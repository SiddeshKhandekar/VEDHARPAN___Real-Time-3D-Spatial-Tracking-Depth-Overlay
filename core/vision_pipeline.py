"""
vision_pipeline.py — VEDHARPAN Phase 1 & 2: AI Vision Backend

Responsibility:
    Manages all webcam I/O and real-time computer vision inference. Runs two
    MediaPipe models simultaneously on each captured frame:
        1. Face Mesh  → extracts the user's interpupillary midpoint (eye bridge)
                        and computes a normalized (x, y, z) head/parallax vector.
        2. Hands      → extracts all 21 landmark positions for up to two hands,
                        providing both the wrist anchor (shadow-occluder center)
                        and the full 21-point skeleton for hand-shaped shadow rigs.

    All raw landmark coordinates are passed through independent Exponential
    Moving Average (EMA) filters before being placed on the output queue:
        • Head/Eye EMA alpha = 0.15  (high stability for camera perspective)
        • Hand EMA alpha    = 0.25  (higher responsiveness for shadow occlusion)

    Normalized output range is [-1.0, 1.0] in all three axes, centred on the
    camera frame. Depth (z) is approximated via interpupillary pixel distance
    for the head and palm bounding-box diagonal for the hands.

Threading Model:
    VisionPipeline runs inside its own daemon thread. It writes telemetry frames
    into a thread-safe queue.Queue that the async WebSocket broker consumes
    without blocking the event loop.

Usage:
    pipeline = VisionPipeline(telemetry_queue)
    pipeline.start()       # spawns the background thread
    ...
    pipeline.stop()        # signals the thread to exit and releases the camera
"""

import base64
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    FaceLandmarker,
    FaceLandmarkerOptions,
    HandLandmarker,
    HandLandmarkerOptions,
)
import numpy as np

# Path to downloaded .task model files (relative to project root)
import pathlib
_MODEL_DIR = pathlib.Path(__file__).resolve().parent.parent / "models"

# ---------------------------------------------------------------------------
# Module-level logger — honours the root logger configuration set in main.py
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Webcam device index.  0 = system default camera.
DEFAULT_CAMERA_INDEX: int = 0

# Target capture resolution.
# 320×240 feeds MediaPipe 15× less pixel data vs 1280×720, achieving 20–30 FPS
# on CPU. MediaPipe internally downscales to 192×192 anyway, so higher input
# resolution adds only CPU overhead with zero inference accuracy benefit.
CAPTURE_WIDTH: int  = 320
CAPTURE_HEIGHT: int = 240

# Camera physical capture frame-rate. 30 FPS matches common webcam capability
# at low resolutions and prevents MediaPipe from queuing stale frames.
CAPTURE_FPS: int = 30

# EMA smoothing coefficients (α).  Lower = smoother but slower to respond.
EMA_ALPHA_HEAD: float = 0.15   # Prioritises camera-perspective stability
EMA_ALPHA_HAND: float = 0.25   # Prioritises shadow-occluder responsiveness

# Approximate reference IPD (Inter-Pupillary Distance) in pixels at 1 metre.
# Used as the reference plane for z-depth estimation from the head model.
# This is a heuristic baseline tuned for a typical 1080p / 72 DPI monitor.
REFERENCE_IPD_PIXELS: float = 120.0

# MediaPipe Face Mesh landmark indices for the left and right pupil centres.
# Using the iris-refined landmarks (indices 468–477) for maximum accuracy when
# the model is configured with refine_landmarks=True.
LEFT_IRIS_CENTER_IDX:  int = 468
RIGHT_IRIS_CENTER_IDX: int = 473

# MediaPipe Hands landmark index for the wrist anchor (most stable hand point).
WRIST_LANDMARK_IDX: int = 0


# ---------------------------------------------------------------------------
# Data container
# ---------------------------------------------------------------------------

@dataclass
class SpatialVector:
    """A normalised 3-axis spatial coordinate in the range [-1.0, 1.0].

    Attributes:
        x: Horizontal offset. Negative = left,  positive = right.
        y: Vertical offset.   Negative = down,  positive = up.
        z: Depth estimate.    0.0 = reference distance, positive = closer.
    """
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


