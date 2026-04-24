"""Event detection & analysis API endpoints.

Five endpoints, one dedicated window:

- ``POST /api/events/detect`` — full pipeline (detection + kinetics +
  exclusion + manual edits). Main entry point.

- ``POST /api/events/template/fit`` — fit the biexponential template
  to a user-selected region of one sweep. Used by the Template
  Generator dialog.

- ``POST /api/events/refine_template`` — given an already-detected set
  of events, compute their average and fit a biexponential to it. Used
  by the Refine Template dialog.

- ``POST /api/events/rms`` — compute RMS + mean of a user-selected
  quiet region. Used by the Thresholding flow's "Select quiet region"
  action to seed the RMS-based threshold.

- ``POST /api/events/detection_measure`` — return the correlation or
  deconvolution trace for plot overlay. Decimated to a manageable
  size for the frontend.

POST everywhere because param surfaces are large (detection +
kinetics + exclusion + manual edits), and because a few endpoints
return float arrays that would be ugly in a query string.

Units: callers send times in seconds; per-event values in the units
of the recording (pA for VC, mV for CC). The backend doesn't do unit
conversion — whatever's in ``tr.data`` stays in ``tr.data`` units.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.files import get_current_recording
from analysis.bursts import _apply_pre_detection_filter
from analysis.events import (
    fit_biexponential, render_template,
    compute_rms,
    _sliding_correlation, _deconvolve,  # for /detection_measure
    _gaussian_fit_to_histogram,          # for deconvolution cutoff overlay
    run_events, average_detected_events,
    EventRecord,
)


router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _trace_for(group: int, series: int, sweep: int, trace: int) -> tuple[np.ndarray, float, str]:
    """Pull a single sweep's trace data + sampling rate + units.

    Centralised so every endpoint validates (group/series/sweep/trace)
    the same way and returns the same ``400`` error text when any of
    them is out of range.
    """
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    if sweep < 0 or sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail="Invalid sweep index")
    sw = ser.sweeps[sweep]
    if trace < 0 or trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail="Invalid trace index")
    tr = sw.traces[trace]
    values = np.asarray(tr.data, dtype=float)
    sr = float(tr.sampling_rate)
    if sr <= 0:
        raise HTTPException(status_code=400, detail="Sweep has no valid sampling rate")
    return values, sr, tr.units or ""


def _decimate_for_overlay(x: np.ndarray, max_points: int = 4000) -> tuple[list[float], int]:
    """Min-max-preserving decimation for a plot overlay.

    For an N-sample trace sent to a ~4000-pixel plot, we don't want to
    ship N floats and we also don't want to lose the peaks. We split
    the signal into ``max_points/2`` buckets and emit each bucket's
    min and max in time order — matches what uPlot would draw anyway
    and preserves all extrema-driven events.
    """
    n = len(x)
    if n <= max_points:
        return [float(v) for v in x], 1
    bucket = max(1, n // max(1, max_points // 2))
    out: list[float] = []
    for i in range(0, n, bucket):
        seg = x[i : i + bucket]
        if seg.size == 0:
            continue
        lo = float(np.min(seg))
        hi = float(np.max(seg))
        # Emit in time order — if the min comes first use (lo, hi),
        # else (hi, lo). Keeps the overlay visually faithful to the
        # raw trace.
        first_is_min = int(np.argmin(seg)) <= int(np.argmax(seg))
        if first_is_min:
            out.append(lo)
            out.append(hi)
        else:
            out.append(hi)
            out.append(lo)
    return out, bucket


# ---------------------------------------------------------------------------
# /template/fit — fit biexp to a user-selected region
# ---------------------------------------------------------------------------

class TemplateFitRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    t_start_s: float
    t_end_s: float
    initial_rise_ms: float = 0.5
    initial_decay_ms: float = 5.0
    direction: str = "auto"      # 'auto' | 'negative' | 'positive'
    # Filter the trace before fitting — matches what the detector will
    # see. Default off for backward compatibility.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4


@router.post("/template/fit")
async def template_fit(req: TemplateFitRequest):
    """Fit the biexp event model to ``(t_start_s, t_end_s)`` in one sweep.

    The caller typically drags a rectangle around a clean exemplar
    event; the left edge should sit at (or near) the event foot for
    a numerically-friendly fit. Returns the fit coefficients + the
    evaluated curve for plotting alongside the selected data.
    """
    values, sr, units = _trace_for(req.group, req.series, req.sweep, req.trace)
    if req.filter_enabled:
        try:
            values = _apply_pre_detection_filter(values, sr, {
                "filter_enabled": True,
                "filter_type": req.filter_type,
                "filter_low": req.filter_low,
                "filter_high": req.filter_high,
                "filter_order": req.filter_order,
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Filter failed: {e}")
    i0 = max(0, int(round(req.t_start_s * sr)))
    i1 = min(len(values), int(round(req.t_end_s * sr)))
    if i1 - i0 < 4:
        raise HTTPException(status_code=400, detail="Selected region too short to fit")

    t = np.arange(i0, i1, dtype=float) / sr
    v = values[i0:i1]
    try:
        fit = fit_biexponential(
            t, v,
            initial_rise_ms=req.initial_rise_ms,
            initial_decay_ms=req.initial_decay_ms,
            direction=req.direction,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Return both the fit-model curve and the raw data so the UI can
    # draw them overlaid without a second round trip.
    return {
        "b0": fit.b0,
        "b1": fit.b1,
        "tau_rise_ms": fit.tau_rise_s * 1000.0,
        "tau_decay_ms": fit.tau_decay_s * 1000.0,
        "r_squared": fit.r_squared,
        # Times are relative to region start (seconds).
        "time_s": [float(x) for x in (fit.time)],
        "fit_values": [float(x) for x in fit.fit_values],
        "region_values": [float(x) for x in v],
        "region_t_start_s": req.t_start_s,
        "units": units,
        "sampling_rate": sr,
    }


# ---------------------------------------------------------------------------
# /rms — quiet-region baseline + RMS
# ---------------------------------------------------------------------------

class RmsRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    t_start_s: float
    t_end_s: float
    # Optional filter — when enabled the RMS matches the trace the
    # detector will see, not the raw recording. Same shape as /detect.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4


@router.post("/rms")
async def rms(req: RmsRequest):
    """Compute RMS + mean over ``(t_start_s, t_end_s)`` of one sweep.

    The caller picks a "quiet region" on the trace; the returned RMS
    drives the thresholding detector's ``baseline ± n × rms`` line.
    When ``filter_enabled`` is true, the same pre-detection filter as
    ``/detect`` is applied first so the RMS is measured on the trace
    the detector will actually see.
    """
    values, sr, units = _trace_for(req.group, req.series, req.sweep, req.trace)
    if req.filter_enabled:
        try:
            values = _apply_pre_detection_filter(values, sr, {
                "filter_enabled": True,
                "filter_type": req.filter_type,
                "filter_low": req.filter_low,
                "filter_high": req.filter_high,
                "filter_order": req.filter_order,
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Filter failed: {e}")
    i0 = max(0, int(round(req.t_start_s * sr)))
    i1 = min(len(values), int(round(req.t_end_s * sr)))
    try:
        r = compute_rms(values, i0, i1)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "rms": r.rms,
        "baseline_mean": r.baseline_mean,
        "n_samples": r.n_samples,
        "t_start_s": float(i0) / sr,
        "t_end_s": float(i1) / sr,
        "units": units,
    }


# ---------------------------------------------------------------------------
# /detect — full pipeline
# ---------------------------------------------------------------------------

class DetectionTemplate(BaseModel):
    """Biexponential template coefficients used on the backend to render
    the sliding template array. All params except the sign of ``b1``
    stay within the detector; sign decides peak polarity."""
    b0: float = 0.0
    b1: float = -30.0
    tau_rise_ms: float = 0.5
    tau_decay_ms: float = 5.0
    width_ms: float = 30.0


class DetectRequest(BaseModel):
    group: int
    series: int
    sweep: int                     # which sweep to run on (Phase 1 = one at a time)
    trace: int

    method: str = "template_correlation"
    # 'template_correlation' | 'template_deconvolution' | 'threshold'

    # Pre-detection filter (same shape as AP/Burst): applied once to the
    # sweep before anything else — threshold, template detection, AND
    # kinetics all see the filtered trace. Off by default; users typically
    # enable a 1–500 Hz bandpass for noisy VC recordings.
    filter_enabled: bool = False
    filter_type: str = "bandpass"  # 'lowpass' | 'highpass' | 'bandpass'
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4

    # Template-method params
    template: Optional[DetectionTemplate] = None
    cutoff: float = 0.4            # correlation: 0-1; deconvolution: SD

    # Deconvolution extras
    deconv_low_hz: float = 0.1
    deconv_high_hz: float = 200.0

    # Threshold method params
    threshold_value: Optional[float] = None

    # Common
    direction: str = "negative"    # 'negative' | 'positive'
    min_iei_ms: float = 5.0

    # Kinetics
    baseline_search_ms: float = 10.0
    avg_baseline_ms: float = 1.0
    avg_peak_ms: float = 1.0
    rise_low_pct: float = 10.0
    rise_high_pct: float = 90.0
    decay_pct: float = 37.0
    decay_search_ms: float = 30.0

    # Exclusion
    amplitude_min_abs: float = 5.0
    amplitude_max_abs: float = 2000.0
    auc_min_abs: Optional[float] = None

    # Manual edits (in seconds within the sweep)
    manual_added_times: Optional[list[float]] = None
    manual_removed_times: Optional[list[float]] = None

    # If true, the detection measure (correlation / deconvolution
    # trace) is decimated and returned — for the optional overlay
    # subplot. The deconvolution trace is large (N samples) so we
    # only compute + ship it when requested.
    return_detection_measure: bool = False


@router.post("/detect")
async def detect(req: DetectRequest):
    values, sr, units = _trace_for(req.group, req.series, req.sweep, req.trace)

    # Pre-detection filter — same Butterworth sosfiltfilt as AP / Burst.
    # Applied once up front so every downstream step (thresholding,
    # template detection, kinetics) sees the same filtered trace.
    if req.filter_enabled:
        try:
            values = _apply_pre_detection_filter(values, sr, {
                "filter_enabled": True,
                "filter_type": req.filter_type,
                "filter_low": req.filter_low,
                "filter_high": req.filter_high,
                "filter_order": req.filter_order,
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Filter failed: {e}")

    template_arr: Optional[np.ndarray] = None
    if req.method.startswith("template_"):
        if req.template is None:
            raise HTTPException(
                status_code=400,
                detail="Template methods require a template payload",
            )
        t = req.template
        template_arr = render_template(
            t.b0, t.b1,
            t.tau_rise_ms / 1000.0, t.tau_decay_ms / 1000.0,
            t.width_ms, sr,
        )

    try:
        records, dm = run_events(
            values, sr,
            method=req.method,
            template=template_arr,
            cutoff=req.cutoff,
            deconv_low_hz=req.deconv_low_hz,
            deconv_high_hz=req.deconv_high_hz,
            threshold_value=req.threshold_value,
            direction=req.direction,
            min_iei_ms=req.min_iei_ms,
            baseline_search_ms=req.baseline_search_ms,
            avg_baseline_ms=req.avg_baseline_ms,
            avg_peak_ms=req.avg_peak_ms,
            rise_low_pct=req.rise_low_pct,
            rise_high_pct=req.rise_high_pct,
            decay_pct=req.decay_pct,
            decay_search_ms=req.decay_search_ms,
            amplitude_min_abs=req.amplitude_min_abs,
            amplitude_max_abs=req.amplitude_max_abs,
            auc_min_abs=req.auc_min_abs,
            manual_added_times=req.manual_added_times,
            manual_removed_times=req.manual_removed_times,
            sweep_index=req.sweep,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    events_out = [r.to_dict() for r in records]

    # Detection-measure overlay (optional). Decimated for the wire.
    # For deconvolution the payload also carries the amplitude
    # histogram's Gaussian parameters + the signed cutoff line, so
    # the UI can render the horizontal threshold as
    # ``mu + sign·cutoff_sd·sigma`` without re-fitting on the client.
    dm_payload = None
    if req.return_detection_measure and dm is not None:
        dm_arr = np.asarray(dm, dtype=float)
        dm_values, bucket = _decimate_for_overlay(dm_arr, max_points=4000)
        dt = (bucket / 2.0) / sr if bucket > 1 else 1.0 / sr
        method_label = (
            "correlation" if req.method == "template_correlation" else "deconvolution"
        )
        extra: dict = {}
        if req.method == "template_deconvolution":
            mu, sigma = _gaussian_fit_to_histogram(dm_arr)
            # Deconvolution peaks are always positive (see detect_deconvolution);
            # cutoff line is on the positive side of the histogram mean.
            extra = {
                "mu": float(mu),
                "sigma": float(sigma),
                "cutoff_line": float(mu + req.cutoff * sigma),
            }
        elif req.method == "template_correlation":
            # For correlation, the cutoff is the r value the user set,
            # a horizontal line on the correlation trace (range [-1, 1]).
            extra = {
                "mu": 0.0, "sigma": 1.0,
                "cutoff_line": float(req.cutoff),
            }
        dm_payload = {
            "values": dm_values,
            "dt_s": dt,
            "t_start_s": 0.0,
            "n_raw_samples": int(len(dm)),
            "method": method_label,
            **extra,
        }

    return {
        "events": events_out,
        "n_events": len(events_out),
        "sampling_rate": sr,
        "units": units,
        "sweep_length_s": float(len(values)) / sr,
        "detection_measure": dm_payload,
    }


# ---------------------------------------------------------------------------
# /refine_template — fit biexp to the average of detected events
# ---------------------------------------------------------------------------

class RefineRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    # Full event list (as returned by /detect). We only need peak_idx +
    # foot_idx + baseline_val + amplitude to re-align, so the client
    # can either ship the whole result or just those fields.
    events: list[dict]
    align: str = "peak"            # 'peak' | 'foot' | 'rise_halfwidth'
    window_before_ms: float = 5.0
    window_after_ms: float = 50.0
    initial_rise_ms: float = 0.5
    initial_decay_ms: float = 5.0
    direction: str = "negative"


@router.post("/refine_template")
async def refine_template(req: RefineRequest):
    """Compute the average event and fit a fresh biexp to it.

    The frontend can use this after a first detection pass to iterate:
    detect → refine → detect-again, so the template converges on the
    shape actually present in the data rather than the user's initial
    hand-fit. The returned averaged event is also sent back so the UI
    can plot it + the new fit on the Refine dialog.
    """
    values, sr, _units = _trace_for(req.group, req.series, req.sweep, req.trace)

    # Rehydrate a light EventRecord list — just the fields the
    # averager reads. We don't care about the other kinetics fields
    # here.
    recs: list[EventRecord] = []
    for e in req.events:
        try:
            recs.append(EventRecord(
                sweep=int(e.get("sweep", req.sweep)),
                peak_idx=int(e["peak_idx"]),
                peak_time_s=float(e.get("peak_time_s", 0.0)),
                peak_val=float(e.get("peak_val", 0.0)),
                foot_idx=int(e.get("foot_idx", e["peak_idx"])),
                foot_time_s=float(e.get("foot_time_s", 0.0)),
                baseline_val=float(e.get("baseline_val", 0.0)),
                amplitude=float(e.get("amplitude", 0.0)),
                rise_time_ms=None, decay_time_ms=None,
                half_width_ms=None, auc=None,
                decay_endpoint_idx=None,
                manual=bool(e.get("manual", False)),
            ))
        except (KeyError, TypeError, ValueError):
            # Silently skip malformed event rows rather than 400ing —
            # the caller may have sent synthetic events.
            continue

    if not recs:
        raise HTTPException(
            status_code=400,
            detail="No usable events to refine from",
        )

    t_avg, avg_values, n = average_detected_events(
        values, sr, recs,
        align=req.align,
        window_before_ms=req.window_before_ms,
        window_after_ms=req.window_after_ms,
    )

    # Fit the biexp to the averaged event — shift the time axis so
    # t=0 sits at the averaged-event foot when possible, otherwise at
    # the window start. For peak-aligned averaging, the rising edge
    # sits in the left half of the window so the fit should trim
    # pre-peak samples to be meaningful — the easiest route is to
    # fit only from the window sample where the average crosses 10%
    # of its extremum amplitude, which approximates the foot.
    direction = req.direction
    sign = -1 if direction == "negative" else 1
    # Find the extremum sample and the 10%-of-extremum crossing BEFORE
    # it (the rising edge).
    if avg_values.size >= 4:
        ex_idx = int(np.argmin(avg_values)) if sign < 0 else int(np.argmax(avg_values))
        baseline_guess = float(np.median(avg_values[: max(3, len(avg_values) // 10)]))
        ex_val = float(avg_values[ex_idx])
        trigger = baseline_guess + 0.10 * (ex_val - baseline_guess)
        # Walk back from ex_idx until we're on the baseline side of trigger.
        foot_i = ex_idx
        for i in range(ex_idx, -1, -1):
            v = avg_values[i]
            if (sign < 0 and v >= trigger) or (sign > 0 and v <= trigger):
                foot_i = i
                break
    else:
        foot_i = 0

    try:
        fit = fit_biexponential(
            t_avg[foot_i:],
            avg_values[foot_i:],
            initial_rise_ms=req.initial_rise_ms,
            initial_decay_ms=req.initial_decay_ms,
            direction=req.direction,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "n_events_averaged": int(n),
        "average_time_s": [float(x) for x in t_avg],
        "average_values": [float(x) for x in avg_values],
        "foot_sample_idx": int(foot_i),
        "fit": {
            "b0": fit.b0,
            "b1": fit.b1,
            "tau_rise_ms": fit.tau_rise_s * 1000.0,
            "tau_decay_ms": fit.tau_decay_s * 1000.0,
            "r_squared": fit.r_squared,
            "fit_time_s": [float(x) for x in fit.time],
            "fit_values": [float(x) for x in fit.fit_values],
        },
    }


# ---------------------------------------------------------------------------
# /detection_measure — standalone overlay preview (no detection run)
# ---------------------------------------------------------------------------

class DetectionMeasureRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    method: str                    # 'template_correlation' | 'template_deconvolution'
    template: DetectionTemplate
    direction: str = "negative"    # needed for cutoff line sign
    cutoff: float = 0.4            # correlation r cutoff OR deconvolution σ cutoff
    deconv_low_hz: float = 1.0
    deconv_high_hz: float = 200.0
    # Optional pre-detection filter (matches /detect).
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4
    # Viewport window (optional) — when set, the DM is computed on
    # the WHOLE sweep (to preserve event context at the edges) and
    # the slice corresponding to [t_start_s, t_end_s] is returned
    # at full sampling-rate resolution. Matches EE, where the DM is
    # shown continuously over every sample.
    t_start_s: Optional[float] = None
    t_end_s: Optional[float] = None


@router.post("/detection_measure")
async def detection_measure(req: DetectionMeasureRequest):
    """Return the (decimated) similarity trace + cutoff metadata.

    Lets the Refine Template window (and the main analysis viewer's
    detection-measure overlay) plot the trace with the horizontal
    cutoff line, exactly as EE does, without re-running the whole
    kinetics pipeline.
    """
    values, sr, _units = _trace_for(req.group, req.series, req.sweep, req.trace)
    if req.filter_enabled:
        try:
            values = _apply_pre_detection_filter(values, sr, {
                "filter_enabled": True,
                "filter_type": req.filter_type,
                "filter_low": req.filter_low,
                "filter_high": req.filter_high,
                "filter_order": req.filter_order,
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Filter failed: {e}")

    t = req.template
    template_arr = render_template(
        t.b0, t.b1,
        t.tau_rise_ms / 1000.0, t.tau_decay_ms / 1000.0,
        t.width_ms, sr,
    )

    extra: dict = {}
    if req.method == "template_correlation":
        dm = _sliding_correlation(values, template_arr)
        label = "correlation"
        extra = {"mu": 0.0, "sigma": 1.0, "cutoff_line": float(req.cutoff)}
    elif req.method == "template_deconvolution":
        dm = _deconvolve(values, template_arr, sr, req.deconv_low_hz, req.deconv_high_hz)
        label = "deconvolution"
        mu, sigma = _gaussian_fit_to_histogram(np.asarray(dm, dtype=float))
        extra = {
            "mu": float(mu),
            "sigma": float(sigma),
            "cutoff_line": float(mu + req.cutoff * sigma),
        }
    else:
        raise HTTPException(status_code=400, detail="Unknown method for detection_measure")

    dm_arr = np.asarray(dm, dtype=float)
    n = len(dm_arr)
    # Viewport slicing: compute on whole sweep (correct detection at
    # edges), return only the requested window at FULL sampling-rate
    # resolution. The frontend refetches on viewport changes so the
    # overlay always matches the visible trace sample-for-sample.
    if req.t_start_s is not None and req.t_end_s is not None:
        i0 = max(0, int(round(req.t_start_s * sr)))
        i1 = min(n, int(round(req.t_end_s * sr)) + 1)
        if i1 > i0:
            dm_arr = dm_arr[i0:i1]
            t_start_out = i0 / sr
        else:
            t_start_out = 0.0
    else:
        t_start_out = 0.0
    # Cap at 200k points to avoid multi-MB JSON payloads on very long
    # sweeps; uPlot renders at pixel-width resolution anyway.
    if len(dm_arr) > 200_000:
        stride = int(np.ceil(len(dm_arr) / 200_000))
        dm_arr = dm_arr[::stride]
        dt = stride / sr
    else:
        dt = 1.0 / sr
    return {
        "values": [float(v) for v in dm_arr],
        "dt_s": dt,
        "t_start_s": t_start_out,
        "n_raw_samples": int(len(dm_arr)),
        "method": label,
        **extra,
    }
