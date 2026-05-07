"""Paired-recording API.

Two endpoints:

- ``POST /api/paired/run`` — full pipeline. Body carries group/series,
  pre/post channel indices, sweeps, pre-detection mode + params, post
  window + filter, failure threshold, latency rule, optional manual
  edits. Returns per-trial rows, per-sweep summary, series stats,
  and three STAs (all / successes / failures).

- ``GET /api/paired/trial_window`` — pre + post slice around one
  pre-event time. Used by the trials table's row-click → scroll
  interaction. Returns LTTB-decimated x/y arrays for both channels.

POST is used for ``/run`` because the param surface is large; GET
fits the trial-window endpoint comfortably.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.files import get_current_recording
from utils.scaling import scaled
from utils.downsampling import lttb_downsample
from analysis.paired import run_paired

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers — pull both pre and post channels for a sweep at once
# ---------------------------------------------------------------------------

def _pre_post_for_sweep(
    group: int, series: int, sweep: int,
    pre_trace: int, post_trace: int,
) -> tuple[np.ndarray, np.ndarray, float]:
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    if sweep < 0 or sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail="Invalid sweep index")
    sw = ser.sweeps[sweep]
    if pre_trace < 0 or pre_trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail="Invalid pre-channel index")
    if post_trace < 0 or post_trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail="Invalid post-channel index")
    if pre_trace == post_trace:
        raise HTTPException(
            status_code=400,
            detail="pre and post channels must differ",
        )
    pre = np.asarray(scaled(sw.traces[pre_trace]), dtype=float)
    post = np.asarray(scaled(sw.traces[post_trace]), dtype=float)
    sr_pre = float(sw.traces[pre_trace].sampling_rate)
    sr_post = float(sw.traces[post_trace].sampling_rate)
    if sr_pre <= 0 or sr_post <= 0:
        raise HTTPException(status_code=400, detail="Sweep has no valid sampling rate")
    if abs(sr_pre - sr_post) > 1e-6:
        # Paired analysis depends on a shared sample grid. Bail rather
        # than silently resample — the user should know.
        raise HTTPException(
            status_code=400,
            detail=(
                f"pre and post channels have different sampling rates "
                f"({sr_pre} vs {sr_post}); paired analysis requires equal rates"
            ),
        )
    return pre, post, sr_pre


# ---------------------------------------------------------------------------
# /run — full paired pipeline
# ---------------------------------------------------------------------------

class PairedRunRequest(BaseModel):
    group: int
    series: int
    pre_trace: int
    post_trace: int
    sweeps: Optional[list[int]] = None
    pre_mode: str = "ap"            # 'ap' | 'stim' | 'ttl' | 'manual'
    pre_params: dict = {}           # mode-specific + filter + bounds
    post_params: dict = {}          # pre_ms, post_ms, baseline_ms,
                                    # peak_direction, filter_*
    failure_params: dict = {}       # rule, k_sd, absolute
    latency_params: dict = {}       # rule, fraction
    manual_edits: Optional[dict] = None


@router.post("/run")
async def paired_run(req: PairedRunRequest):
    rec = get_current_recording()
    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    n_sweeps = ser.sweep_count
    if n_sweeps == 0:
        raise HTTPException(status_code=400, detail="Series has no sweeps")

    sweep_indices = req.sweeps if req.sweeps else list(range(n_sweeps))
    sweep_indices = [s for s in sweep_indices if 0 <= s < n_sweeps]
    if not sweep_indices:
        raise HTTPException(status_code=400, detail="No valid sweeps requested")

    sweeps_pre: list[np.ndarray] = []
    sweeps_post: list[np.ndarray] = []
    sr: float = 0.0
    for sw_idx in sweep_indices:
        pre, post, sweep_sr = _pre_post_for_sweep(
            req.group, req.series, sw_idx,
            req.pre_trace, req.post_trace,
        )
        sweeps_pre.append(pre)
        sweeps_post.append(post)
        sr = sweep_sr   # validated equal across channels in helper

    if sr <= 0:
        raise HTTPException(status_code=400, detail="No valid sampling rate")

    try:
        result = run_paired(
            sweeps_pre=sweeps_pre,
            sweeps_post=sweeps_post,
            sweep_indices=sweep_indices,
            sr=sr,
            pre_mode=req.pre_mode,
            pre_params=req.pre_params or {},
            post_params=req.post_params or {},
            failure_params=req.failure_params or {},
            latency_params=req.latency_params or {},
            manual_edits=req.manual_edits,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Echo back the request shape so the frontend can persist it
    # alongside the results without having to remember what it sent.
    result["request"] = {
        "group": req.group, "series": req.series,
        "pre_trace": req.pre_trace, "post_trace": req.post_trace,
        "sweeps": sweep_indices,
        "pre_mode": req.pre_mode,
        "pre_params": req.pre_params,
        "post_params": req.post_params,
        "failure_params": req.failure_params,
        "latency_params": req.latency_params,
        "manual_edits": req.manual_edits,
    }
    result["sampling_rate"] = sr
    return result


# ---------------------------------------------------------------------------
# /trial_window — pre + post slice around one pre-event time
# ---------------------------------------------------------------------------

@router.get("/trial_window")
async def paired_trial_window(
    group: int = Query(...),
    series: int = Query(...),
    sweep: int = Query(...),
    pre_trace: int = Query(...),
    post_trace: int = Query(...),
    t_pre_s: float = Query(..., description="Pre-event anchor time in seconds"),
    pre_ms: float = Query(2.0),
    post_ms: float = Query(30.0),
    max_points: int = Query(2000),
):
    """Return decimated pre + post slices around ``t_pre_s``.

    Used to populate the trial inspector when the user clicks a row in
    the Trials table. Decimation is LTTB-based, same as the main
    `/api/traces/data` endpoint; the slice always extends a full
    ``pre_ms`` before and ``post_ms`` after even if the post-window
    truncated for the actual measurement.
    """
    pre, post, sr = _pre_post_for_sweep(group, series, sweep, pre_trace, post_trace)
    n = pre.size
    pre_samples = max(1, int(round(pre_ms / 1000.0 * sr)))
    post_samples = max(1, int(round(post_ms / 1000.0 * sr)))
    anchor = int(round(t_pre_s * sr))
    a = max(0, anchor - pre_samples)
    b = min(n, anchor + post_samples + 1)
    if b <= a:
        raise HTTPException(status_code=400, detail="Empty trial window")

    t = (np.arange(a, b, dtype=float)) / sr
    pre_seg = pre[a:b]
    post_seg = post[a:b]

    if max_points > 0 and (b - a) > max_points:
        t_pre_ds, pre_ds = lttb_downsample(t, pre_seg, max_points)
        t_post_ds, post_ds = lttb_downsample(t, post_seg, max_points)
        return {
            "t_pre": t_pre_ds.tolist(),
            "pre": pre_ds.tolist(),
            "t_post": t_post_ds.tolist(),
            "post": post_ds.tolist(),
            "sampling_rate": sr,
            "anchor_t_s": float(anchor / sr),
        }
    return {
        "t_pre": t.tolist(),
        "pre": pre_seg.tolist(),
        "t_post": t.tolist(),
        "post": post_seg.tolist(),
        "sampling_rate": sr,
        "anchor_t_s": float(anchor / sr),
    }
