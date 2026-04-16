"""Analysis execution API endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Optional

from api.files import get_current_recording
from api.traces import average_sweeps

# Import all analysis modules to trigger registration
import analysis.cursors
import analysis.resistance
import analysis.kinetics
import analysis.events
import analysis.field_potential
import analysis.bursts
import analysis.spectral
import analysis.fitting

from analysis.base import get_analysis, list_analyses

router = APIRouter()


class AnalysisRequest(BaseModel):
    analysis_type: str
    group: int = 0
    series: int = 0
    sweep: int = 0
    trace: int = 0
    cursors: dict = {}
    params: dict = {}


@router.get("/list")
async def get_analyses():
    """List all available analysis types."""
    return {"analyses": list_analyses()}


@router.post("/run")
async def run_analysis(req: AnalysisRequest):
    """Run an analysis on the specified trace."""
    rec = get_current_recording()

    # Get trace data
    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
        sw = ser.sweeps[req.sweep]
        tr = sw.traces[req.trace]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series/sweep/trace index")

    # Merge cursor positions into params
    params = {**req.cursors, **req.params}

    try:
        analysis = get_analysis(req.analysis_type)
        result = analysis.run(tr.data, tr.sampling_rate, params)
        return {"measurement": result, "analysis_type": req.analysis_type}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis error: {e}")


class BatchAnalysisRequest(BaseModel):
    analysis_type: str
    group: int = 0
    series: int = 0
    trace: int = 0
    sweep_start: int = 0
    sweep_end: int = -1
    cursors: dict = {}
    params: dict = {}


class AveragedAnalysisRequest(BaseModel):
    analysis_type: str
    group: int = 0
    series: int = 0
    trace: int = 0
    sweep_indices: Optional[list[int]] = None  # None = all sweeps in series
    cursors: dict = {}
    params: dict = {}


@router.post("/run_averaged")
async def run_averaged_analysis(req: AveragedAnalysisRequest):
    """Average a subset of sweeps and run an analysis on the averaged trace.

    If sweep_indices is None, averages every sweep in the series.
    """
    rec = get_current_recording()

    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    try:
        averaged_data, sr, units = average_sweeps(ser, req.trace, req.sweep_indices)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Merge cursors + params
    params = {**req.cursors, **req.params}

    try:
        analysis = get_analysis(req.analysis_type)
        result = analysis.run(averaged_data, sr, params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis error: {e}")

    n_used = len(req.sweep_indices) if req.sweep_indices is not None else ser.sweep_count
    return {
        "measurement": result,
        "analysis_type": req.analysis_type,
        "n_sweeps_averaged": n_used,
        "sweep_indices": req.sweep_indices if req.sweep_indices is not None else list(range(ser.sweep_count)),
        "sampling_rate": sr,
        "units": units,
    }


@router.post("/batch")
async def run_batch_analysis(req: BatchAnalysisRequest):
    """Run analysis across multiple sweeps."""
    rec = get_current_recording()

    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    end = req.sweep_end if req.sweep_end >= 0 else ser.sweep_count
    params = {**req.cursors, **req.params}

    analysis = get_analysis(req.analysis_type)
    results = []

    for sweep_idx in range(req.sweep_start, end):
        if sweep_idx >= ser.sweep_count:
            break
        sw = ser.sweeps[sweep_idx]
        if req.trace >= sw.trace_count:
            continue

        tr = sw.traces[req.trace]
        try:
            result = analysis.run(tr.data, tr.sampling_rate, params)
            result["sweep_index"] = sweep_idx
            results.append(result)
        except Exception as e:
            results.append({"sweep_index": sweep_idx, "error": str(e)})

    return {
        "analysis_type": req.analysis_type,
        "n_sweeps": len(results),
        "results": results,
    }
