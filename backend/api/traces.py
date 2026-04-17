"""Trace data API endpoints with downsampling support."""

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from api.files import get_current_recording
from readers.models import Recording, Series
from utils.downsampling import lttb_downsample

router = APIRouter()


def average_sweeps(
    ser: Series,
    trace_idx: int,
    sweep_indices: Optional[list[int]] = None,
) -> tuple[np.ndarray, float, str]:
    """Average trace data across a set of sweeps within a series.

    If sweep_indices is None, averages all sweeps.
    Returns (averaged_values, sampling_rate, units).
    """
    if sweep_indices is None:
        sweep_indices = list(range(ser.sweep_count))

    traces: list[np.ndarray] = []
    ref_sr = 20000.0
    ref_units = ""

    for sw_idx in sweep_indices:
        if sw_idx < 0 or sw_idx >= ser.sweep_count:
            continue
        sw = ser.sweeps[sw_idx]
        if trace_idx >= sw.trace_count:
            continue
        tr = sw.traces[trace_idx]
        traces.append(tr.data)
        ref_sr = tr.sampling_rate
        ref_units = tr.units

    if not traces:
        raise ValueError("No valid sweeps to average")

    # Align to shortest trace
    min_len = min(len(t) for t in traces)
    aligned = np.stack([t[:min_len] for t in traces], axis=0)
    avg = np.mean(aligned, axis=0)
    return avg, ref_sr, ref_units


@router.get("/data")
async def get_trace_data(
    group: int = Query(0),
    series: int = Query(0),
    sweep: int = Query(0),
    trace: int = Query(0),
    max_points: int = Query(10000, description="Max points for downsampling (0 = no downsampling)"),
    t_start: Optional[float] = Query(None, description="Window start time in seconds (None = from beginning)"),
    t_end: Optional[float] = Query(None, description="Window end time in seconds (None = to end)"),
    filter_type: str = Query("", description="Filter type: lowpass, highpass, bandpass, or empty for none"),
    filter_low: float = Query(0, description="Low cutoff frequency (Hz) for highpass/bandpass"),
    filter_high: float = Query(0, description="High cutoff frequency (Hz) for lowpass/bandpass"),
    filter_order: int = Query(4, description="Butterworth filter order"),
    zero_offset: bool = Query(False, description="Subtract baseline computed from first ~3ms of the full sweep (post-filter, pre-slice)"),
    zero_offset_ms: float = Query(3.0, description="Window (ms) at the start of the sweep used to compute the zero offset"),
):
    """Get trace data, optionally filtered, windowed, and downsampled for display.

    Filtering is applied on the full trace first, then the [t_start, t_end]
    window is sliced, then the slice is decimated to at most ``max_points``.
    """
    from utils.filters import lowpass_filter, highpass_filter, bandpass_filter

    rec = get_current_recording()

    if group >= rec.group_count:
        raise HTTPException(status_code=400, detail=f"Group index {group} out of range (max {rec.group_count - 1})")
    grp = rec.groups[group]

    if series >= grp.series_count:
        raise HTTPException(status_code=400, detail=f"Series index {series} out of range (max {grp.series_count - 1})")
    ser = grp.series_list[series]

    if sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail=f"Sweep index {sweep} out of range (max {ser.sweep_count - 1})")
    sw = ser.sweeps[sweep]

    if trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail=f"Trace index {trace} out of range (max {sw.trace_count - 1})")
    tr = sw.traces[trace]

    time_full = tr.time_array
    data_full = tr.data
    sr = tr.sampling_rate
    original_n = len(data_full)

    # Compute slice indices first — this lets us avoid copying the whole trace
    # when no filter is applied, which is the common case for long sweeps.
    want_window = t_start is not None or t_end is not None
    if want_window:
        i0 = max(0, int((t_start or 0.0) * sr))
        i1 = original_n if t_end is None else min(original_n, int(t_end * sr) + 1)
    else:
        i0, i1 = 0, original_n

    if i1 <= i0:
        return {
            "time": [],
            "values": [],
            "sampling_rate": sr,
            "units": tr.units,
            "label": tr.label,
            "n_samples": original_n,
            "duration": tr.duration,
            "filtered": bool(filter_type),
            "window": {"t_start": t_start, "t_end": t_end},
            "decimated": False,
            "returned_n": 0,
        }

    want_filter = (
        filter_type
        and filter_type != "none"
        and (
            (filter_type == "lowpass" and filter_high > 0)
            or (filter_type == "highpass" and filter_low > 0)
            or (filter_type == "bandpass" and filter_low > 0 and filter_high > 0)
        )
    )

    if want_filter:
        # Filter the FULL trace first so viewport edges match full-view values.
        # We must copy here (filter mutates) — unavoidable for correctness.
        values_full = data_full.copy()
        try:
            if filter_type == "lowpass":
                values_full = lowpass_filter(values_full, filter_high, sr, filter_order)
            elif filter_type == "highpass":
                values_full = highpass_filter(values_full, filter_low, sr, filter_order)
            elif filter_type == "bandpass":
                values_full = bandpass_filter(values_full, filter_low, filter_high, sr, filter_order)
        except Exception:
            values_full = data_full  # fall back silently on bad params
    else:
        # No filter — we work off a view unless we need to apply zero offset
        # (which would mutate and must stay confined to our local array).
        values_full = data_full

    # Compute zero offset from the FIRST few ms of the full (filtered) sweep,
    # then subtract. This ensures offset is per-SWEEP, independent of where
    # the viewport is currently positioned.
    offset = 0.0
    if zero_offset:
        n_baseline = max(1, min(int(zero_offset_ms * 1e-3 * sr), original_n))
        offset = float(np.mean(values_full[:n_baseline]))
        if offset != 0.0:
            # Subtract only into the slice we're returning, not the cached
            # full trace. If values_full is still a view of data_full (unfiltered
            # path), take a sliced copy; if it's already our filter-output
            # array, we can mutate its slice in place.
            slice_copy = np.asarray(values_full[i0:i1]).copy()
            slice_copy -= offset
            values = slice_copy
        else:
            values = values_full[i0:i1]
    else:
        values = values_full[i0:i1]

    time = time_full[i0:i1]

    # Downsample if needed
    decimated = False
    if max_points > 0 and len(values) > max_points:
        # lttb_downsample requires arrays (not views). Cast once; it allocates
        # only for the downsampled output size, not the input length.
        time, values = lttb_downsample(np.ascontiguousarray(time), np.ascontiguousarray(values), max_points)
        decimated = True

    return {
        "time": time.tolist(),
        "values": values.tolist(),
        "sampling_rate": sr,
        "units": tr.units,
        "label": tr.label,
        "n_samples": original_n,
        "duration": tr.duration,
        "filtered": want_filter,
        "window": {"t_start": t_start, "t_end": t_end},
        "decimated": decimated,
        "returned_n": len(values),
        "zero_offset": offset if zero_offset else 0.0,
    }


