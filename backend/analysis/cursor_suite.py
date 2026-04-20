"""Stimfit-style cursor analysis suite.

Covers every measurement and fit function exposed by Stimfit's UI:
baseline/peak/amplitude, rise time (10-90 and 20-80), half-width,
time-to-peak, max rise and decay slopes, rise/decay ratio, area,
action-potential threshold (dV/dt crossing), and curve fits with ten
function forms matching libstfnum/funclib.cpp. The single-slot
``analysis/cursors.py`` module is left in place for the generic
``/api/analysis/run`` path; this module powers the dedicated
``/api/cursors/run`` endpoint that the CursorAnalysisWindow calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from scipy.optimize import curve_fit


# ---------------------------------------------------------------------------
# Measurements
# ---------------------------------------------------------------------------

@dataclass
class SlotMeasurement:
    """Per-(sweep, slot) measurement result, matching Stimfit's output."""
    slot: int
    sweep: int                              # -1 when computed on the average trace
    baseline: float
    baseline_sd: float
    peak: float                             # absolute value (Stimfit "peak from 0")
    peak_time: float                        # seconds, absolute in the sweep
    amplitude: float                        # peak - baseline ("peak from base")
    time_to_peak: Optional[float] = None    # peak_time - peak_cursor_start
    rise_time_10_90: Optional[float] = None
    rise_time_20_80: Optional[float] = None
    half_width: Optional[float] = None
    max_slope_rise: Optional[float] = None
    max_slope_decay: Optional[float] = None
    rise_decay_ratio: Optional[float] = None
    area: Optional[float] = None
    # Action-potential specific
    ap_threshold: Optional[float] = None
    ap_threshold_time: Optional[float] = None
    # Fit
    fit: Optional["FitResult"] = None


@dataclass
class FitResult:
    function: str
    params: dict[str, float]
    rss: float
    r_squared: float
    fit_time: list[float]   # time samples aligned to the fit cursor window
    fit_values: list[float] # model evaluated at fit_time


def _baseline(data: np.ndarray, i0: int, i1: int, method: str = "mean") -> tuple[float, float]:
    """Return (baseline, sd or IQR) over [i0, i1)."""
    seg = data[max(0, i0):min(len(data), i1)]
    if seg.size == 0:
        return 0.0, 0.0
    if method == "median":
        med = float(np.median(seg))
        q75, q25 = np.percentile(seg, [75, 25])
        return med, float(q75 - q25)
    return float(np.mean(seg)), float(np.std(seg))


def _peak_signed(seg: np.ndarray, baseline: float) -> tuple[float, int, int]:
    """Return (peak_value, peak_index_in_seg, direction).

    ``direction`` is +1 or -1 — whichever extreme deviates farther from
    the baseline, matching Stimfit's automatic direction handling.
    """
    if seg.size == 0:
        return baseline, 0, -1
    mn, mx = float(np.min(seg)), float(np.max(seg))
    if abs(mn - baseline) >= abs(mx - baseline):
        return mn, int(np.argmin(seg)), -1
    return mx, int(np.argmax(seg)), 1


def _cross(data: np.ndarray, start_idx: int, end_idx: int, level: float,
           from_above: bool) -> Optional[float]:
    """Find the first sample index (float, interpolated) in [start, end)
    where ``data`` crosses ``level`` in the requested direction.
    ``from_above`` = True  → data is decreasing through level.
    ``from_above`` = False → data is increasing through level."""
    n = len(data)
    a = max(0, min(start_idx, n - 1))
    b = max(a, min(end_idx, n - 1))
    for i in range(a, b):
        y0, y1 = data[i], data[i + 1]
        if from_above and y0 >= level >= y1:
            if y1 == y0:
                return float(i)
            return i + (level - y0) / (y1 - y0)
        if (not from_above) and y0 <= level <= y1:
            if y1 == y0:
                return float(i)
            return i + (level - y0) / (y1 - y0)
    return None


