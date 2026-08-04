"""Process Monitor Data Organizer — core logic.

This module is the unmodified data-processing core originally shipped as
part of ``process_monitor_organizer.py``. It reads a Monitor export,
organizes it per process module, and exports the result to Excel. It has
no UI dependency (no tkinter) so it can be wrapped by any front end,
including the pywebview desktop app in this repository.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time
from pathlib import Path

import pandas as pd


APP_TITLE = "Process Monitor Data Organizer"

BASE_OUTPUT_COLUMNS = [
    "Order number", "Node", "Part number", "Part name", "Measuring report number",
    "Day", "Weekday", "CW", "Month", "Year", "Shift", "Date",
]

MIXING_COLUMNS = BASE_OUTPUT_COLUMNS + [
    "pH-level Acidity/Alkalinity", "RPM setting", "Temperature of mixture",
    "Time mixture has been soaking", "Time spent mixing", "Viscosity in Centipoise",
]


@dataclass(frozen=True)
class ProcessConfig:
    step_id: str
    name: str
    work_centers: tuple[str, ...]
    output_columns: tuple[str, ...]
    measurements: dict[str, tuple[str, ...]]
    implemented: bool = True


def aliases(*values: str) -> tuple[str, ...]:
    return tuple(values)


PROCESS_CONFIGS = [
    ProcessConfig("1.03", "Mixing", ("1.03 MIX",), tuple(MIXING_COLUMNS), {
        "pH-level Acidity/Alkalinity": aliases("pH-level Acidity/Alkalinity"),
        "RPM setting": aliases("RPM setting"),
        "Temperature of mixture": aliases("Temperature of mixture", "Temperature of mixture (<50)"),
        "Time mixture has been soaking": aliases("Time mixture has been soaking"),
        "Time spent mixing": aliases("Time spent mixing"),
        "Viscosity in Centipoise": aliases("Viscosity in Centipoise"),
    }),
    ProcessConfig("1.04", "Coating", ("1.04 ROL",), tuple(BASE_OUTPUT_COLUMNS + [
        "Humidity level (% RH)", "Line speed setting (mm/min)", "Scrape height setting",
        "Temperature Oven 1", "Temperature Oven 2", "Temperature Oven 3", "Temperature Oven 4",
        "Temperature Oven 5", "Temperature Oven 6", "Temperature Oven 7", "Temperature Oven 8", "Thickness",
    ]), {
        "Humidity level (% RH)": aliases("Humidity level (% RH)"),
        "Line speed setting (mm/min)": aliases("Line speed setting", "Line speed setting (mm/min)"),
        "Scrape height setting": aliases("Scraper height setting"),
        **{f"Temperature Oven {i}": aliases(f"Temperature Oven {i}") for i in range(1, 9)},
        "Thickness": aliases("Thickness"),
    }),
    ProcessConfig("1.05", "Cutting to Sheet", ("1.05 CUT",), tuple(BASE_OUTPUT_COLUMNS + ["Thickness"]), {
        "Thickness": aliases("Thickness"),
    }),
    ProcessConfig("1.06", "Pretreatment Oven", ("1.06 PRE",), tuple(BASE_OUTPUT_COLUMNS + [
        "Oven number", "Sheet 1", "Sheet 2", "Sheet 3", "Temperature of oven (1h)",
        "Temperature of oven (4h)", "Time sheets spent in oven",
    ]), {
        "Oven number": aliases("Oven number"),
        "Sheet 1": aliases("Sheet 1"), "Sheet 2": aliases("Sheet 2"), "Sheet 3": aliases("Sheet 3"),
        "Temperature of oven (1h)": aliases("Temperature of oven (1h)"),
        "Temperature of oven (4h)": aliases("Temperature of oven (4h)"),
        "Time sheets spent in oven": aliases("Time sheets spent in oven"),
    }),
    ProcessConfig("1.07", "Stacking", ("1.07 STA",), tuple(BASE_OUTPUT_COLUMNS + [
        "Holder is assembled correctly", "Weight of GO film", "Average Density in g/cm³",
        "Thickness", "Weight of Unqualified Films",
    ]), {
        "Holder is assembled correctly": aliases("Holder is assembled correctly"),
        "Weight of GO film": aliases("Weight of GO film"),
        "Average Density in g/cm³": aliases("Average Density in g/cm³"),
        "Thickness": aliases("Thickness"),
        "Weight of Unqualified Films": aliases("Weight of Unqualified Films"),
    }),
    ProcessConfig("1.08", "Carbonization", ("1.08 CAR", "CAR3", "CAR4"), tuple(BASE_OUTPUT_COLUMNS + [
        "Furnace number (1,2,3...)", "Position in furnace (A,B,C)", "Temperature of furnace",
        "Vacuum amount (<100 Pa)", "Height of nuts", "Amount of diesel used", "Current amount in tank",
    ]), {name: aliases(name) for name in [
        "Furnace number (1,2,3...)", "Position in furnace (A,B,C)", "Temperature of furnace",
        "Vacuum amount (<100 Pa)", "Height of nuts", "Amount of diesel used", "Current amount in tank",
    ]}),
    ProcessConfig("1.09", "Graphitization", ("1.09 GRA", "GRA1", "GRA2"), tuple(BASE_OUTPUT_COLUMNS + [
        "Furnace number (1,2,3...)", "Furnace No.", "Position in furnace (A,B,C)",
        "Temperature of furnace", "Argon pressure", "Height of nuts", "Amount of diesel used",
    ]), {name: aliases(name) for name in [
        "Furnace number (1,2,3...)", "Furnace No.", "Position in furnace (A,B,C)",
        "Temperature of furnace", "Argon pressure", "Height of nuts", "Amount of diesel used",
    ]}),
    ProcessConfig("1.10", "Destacking", (), tuple(), {}, implemented=False),
    ProcessConfig("1.11", "FQC GF Sheets", ("1.11 QCL",), tuple(BASE_OUTPUT_COLUMNS + [
        "Average Density in g/cm³", "Thickness", "Weight of Unqualified Films",
        "Weight of approved film that do not fit any size",
    ]), {name: aliases(name) for name in [
        "Average Density in g/cm³", "Thickness", "Weight of Unqualified Films",
        "Weight of approved film that do not fit any size",
    ]}),
]

PROCESS_BY_ID = {config.step_id: config for config in PROCESS_CONFIGS}
PROCESS_MODULES = [
    (config.step_id, config.name, ", ".join(config.work_centers) or None, config.implemented)
    for config in PROCESS_CONFIGS
]
OUTPUT_COLUMNS = MIXING_COLUMNS

SOURCE_HEADERS = {
    "Serial number/Batch number": ["serial number batch number"],
    "Order number": ["order number"],
    "Measuring report number": ["measuring report number"],
    "Date": ["date"],
    "Value": ["value"],
    "Work center": ["work center", "work centre"],
    # The Monitor export supplied on 2026-08-03 spells this header this way.
    "Row description": ["row descripiton"],
    "Op.": ["op", "operation"],
}

MEASUREMENTS = PROCESS_BY_ID["1.03"].measurements


class DuplicateMeasurementsError(ValueError):
    def __init__(self, groups: list[dict[str, object]]) -> None:
        self.groups = groups
        first = groups[0]
        super().__init__(
            f"Duplicate measurement found for report {first['report']}: "
            f"{first['measurement']}. Select the correct source row."
        )


def normalize(value: object) -> str:
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value).casefold())).strip()


def header_mapping(row: pd.Series) -> dict[str, int]:
    result: dict[str, int] = {}
    for pos, cell in enumerate(row.tolist()):
        text = normalize(cell)
        for canonical, accepted in SOURCE_HEADERS.items():
            if text in accepted and canonical not in result:
                result[canonical] = pos
    return result


def find_monitor_table(raw: pd.DataFrame) -> tuple[int, dict[str, int]]:
    required = {"Serial number/Batch number", "Order number", "Measuring report number", "Date", "Value", "Work center", "Row description", "Op."}
    for row_index, row in raw.head(200).iterrows():
        mapping = header_mapping(row)
        if required.issubset(mapping):
            return int(row_index), mapping
    raise ValueError(
        "The Monitor table header was not found. Expected one row containing: "
        "Serial number/Batch number, Order number, Measuring report number, Date, Value, "
        "Work center, Row description and Op."
    )


def value_below_label(raw: pd.DataFrame, label: str, header_row: int) -> object:
    wanted = normalize(label)
    for r in range(header_row):
        for c in range(raw.shape[1]):
            if normalize(raw.iat[r, c]) == wanted:
                for rr in range(r + 1, min(header_row, r + 4)):
                    value = raw.iat[rr, c]
                    if not pd.isna(value) and str(value).strip():
                        return value
    return ""


def read_source(path: Path) -> pd.DataFrame:
    if path.suffix.casefold() not in {".xlsx", ".xlsm", ".xls", ".csv", ".tsv"}:
        raise ValueError("Select an Excel, CSV or TSV Monitor export.")

    candidates: list[tuple[str, pd.DataFrame]] = []
    if path.suffix.casefold() in {".xlsx", ".xlsm", ".xls"}:
        book = pd.ExcelFile(path)
        for sheet in book.sheet_names:
            candidates.append((sheet, pd.read_excel(book, sheet_name=sheet, header=None, dtype=object)))
    else:
        sep = "\t" if path.suffix.casefold() == ".tsv" else None
        try:
            frame = pd.read_csv(path, sep=sep, engine="python", header=None, dtype=object)
        except UnicodeDecodeError:
            frame = pd.read_csv(path, sep=sep, engine="python", header=None, dtype=object, encoding="latin-1")
        candidates.append((path.name, frame))

    failures: list[str] = []
    for sheet_name, raw in candidates:
        blocks: list[pd.DataFrame] = []
        current_part_number: object = ""
        current_part_name: object = ""
        row_no = 0
        while row_no < len(raw):
            row = raw.iloc[row_no]
            if any(normalize(v) == "part number" for v in row.tolist()):
                current_part_number = value_below_label(raw.iloc[row_no:], "Part number", min(4, len(raw)-row_no))
                current_part_name = value_below_label(raw.iloc[row_no:], "Part name", min(4, len(raw)-row_no))
            mapping = header_mapping(row)
            required = set(SOURCE_HEADERS)
            if not required.issubset(mapping):
                row_no += 1
                continue
            start = row_no + 1
            end = start
            while end < len(raw):
                first = normalize(raw.iat[end, mapping["Serial number/Batch number"]])
                if first in {"part number", "serial number batch number", "list"}:
                    break
                # Data rows have all four identifiers populated.
                identifiers = [raw.iat[end, mapping[k]] for k in (
                    "Serial number/Batch number", "Order number", "Measuring report number", "Date"
                )]
                if all(pd.isna(v) or str(v).strip() == "" for v in identifiers):
                    break
                end += 1
            data = raw.iloc[start:end, list(mapping.values())].copy()
            data.columns = list(mapping.keys())
            data = data.dropna(how="all")
            data["Part number"] = current_part_number
            data["Part name"] = current_part_name
            data["Source sheet"] = sheet_name
            blocks.append(data)
            row_no = max(end, row_no + 1)
        if blocks:
            return pd.concat(blocks, ignore_index=True)
        failures.append(f"{sheet_name}: the exact Monitor table header was not found")
    raise ValueError("No worksheet has the exact Monitor table layout.\n\n" + "\n".join(failures))


def measurement_name(value: object, config: ProcessConfig) -> str | None:
    source = normalize(value)
    for output, accepted in config.measurements.items():
        if source in {normalize(item) for item in accepted}:
            return output
    return None


def first_nonblank(values: pd.Series) -> object:
    for value in values:
        if not pd.isna(value) and str(value).strip():
            return value
    return ""


def monitor_value(value: object) -> object:
    if pd.isna(value) or str(value).strip() == "":
        return ""
    text = str(value).strip().replace(",", "")
    try:
        number = float(text)
        return int(number) if number.is_integer() else number
    except ValueError:
        return str(value).strip()


def identifier_number(value: object, field_name: str) -> int | float:
    if pd.isna(value) or str(value).strip() == "":
        raise ValueError(f"{field_name} is blank and cannot be exported as a number.")
    text = str(value).strip().replace(",", "")
    try:
        number = float(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} is not numeric: {value}") from exc
    if not pd.notna(number) or number in (float("inf"), float("-inf")):
        raise ValueError(f"{field_name} is not a finite number: {value}")
    return int(number) if number.is_integer() else number


def order_number(value: object) -> int | float:
    """Convert Monitor order IDs such as RD10791 to numeric Excel values."""
    if pd.isna(value) or str(value).strip() == "":
        raise ValueError("Order number is blank and cannot be exported as a number.")
    text = str(value).strip().replace(",", "")
    match = re.fullmatch(r"[A-Za-z]+(\d+(?:\.\d+)?)", text)
    if match:
        text = match.group(1)
    return identifier_number(text, "Order number")


def parse_clock(text: str, label: str) -> time:
    try:
        return datetime.strptime(text.strip(), "%H:%M").time()
    except ValueError as exc:
        raise ValueError(f"Enter {label} in 24-hour HH:MM format.") from exc


def shift_from_datetime(value: pd.Timestamp, day_start: time, evening_start: time, night_start: time) -> str:
    clock = value.time()
    if not (day_start < evening_start < night_start):
        raise ValueError("Shift starts must be in order: DAY, then EVENING, then NIGHT.")
    if day_start <= clock < evening_start:
        return "DAY"
    if evening_start <= clock < night_start:
        return "EVENING"
    return "NIGHT"


def organize_process(
    raw: pd.DataFrame,
    config: ProcessConfig,
    node: str,
    day_start_text: str,
    evening_start_text: str,
    night_start_text: str,
    duplicate_selections: dict[str, int] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if not node.strip():
        raise ValueError("Enter the Node value. It is not present in the Monitor export.")
    day_start = parse_clock(day_start_text, "DAY start")
    evening_start = parse_clock(evening_start_text, "EVENING start")
    night_start = parse_clock(night_start_text, "NIGHT start")
    accepted_work_centers = {normalize(item) for item in config.work_centers}
    work = raw[raw["Work center"].map(normalize).isin(accepted_work_centers)].copy()
    if work.empty:
        centers = ", ".join(config.work_centers)
        raise ValueError(f"No records for {config.name} work center(s) {centers} were found in the selected Monitor file.")
    work["Part number"] = work["Part number"].map(lambda v: str(v).strip())
    work["Part name"] = work["Part name"].map(lambda v: str(v).strip())
    work["_SourceOrder"] = range(len(work))
    work["_Measurement"] = work["Row description"].map(lambda value: measurement_name(value, config))
    recognized = work[work["_Measurement"].notna()].copy()
    recognized["Value"] = recognized["Value"].map(monitor_value)
    if recognized.empty:
        present = work["Row description"].dropna().astype(str).drop_duplicates().tolist()
        raise ValueError(f"None of the defined {config.name} measurements were found.\n\nFound:\n" + "\n".join(present[:30]))

    keys = ["Part number", "Part name", "Serial number/Batch number", "Order number", "Measuring report number", "Date", "Work center"]
    duplicate_counts = recognized.groupby(keys + ["_Measurement"], dropna=False).size().reset_index(name="Count")
    duplicates = duplicate_counts[duplicate_counts["Count"] > 1]
    if not duplicates.empty:
        duplicate_selections = duplicate_selections or {}
        unresolved: list[dict[str, object]] = []
        rows_to_remove: set[int] = set()
        for _, duplicate in duplicates.iterrows():
            mask = pd.Series(True, index=recognized.index)
            for key in keys + ["_Measurement"]:
                wanted = duplicate[key]
                mask &= recognized[key].isna() if pd.isna(wanted) else recognized[key].eq(wanted)
            choices = recognized.loc[mask].sort_values("_SourceOrder", kind="stable")
            selection_key = "|".join(normalize(duplicate[key]) for key in keys + ["_Measurement"])
            selected_index = duplicate_selections.get(selection_key)
            if selected_index not in choices.index:
                unresolved.append({
                    "key": selection_key,
                    "report": duplicate["Measuring report number"],
                    "measurement": duplicate["_Measurement"],
                    "choices": [
                        {
                            "index": int(index),
                            "source_row": int(row["_SourceOrder"]) + 1,
                            "value": row["Value"],
                            "date": row["Date"],
                            "batch": row["Serial number/Batch number"],
                        }
                        for index, row in choices.iterrows()
                    ],
                })
            else:
                rows_to_remove.update(int(index) for index in choices.index if int(index) != selected_index)
        if unresolved:
            raise DuplicateMeasurementsError(unresolved)
        recognized = recognized.drop(index=list(rows_to_remove))
    group_order = recognized.groupby(keys, sort=False, dropna=False)["_SourceOrder"].min().reset_index()
    wide = recognized.pivot(index=keys, columns="_Measurement", values="Value").reset_index()
    wide = wide.merge(group_order, on=keys, how="left").sort_values("_SourceOrder", kind="stable").drop(columns="_SourceOrder").reset_index(drop=True)
    wide.columns.name = None

    parsed = pd.to_datetime(wide["Date"], errors="coerce", dayfirst=False)
    if parsed.isna().any():
        bad = wide.loc[parsed.isna(), "Date"].astype(str).drop_duplicates().tolist()
        raise ValueError("These Monitor dates could not be read: " + ", ".join(bad[:10]))

    output = pd.DataFrame()
    output["Order number"] = wide["Order number"].map(order_number)
    output["Node"] = identifier_number(node, "Node")
    output["Part number"] = wide["Part number"].map(lambda v: identifier_number(v, "Part number"))
    output["Part name"] = wide["Part name"]
    output["Measuring report number"] = wide["Measuring report number"].map(
        lambda v: identifier_number(v, "Measuring report number")
    )
    output["Day"] = parsed.dt.day
    output["Weekday"] = parsed.dt.day_name()
    output["CW"] = parsed.dt.isocalendar().week.astype(int)
    output["Month"] = parsed.dt.month
    output["Year"] = parsed.dt.year
    output["Shift"] = parsed.map(lambda value: shift_from_datetime(value, day_start, evening_start, night_start))
    output["Date"] = parsed
    for name in config.measurements:
        output[name] = wide[name] if name in wide.columns else ""
    output = output[list(config.output_columns)]

    issues: list[dict[str, object]] = []
    for desc in work.loc[work["_Measurement"].isna(), "Row description"].dropna().astype(str).drop_duplicates():
        issues.append({"Issue": "Unrecognized row description", "Details": desc})
    for _, row in output.iterrows():
        missing = [name for name in config.measurements if pd.isna(row[name]) or str(row[name]).strip() == ""]
        if missing:
            issues.append({"Issue": "Missing measurement", "Details": ", ".join(missing), "Measuring report number": row["Measuring report number"]})
    return output, pd.DataFrame(issues)


def organize(
    raw: pd.DataFrame,
    node: str,
    day_start_text: str,
    evening_start_text: str,
    night_start_text: str,
    duplicate_selections: dict[str, int] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Backward-compatible Mixing entry point used by the original tests."""
    return organize_process(
        raw, PROCESS_BY_ID["1.03"], node, day_start_text, evening_start_text,
        night_start_text, duplicate_selections=duplicate_selections,
    )


