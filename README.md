# Process Monitor Data Organizer — Desktop App

A local desktop app that organizes Monitor exports into per-process Excel
reports. It wraps the original `process_monitor_organizer.py` data logic
in a [pywebview](https://pywebview.flowrl.com/) window with a modern
HTML/CSS/JS front end, instead of the original tkinter UI.

## How it's put together

- `organizer_core.py` — the unmodified data-processing core (reading
  Monitor exports, organizing each process module, exporting Excel). No
  UI code. This is the same logic that shipped in the original
  `process_monitor_organizer.py`, with the tkinter `OrganizerApp` class
  removed.
- `api.py` — the pywebview JS-API bridge (`Api` class). The front end
  calls its methods as `window.pywebview.api.<function_name>(...)`. It
  owns per-module state (selected input/output files, last preview data,
  duplicate-measurement selections) for the life of the window, and
  drives native OS file dialogs via `window.create_file_dialog(...)`.
- `main.py` — creates the pywebview window and binds `Api` to it. No
  terminal window, no separate HTTP server: pywebview loads `web/index.html`
  straight off disk.
- `web/` — the front end: `index.html`, `app.js`, `styles.css`. Styled
  with the Tailwind CDN build (`<script src="https://cdn.tailwindcss.com">`)
  plus a small stylesheet for buttons/tables/sidebar states.
- `process_monitor_organizer.spec` — PyInstaller spec that bundles `web/`
  as data and produces a single windowed (no console) executable.

No database, no automatic file watching: every input/output file is
picked explicitly by the user through native file dialogs.

## Process modules exposed in the UI

Same 11 modules as the original app (`1.03` through `1.11`), sourced
from `organizer_core.PROCESS_CONFIGS`. `1.10 Destacking` has no defined
output schema in Monitor yet, so its panel shows a notice instead of the
preview/export controls, matching the original app's behavior.

## Running in development

Requires Python 3.11+ (uses `from __future__ import annotations` and
`X | Y` type syntax throughout, matching the original script).

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
python main.py
```

On Windows you can also just double-click `Run_Process_Monitor_Organizer.bat`,
which creates the virtual environment on first run, installs dependencies,
and launches the app the same way the original `.bat` launcher did.

## Building the single-file Windows executable

```bash
pip install -r requirements.txt   # includes pyinstaller
pyinstaller process_monitor_organizer.spec
```

Or just run `build_windows.bat`, which does the same thing end to end.
The result is `dist\Process Monitor Data Organizer.exe` — double-click to
run, no terminal window, no Python install required on the target
machine. The spec file bundles the `web/` folder into the executable and
resolves it at runtime via `sys._MEIPASS` (see `resource_path()` in
`main.py`), and pulls in the `pywebview`/`pythonnet`/`clr_loader` hidden
imports PyInstaller can't detect automatically on Windows (pywebview's
default Windows renderer is EdgeChromium/WebView2).

The target machine needs the Microsoft Edge WebView2 Runtime, which
ships pre-installed on Windows 11 and current Windows 10 updates; if it's
missing, WebView2 offers to install it automatically, or you can bundle
the [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/) alongside the exe.

## No networking dependency

Styling is a self-contained stylesheet (`web/styles.css`) rather than the
Tailwind CDN build. An earlier version of this app loaded Tailwind from
`cdn.tailwindcss.com`, which is a blocking `<script>` tag — on a machine
without internet access (or a blocked/slow connection to that CDN), the
page load stalls before the app's own `app.js` ever runs, so the whole UI
looks dead: no sidebar, no working buttons. `styles.css` now defines every
utility class the page actually uses, so the app works fully offline with
no first-paint network dependency at all.

## Verification files

The original verification fixtures still apply to `organize_process` /
`export_excel` in `organizer_core.py` unchanged: `test_monitor_exact_layout.xlsx`,
`test_output.xlsx`, `test_all_stations_mixing_output.xlsx`,
`test_all_modules_monitor.xlsx`, `test_all_modules_outputs.xlsx`,
`test_exact_monitor_layout.py`, `test_all_process_modules.py`.
