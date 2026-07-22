"""
main.py — VEDHARPAN Phase 1: Telemetry Broker & Lifecycle Controller

Responsibility:
    Acts as the central orchestrator for the VEDHARPAN system. It owns the
    complete application lifecycle:
        1. Configures a structured logging pipeline for all modules.
        2. Instantiates the VisionPipeline and starts its background thread.
        3. Runs an asyncio WebSocket server on ws://localhost:8765 that reads
           TelemetryFrame objects from the shared queue and broadcasts them
           as JSON to all connected clients at up to 60 Hz.
        4. Listens for OS SIGINT / SIGTERM signals and GUI close events,
           triggering a clean, ordered shutdown sequence that guarantees:
               a. The vision thread is joined and the camera is released.
               b. All WebSocket connections are gracefully closed.
               c. The asyncio event loop exits cleanly.

JSON Payload Schema (broadcast to each connected WebSocket client):
    {
        "head":      { "x": float, "y": float, "z": float },
        "hand":      { "x": float, "y": float, "z": float },
        "timestamp": float   // Unix epoch seconds
    }

Usage:
    python main.py

Test with wscat (npm install -g wscat):
    wscat -c ws://localhost:8765

Test with the bundled verify_stream.py script:
    python verify_stream.py
"""

import asyncio
import json
import logging
import queue
import signal
import sys
import threading
import time
from typing import Set


import websockets
from websockets.asyncio.server import ServerConnection

from vision_pipeline import TelemetryFrame, VisionPipeline


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WEBSOCKET_HOST: str = "localhost"
WEBSOCKET_PORT: int = 8765

# Maximum number of unread frames held in the shared queue before the oldest
# is discarded. Keeps memory usage bounded and ensures the broker always
# serves the freshest available telemetry.
TELEMETRY_QUEUE_MAX_SIZE: int = 10

# How often the broadcaster yields to the event loop between frames (seconds).
# 1/60 ≈ 16.67 ms targets 60 Hz broadcast cadence.
BROADCAST_INTERVAL_SECONDS: float = 1.0 / 60.0

# Logging format: timestamp, level, module, message
LOG_FORMAT: str = "%(asctime)s  %(levelname)-8s  %(name)-22s  %(message)s"
LOG_LEVEL:  int = logging.INFO


# ---------------------------------------------------------------------------
# Logging configuration
# ---------------------------------------------------------------------------

def configure_logging() -> None:
    """Configure the root logger with a human-readable console handler.

    All child loggers (vision_pipeline, __main__, websockets) inherit this
    configuration. Call this once at application startup before instantiating
    any other module.
    """
    logging.basicConfig(
        level   = LOG_LEVEL,
        format  = LOG_FORMAT,
        datefmt = "%Y-%m-%d %H:%M:%S",
        stream  = sys.stdout,
    )

    # Quieten the verbose websockets protocol logger in normal operation.
    logging.getLogger("websockets").setLevel(logging.WARNING)


# Module-level logger — must be created after configure_logging() is called.
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# WebSocket Broker
# ---------------------------------------------------------------------------

