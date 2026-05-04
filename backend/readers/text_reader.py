"""Generic text / CSV / TSV / ATF reader.

Loads a single recording from a delimited text file. The file lays
out one or more columns: an optional time column followed by one or
more channel columns. Each non-time column becomes one Trace in a
single Sweep of a single Series.

Two parse modes:

* **Delimited** — generic CSV / TSV / whitespace. Auto-detects the
  delimiter from the first non-comment line. Comment lines start
  with ``#``, ``%`` or ``//``. An optional header row provides
  per-column names; embedded units like ``"Im (pA)"`` or
  ``"Time, s"`` are parsed out and used as the channel's units.

* **ATF** — Axon Text File. Standard header is two integers on the
  second line giving (n_optional_header_lines, n_columns); the
  column titles line follows with names like ``"Im (pA)"``.

Options accepted via ``read(file_path, options=...)``:

    sample_rate_hz : float
        Required when the file has no time column.
    time_column : "auto" | "none" | int
        Default ``"auto"``. ``"none"`` forces all columns to be
        treated as channels. An integer index forces that column
        to be used as time.
    delimiter : "auto" | "," | "\\t" | "space"
        Default ``"auto"``.
    units_per_channel : list[str] | None
        Override units extracted from the header. One entry per
        channel column (excluding the time column). Empty strings
        are ignored.
    sweep_mode : "single"
        Reserved — only ``"single"`` is implemented in v1.
"""

from __future__ import annotations

import csv
import os
import re
from typing import Any, Optional

import numpy as np

from .base import BaseReader
from .models import Group, Recording, Series, Sweep, Trace


_TEXT_EXTS = {".csv", ".tsv", ".txt", ".atf"}
_NUMERIC_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_UNIT_IN_LABEL_RE = re.compile(r"\s*[\(\[]\s*([^\)\]]+?)\s*[\)\]]\s*$")


