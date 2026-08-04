"""pywebview JS-API bridge.

Exposes the organizer_core functions to the HTML/JS front end via
window.pywebview.api.<method_name>(...). Holds per-module UI state
(selected file paths, last preview, pending duplicate selections) for
the lifetime of the window, mirroring the original tkinter app's
per-module state.
"""

from __future__ import annotations

import math
import traceback
from pathlib import Path
from typing import Any

import pandas as pd
import webview

from organizer_core import (
    PROCESS_BY_ID,
    PROCESS_MODULES,
    DuplicateMeasurementsError,
    export_excel,
    organize_process,
    read_source,
)

OPEN_FILE_TYPES = ("Monitor files (*.xlsx;*.xlsm;*.xls;*.csv;*.tsv)", "All files (*.*)")
SAVE_FILE_TYPES = ("Excel workbook (*.xlsx)",)


def to_jsonable(value: Any) -> Any:
    """Recursively convert pandas/numpy values to plain JSON-safe types."""
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        if pd.isna(value):
            return None
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, float):
        return None if math.isnan(value) else value
    try:
        # numpy scalar types (int64, float64, bool_...) expose .item()
        if hasattr(value, "item") and not isinstance(value, str):
            return to_jsonable(value.item())
    except (TypeError, ValueError):
        pass
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


class ModuleState:
    def __init__(self) -> None:
        self.data: pd.DataFrame | None = None
        self.issues: pd.DataFrame | None = None
        self.duplicate_selections: dict[str, int] = {}


