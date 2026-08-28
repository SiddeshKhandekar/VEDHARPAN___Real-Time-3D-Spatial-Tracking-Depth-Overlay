"""
verify_stream.py — VEDHARPAN Phase 1: Terminal Telemetry Verification Script

PURPOSE:
    Standalone test client that connects to the WebSocket broker at
    ws://localhost:8765 and measures the real-time telemetry stream.

    Prints a live, formatted readout of every received JSON frame and, after
    a configurable duration, reports the achieved frames-per-second rate.

USAGE:
    1.  In Terminal A — start the backend:
            python main.py

    2.  In Terminal B — run this verification script:
            python verify_stream.py

    3.  Move your head and hand in front of the webcam. You should see the
        (x, y, z) coordinates updating live. After TEST_DURATION_SECONDS the
        script exits and prints the achieved FPS.

EXPECTED OUTCOME (Phase 1 Definition of Done):
    - Achieved FPS ≥ 60.
    - head.x, head.y values change as you move your head.
    - hand.x, hand.y values change as you move your hand/wrist.
    - All values are in the [-1.0, 1.0] normalised range.
"""

import asyncio
import json
import sys
import time

import websockets

# ---------------------------------------------------------------------------
# Test configuration
# ---------------------------------------------------------------------------

TARGET_URI:          str   = "ws://localhost:8765"
TEST_DURATION_SECONDS: int = 15     # How many seconds to run the test
PRINT_EVERY_N_FRAMES:  int = 6      # Print 1 out of every N frames to avoid console flood


async def run_verification() -> None:
    """Connect to the telemetry broker and measure stream quality.

    Prints live frame data and reports achieved FPS at the end of the test.
    """
    print()
    print("=" * 65)
    print("  VEDHARPAN — Phase 1 Telemetry Stream Verification")
    print("=" * 65)
    print(f"  Connecting to: {TARGET_URI}")
    print(f"  Test duration: {TEST_DURATION_SECONDS} seconds")
    print(f"  Move your HEAD and HAND in front of the webcam.")
    print("=" * 65)
    print()

    try:
        async with websockets.connect(TARGET_URI) as ws:
            print("  ✅ Connected successfully. Receiving frames...\n")

            frames_received: int  = 0
            test_start:      float = time.perf_counter()
            test_deadline:   float = test_start + TEST_DURATION_SECONDS

            async for raw_message in ws:
                if time.perf_counter() >= test_deadline:
                    break

                frames_received += 1

                # Print a human-readable summary of every Nth frame.
                if frames_received % PRINT_EVERY_N_FRAMES == 0:
                    try:
                        data = json.loads(raw_message)
                        head = data.get("head", {})
                        hand = data.get("hand", {})

                        # Compute elapsed seconds for display.
                        elapsed = time.perf_counter() - test_start
                        running_fps = frames_received / max(elapsed, 0.001)

                        print(
                            f"  [t={elapsed:5.1f}s | {running_fps:5.1f} FPS]  "
                            f"HEAD  x={head.get('x', 0.0):+.3f}  "
                            f"y={head.get('y', 0.0):+.3f}  "
                            f"z={head.get('z', 0.0):+.3f}    "
                            f"HAND  x={hand.get('x', 0.0):+.3f}  "
                            f"y={hand.get('y', 0.0):+.3f}  "
                            f"z={hand.get('z', 0.0):+.3f}"
                        )

                    except (json.JSONDecodeError, KeyError) as exc:
                        print(f"  ⚠️  Failed to parse frame: {exc}")

            # --- Final report ---
            total_elapsed = time.perf_counter() - test_start
            achieved_fps  = frames_received / max(total_elapsed, 0.001)

            print()
            print("=" * 65)
            print("  VERIFICATION RESULTS")
            print("=" * 65)
            print(f"  Total frames received : {frames_received}")
            print(f"  Total elapsed time    : {total_elapsed:.2f} s")
            print(f"  Achieved FPS          : {achieved_fps:.1f}")
            print()

            if achieved_fps >= 60.0:
                print("  ✅ PASS — 60 Hz target met. Phase 1 complete.")
            elif achieved_fps >= 30.0:
                print(
                    "  ⚠️  PARTIAL — FPS above 30 but below 60. "
                    "Check CPU load or camera driver settings."
                )
            else:
                print(
                    "  ❌ FAIL — FPS below 30. Check webcam FPS capability, "
                    "CUDA/MediaPipe installation, and system load."
                )
            print("=" * 65)
            print()

    except ConnectionRefusedError:
        print(
            "\n  ❌ CONNECTION REFUSED\n"
            "  Could not reach the WebSocket server at "
            f"{TARGET_URI}.\n\n"
            "  Make sure 'python main.py' is running in another terminal "
            "before launching this script.\n"
        )
        sys.exit(1)

    except Exception as exc:
        print(f"\n  ❌ Unexpected error: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_verification())
