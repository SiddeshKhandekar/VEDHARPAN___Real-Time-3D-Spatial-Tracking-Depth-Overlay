"""
gui_overlay.py — VEDHARPAN Phase 3: Native Desktop Presentation Layer

Responsibility:
    Constructs a frameless, transparent, always-on-top PyQt6 window
    hosting a QWebEngineView. The WebEngineView loads the local WebGL
    Three.js diorama viewport.

    Enables OS-level mouse-click passthrough so that the diorama renders
    as a seamless holographic overlay on top of the user's desktop
    without blocking standard desktop interactions.

Usage:
    Called by main.py to spin up the presentation layer.
"""

import logging
import os
import sys
from typing import Optional

from PyQt6.QtCore import QUrl, Qt
from PyQt6.QtGui import QResizeEvent
from PyQt6.QtWidgets import QApplication, QMainWindow
from PyQt6.QtWebEngineCore import QWebEngineSettings
from PyQt6.QtWebEngineWidgets import QWebEngineView

logger = logging.getLogger(__name__)


class TransparentOverlay(QMainWindow):
    """Frameless, transparent, always-on-top QMainWindow hosting WebEngineView.

    Attributes:
        html_path: Absolute or relative filesystem path to the target index.html.
    """

    def __init__(self, html_path: str) -> None:
        super().__init__()
        self.html_path: str = html_path
        self.web_view: Optional[QWebEngineView] = None

        self._configure_window_properties()
        self._setup_web_view()
        logger.info("TransparentOverlay: GUI window successfully initialized.")

    def _configure_window_properties(self) -> None:
        """Applies transparent, frameless, stay-on-top, and click-passthrough flags."""
        # Window flags:
        # - FramelessWindowHint: Removes title bar and OS borders.
        # - WindowStaysOnTopHint: Forces window to render above other applications.
        # - SubWindow: Prevents creating a separate taskbar entry on some platforms.
        # - TransparentForMouseEvents: Enables OS-level click-passthrough.
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.SubWindow |
            Qt.WindowType.TransparentForMouseEvents
        )

        # Translucent widget background configuration
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setStyleSheet("background: transparent;")

        # Set window size to match primary screen geometry
        screen = QApplication.primaryScreen()
        if screen:
            self.setGeometry(screen.geometry())
            logger.info("TransparentOverlay: Bounds set to screen resolution: %s", screen.geometry())
        else:
            self.showFullScreen()
            logger.warning("TransparentOverlay: Screen geometry not detected, falling back to fullscreen.")

    def _setup_web_view(self) -> None:
        """Creates and configures the embedded QWebEngineView."""
        self.web_view = QWebEngineView(self)
        self.web_view.setGeometry(self.rect())
        self.web_view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.web_view.setStyleSheet("background: transparent;")
        
        # Prevent page background filling with solid colors
        self.web_view.page().setBackgroundColor(Qt.GlobalColor.transparent)

        # Allow local content to access file schemes and cross-origin urls
        settings = self.web_view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)

        # Resolve path and load HTML file
        absolute_html_path = os.path.abspath(self.html_path)
        if not os.path.exists(absolute_html_path):
            logger.error("TransparentOverlay: HTML file not found at %s", absolute_html_path)

        url = QUrl.fromLocalFile(absolute_html_path)
        logger.info("TransparentOverlay: Loading local WebGL scene: %s", url.toLocalFile())
        self.web_view.load(url)

        self.setCentralWidget(self.web_view)

    def resizeEvent(self, event: QResizeEvent) -> None:
        """Maintains full-screen bounds on QWebEngineView when widget size changes.

        Args:
            event: QResizeEvent details.
        """
        super().resizeEvent(event)
        if self.web_view:
            self.web_view.setGeometry(self.rect())


def run_gui(html_path: str) -> None:
    """Helper method to run a standalone test of the GUI layer.

    Args:
        html_path: Path to the frontend index.html file.
    """
    app = QApplication(sys.argv)
    overlay = TransparentOverlay(html_path)
    overlay.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    # Configure fallback logger when run directly for testing
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
    # Point to the local frontend directory
    run_gui("frontend/index.html")