@dataclass
class TelemetryFrame:
    """A single frame of unified tracking data ready for JSON serialization.

    Attributes:
        head:      Smoothed spatial vector for the head/eyes.
        hands:     List of smoothed spatial vectors and landmarks for tracked hands,
                   including recognized gesture state ('none', 'aim', 'fire').
        timestamp: Creation time of the frame (Unix epoch seconds).
        debug_image: Base64 JPEG string of the camera feed with 2D debug overlays.
    """
    head:      SpatialVector
    hands:     List[Dict[str, Any]] = field(default_factory=list)
    timestamp: float = 0.0
    debug_image: Optional[str] = None


# ---------------------------------------------------------------------------
# EMA Filter
# ---------------------------------------------------------------------------

class ExponentialMovingAverage:
    """A stateful single-axis Exponential Moving Average filter.

    Applies the recurrence relation:
        S_t = α · Y_t + (1 − α) · S_{t-1}

    On the first call the filter is initialised with the raw observation,
    preventing an artificial snap from zero on startup.

    Args:
        alpha: Smoothing coefficient in the range (0.0, 1.0].
               Higher values track the signal more closely (less smoothing).

    Raises:
        ValueError: If alpha is not in the range (0.0, 1.0].
    """

    def __init__(self, alpha: float) -> None:
        if not (0.0 < alpha <= 1.0):
            raise ValueError(f"EMA alpha must be in (0.0, 1.0], received {alpha}.")
        self._alpha: float           = alpha
        self._state: Optional[float] = None

    def update(self, raw_value: float) -> float:
        """Feed a new raw observation and return the smoothed output.

        Args:
            raw_value: The latest raw measurement from the vision model.

        Returns:
            The smoothed value after applying the EMA recurrence.
        """
        if self._state is None:
            self._state = raw_value
        else:
            self._state = self._alpha * raw_value + (1.0 - self._alpha) * self._state
        return self._state

    def reset(self) -> None:
        """Reset the filter state (e.g., when a landmark disappears mid-stream)."""
        self._state = None


class VectorEMAFilter:
    """Three independent EMA filters acting on a (x, y, z) spatial vector.

    Args:
        alpha: Shared smoothing coefficient applied to all three axes.
    """

    def __init__(self, alpha: float) -> None:
        self._x_filter = ExponentialMovingAverage(alpha)
        self._y_filter = ExponentialMovingAverage(alpha)
        self._z_filter = ExponentialMovingAverage(alpha)

    def update(self, raw: SpatialVector) -> SpatialVector:
        """Apply EMA to each axis of the input vector.

        Args:
            raw: The raw, un-smoothed spatial vector from the vision model.

        Returns:
            A new SpatialVector containing smoothed coordinate values.
        """
        return SpatialVector(
            x = self._x_filter.update(raw.x),
            y = self._y_filter.update(raw.y),
            z = self._z_filter.update(raw.z),
        )

    def reset(self) -> None:
        """Reset all three axis filters (call when a landmark goes out of frame)."""
        self._x_filter.reset()
        self._y_filter.reset()
        self._z_filter.reset()


# ---------------------------------------------------------------------------
# Coordinate utilities
# ---------------------------------------------------------------------------

def _normalise_pixel(
    pixel_x: float,
    pixel_y: float,
    frame_width: int,
    frame_height: int,
) -> Tuple[float, float]:
    """Convert pixel coordinates to the normalised [-1.0, 1.0] Cartesian range.

    The centre of the frame maps to (0.0, 0.0). The y-axis is flipped so that
    "up" in camera space corresponds to positive-y in 3D world space.

    Args:
        pixel_x:      Raw pixel column from the MediaPipe landmark.
        pixel_y:      Raw pixel row from the MediaPipe landmark.
        frame_width:  Width of the captured frame in pixels.
        frame_height: Height of the captured frame in pixels.

    Returns:
        A tuple (norm_x, norm_y) each in the range [-1.0, 1.0].
    """
    norm_x =  (pixel_x / frame_width)  * 2.0 - 1.0
    norm_y = -((pixel_y / frame_height) * 2.0 - 1.0)   # flip for world-space up
    return norm_x, norm_y