def _rise_time(data: np.ndarray, baseline: float, peak_val: float, peak_idx: int,
               direction: int, sr: float, start_idx: int, low_frac: float,
               high_frac: float) -> Optional[float]:
    """Rise time between ``low_frac``×amplitude and ``high_frac``×amplitude.
    Scans backward from peak so the crossings bracket the peak correctly."""
    amp = peak_val - baseline
    if abs(amp) < 1e-15:
        return None
    level_lo = baseline + low_frac * amp
    level_hi = baseline + high_frac * amp
    # Search from start_idx up to peak_idx. For a negative-going event the
    # signal crosses the *lower* absolute level after the *higher* one; we
    # treat fractions relative to signed amplitude so the caller's low/high
    # fractions stay meaningful regardless of direction.
    t_lo = _cross(data, start_idx, peak_idx + 1, level_lo, from_above=(direction < 0))
    t_hi = _cross(data, start_idx, peak_idx + 1, level_hi, from_above=(direction < 0))
    if t_lo is None or t_hi is None:
        return None
    return abs(t_hi - t_lo) / sr


def _half_width(data: np.ndarray, baseline: float, amplitude: float, peak_idx: int,
                direction: int, sr: float, start_idx: int, end_idx: int) -> Optional[float]:
    half_level = baseline + 0.5 * amplitude
    # Before the peak
    t_before: Optional[float] = None
    for i in range(peak_idx - 1, max(start_idx - 1, -1), -1):
        if i + 1 >= len(data):
            continue
        y0, y1 = data[i], data[i + 1]
        if (y0 - half_level) * (y1 - half_level) <= 0:
            t_before = i + (0 if y1 == y0 else (half_level - y0) / (y1 - y0))
            break
    # After the peak
    t_after: Optional[float] = None
    for i in range(peak_idx, min(end_idx, len(data) - 1)):
        y0, y1 = data[i], data[i + 1]
        if (y0 - half_level) * (y1 - half_level) <= 0:
            t_after = i + (0 if y1 == y0 else (half_level - y0) / (y1 - y0))
            break
    if t_before is None or t_after is None:
        return None
    return (t_after - t_before) / sr


def _max_slope(seg: np.ndarray, sr: float, direction: int) -> tuple[Optional[float], Optional[int]]:
    """Return (max_slope, sample_index) within ``seg``.

    ``direction`` = +1 returns the maximum positive slope (rising phase of an
    upward event) or minimum (rising phase of a downward event, i.e. the
    fastest descent toward the peak); we canonicalize so the returned value
    is always in physical units per second and positive for "rising phase"
    irrespective of event polarity.
    """
    if seg.size < 2:
        return None, None
    dy = np.diff(seg) * sr
    if direction < 0:
        idx = int(np.argmin(dy))
        return float(abs(dy[idx])), idx
    idx = int(np.argmax(dy))
    return float(abs(dy[idx])), idx


def _ap_threshold(data: np.ndarray, start_idx: int, end_idx: int, sr: float,
                  slope_thresh: float) -> Optional[tuple[float, float]]:
    """Detect AP threshold as first point in [start, end) where |dV/dt|
    exceeds ``slope_thresh`` (V/s for voltage data). Returns (value, time)."""
    if end_idx - start_idx < 2:
        return None
    seg = data[start_idx:end_idx]
    dv = np.diff(seg) * sr
    crossings = np.where(np.abs(dv) >= slope_thresh)[0]
    if crossings.size == 0:
        return None
    i = int(crossings[0]) + start_idx
    return float(data[i]), float(i / sr)


