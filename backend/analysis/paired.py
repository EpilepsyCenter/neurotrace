"""Paired-recording analysis — pre/post synaptic trial extraction + stats.

Given a pre channel that carries action potentials (or stim-artifact /
TTL trigger pulses) and a post channel that carries the evoked PSP /
PSC, produce per-trial measurements (amplitude, latency, success vs
failure, baseline stats, optional rise/decay) and per-series release
statistics (failure rate, mean amplitude, potency, CV, 1/CV², latency
jitter, paired-pulse ratio) plus a spike-triggered average of the post
channel.

Pre-event detection has four modes:

- ``ap``     — reuse :func:`analysis.ap._detect_spikes_sweep` for
               current-clamp pre-recordings.
- ``stim``   — |d/dt| threshold for biphasic / capacitive artifacts.
               Polarity-agnostic; the anchor is the FIRST threshold
               crossing of each artifact group (so it tracks command
               onset, not the rebound).
- ``ttl``    — level threshold + edge detection for square external
               stimulator triggers. Debounces by ``min_pulse_ms``.
- ``manual`` — user-supplied timestamps only.

Per trial, given an anchor time ``t_pre``:
    baseline window = [t_pre - pre_ms - baseline_ms, t_pre - pre_ms]
    post     window = [t_pre, t_pre + post_ms]   (truncated when the
                       next pre event lands inside, with a 0.2 ms guard)

Failure threshold: k·SD of the per-trial baseline (default k=3) OR an
absolute amplitude in physical units. Trials below threshold get
``success=False`` with their measured amplitude PRESERVED (not zeroed)
so the histogram in the Statistics tab shows where the boundary sits.

Latency: time from ``t_pre`` to where the post signal reaches a
fraction of its peak (default 20 %). Onset-by-d²V/dt² is implemented
as an alternative rule for sharp signals with clean rising flanks.

All public-domain math; no copyleft code ported.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from analysis.ap import _Spike, _detect_spikes_sweep, _apply_manual_edits_to_sweep
from analysis.bursts import _apply_pre_detection_filter


# ---------------------------------------------------------------------------
# Pre-event detection — three programmatic modes
# ---------------------------------------------------------------------------

def _detect_stim_artifacts(
    sig: np.ndarray, sr: float,
    *,
    dvdt_threshold: float,
    min_distance_ms: float,
    bounds_start_s: float,
    bounds_end_s: float,
) -> list[int]:
    """Return sample indices of stim-artifact onsets.

    Operates on |d/dt|, so detection is polarity-agnostic. We pick the
    first crossing of each contiguous run above threshold (rising edge
    of the abs-derivative gate). ``min_distance_ms`` merges adjacent
    detections — the artifact's rebound or a bipolar second phase
    typically falls within a few hundred microseconds, so the merge
    leaves one anchor per artifact.
    """
    if sig.size < 2 or sr <= 0:
        return []
    i0 = max(0, int(round(bounds_start_s * sr)))
    i1 = min(sig.size, int(round(bounds_end_s * sr))) if bounds_end_s > 0 else sig.size
    if i1 <= i0 + 2:
        return []
    seg = sig[i0:i1]
    # |d/dt| in (units / second). Caller picks dvdt_threshold in the
    # same unit per second — for an Im stim-monitor in pA it'd be pA/s.
    dvdt = np.abs(np.gradient(seg) * sr)
    above = dvdt >= dvdt_threshold
    if not above.any():
        return []
    rising = np.flatnonzero(above[1:] & ~above[:-1]) + 1
    if above[0]:
        rising = np.r_[0, rising]
    # Merge by min_distance_ms.
    if rising.size <= 1:
        return [int(i0 + r) for r in rising]
    min_dist = max(1, int(round(min_distance_ms / 1000.0 * sr)))
    merged: list[int] = [int(rising[0])]
    for r in rising[1:]:
        if int(r) - merged[-1] >= min_dist:
            merged.append(int(r))
    return [int(i0 + r) for r in merged]


def _detect_ttl_edges(
    sig: np.ndarray, sr: float,
    *,
    level_threshold: Optional[float],
    edge: str,                  # 'rising' | 'falling' | 'both'
    min_pulse_ms: float,
    bounds_start_s: float,
    bounds_end_s: float,
) -> list[int]:
    """Return sample indices of TTL pulse edges.

    ``level_threshold`` defaults to the midway point between sweep
    min and max when None — robust for unknown TTL voltages (5 V, 3.3 V,
    etc.) without the caller having to look it up. Edges are detected
    via ``np.diff((x > level).astype(int8))``: ``+1`` = rising,
    ``-1`` = falling. The ``min_pulse_ms`` debounce drops crossings
    closer than the threshold to the previously accepted edge.
    """
    if sig.size < 2 or sr <= 0:
        return []
    i0 = max(0, int(round(bounds_start_s * sr)))
    i1 = min(sig.size, int(round(bounds_end_s * sr))) if bounds_end_s > 0 else sig.size
    if i1 <= i0 + 2:
        return []
    seg = sig[i0:i1]
    if level_threshold is None:
        smin, smax = float(np.min(seg)), float(np.max(seg))
        # If the channel is essentially flat, no TTL pulses.
        if smax - smin < 1e-9:
            return []
        level = (smin + smax) / 2.0
    else:
        level = float(level_threshold)
    above = (seg > level).astype(np.int8)
    diffs = np.diff(above)
    if edge == "rising":
        crossings = np.flatnonzero(diffs == 1) + 1
    elif edge == "falling":
        crossings = np.flatnonzero(diffs == -1) + 1
    elif edge == "both":
        crossings = np.flatnonzero(diffs != 0) + 1
    else:
        raise ValueError(f"Unknown edge: {edge!r}")
    if crossings.size == 0:
        return []
    # Debounce.
    min_dist = max(1, int(round(min_pulse_ms / 1000.0 * sr)))
    accepted: list[int] = [int(crossings[0])]
    for c in crossings[1:]:
        if int(c) - accepted[-1] >= min_dist:
            accepted.append(int(c))
    return [int(i0 + a) for a in accepted]


def _apply_manual_anchor_edits(
    anchors: list[int], sr: float,
    added_t_s: list[float], removed_t_s: list[float],
    min_distance_ms: float,
) -> list[int]:
    """Replay manual additions/removals on top of an auto-detected
    anchor list. Same tolerance semantics as
    :func:`analysis.ap._apply_manual_edits_to_sweep` but operates on
    raw sample indices rather than ``_Spike`` objects."""
    tol = max(1, int(round(min_distance_ms / 1000.0 * sr)))
    if removed_t_s:
        removed_idx = [int(round(t * sr)) for t in removed_t_s]
        anchors = [a for a in anchors
                   if not any(abs(a - r) <= tol for r in removed_idx)]
    for t in added_t_s:
        click_idx = int(round(t * sr))
        if any(abs(click_idx - a) <= tol for a in anchors):
            continue
        anchors.append(click_idx)
    anchors.sort()
    return anchors


# ---------------------------------------------------------------------------
# Per-trial measurement
# ---------------------------------------------------------------------------

@dataclass
class _Trial:
    sweep: int
    trial_idx: int
    pre_t_s: float
    pre_amp: float
    baseline_mean: float
    baseline_sd: float
    post_peak: float
    post_peak_t_s: float
    amplitude: float           # signed: post_peak - baseline_mean
    success: bool
    latency_s: Optional[float]
    rise_ms: Optional[float]   # 10–90 % rise on successes only
    decay_ms: Optional[float]  # 90–10 % decay on successes only
    truncated: bool
    manual: bool = False


def _measure_trial(
    post: np.ndarray, sr: float,
    *,
    pre_idx: int,
    pre_amp: float,
    pre_ms: float,
    post_ms: float,
    baseline_ms: float,
    next_pre_idx: Optional[int],
    peak_direction: str,        # 'auto' | 'positive' | 'negative'
    failure_rule: str,          # 'k_sd' | 'absolute'
    failure_k_sd: float,
    failure_absolute: float,
    latency_rule: str,          # 'fraction' | 'onset_d2'
    latency_fraction: float,
    sweep: int,
    trial_idx: int,
    manual: bool,
    # Optional absolute-time clip on the peak-search window. When
    # both are >0 and post_search_end_s > post_search_start_s, the
    # per-trial post window is intersected with [a, b], so peaks
    # outside the user's drag-cursors aren't considered. ``None`` /
    # zero means "no clip" — fall back to ``post_ms`` only.
    post_search_start_s: Optional[float] = None,
    post_search_end_s: Optional[float] = None,
) -> _Trial:
    """Measure one trial on the post channel."""
    n = post.size
    pre_samples = max(1, int(round(pre_ms / 1000.0 * sr)))
    post_samples = max(1, int(round(post_ms / 1000.0 * sr)))
    bl_samples = max(1, int(round(baseline_ms / 1000.0 * sr)))

    bl_a = max(0, pre_idx - pre_samples - bl_samples)
    bl_b = max(bl_a + 1, pre_idx - pre_samples)
    post_a = max(0, pre_idx)
    post_b = min(n, pre_idx + post_samples)

    # Apply absolute-time post-search clip when set.
    if (post_search_start_s is not None and post_search_end_s is not None
            and post_search_end_s > post_search_start_s):
        clip_a = int(round(post_search_start_s * sr))
        clip_b = int(round(post_search_end_s * sr))
        post_a = max(post_a, clip_a)
        post_b = min(post_b, clip_b)

    truncated = False
    if next_pre_idx is not None and next_pre_idx > pre_idx:
        guard = max(1, int(round(0.0002 * sr)))   # 0.2 ms guard
        post_b = min(post_b, next_pre_idx - guard)
        if post_b <= post_a + 1:
            post_b = min(n, post_a + 2)
        truncated = post_b < min(n, pre_idx + post_samples)

    bl_segment = post[bl_a:bl_b] if bl_b > bl_a else post[max(0, pre_idx - 1):pre_idx]
    if bl_segment.size == 0:
        baseline_mean = float(post[max(0, pre_idx - 1)])
        baseline_sd = 0.0
    else:
        baseline_mean = float(np.mean(bl_segment))
        baseline_sd = float(np.std(bl_segment, ddof=0))

    post_segment = post[post_a:post_b]
    if post_segment.size == 0:
        return _Trial(
            sweep=sweep, trial_idx=trial_idx,
            pre_t_s=float(pre_idx / sr), pre_amp=float(pre_amp),
            baseline_mean=baseline_mean, baseline_sd=baseline_sd,
            post_peak=float("nan"), post_peak_t_s=float("nan"),
            amplitude=float("nan"), success=False,
            latency_s=None, rise_ms=None, decay_ms=None,
            truncated=truncated, manual=manual,
        )

    # Peak: choose extremum side from peak_direction, or auto-pick
    # whichever has the larger excursion from baseline_mean.
    centered = post_segment - baseline_mean
    if peak_direction == "positive":
        rel_peak = int(np.argmax(centered))
    elif peak_direction == "negative":
        rel_peak = int(np.argmin(centered))
    else:  # auto
        i_pos = int(np.argmax(centered))
        i_neg = int(np.argmin(centered))
        rel_peak = i_pos if abs(centered[i_pos]) >= abs(centered[i_neg]) else i_neg
    peak_idx_abs = post_a + rel_peak
    post_peak = float(post[peak_idx_abs])
    amplitude = post_peak - baseline_mean

    # Failure classification.
    if failure_rule == "absolute":
        threshold_abs = abs(failure_absolute)
    else:  # 'k_sd'
        threshold_abs = failure_k_sd * baseline_sd
    success = abs(amplitude) >= threshold_abs and threshold_abs > 0

    # Latency — only meaningful when the trial is a success.
    latency_s: Optional[float] = None
    rise_ms: Optional[float] = None
    decay_ms: Optional[float] = None
    if success and rel_peak > 0:
        target = baseline_mean + latency_fraction * amplitude
        rising = post_segment[:rel_peak + 1]
        if latency_rule == "onset_d2":
            # Argmax of d²/dt² on the rising flank — robust to slow
            # baseline drift, fragile to sample noise. Caller knows.
            if rising.size >= 4:
                d2 = np.diff(rising, n=2)
                latency_idx = int(np.argmax(np.abs(d2))) + 1
            else:
                latency_idx = 0
        else:  # 'fraction'
            # First sample on the rise that has crossed `target`.
            if amplitude >= 0:
                crossed = rising >= target
            else:
                crossed = rising <= target
            idxs = np.flatnonzero(crossed)
            latency_idx = int(idxs[0]) if idxs.size else 0
        latency_s = float((post_a + latency_idx - pre_idx) / sr)

        # 10–90 rise, 90–10 decay on the post window. Compute against
        # baseline_mean and the peak; clamp to NaN-able when the segment
        # doesn't contain both crossings.
        rise_ms = _percent_crossing_ms(
            rising, baseline_mean, post_peak, sr,
            low_pct=0.10, high_pct=0.90,
        )
        falling = post_segment[rel_peak:]
        decay_ms = _percent_crossing_ms(
            falling, post_peak, baseline_mean, sr,
            low_pct=0.90, high_pct=0.10,   # inverted: from peak back toward baseline
        )

    return _Trial(
        sweep=sweep, trial_idx=trial_idx,
        pre_t_s=float(pre_idx / sr), pre_amp=float(pre_amp),
        baseline_mean=baseline_mean, baseline_sd=baseline_sd,
        post_peak=post_peak, post_peak_t_s=float(peak_idx_abs / sr),
        amplitude=amplitude, success=bool(success),
        latency_s=latency_s, rise_ms=rise_ms, decay_ms=decay_ms,
        truncated=truncated, manual=manual,
    )


def _percent_crossing_ms(
    seg: np.ndarray, start_val: float, end_val: float, sr: float,
    *, low_pct: float, high_pct: float,
) -> Optional[float]:
    """Time in ms between two amplitude-fraction crossings.

    Used for both rise (low → high) on the rising edge and decay (high
    → low) on the falling edge. Returns None when either crossing is
    missing from the segment.
    """
    if seg.size < 2:
        return None
    span = end_val - start_val
    if span == 0:
        return None
    # Frame the targets so that lower comes BEFORE upper in the segment
    # for both rising (start<end) and falling (start>end) cases.
    t_low = start_val + low_pct * span
    t_high = start_val + high_pct * span
    if span > 0:
        cross_low = np.flatnonzero(seg >= t_low)
        cross_high = np.flatnonzero(seg >= t_high)
    else:
        cross_low = np.flatnonzero(seg <= t_low)
        cross_high = np.flatnonzero(seg <= t_high)
    if cross_low.size == 0 or cross_high.size == 0:
        return None
    i_low = int(cross_low[0])
    i_high = int(cross_high[0])
    if i_high <= i_low:
        return None
    return float((i_high - i_low) / sr * 1000.0)


# ---------------------------------------------------------------------------
# Summary stats
# ---------------------------------------------------------------------------

def _series_summary(trials: list[_Trial]) -> dict:
    n_trials = len(trials)
    successes = [t for t in trials if t.success]
    failures = [t for t in trials if not t.success]
    n_success = len(successes)
    n_failures = len(failures)

    amps_all = np.array([t.amplitude for t in trials], dtype=float) if trials else np.zeros(0)
    amps_success = np.array([t.amplitude for t in successes], dtype=float) if successes else np.zeros(0)

    failure_rate = (n_failures / n_trials) if n_trials else None
    mean_amplitude = float(np.mean(amps_all)) if amps_all.size else None
    # "Failures-as-zero" convention used by some labs — exposed alongside
    # the natural mean so the user can pick the one they cite.
    amps_all_zeroed = np.array(
        [t.amplitude if t.success else 0.0 for t in trials], dtype=float,
    ) if trials else np.zeros(0)
    mean_amplitude_zeroed = float(np.mean(amps_all_zeroed)) if amps_all_zeroed.size else None
    potency = float(np.mean(amps_success)) if amps_success.size else None

    cv_success: Optional[float] = None
    inv_cv2: Optional[float] = None
    if amps_success.size >= 2 and potency not in (None, 0.0):
        sd = float(np.std(amps_success, ddof=1))
        if potency != 0.0:
            cv_success = sd / abs(potency)
            if cv_success and cv_success != 0.0:
                inv_cv2 = 1.0 / (cv_success ** 2)

    lat_arr = np.array(
        [t.latency_s for t in successes if t.latency_s is not None],
        dtype=float,
    )
    latency_mean_ms = float(np.mean(lat_arr) * 1000.0) if lat_arr.size else None
    latency_sd_ms = float(np.std(lat_arr, ddof=1) * 1000.0) if lat_arr.size >= 2 else None

    # PPR pulse_n / pulse_1 — convention: only sweeps where pulse_1 is
    # a SUCCESS contribute. Sweeps where pulse_1 fails are excluded
    # because PPR otherwise blows up. This is configurable in the
    # /run request via ``ppr_include_pulse1_failures``; default False.
    ppr_n_1: list[dict] = []
    by_sweep: dict[int, list[_Trial]] = {}
    for t in trials:
        by_sweep.setdefault(t.sweep, []).append(t)
    # Stable order by sweep number.
    max_pulses = max((len(v) for v in by_sweep.values()), default=0)
    for n in range(2, max_pulses + 1):
        ratios: list[float] = []
        for sw, tr_list in by_sweep.items():
            if len(tr_list) < n:
                continue
            tr_list_sorted = sorted(tr_list, key=lambda t: t.pre_t_s)
            t1 = tr_list_sorted[0]
            tn = tr_list_sorted[n - 1]
            if not t1.success or t1.amplitude == 0.0:
                continue
            ratios.append(tn.amplitude / t1.amplitude)
        if ratios:
            ppr_n_1.append({"n": n, "ratio": float(np.mean(ratios)), "n_sweeps": len(ratios)})

    return {
        "n_trials": int(n_trials),
        "n_success": int(n_success),
        "n_failures": int(n_failures),
        "failure_rate": failure_rate,
        "mean_amplitude": mean_amplitude,
        "mean_amplitude_zeroed": mean_amplitude_zeroed,
        "potency": potency,
        "cv_success": cv_success,
        "inv_cv2": inv_cv2,
        "latency_mean_ms": latency_mean_ms,
        "latency_sd_ms": latency_sd_ms,
        "ppr_n1": ppr_n_1,
    }


# ---------------------------------------------------------------------------
# Spike-triggered average
# ---------------------------------------------------------------------------

def _compute_sta(
    sweeps_post: list[np.ndarray], sr: float,
    trials: list[_Trial],
    *,
    pre_ms: float, post_ms: float,
    sweep_index_lookup: dict[int, int],
    successes_only: bool = False,
    failures_only: bool = False,
) -> Optional[dict]:
    """Spike-triggered average of the post channel.

    Aligns each trial's window to ``t_pre = 0`` on a common grid and
    averages. Returns dict with ``time``, ``mean``, ``sem``, ``n``.
    Returns None when no trial qualifies.
    """
    if successes_only and failures_only:
        raise ValueError("successes_only and failures_only are mutually exclusive")
    pre_samples = max(1, int(round(pre_ms / 1000.0 * sr)))
    post_samples = max(1, int(round(post_ms / 1000.0 * sr)))
    n_total = pre_samples + post_samples + 1

    stack: list[np.ndarray] = []
    for t in trials:
        if successes_only and not t.success:
            continue
        if failures_only and t.success:
            continue
        sweep_pos = sweep_index_lookup.get(t.sweep)
        if sweep_pos is None or sweep_pos >= len(sweeps_post):
            continue
        post = sweeps_post[sweep_pos]
        anchor = int(round(t.pre_t_s * sr))
        a = anchor - pre_samples
        b = anchor + post_samples + 1
        if a < 0 or b > post.size:
            # Pad with NaN so partial windows don't bias the mean.
            seg = np.full(n_total, np.nan, dtype=float)
            src_a = max(0, a); src_b = min(post.size, b)
            dst_a = src_a - a; dst_b = dst_a + (src_b - src_a)
            seg[dst_a:dst_b] = post[src_a:src_b]
        else:
            seg = post[a:b].astype(float, copy=False)
        stack.append(seg)
    if not stack:
        return None
    mat = np.vstack(stack)
    # nanmean / nanstd handle padded windows.
    n_per_sample = np.sum(~np.isnan(mat), axis=0)
    mean = np.nanmean(mat, axis=0)
    sd = np.nanstd(mat, axis=0, ddof=1) if mat.shape[0] >= 2 else np.zeros_like(mean)
    with np.errstate(divide="ignore", invalid="ignore"):
        sem = np.where(n_per_sample > 1, sd / np.sqrt(n_per_sample), 0.0)
    time_axis = (np.arange(n_total, dtype=float) - pre_samples) / sr
    return {
        "time": time_axis.tolist(),
        "mean": np.where(np.isnan(mean), 0.0, mean).tolist(),
        "sem": np.where(np.isnan(sem), 0.0, sem).tolist(),
        "n": int(mat.shape[0]),
    }


# ---------------------------------------------------------------------------
# Top-level pipeline
# ---------------------------------------------------------------------------

def run_paired(
    *,
    sweeps_pre: list[np.ndarray],
    sweeps_post: list[np.ndarray],
    sweep_indices: list[int],
    sr: float,
    pre_mode: str,                             # 'ap' | 'stim' | 'ttl' | 'manual'
    pre_params: dict,                          # mode-specific detection params
    post_params: dict,                         # pre_ms, post_ms, baseline_ms, peak_direction, filter_*
    failure_params: dict,                      # rule, k_sd, absolute
    latency_params: dict,                      # rule, fraction
    manual_edits: Optional[dict] = None,       # {added: {sweep: [t_s,...]}, removed: {...}}
) -> dict:
    """Run the full paired pipeline. Returns a dict with
    ``per_trial``, ``per_sweep_summary``, ``series_summary``,
    ``sta_all`` / ``sta_success`` / ``sta_failure``.
    """
    if len(sweeps_pre) != len(sweeps_post) or len(sweeps_pre) != len(sweep_indices):
        raise ValueError("sweeps_pre, sweeps_post, sweep_indices must have equal length")

    pre_ms = float(post_params.get("pre_ms", 1.0))
    post_ms = float(post_params.get("post_ms", 30.0))
    baseline_ms = float(post_params.get("baseline_ms", 2.0))
    peak_direction = str(post_params.get("peak_direction", "auto"))
    post_search_start_s = post_params.get("post_search_start_s")
    post_search_end_s = post_params.get("post_search_end_s")
    if post_search_start_s is not None:
        post_search_start_s = float(post_search_start_s)
    if post_search_end_s is not None:
        post_search_end_s = float(post_search_end_s)

    failure_rule = str(failure_params.get("rule", "k_sd"))
    failure_k_sd = float(failure_params.get("k_sd", 3.0))
    failure_absolute = float(failure_params.get("absolute", 0.0))

    latency_rule = str(latency_params.get("rule", "fraction"))
    latency_fraction = float(latency_params.get("fraction", 0.20))

    bounds_start_s = float(pre_params.get("bounds_start_s", 0.0))
    bounds_end_s = float(pre_params.get("bounds_end_s", 0.0))
    min_distance_ms = float(pre_params.get("min_distance_ms", 2.0))

    added_by_sweep: dict[int, list[float]] = {}
    removed_by_sweep: dict[int, list[float]] = {}
    if manual_edits:
        for k, v in (manual_edits.get("added") or {}).items():
            added_by_sweep[int(k)] = [float(t) for t in (v or [])]
        for k, v in (manual_edits.get("removed") or {}).items():
            removed_by_sweep[int(k)] = [float(t) for t in (v or [])]

    sweep_index_lookup = {sw: i for i, sw in enumerate(sweep_indices)}

    all_trials: list[_Trial] = []
    per_sweep_summary: list[dict] = []

    for i, sw_idx in enumerate(sweep_indices):
        pre = sweeps_pre[i]
        post = sweeps_post[i]
        if pre.size == 0 or post.size == 0:
            per_sweep_summary.append({
                "sweep": int(sw_idx), "n_trials": 0, "n_success": 0,
                "n_failures": 0, "ppr_2_1": None,
            })
            continue

        # Pre-detection filter applies to BOTH pre and post (mirrors
        # the rest of the app: filter the displayed signal, then
        # measure on the same signal). Same dict shape as bursts/AP.
        pre_filtered = _apply_pre_detection_filter(pre, sr, pre_params)
        post_filtered = _apply_pre_detection_filter(post, sr, post_params)

        anchors = _find_pre_anchors(
            pre_filtered, sr, pre_mode, pre_params,
            bounds_start_s=bounds_start_s, bounds_end_s=bounds_end_s,
        )
        added = added_by_sweep.get(int(sw_idx), [])
        removed = removed_by_sweep.get(int(sw_idx), [])
        if added or removed or pre_mode == "manual":
            anchors = _apply_manual_anchor_edits(
                anchors, sr, added, removed, min_distance_ms,
            )
        manual_set = {int(round(t * sr)) for t in added}
        manual_tol = max(1, int(round(min_distance_ms / 1000.0 * sr)))

        # Pre amplitude per anchor (for the table). Cheap; we already
        # have the filtered signal in hand.
        pre_amps = _pre_amps(pre_filtered, anchors, pre_mode, sr)

        sweep_trials: list[_Trial] = []
        for trial_idx, anchor in enumerate(anchors):
            next_anchor = anchors[trial_idx + 1] if trial_idx + 1 < len(anchors) else None
            is_manual = any(abs(anchor - m) <= manual_tol for m in manual_set)
            tr = _measure_trial(
                post_filtered, sr,
                pre_idx=anchor, pre_amp=pre_amps[trial_idx],
                pre_ms=pre_ms, post_ms=post_ms, baseline_ms=baseline_ms,
                next_pre_idx=next_anchor,
                peak_direction=peak_direction,
                failure_rule=failure_rule,
                failure_k_sd=failure_k_sd,
                failure_absolute=failure_absolute,
                latency_rule=latency_rule,
                latency_fraction=latency_fraction,
                sweep=int(sw_idx),
                trial_idx=trial_idx,
                manual=is_manual,
                post_search_start_s=post_search_start_s,
                post_search_end_s=post_search_end_s,
            )
            sweep_trials.append(tr)
        all_trials.extend(sweep_trials)

        # Per-sweep PPR (just pulse 2 / pulse 1 for the table column).
        ppr_2_1: Optional[float] = None
        if len(sweep_trials) >= 2 and sweep_trials[0].success and sweep_trials[0].amplitude != 0.0:
            ppr_2_1 = float(sweep_trials[1].amplitude / sweep_trials[0].amplitude)
        per_sweep_summary.append({
            "sweep": int(sw_idx),
            "n_trials": len(sweep_trials),
            "n_success": sum(1 for t in sweep_trials if t.success),
            "n_failures": sum(1 for t in sweep_trials if not t.success),
            "ppr_2_1": ppr_2_1,
        })

    series_summary = _series_summary(all_trials)
    sta_all = _compute_sta(
        sweeps_post, sr, all_trials,
        pre_ms=pre_ms, post_ms=post_ms,
        sweep_index_lookup=sweep_index_lookup,
    )
    sta_success = _compute_sta(
        sweeps_post, sr, all_trials,
        pre_ms=pre_ms, post_ms=post_ms,
        sweep_index_lookup=sweep_index_lookup,
        successes_only=True,
    )
    sta_failure = _compute_sta(
        sweeps_post, sr, all_trials,
        pre_ms=pre_ms, post_ms=post_ms,
        sweep_index_lookup=sweep_index_lookup,
        failures_only=True,
    )

    return {
        "per_trial": [_trial_to_dict(t) for t in all_trials],
        "per_sweep_summary": per_sweep_summary,
        "series_summary": series_summary,
        "sta_all": sta_all,
        "sta_success": sta_success,
        "sta_failure": sta_failure,
    }


def _trial_to_dict(t: _Trial) -> dict:
    return {
        "sweep": int(t.sweep),
        "trial_idx": int(t.trial_idx),
        "pre_t_s": float(t.pre_t_s),
        "pre_amp": float(t.pre_amp),
        "baseline_mean": float(t.baseline_mean),
        "baseline_sd": float(t.baseline_sd),
        "post_peak": float(t.post_peak),
        "post_peak_t_s": float(t.post_peak_t_s),
        "amplitude": float(t.amplitude),
        "success": bool(t.success),
        "latency_ms": (t.latency_s * 1000.0) if t.latency_s is not None else None,
        "rise_ms": t.rise_ms,
        "decay_ms": t.decay_ms,
        "truncated": bool(t.truncated),
        "manual": bool(t.manual),
    }


def _find_pre_anchors(
    pre: np.ndarray, sr: float,
    mode: str, params: dict,
    *, bounds_start_s: float, bounds_end_s: float,
) -> list[int]:
    """Mode-dispatched anchor detection. Returns absolute sample indices
    on the (already filtered) pre signal."""
    if mode == "manual":
        return []
    if mode == "ap":
        spikes = _detect_spikes_sweep(
            pre, sr,
            method=str(params.get("ap_method", "auto_rec")),
            manual_threshold_mv=float(params.get("ap_manual_threshold_mv", -10.0)),
            min_amplitude_mv=float(params.get("ap_min_amplitude_mv", 50.0)),
            pos_dvdt_mv_ms=float(params.get("ap_pos_dvdt_mv_ms", 10.0)),
            neg_dvdt_mv_ms=float(params.get("ap_neg_dvdt_mv_ms", -10.0)),
            width_ms=float(params.get("ap_width_ms", 5.0)),
            min_distance_ms=float(params.get("min_distance_ms", 2.0)),
            bounds_start_s=bounds_start_s,
            bounds_end_s=bounds_end_s,
        )
        return [s.peak_idx for s in spikes]
    if mode == "stim":
        return _detect_stim_artifacts(
            pre, sr,
            dvdt_threshold=float(params.get("stim_dvdt_threshold", 1.0e3)),
            min_distance_ms=float(params.get("min_distance_ms", 2.0)),
            bounds_start_s=bounds_start_s,
            bounds_end_s=bounds_end_s,
        )
    if mode == "ttl":
        lvl = params.get("ttl_level_threshold", None)
        return _detect_ttl_edges(
            pre, sr,
            level_threshold=(float(lvl) if lvl is not None else None),
            edge=str(params.get("ttl_edge", "rising")),
            min_pulse_ms=float(params.get("ttl_min_pulse_ms", 1.0)),
            bounds_start_s=bounds_start_s,
            bounds_end_s=bounds_end_s,
        )
    raise ValueError(f"Unknown pre_mode: {mode!r}")


def _pre_amps(pre: np.ndarray, anchors: list[int], mode: str, sr: float) -> list[float]:
    """One amplitude value per anchor for the table.

    - ``ap``     — Vm at the anchor sample (the spike peak).
    - ``stim``   — local |d/dt| value at the anchor.
    - ``ttl``    — pulse height: signal at anchor minus min over the
                   preceding 1 ms.
    - ``manual`` — Vm at the anchor (best we can do without knowing the
                   user's intent).
    """
    if not anchors:
        return []
    out: list[float] = []
    for a in anchors:
        if mode == "stim":
            i0 = max(1, a - 1)
            i1 = min(pre.size, a + 2)
            local = pre[i0:i1]
            if local.size >= 2:
                out.append(float(np.max(np.abs(np.diff(local) * sr))))
            else:
                out.append(float("nan"))
        elif mode == "ttl":
            window = max(1, int(round(0.001 * sr)))
            i0 = max(0, a - window)
            base = float(np.min(pre[i0:a + 1])) if a > i0 else float(pre[a])
            out.append(float(pre[a] - base))
        else:
            out.append(float(pre[a]) if 0 <= a < pre.size else float("nan"))
    return out


# ---------------------------------------------------------------------------
# Synthetic-signal smoke test (run as ``python -m analysis.paired``)
# ---------------------------------------------------------------------------

def _synthetic_pair(
    sr: float = 20_000.0,
    duration_s: float = 1.0,
    pre_times_s: tuple[float, ...] = (0.10, 0.30, 0.50, 0.70),
    success_mask: tuple[bool, ...] = (True, True, False, True),
    psp_amp: float = -50.0,           # pA, negative = inward EPSC
    psp_tau_rise_ms: float = 0.5,
    psp_tau_decay_ms: float = 5.0,
    latency_ms: float = 1.5,
    noise_sd_pre: float = 1.0,        # mV
    noise_sd_post: float = 0.5,       # pA — chosen so k=3 cleanly
                                      # separates the synthetic failure
                                      # over a 30 ms search window.
                                      # Real low-noise patches sit here.
    rng_seed: int = 0,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Build a (pre, post, sr) synthetic paired sweep.

    Pre is a Vm trace with sharp positive deflections at ``pre_times_s``
    (toy spikes — high enough to clear the AP-detection thresholds).
    Post is an Im trace with biexponential PSCs at the same times,
    delayed by ``latency_ms``, present only where success_mask is True.
    """
    n = int(duration_s * sr)
    t = np.arange(n) / sr
    rng = np.random.default_rng(rng_seed)
    pre = rng.normal(scale=noise_sd_pre, size=n) - 70.0   # rest at -70 mV
    post = rng.normal(scale=noise_sd_post, size=n)
    for pt in pre_times_s:
        # Toy AP: 80 mV deflection, 1 ms rise, 1.5 ms fall.
        pi = int(round(pt * sr))
        rise = max(1, int(round(0.001 * sr)))
        fall = max(1, int(round(0.0015 * sr)))
        i0 = max(0, pi - rise)
        i1 = min(n, pi + fall)
        ramp = np.linspace(0.0, 80.0, pi - i0 + 1)
        decay = np.linspace(80.0, 0.0, i1 - pi + 1)
        pre[i0:pi + 1] += ramp
        pre[pi:i1 + 1] += decay
    tau_r = psp_tau_rise_ms / 1000.0
    tau_d = psp_tau_decay_ms / 1000.0
    for pt, ok in zip(pre_times_s, success_mask):
        if not ok:
            continue
        onset = pt + latency_ms / 1000.0
        oi = int(round(onset * sr))
        # Biexp: psp(τ) = (1 - exp(-τ/tr)) * exp(-τ/td) normalised so
        # peak = psp_amp.
        end = min(n, oi + int(0.05 * sr))
        if end <= oi:
            continue
        tt = (np.arange(end - oi) / sr)
        shape = (1.0 - np.exp(-tt / tau_r)) * np.exp(-tt / tau_d)
        peak = float(np.max(np.abs(shape)))
        if peak == 0:
            continue
        post[oi:end] += psp_amp * (shape / peak)
    return pre, post, sr


def _smoke_test():
    pre, post, sr = _synthetic_pair()
    out = run_paired(
        sweeps_pre=[pre], sweeps_post=[post], sweep_indices=[0], sr=sr,
        pre_mode="ap",
        pre_params={
            "ap_method": "auto_spike",
            "ap_min_amplitude_mv": 30.0,
            "ap_pos_dvdt_mv_ms": 5.0,
            "min_distance_ms": 5.0,
        },
        post_params={
            "pre_ms": 1.0, "post_ms": 30.0, "baseline_ms": 2.0,
            "peak_direction": "negative",
        },
        # k=5 is conservative; default in the API is k=3, but extreme-
        # value statistics on 30 ms × 0.5 pA Gaussian noise give an
        # expected peak ≈ 1.8 pA, which sits right on the k=3
        # boundary. k=5 gives the smoke test a deterministic margin.
        failure_params={"rule": "k_sd", "k_sd": 5.0},
        latency_params={"rule": "fraction", "fraction": 0.20},
    )
    assert len(out["per_trial"]) == 4, f"expected 4 trials, got {len(out['per_trial'])}"
    successes = [t for t in out["per_trial"] if t["success"]]
    assert len(successes) == 3, f"expected 3 successes, got {len(successes)}"
    failures = [t for t in out["per_trial"] if not t["success"]]
    assert len(failures) == 1
    s = out["series_summary"]
    assert s["n_trials"] == 4 and s["n_success"] == 3 and s["n_failures"] == 1
    assert s["failure_rate"] == 0.25
    # Latency on successes should land near 1.5 ms (input).
    lats = [t["latency_ms"] for t in successes if t["latency_ms"] is not None]
    assert lats, "no latencies reported on successes"
    mean_lat = float(np.mean(lats))
    assert 0.5 < mean_lat < 4.0, f"mean latency {mean_lat:.2f} ms outside expected range"
    # STA over successes should have an obvious negative trough.
    sta = out["sta_success"]
    assert sta is not None and sta["n"] == 3
    assert min(sta["mean"]) < -10.0, "STA trough not deep enough"
    print("paired.py smoke test OK:")
    print(f"  trials={s['n_trials']}  success={s['n_success']}  failure_rate={s['failure_rate']:.2f}")
    print(f"  potency={s['potency']:.1f}  cv={s['cv_success']}  1/cv²={s['inv_cv2']}")
    print(f"  latency mean={s['latency_mean_ms']:.2f} ms  jitter={s['latency_sd_ms']}")
    print(f"  STA n={sta['n']}  trough={min(sta['mean']):.1f}")


def _smoke_test_ttl_and_stim():
    """Confirm TTL-edge and stim-artifact detection both find the
    expected anchor count on a synthetic pre channel."""
    sr = 20_000.0
    n = int(0.5 * sr)
    rng = np.random.default_rng(1)
    # TTL: 5 V square pulses at 0.10, 0.20, 0.30, 0.40 s, 1 ms wide.
    ttl = rng.normal(scale=0.01, size=n)
    for pt in (0.10, 0.20, 0.30, 0.40):
        a = int(round(pt * sr))
        b = a + max(1, int(round(0.001 * sr)))
        ttl[a:b] += 5.0
    edges = _detect_ttl_edges(
        ttl, sr,
        level_threshold=2.5, edge="rising",
        min_pulse_ms=2.0,
        bounds_start_s=0.0, bounds_end_s=0.0,
    )
    assert len(edges) == 4, f"TTL: expected 4 rising edges, got {len(edges)}"

    # Auto-threshold path (level=None) — should still hit all four.
    edges_auto = _detect_ttl_edges(
        ttl, sr,
        level_threshold=None, edge="rising",
        min_pulse_ms=2.0,
        bounds_start_s=0.0, bounds_end_s=0.0,
    )
    assert len(edges_auto) == 4, f"TTL auto-threshold: got {len(edges_auto)}"

    # Stim artifact: biphasic step (+, then -, ringing) on |d/dt|.
    stim = rng.normal(scale=0.5, size=n)
    for pt in (0.10, 0.30):
        a = int(round(pt * sr))
        # Sharp step then immediate counter-step — typical extracellular
        # stim shape.
        stim[a:a + 5] += 100.0
        stim[a + 5:a + 10] -= 100.0
    artifacts = _detect_stim_artifacts(
        stim, sr,
        dvdt_threshold=1.0e6,           # |d/dt| in units/s
        min_distance_ms=20.0,           # merge anything closer than 20 ms
        bounds_start_s=0.0, bounds_end_s=0.0,
    )
    assert len(artifacts) == 2, f"stim: expected 2 anchors, got {len(artifacts)}"

    print("paired.py TTL + stim smoke OK:")
    print(f"  TTL rising edges: {len(edges)}  (auto-threshold: {len(edges_auto)})")
    print(f"  Stim artifacts:   {len(artifacts)}")


if __name__ == "__main__":
    _smoke_test()
    _smoke_test_ttl_and_stim()
