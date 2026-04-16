"""Parse the .pul (acquisition/pulse) tree from a HEKA PatchMaster bundle.

Extracts: Root → Group → Series → Sweep → Trace hierarchy with all the
metadata needed to locate and read trace data from the .dat section.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .tree import TreeNode, read_str, read_i32, read_f64, read_u8, read_u16


# ---- Data classes ----

@dataclass
class PulTrace:
    """Metadata for one trace (one channel of one sweep)."""
    label: str
    data_offset: int       # byte offset into the .dat sub-file
    n_points: int          # number of samples
    data_format: int       # 0=int16, 1=int32, 2=float32, 3=float64
    data_scaler: float     # raw_value * scaler = SI value
    zero_data: float       # raw_value * scaler + zero_data = SI value
    x_interval: float      # sampling interval (seconds)
    x_start: float         # time of first sample (seconds)
    y_unit: str            # e.g. "A", "V"
    x_unit: str            # e.g. "s"
    recording_mode: int    # 0=InOut, ..., 4=CClamp, 5=VClamp
    holding: float         # TrTrHolding (SI)

    @property
    def sampling_rate(self) -> float:
        return 1.0 / self.x_interval if self.x_interval > 0 else 20000.0

    @property
    def byte_size(self) -> int:
        """Total byte size of the raw data for this trace."""
        fmt_sizes = {0: 2, 1: 4, 2: 4, 3: 8}
        return self.n_points * fmt_sizes.get(self.data_format, 4)


@dataclass
class PulSweep:
    """One sweep (episode)."""
    label: str
    time: float           # sweep time (seconds since some reference)
    traces: list[PulTrace] = field(default_factory=list)


@dataclass
class PulSeries:
    """One series of sweeps."""
    label: str
    comment: str
    n_sweeps_expected: int
    time: float
    method_name: str
    sweeps: list[PulSweep] = field(default_factory=list)


@dataclass
class PulGroup:
    """One group (typically one cell or experiment)."""
    label: str
    series_list: list[PulSeries] = field(default_factory=list)


@dataclass
class PulRoot:
    """Root of the .pul tree."""
    version: int
    version_name: str
    groups: list[PulGroup] = field(default_factory=list)


# ---- Parsing ----

def parse_pul(data: bytes, tree: TreeNode) -> PulRoot:
    """Parse the .pul tree into PulRoot → PulGroup → PulSeries → PulSweep → PulTrace."""

    off = tree.record_offset
    root = PulRoot(
        version=read_i32(data, off),
        version_name=read_str(data, off + 8, 32),
    )

    for group_node in tree.children:
        group = _parse_group(data, group_node)
        root.groups.append(group)

    return root


def _parse_group(data: bytes, node: TreeNode) -> PulGroup:
    off = node.record_offset
    group = PulGroup(
        label=read_str(data, off + 4, 32),  # GrLabel
    )
    for series_node in node.children:
        series = _parse_series(data, series_node)
        group.series_list.append(series)
    return group


def _parse_series(data: bytes, node: TreeNode) -> PulSeries:
    off = node.record_offset
    series = PulSeries(
        label=read_str(data, off + 4, 32),           # SeLabel
        comment=read_str(data, off + 36, 80),         # SeComment
        n_sweeps_expected=read_i32(data, off + 120),  # SeNumberSweeps
        time=read_f64(data, off + 136),               # SeTime
        method_name=read_str(data, off + 312, 32),    # SeMethodName
    )
    for sweep_node in node.children:
        sweep = _parse_sweep(data, sweep_node)
        series.sweeps.append(sweep)
    return series


def _parse_sweep(data: bytes, node: TreeNode) -> PulSweep:
    off = node.record_offset
    sweep = PulSweep(
        label=read_str(data, off + 4, 32),  # SwLabel
        time=read_f64(data, off + 48),       # SwTime
    )
    for trace_node in node.children:
        trace = _parse_trace(data, trace_node)
        sweep.traces.append(trace)
    return sweep


def _parse_trace(data: bytes, node: TreeNode) -> PulTrace:
    off = node.record_offset
    sz = node.record_size

    return PulTrace(
        label=read_str(data, off + 4, 32),            # TrLabel
        data_offset=read_i32(data, off + 40),          # TrData
        n_points=read_i32(data, off + 44),             # TrDataPoints
        data_format=read_u8(data, off + 70),           # TrDataFormat
        data_scaler=read_f64(data, off + 72),          # TrDataScaler
        zero_data=read_f64(data, off + 88),            # TrZeroData
        x_interval=read_f64(data, off + 104),          # TrXInterval
        x_start=read_f64(data, off + 112),             # TrXStart
        y_unit=read_str(data, off + 96, 8),            # TrYUnit
        x_unit=read_str(data, off + 120, 8),           # TrXUnit
        recording_mode=read_u8(data, off + 68),        # TrRecordingMode
        holding=read_f64(data, off + 408) if sz > 416 else 0.0,  # TrTrHolding (v9+)
    )


# ---- Data reading ----

def read_trace_data(data: bytes, dat_offset: int, trace: PulTrace) -> np.ndarray:
    """Read the raw trace data and convert to SI units.

    TrData is an ABSOLUTE byte offset within the bundle file (not relative
    to the .dat sub-file start). dat_offset is ignored but kept for API compat.
    Returns a float64 array in SI units (Volts, Amps, etc.).
    """
    abs_offset = trace.data_offset  # absolute offset in the bundle
    n = trace.n_points

    dtype_map = {
        0: np.dtype('<i2'),    # int16
        1: np.dtype('<i4'),    # int32
        2: np.dtype('<f4'),    # float32
        3: np.dtype('<f8'),    # float64
    }
    dtype = dtype_map.get(trace.data_format, np.dtype('<f4'))
    byte_size = n * dtype.itemsize

    if abs_offset + byte_size > len(data):
        # Truncated file — return zeros
        return np.zeros(n, dtype=np.float64)

    raw = np.frombuffer(data[abs_offset:abs_offset + byte_size], dtype=dtype)
    # Scale: value_SI = raw * scaler.
    # Note: TrZeroData is NOT added — in modern HEKA files, the zero offset
    # is already incorporated into the raw integer values during acquisition.
    # Adding it would double-count and produce incorrect absolute values.
    return raw.astype(np.float64) * trace.data_scaler