def measure_slot(
    data: np.ndarray,
    sampling_rate: float,
    baseline_window: tuple[float, float],
    peak_window: tuple[float, float],
    baseline_method: str,
    compute_ap: bool,
    ap_slope_vs: float,
) -> tuple[float, float, dict]:
    """Compute all Stimfit-style measurements for one peak cursor pair.

    Returns (baseline, baseline_sd_or_iqr, measurement_dict). Callers attach
    sweep + slot metadata and handle fits separately.
    """
    dt = 1.0 / sampling_rate
    n = len(data)
    bl_i0 = max(0, min(n, int(round(baseline_window[0] * sampling_rate))))
    bl_i1 = max(0, min(n, int(round(baseline_window[1] * sampling_rate))))
    pk_i0 = max(0, min(n, int(round(peak_window[0] * sampling_rate))))
    pk_i1 = max(0, min(n, int(round(peak_window[1] * sampling_rate))))

    baseline, sd_or_iqr = _baseline(data, bl_i0, bl_i1, baseline_method)

    if pk_i1 <= pk_i0:
        return baseline, sd_or_iqr, {
            "peak": baseline, "peak_time": 0.0, "amplitude": 0.0,
        }

    seg = data[pk_i0:pk_i1]
    peak_val, peak_rel, direction = _peak_signed(seg, baseline)
    peak_idx = pk_i0 + peak_rel
    peak_time = peak_idx * dt
    amplitude = peak_val - baseline

    m: dict[str, Optional[float]] = {
        "peak": peak_val,
        "peak_time": peak_time,
        "amplitude": amplitude,
        "time_to_peak": peak_time - pk_i0 * dt,
    }
    m["rise_time_10_90"] = _rise_time(
        data, baseline, peak_val, peak_idx, direction, sampling_rate, pk_i0, 0.1, 0.9,
    )
    m["rise_time_20_80"] = _rise_time(
        data, baseline, peak_val, peak_idx, direction, sampling_rate, pk_i0, 0.2, 0.8,
    )
    m["half_width"] = _half_width(
        data, baseline, amplitude, peak_idx, direction, sampling_rate, pk_i0, pk_i1,
    )

    rise_slope, _ = _max_slope(data[pk_i0:peak_idx + 1], sampling_rate, direction)
    decay_slope, _ = _max_slope(data[peak_idx:pk_i1], sampling_rate, -direction)
    m["max_slope_rise"] = rise_slope
    m["max_slope_decay"] = decay_slope
    if rise_slope is not None and decay_slope is not None and decay_slope != 0:
        m["rise_decay_ratio"] = rise_slope / decay_slope

    # Trapezoidal area above baseline across the full peak window.
    _trapz = getattr(np, "trapezoid", None) or getattr(np, "trapz")
    m["area"] = float(_trapz(seg - baseline, dx=dt))

    if compute_ap:
        ap = _ap_threshold(data, pk_i0, pk_i1, sampling_rate, ap_slope_vs)
        if ap is not None:
            m["ap_threshold"] = ap[0]
            m["ap_threshold_time"] = ap[1]

    return baseline, sd_or_iqr, m


# ---------------------------------------------------------------------------
# Fit functions (Stimfit's libstfnum/funclib.cpp)
# ---------------------------------------------------------------------------

def _mono_exp(x, amp, tau, offset):
    return amp * np.exp(-x / tau) + offset


def _mono_exp_delay(x, baseline, delay, tau, peak):
    out = np.full_like(x, baseline, dtype=float)
    mask = x >= delay
    out[mask] = (baseline - peak) * np.exp(-(x[mask] - delay) / tau) + peak
    return out


def _bi_exp(x, amp0, tau0, amp1, tau1, offset):
    return amp0 * np.exp(-x / tau0) + amp1 * np.exp(-x / tau1) + offset


def _bi_exp_delay(x, baseline, delay, tau1, factor, tau2):
    # Stimfit: p[0] if x<p[1]; else p[3]*exp((p[1]-x)/p[2]) - p[3]*exp((p[1]-x)/p[4]) + p[0]
    out = np.full_like(x, baseline, dtype=float)
    mask = x >= delay
    t = x[mask] - delay
    out[mask] = factor * np.exp(-t / tau1) - factor * np.exp(-t / tau2) + baseline
    return out


def _tri_exp(x, a0, t0, a1, t1, a2, t2, offset):
    return (a0 * np.exp(-x / t0) + a1 * np.exp(-x / t1)
            + a2 * np.exp(-x / t2) + offset)