def _estimate_head_depth(
    left_iris_pixel:  Tuple[float, float],
    right_iris_pixel: Tuple[float, float],
) -> float:
    """Estimate normalised head depth from the inter-pupillary pixel distance.

    As the user moves closer, the IPD in pixels grows; further away it shrinks.
    The result is normalised so that the reference distance (1 metre) maps to
    z = 0.0, closer = positive, further = negative (clamped to [-1.0, 1.0]).

    Args:
        left_iris_pixel:  (x, y) pixel coordinates of the left iris centre.
        right_iris_pixel: (x, y) pixel coordinates of the right iris centre.

    Returns:
        A float in the range [-1.0, 1.0] representing relative depth.
    """
    ipd_pixels = float(
        np.linalg.norm(
            np.array(left_iris_pixel) - np.array(right_iris_pixel)
        )
    )

    if ipd_pixels < 1e-6:
        return 0.0

    # Ratio: 1.0 at reference distance, >1 when closer, <1 when further.
    depth_ratio = ipd_pixels / REFERENCE_IPD_PIXELS

    # Shift by -1 so reference = 0, then clamp.
    normalised_depth = float(np.clip(depth_ratio - 1.0, -1.0, 1.0))
    return normalised_depth


def _estimate_hand_depth(landmarks_list, frame_width: int, frame_height: int) -> float:
    """Estimate normalised hand depth from the palm bounding-box diagonal.

    Larger hand = closer to the camera; smaller = further away.
    The reference diagonal is calibrated to a mid-distance hand position.

    Args:
        landmarks_list: List of NormalizedLandmark for one hand (21 items).
        frame_width:    Captured frame width in pixels.
        frame_height:   Captured frame height in pixels.

    Returns:
        A float in the range [-1.0, 1.0] representing relative depth.
    """
    # Collect pixel coordinates for all 21 landmarks.
    xs = [lm.x * frame_width  for lm in landmarks_list]
    ys = [lm.y * frame_height for lm in landmarks_list]

    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)

    diagonal = float(
        np.sqrt((x_max - x_min) ** 2 + (y_max - y_min) ** 2)
    )

    # Reference diagonal at a neutral arm-extended position (~200 px at 720p).
    reference_diagonal: float = 200.0

    if diagonal < 1e-6:
        return 0.0

    depth_ratio     = diagonal / reference_diagonal
    normalised_depth = float(np.clip(depth_ratio - 1.0, -1.0, 1.0))
    return normalised_depth


# ---------------------------------------------------------------------------
# VisionPipeline — main public class
# ---------------------------------------------------------------------------

