# Product Requirement Document (PRD): VEDHARPAN
**Project Title:** Real-Time Anamorphic Parallax & Ray-Traced 3D Shadow Engine  
**Architecture Style:** Decoupled Client-Server (Python AI Backend + Three.js WebGL Frontend via WebSockets)  
**Target Environment:** Local Desktop (Windows / macOS / Linux with NVIDIA RTX / CUDA Acceleration)  

---

## 1. Executive Summary & Objective
ShadowSync 2.0 is a real-time spatial computing engine that transforms a standard desktop monitor into an anamorphic holographic "window box" (diorama) without requiring specialized VR/AR headsets. 

Utilizing a standard 1080p RGB webcam and local NVIDIA RTX / CUDA GPU acceleration, the application executes simultaneous dual-target computer vision:
1. **Head & Eye Tracking (Parallax):** Extracts real-time spatial coordinates $(x, y, z)$ of the user's eyes to dynamically warp an off-axis camera projection matrix in a 3D scene. As the user physically moves their head in front of the monitor, the virtual camera shifts, revealing true depth and perspective inside the 3D room box.
2. **Hand Tracking (Dynamic Occlusion):** Tracks the spatial coordinates $(x, y, z)$ of the user's hand to position an invisible 3D light-occluder mesh. This mesh sits between a digital directional light and the 3D diorama models (e.g., sports cars, skeletons, architectural interiors), casting real-time, ray-traced shadows that physically bend and conform across curved surfaces.

---

## 2. System Architecture & Data Flow
To guarantee a minimum rendering standard of **60+ FPS** and prevent desktop UI freezing, the system enforces a decoupled client-server architecture. Heavy Tensor/CUDA inference runs asynchronously on a backend Python server, streaming lightweight telemetry to a hardware-accelerated WebGL frontend embedded within a native desktop wrapper.


```

[Webcam Stream @ 1080p]
│
▼
(vision_pipeline.py: CUDA-Accelerated Dual Tracker)
├── Tracks Face/Eyes -> Calculates Interpupillary Depth & Off-Axis Vector
├── Tracks Hand/Wrist -> Extracts Center of Mass Coordinates $(x, y, z)$
└── Applies Exponential Moving Average (EMA) Signal Filtering
│
▼ (Async JSON over WebSocket @ ws://localhost:8765 | ~1ms latency)
(main.py: Local Telemetry Broker & Lifecycle Controller)
│
▼
(gui_overlay.py: PyQt6 Transparent Window hosting QWebEngineView)
│
▼
(/frontend/scene.js: Three.js 3D Viewport Engine)
├── Anamorphic Parallax -> Warps Frustum via camera.setViewOffset()
└── Shadow Physics -> Moves Invisible Light Occluder over .GLB/.GLTF Models

```

---

## 3. Technical Specifications & Module Breakdown

### 3.1 AI Vision Backend (`vision_pipeline.py`)
* **Core Frameworks:** OpenCV (`cv2`), PyTorch / TensorRT, or Google MediaPipe (Face Mesh + Hands accelerated via CUDA).
* **Dual-Target Inference Targets:**
  * **Head/Eye Vector (Parallax):** Anchor to the left and right pupil centers (or eye bridge). Compute metric distance ($z$-depth) by measuring the pixel delta against standard Interpupillary Distance (IPD scaling).
  * **Hand Occluder (Shadow Physics):** Anchor to the primary wrist landmark (`WRIST`, index 0) or the center of the palm bounding box to ensure a stable shadow center of mass.
* **Signal Smoothing (EMA Filter):** Raw vision telemetry must pass through an Exponential Moving Average math filter prior to network broadcast to eliminate coordinate jitter and visual stutter:
  $$S_t = \alpha \cdot Y_t + (1 - \alpha) \cdot S_{t-1}$$
  *Configure smoothing coefficient $\alpha = 0.15$ for camera perspective (prioritizing stability) and $\alpha = 0.25$ for the shadow occluder (prioritizing responsiveness).*
* **Normalization:** Map raw camera pixel space into normalized $[-1.0, 1.0]$ Cartesian coordinates before transmission.

### 3.2 Telemetry Broker & Lifecycle Controller (`main.py`)
* **Core Frameworks:** `asyncio` and `websockets` (or FastAPI with Uvicorn).
* **Network Protocol:** Initializes a local WebSocket server binding to `ws://localhost:8765`.
* **Telemetry Payload Schema:** Broadcasts structured JSON payloads at a minimum rate of 60 ticks per second:
  ```json
  {
    "head": { "x": 0.04, "y": -0.02, "z": 0.68 },
    "hand": { "x": -0.18, "y": 0.10, "z": 0.32 },
    "timestamp": 1721000123.456
  }

```

* **Thread Safety:** The vision processing loop must run in a dedicated background worker thread (`QThread` or `concurrent.futures`), placing telemetry frames into a non-blocking queue consumed by the async WebSocket broadcaster.