class TextReader(BaseReader):
    @staticmethod
    def can_read(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in _TEXT_EXTS:
            return False
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(4096)
        except OSError:
            return False
        if not head.strip():
            return False
        # ATF files start with the magic ``ATF`` token on line 1.
        if head.lstrip().startswith("ATF"):
            return True
        # Otherwise look for at least one numeric data line.
        for line in head.splitlines():
            s = line.strip()
            if not s or s.startswith(("#", "%", "//")):
                continue
            tokens = _split_auto(s)
            if not tokens:
                continue
            numeric = sum(1 for t in tokens if _is_number(t))
            if numeric >= max(1, len(tokens) - 1):
                return True
            # First non-comment line might be a header — keep scanning.
        return False

    def read(self, file_path: str, **options: Any) -> Recording:
        ext = os.path.splitext(file_path)[1].lower()
        opts = options.get("options") or {}
        if ext == ".atf":
            return _read_atf(file_path, opts)
        return _read_delimited(file_path, opts)


# ---------------------------------------------------------------------------
# Generic delimited
# ---------------------------------------------------------------------------

def _read_delimited(file_path: str, options: dict[str, Any]) -> Recording:
    delimiter_opt = options.get("delimiter", "auto")
    time_column_opt = options.get("time_column", "auto")
    sample_rate_opt = options.get("sample_rate_hz")
    units_override = options.get("units_per_channel") or []

    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        raw_lines = f.readlines()

    # Strip comment + blank lines.
    body: list[str] = []
    for line in raw_lines:
        s = line.rstrip("\n\r")
        if not s.strip() or s.lstrip().startswith(("#", "%", "//")):
            continue
        body.append(s)
    if not body:
        raise ValueError("Text file has no data lines")

    delim = _resolve_delimiter(delimiter_opt, body[0])

    # Detect header row: first line whose tokens are mostly non-numeric.
    header: Optional[list[str]] = None
    if not _line_is_numeric(body[0], delim):
        header = _split_with_delim(body[0], delim)
        body = body[1:]
    if not body:
        raise ValueError("Text file has a header but no numeric rows")

    # Parse the data block.
    rows = []
    n_cols = 0
    for s in body:
        toks = _split_with_delim(s, delim)
        if not toks:
            continue
        if n_cols == 0:
            n_cols = len(toks)
        if len(toks) != n_cols:
            raise ValueError(
                f"Inconsistent column count (expected {n_cols}, got {len(toks)} on line: {s[:80]!r})"
            )
        rows.append([_to_float(t) for t in toks])
    if not rows:
        raise ValueError("Text file has no numeric rows")
    data = np.asarray(rows, dtype=float)  # (n_samples, n_cols)

    # Decide which column (if any) is time.
    time_col = _resolve_time_column(time_column_opt, data, header)

    if time_col is not None:
        time_arr = data[:, time_col]
        sr = _infer_sampling_rate(time_arr)
        channel_cols = [c for c in range(n_cols) if c != time_col]
    else:
        if not sample_rate_opt or float(sample_rate_opt) <= 0:
            raise ValueError(
                "Text file has no time column — pass sample_rate_hz in the import options"
            )
        sr = float(sample_rate_opt)
        channel_cols = list(range(n_cols))

    # Channel labels + units.
    labels: list[str] = []
    units: list[str] = []
    for i, col in enumerate(channel_cols):
        ovr = units_override[i] if i < len(units_override) and units_override[i] else None
        if header and col < len(header):
            label, unit_in_label = _split_label_units(header[col])
        else:
            label, unit_in_label = (f"Ch {i + 1}", "")
        labels.append(label)
        units.append(ovr or unit_in_label or "")

    sweep = Sweep(index=0, label="Sweep 1")
    for i, col in enumerate(channel_cols):
        col_data = data[:, col].astype(np.float32, copy=False)
        sweep.traces.append(Trace(
            data=col_data,
            sampling_rate=sr,
            units=units[i],
            label=labels[i],
        ))

    series = Series(index=0, label="Series 1", sweeps=[sweep])
    group = Group(index=0, label="Group 1", series_list=[series])
    return Recording(
        file_path=file_path,
        file_name=os.path.basename(file_path),
        format="TEXT",
        groups=[group],
    )


# ---------------------------------------------------------------------------
# ATF
# ---------------------------------------------------------------------------

def _read_atf(file_path: str, options: dict[str, Any]) -> Recording:
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        lines = [ln.rstrip("\n\r") for ln in f.readlines()]
    if not lines or not lines[0].lstrip().startswith("ATF"):
        raise ValueError("Not an ATF file")
    # Line 2: "<n_header_lines>\t<n_columns>" (after the magic + version).
    try:
        n_header_lines, _n_columns = (int(x) for x in re.split(r"\s+", lines[1].strip())[:2])
    except Exception as exc:
        raise ValueError(f"Malformed ATF header: {lines[1]!r}") from exc
    # Skip the optional header records, then the next line is the column-titles row.
    title_idx = 2 + n_header_lines
    if title_idx >= len(lines):
        raise ValueError("ATF file truncated before column titles")
    title_line = lines[title_idx].strip().strip('"')
    delim = "\t" if "\t" in title_line else _resolve_delimiter("auto", title_line)
    headers = [h.strip().strip('"') for h in _split_with_delim(title_line, delim)]

    body = []
    for s in lines[title_idx + 1:]:
        if not s.strip():
            continue
        toks = _split_with_delim(s, delim)
        body.append([_to_float(t) for t in toks])
    if not body:
        raise ValueError("ATF file has no data rows")

    # Reuse the delimited path with pre-parsed header + body.
    return _build_recording_from_arrays(
        file_path=file_path,
        header=headers,
        data=np.asarray(body, dtype=float),
        options=options,
        format_label="ATF",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_recording_from_arrays(
    *, file_path: str, header: list[str], data: np.ndarray,
    options: dict[str, Any], format_label: str,
) -> Recording:
    n_cols = data.shape[1]
    time_col = _resolve_time_column(options.get("time_column", "auto"), data, header)
    if time_col is not None:
        sr = _infer_sampling_rate(data[:, time_col])
        channel_cols = [c for c in range(n_cols) if c != time_col]
    else:
        sr_opt = options.get("sample_rate_hz")
        if not sr_opt or float(sr_opt) <= 0:
            raise ValueError("No time column — pass sample_rate_hz in import options")
        sr = float(sr_opt)
        channel_cols = list(range(n_cols))

    units_override = options.get("units_per_channel") or []
    sweep = Sweep(index=0, label="Sweep 1")
    for i, col in enumerate(channel_cols):
        if header and col < len(header):
            label, unit_in_label = _split_label_units(header[col])
        else:
            label, unit_in_label = (f"Ch {i + 1}", "")
        ovr = units_override[i] if i < len(units_override) and units_override[i] else None
        sweep.traces.append(Trace(
            data=data[:, col].astype(np.float32, copy=False),
            sampling_rate=sr,
            units=ovr or unit_in_label or "",
            label=label,
        ))
    series = Series(index=0, label="Series 1", sweeps=[sweep])
    group = Group(index=0, label="Group 1", series_list=[series])
    return Recording(
        file_path=file_path,
        file_name=os.path.basename(file_path),
        format=format_label,
        groups=[group],
    )


def _resolve_delimiter(opt: str, sample_line: str) -> str:
    if opt == ",":
        return ","
    if opt == "\t":
        return "\t"
    if opt == "space":
        return " "
    # Auto: pick the highest-frequency separator on the line. Tabs win
    # ties because TSV is more common in scientific data than CSV.
    counts = {"\t": sample_line.count("\t"), ",": sample_line.count(",")}
    if counts["\t"] >= counts[","] and counts["\t"] > 0:
        return "\t"
    if counts[","] > 0:
        return ","
    return " "


def _split_with_delim(line: str, delim: str) -> list[str]:
    if delim == " ":
        return [t for t in re.split(r"\s+", line.strip()) if t]
    if delim == ",":
        # Use csv to handle quoted cells.
        return [c.strip() for c in next(csv.reader([line], delimiter=","), [])]
    return [c.strip() for c in line.split(delim)]


def _split_auto(line: str) -> list[str]:
    return _split_with_delim(line, _resolve_delimiter("auto", line))


def _is_number(s: str) -> bool:
    return bool(_NUMERIC_RE.match(s.strip()))


def _to_float(s: str) -> float:
    s = s.strip().strip('"')
    if not s or not _is_number(s):
        return float("nan")
    return float(s)


def _line_is_numeric(line: str, delim: str) -> bool:
    toks = _split_with_delim(line, delim)
    if not toks:
        return False
    numeric = sum(1 for t in toks if _is_number(t))
    return numeric >= max(1, len(toks) - 0)


def _resolve_time_column(opt: Any, data: np.ndarray, header: Optional[list[str]]) -> Optional[int]:
    if opt == "none":
        return None
    if isinstance(opt, int):
        return opt if 0 <= opt < data.shape[1] else None
    # auto: pick the first column that is monotonically increasing
    # AND looks like time (positive deltas, range > 0). Bias towards
    # column 0, plus take a hint from the header if present.
    if header:
        for i, h in enumerate(header):
            if i >= data.shape[1]:
                break
            if re.search(r"\btime\b|\bt\s*\(", h, re.IGNORECASE):
                if _is_monotonic_time(data[:, i]):
                    return i
    if _is_monotonic_time(data[:, 0]):
        return 0
    return None


def _is_monotonic_time(col: np.ndarray) -> bool:
    if col.size < 2:
        return False
    diffs = np.diff(col)
    if not np.all(diffs > 0):
        return False
    # Reject "index" columns (1, 2, 3, …) — too small a range for a real time axis
    # if everything's the same integer step. We accept them anyway since the user
    # may want sample index as time; sampling rate then comes out as 1 Hz which
    # is obviously wrong but easy to spot. Better: require non-integer steps.
    return float(diffs.max() - diffs.min()) < 0.01 * float(np.median(diffs)) + 1e-9


def _infer_sampling_rate(time_arr: np.ndarray) -> float:
    if time_arr.size < 2:
        raise ValueError("Need at least two time points to infer sampling rate")
    dt = float(np.median(np.diff(time_arr)))
    if dt <= 0:
        raise ValueError("Time column is not strictly increasing")
    return 1.0 / dt


def _split_label_units(header_cell: str) -> tuple[str, str]:
    """Pull units out of a header label like ``"Im (pA)"`` or
    ``"Voltage [mV]"``. Returns ``(label, units)``. If no units
    pattern is found, the whole cell is the label and units is "".
    """
    s = header_cell.strip().strip('"')
    m = _UNIT_IN_LABEL_RE.search(s)
    if m:
        units = m.group(1).strip()
        label = _UNIT_IN_LABEL_RE.sub("", s).strip()
        return label, units
    return s, ""
