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
conversion — values pass through ``scaled(tr)`` (which applies any
user override) and the resulting units are reported back unchanged.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.files import get_current_recording
from utils.scaling import scaled
from analysis.bursts import _apply_pre_detection_filter
from analysis.events import (
    fit_biexponential, render_template,
    compute_rms,
    _sliding_correlation, _deconvolve,  # for /detection_measure
    _gaussian_fit_to_histogram,          # for deconvolution cutoff overlay
    run_events, average_detected_events,
    measure_event_kinetics,              # for /add_manual
    fit_polynomial_baseline,             # for /baseline_curve
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
    values = np.asarray(scaled(tr), dtype=float)
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
    sweep: int                     # primary sweep (used for the DM overlay)
    trace: int
    # Cross-sweep detection. When non-null, detection runs on every
    # sweep in the list, events are concatenated with their sweep
    # index, and the returned detection-measure corresponds to the
    # primary ``sweep`` above (so the overlay on the main viewer
    # stays sensible). Leave null for single-sweep detection.
    sweeps: Optional[list[int]] = None

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
    # Optional rolling-median detrend applied BEFORE the Butterworth
    # filter (and before detection). Subtracts a running median of
    # width ``detrend_window_ms`` — cleaner than a high-pass for
    # baseline drift because it doesn't ring at sharp event edges.
    detrend_enabled: bool = False
    detrend_window_ms: float = 500.0

    # Template-method params
    template: Optional[DetectionTemplate] = None
    # Optional multi-template detection (up to 3). When supplied with ≥
    # 2 entries, the detector uses them as a co-operating set: for
    # correlation, peaks are picked from the pointwise max of the
    # per-template correlation traces; for deconvolution, the union of
    # per-template peak sets is merged under the shared min-IEI rule.
    # Matches Easy Electrophysiology's "Detect with Templates 1/2/3"
    # workflow. Leave empty (or null) to use the single ``template``.
    templates: Optional[list[DetectionTemplate]] = None
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
    # Per-event baseline detection method. 'auto' = Jonas line-intersect
    # + local mean (default). 'polynomial' = fit a low-order polynomial
    # to the whole sweep (event-side tail clipped) and read the
    # baseline off that curve at each foot — drift-aware.
    baseline_method: str = "auto"
    baseline_poly_order: int = 2
    # Decay-endpoint method: 'first_cross' (default) or 'entire'.
    decay_endpoint_method: str = "first_cross"
    # Min biexp R² for retaining an event. None disables.
    biexp_min_r2: Optional[float] = None

    # Exclusion
    amplitude_min_abs: float = 5.0
    amplitude_max_abs: float = 2000.0
    auc_min_abs: Optional[float] = None
    rise_max_ms: Optional[float] = None
    decay_max_ms: Optional[float] = None
    fwhm_max_ms: Optional[float] = None
    # Manual skip regions — list of [start_s, end_s] pairs. Events whose
    # peak falls inside any region get dropped. Intended for stimulus
    # artifacts, perfusion switches, etc. Drawn as red bands in the UI.
    skip_regions: Optional[list[list[float]]] = None

    # Manual edits (in seconds within the sweep)
    manual_added_times: Optional[list[float]] = None
    manual_removed_times: Optional[list[float]] = None

    # If true, the detection measure (correlation / deconvolution
    # trace) is decimated and returned — for the optional overlay
    # subplot. The deconvolution trace is large (N samples) so we
    # only compute + ship it when requested.
    return_detection_measure: bool = False


def _detect_iter(req: "DetectRequest"):
    """Generator core of /detect.

    Yields:
      ``('progress', {sweep_index, completed, total, sweep_id})``
        once per sweep AFTER it finishes processing. Lets the streaming
        endpoint surface "X / N sweeps done" to the UI.
      ``('result', payload)``
        as the final yield, carrying the same dict the synchronous
        /detect endpoint returns to its callers.

    Splitting like this lets ``/detect`` and ``/detect_stream`` share
    every line of detection logic without one calling the other —
    the synchronous endpoint just consumes the generator and returns
    the final payload, the streaming endpoint serializes each yield.
    """
    # Sweep list: either the explicit cross-sweep list, or the single
    # primary sweep. The "primary" sweep is the one whose trace feeds
    # the detection-measure overlay and whose units / sampling-rate
    # bootstrap the response.
    primary = int(req.sweep)
    sweeps: list[int] = list(req.sweeps) if req.sweeps else [primary]
    if primary not in sweeps:
        # Force-include the primary so the DM overlay always has data.
        sweeps = [primary, *sweeps]

    # Preprocess one sweep: detrend → Butterworth filter. Shared helper
    # so cross-sweep detection applies the SAME pipeline to each sweep.
    def _prep_sweep(sw_idx: int) -> tuple[np.ndarray, float, str]:
        vv, sr_i, units_i = _trace_for(req.group, req.series, sw_idx, req.trace)
        if req.detrend_enabled:
            try:
                from scipy.ndimage import median_filter
                w = max(3, int(round(req.detrend_window_ms / 1000.0 * sr_i)))
                if w % 2 == 0:
                    w += 1
                base_i = median_filter(vv, size=w, mode="nearest")
                vv = vv - base_i
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Detrend failed: {e}")
        if req.filter_enabled:
            try:
                vv = _apply_pre_detection_filter(vv, sr_i, {
                    "filter_enabled": True,
                    "filter_type": req.filter_type,
                    "filter_low": req.filter_low,
                    "filter_high": req.filter_high,
                    "filter_order": req.filter_order,
                })
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Filter failed: {e}")
        return vv, sr_i, units_i

    # Render templates once — they don't depend on the sweep.
    # Note: biexp templates are parametric so they'd work at any sampling
    # rate, but `render_template` bakes in the sample count from `sr`.
    # For mixed-sr series this would be wrong; in practice all sweeps in
    # one series share the same sampling rate so using the primary's sr
    # is fine.
    values_primary, sr, units = _prep_sweep(primary)

    template_arr: Optional[np.ndarray] = None
    template_list: Optional[list[np.ndarray]] = None
    if req.method.startswith("template_"):
        if req.templates and len(req.templates) >= 1:
            template_list = [
                render_template(
                    t.b0, t.b1,
                    t.tau_rise_ms / 1000.0, t.tau_decay_ms / 1000.0,
                    t.width_ms, sr,
                )
                for t in req.templates
            ]
            template_arr = template_list[0]
        elif req.template is not None:
            t = req.template
            template_arr = render_template(
                t.b0, t.b1,
                t.tau_rise_ms / 1000.0, t.tau_decay_ms / 1000.0,
                t.width_ms, sr,
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="Template methods require a template payload",
            )

    all_records: list[EventRecord] = []
    primary_dm: Optional[np.ndarray] = None
    # Sweep-length bookkeeping for the response — each event's sweep
    # idx is known, so the frontend can compute total-sweep-duration
    # for cross-sweep rates.
    sweep_lengths_s: dict[int, float] = {}
    total_sweeps = len(sweeps)
    # Threading + queue plumbing so within-sweep progress (kinetics
    # callbacks from ``run_events``) can be yielded while the sync
    # detection function is still running. Without this the generator
    # would only see progress at sweep boundaries — useless for
    # single-sweep detections, which is the common case.
    import queue as _q
    import threading as _th
    for done_count, sw_idx in enumerate(sweeps, start=1):
        # Iterating with ``done_count`` so the progress yield below
        # carries 1-based completion counts (1/N, 2/N, …, N/N).
        if sw_idx == primary:
            vv = values_primary
            sr_i = sr
        else:
            vv, sr_i, _ = _prep_sweep(sw_idx)
        # Manual edits only apply to the user-active sweep — cross-
        # sweep mass detection should run clean on the rest.
        added_times = req.manual_added_times if sw_idx == primary else None
        removed_times = req.manual_removed_times if sw_idx == primary else None

        # Per-sweep progress fraction maps into the band
        # ``[(done_count-1)/N, done_count/N]`` of overall progress.
        sweep_base = (done_count - 1) / total_sweeps
        sweep_span = 1.0 / total_sweeps

        # Bridge ``run_events``'s progress callback (called from the
        # worker thread) to the generator (which yields). Items on
        # the queue are floats in [0, 1] = within-sweep fraction; the
        # sentinel ``None`` means the worker finished.
        progress_q: '_q.Queue[Optional[float]]' = _q.Queue()
        worker_result: dict = {}

        def _worker(_vv=vv, _sr_i=sr_i, _added=added_times,
                    _removed=removed_times, _sw=sw_idx, _q=progress_q,
                    _holder=worker_result):
            try:
                recs, dm = run_events(
                    _vv, _sr_i,
                    method=req.method,
                    template=template_arr,
                    templates=template_list,
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
                    baseline_method=req.baseline_method,
                    baseline_poly_order=req.baseline_poly_order,
                    decay_endpoint_method=req.decay_endpoint_method,
                    biexp_min_r2=req.biexp_min_r2,
                    amplitude_min_abs=req.amplitude_min_abs,
                    amplitude_max_abs=req.amplitude_max_abs,
                    auc_min_abs=req.auc_min_abs,
                    rise_max_ms=req.rise_max_ms,
                    decay_max_ms=req.decay_max_ms,
                    fwhm_max_ms=req.fwhm_max_ms,
                    skip_regions=req.skip_regions,
                    manual_added_times=_added,
                    manual_removed_times=_removed,
                    sweep_index=_sw,
                    progress_cb=lambda f: _q.put(float(f)),
                )
                _holder['records'] = recs
                _holder['dm'] = dm
            except Exception as exc:  # noqa: BLE001
                _holder['error'] = exc
            finally:
                _q.put(None)

        worker = _th.Thread(target=_worker, daemon=True)
        worker.start()

        # Drain progress events as they arrive. Each tick re-emits a
        # combined ``progress`` event with the overall fraction.
        last_within = 0.0
        while True:
            within = progress_q.get()
            if within is None:
                break
            # Coalesce: if the queue has a backlog (worker is faster
            # than the consumer), skip ahead to the latest fraction
            # so the UI sees recent state, not stale ones.
            try:
                while True:
                    next_within = progress_q.get_nowait()
                    if next_within is None:
                        # Sentinel — replay it after the loop body so
                        # the outer while exits cleanly.
                        progress_q.put(None)
                        break
                    within = next_within
            except _q.Empty:
                pass
            if within < last_within:
                # Clamp to monotonic — a rare case where the worker
                # ticks 0.30 (start of kinetics) AFTER an earlier
                # higher tick gets requeued shouldn't make the bar
                # jump backwards.
                within = last_within
            last_within = within
            yield ('progress', {
                'sweep_id': int(sw_idx),
                'completed': int(done_count - 1),
                'total': int(total_sweeps),
                'fraction': float(sweep_base + sweep_span * within),
                'events_so_far': len(all_records),
            })

        worker.join()
        if 'error' in worker_result:
            exc = worker_result['error']
            if isinstance(exc, ValueError):
                raise HTTPException(status_code=400, detail=str(exc))
            raise exc

        recs_i = worker_result['records']
        dm_i = worker_result['dm']
        all_records.extend(recs_i)
        sweep_lengths_s[sw_idx] = float(len(vv)) / sr_i
        if sw_idx == primary:
            primary_dm = dm_i

        # Final per-sweep tick (in case the within-sweep callbacks
        # didn't reach 1.0 for the last batch).
        yield ('progress', {
            'sweep_id': int(sw_idx),
            'completed': int(done_count),
            'total': int(total_sweeps),
            'fraction': float(done_count) / float(total_sweeps),
            'events_so_far': len(all_records),
        })

    # Sort merged records by (sweep, peak_time) so the table is
    # consistent across re-runs.
    all_records.sort(key=lambda r: (r.sweep, r.peak_time_s))
    events_out = [r.to_dict() for r in all_records]
    dm = primary_dm

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

    # Total duration across all sweeps that contributed events —
    # lets the frontend compute cross-sweep rates without a re-fetch.
    total_len_s = float(sum(sweep_lengths_s.values()))
    yield ('result', {
        "events": events_out,
        "n_events": len(events_out),
        "sampling_rate": sr,
        "units": units,
        "sweep_length_s": sweep_lengths_s.get(primary, total_len_s),
        "total_length_s": total_len_s,
        "sweeps_analysed": sorted(sweep_lengths_s.keys()),
        "detection_measure": dm_payload,
    })


@router.post("/detect")
async def detect(req: DetectRequest):
    """Synchronous detection. Drains :func:`_detect_iter` and returns
    the final result payload — backwards-compatible with all existing
    callers."""
    final = None
    for kind, payload in _detect_iter(req):
        if kind == 'result':
            final = payload
    if final is None:
        # Should never happen — _detect_iter always yields a 'result'
        # last unless it raised mid-flight. Treat as 500.
        raise HTTPException(status_code=500, detail="Detection produced no result")
    return final


@router.post("/detect_stream")
async def detect_stream(req: DetectRequest):
    """Streaming detection. Returns an ``application/x-ndjson`` body
    with one JSON object per line:

    * ``{"type": "progress", ...}`` — emitted after each sweep
      finishes processing. Carries ``completed`` / ``total`` /
      ``fraction`` so the UI can drive a progress fill on the RUN
      button without polling.
    * ``{"type": "result", "data": {...}}`` — emitted last. ``data``
      is the same payload :func:`detect` returns synchronously.

    NDJSON over POST (rather than SSE) because Server-Sent Events'
    EventSource API is GET-only; the detect request body is large
    (params + manual edits + skip regions + multi-templates) so POST
    is the right verb.
    """
    from fastapi.responses import StreamingResponse
    import json as _json

    def _stream():
        try:
            for kind, payload in _detect_iter(req):
                if kind == 'progress':
                    yield _json.dumps({"type": "progress", **payload}) + "\n"
                elif kind == 'result':
                    yield _json.dumps({"type": "result", "data": payload}) + "\n"
        except HTTPException as exc:
            # Surface as a final error line so the client can
            # display a clean message instead of having to parse a
            # half-streamed body.
            yield _json.dumps({"type": "error",
                               "status": exc.status_code,
                               "detail": str(exc.detail)}) + "\n"
        except Exception as exc:  # noqa: BLE001 — graceful failure
            yield _json.dumps({"type": "error",
                               "status": 500,
                               "detail": f"{type(exc).__name__}: {exc}"}) + "\n"

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        # Disable buffering so the browser sees each line as it's
        # written. Without this, nginx-style intermediate proxies
        # could batch the whole response. (Electron talks directly
        # to uvicorn so this is mostly future-proofing.)
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


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
    #
    # IMPORTANT — biexp cannot fit a "flat baseline + rise + decay"
    # shape because the (1−exp(−t/τ_r))·exp(−t/τ_d) factor always
    # rises from t=0. If we start the fit window far before the
    # actual rise, curve_fit lands on degenerate parameters (very
    # slow τ_decay + very slow τ_rise to keep the model near b0 for
    # the flat prefix). That's exactly the "τ_decay jumps from 5 ms
    # to 270 ms when window_before_ms goes from 5 → 7" failure mode
    # users reported. Guard: cap how far back from the peak the foot
    # is allowed to sit.
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
        # Cap the walk-back: the fit window must start no more than
        # ``max_pre_ms`` before the extremum. Prevents degenerate fits
        # when the user-chosen pre-peak window is longer than one rise
        # time (the averaged baseline is cleaner → trigger is close to
        # baseline → walk-back reaches the pre-event noise floor).
        max_pre_ms = max(req.initial_rise_ms * 4.0, 2.0)
        min_foot_i = max(0, ex_idx - int(round(max_pre_ms / 1000.0 * sr)))
        if foot_i < min_foot_i:
            foot_i = min_foot_i
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
# /add_manual — measure a single user-clicked event (no full re-detection)
# ---------------------------------------------------------------------------

class AddManualRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    click_time_s: float            # where the user clicked on the viewer
    direction: str = "negative"
    # Half-window around the click in which to snap to the local
    # extremum. 5 ms default — wide enough to catch a click that
    # landed on the rise/decay shoulder, narrow enough that we don't
    # accidentally snap into a neighbouring event.
    snap_window_ms: float = 5.0
    # Kinetics knobs — same meaning as run_events; expose so the
    # per-event measurement here matches the rest of the results table.
    baseline_search_ms: float = 10.0
    avg_baseline_ms: float = 1.0
    avg_peak_ms: float = 1.0
    rise_low_pct: float = 10.0
    rise_high_pct: float = 90.0
    decay_pct: float = 37.0
    decay_search_ms: float = 30.0
    # Optional pre-detection filter (matches /detect) — apply the same
    # filter the user has on the main viewer so the snap + kinetics see
    # the filtered trace, not the raw one.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4


@router.post("/add_manual")
async def add_manual(req: AddManualRequest):
    """Measure a single event at a user-clicked time.

    Purpose: the main events window lets the user click on the viewer
    to add an event the detector missed. Running the full detection
    pipeline again just to slot in one extra peak is slow (seconds on
    long sweeps). This endpoint is the fast path — it snaps the click
    to the local extremum and runs ``measure_event_kinetics`` on that
    single peak, returning one ``EventRecord`` the frontend can splice
    into its results table directly.
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

    n = len(values)
    if n < 4:
        raise HTTPException(status_code=400, detail="Sweep too short")

    click_i = int(round(req.click_time_s * sr))
    if click_i < 0 or click_i >= n:
        raise HTTPException(status_code=400, detail="Click time outside sweep")

    # Snap to local extremum in a ±snap_window half-window.
    snap = max(1, int(round(req.snap_window_ms / 1000.0 * sr)))
    a = max(0, click_i - snap)
    b = min(n, click_i + snap + 1)
    local = values[a:b]
    if req.direction == "negative":
        rel = int(np.argmin(local))
    else:
        rel = int(np.argmax(local))
    peak_idx = a + rel

    kin = measure_event_kinetics(
        values, sr, peak_idx,
        direction=req.direction,
        baseline_search_ms=req.baseline_search_ms,
        avg_baseline_ms=req.avg_baseline_ms,
        avg_peak_ms=req.avg_peak_ms,
        rise_low_pct=req.rise_low_pct,
        rise_high_pct=req.rise_high_pct,
        decay_pct=req.decay_pct,
        decay_search_ms=req.decay_search_ms,
    )

    rec = EventRecord(
        sweep=req.sweep,
        peak_idx=kin.peak_idx,
        peak_time_s=float(kin.peak_idx) / sr,
        peak_val=kin.peak_val,
        foot_idx=kin.foot_idx,
        foot_time_s=float(kin.foot_idx) / sr,
        baseline_val=kin.baseline_val,
        amplitude=kin.amplitude,
        rise_time_ms=kin.rise_time_ms,
        decay_time_ms=kin.decay_time_ms,
        half_width_ms=kin.half_width_ms,
        auc=kin.auc,
        decay_endpoint_idx=kin.decay_endpoint_idx,
        manual=True,
    )
    return {"event": rec.to_dict()}


# ---------------------------------------------------------------------------
# /edit_kinetics — re-measure ONE event with manual foot / decay overrides
# ---------------------------------------------------------------------------

class EditKineticsRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    direction: str = "negative"
    # The peak the user wants to re-measure. Frontend sends the index
    # (sample) that's already on the event; we don't refine it again.
    peak_idx: int
    # User's new landmark — exactly one is set per request. Null means
    # "leave the auto-detected one in place" (so the frontend can pick
    # which kinetic to override without sending the other one).
    foot_time_s: Optional[float] = None
    decay_endpoint_time_s: Optional[float] = None
    # Pre-detection pipeline — must match what was used during the
    # original detection so the trace seen here is the same one the
    # event was measured on. Frontend forwards the active params.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4
    detrend_enabled: bool = False
    detrend_window_ms: float = 500.0
    # Kinetics knobs — same as /detect; passed through to
    # measure_event_kinetics so the recompute matches the original.
    baseline_search_ms: float = 10.0
    avg_baseline_ms: float = 1.0
    avg_peak_ms: float = 0.0
    rise_low_pct: float = 10.0
    rise_high_pct: float = 90.0
    decay_pct: float = 37.0
    decay_search_ms: float = 30.0
    decay_endpoint_method: str = "first_cross"


@router.post("/edit_kinetics")
async def edit_kinetics(req: EditKineticsRequest):
    """Re-measure a single event with a user-supplied foot / endpoint.

    The Edit-Kinetics drag mode in the events browser sends one of
    these on each click. We rebuild the same trace the detector saw
    (detrend → filter), then re-run ``measure_event_kinetics`` on the
    event's existing peak with the override applied. Returns one full
    event row the frontend can splice in to replace the old one.
    """
    values, sr, _units = _trace_for(req.group, req.series, req.sweep, req.trace)
    if req.detrend_enabled:
        try:
            from scipy.ndimage import median_filter
            w = max(3, int(round(req.detrend_window_ms / 1000.0 * sr)))
            if w % 2 == 0:
                w += 1
            base = median_filter(values, size=w, mode="nearest")
            values = values - base
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Detrend failed: {e}")
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
    n = len(values)
    foot_override = (int(round(req.foot_time_s * sr))
                     if req.foot_time_s is not None else None)
    decay_override = (int(round(req.decay_endpoint_time_s * sr))
                      if req.decay_endpoint_time_s is not None else None)
    kin = measure_event_kinetics(
        np.asarray(values, dtype=float), sr, int(req.peak_idx),
        direction=req.direction,
        baseline_search_ms=req.baseline_search_ms,
        avg_baseline_ms=req.avg_baseline_ms,
        avg_peak_ms=req.avg_peak_ms,
        rise_low_pct=req.rise_low_pct,
        rise_high_pct=req.rise_high_pct,
        decay_pct=req.decay_pct,
        decay_search_ms=req.decay_search_ms,
        decay_endpoint_method=req.decay_endpoint_method,
        foot_idx_override=foot_override,
        decay_endpoint_idx_override=decay_override,
    )
    rec = EventRecord(
        sweep=req.sweep,
        peak_idx=kin.peak_idx,
        peak_time_s=float(kin.peak_idx) / sr,
        peak_val=kin.peak_val,
        foot_idx=kin.foot_idx,
        foot_time_s=float(kin.foot_idx) / sr,
        baseline_val=kin.baseline_val,
        amplitude=kin.amplitude,
        rise_time_ms=kin.rise_time_ms,
        decay_time_ms=kin.decay_time_ms,
        half_width_ms=kin.half_width_ms,
        auc=kin.auc,
        decay_endpoint_idx=kin.decay_endpoint_idx,
        decay_tau_ms=kin.decay_tau_ms,
        biexp_tau_rise_ms=kin.biexp_tau_rise_ms,
        biexp_tau_decay_ms=kin.biexp_tau_decay_ms,
        biexp_b0=kin.biexp_b0,
        biexp_b1=kin.biexp_b1,
        biexp_r2=kin.biexp_r2,
        manual=True,
    )
    _ = n  # keep n referenced for clarity; clamping happens inside measure_event_kinetics
    return {"event": rec.to_dict()}


# ---------------------------------------------------------------------------
# /overlay — stack all events aligned on peak / foot for QC display
# ---------------------------------------------------------------------------

class OverlayEventRef(BaseModel):
    peak_idx: int
    foot_idx: int
    baseline_val: float


class OverlayRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    events: list[OverlayEventRef]
    align: str = "peak"              # 'peak' | 'foot'
    window_before_ms: float = 5.0
    window_after_ms: float = 50.0
    baseline_subtract: bool = True   # subtract each event's baseline so
                                     # overlays share a common zero line
    # Optional pre-detection filter — when on, the sweep is filtered
    # with the same Butterworth settings the detector used, so the
    # overlay window matches the signal the detector saw. Off → raw
    # unfiltered trace. Lets users A/B compare raw vs filtered shapes
    # from the browser and overlay tabs.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 1000.0
    filter_order: int = 1


@router.post("/overlay")
async def overlay(req: OverlayRequest):
    """Return a stack of all events aligned on the chosen anchor.

    Companion to the Overlay tab in the main events window. Each event
    gets its window extracted from the raw trace (with baseline
    subtracted by default), aligned, and returned alongside the
    sample-wise mean + ±1 SD envelope.

    Events whose window would extend past the sweep's ends are
    skipped rather than zero-padded — padding would bias the mean.
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
    n_before = max(0, int(round(req.window_before_ms / 1000.0 * sr)))
    n_after = max(1, int(round(req.window_after_ms / 1000.0 * sr)))
    n_total = n_before + n_after + 1
    time = (np.arange(n_total, dtype=float) - n_before) / sr

    traces: list[list[Optional[float]]] = []
    stack: list[np.ndarray] = []
    for e in req.events:
        ref = int(e.peak_idx) if req.align == "peak" else int(e.foot_idx)
        a = ref - n_before
        b = ref + n_after + 1
        if a < 0 or b > len(values):
            traces.append([None] * n_total)   # keep row to match entry.events count
            continue
        seg = np.asarray(values[a:b], dtype=float)
        if req.baseline_subtract:
            seg = seg - float(e.baseline_val)
        stack.append(seg)
        traces.append([float(x) for x in seg])

    if stack:
        arr = np.asarray(stack, dtype=float)
        mean_arr = np.mean(arr, axis=0)
        sd_arr = np.std(arr, axis=0, ddof=1) if arr.shape[0] > 1 else np.zeros_like(mean_arr)
        mean_out: list[Optional[float]] = [float(x) for x in mean_arr]
        sd_lo: list[Optional[float]] = [float(m - s) for m, s in zip(mean_arr, sd_arr)]
        sd_hi: list[Optional[float]] = [float(m + s) for m, s in zip(mean_arr, sd_arr)]
    else:
        mean_out = [None] * n_total
        sd_lo = [None] * n_total
        sd_hi = [None] * n_total

    return {
        "time_s": [float(t) for t in time],
        "traces": traces,
        "mean": mean_out,
        "sd_lo": sd_lo,
        "sd_hi": sd_hi,
        "n_included": len(stack),
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
    # Cap at 500k points to avoid multi-MB JSON payloads on very long
    # sweeps; uPlot renders at pixel-width resolution anyway. At 20 kHz
    # this is 25 s of sample-for-sample data — longer viewports fall
    # back to a small stride, which users are unlikely to perceive
    # since the events they care about are tens of ms wide.
    if len(dm_arr) > 500_000:
        stride = int(np.ceil(len(dm_arr) / 500_000))
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


# ---------------------------------------------------------------------------
# /baseline_curve — polynomial baseline curve for visualization
# ---------------------------------------------------------------------------

class BaselineCurveRequest(BaseModel):
    """Inputs for the polynomial-baseline overlay shown on the events
    viewer when ``baseline_method == 'polynomial'``. Mirrors the
    ``/detection_measure`` endpoint's preprocessing pipeline (detrend →
    Butterworth filter) so the curve is computed on the EXACT trace
    detection runs against, not the raw signal."""
    group: int
    series: int
    sweep: int
    trace: int
    direction: str = "negative"
    poly_order: int = 2
    # Same pre-processing pipeline as /detect.
    filter_enabled: bool = False
    filter_type: str = "bandpass"
    filter_low: float = 1.0
    filter_high: float = 500.0
    filter_order: int = 4
    detrend_enabled: bool = False
    detrend_window_ms: float = 500.0
    # Optional viewport slicing (full sample-rate); when omitted the
    # whole sweep is returned (decimated if it would exceed the cap).
    t_start_s: Optional[float] = None
    t_end_s: Optional[float] = None


@router.post("/baseline_curve")
async def baseline_curve(req: BaselineCurveRequest):
    """Return the polynomial baseline curve for one sweep (decimated).

    The polynomial fit runs on the WHOLE sweep so the curve at the
    edges is anchored — slicing at the request stage would bias the fit
    toward whichever end of the viewport the user is looking at. Same
    decimation cap as ``/detection_measure`` (500k points).
    """
    values, sr, _units = _trace_for(req.group, req.series, req.sweep, req.trace)
    # Match the run_events preprocessing pipeline exactly: detrend
    # (rolling median) then bandpass / lowpass / highpass.
    if req.detrend_enabled:
        try:
            from scipy.ndimage import median_filter
            w = max(3, int(round(req.detrend_window_ms / 1000.0 * sr)))
            if w % 2 == 0:
                w += 1
            base = median_filter(values, size=w, mode="nearest")
            values = values - base
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Detrend failed: {e}")
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

    try:
        curve = fit_polynomial_baseline(
            np.asarray(values, dtype=float), float(sr),
            int(req.poly_order), req.direction,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Polynomial fit failed: {e}")

    n = len(curve)
    if req.t_start_s is not None and req.t_end_s is not None:
        i0 = max(0, int(round(req.t_start_s * sr)))
        i1 = min(n, int(round(req.t_end_s * sr)) + 1)
        if i1 > i0:
            curve_out = curve[i0:i1]
            t_start_out = i0 / sr
        else:
            curve_out = curve
            t_start_out = 0.0
    else:
        curve_out = curve
        t_start_out = 0.0

    if len(curve_out) > 500_000:
        stride = int(np.ceil(len(curve_out) / 500_000))
        curve_out = curve_out[::stride]
        dt = stride / sr
    else:
        dt = 1.0 / sr
    return {
        "values": [float(v) for v in curve_out],
        "dt_s": float(dt),
        "t_start_s": float(t_start_out),
        "n_raw_samples": int(len(curve_out)),
        "poly_order": int(req.poly_order),
    }