def export_excel(data: pd.DataFrame, issues: pd.DataFrame, output_path: Path) -> None:
    from openpyxl.styles import Alignment, Font, PatternFill
    with pd.ExcelWriter(output_path, engine="openpyxl", datetime_format="dd-mm-yy hh:mm") as writer:
        data.to_excel(writer, sheet_name="Sheet1", index=False)
        if not issues.empty:
            issues.to_excel(writer, sheet_name="Validation_Issues", index=False)
        ws = writer.book["Sheet1"]
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        ws.sheet_view.showGridLines = False
        for cell in ws[1]:
            cell.font = Font(name="Aptos Narrow", size=11, bold=True)
            cell.fill = PatternFill("solid", fgColor="D9EAD3")
            cell.alignment = Alignment(textRotation=90, vertical="bottom", horizontal="center", wrap_text=True)
        ws.row_dimensions[1].height = 145
        widths = []
        for column in data.columns:
            if column == "Part name":
                widths.append(28)
            elif column == "Date":
                widths.append(18)
            else:
                widths.append(max(8, min(22, len(column) + 2)))
        for i, width in enumerate(widths, 1):
            ws.column_dimensions[ws.cell(1, i).column_letter].width = width
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.font = Font(name="Aptos Narrow", size=11)
        for cell in ws["L"][1:]:
            cell.number_format = "dd-mm-yy hh:mm"
        if not issues.empty:
            issue_ws = writer.book["Validation_Issues"]
            issue_ws.freeze_panes = "A2"
            issue_ws.auto_filter.ref = issue_ws.dimensions
            for cell in issue_ws[1]:
                cell.font = Font(name="Aptos Narrow", size=11, bold=True)
                cell.fill = PatternFill("solid", fgColor="FCE5CD")
            for column_cells in issue_ws.columns:
                length = max(len(str(cell.value or "")) for cell in column_cells)
                issue_ws.column_dimensions[column_cells[0].column_letter].width = min(60, max(12, length + 2))