@router.get("/average")
async def get_average_trace(
    group: int = Query(0),
    series: int = Query(0),
    trace: int = Query(0),
    sweep_start: int = Query(0),
    sweep_end: int = Query(-1),
    max_points: int = Query(10000),
):
    """Get average trace across sweeps."""
    rec = get_current_recording()
    grp = rec.groups[group]
    ser = grp.series_list[series]

    end = sweep_end if sweep_end >= 0 else ser.sweep_count
    indices = list(range(sweep_start, end))

    try:
        avg, sr, units = average_sweeps(ser, trace, indices)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    time = np.arange(len(avg)) / sr

    if max_points > 0 and len(avg) > max_points:
        time, avg = lttb_downsample(time, avg, max_points)

    return {
        "time": time.tolist(),
        "values": avg.tolist(),
        "sampling_rate": sr,
        "units": units,
        "label": f"Average ({len(indices)} sweeps)",
        "n_sweeps": len(indices),
    }


@router.get("/stimulus")
async def get_stimulus_for_sweep(
    group: int = Query(0),
    series: int = Query(0),
    sweep: int = Query(0),
):
    """Get the stimulus segments for a specific sweep, with per-sweep
    increment math applied. Returns the segment waveform for overlay."""
    from api.files import _pgf_data

    if _pgf_data is None:
        return {"segments": [], "unit": ""}

    # Linear index: count series across all groups
    rec = get_current_recording()
    stim_idx = 0
    target_stim = None
    for g in rec.groups:
        for s in g.series_list:
            if g.index == group and s.index == series:
                target_stim = stim_idx
            stim_idx += 1

    if target_stim is None or target_stim >= len(_pgf_data.stimulations):
        return {"segments": [], "unit": ""}

    from readers.heka_native.pgf import PgfStimulation, PgfChannel, SegmentClass

    stim: PgfStimulation = _pgf_data.stimulations[target_stim]

    # Find the best channel (same logic as _extract_stimulus)
    best_ch: PgfChannel | None = None
    best_range = 0.0
    for ch in stim.channels:
        if not ch.segments:
            continue
        levels = [seg.voltage_at_sweep(sweep) for seg in ch.segments]
        v_range = max(abs(v) for v in levels) if levels else 0
        score = v_range * (2.0 if ch.do_write else 1.0)
        if score > best_range or best_ch is None:
            best_range = score
            best_ch = ch

    if best_ch is None:
        return {"segments": [], "unit": ""}

    # Unit conversion (same logic as reader.py: x1000 universally)
    dac_unit = best_ch.dac_unit.strip()
    if dac_unit in ('V', 'Volt'):
        unit_label = 'mV'
        scale = 1000.0
    elif dac_unit in ('A', 'Amp', 'Ampere'):
        unit_label = 'pA'
        scale = 1000.0  # stored as nA, not SI Amperes
    else:
        unit_label = dac_unit
        scale = 1.0

    # Build segments for this specific sweep
    segments = []
    t = 0.0
    for seg in best_ch.segments:
        dur = seg.duration_at_sweep(sweep)
        level = seg.voltage_at_sweep(sweep) * scale
        if dur > 0:
            segments.append({"start": t, "end": t + dur, "level": level})
        t += dur

    return {"segments": segments, "unit": unit_label}
