"""Desktop app entry point.

Opens a native pywebview window that loads the local web/ front end and
binds the Api class (api.py) as the JS-API bridge, so the page can call
window.pywebview.api.<function_name>(...) directly. No local HTTP server
and no internet connection are required to run the app itself.
"""

from __future__ import annotations

import sys
from pathlib import Path

import webview

from api import Api

APP_TITLE = "Process Monitor Data Organizer"


def resource_path(relative: str) -> Path:
    """Resolve a path next to the script, or inside the PyInstaller bundle."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative


def main() -> int:
    api = Api()
    index_file = resource_path("web/index.html")

    window = webview.create_window(
        APP_TITLE,
        url=str(index_file),
        js_api=api,
        width=1400,
        height=860,
        min_size=(1100, 700),
    )
    api.set_window(window)
    webview.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
