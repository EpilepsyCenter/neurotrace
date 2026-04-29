"""Pure-numpy processing pipeline for Trace Export.

This module is the single source of truth for what a trace looks
like after the user's per-series knobs (filter / baseline / blanking)
and per-trace knobs (xOffset / xRange / decimation) have been applied.
Both the live preview endpoint and the final matplotlib render
funnel through ``process_trace`` so they cannot drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np

from utils.filters import bandpass_filter, highpass_filter, lowpass_filter
from utils.downsampling import lttb_downsample


@dataclass
class FilterCfg:
    enabled: bool = False
    type: Literal["lowpass", "highpass", "bandpass"] = "lowpass"
    low_hz: float = 0.0
    high_hz: float = 0.0
    order: int = 4


@dataclass
class BaselineCfg:
    enabled: bool = False
    t0: float = 0.0
    t1: float = 0.05


@dataclass
class BlankingCfg:
    enabled: bool = False
    t0: float = 0.0
    t1: float = 0.0
    mode: Literal["interp", "hide"] = "interp"


@dataclass
class DecimationCfg:
    enabled: bool = True
    max_points: int = 8000


@dataclass
class SeriesCfg:
    """Per-(file, group, series) processing settings."""
    filter: FilterCfg
    baseline: BaselineCfg
    blanking: BlankingCfg


def _apply_filter(values: np.ndarray, sr: float, cfg: FilterCfg) -> np.ndarray:
    if not cfg.enabled:
        return values
    try:
        if cfg.type == "lowpass" and cfg.high_hz > 0:
            return lowpass_filter(values, cfg.high_hz, sr, cfg.order)
        if cfg.type == "highpass" and cfg.low_hz > 0:
            return highpass_filter(values, cfg.low_hz, sr, cfg.order)
        if cfg.type == "bandpass" and cfg.low_hz > 0 and cfg.high_hz > 0:
            return bandpass_filter(values, cfg.low_hz, cfg.high_hz, sr, cfg.order)
    except Exception:
        return values
    return values


def _apply_baseline(values: np.ndarray, sr: float, cfg: BaselineCfg) -> np.ndarray:
    if not cfg.enabled:
        return values
    n = len(values)
    i0 = max(0, int(cfg.t0 * sr))
    i1 = min(n, int(cfg.t1 * sr))
    if i1 <= i0:
        return values
    base = float(np.median(values[i0:i1]))
    return values - base


def _apply_blanking(values: np.ndarray, sr: float, cfg: BlankingCfg) -> np.ndarray:
    """Either interpolate across [t0, t1] or replace with NaN.

    Matplotlib draws NaN as a gap in the line, which is visually the
    "hide" we want for stim artifacts; uPlot honors NaN the same way.
    """
    if not cfg.enabled or cfg.t1 <= cfg.t0:
        return values
    n = len(values)
    i0 = max(0, int(cfg.t0 * sr))
    i1 = min(n, int(cfg.t1 * sr))
    if i1 <= i0:
        return values
    out = values.astype(np.float64, copy=True)
    if cfg.mode == "hide":
        out[i0:i1] = np.nan
        return out
    # 'interp' — linear bridge across the window
    if i0 == 0 or i1 >= n:
        out[i0:i1] = np.nan
        return out
    a = out[i0 - 1]
    b = out[i1]
    out[i0:i1] = np.linspace(a, b, i1 - i0, endpoint=False)
    return out


def process_trace(
    values: np.ndarray,
    sr: float,
    series_cfg: SeriesCfg,
    x_window: Optional[tuple[float, float]] = None,
    x_offset: float = 0.0,
    decimation: Optional[DecimationCfg] = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply the full pipeline to one trace and return ``(time, values)``.

    Order:
      1. Filter (full sweep, so edges aren't biased by the window)
      2. Baseline subtract (full sweep, by t0/t1 in source-time)
      3. Window slice [t_start, t_end]
      4. Blanking (slice-local times, same source-time coords)
      5. Decimation (LTTB)
      6. x_offset added at the very end (does not affect any of the above)
    """
    values = np.asarray(values, dtype=np.float64)
    n = len(values)

    values = _apply_filter(values, sr, series_cfg.filter)
    values = _apply_baseline(values, sr, series_cfg.baseline)

    if x_window is not None:
        t0, t1 = x_window
        i0 = max(0, int(t0 * sr))
        i1 = min(n, int(t1 * sr) + 1)
        if i1 <= i0:
            return np.array([]), np.array([])
    else:
        i0, i1 = 0, n

    sliced = values[i0:i1].copy()
    # Re-base blanking times against the source-time origin so the user's
    # windows remain meaningful even after slicing.
    if series_cfg.blanking.enabled:
        # convert source-time blanking window into the slice's index space
        b_i0 = max(0, int(series_cfg.blanking.t0 * sr) - i0)
        b_i1 = min(len(sliced), int(series_cfg.blanking.t1 * sr) - i0)
        if b_i1 > b_i0:
            shifted = BlankingCfg(
                enabled=True,
                t0=b_i0 / sr,
                t1=b_i1 / sr,
                mode=series_cfg.blanking.mode,
            )
            sliced = _apply_blanking(sliced, sr, shifted)

    time = (np.arange(i0, i0 + len(sliced)) / sr) + x_offset

    if decimation and decimation.enabled and decimation.max_points > 0 and len(sliced) > decimation.max_points:
        time, sliced = lttb_downsample(
            np.ascontiguousarray(time),
            np.ascontiguousarray(sliced),
            decimation.max_points,
        )

    return time, sliced


def average_traces(traces: list[np.ndarray]) -> np.ndarray:
    """Mean across same-length traces. Aligns to shortest length."""
    if not traces:
        return np.array([])
    min_len = min(len(t) for t in traces)
    aligned = np.stack([t[:min_len] for t in traces], axis=0)
    return np.mean(aligned, axis=0)