def _tri_exp_delay(x, baseline, delay, tau1a, factor, tau2, tau1b, p_tau1b):
    out = np.full_like(x, baseline, dtype=float)
    mask = x >= delay
    t = x[mask] - delay
    rise = p_tau1b * factor * np.exp(-t / tau1a) + (1.0 - p_tau1b) * factor * np.exp(-t / tau1b)
    decay = factor * np.exp(-t / tau2)
    out[mask] = rise - decay + baseline
    return out


def _alpha(x, amp, rate, offset):
    # Stimfit: A * x/tau * exp(1 - x/tau) + offset (peak at x=tau, height=amp)
    with np.errstate(over="ignore", invalid="ignore"):
        return amp * x / rate * np.exp(1 - x / rate) + offset


def _gaussian(x, amp, mean, width):
    return amp * np.exp(-((x - mean) / width) ** 2)


def _hh_gna(x, gprime, tau_m, tau_h, offset):
    return gprime * (1 - np.exp(-x / tau_m)) ** 3 * np.exp(-x / tau_h) + offset


def _power1_gna(x, gprime, tau_m, tau_h, offset):
    return gprime * (1 - np.exp(-x / tau_m)) * np.exp(-x / tau_h) + offset


def _boltzmann(x, bottom, top, v50, slope):
    return bottom + (top - bottom) / (1 + np.exp((v50 - x) / slope))


FIT_FUNCTIONS: dict[str, dict] = {
    "mono_exp": {
        "label": "Monoexponential",
        "fn": _mono_exp,
        "params": ["amp", "tau", "offset"],
        "guess": lambda x, y: [y[0] - y[-1], max((x[-1] - x[0]) / 3, 1e-6), y[-1]],
    },
    "mono_exp_delay": {
        "label": "Monoexponential with delay",
        "fn": _mono_exp_delay,
        "params": ["baseline", "delay", "tau", "peak"],
        "guess": lambda x, y: [y[0], x[0] + (x[-1] - x[0]) * 0.1, max((x[-1] - x[0]) / 3, 1e-6), y[-1]],
    },
    "bi_exp": {
        "label": "Biexponential",
        "fn": _bi_exp,
        "params": ["amp0", "tau0", "amp1", "tau1", "offset"],
        "guess": lambda x, y: [
            (y[0] - y[-1]) * 0.5, max((x[-1] - x[0]) / 10, 1e-6),
            (y[0] - y[-1]) * 0.5, max((x[-1] - x[0]) / 2, 1e-6),
            y[-1],
        ],
    },
    "bi_exp_delay": {
        "label": "Biexponential with delay",
        "fn": _bi_exp_delay,
        "params": ["baseline", "delay", "tau1", "factor", "tau2"],
        "guess": lambda x, y: [
            y[0], x[0] + (x[-1] - x[0]) * 0.1,
            max((x[-1] - x[0]) / 10, 1e-6),
            float(np.max(y) - np.min(y)),
            max((x[-1] - x[0]) / 2, 1e-6),
        ],
    },
    "tri_exp": {
        "label": "Triexponential",
        "fn": _tri_exp,
        "params": ["amp0", "tau0", "amp1", "tau1", "amp2", "tau2", "offset"],
        "guess": lambda x, y: [
            (y[0] - y[-1]) / 3, max((x[-1] - x[0]) / 20, 1e-6),
            (y[0] - y[-1]) / 3, max((x[-1] - x[0]) / 5, 1e-6),
            (y[0] - y[-1]) / 3, max((x[-1] - x[0]) / 1.5, 1e-6),
            y[-1],
        ],
    },
    "tri_exp_delay": {
        "label": "Triexponential with delay",
        "fn": _tri_exp_delay,
        "params": ["baseline", "delay", "tau1a", "factor", "tau2", "tau1b", "p_tau1b"],
        "guess": lambda x, y: [
            y[0], x[0] + (x[-1] - x[0]) * 0.1,
            max((x[-1] - x[0]) / 20, 1e-6),
            float(np.max(y) - np.min(y)),
            max((x[-1] - x[0]) / 2, 1e-6),
            max((x[-1] - x[0]) / 5, 1e-6),
            0.5,
        ],
    },
    "alpha": {
        "label": "Alpha function",
        "fn": _alpha,
        "params": ["amp", "rate", "offset"],
        "guess": lambda x, y: [
            float(np.max(y) - np.min(y)),
            max((x[-1] - x[0]) / 5, 1e-6),
            float(y[0]),
        ],
    },
    "gaussian": {
        "label": "Gaussian",
        "fn": _gaussian,
        "params": ["amp", "mean", "width"],
        "guess": lambda x, y: [
            float(np.max(y) - np.min(y)),
            float(x[int(np.argmax(y))]),
            max((x[-1] - x[0]) / 6, 1e-6),
        ],
    },
    "hh_gna": {
        "label": "Hodgkin-Huxley g_Na",
        "fn": _hh_gna,
        "params": ["gprime", "tau_m", "tau_h", "offset"],
        "guess": lambda x, y: [
            float(np.max(y) - np.min(y)),
            max((x[-1] - x[0]) / 20, 1e-6),
            max((x[-1] - x[0]) / 5, 1e-6),
            float(np.min(y)),
        ],
    },
    "power1_gna": {
        "label": "Power of 1 g_Na",
        "fn": _power1_gna,
        "params": ["gprime", "tau_m", "tau_h", "offset"],
        "guess": lambda x, y: [
            float(np.max(y) - np.min(y)),
            max((x[-1] - x[0]) / 20, 1e-6),
            max((x[-1] - x[0]) / 5, 1e-6),
            float(np.min(y)),
        ],
    },
    "boltzmann": {
        "label": "Boltzmann",
        "fn": _boltzmann,
        "params": ["bottom", "top", "v50", "slope"],
        "guess": lambda x, y: [
            float(np.min(y)), float(np.max(y)),
            float((x[0] + x[-1]) / 2),
            max((x[-1] - x[0]) / 10, 1e-6),
        ],
    },
}


