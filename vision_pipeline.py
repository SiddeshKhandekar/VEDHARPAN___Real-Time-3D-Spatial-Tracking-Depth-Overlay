"""
vision_pipeline.py — VEDHARPAN Phase 1: AI Vision Backend

Responsibility:
    Manages all webcam I/O and real-time computer vision inference. Runs two
    MediaPipe models simultaneously on each captured frame:
        1. Face Mesh  → extracts the user's interpupillary midpoint (eye bridge)
                        and computes a normalized (x, y, z) head/parallax vector.
        2. Hands      → extracts the wrist anchor of the dominant hand and
                        computes a normalized (x, y, z) shadow-occluder vector.

    All raw landmark coordinates are passed through independent Exponential
    Moving Average (EMA) filters before being placed on the output queue:
        • Head/Eye EMA alpha = 0.15  (high stability for camera perspective)
        • Hand EMA alpha    = 0.25  (higher responsiveness for shadow occlusion)

    Normalized output range is [-1.0, 1.0] in all three axes, centred on the
    camera frame. Depth (z) is approximated via interpupillary pixel distance
    for the head and palm bounding-box diagonal for the hand.

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

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np

# ---------------------------------------------------------------------------
# Module-level logger — honours the root logger configuration set in main.py
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Webcam device index.  0 = system default camera.
DEFAULT_CAMERA_INDEX: int = 0

# Target capture resolution. 1280×720 is a common 60 fps-capable resolution.
CAPTURE_WIDTH: int  = 1280
CAPTURE_HEIGHT: int = 720

# Camera's physical capture frame-rate request. The OS may clamp this.
CAPTURE_FPS: int = 60

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
    """A single telemetry snapshot emitted from the vision pipeline.

    Attributes:
        head:      Smoothed head/eye spatial vector for parallax computation.
        hand:      Smoothed hand/wrist spatial vector for shadow occlusion.
        timestamp: Unix epoch seconds at the moment of capture.
    """
    head:      SpatialVector = field(default_factory=SpatialVector)
    hand:      SpatialVector = field(default_factory=SpatialVector)
    timestamp: float         = field(default_factory=time.time)


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


def _estimate_hand_depth(hand_landmarks, frame_width: int, frame_height: int) -> float:
    """Estimate normalised hand depth from the palm bounding-box diagonal.

    Larger hand = closer to the camera; smaller = further away.
    The reference diagonal is calibrated to a mid-distance hand position.

    Args:
        hand_landmarks: MediaPipe NormalizedLandmarkList for one hand.
        frame_width:    Captured frame width in pixels.
        frame_height:   Captured frame height in pixels.

    Returns:
        A float in the range [-1.0, 1.0] representing relative depth.
    """
    # Collect pixel coordinates for all 21 landmarks.
    xs = [lm.x * frame_width  for lm in hand_landmarks.landmark]
    ys = [lm.y * frame_height for lm in hand_landmarks.landmark]

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

        # Background worker thread — daemon so it dies with the main process.
        self._thread: threading.Thread = threading.Thread(
            target     = self._run_capture_loop,
            name       = "VisionPipelineThread",
            daemon     = True,
        )

        # EMA filters — separate instances for head and hand to allow
        # independent alpha coefficients.
        self._head_ema = VectorEMAFilter(alpha=EMA_ALPHA_HEAD)
        self._hand_ema = VectorEMAFilter(alpha=EMA_ALPHA_HAND)

        # MediaPipe solution handles (initialised inside the worker thread
        # so that CUDA context is bound to the correct thread).
        self._face_mesh = None
        self._hands     = None

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

    @property
    def is_running(self) -> bool:
        """True if the worker thread is alive and has not been asked to stop."""
        return self._thread.is_alive() and not self._stop_event.is_set()

    # ------------------------------------------------------------------
    # Internal worker loop — runs entirely inside the background thread
    # ------------------------------------------------------------------

    def _initialise_mediapipe(self) -> None:
        """Construct MediaPipe Face Mesh and Hands solution objects.

        Called once at the start of the worker thread. Iris-landmark
        refinement is enabled on Face Mesh for sub-pixel pupil accuracy.
        """
        mp_face_mesh = mp.solutions.face_mesh   # type: ignore[attr-defined]
        mp_hands     = mp.solutions.hands        # type: ignore[attr-defined]

        self._face_mesh = mp_face_mesh.FaceMesh(
            max_num_faces            = 1,
            refine_landmarks         = True,   # enables 10 iris landmarks
            min_detection_confidence = 0.6,
            min_tracking_confidence  = 0.5,
        )

        self._hands = mp_hands.Hands(
            max_num_hands            = 1,
            min_detection_confidence = 0.7,
            min_tracking_confidence  = 0.6,
        )

        logger.info("VisionPipeline: MediaPipe Face Mesh and Hands initialised.")

    def _release_mediapipe(self) -> None:
        """Close MediaPipe solution contexts to free GPU/model memory."""
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
        when an unhandled exception occurs.
        """
        cap: Optional[cv2.VideoCapture] = None

        try:
            self._initialise_mediapipe()
            cap = self._open_camera(self._camera_index)
            self._capture_and_infer(cap)

        except RuntimeError as exc:
            logger.error("VisionPipeline: %s", exc)

        except Exception as exc:
            logger.exception(
                "VisionPipeline: Unexpected error in capture loop — %s", exc
            )

        finally:
            if cap is not None and cap.isOpened():
                cap.release()
                logger.info("VisionPipeline: Camera device released.")
            self._release_mediapipe()

    def _capture_and_infer(self, cap: cv2.VideoCapture) -> None:
        """Core per-frame loop: read → RGB convert → infer → EMA → enqueue.

        Args:
            cap: An already-opened cv2.VideoCapture instance.
        """
        # Performance diagnostics — log actual achieved FPS every 5 seconds.
        frame_count: int   = 0
        loop_start:  float = time.perf_counter()

        while not self._stop_event.is_set():
            success, bgr_frame = cap.read()

            if not success or bgr_frame is None:
                logger.warning(
                    "VisionPipeline: Failed to read frame — "
                    "camera may have been disconnected. Retrying..."
                )
                time.sleep(0.05)  # brief pause before retry
                continue

            frame_height, frame_width = bgr_frame.shape[:2]

            # MediaPipe requires RGB; OpenCV captures in BGR.
            # Marking the array non-writeable avoids an internal buffer copy.
            rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
            rgb_frame.flags.writeable = False

            # --- Run inference on both models ---
            face_results = self._face_mesh.process(rgb_frame)
            hand_results = self._hands.process(rgb_frame)

            # --- Extract raw spatial vectors ---
            raw_head = self._extract_head_vector(
                face_results, frame_width, frame_height
            )
            raw_hand = self._extract_hand_vector(
                hand_results, frame_width, frame_height
            )

            # --- Apply EMA smoothing ---
            smooth_head = self._head_ema.update(raw_head)
            smooth_hand = self._hand_ema.update(raw_hand)

            # --- Build and enqueue the telemetry frame ---
            telemetry = TelemetryFrame(
                head      = smooth_head,
                hand      = smooth_hand,
                timestamp = time.time(),
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

        Args:
            face_results: The output of self._face_mesh.process().
            frame_width:  Pixel width of the current frame.
            frame_height: Pixel height of the current frame.

        Returns:
            A raw SpatialVector for the head position.
        """
        if not face_results.multi_face_landmarks:
            self._head_ema.reset()
            return SpatialVector(0.0, 0.0, 0.0)

        landmarks = face_results.multi_face_landmarks[0].landmark

        # Pixel positions of the iris centres.
        left_iris  = (
            landmarks[LEFT_IRIS_CENTER_IDX].x  * frame_width,
            landmarks[LEFT_IRIS_CENTER_IDX].y  * frame_height,
        )
        right_iris = (
            landmarks[RIGHT_IRIS_CENTER_IDX].x * frame_width,
            landmarks[RIGHT_IRIS_CENTER_IDX].y * frame_height,
        )

        # Midpoint of the two irises → horizontal/vertical gaze centre.
        mid_x = (left_iris[0] + right_iris[0]) / 2.0
        mid_y = (left_iris[1] + right_iris[1]) / 2.0

        norm_x, norm_y = _normalise_pixel(mid_x, mid_y, frame_width, frame_height)
        norm_z         = _estimate_head_depth(left_iris, right_iris)

        return SpatialVector(x=norm_x, y=norm_y, z=norm_z)

    def _extract_hand_vector(
        self,
        hand_results,
        frame_width:  int,
        frame_height: int,
    ) -> SpatialVector:
        """Extract a raw (un-smoothed) hand spatial vector from Hands results.

        Anchors to the WRIST landmark for a stable centre-of-mass position
        and computes depth from the bounding-box diagonal of the full hand.

        If no hand is detected, resets the EMA filter and returns the origin
        so the occluder gently returns to a neutral resting position.

        Args:
            hand_results: The output of self._hands.process().
            frame_width:  Pixel width of the current frame.
            frame_height: Pixel height of the current frame.

        Returns:
            A raw SpatialVector for the hand position.
        """
        if not hand_results.multi_hand_landmarks:
            self._hand_ema.reset()
            return SpatialVector(0.0, 0.0, 0.0)

        hand_landmarks = hand_results.multi_hand_landmarks[0]
        wrist          = hand_landmarks.landmark[WRIST_LANDMARK_IDX]

        wrist_pixel_x = wrist.x * frame_width
        wrist_pixel_y = wrist.y * frame_height

        norm_x, norm_y = _normalise_pixel(
            wrist_pixel_x, wrist_pixel_y, frame_width, frame_height
        )
        norm_z = _estimate_hand_depth(hand_landmarks, frame_width, frame_height)

        return SpatialVector(x=norm_x, y=norm_y, z=norm_z)
