"""Cohort-level metric extraction from ``.neurotrace`` sidecars.

This is the foundation of the Cohort Analysis module (Phase B in
``NeuroTrace_modules_spec.md``). It does not run statistics or render
plots — it just walks a folder of sidecar JSON files and produces a
flat per-cell table of metrics for downstream stats / graphs / export.

# Two metric kinds

Each per-analysis extractor returns a :class:`CellExtraction` carrying:

* ``scalars``       — per-cell single numbers (``freq_hz``,
  ``amp_mean``, ``rheobase_pa`` …). Plotted as dot+SEM, tested with
  t / Mann-Whitney / RM-ANOVA.
* ``distributions`` — per-cell **arrays** (every IEI, every event
  amplitude). Plotted as overlaid per-cell ECDFs grouped by
  condition. Stats default to Mann-Whitney on the per-cell median
  (defensible N = n_cells); pooled K-S is opt-in only because it
  pseudoreplicates events.
* ``meta``          — bookkeeping (event counts, recording duration,
  units). The cohort UI uses ``meta`` to surface per-cell counts +
  drive the auto-min subsampling control on distribution metrics.

# Sidecar key conventions

Sidecars are written by the frontend, so JSON keys are camelCase
(``peakTimeS``, ``totalLengthS``, ``riseTimeMs``). Don't assume
snake_case here — the only snake_case parts of the sidecar are
``meta.group_tags`` / ``meta.series_tags`` which were defined that
way for the metadata module.

# IEI / IBI computation

IEIs and IBIs are derived **within each sweep** — never bridge across
sweep boundaries. There's a recording gap between sweeps that would
inflate any inter-event interval bridging two sweeps.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

# Recording extensions that carry a ``.neurotrace`` sidecar. Mirrors
# ``RECORDING_EXTENSIONS`` in ``electron/main.ts`` so a cohort scan
# sees the same files the metadata window does.
RECORDING_EXTS = {'.dat', '.abf', '.h5', '.nwb', '.wcp', '.axgd', '.smr'}


# ---------------------------------------------------------------------
# Result type returned by every extractor
# ---------------------------------------------------------------------

@dataclass
class CellExtraction:
    """One cell's contribution to a cohort comparison.

    All three slots are JSON-serialisable so the API layer can return
    them as-is.
    """
    scalars: dict[str, Optional[float]] = field(default_factory=dict)
    distributions: dict[str, list[float]] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)


# ``(slice_data, sidecar_top_level) -> CellExtraction``. The top-level
# is passed in case an extractor needs cross-slice context (e.g. file
# tags, holding potential, recording duration); most won't need it.
ExtractorFn = Callable[[dict, dict], CellExtraction]


# ---------------------------------------------------------------------
# Tiny stats helpers — all None-safe
# ---------------------------------------------------------------------

def _clean(xs) -> list[float]:
    """Drop ``None`` and NaN, coerce to ``float``. Defensive against
    sidecars where optional fields can legitimately be missing
    (manual events without measured kinetics, edge bursts, etc.)."""
    out: list[float] = []
    for x in xs or []:
        if x is None:
            continue
        try:
            f = float(x)
        except (TypeError, ValueError):
            continue
        if math.isnan(f):
            continue
        out.append(f)
    return out


def _mean(xs) -> Optional[float]:
    xs = _clean(xs)
    return float(np.mean(xs)) if xs else None


def _median(xs) -> Optional[float]:
    xs = _clean(xs)
    return float(np.median(xs)) if xs else None


def _sd(xs) -> Optional[float]:
    """Sample SD (ddof=1). Returns ``None`` for n < 2."""
    xs = _clean(xs)
    return float(np.std(xs, ddof=1)) if len(xs) >= 2 else None


def _cv(xs) -> Optional[float]:
    """Coefficient of variation = SD / |mean|. Useful regularity
    metric for IEI / IBI distributions; lower = more regular.
    Returns ``None`` if mean is ~0 to avoid division blow-ups."""
    m = _mean(xs)
    s = _sd(xs)
    if m is None or s is None or abs(m) < 1e-12:
        return None
    return s / abs(m)


def _within_sweep_intervals_ms(events: list[dict],
                               time_key: str = 'peakTimeS',
                               sweep_key: str = 'sweep') -> list[float]:
    """Compute consecutive intervals **in ms**, partitioned by sweep.

    Use for events: pairs ``np.diff(peak_times)`` within each sweep,
    then concatenates across sweeps. Skips bridging across sweeps so
    the recording gap doesn't pollute the IEI distribution.
    """
    by_sweep: dict[int, list[float]] = {}
    for e in events or []:
        t = e.get(time_key)
        if t is None:
            continue
        sweep = int(e.get(sweep_key, 0) or 0)
        try:
            by_sweep.setdefault(sweep, []).append(float(t))
        except (TypeError, ValueError):
            continue
    out: list[float] = []
    for times in by_sweep.values():
        if len(times) < 2:
            continue
        times.sort()
        for a, b in zip(times, times[1:]):
            out.append((b - a) * 1000.0)
    return out


# ---------------------------------------------------------------------
# Events extractor (spontaneous events / minis / sPSCs)
# ---------------------------------------------------------------------

def extract_events(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Per-cell summary of detected events.

    Scalars match the typical mini paper Methods section; distributions
    drive the cumulative-probability graphs reviewers always ask for.
    """
    events = slice_data.get('events') or []
    total_s = float(slice_data.get('totalLengthS') or 0.0)

    n_events = len(events)
    amps = [e.get('amplitude') for e in events]
    rises = [e.get('riseTimeMs') for e in events]
    decays = [e.get('decayTimeMs') for e in events]
    halfwidths = [e.get('halfWidthMs') for e in events]
    taus = [e.get('decayTauMs') for e in events]
    aucs = [e.get('auc') for e in events]
    iei_ms = _within_sweep_intervals_ms(events)

    scalars: dict[str, Optional[float]] = {
        'n_events': float(n_events),
        # Frequency uses the analysed-window duration the frontend
        # already tracks (sum of analysed sweep lengths). If we used
        # max(peakTimeS) we'd undercount cells with quiet tails.
        'freq_hz': (n_events / total_s) if total_s > 0 else None,
        'iei_mean_ms': _mean(iei_ms),
        'iei_median_ms': _median(iei_ms),
        'iei_sd_ms': _sd(iei_ms),
        'iei_cv': _cv(iei_ms),
        'amp_mean': _mean(amps),
        'amp_median': _median(amps),
        'amp_sd': _sd(amps),
        'amp_cv': _cv(amps),
        'rise_mean_ms': _mean(rises),
        'decay_mean_ms': _mean(decays),
        'tau_decay_mean_ms': _mean(taus),
        'half_width_mean_ms': _mean(halfwidths),
        'auc_mean': _mean(aucs),
    }

    distributions: dict[str, list[float]] = {
        'iei_ms': iei_ms,
        'amp': _clean(amps),
        'rise_ms': _clean(rises),
        'decay_ms': _clean(decays),
        'tau_decay_ms': _clean(taus),
        'half_width_ms': _clean(halfwidths),
        'auc': _clean(aucs),
    }

    meta: dict[str, Any] = {
        'n_events_total': n_events,
        'total_length_s': total_s,
        'sweeps_analysed': list(slice_data.get('sweepsAnalysed') or []),
        'units': slice_data.get('units') or '',
        # Distribution-metric subsampling reads this to drive the
        # auto-min control: per-distribution non-null count.
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


# ---------------------------------------------------------------------
# Action-potential extractor
# ---------------------------------------------------------------------

def extract_ap(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Per-cell AP analysis: rheobase, FI slope, AP shape."""
    per_sweep = slice_data.get('perSweep') or []
    per_spike = slice_data.get('perSpike') or []
    rheobase = slice_data.get('rheobase') or {}
    fi_curve = slice_data.get('fiCurve') or {}

    # FI slope from a simple linear regression on the suprathreshold
    # portion (rate > 0). Not robust to plateauing cells — the cohort
    # spec calls out a follow-up to fit a saturating function later.
    fi_slope: Optional[float] = None
    fi_intercept: Optional[float] = None
    ims = fi_curve.get('im') or []
    rates = fi_curve.get('rate') or []
    sup = [(im, r) for im, r in zip(ims, rates)
           if im is not None and r is not None and r > 0]
    if len(sup) >= 2:
        xs = np.array([s[0] for s in sup], dtype=float)
        ys = np.array([s[1] for s in sup], dtype=float)
        slope, intercept = np.polyfit(xs, ys, 1)
        fi_slope = float(slope)
        fi_intercept = float(intercept)

    thresholds = [s.get('thresholdVm') for s in per_spike]
    peaks = [s.get('peakVm') for s in per_spike]
    amps = [s.get('amplitudeMv') for s in per_spike]
    fwhm_ms = [(s.get('halfWidthS') or 0) * 1000.0 if s.get('halfWidthS') is not None else None
               for s in per_spike]
    rise_slopes = [s.get('maxRiseSlopeMvMs') for s in per_spike]
    decay_slopes = [s.get('maxDecaySlopeMvMs') for s in per_spike]
    fahps = [s.get('fahpVm') for s in per_spike]
    mahps = [s.get('mahpVm') for s in per_spike]
    rates_per_sweep = [s.get('spikeRateHz') for s in per_sweep]
    first_spike_lat = [s.get('firstSpikeLatency') for s in per_sweep]
    sfa_div = [s.get('sfaDivisor') for s in per_sweep]
    local_var = [s.get('localVariance') for s in per_sweep]

    scalars: dict[str, Optional[float]] = {
        'rheobase_pa': float(rheobase.get('value')) if rheobase.get('value') is not None else None,
        'threshold_mean_mv': _mean(thresholds),
        'ap_amp_mean_mv': _mean(amps),
        'ap_peak_mean_mv': _mean(peaks),
        'fwhm_mean_ms': _mean(fwhm_ms),
        'fi_slope_hz_per_pa': fi_slope,
        'fi_intercept_hz': fi_intercept,
        'max_rate_hz': float(max(_clean(rates_per_sweep))) if _clean(rates_per_sweep) else None,
        'max_rise_slope_mv_per_ms': _mean(rise_slopes),
        'max_decay_slope_mv_per_ms': _mean(decay_slopes),
        'fahp_mean_mv': _mean(fahps),
        'mahp_mean_mv': _mean(mahps),
        'first_spike_latency_mean_s': _mean(first_spike_lat),
        'sfa_divisor_mean': _mean(sfa_div),
        'local_variance_mean': _mean(local_var),
        'n_spikes_total': float(len(per_spike)),
    }

    distributions: dict[str, list[float]] = {
        'threshold_mv': _clean(thresholds),
        'amp_mv': _clean(amps),
        'fwhm_ms': _clean(fwhm_ms),
        'rise_slope_mv_per_ms': _clean(rise_slopes),
        'decay_slope_mv_per_ms': _clean(decay_slopes),
    }

    meta: dict[str, Any] = {
        'n_sweeps': len(per_sweep),
        'n_spikes_total': len(per_spike),
        'rheobase_mode': rheobase.get('mode'),
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


# ---------------------------------------------------------------------
# I-V curve extractor
# ---------------------------------------------------------------------

def extract_iv(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Linear fit on the I-V curve.

    The slope and reversal here are unit-agnostic — caller knows
    whether stim is current (slope = R, reversal in mV) or voltage
    (slope = 1/R, reversal in pA) from ``meta.stim_unit`` /
    ``meta.response_unit``. We don't try to convert because input
    resistance from a current-injection IV is the same number under
    both interpretations.
    """
    points = slice_data.get('points') or []
    metric = slice_data.get('responseMetric', 'steady')
    field_name = 'steadyState' if metric == 'steady' else 'transientPeak'

    pairs = [(p.get('stimLevel'), p.get(field_name))
             for p in points
             if p.get('stimLevel') is not None and p.get(field_name) is not None]

    scalars: dict[str, Optional[float]] = {
        'iv_slope': None,
        'iv_intercept': None,
        'reversal_potential': None,
        'sag_amp_mean': _mean([p.get('sagAmp') for p in points]),
        'sag_ratio_mean': _mean([p.get('sagRatio') for p in points]),
        'n_points': float(len(points)),
    }

    if len(pairs) >= 2:
        xs = np.array([p[0] for p in pairs], dtype=float)
        ys = np.array([p[1] for p in pairs], dtype=float)
        slope, intercept = np.polyfit(xs, ys, 1)
        scalars['iv_slope'] = float(slope)
        scalars['iv_intercept'] = float(intercept)
        if slope != 0:
            scalars['reversal_potential'] = -float(intercept) / float(slope)

    meta: dict[str, Any] = {
        'n_points': len(points),
        'response_metric': metric,
        'stim_unit': slice_data.get('stimUnit'),
        'response_unit': slice_data.get('responseUnit'),
    }

    # IV doesn't carry meaningful per-cell distributions for ECDF;
    # leave empty so the metric tree's distribution branch hides.
    return CellExtraction(scalars=scalars, distributions={}, meta=meta)


# ---------------------------------------------------------------------
# Bursts extractor (field bursts, ISI bursts, threshold bursts)
# ---------------------------------------------------------------------

def extract_bursts(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Per-cell burst summary + IBI distribution.

    IBI = inter-burst interval, measured end-of-prev → start-of-next
    within the same sweep. Cross-sweep gaps are excluded for the same
    reason events skip them.
    """
    bursts = slice_data.get('bursts') or []
    n_bursts = len(bursts)

    durations_ms = [b.get('durationMs') for b in bursts]
    peaks = [b.get('peakAmplitude') for b in bursts]
    integrals = [b.get('integral') for b in bursts]
    rise_times = [b.get('riseTime10_90Ms') for b in bursts]
    decay_times = [b.get('decayHalfTimeMs') for b in bursts]
    mean_freqs = [b.get('meanFrequencyHz') for b in bursts]
    n_spikes = [b.get('nSpikes') for b in bursts]

    # IBI: gap from end of one burst to start of next, within sweep.
    by_sweep: dict[int, list[tuple[float, float]]] = {}
    for b in bursts:
        start = b.get('startS')
        end = b.get('endS')
        if start is None or end is None:
            continue
        try:
            sweep = int(b.get('sweepIndex', 0) or 0)
            by_sweep.setdefault(sweep, []).append((float(start), float(end)))
        except (TypeError, ValueError):
            continue
    ibi_s: list[float] = []
    for spans in by_sweep.values():
        spans.sort()
        for (_, e1), (s2, _) in zip(spans, spans[1:]):
            gap = s2 - e1
            if gap >= 0:
                ibi_s.append(gap)

    scalars: dict[str, Optional[float]] = {
        'n_bursts': float(n_bursts),
        'duration_mean_ms': _mean(durations_ms),
        'duration_median_ms': _median(durations_ms),
        'duration_cv': _cv(durations_ms),
        'peak_mean': _mean(peaks),
        'peak_median': _median(peaks),
        'integral_mean': _mean(integrals),
        'rise_mean_ms': _mean(rise_times),
        'decay_mean_ms': _mean(decay_times),
        'intra_burst_freq_mean_hz': _mean(mean_freqs),
        'spikes_per_burst_mean': _mean(n_spikes),
        'ibi_mean_s': _mean(ibi_s),
        'ibi_median_s': _median(ibi_s),
        'ibi_cv': _cv(ibi_s),
    }

    distributions: dict[str, list[float]] = {
        'duration_ms': _clean(durations_ms),
        'peak': _clean(peaks),
        'integral': _clean(integrals),
        'ibi_s': ibi_s,
    }

    meta: dict[str, Any] = {
        'n_bursts_total': n_bursts,
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


# ---------------------------------------------------------------------
# Resistance extractor (Rs / Rin / Cm / τ)
# ---------------------------------------------------------------------

def extract_resistance(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Per-series Rs / Rin / Cm / τ from the Resistance analysis.

    Stored as a single result dict per series (no per-event /
    per-sweep arrays — the resistance analysis collapses a test
    pulse to four scalars). Distributions therefore stay empty.
    """
    scalars: dict[str, Optional[float]] = {
        'rs_mohm': _maybe_float(slice_data.get('rs')),
        'rin_mohm': _maybe_float(slice_data.get('rin')),
        'cm_pf': _maybe_float(slice_data.get('cm')),
        'tau_ms': _maybe_float(slice_data.get('tau')),
        'baseline': _maybe_float(slice_data.get('baseline')),
        'peak_current': _maybe_float(slice_data.get('peak_current')),
        'steady_state_current': _maybe_float(slice_data.get('steady_state_current')),
    }
    meta: dict[str, Any] = {
        'source': slice_data.get('source'),
    }
    return CellExtraction(scalars=scalars, distributions={}, meta=meta)


def _maybe_float(v) -> Optional[float]:
    """Coerce to float, treating missing / NaN as ``None`` so the
    cohort table renders an em-dash instead of ``NaN``."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


# ---------------------------------------------------------------------
# Cursor-suite extractor (Stimfit-style multi-slot measurements)
# ---------------------------------------------------------------------

# Cap the number of cursor slots we expose to the cohort metric tree.
# The store allows up to 10, but in practice nobody uses more than 3-4
# in a comparison; flattening 10×~8 = 80 metrics per cell would make
# the metric picker unusable.
CURSOR_MAX_SLOT_INDEX = 3


def extract_cursors(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Per-slot per-cell summary of cursor-suite measurements.

    Each enabled slot becomes its own family of metrics with a
    ``slot{i}__`` prefix: ``slot0__amp_mean``, ``slot1__amp_sd``, etc.
    Up to ``CURSOR_MAX_SLOT_INDEX`` slots are exposed (slot indices
    beyond that exist in the store but flooding the metric picker
    with 80 slot-prefixed metrics per analysis is a bad UX). The
    cohort UI's role filter (Phase B.5) lets the user pick which slot
    to compare across cells.

    Per-cell distributions: each slot's full per-sweep amplitude
    array (``slot{i}__amp``) so ECDF overlays show within-cell
    sweep-to-sweep variability honestly.
    """
    measurements = slice_data.get('measurements') or []
    slots_cfg = slice_data.get('slots') or []
    trace_unit = slice_data.get('traceUnit') or ''

    # Group measurements by slot index.
    by_slot: dict[int, list[dict]] = {}
    for m in measurements:
        slot = m.get('slot')
        if slot is None:
            continue
        try:
            slot_i = int(slot)
        except (TypeError, ValueError):
            continue
        if slot_i > CURSOR_MAX_SLOT_INDEX:
            continue
        by_slot.setdefault(slot_i, []).append(m)

    scalars: dict[str, Optional[float]] = {}
    distributions: dict[str, list[float]] = {}
    per_slot_meta: dict[str, dict[str, Any]] = {}

    for slot_i, rows in sorted(by_slot.items()):
        prefix = f'slot{slot_i}__'
        amps = [r.get('amplitude') for r in rows]
        baselines = [r.get('baseline') for r in rows]
        peaks = [r.get('peak') for r in rows]
        rises_10_90 = [r.get('rise_time_10_90') for r in rows]
        rises_20_80 = [r.get('rise_time_20_80') for r in rows]
        halfwidths = [r.get('half_width') for r in rows]
        rise_slopes = [r.get('max_slope_rise') for r in rows]
        decay_slopes = [r.get('max_slope_decay') for r in rows]
        ttp = [r.get('time_to_peak') for r in rows]
        areas = [r.get('area') for r in rows]

        scalars[prefix + 'amp_mean'] = _mean(amps)
        scalars[prefix + 'amp_median'] = _median(amps)
        scalars[prefix + 'amp_sd'] = _sd(amps)
        scalars[prefix + 'amp_cv'] = _cv(amps)
        scalars[prefix + 'baseline_mean'] = _mean(baselines)
        scalars[prefix + 'peak_mean'] = _mean(peaks)
        scalars[prefix + 'rise_time_10_90_mean'] = _mean(rises_10_90)
        scalars[prefix + 'rise_time_20_80_mean'] = _mean(rises_20_80)
        scalars[prefix + 'half_width_mean'] = _mean(halfwidths)
        scalars[prefix + 'max_rise_slope_mean'] = _mean(rise_slopes)
        scalars[prefix + 'max_decay_slope_mean'] = _mean(decay_slopes)
        scalars[prefix + 'time_to_peak_mean'] = _mean(ttp)
        scalars[prefix + 'area_mean'] = _mean(areas)

        distributions[prefix + 'amp'] = _clean(amps)
        distributions[prefix + 'baseline'] = _clean(baselines)
        distributions[prefix + 'rise_time_10_90'] = _clean(rises_10_90)
        distributions[prefix + 'half_width'] = _clean(halfwidths)
        distributions[prefix + 'area'] = _clean(areas)

        # Resolve a human-readable slot label from the slot config so
        # the cohort UI can show "slot 0 (baseline EPSC)" rather than
        # bare indices when the user labelled their slots.
        slot_label: Optional[str] = None
        if 0 <= slot_i < len(slots_cfg):
            cfg = slots_cfg[slot_i]
            if isinstance(cfg, dict):
                slot_label = cfg.get('label')

        per_slot_meta[f'slot{slot_i}'] = {
            'n_measurements': len(rows),
            'label': slot_label,
        }

    meta: dict[str, Any] = {
        'n_measurements_total': len(measurements),
        'trace_unit': trace_unit,
        'slots_present': sorted(by_slot.keys()),
        'per_slot': per_slot_meta,
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


# ---------------------------------------------------------------------
# fPSP extractors — one per mode (io / ppr / ltp)
# ---------------------------------------------------------------------
#
# Each fPSP slice carries its own ``mode`` field; the ``analyses.fpsp_curves``
# dict can hold several entries per recording (e.g. an I-O run + a PPR
# run + an LTP run with different series). Expose three cohort
# analysis types so the user picks which mode to compare; the
# aggregator filters slices by mode below.

def extract_fpsp_io(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Input-output curve summary.

    Standard reporting: linear-regression slope of ``slope`` (or
    ``amplitude``, depending on ``ioMetric``) vs stimulus intensity,
    plus the maximum response.
    """
    points = slice_data.get('points') or []
    metric_kind = slice_data.get('ioMetric') or 'slope'
    field = 'slope' if metric_kind == 'slope' else 'fepspAmp'

    pairs: list[tuple[float, float]] = []
    initial = slice_data.get('ioInitialIntensity')
    step = slice_data.get('ioIntensityStep')
    for p in points:
        y = p.get(field)
        if y is None:
            continue
        # Intensity reconstruction: prefer explicit per-point recipe
        # (initial + step * binIndex). Falls back to binIndex when the
        # I-O recipe wasn't recorded so the regression is still
        # meaningful even if the x-axis is just bin numbers.
        bin_idx = p.get('binIndex')
        if initial is not None and step is not None and bin_idx is not None:
            x = float(initial) + float(step) * float(bin_idx)
        elif bin_idx is not None:
            x = float(bin_idx)
        else:
            continue
        try:
            pairs.append((x, float(y)))
        except (TypeError, ValueError):
            continue

    scalars: dict[str, Optional[float]] = {
        'io_slope': None,
        'io_intercept': None,
        'io_max_response': None,
        'io_at_threshold_response': None,
        'n_intensities': float(len(pairs)),
    }

    if len(pairs) >= 2:
        xs = np.array([p[0] for p in pairs], dtype=float)
        ys = np.array([p[1] for p in pairs], dtype=float)
        slope, intercept = np.polyfit(xs, ys, 1)
        scalars['io_slope'] = float(slope)
        scalars['io_intercept'] = float(intercept)
        scalars['io_max_response'] = float(np.max(np.abs(ys)))
        # Response at the lowest intensity that produced a non-zero
        # measurement — a rough "threshold" proxy that doesn't require
        # a saturating-curve fit. Better fits come in a later phase.
        nz = [p for p in pairs if abs(p[1]) > 1e-9]
        if nz:
            nz.sort(key=lambda p: p[0])
            scalars['io_at_threshold_response'] = float(nz[0][1])

    meta: dict[str, Any] = {
        'n_points': len(points),
        'metric_kind': metric_kind,
        'response_unit': slice_data.get('responseUnit'),
        'intensity_unit': slice_data.get('ioUnit'),
        'mode': slice_data.get('mode'),
    }

    return CellExtraction(scalars=scalars, distributions={}, meta=meta)


def extract_fpsp_ppr(slice_data: dict, sidecar: dict) -> CellExtraction:
    """Paired-pulse ratio summary.

    Each ``point`` is one pair of stimuli. ``pprAmp`` and ``pprSlope``
    are the second-pulse / first-pulse ratios. Standard reporting:
    mean PPR + the ISI used.
    """
    points = slice_data.get('points') or []
    metric_kind = (slice_data.get('pprMetric') or 'amplitude').lower()
    # Backend stores ratios on amplitude as ``pprAmp`` and on slope as
    # ``pprSlope``. Pick the one the user analysed against.
    field = 'pprSlope' if metric_kind == 'slope' else 'pprAmp'

    ratios = [p.get(field) for p in points]
    isi_ms = slice_data.get('pprIsiMs')

    scalars: dict[str, Optional[float]] = {
        'ppr_mean': _mean(ratios),
        'ppr_median': _median(ratios),
        'ppr_sd': _sd(ratios),
        'ppr_cv': _cv(ratios),
        'isi_ms': float(isi_ms) if isi_ms is not None else None,
        'n_pairs': float(len(points)),
    }

    distributions: dict[str, list[float]] = {
        'ppr': _clean(ratios),
    }

    meta: dict[str, Any] = {
        'n_points': len(points),
        'metric_kind': metric_kind,
        'mode': slice_data.get('mode'),
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


def extract_fpsp_ltp(slice_data: dict, sidecar: dict) -> CellExtraction:
    """LTP / LTD time-series summary.

    The same fpsp "LTP" module is used for both potentiation and
    depression studies — the figure is identical, only the direction
    of the change differs. The cohort metrics here are therefore
    direction-agnostic and centre on **normalised response** (each
    bin divided by the mean baseline response), which is the unit
    every LTP/LTD figure plots.

    Per-cell outputs:

    * ``baseline_response_mean`` / ``late_response_mean`` — raw
      means in the recording's response units. Reported alongside
      the normalised numbers because reviewers sometimes want the
      absolute values too.
    * ``late_normalized_mean`` — late window mean expressed as a
      fraction of baseline. ``1.0`` = no change, ``1.50`` = 150% of
      baseline (canonical LTP), ``0.70`` = 70% of baseline (LTD).
      **This is the primary cohort scalar** — the per-cell number
      that goes into the dot+SEM plot.
    * ``pct_change_from_baseline`` — same information as a percent
      delta. ``+50`` for LTP, ``-30`` for LTD. Convenience metric
      for users who report deltas instead of fractions.
    * ``response_normalized_timeseries`` distribution — per-cell
      array of (response / mean baseline) per bin, in time order.
      Drives the canonical "% baseline vs. time" group plot in B.6
      (group mean ± SEM line over time, baseline = 1.0 reference).

    The "late" window defaults to the trailing 10 bins (≈ last 5-10
    minutes for the typical 30-60 s bin); user-defined windows come
    in B.5. The baseline window comes from ``normBaselineFrom`` /
    ``normBaselineTo`` (1-based bin indices) the user already set in
    the LTP analysis window — that field exists precisely so this
    extractor doesn't have to guess.

    The response field follows the user's ``measurementMethod``:
    slope-based recipes use ``points[i].slope``, amplitude-based
    recipes use ``points[i].fepspAmp``. Normalisation is computed on
    the magnitude (``|response|``) so the sign of the slope (negative
    for downward-going fEPSPs) doesn't flip the direction of the
    reported change.
    """
    points = slice_data.get('points') or []
    n_bins = len(points)

    # Pick the response metric the user analysed against. PPR /
    # fpsp_ltp share the same point dict shape — ``slope`` for both
    # slope-based recipes, ``fepspAmp`` for the amplitude recipe.
    method = (slice_data.get('measurementMethod') or 'full_slope').lower()
    if method == 'amplitude':
        metric_field = 'fepspAmp'
        metric_label = 'amplitude'
    else:
        metric_field = 'slope'
        metric_label = 'slope'

    # Baseline window from the user's normalisation settings (1-based,
    # inclusive in the UI). Convert to 0-based slice. Falls back to
    # "first 10 bins" when the user didn't set one.
    bf = slice_data.get('normBaselineFrom')
    bt = slice_data.get('normBaselineTo')
    if bf is not None and bt is not None and n_bins > 0:
        baseline_lo = max(0, int(bf) - 1)
        baseline_hi = min(n_bins, int(bt))
    else:
        baseline_lo = 0
        baseline_hi = min(10, n_bins)

    # Late window: trailing 10 bins. Excludes the baseline window
    # so a too-short post-induction series doesn't double-count.
    late_n = 10
    late_lo = max(baseline_hi, n_bins - late_n)
    late_hi = n_bins

    series_vals_raw = [p.get(metric_field) for p in points]
    # Magnitude series used for normalisation so the sign of the
    # underlying slope doesn't matter — works for fEPSPs (negative
    # slope) and depolarising responses (positive slope) alike.
    series_mag = [abs(v) if v is not None else None for v in series_vals_raw]

    baseline_mag = [v for v in series_mag[baseline_lo:baseline_hi] if v is not None]
    late_mag = [v for v in series_mag[late_lo:late_hi] if v is not None]

    baseline_response_mean = _mean(baseline_mag)
    late_response_mean = _mean(late_mag)

    # Per-bin normalisation: each bin's |response| / mean baseline
    # |response|. The canonical LTP/LTD time-series — group mean ±
    # SEM of this curve is the standard figure.
    response_normalized: list[float] = []
    if baseline_response_mean is not None and abs(baseline_response_mean) > 1e-12:
        for v in series_mag:
            if v is None:
                continue
            response_normalized.append(v / baseline_response_mean)

    late_normalized_mean: Optional[float] = None
    if (baseline_response_mean is not None
            and late_response_mean is not None
            and abs(baseline_response_mean) > 1e-12):
        late_normalized_mean = late_response_mean / baseline_response_mean

    pct_change_from_baseline: Optional[float] = None
    if late_normalized_mean is not None:
        # Equivalent to ``(|late| - |baseline|) / |baseline| * 100``.
        # +50 = potentiated 50%; -30 = depressed 30%. Direction-
        # agnostic so the same metric serves LTP and LTD studies.
        pct_change_from_baseline = (late_normalized_mean - 1.0) * 100.0

    scalars: dict[str, Optional[float]] = {
        # Primary cohort metric — fraction of baseline.
        'late_normalized_mean': late_normalized_mean,
        # Same information as a percent delta; convenience.
        'pct_change_from_baseline': pct_change_from_baseline,
        # Raw means for users who report absolute numbers too.
        'baseline_response_mean': baseline_response_mean,
        'late_response_mean': late_response_mean,
        'n_baseline_bins': float(len(baseline_mag)),
        'n_late_bins': float(len(late_mag)),
        'n_total_bins': float(n_bins),
    }

    # Two distributions:
    #   * ``response_normalized_timeseries`` — per-bin × baseline
    #     (the actual quantity plotted in every LTP/LTD figure).
    #     Tagged as a time series in ``meta.distribution_kinds`` so
    #     B.6 picks a line-over-time plot, not an ECDF.
    #   * ``response_raw_timeseries`` — same series in raw units, in
    #     case downstream wants the unnormalised view.
    distributions: dict[str, list[float]] = {
        'response_normalized_timeseries': response_normalized,
        'response_raw_timeseries': _clean(series_vals_raw),
    }

    meta: dict[str, Any] = {
        'n_bins': n_bins,
        'baseline_window_bins': [baseline_lo + 1, baseline_hi],
        'late_window_bins': [late_lo + 1, late_hi],
        'response_unit': slice_data.get('responseUnit'),
        'measurement_method': method,
        'metric_label': metric_label,
        'mode': slice_data.get('mode'),
        # Per-distribution plot-kind hint for the cohort UI.
        # ``timeseries`` → group line ± SEM vs. time.
        # ``samples``    → per-cell ECDF overlay (default).
        'distribution_kinds': {
            'response_normalized_timeseries': 'timeseries',
            'response_raw_timeseries': 'timeseries',
        },
        'distribution_counts': {k: len(v) for k, v in distributions.items()},
    }

    return CellExtraction(scalars=scalars, distributions=distributions, meta=meta)


# ---------------------------------------------------------------------
# Registry — analysis_type → extractor
# ---------------------------------------------------------------------

EXTRACTORS: dict[str, ExtractorFn] = {
    'events': extract_events,
    'ap': extract_ap,
    'iv_curves': extract_iv,
    'bursts': extract_bursts,
    'cursors': extract_cursors,
    'resistance': extract_resistance,
    # fPSP exposes three cohort analysis types because the three modes
    # (I-O, PPR, LTP) are different experiments with different metric
    # vocabularies — bundling them would force the metric tree to
    # show metrics that don't apply to whichever mode the user chose.
    'fpsp_io': extract_fpsp_io,
    'fpsp_ppr': extract_fpsp_ppr,
    'fpsp_ltp': extract_fpsp_ltp,
}


# Cohort analysis_type → which key under ``sidecar.analyses`` to look up.
# Identity for most; cursor and fpsp_* alias to the underlying sidecar
# slice. The ``MODE_FILTER`` table below trims fpsp slices by mode.
SIDECAR_KEY: dict[str, str] = {
    'events': 'events',
    'ap': 'ap',
    'iv_curves': 'iv_curves',
    'bursts': 'bursts',
    'cursors': 'cursor_analyses',
    'resistance': 'resistance',
    'fpsp_io': 'fpsp_curves',
    'fpsp_ppr': 'fpsp_curves',
    'fpsp_ltp': 'fpsp_curves',
}


# When set, only fpsp slices whose ``mode`` matches this value
# contribute. Lets the same ``fpsp_curves`` dict feed three cohort
# analysis types without the extractors having to discard wrong-mode
# slices themselves.
MODE_FILTER: dict[str, str] = {
    'fpsp_io': 'io',
    'fpsp_ppr': 'ppr',
    'fpsp_ltp': 'ltp',
}


# Curated default-checked metrics per analysis (drives the metric
# tree's pre-selection in Phase B.5). Everything else is one click
# away in the same tree.
DEFAULT_METRICS: dict[str, dict[str, list[str]]] = {
    'events': {
        'scalars': [
            'freq_hz', 'iei_mean_ms', 'iei_median_ms',
            'amp_mean', 'amp_median',
            'rise_mean_ms', 'decay_mean_ms', 'tau_decay_mean_ms',
        ],
        'distributions': ['iei_ms', 'amp'],
    },
    'ap': {
        'scalars': [
            'rheobase_pa', 'threshold_mean_mv', 'ap_amp_mean_mv',
            'fwhm_mean_ms', 'fi_slope_hz_per_pa', 'max_rate_hz',
        ],
        'distributions': [],
    },
    'iv_curves': {
        'scalars': ['iv_slope', 'reversal_potential', 'sag_amp_mean'],
        'distributions': [],
    },
    'bursts': {
        'scalars': [
            'n_bursts', 'duration_mean_ms', 'peak_mean', 'ibi_mean_s',
        ],
        'distributions': ['ibi_s'],
    },
    'resistance': {
        'scalars': ['rs_mohm', 'rin_mohm', 'cm_pf', 'tau_ms'],
        'distributions': [],
    },
    'cursors': {
        # Curated: just slot 0's standard kinetics. Users with more
        # slots tick the rest in the metric tree as needed — don't
        # pre-check 80 metrics across 3 slots by default.
        'scalars': [
            'slot0__amp_mean', 'slot0__rise_time_10_90_mean',
            'slot0__half_width_mean', 'slot0__max_decay_slope_mean',
        ],
        'distributions': ['slot0__amp'],
    },
    'fpsp_io': {
        'scalars': ['io_slope', 'io_max_response'],
        'distributions': [],
    },
    'fpsp_ppr': {
        'scalars': ['ppr_mean', 'ppr_median', 'isi_ms'],
        'distributions': ['ppr'],
    },
    'fpsp_ltp': {
        # ``late_normalized_mean`` is the canonical per-cell scalar
        # ("X.XX of baseline"); ``pct_change_from_baseline`` is the
        # same in delta form. Both pre-checked because reviewers
        # often ask for both. Raw means available, not pre-checked.
        'scalars': ['late_normalized_mean', 'pct_change_from_baseline'],
        # The normalised time series IS the LTP figure — pre-checked
        # so the canonical "% baseline vs. time" line plot appears
        # in B.6 by default.
        'distributions': ['response_normalized_timeseries'],
    },
}


# ---------------------------------------------------------------------
# Folder walker + per-cell aggregator
# ---------------------------------------------------------------------

def _list_sidecars(folder: Path) -> list[Path]:
    """Return sorted absolute paths to ``.neurotrace`` sidecars next to
    every recording-shaped file in ``folder``. Files without sidecars
    are skipped — they can't have been tagged."""
    out: list[Path] = []
    if not folder.exists() or not folder.is_dir():
        return out
    for entry in sorted(folder.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in RECORDING_EXTS:
            continue
        sidecar = entry.with_name(entry.name + '.neurotrace')
        if sidecar.exists():
            out.append(sidecar)
    return out


def _load_sidecar(path: Path) -> Optional[dict]:
    """Read + parse a sidecar. Returns ``None`` on any IO / JSON error
    so the caller can record the file as a soft failure rather than
    aborting the whole cohort scan."""
    try:
        with path.open('r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get('format') != 'neurotrace-sidecar':
        return None
    return data


def aggregate_folder(
    folder: str,
    analysis_type: str,
    file_filter: Optional[list[str]] = None,
    series_filter: Optional[dict[str, list[str]]] = None,
) -> dict:
    """Walk ``folder`` and extract per-cell metrics for ``analysis_type``.

    Parameters
    ----------
    folder
        Absolute path to a directory containing ``.neurotrace`` files.
    analysis_type
        One of :data:`EXTRACTORS` keys.
    file_filter
        Optional allow-list of recording file paths. When given, only
        sidecars next to those files contribute. Used by the cohort UI
        to honor per-file checkbox selection.
    series_filter
        Optional ``{recording_path: [series_key, …]}`` map. When set
        for a given recording, only those ``"{group}:{series}"`` keys
        contribute. Lets the user trim multi-series recordings.

    Returns
    -------
    dict
        Self-describing payload — see top of file for the JSON shape.
        ``cells`` is the per-cell data; ``errors`` /
        ``skipped_no_meta`` / ``skipped_no_analysis`` surface why
        files were dropped so the cohort UI can show actionable
        warnings.
    """
    if analysis_type not in EXTRACTORS:
        raise ValueError(
            f"Unknown analysis type: {analysis_type!r}. "
            f"Known: {sorted(EXTRACTORS)}"
        )
    extractor = EXTRACTORS[analysis_type]
    sidecar_key = SIDECAR_KEY.get(analysis_type, analysis_type)
    mode_filter = MODE_FILTER.get(analysis_type)

    folder_path = Path(folder).expanduser().resolve()
    sidecars = _list_sidecars(folder_path)
    file_filter_set = set(file_filter) if file_filter else None

    cells: list[dict] = []
    errors: list[dict] = []
    skipped_no_meta: list[dict] = []
    skipped_no_analysis: list[dict] = []

    for sidecar_path in sidecars:
        # Recording path = sidecar path with the ``.neurotrace`` suffix
        # stripped (sidecars are named ``recording.dat.neurotrace``).
        recording_path = str(sidecar_path)[: -len('.neurotrace')]
        if file_filter_set is not None and recording_path not in file_filter_set:
            continue
        sidecar = _load_sidecar(sidecar_path)
        if sidecar is None:
            errors.append({
                'file_path': recording_path,
                'reason': 'parse_error',
            })
            continue
        meta = sidecar.get('meta') or {}
        group_tags = list(meta.get('group_tags') or [])
        series_tags = dict(meta.get('series_tags') or {})
        cell_id = meta.get('cell_id')

        if not group_tags:
            # Cohort comparisons are tag-driven — a file with no
            # file-level tags can't be assigned to any group. Record
            # so the UI can surface the path and the user can fix it.
            skipped_no_meta.append({
                'file_path': recording_path,
                'file_name': os.path.basename(recording_path),
            })
            continue

        analyses = sidecar.get('analyses') or {}
        slices = analyses.get(sidecar_key) or {}
        # When a mode filter is active (e.g. cohort type ``fpsp_ppr``
        # only wants ``ppr`` slices), trim before the empty check so a
        # cell with only an LTP slice gets reported under
        # ``skipped_no_analysis`` for the PPR cohort instead of
        # silently contributing nothing.
        if mode_filter is not None:
            slices = {
                k: v for k, v in slices.items()
                if (v.get('mode') or '').lower() == mode_filter
            }
        if not slices:
            skipped_no_analysis.append({
                'file_path': recording_path,
                'file_name': os.path.basename(recording_path),
            })
            continue

        per_file_series_filter = (series_filter or {}).get(recording_path)

        for series_key, slice_data in slices.items():
            if per_file_series_filter is not None \
                    and series_key not in per_file_series_filter:
                continue
            try:
                extraction = extractor(slice_data, sidecar)
            except Exception as exc:  # noqa: BLE001 — surface, don't crash the whole scan
                errors.append({
                    'file_path': recording_path,
                    'series_key': series_key,
                    'reason': f'extractor_error: {type(exc).__name__}: {exc}',
                })
                continue

            cells.append({
                'file_path': recording_path,
                'file_name': os.path.basename(recording_path),
                'cell_id': cell_id,
                'group_tags': list(group_tags),
                # Carry the full series_tags map so downstream code can
                # do its own per-series tag filtering for distribution
                # plots that compare e.g. ``baseline`` vs ``treatment``
                # within the same cell.
                'series_tags': dict(series_tags),
                'series_key': series_key,
                'series_specific_tags': list(series_tags.get(series_key) or []),
                'scalars': extraction.scalars,
                'distributions': extraction.distributions,
                'meta': extraction.meta,
            })

    return {
        'analysis_type': analysis_type,
        'folder': str(folder_path),
        'cells': cells,
        'errors': errors,
        'skipped_no_meta': skipped_no_meta,
        'skipped_no_analysis': skipped_no_analysis,
        'summary': {
            'n_cells': len(cells),
            'n_files_scanned': len(sidecars),
            'n_files_filtered_out': (
                len(sidecars) - len(file_filter_set)
                if file_filter_set is not None
                else 0
            ),
        },
    }


def list_supported_analyses() -> list[str]:
    """Public list of analysis types the cohort module knows how to
    aggregate. Drives the wizard's analysis-type dropdown."""
    return sorted(EXTRACTORS)