def fit_window(data: np.ndarray, sampling_rate: float,
               window: tuple[float, float], function: str) -> Optional[FitResult]:
    """Fit ``function`` to ``data`` over the (start, end) seconds window."""
    entry = FIT_FUNCTIONS.get(function)
    if entry is None:
        return None
    n = len(data)
    i0 = max(0, min(n, int(round(window[0] * sampling_rate))))
    i1 = max(0, min(n, int(round(window[1] * sampling_rate))))
    if i1 - i0 < len(entry["params"]) + 1:
        return None
    dt = 1.0 / sampling_rate
    # Fit on a local time axis starting at 0 — matches Stimfit's behavior
    # and avoids huge x values that destabilize the nonlinear solver.
    x = np.arange(i1 - i0, dtype=float) * dt
    y = data[i0:i1].astype(float)
    try:
        p0 = entry["guess"](x, y)
        popt, _pcov = curve_fit(entry["fn"], x, y, p0=p0, maxfev=5000)
    except Exception:
        return None
    y_fit = entry["fn"](x, *popt)
    resid = y - y_fit
    rss = float(np.sum(resid ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1.0 - rss / ss_tot if ss_tot > 0 else 1.0
    # Emit fit time in absolute-sweep seconds so the frontend can overlay.
    return FitResult(
        function=function,
        params={name: float(val) for name, val in zip(entry["params"], popt)},
        rss=rss,
        r_squared=r2,
        fit_time=[float(window[0] + t) for t in x.tolist()],
        fit_values=[float(v) for v in y_fit.tolist()],
    )


def fit_function_catalog() -> list[dict]:
    """Return a frontend-friendly listing of the fit functions."""
    return [
        {"id": key, "label": entry["label"], "params": entry["params"]}
        for key, entry in FIT_FUNCTIONS.items()
    ]
