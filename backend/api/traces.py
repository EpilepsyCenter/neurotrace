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
):
    """Get trace data, optionally downsampled for display."""
    rec = get_current_recording()

    # Validate indices
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

    time = tr.time_array
    values = tr.data

    # Downsample if needed
    if max_points > 0 and len(values) > max_points:
        time, values = lttb_downsample(time, values, max_points)

    return {
        "time": time.tolist(),
        "values": values.tolist(),
        "sampling_rate": tr.sampling_rate,
        "units": tr.units,
        "label": tr.label,
        "n_samples": len(tr.data),
        "duration": tr.duration,
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
