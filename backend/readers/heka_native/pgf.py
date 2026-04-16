"""Parse the .pgf (stimulus) tree from a HEKA PatchMaster bundle.

Extracts: Stimulation → Channel → Segment hierarchy with per-sweep
voltage/current reconstruction using the increment math.

Segment classes: Constant, Ramp, Continuous.
Increment modes: Inc, Dec, Alternate, LogInc, LogDec, etc.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .tree import TreeNode, read_str, read_i32, read_f64, read_u8, read_bool


# ---- Enums ----

class SegmentClass:
    Constant = 0
    Ramp = 1
    Continuous = 2
    ConstSine = 3
    Squarewave = 4
    Chirpwave = 5


class IncrementMode:
    Inc = 0
    Dec = 1
    IncInterleaved = 2
    DecInterleaved = 3
    Alternate = 4
    LogInc = 5
    LogDec = 6
    LogIncInterleaved = 7
    LogDecInterleaved = 8
    LogAlternate = 9


class StoreKind:
    NoStore = 0
    Store = 1
    StoreStart = 2
    StoreEnd = 3


# ---- Data classes ----

@dataclass
class PgfSegment:
    """One segment of a stimulus channel."""
    seg_class: int           # SegmentClass enum
    store_kind: int          # StoreKind enum
    voltage_inc_mode: int    # IncrementMode enum
    duration_inc_mode: int   # IncrementMode enum
    voltage: float           # base voltage/current for sweep 0 (SI: V or A)
    delta_v_factor: float    # multiplicative factor for voltage increment
    delta_v_increment: float # additive voltage increment per sweep
    duration: float          # base duration for sweep 0 (seconds)
    delta_t_factor: float    # multiplicative factor for duration increment
    delta_t_increment: float # additive duration increment per sweep

    def voltage_at_sweep(self, sweep_idx: int) -> float:
        """Compute the voltage/current level for a given sweep index."""
        return _apply_increment(
            self.voltage, sweep_idx,
            self.delta_v_increment, self.delta_v_factor,
            self.voltage_inc_mode,
        )

    def duration_at_sweep(self, sweep_idx: int) -> float:
        """Compute the segment duration for a given sweep index."""
        return _apply_increment(
            self.duration, sweep_idx,
            self.delta_t_increment, self.delta_t_factor,
            self.duration_inc_mode,
        )


@dataclass
class PgfChannel:
    """One DA/AD channel of a stimulation."""
    linked_channel: int
    dac_channel: int
    adc_channel: int
    dac_unit: str        # e.g. "V", "A"
    y_unit: str          # e.g. "A", "V"
    holding: float       # holding potential/current (SI)
    ampl_mode: int       # 0=Any, 1=VC, 2=CC, 3=IDensity
    do_write: bool       # whether this channel's data is stored
    segments: list[PgfSegment] = field(default_factory=list)

    # Convenience
    @property
    def is_voltage_clamp(self) -> bool:
        return self.ampl_mode == 1

    @property
    def is_current_clamp(self) -> bool:
        return self.ampl_mode == 2

    @property
    def stim_unit_label(self) -> str:
        """Human-readable unit for the stimulus command."""
        u = self.dac_unit.strip()
        if u in ('V', 'Volt'):
            return 'mV'
        elif u in ('A', 'Amp', 'Ampere'):
            return 'pA'
        return u

    def reconstruct_sweep(self, sweep_idx: int, dt: float) -> np.ndarray:
        """Reconstruct the DA waveform for a given sweep as a sample array.

        dt is the sampling interval in seconds.
        Returns values in SI units (V or A).
        """
        samples: list[np.ndarray] = []
        prev_end_level = self.holding

        for seg in self.segments:
            dur = seg.duration_at_sweep(sweep_idx)
            n = max(1, int(round(dur / dt)))
            level = seg.voltage_at_sweep(sweep_idx)

            if seg.seg_class == SegmentClass.Constant:
                samples.append(np.full(n, level))
                prev_end_level = level

            elif seg.seg_class == SegmentClass.Ramp:
                # Ramp from previous segment's end level to this segment's level
                samples.append(np.linspace(prev_end_level, level, n))
                prev_end_level = level

            elif seg.seg_class == SegmentClass.Continuous:
                # Continue at whatever level was last
                samples.append(np.full(n, prev_end_level))

            else:
                # Unsupported segment class — fill with holding
                samples.append(np.full(n, self.holding))
                prev_end_level = self.holding

        if not samples:
            return np.array([self.holding])

        return np.concatenate(samples)


@dataclass
class PgfStimulation:
    """One stimulation protocol (maps 1:1 to a .pul Series)."""
    name: str
    sample_interval: float  # seconds
    sweep_interval: float   # seconds between sweeps
    n_sweeps: int
    is_gap_free: bool
    channels: list[PgfChannel] = field(default_factory=list)


@dataclass
class PgfRoot:
    """Root of the .pgf tree."""
    version: int
    stimulations: list[PgfStimulation] = field(default_factory=list)


# ---- Parsing ----

def parse_pgf(data: bytes, tree: TreeNode) -> PgfRoot:
    """Parse the .pgf tree into PgfRoot → PgfStimulation → PgfChannel → PgfSegment."""

    # Root
    off = tree.record_offset
    root = PgfRoot(version=read_i32(data, off))

    for stim_node in tree.children:
        stim = _parse_stimulation(data, stim_node)
        root.stimulations.append(stim)

    return root


def _parse_stimulation(data: bytes, node: TreeNode) -> PgfStimulation:
    off = node.record_offset
    name = read_str(data, off + 4, 32)            # stEntryName
    sample_interval = read_f64(data, off + 112)    # stSampleInterval
    sweep_interval = read_f64(data, off + 120)     # stSweepInterval
    n_sweeps = read_i32(data, off + 144)           # stNumberSweeps
    is_gap_free = read_bool(data, off + 240)       # sIsGapFree

    stim = PgfStimulation(
        name=name,
        sample_interval=sample_interval,
        sweep_interval=sweep_interval,
        n_sweeps=n_sweeps,
        is_gap_free=is_gap_free,
    )

    for ch_node in node.children:
        ch = _parse_channel(data, ch_node)
        stim.channels.append(ch)

    return stim


def _parse_channel(data: bytes, node: TreeNode) -> PgfChannel:
    off = node.record_offset
    ch = PgfChannel(
        linked_channel=read_i32(data, off + 4),     # chLinkedChannel
        dac_channel=read_i32(data, off + 28) if node.record_size > 28 else 0,
        adc_channel=read_i32(data, off + 20) if node.record_size > 20 else 0,
        y_unit=read_str(data, off + 12, 8),          # chYUnit
        dac_unit=read_str(data, off + 40, 8),         # chDacUnit
        holding=read_f64(data, off + 48),              # chHolding
        ampl_mode=read_u8(data, off + 25),             # chAmplMode
        do_write=read_bool(data, off + 23),            # chDoWrite
    )

    for seg_node in node.children:
        seg = _parse_segment(data, seg_node)
        ch.segments.append(seg)

    return ch


def _parse_segment(data: bytes, node: TreeNode) -> PgfSegment:
    off = node.record_offset
    return PgfSegment(
        seg_class=read_u8(data, off + 4),              # seClass
        store_kind=read_u8(data, off + 5),             # seStoreKind
        voltage_inc_mode=read_u8(data, off + 6),       # seVoltageIncMode
        duration_inc_mode=read_u8(data, off + 7),      # seDurationIncMode
        voltage=read_f64(data, off + 8),               # seVoltage (SI)
        delta_v_factor=read_f64(data, off + 20),       # seDeltaVFactor
        delta_v_increment=read_f64(data, off + 28),    # seDeltaVIncrement (SI)
        duration=read_f64(data, off + 36),             # seDuration (seconds)
        delta_t_factor=read_f64(data, off + 48),       # seDeltaTFactor
        delta_t_increment=read_f64(data, off + 56),    # seDeltaTIncrement (seconds)
    )


# ---- Increment math ----

def _apply_increment(
    base: float,
    sweep_idx: int,
    increment: float,
    factor: float,
    mode: int,
) -> float:
    """Apply the per-sweep increment to a base value.

    Handles linear, logarithmic, alternating, and interleaved modes.

    In HEKA files, when factor == 1.0 (or 0), the increment is always
    additive regardless of the mode label. The "log" modes only use
    multiplicative scaling when factor != 1.0 AND base != 0.
    """
    if sweep_idx == 0:
        return base
    if increment == 0 and (factor == 0 or factor == 1.0):
        return base

    # For truly multiplicative (log) modes: factor must differ from 1.0
    # and base must be non-zero for multiplication to be meaningful.
    use_multiplicative = (
        factor != 0 and factor != 1.0 and base != 0 and
        mode in (IncrementMode.LogInc, IncrementMode.LogDec,
                 IncrementMode.LogIncInterleaved, IncrementMode.LogDecInterleaved,
                 IncrementMode.LogAlternate)
    )

    if use_multiplicative:
        if mode in (IncrementMode.LogInc, IncrementMode.LogIncInterleaved):
            return base * (factor ** sweep_idx)
        elif mode in (IncrementMode.LogDec, IncrementMode.LogDecInterleaved):
            return base / (factor ** sweep_idx)
        elif mode == IncrementMode.LogAlternate:
            sign = 1 if (sweep_idx % 2 == 0) else -1
            half = (sweep_idx + 1) // 2
            return base * (factor ** (sign * half))

    # Additive (linear) modes — the default for all modes when factor=1 or base=0
    if mode in (IncrementMode.Dec, IncrementMode.DecInterleaved, IncrementMode.LogDec, IncrementMode.LogDecInterleaved):
        return base - sweep_idx * increment
    elif mode == IncrementMode.Alternate or mode == IncrementMode.LogAlternate:
        sign = 1 if (sweep_idx % 2 == 0) else -1
        half = (sweep_idx + 1) // 2
        return base + sign * half * increment
    else:
        # Inc, IncInterleaved, LogInc (with factor=1), and anything else
        return base + sweep_idx * increment