class Api:
    def __init__(self) -> None:
        # Leading underscore matters: pywebview builds window.pywebview.api by
        # recursively walking every *public* attribute of this instance to
        # discover exposable methods. Storing the pywebview Window itself as a
        # public attribute makes that walk descend into the Window's internal
        # GUI objects (on Windows, WinForms/.NET types like Rectangle for the
        # window bounds), which then crashes trying to compare those against
        # unrelated objects during the walk — before the API is ever built.
        self._window: webview.Window | None = None
        self.universal_input_path: str = ""
        self.module_input_paths: dict[str, str] = {c[0]: "" for c in PROCESS_MODULES}
        self.output_paths: dict[str, str] = {c[0]: "" for c in PROCESS_MODULES}
        self.states: dict[str, ModuleState] = {c[0]: ModuleState() for c in PROCESS_MODULES}

    def set_window(self, window: webview.Window) -> None:
        self._window = window

    # ------------------------------------------------------------------
    # Module listing
    # ------------------------------------------------------------------
    def list_modules(self) -> list[dict[str, Any]]:
        return [
            {
                "step_id": step_id,
                "name": name,
                "work_centers": work_centers or "",
                "implemented": implemented,
            }
            for step_id, name, work_centers, implemented in PROCESS_MODULES
        ]

    def get_context(self, step_id: str) -> dict[str, Any]:
        state = self.states[step_id]
        return {
            "universal_input": self.universal_input_path,
            "module_input": self.module_input_paths.get(step_id, ""),
            "output_path": self.output_paths.get(step_id, ""),
            "has_preview": state.data is not None,
        }

    # ------------------------------------------------------------------
    # File dialogs
    # ------------------------------------------------------------------
    def pick_input_file(self, scope: str) -> dict[str, Any]:
        """scope is either 'universal' or a process step_id."""
        result = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=OPEN_FILE_TYPES)
        path = self._first_path(result)
        if not path:
            return {"path": None}
        if scope == "universal":
            self.universal_input_path = path
        else:
            self.module_input_paths[scope] = path
            self.states[scope] = ModuleState()
        return {"path": path, "suggested_output": self._suggest_output(scope if scope != "universal" else None, path)}

    def clear_input(self, scope: str) -> dict[str, Any]:
        if scope == "universal":
            self.universal_input_path = ""
        else:
            self.module_input_paths[scope] = ""
            self.states[scope] = ModuleState()
        return {"ok": True}

    def pick_output_file(self, step_id: str, default_name: str = "") -> dict[str, Any]:
        result = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_name or "organized.xlsx",
            file_types=SAVE_FILE_TYPES,
        )
        path = self._first_path(result)
        if not path:
            return {"path": None}
        if not path.lower().endswith(".xlsx"):
            path += ".xlsx"
        self.output_paths[step_id] = path
        return {"path": path}

    @staticmethod
    def _first_path(result: Any) -> str | None:
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return str(result)

    def _suggest_output(self, step_id: str | None, chosen_path: str) -> str:
        active = step_id or next(iter(self.states))
        config = PROCESS_BY_ID[active]
        import re as _re
        safe_name = _re.sub(r"[^A-Za-z0-9]+", "_", config.name).strip("_")
        p = Path(chosen_path)
        return str(p.with_name(p.stem + f"_{safe_name}_Organized.xlsx"))

    def suggest_output_for_module(self, step_id: str) -> dict[str, Any]:
        source = self._selected_input(step_id)
        if source is None:
            return {"path": None}
        config = PROCESS_BY_ID[step_id]
        import re as _re
        safe_name = _re.sub(r"[^A-Za-z0-9]+", "_", config.name).strip("_")
        return {"path": str(source.with_name(source.stem + f"_{safe_name}_Organized.xlsx"))}

    # ------------------------------------------------------------------
    # Preview / organize
    # ------------------------------------------------------------------
    def _selected_input(self, step_id: str) -> Path | None:
        station_value = self.module_input_paths.get(step_id, "").strip()
        if station_value:
            return Path(station_value)
        universal_value = self.universal_input_path.strip()
        if universal_value:
            return Path(universal_value)
        return None

    def load_preview(
        self,
        step_id: str,
        node: str,
        day_start: str,
        evening_start: str,
        night_start: str,
    ) -> dict[str, Any]:
        config = PROCESS_BY_ID.get(step_id)
        if config is None:
            return {"ok": False, "error": "unknown_module", "message": "Unknown process module."}
        if not config.implemented:
            return {
                "ok": False,
                "error": "not_implemented",
                "message": (
                    "No Destacking records were found in the supplied Monitor input, "
                    "so no output schema has been invented."
                ),
            }
        source = self._selected_input(step_id)
        if source is None:
            return {
                "ok": False,
                "error": "no_input",
                "message": f"Select either an individual {config.name} input file or the universal all-stations input file.",
            }
        if not source.is_file():
            return {"ok": False, "error": "bad_file", "message": "The selected input is not a valid file."}

        state = self.states[step_id]
        try:
            raw = read_source(source)
            data, issues = organize_process(
                raw, config, node, day_start, evening_start, night_start,
                duplicate_selections=state.duplicate_selections,
            )
        except DuplicateMeasurementsError as exc:
            return {"ok": False, "error": "duplicates", "groups": to_jsonable(exc.groups)}
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI, not swallowed
            return {
                "ok": False,
                "error": "exception",
                "message": str(exc),
                "detail": traceback.format_exc()[-1200:],
            }

        state.data = data
        state.issues = issues
        preview_rows = data.head(300)
        return {
            "ok": True,
            "columns": list(data.columns),
            "rows": to_jsonable(preview_rows.values.tolist()),
            "row_count": int(len(data)),
            "previewed_count": int(len(preview_rows)),
            "issue_count": int(len(issues)),
            "issues": to_jsonable(issues.to_dict("records")) if not issues.empty else [],
        }

    def submit_duplicate_selection(self, step_id: str, selections: dict[str, int]) -> dict[str, Any]:
        state = self.states[step_id]
        state.duplicate_selections.update({k: int(v) for k, v in selections.items()})
        return {"ok": True}

    def cancel_duplicate_selection(self, step_id: str) -> dict[str, Any]:
        # Nothing persisted; the caller simply stops the preview flow.
        return {"ok": True}

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------
    def export(self, step_id: str) -> dict[str, Any]:
        state = self.states[step_id]
        if state.data is None:
            return {"ok": False, "message": "Load and preview the data before exporting."}
        target_text = self.output_paths.get(step_id, "").strip()
        if not target_text:
            return {"ok": False, "message": "Select the output Excel file."}
        target = Path(target_text)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            export_excel(state.data, state.issues if state.issues is not None else pd.DataFrame(), target)
            return {"ok": True, "path": str(target)}
        except PermissionError:
            return {"ok": False, "message": "Close the output workbook in Excel and export again."}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)}
