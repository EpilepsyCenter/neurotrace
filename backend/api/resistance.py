"""Resistance monitoring API — compute Rs/Rin across all sweeps in a series."""

from fastapi import APIRouter, HTTPException, Query

from api.files import get_current_recording
from analysis.resistance import ResistanceAnalysis

router = APIRouter()

_resistance_analysis = ResistanceAnalysis()


@router.get("/monitor")
async def resistance_monitor(
    group: int = Query(0),
    series: int = Query(0),
    trace: int = Query(0),
    v_step: float = Query(5.0, description="Test pulse amplitude in mV"),
    baseline_start: float = Query(0.0, description="Baseline start (s)"),
    baseline_end: float = Query(0.005, description="Baseline end (s)"),
    peak_start: float = Query(0.005, description="Pulse start (s)"),
    peak_end: float = Query(0.02, description="Pulse end (s)"),
):
    """Compute Rs, Rin, Cm for every sweep in a series — for monitoring over time."""
    rec = get_current_recording()

    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    rs_values = []
    rin_values = []
    cm_values = []
    sweep_indices = []

    # Build params once — same for every sweep
    params = {
        "v_step": v_step,
        "baselineStart": baseline_start,
        "baselineEnd": baseline_end,
        "peakStart": peak_start,
        "peakEnd": peak_end,
    }

    for sweep_idx, sw in enumerate(ser.sweeps):
        if trace >= sw.trace_count:
            continue

        tr = sw.traces[trace]

        try:
            result = _resistance_analysis.run(tr.data, tr.sampling_rate, params)
            sweep_indices.append(sweep_idx)
            rs_values.append(result.get("rs"))
            rin_values.append(result.get("rin"))
            cm_values.append(result.get("cm"))
        except Exception:
            sweep_indices.append(sweep_idx)
            rs_values.append(None)
            rin_values.append(None)
            cm_values.append(None)

    # Quality assessment
    valid_rs = [r for r in rs_values if r is not None]
    if len(valid_rs) >= 2:
        initial_rs = valid_rs[0]
        rs_change_pct = [(r / initial_rs - 1) * 100 for r in valid_rs]
        max_change = max(abs(c) for c in rs_change_pct)
        quality = "good" if max_change < 20 else "warning" if max_change < 30 else "poor"
    else:
        max_change = 0
        quality = "unknown"

    valid_rin = [r for r in rin_values if r is not None]

    return {
        "sweep_indices": sweep_indices,
        "rs": rs_values,
        "rin": rin_values,
        "cm": cm_values,
        "quality": quality,
        "max_rs_change_pct": max_change,
        "mean_rs": float(sum(valid_rs) / len(valid_rs)) if valid_rs else None,
        "mean_rin": float(sum(valid_rin) / len(valid_rin)) if valid_rin else None,
        "params": params,  # echo back so frontend can confirm what was used
    }