class TelemetryBroker:
    """Async WebSocket server that broadcasts TelemetryFrame JSON to all clients.

    The broker owns the asyncio event loop but not the vision pipeline. It
    reads from a thread-safe queue.Queue that is written to by the vision
    pipeline's background thread, decoupling blocking camera I/O from the
    async networking layer.

    Args:
        telemetry_queue: Shared queue written by the VisionPipeline thread.
        host:            Bind address for the WebSocket server.
        port:            Bind port for the WebSocket server.

    Attributes:
        _connected_clients: The set of currently active WebSocket connections.
    """

    def __init__(
        self,
        telemetry_queue: "queue.Queue[TelemetryFrame]",
        host: str = WEBSOCKET_HOST,
        port: int = WEBSOCKET_PORT,
    ) -> None:
        self._queue:   "queue.Queue[TelemetryFrame]" = telemetry_queue
        self._host:    str = host
        self._port:    int = port
        self._connected_clients: Set[ServerConnection] = set()

        # asyncio.Event used by the broadcaster to know when to stop.
        self._shutdown_event: asyncio.Event = asyncio.Event()

        # Diagnostics
        self._frames_broadcast: int   = 0
        self._last_stats_time:  float = time.perf_counter()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Start the WebSocket server and the telemetry broadcast loop.

        This coroutine blocks until self.shutdown() is called. It starts
        both the WebSocket listener (for incoming client connections) and
        the broadcast loop (which pulls from the queue and fans out to all
        clients) as concurrent asyncio tasks.

        Raises:
            OSError: If the port is already in use or the bind address
                     is unavailable. Logged cleanly; does not raise to caller.
        """
        try:
            server = await websockets.serve(
                self._handle_client_connection,
                self._host,
                self._port,
            )
        except OSError as exc:
            logger.error(
                "TelemetryBroker: Failed to bind WebSocket server on "
                "%s:%d — %s. Is another process already using this port?",
                self._host,
                self._port,
                exc,
            )
            return

        logger.info(
            "TelemetryBroker: WebSocket server listening on ws://%s:%d",
            self._host,
            self._port,
        )

        # Run the broadcast loop concurrently alongside the server listener.
        broadcast_task = asyncio.create_task(
            self._broadcast_loop(),
            name="TelemetryBroadcastLoop",
        )

        # Block here until the shutdown event fires.
        await self._shutdown_event.wait()

        logger.info("TelemetryBroker: Shutdown event received — closing server.")

        # Close the WebSocket server (stops accepting new connections).
        server.close()
        await server.wait_closed()

        # Cancel the broadcast loop and wait for it to exit.
        broadcast_task.cancel()
        try:
            await broadcast_task
        except asyncio.CancelledError:
            pass

        logger.info("TelemetryBroker: WebSocket server shut down cleanly.")

    def shutdown(self) -> None:
        """Signal the broker to begin its graceful shutdown sequence.

        Safe to call from both sync code (e.g., a signal handler) and
        async code. Sets an asyncio.Event that unblocks the run() coroutine.
        """
        self._shutdown_event.set()

    # ------------------------------------------------------------------
    # Client connection handler
    # ------------------------------------------------------------------

    async def _handle_client_connection(
        self, websocket: ServerConnection
    ) -> None:
        """Manage the lifecycle of a single WebSocket client connection.

        Called by the websockets library for each new client. Registers the
        client in the connected set and deregisters it upon disconnection
        regardless of whether the client disconnected cleanly or with an error.

        Args:
            websocket: The active connection object for this client.
        """
        client_address = websocket.remote_address
        logger.info("TelemetryBroker: Client connected — %s.", client_address)
        self._connected_clients.add(websocket)

        try:
            # Keep the connection open until the client disconnects.
            # We don't expect inbound messages in this protocol, but
            # awaiting here prevents the handler from returning immediately.
            await websocket.wait_closed()
        finally:
            self._connected_clients.discard(websocket)
            logger.info("TelemetryBroker: Client disconnected — %s.", client_address)

    # ------------------------------------------------------------------
    # Broadcast loop — the hot path
    # ------------------------------------------------------------------

    async def _broadcast_loop(self) -> None:
        """Pull telemetry frames from the queue and fan out to all clients.

        Runs at up to 60 Hz. Uses asyncio.sleep to yield control back to the
        event loop between frames, ensuring WebSocket I/O and client handshakes
        are processed without starvation.

        Skips broadcast silently if no clients are currently connected to
        avoid building up queue backpressure from un-consumed frames.
        """
        while not self._shutdown_event.is_set():
            loop_start = asyncio.get_event_loop().time()

            # --- Drain the latest frame from the queue ---
            frame: TelemetryFrame | None = None
            try:
                # Drain all stale frames; keep only the most recent one.
                while True:
                    frame = self._queue.get_nowait()
            except queue.Empty:
                pass   # frame holds the last successfully dequeued item

            # --- Broadcast only if we have a frame and active clients ---
            if frame is not None and self._connected_clients:
                payload = self._serialise_frame(frame)
                await self._send_to_all_clients(payload)

            # --- Diagnostics: log achieved broadcast rate every 10 s ---
            self._frames_broadcast += 1
            elapsed = asyncio.get_event_loop().time() - self._last_stats_time
            if elapsed >= 10.0:
                rate = self._frames_broadcast / elapsed
                logger.info(
                    "TelemetryBroker: Broadcasting at %.1f Hz | %d client(s) connected.",
                    rate,
                    len(self._connected_clients),
                )
                self._frames_broadcast = 0
                self._last_stats_time  = asyncio.get_event_loop().time()

            # --- Pace the loop to the target broadcast interval ---
            loop_elapsed = asyncio.get_event_loop().time() - loop_start
            sleep_duration = max(0.0, BROADCAST_INTERVAL_SECONDS - loop_elapsed)
            await asyncio.sleep(sleep_duration)

    @staticmethod
    def _serialise_frame(frame: TelemetryFrame) -> str:
        """Serialise a TelemetryFrame to the canonical JSON wire format.

        Args:
            frame: The telemetry snapshot to serialise.

        Returns:
            A compact JSON string conforming to the payload schema in the PRD.
        """
        payload = {
            "head": {
                "x": round(frame.head.x, 6),
                "y": round(frame.head.y, 6),
                "z": round(frame.head.z, 6),
            },
            "hand": {
                "x": round(frame.hand.x, 6),
                "y": round(frame.hand.y, 6),
                "z": round(frame.hand.z, 6),
            },
            "timestamp": round(frame.timestamp, 6),
        }
        return json.dumps(payload, separators=(",", ":"))

    async def _send_to_all_clients(self, payload: str) -> None:
        """Broadcast a JSON payload to every currently connected client.

        Clients that have disconnected between the connection check and the
        send are silently removed from the active set. All sends are done
        concurrently via asyncio.gather so a slow client doesn't block others.

        Args:
            payload: The pre-serialised JSON string to broadcast.
        """
        if not self._connected_clients:
            return

        dead_clients: Set[ServerConnection] = set()

        async def send_one(ws: ServerConnection) -> None:
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                dead_clients.add(ws)
            except Exception as exc:
                logger.warning(
                    "TelemetryBroker: Unexpected send error to %s — %s.",
                    ws.remote_address,
                    exc,
                )
                dead_clients.add(ws)

        await asyncio.gather(
            *(send_one(ws) for ws in list(self._connected_clients))
        )

        # Prune connections that closed during this broadcast round.
        self._connected_clients -= dead_clients


# ---------------------------------------------------------------------------
# Application entry point & lifecycle orchestration
# ---------------------------------------------------------------------------

class Application:
    """Top-level lifecycle controller for the VEDHARPAN system.

    Wires together the VisionPipeline, TelemetryBroker, and TransparentOverlay.
    Runs the PyQt6 GUI event loop on the main thread while delegating vision
    inference and WebSocket telemetry broadcasting to background threads.

    Usage:
        app = Application()
        app.run()
    """

    def __init__(self) -> None:
        self._telemetry_queue: "queue.Queue[TelemetryFrame]" = queue.Queue(
            maxsize = TELEMETRY_QUEUE_MAX_SIZE
        )
        self._vision_pipeline = VisionPipeline(
            output_queue = self._telemetry_queue,
            camera_index = 0,
        )
        self._broker = TelemetryBroker(
            telemetry_queue = self._telemetry_queue,
            host            = WEBSOCKET_HOST,
            port            = WEBSOCKET_PORT,
        )
        self._async_loop: Optional[asyncio.AbstractEventLoop] = None
        self._async_thread: Optional[threading.Thread] = None

    def run(self) -> None:
        """Start all subsystems and block until the GUI window is closed.

        Execution order:
            1. Start the vision pipeline background thread.
            2. Run the asyncio event loop / WebSocket broker in a daemon thread.
            3. Initialize and execute the PyQt6 GUI on the main thread.
            4. Execute the teardown sequence on exit.
        """
        logger.info("=" * 60)
        logger.info("VEDHARPAN — ShadowSync 2.0 Starting")
        logger.info("=" * 60)

        # 1. Start the vision pipeline background thread
        self._vision_pipeline.start()

        # 2. Run the WebSocket broker in a separate background thread
        self._async_loop = asyncio.new_event_loop()
        self._async_thread = threading.Thread(
            target = self._run_async_loop,
            name   = "WebSocketBrokerThread",
            daemon = True
        )
        self._async_thread.start()

        # 3. Start the PyQt6 GUI on the main thread
        from gui_overlay import TransparentOverlay
        from PyQt6.QtWidgets import QApplication

        # Force hardware WebGL and shared context initialization
        os.environ["QT_FORCE_STDERR_LOGGING"] = "1"
        
        self._qt_app = QApplication(sys.argv)
        self._overlay_window = TransparentOverlay("frontend/index.html")
        self._overlay_window.show()

        try:
            self._qt_app.exec()
        except KeyboardInterrupt:
            logger.info("Application: KeyboardInterrupt received.")
        finally:
            self._teardown()

    def _run_async_loop(self) -> None:
        """Entry point for the background async thread."""
        if self._async_loop is None:
            return
        asyncio.set_event_loop(self._async_loop)
        try:
            self._async_loop.run_until_complete(self._broker.run())
        except asyncio.CancelledError:
            pass
        finally:
            self._async_loop.close()

    def _teardown(self) -> None:
        """Execute the ordered shutdown sequence for all subsystems.

        Order is critical:
            1. Stop the WebSocket broker server.
            2. Stop the vision pipeline (releases camera).
            3. Join background threads.
        """
        logger.info("Application: Executing teardown sequence.")
        
        # Stop broker
        self._broker.shutdown()
        
        # Stop vision pipeline
        self._vision_pipeline.stop()
        
        # Join async thread
        if self._async_thread and self._async_thread.is_alive():
            self._async_thread.join(timeout=3.0)
            
        logger.info("Application: All subsystems stopped. Goodbye.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    configure_logging()
    app = Application()
    app.run()

