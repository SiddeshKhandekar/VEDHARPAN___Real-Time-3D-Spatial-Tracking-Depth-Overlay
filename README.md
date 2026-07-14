# VEDHARPAN: Real-Time Anamorphic Parallax and Ray-Traced 3D Shadow Engine

> **Current Status:** 🚧 *Active Development — Scaffolding the multi-threaded vision and rendering pipelines.*

## Why I'm Building This
Most spatial computing and augmented reality experiences require expensive headsets or specialized depth sensors. I wanted to challenge that limitation by asking a simple question: **Can we turn a standard 1080p webcam into a responsive, zero-latency spatial projection engine?**

VEDHARPAN is an exploration into real-time computer vision, mathematical coordinate mapping, and UI rendering. The goal is to detect a user's physical proximity and hand movements in 3D space $(x, y, z)$ and cast a dynamic, interactive "shadow" directly onto the desktop monitor that scales, blurs, and shifts in real time as you move closer or further from the screen.

---

## 🧠 System Architecture & Engineering Goals

To achieve a seamless, natural feel without UI lag, the system is designed around a decoupled, asynchronous architecture:

1. **The Sensor Layer (Vision Pipeline):** Captures high-speed video feeds and utilizes lightweight ML models (MediaPipe) to extract 21-point spatial landmarks in real time.
2. **The Math & Calibration Engine:** Transforms normalized camera coordinates into monitor pixel space while applying an **Exponential Moving Average (EMA)** filter to eliminate jitter and mathematical noise.
3. **The Rendering Layer (GUI Overlay):** A frameless, transparent desktop overlay built with PyQt6 that utilizes alpha-blending and dynamic Gaussian blur scaling to simulate real-world depth and physics.

---

## 🗺️ Engineering Roadmap

I am building this project iteratively, focusing on mathematical precision and frame-rate optimization at each step:

- [x] **Phase 0: Environment & Architecture Setup**
  - Configured repository structure, MIT licensing, and strict `.gitignore` rules for media and model caching.
- [ ] **Phase 1: The Vision Pipeline (`vision_pipeline.py`)**
  - Integrate OpenCV and MediaPipe Hands for multi-threaded webcam streaming.
  - Implement depth ($z$-axis) approximation and EMA coordinate smoothing.
- [ ] **Phase 2: The Overlay Engine (`gui_overlay.py`)**
  - Build a custom, transparent PyQt6 window with "always-on-top" and mouse-click passthrough flags.
  - Create the dynamic alpha-blended silhouette rendering logic.
- [ ] **Phase 3: Pipeline Integration (`main.py`)**
  - Connect the asynchronous vision thread to the GUI rendering loop.
  - Optimize frame buffer memory to maintain a steady **30+ FPS** on standard hardware.
- [ ] **Phase 4: Calibration & Polish**
  - Add auto-calibration for different webcam focal lengths and lighting environments.
  - Record performance benchmarks and demo visuals.

---

## 🛠️ Tech Stack
* **Core Language:** Python 3.10+
* **Computer Vision:** OpenCV (`cv2`), Google MediaPipe
* **Mathematics & Matrix Ops:** NumPy
* **GUI & Rendering:** PyQt6 (Custom frameless window rendering)

---

## 🤝 Following the Build
This repository is being actively updated as each subsystem comes online. If you are a recruiter, fellow engineer, or just curious about spatial computing and computer vision, feel free to star ⭐ the repo or reach out to discuss the architecture!
