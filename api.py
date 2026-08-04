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
    PROCESS_CONFIGS,
    PROCESS_MODULES,
    DuplicateMeasurementsError,
    export_excel,
    normalize,
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


def cluster_duplicate_groups(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cluster per-measurement duplicate groups (from DuplicateMeasurementsError,
    already run through to_jsonable) by the record they belong to, so the UI can
    offer one interactive choice per duplicated record instead of one dropdown
    per affected measurement field.

    A record's measurements are "uniform" when every one of them has the same
    number of candidate source rows — i.e. the whole record was entered as a
    duplicated block, not just one field typoed into two entries. Sorting each
    measurement's choices by source row and pairing by position turns that into
    a small set of whole-record candidates: candidate 0 is "the first time this
    record was entered", candidate 1 is "the second time", etc., each carrying
    every measurement's value for that entry plus the selection map needed to
    resolve every one of them at once.

    Non-uniform records (only some fields were individually duplicated) fall
    back to the original per-field choices, unchanged.
    """
    buckets: dict[tuple[Any, Any, Any], list[dict[str, Any]]] = {}
    order: list[tuple[Any, Any, Any]] = []
    for group in groups:
        first_choice = group["choices"][0]
        record_id = (group["report"], first_choice["date"], first_choice["batch"])
        if record_id not in buckets:
            buckets[record_id] = []
            order.append(record_id)
        buckets[record_id].append(group)

    clusters: list[dict[str, Any]] = []
    for record_id in order:
        report, date, batch = record_id
        member_groups = buckets[record_id]
        for group in member_groups:
            group["choices"] = sorted(group["choices"], key=lambda c: c["source_row"])
        candidate_counts = {len(group["choices"]) for group in member_groups}

        if len(candidate_counts) == 1:
            n = next(iter(candidate_counts))
            candidates = []
            for i in range(n):
                candidates.append({
                    "candidate_index": i,
                    "source_row": member_groups[0]["choices"][i]["source_row"],
                    "values": {group["measurement"]: group["choices"][i]["value"] for group in member_groups},
                    "selections": {group["key"]: group["choices"][i]["index"] for group in member_groups},
                })
            clusters.append({
                "mode": "record",
                "report": report,
                "date": date,
                "batch": batch,
                "measurements": [group["measurement"] for group in member_groups],
                "candidates": candidates,
            })
        else:
            clusters.append({
                "mode": "fields",
                "report": report,
                "date": date,
                "batch": batch,
                "groups": member_groups,
            })
    return clusters


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
        # Cache of parsed Monitor files, keyed by path with an (mtime, size)
        # fingerprint so an edited file on disk is re-read automatically.
        # Lets scan_status() and load_preview() share one parse per file
        # instead of re-reading the same workbook for every module.
        self._raw_cache: dict[str, tuple[tuple[int, int], pd.DataFrame]] = {}
        # Directory of the most recently picked file (input or output), so
        # the next file dialog opens there instead of always starting fresh.
        self._last_directory: str = ""

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
        output_path = self.output_paths.get(step_id, "")
        if not output_path:
            # No output chosen yet for this module. If an input is already
            # available (module-specific or universal), show a live
            # suggestion so switching to a module doesn't leave the output
            # box blank when there's actually something to organize.
            source = self._selected_input(step_id)
            if source is not None:
                output_path = self._suggest_output(step_id, str(source))
        return {
            "universal_input": self.universal_input_path,
            "module_input": self.module_input_paths.get(step_id, ""),
            "output_path": output_path,
            "has_preview": state.data is not None,
        }

    # ------------------------------------------------------------------
    # File dialogs
    # ------------------------------------------------------------------
    # Deliberately webview.OPEN_DIALOG / webview.SAVE_DIALOG, not the newer
    # webview.FileDialog.OPEN / .SAVE: the newer enum only exists starting in
    # pywebview 6.x, but requirements.txt pins pywebview<6.0. Using it crashed
    # with AttributeError on an actual pinned-version (5.4) install. The old
    # constants raise a harmless deprecation warning on 6.x but work on both.
    def pick_input_file(self, scope: str, active_step_id: str) -> dict[str, Any]:
        """scope is either 'universal' or a process step_id; active_step_id is
        whichever module panel is currently showing in the UI, used to name
        the suggested output file correctly even when scope is 'universal'."""
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG, directory=self._last_directory, file_types=OPEN_FILE_TYPES
        )
        path = self._first_path(result)
        if not path:
            return {"path": None}
        self._last_directory = str(Path(path).parent)
        if scope == "universal":
            self.universal_input_path = path
        else:
            self.module_input_paths[scope] = path
            self.states[scope] = ModuleState()
        # Persist the suggestion immediately, not just display it: otherwise
        # the output box can show a filename that Export never actually sees,
        # since only pick_output_file() used to write to self.output_paths.
        suggested = self._suggest_output(active_step_id, path)
        self.output_paths[active_step_id] = suggested
        return {"path": path, "suggested_output": suggested}

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
            directory=self._last_directory,
            save_filename=default_name or "organized.xlsx",
            file_types=SAVE_FILE_TYPES,
        )
        path = self._first_path(result)
        if not path:
            return {"path": None}
        if not path.lower().endswith(".xlsx"):
            path += ".xlsx"
        self._last_directory = str(Path(path).parent)
        self.output_paths[step_id] = path
        return {"path": path}

    def check_output_exists(self, step_id: str) -> dict[str, Any]:
        """Whether the module's currently chosen output path already exists on
        disk, so the UI can confirm before Export silently overwrites it."""
        target_text = self.output_paths.get(step_id, "").strip()
        if not target_text:
            return {"exists": False, "path": ""}
        return {"exists": Path(target_text).is_file(), "path": target_text}

    @staticmethod
    def _first_path(result: Any) -> str | None:
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return str(result)

    def _suggest_output(self, step_id: str, chosen_path: str) -> str:
        config = PROCESS_BY_ID[step_id]
        import re as _re
        safe_name = _re.sub(r"[^A-Za-z0-9]+", "_", config.name).strip("_")
        p = Path(chosen_path)
        return str(p.with_name(p.stem + f"_{safe_name}_Organized.xlsx"))

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

    def _read_source_cached(self, path: Path) -> pd.DataFrame:
        stat = path.stat()
        fingerprint = (stat.st_mtime_ns, stat.st_size)
        key = str(path)
        cached = self._raw_cache.get(key)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]
        raw = read_source(path)
        self._raw_cache[key] = (fingerprint, raw)
        return raw

    def scan_module_status(self, step_id: str) -> dict[str, Any]:
        """Data-availability status for one module, for whichever input is
        currently effective for it (its own individual input if set,
        otherwise the universal input) — a fast scan of row counts, not a
        full organize pass. Callable per-module so the UI can show
        incremental progress across the sidebar instead of everything
        updating at once; the underlying parsed file is cached, so scanning
        every module this way still only reads the file from disk once."""
        config = PROCESS_BY_ID.get(step_id)
        if config is None:
            return {"status": "error", "row_count": None, "message": "Unknown process module."}
        if not config.implemented:
            return {"status": "not_implemented", "row_count": None, "message": "Output format not defined"}
        source = self._selected_input(step_id)
        if source is None:
            return {"status": "no_input", "row_count": None, "message": "No input selected"}
        if not source.is_file():
            return {"status": "error", "row_count": None, "message": "Selected input is not a valid file"}
        try:
            raw = self._read_source_cached(source)
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI, not swallowed
            return {"status": "error", "row_count": None, "message": str(exc)}
        accepted = {normalize(item) for item in config.work_centers}
        count = int(raw["Work center"].map(normalize).isin(accepted).sum())
        if count == 0:
            return {"status": "empty", "row_count": 0, "message": "No matching rows found in the selected input"}
        return {"status": "ready", "row_count": count, "message": f"{count} row(s) found for this station"}

    def scan_status(self) -> dict[str, Any]:
        """All modules' scan_module_status() in one batch call. Used
        internally (export_all_ready) and kept for any caller that wants the
        full picture at once rather than incremental per-module progress."""
        return {config.step_id: self.scan_module_status(config.step_id) for config in PROCESS_CONFIGS}

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
            raw = self._read_source_cached(source)
            data, issues = organize_process(
                raw, config, node, day_start, evening_start, night_start,
                duplicate_selections=state.duplicate_selections,
            )
        except DuplicateMeasurementsError as exc:
            clusters = cluster_duplicate_groups(to_jsonable(exc.groups))
            return {"ok": False, "error": "duplicates", "clusters": clusters}
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
            "has_duplicate_selections": bool(state.duplicate_selections),
        }

    def submit_duplicate_selection(self, step_id: str, selections: dict[str, int]) -> dict[str, Any]:
        state = self.states[step_id]
        state.duplicate_selections.update({k: int(v) for k, v in selections.items()})
        return {"ok": True}

    def cancel_duplicate_selection(self, step_id: str) -> dict[str, Any]:
        # Nothing persisted; the caller simply stops the preview flow.
        return {"ok": True}

    def clear_duplicate_selections(self, step_id: str) -> dict[str, Any]:
        """Forget this module's previously resolved duplicate choices, so the
        next Load and preview re-raises them for the user to pick again."""
        self.states[step_id].duplicate_selections = {}
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

    def export_all_ready(
        self, node: str, day_start: str, evening_start: str, night_start: str
    ) -> dict[str, Any]:
        """Load, preview and export every module scan_status() currently shows
        as 'ready' (has matching data), in one action. Never resolves
        duplicate measurements on its own — a module that needs manual
        duplicate resolution is skipped and reported, not guessed at. If a
        ready module has no output path chosen yet, one is generated the same
        way the UI suggests one, so this works without having to click into
        every module first."""
        status = self.scan_status()
        results: list[dict[str, Any]] = []
        for config in PROCESS_CONFIGS:
            step_id = config.step_id
            info = status.get(step_id)
            if not info or info.get("status") != "ready":
                continue

            preview = self.load_preview(step_id, node, day_start, evening_start, night_start)
            if not preview["ok"]:
                if preview.get("error") == "duplicates":
                    message = "Has duplicate measurements that need manual resolution — open this module to resolve them."
                else:
                    message = preview.get("message", "Could not organize this module.")
                results.append({"step_id": step_id, "name": config.name, "ok": False, "message": message})
                continue

            if not self.output_paths.get(step_id, "").strip():
                source = self._selected_input(step_id)
                if source is not None:
                    self.output_paths[step_id] = self._suggest_output(step_id, str(source))

            export_result = self.export(step_id)
            if export_result["ok"]:
                results.append({"step_id": step_id, "name": config.name, "ok": True, "path": export_result["path"]})
            else:
                results.append({
                    "step_id": step_id, "name": config.name, "ok": False,
                    "message": export_result.get("message", "Export failed."),
                })
        return {"results": results}