class VisionPipeline:
    """Manages webcam capture and dual MediaPipe inference in a background thread.

    Runs MediaPipe Face Mesh and Hands on each captured frame. Smoothed spatial
    vectors are emitted into the provided output queue as TelemetryFrame objects.

    The pipeline is designed to be run in a dedicated daemon thread so that
    blocking OpenCV camera I/O never stalls the async WebSocket event loop.

    Args:
        output_queue:   A thread-safe queue.Queue that the caller reads from.
                        The pipeline puts TelemetryFrame instances onto it.
        camera_index:   OS device index for cv2.VideoCapture. Defaults to 0.

    Raises:
        RuntimeError: Raised during start() if the camera cannot be opened.

    Example:
        >>> q = queue.Queue(maxsize=10)
        >>> pipeline = VisionPipeline(output_queue=q)
        >>> pipeline.start()
        >>> frame: TelemetryFrame = q.get()
        >>> pipeline.stop()
    """

    def __init__(
        self,
        output_queue: "queue.Queue[TelemetryFrame]",
        camera_index: int = DEFAULT_CAMERA_INDEX,
    ) -> None:
        self._output_queue: "queue.Queue[TelemetryFrame]" = output_queue
        self._camera_index: int  = camera_index
        self._stop_event: threading.Event = threading.Event()
        self._pause_event: threading.Event = threading.Event()
        self._pause_event.set() # Default to paused until explicitly resumed

        # Background worker thread — daemon so it dies with the main process.
        self._thread: threading.Thread = threading.Thread(
            target     = self._run_capture_loop,
            name       = "VisionPipelineThread",
            daemon     = True,
        )

        # EMA filters — separate instances for head and two hands to allow
        # independent alpha coefficients.
        self._head_ema = VectorEMAFilter(alpha=EMA_ALPHA_HEAD)
        self._hand_emas = [
            VectorEMAFilter(alpha=EMA_ALPHA_HAND),
            VectorEMAFilter(alpha=EMA_ALPHA_HAND)
        ]

        # MediaPipe solution handles (initialised inside the worker thread
        # so that CUDA context is bound to the correct thread).
        self._face_mesh = None
        self._hands     = None

        # Backend fist-hold tracker — used for the diagnostic progress bar
        self._fist_start_ts: Optional[float] = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background vision-capture thread.

        Returns immediately. The thread begins producing TelemetryFrame
        objects and placing them on self._output_queue.
        """
        logger.info("VisionPipeline: Starting background capture thread.")
        self._thread.start()

    def stop(self) -> None:
        """Signal the capture thread to exit and wait for it to join.

        Guarantees that the camera device is released before this method
        returns, even if an exception occurred inside the worker loop.
        """
        logger.info("VisionPipeline: Stop signal received — waiting for thread to exit.")
        self._stop_event.set()
        self._thread.join(timeout=5.0)
        if self._thread.is_alive():
            logger.warning("VisionPipeline: Worker thread did not exit within timeout.")

    def set_active(self, is_active: bool) -> None:
        """Enable or disable the camera capture loop without stopping the thread.

        When inactive (paused), the thread sleeps in a tight 100 ms poll
        loop and the physical webcam LED turns off. When active, the webcam
        is opened and inference resumes immediately.

        Args:
            is_active: True to start capturing; False to pause and release camera.
        """
        if is_active:
            logger.info("VisionPipeline: Resuming capture (webcam ON).")
            self._pause_event.clear()   # clear = unpaused → capture loop runs
        else:
            logger.info("VisionPipeline: Pausing capture (webcam OFF).")
            self._pause_event.set()     # set = paused → capture loop skips

    @property
    def is_running(self) -> bool:
        """True if the worker thread is alive and has not been asked to stop."""
        return self._thread.is_alive() and not self._stop_event.is_set()

    def set_active(self, active: bool) -> None:
        """Pause or resume the vision pipeline, toggling the physical webcam."""
        if active:
            if self._pause_event.is_set():
                logger.info("VisionPipeline: Resuming capture (Camera ON).")
                self._pause_event.clear()
        else:
            if not self._pause_event.is_set():
                logger.info("VisionPipeline: Pausing capture (Camera OFF).")
                self._pause_event.set()

    # ------------------------------------------------------------------
    # Internal worker loop — runs entirely inside the background thread
    # ------------------------------------------------------------------

    def _initialise_mediapipe(self) -> None:
        """Construct MediaPipe FaceLandmarker and HandLandmarker using the Tasks API.

        Called once at the start of the worker thread.
        Requires face_landmarker.task and hand_landmarker.task in the models/ directory.
        """
        face_model_path = str(_MODEL_DIR / "face_landmarker.task")
        hand_model_path = str(_MODEL_DIR / "hand_landmarker.task")

        face_options = FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=face_model_path),
            num_faces=1,
            min_face_detection_confidence=0.6,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )

        hand_options = HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=hand_model_path),
            num_hands=2,
            min_hand_detection_confidence=0.4,
            min_hand_presence_confidence=0.4,
            min_tracking_confidence=0.4,
        )

        self._face_mesh = FaceLandmarker.create_from_options(face_options)
        self._hands     = HandLandmarker.create_from_options(hand_options)

        logger.info("VisionPipeline: MediaPipe FaceLandmarker and HandLandmarker initialised (Tasks API).")

    def _release_mediapipe(self) -> None:
        """Close MediaPipe task contexts to free GPU/model memory."""
        if self._face_mesh is not None:
            self._face_mesh.close()
            self._face_mesh = None
        if self._hands is not None:
            self._hands.close()
            self._hands = None
        logger.info("VisionPipeline: MediaPipe resources released.")

    def _open_camera(self, camera_index: int) -> cv2.VideoCapture:
        """Open the webcam and configure capture parameters.

        Args:
            camera_index: The OS device index to open.

        Returns:
            An opened cv2.VideoCapture instance.

        Raises:
            RuntimeError: If the camera cannot be opened or is already in use.
        """
        try:
            cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)  # CAP_DSHOW for Windows
        except Exception as exc:
            raise RuntimeError(
                f"VisionPipeline: cv2.VideoCapture raised an unexpected error "
                f"for device index {camera_index}: {exc}"
            ) from exc

        if not cap.isOpened():
            raise RuntimeError(
                f"VisionPipeline: Could not open camera at device index {camera_index}. "
                "The device may be busy, disconnected, or blocked by another process."
            )

        # Request capture parameters — the driver may silently clamp these.
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  CAPTURE_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS,          CAPTURE_FPS)

        actual_fps = cap.get(cv2.CAP_PROP_FPS)
        logger.info(
            "VisionPipeline: Camera %d opened — resolution %dx%d, FPS %.1f.",
            camera_index,
            int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            actual_fps,
        )
        return cap

    def _run_capture_loop(self) -> None:
        """Main worker loop — capture → infer → filter → enqueue.

        This method runs exclusively inside the background thread. All
        resources (camera, MediaPipe) are acquired and released here to
        ensure correct CUDA thread affinity and guaranteed cleanup even
        when an unhandled exception occurs or when paused.
        """
        try:
            self._initialise_mediapipe()
            
            while not self._stop_event.is_set():
                if self._pause_event.is_set():
                    # Yield thread while waiting to be resumed or stopped
                    time.sleep(0.1)
                    continue

                cap: Optional[cv2.VideoCapture] = None
                try:
                    cap = self._open_camera(self._camera_index)
                    self._capture_and_infer(cap)

                except RuntimeError as exc:
                    logger.error("VisionPipeline: %s", exc)
                    time.sleep(1.0) # Avoid tight fail-loops

                except Exception as exc:
                    logger.exception(
                        "VisionPipeline: Unexpected error in capture loop — %s", exc
                    )
                    time.sleep(1.0)

                finally:
                    if cap is not None and cap.isOpened():
                        cap.release()
                        logger.info("VisionPipeline: Camera device released.")

        finally:
            self._release_mediapipe()

    def _capture_and_infer(self, cap: cv2.VideoCapture) -> None:
        """Core per-frame loop: read → RGB convert → infer → EMA → enqueue.

        Args:
            cap: An already-opened cv2.VideoCapture instance.
        """
        # Performance diagnostics — log actual achieved FPS every 5 seconds.
        frame_count: int   = 0
        loop_start:  float = time.perf_counter()

        while not self._stop_event.is_set() and not self._pause_event.is_set():
            success, bgr_frame = cap.read()

            if not success or bgr_frame is None:
                logger.warning(
                    "VisionPipeline: Failed to read frame — "
                    "camera may have been disconnected. Retrying..."
                )
                time.sleep(0.05)  # brief pause before retry
                continue

            frame_height, frame_width = bgr_frame.shape[:2]

            # MediaPipe Tasks API requires an mp.Image wrapper around RGB numpy data.
            rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

            # --- Run inference on both models ---
            face_results = self._face_mesh.detect(mp_image)
            hand_results = self._hands.detect(mp_image)

            # --- Extract raw spatial vectors ---
            raw_head = self._extract_head_vector(
                face_results, frame_width, frame_height
            )
            extracted_hands = self._extract_hands(
                hand_results, frame_width, frame_height
            )

            # --- Apply EMA smoothing ---
            smooth_head = self._head_ema.update(raw_head)
            
            smooth_hands = []
            for i, (raw_hand_center, raw_landmarks, gesture, handedness, index_tip) in enumerate(extracted_hands):
                if i < len(self._hand_emas):
                    smooth_center = self._hand_emas[i].update(raw_hand_center)
                    hand_entry = {
                        "center": smooth_center,
                        "landmarks": raw_landmarks,
                        "gesture": gesture,
                        "handedness": handedness,
                    }
                    if index_tip is not None:
                        hand_entry["index_tip"] = index_tip
                    smooth_hands.append(hand_entry)
            
            # Reset unused EMAs
            for i in range(len(extracted_hands), len(self._hand_emas)):
                self._hand_emas[i].reset()

            # --- Update backend fist-hold debounce timer for debug bar ---
            any_fist = any(
                hand[2] == 'fist' for hand in extracted_hands
            )
            if any_fist:
                if self._fist_start_ts is None:
                    self._fist_start_ts = time.perf_counter()
            else:
                self._fist_start_ts = None

            # --- Base64 Debug Image for UI ---
            # Hand skeleton connection pairs (MediaPipe standard 21-node graph)
            _HAND_CONNECTIONS = [
                (0,1),(1,2),(2,3),(3,4),           # thumb
                (0,5),(5,6),(6,7),(7,8),            # index
                (0,9),(9,10),(10,11),(11,12),       # middle
                (0,13),(13,14),(14,15),(15,16),     # ring
                (0,17),(17,18),(18,19),(19,20),     # pinky
                (5,9),(9,13),(13,17),               # palm cross-links
            ]

            debug_base64: Optional[str] = None
            try:
                # Mirror the raw frame so left/right matches the user's expectation
                debug_img = cv2.flip(bgr_frame, 1)
                debug_h, debug_w = debug_img.shape[:2]

                # Overlay each detected hand
                for hand_idx, raw_lm_list in enumerate(hand_results.hand_landmarks):
                    # raw_lm_list is List[NormalizedLandmark]; .x/.y are in [0, 1]
                    # After mirror flip, the correct pixel x = (1 - lm.x) * w
                    def lm_px(lm):
                        return (int((1.0 - lm.x) * debug_w), int(lm.y * debug_h))

                    pts = [lm_px(lm) for lm in raw_lm_list]

                    # Draw skeleton connections
                    for (a, b) in _HAND_CONNECTIONS:
                        cv2.line(debug_img, pts[a], pts[b], (0, 200, 200), 1)

                    # Draw all 21 joint dots
                    for pt in pts:
                        cv2.circle(debug_img, pt, 3, (0, 255, 100), -1)

                    # Highlight index fingertip (landmark 8) in bold red
                    ix, iy = pts[8]
                    cv2.circle(debug_img, (ix, iy), 7, (0, 0, 255), -1)
                    cv2.putText(debug_img, "INDEX", (ix + 6, iy - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 80, 255), 1)

                    # Gesture label + handedness above wrist
                    wx, wy = pts[0]
                    gesture_str = "none"
                    handedness_str = "?"
                    if hand_idx < len(extracted_hands):
                        gesture_str    = extracted_hands[hand_idx][2] or "none"
                        handedness_str = extracted_hands[hand_idx][3] or "?"

                    label = f"{handedness_str[0].upper()}  {gesture_str.upper()}"
                    cv2.putText(debug_img, label, (wx - 30, wy - 12),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)

                    # Fist-hold progress bar (400ms debounce window)
                    if hasattr(self, '_fist_start_ts') and self._fist_start_ts and gesture_str == 'fist':
                        import time as _time
                        held_ms = (_time.perf_counter() - self._fist_start_ts) * 1000
                        ratio   = min(1.0, held_ms / 400.0)
                        bar_w   = int(60 * ratio)
                        bar_x   = max(0, wx - 30)
                        bar_y   = wy - 4
                        cv2.rectangle(debug_img, (bar_x, bar_y), (bar_x + 60, bar_y + 5),
                                      (50, 50, 50), -1)
                        cv2.rectangle(debug_img, (bar_x, bar_y), (bar_x + bar_w, bar_y + 5),
                                      (0, 220, 255), -1)

                # Status strip at top-left
                status_txt = f"Hands: {len(hand_results.hand_landmarks)}"
                cv2.putText(debug_img, status_txt, (6, 14),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)

                _, buffer = cv2.imencode('.jpg', debug_img, [cv2.IMWRITE_JPEG_QUALITY, 65])
                debug_base64 = base64.b64encode(buffer).decode('utf-8')
            except Exception as e:
                logger.warning("VisionPipeline: Failed to encode debug image - %s", e)

            # --- Build and enqueue the telemetry frame ---
            telemetry = TelemetryFrame(
                head           = smooth_head,
                hands          = smooth_hands,
                timestamp      = time.time(),
                debug_image    = debug_base64,
            )


            try:
                # Discard oldest frame rather than block the inference loop.
                self._output_queue.put_nowait(telemetry)
            except queue.Full:
                try:
                    self._output_queue.get_nowait()   # discard stale frame
                    self._output_queue.put_nowait(telemetry)
                except queue.Empty:
                    pass

            # --- FPS diagnostics (non-blocking log every 5 s) ---
            frame_count += 1
            elapsed = time.perf_counter() - loop_start
            if elapsed >= 5.0:
                achieved_fps = frame_count / elapsed
                logger.info(
                    "VisionPipeline: Achieved %.1f FPS over the last %.1f seconds.",
                    achieved_fps,
                    elapsed,
                )
                frame_count = 0
                loop_start  = time.perf_counter()

    def _extract_head_vector(
        self,
        face_results,
        frame_width:  int,
        frame_height: int,
    ) -> SpatialVector:
        """Extract a raw (un-smoothed) head spatial vector from Face Mesh results.

        Uses the iris centre landmarks (refined mode) to compute a normalised
        (x, y) midpoint between the pupils and a z-depth from the IPD.

        If no face is detected, returns the last valid vector (via EMA state)
        by returning the zero-centred origin vector, which will be pulled
        toward the current EMA state by the low alpha coefficient.
        """
        if not face_results.face_landmarks:
            self._head_ema.reset()
            return SpatialVector(0.0, 0.0, 0.0)

        landmarks = face_results.face_landmarks[0]  # List[NormalizedLandmark]

        # The Tasks API face_landmarker returns 478 landmarks (468 mesh + 10 iris)
        # Check if iris landmarks are available; fall back to inner eye corners if not.
        if len(landmarks) > RIGHT_IRIS_CENTER_IDX:
            left_iris_lm  = landmarks[LEFT_IRIS_CENTER_IDX]
            right_iris_lm = landmarks[RIGHT_IRIS_CENTER_IDX]
        else:
            # Fallback: inner eye corners (landmarks 133 and 362)
            left_iris_lm  = landmarks[133]
            right_iris_lm = landmarks[362]

        # Pixel positions of the iris centres.
        left_iris  = (
            left_iris_lm.x  * frame_width,
            left_iris_lm.y  * frame_height,
        )
        right_iris = (
            right_iris_lm.x * frame_width,
            right_iris_lm.y * frame_height,
        )

        # Midpoint of the two irises -> horizontal/vertical gaze centre.
        mid_x = (left_iris[0] + right_iris[0]) / 2.0
        mid_y = (left_iris[1] + right_iris[1]) / 2.0

        norm_x, norm_y = _normalise_pixel(mid_x, mid_y, frame_width, frame_height)
        norm_z         = _estimate_head_depth(left_iris, right_iris)

        return SpatialVector(x=norm_x, y=norm_y, z=norm_z)

    def _classify_gesture(self, landmarks) -> str:
        """Classify a hand gesture from MediaPipe hand landmarks.

        Detects four gesture states for Construct (Mode 4):
            fist  : 3 of 4 non-thumb fingers clearly curled (majority vote).
            open  : all 4 non-thumb fingers clearly extended.
            point : only index finger extended, others curled.
            none  : default / transitional fallback.

        Each finger is checked with three independent conditions so a single
        borderline reading cannot break the whole gesture.
        """
        # ── Landmark indices ───────────────────────────────────────────────
        THUMB_TIP  = 4;  THUMB_MCP  = 2
        INDEX_TIP  = 8;  INDEX_PIP  = 6;  INDEX_MCP  = 5
        MIDDLE_TIP = 12; MIDDLE_PIP = 10; MIDDLE_MCP = 9
        RING_TIP   = 16; RING_PIP   = 14; RING_MCP   = 13
        PINKY_TIP  = 20; PINKY_PIP  = 18; PINKY_MCP  = 17
        WRIST      = 0

        def d2(a, b):
            dx = landmarks[a].x - landmarks[b].x
            dy = landmarks[a].y - landmarks[b].y
            return (dx*dx + dy*dy) ** 0.5

        def is_curled(tip, pip, mcp):
            # 1. Tip clearly below its own knuckle (MCP) in image space
            below_mcp  = landmarks[tip].y > landmarks[mcp].y + 0.04
            # 2. Tip at or below its PIP knuckle
            below_pip  = landmarks[tip].y > landmarks[pip].y - 0.01
            # 3. Tip closer to wrist than MCP (with generous tolerance)
            near_wrist = d2(tip, WRIST) < d2(mcp, WRIST) + 0.07
            return below_mcp and below_pip and near_wrist

        def is_extended(tip, mcp):
            return d2(tip, WRIST) > d2(mcp, WRIST) + 0.025

        # Thumb: tip near index MCP (cross-palm) = curled/tucked
        thumb_curled   = d2(THUMB_TIP, INDEX_MCP) < 0.15
        thumb_extended = d2(THUMB_TIP, WRIST) > d2(THUMB_MCP, WRIST) + 0.02

        curled = [
            is_curled(INDEX_TIP,  INDEX_PIP,  INDEX_MCP),
            is_curled(MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
            is_curled(RING_TIP,   RING_PIP,   RING_MCP),
            is_curled(PINKY_TIP,  PINKY_PIP,  PINKY_MCP),
        ]
        extended = [
            is_extended(INDEX_TIP,  INDEX_MCP),
            is_extended(MIDDLE_TIP, MIDDLE_MCP),
            is_extended(RING_TIP,   RING_MCP),
            is_extended(PINKY_TIP,  PINKY_MCP),
        ]

        n_curled   = sum(curled)
        n_extended = sum(extended)

        # FIST: at least 3 of 4 fingers clearly curled
        if n_curled >= 3:
            return "fist"

        # OPEN: all 4 non-thumb fingers clearly extended
        if n_extended == 4 and thumb_extended:
            return "open"

        # POINT: index extended, middle and ring curled
        if extended[0] and curled[1] and curled[2]:
            return "point"

        return "none"


    def _extract_hands(
        self,
        hand_results,
        frame_width:  int,
        frame_height: int,
    ) -> List[Tuple[SpatialVector, List[Dict[str, float]], str, str, Optional[Dict[str, float]]]]:
        """Extract raw (un-smoothed) hand vectors, landmarks, gestures, handedness, and index tip.

        Returns:
            A list of tuples:
                (SpatialVector, List[Dict], gesture_str, handedness_str, index_tip_dict_or_None)
        """
        if not hand_results.hand_landmarks:
            return []

        hands_data = []
        for hand_idx, hand_landmark_list in enumerate(hand_results.hand_landmarks):
            # hand_landmark_list is List[NormalizedLandmark] (21 items)
            wrist = hand_landmark_list[WRIST_LANDMARK_IDX]

            wrist_pixel_x = wrist.x * frame_width
            wrist_pixel_y = wrist.y * frame_height

            norm_x, norm_y = _normalise_pixel(
                wrist_pixel_x, wrist_pixel_y, frame_width, frame_height
            )
            norm_z = _estimate_hand_depth(hand_landmark_list, frame_width, frame_height)

            # --- Handedness detection ---
            # MediaPipe labels from camera perspective; since we mirror X,
            # "Left" from MP = user's Right hand and vice versa.
            handedness_label = "Unknown"
            if (hand_results.handedness
                    and hand_idx < len(hand_results.handedness)
                    and len(hand_results.handedness[hand_idx]) > 0):
                mp_label = hand_results.handedness[hand_idx][0].category_name
                # Flip because the camera image is mirrored
                handedness_label = "Right" if mp_label == "Left" else "Left"

            # Collect all 21 normalised landmark points for the frontend.
            all_landmarks: List[Dict[str, float]] = []
            for lm in hand_landmark_list:
                # Invert the X coordinate to fix the hand mirror/chirality issue
                mirrored_pixel_x = (1.0 - lm.x) * frame_width

                lm_norm_x, lm_norm_y = _normalise_pixel(
                    mirrored_pixel_x,
                    lm.y * frame_height,
                    frame_width,
                    frame_height,
                )
                lm_norm_z = float(np.clip(lm.z * 5.0, -1.0, 1.0))
                all_landmarks.append({
                    "x": round(lm_norm_x, 5),
                    "y": round(lm_norm_y, 5),
                    "z": round(lm_norm_z, 5),
                })

            gesture = self._classify_gesture(hand_landmark_list)

            # --- Index fingertip for 3D drawing (only when pointing) ---
            index_tip_data = None
            if gesture == "point":
                idx_lm = hand_landmark_list[8]  # INDEX_FINGER_TIP
                mirrored_idx_x = (1.0 - idx_lm.x) * frame_width
                itx, ity = _normalise_pixel(
                    mirrored_idx_x, idx_lm.y * frame_height,
                    frame_width, frame_height,
                )
                itz = float(np.clip(idx_lm.z * 5.0, -1.0, 1.0))
                index_tip_data = {
                    "x": round(itx, 5),
                    "y": round(ity, 5),
                    "z": round(itz, 5),
                }

            hands_data.append((
                SpatialVector(x=norm_x, y=norm_y, z=norm_z),
                all_landmarks,
                gesture,
                handedness_label,
                index_tip_data,
            ))

        return hands_data