### 3.3 3D Viewport & Physics Engine (`/frontend`)

* **Core Frameworks:** HTML5, Modern ES6+ JavaScript, and **Three.js** (or React Three Fiber).
* **Asset Pipeline:** Load standardized 3D models (`.GLB` or `.GLTF` formats) from the `/frontend/assets/` directory. Required baseline assets include a 3D recessed room diorama (Cornell Box style) and a central high-detail mesh (e.g., vehicle, anatomical model, or geometric sculpture).
* **Parallax Camera Math:** Map incoming `head` JSON coordinates to dynamically shift the Three.js perspective camera's physical position while adjusting the asymmetric viewing frustum:
```javascript
// Adjust camera frustum offsets to create head-coupled window illusion
camera.setViewOffset(fullWidth, fullHeight, xOffset, yOffset, width, height);

```


* **Shadow Occlusion Math:**
* Instantiate a high-output `DirectionalLight` pointing from the top-front toward the interior of the room box.
* Instantiate an invisible 3D primitive (e.g., low-poly sphere or hand mesh) linked directly to the incoming `hand` $(x, y, z)$ coordinates.
* Set `castShadow = true` on the occluder primitive and `receiveShadow = true` on all diorama background walls and centerpieces. Enable Three.js PCFSoftShadowMap for physically realistic edge diffusion.



### 3.4 Native Desktop Presentation Layer (`gui_overlay.py`)

* **Core Frameworks:** `PyQt6`, `PyQt6-WebEngine` (`QWebEngineView`).
* **Window Configuration Flags:** The application window must instantiate with strict OS-level flags to operate as a frameless, transparent desktop overlay:
* `Qt.WindowType.FramelessWindowHint`: Removes title bar and OS window borders.
* `Qt.WindowType.WindowStaysOnTopHint`: Forces the viewport above standard desktop applications.
* `Qt.WindowType.TransparentForMouseEvents`: Enables mouse click-passthrough so user desktop interactions (clicking icons, opening files) remain unblocked by the overlay canvas.


* **Alpha Blending:** Explicitly enable background translucency on the QWidget container:
```python
self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)

```


* **Local Rendering:** Point the `QWebEngineView` directly to the local HTML file: `file:///path/to/project/frontend/index.html`.

---

## 4. Phased Implementation Roadmap & Definition of Done

### Phase 1: AI Vision Backend & WebSocket Broker

* **Target Files:** `vision_pipeline.py`, `main.py`, `requirements.txt`.
* **Objective:** Establish reliable GPU-accelerated dual tracking and broadcast clean JSON telemetry over a local network socket.
* **Definition of Done:** Running `python main.py` initiates the webcam stream, executes simultaneous eye and hand tracking without memory leaks, applies the EMA filter, and successfully outputs JSON telemetry to a test terminal client connected to `ws://localhost:8765` at **60+ FPS**.

### Phase 2: Three.js 3D Viewport & Physics Engine

* **Target Files:** `/frontend/index.html`, `/frontend/scene.js`, `/frontend/style.css`, `/frontend/assets/`.
* **Objective:** Build the standalone 3D diorama scene and bind camera/light physics to the WebSocket telemetry stream.
* **Definition of Done:** Opening `index.html` in a standard desktop browser automatically establishes a WebSocket connection to the Python backend. Moving your head in front of the webcam physically shifts the perspective inside the 3D room box (anamorphic parallax), and moving your hand casts a real-time ray-traced shadow that bends accurately across the 3D models.

### Phase 3: Desktop Overlay Wrapper & Lifecycle Integration

* **Target Files:** `gui_overlay.py`, `main.py`.
* **Objective:** Wrap the WebGL viewport into a native, transparent desktop application with OS click-passthrough and automated resource cleanup.
* **Definition of Done:** Launching `main.py` opens a borderless, always-on-top transparent window over the OS desktop. The 3D diorama renders cleanly over the desktop wallpaper, mouse clicks pass through to background applications, and closing the application safely releases the OpenCV webcam sensor and shuts down the async WebSocket server without OS error dialogs.

---

## 5. Non-Functional & Engineering Quality Standards

* **Strict Type Hinting:** All Python functions, variables, and class methods must implement explicit Python type annotations (`from typing import Dict, Tuple, Optional, Any`).
* **Comprehensive Docstrings:** Every class and public method must include Google-style docstrings defining parameters, return types, and potential raised exceptions.
* **Defensive Hardware I/O:** Wrap all video capture initialization (`cv2.VideoCapture`) and network socket bindings in explicit `try-except-finally` blocks. If the webcam is busy or disconnected, log a clean, readable error to the terminal without dumping an unhandled stack trace.
* **Graceful Teardown:** The application must capture OS termination signals (`SIGINT`, `SIGTERM`) and GUI close events to ensure absolute release of GPU resources, camera threads (`cap.release()`), and socket ports (`server.close()`).

```

```