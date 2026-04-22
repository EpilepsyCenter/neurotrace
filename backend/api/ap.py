"""Action Potentials API endpoints.

Three endpoints:

- ``POST /api/ap/run`` — full pipeline. Takes a JSON body with the
  detection params, kinetics params, optional manual edits, and
  rheobase mode. Returns per-sweep + per-spike results, F-I curve,
  and rheobase.

- ``GET /api/ap/phase_plot`` — Vm vs dV/dt slice around one spike,
  computed on demand. Takes the spike's peak time so the call site
  doesn't have to re-detect.

- ``GET /api/ap/auto_im_params`` — best-effort guess at ramp
  parameters parsed from the ``.pgf`` stimulus tree. Used by the
  frontend to prefill the ramp-rheobase inputs when the user has
  no Im channel recorded.

POST is used for ``/run`` because the param surface is large enough
(detection, kinetics, ramp, manual edits) that a query string would
be unwieldy. The other two endpoints stay GET — both have a small
parameter set.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.files import get_current_recording
from api.fpsp import _stim_for_series, _detect_stim_onset_s
from analysis.ap import run_ap, phase_plot_for_spike

router = APIRouter()


# ---------------------------------------------------------------------------
# /run — full AP pipeline
# ---------------------------------------------------------------------------

class APRunRequest(BaseModel):
    """All inputs for one /api/ap/run call."""
    group: int
    series: int
    trace: int
    im_trace: Optional[int] = None
    # When the Im channel lives on a different series than Vm (a
    # common HEKA pattern — separate "current-monitoring" series),
    # this points at that series. Defaults to the same series as Vm.
    im_series: Optional[int] = None
    sweeps: Optional[list[int]] = None
    detection: dict = {}
    kinetics: dict = {}
    rheobase_mode: str = "record"
    ramp_params: Optional[dict] = None
    manual_edits: Optional[dict] = None
    measure_kinetics: bool = True


@router.post("/run")
async def ap_run(req: APRunRequest):
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

    # Im source. Three layouts the AP window supports:
    #
    # 1. Recorded Im on the same series as Vm (im_series=None, im_trace>=0).
    # 2. Recorded Im on a parallel series (im_series=N, im_trace>=0).
    # 3. *Synthesised* Im from the .pgf stimulus protocol when no
    #    real Im was recorded (im_trace=-1). For current-clamp this
    #    is what the user sees as "the current step / ramp" in the
    #    main viewer. We rebuild the DA waveform per sweep using the
    #    pgf channel's `reconstruct_sweep`.
    SYNTHESISE_IM = -1
    use_synth = req.im_trace == SYNTHESISE_IM
    im_ser = None
    if req.im_trace is not None and not use_synth:
        try:
            im_ser = grp.series_list[req.im_series if req.im_series is not None else req.series]
        except IndexError:
            raise HTTPException(status_code=400, detail="Invalid im_series index")

    # Pull Vm + (optionally) Im traces. We assume every sweep has the
    # same channel layout — if not, the affected sweeps just produce
    # empty arrays and the analysis silently skips them. Sampling rate
    # is taken from the primary trace of the first valid sweep.
    sweeps_vm: list[np.ndarray] = []
    sweeps_im: Optional[list[np.ndarray]] = [] if req.im_trace is not None else None
    sr: float = 0.0

    # Lazily look up the .pgf channel for synthesis mode. Picked once,
    # reused per sweep. Falls back to a noop if no .pgf data is
    # present (older Patchmaster versions don't write one).
    synth_channel = None
    synth_value_factor = 1.0  # multiplier from raw channel values → pA
    if use_synth:
        target = _stim_for_series(rec, req.group, req.series)
        if target is not None:
            # Layered current-channel pick:
            # 1) Channels in current-clamp ampl_mode (== 2). HEKA
            #    sets this on the active CC DAC reliably.
            # 2) Channels whose DAC unit string explicitly says
            #    A / Amp / Ampere.
            # 3) Sanity: pick the result whose actual values look
            #    like biological currents (< 1 µA in magnitude). If
            #    we wind up with a value that's clearly a voltage in
            #    SI volts (~0.05 = 50 mV), bail.
            def _is_current_unit(u: str) -> bool:
                u = (u or "").strip().upper()
                return u in ("A", "AMP", "AMPS", "AMPERE", "AMPERES")

            cc_channels = [
                ch for ch in target.channels
                if ch.segments and getattr(ch, "is_current_clamp", False)
            ]
            unit_channels = [
                ch for ch in target.channels
                if ch.segments and _is_current_unit(ch.dac_unit)
            ]
            # Combine, deduplicating; prefer CC-mode channels first.
            seen = set()
            candidates: list = []
            for ch in cc_channels + unit_channels:
                if id(ch) in seen:
                    continue
                seen.add(id(ch))
                candidates.append(ch)

            # Tie-break across candidates: widest range across first/
            # middle/last sweep wins (sweep 0 of a CC step protocol
            # is often 0 pA — checking sweep 0 alone misses the
            # active channel entirely).
            n_sw = ser.sweep_count
            probe_sweeps = sorted({0, n_sw // 2, n_sw - 1})
            best, best_score = None, -1.0
            for ch in candidates:
                max_range = 0.0
                for sw in probe_sweeps:
                    if sw < 0 or sw >= n_sw:
                        continue
                    try:
                        lvls = [seg.voltage_at_sweep(sw) for seg in ch.segments]
                    except Exception:
                        continue
                    if not lvls:
                        continue
                    rng = max(abs(v) for v in lvls)
                    if rng > max_range:
                        max_range = rng
                store_bonus = 2.0 if ch.do_write else 1.0
                score = max_range * store_bonus + 1e-30  # tiebreak ≥ 0
                if score > best_score:
                    best_score = score; best = ch

            # Final gate: require the unit string to be a current
            # explicitly. Values are stored in nA (50 pA → 0.05),
            # so a magnitude check is mostly redundant — the unit
            # string is the canonical signal.
            if best is not None and not _is_current_unit(best.dac_unit):
                best = None
            synth_channel = best

    for si in sweep_indices:
        sw = ser.sweeps[si]
        if req.trace < 0 or req.trace >= sw.trace_count:
            sweeps_vm.append(np.zeros(0))
            if sweeps_im is not None:
                sweeps_im.append(np.zeros(0))
            continue
        tr = sw.traces[req.trace]
        sweeps_vm.append(np.asarray(tr.data, dtype=float))
        if sr <= 0 and tr.sampling_rate > 0:
            sr = float(tr.sampling_rate)
        if sweeps_im is not None:
            if use_synth and synth_channel is not None and tr.sampling_rate > 0:
                # PgfSegment values are stored in nA (not SI A as the
                # dataclass docstring claims). Convert nA → pA = ×1000.
                # api/traces.py uses the same factor for stim overlay.
                wave = synth_channel.reconstruct_sweep(si, 1.0 / float(tr.sampling_rate))
                sweeps_im.append(np.asarray(wave, dtype=float) * 1000.0)
            elif im_ser is not None:
                # Pull the corresponding sweep from the Im series. If
                # the Im series has fewer sweeps than Vm's selection,
                # or the trace index is out of range, pad with empty
                # so rheobase / F-I just skip that sweep.
                if si < im_ser.sweep_count and 0 <= (req.im_trace or 0) < im_ser.sweeps[si].trace_count:
                    im_sw = im_ser.sweeps[si]
                    im_tr = im_sw.traces[req.im_trace]  # type: ignore[index]
                    sweeps_im.append(np.asarray(im_tr.data, dtype=float))
                else:
                    sweeps_im.append(np.zeros(0))
            else:
                sweeps_im.append(np.zeros(0))

    if sr <= 0:
        raise HTTPException(status_code=400, detail="No valid sweeps in selection")

    # Stim onset (used for first-spike latency only; rheobase 'exact'
    # uses the actual Im channel sample rather than this).
    im_onset_s: Optional[float] = None
    target = _stim_for_series(rec, req.group, req.series)
    if target is not None:
        try:
            im_onset_s = float(_detect_stim_onset_s(target))
        except Exception:
            im_onset_s = None

    # Default bounds_end_s to the Vm sweep length when not provided —
    # mirrors how FPsp handles "no end set".
    detection = dict(req.detection)
    if not detection.get("bounds_end_s"):
        detection["bounds_end_s"] = sweeps_vm[0].size / sr if sweeps_vm[0].size else 0.0

    result = run_ap(
        sweeps_vm=sweeps_vm,
        sweeps_im=sweeps_im,
        sweep_indices=sweep_indices,
        sr=sr,
        detection=detection,
        kinetics=req.kinetics or {},
        rheobase_mode=req.rheobase_mode,
        ramp_params=req.ramp_params,
        im_onset_s=im_onset_s,
        manual_edits=req.manual_edits,
        measure_kinetics=req.measure_kinetics,
    )

    # Synth-Im patch: for step protocols the per-sweep Im mean over
    # [bounds_start_s, bounds_end_s] (typically the full sweep) is
    # diluted by long stretches at holding (0 pA) and collapses
    # toward zero. F-I points then all stack at x ≈ 0. Recompute
    # im_mean from the most-active stim segment for each sweep, and
    # rebuild the F-I curve from those step-level values. Spike
    # counts/rates are not changed.
    if use_synth and synth_channel is not None and sweeps_im is not None:
        new_fi_im: list[float] = []
        new_fi_rate: list[float] = []
        new_fi_sweep: list[int] = []
        for i, sweep_idx in enumerate(sweep_indices):
            # Find the dominant non-trivial segment for this sweep.
            t = 0.0
            step_t0 = step_t1 = None
            best_abs = 0.0
            for seg in synth_channel.segments:
                try:
                    dur = seg.duration_at_sweep(sweep_idx)
                    level = seg.voltage_at_sweep(sweep_idx)
                except Exception:
                    continue
                if dur > 0 and abs(level) > best_abs:
                    best_abs = abs(level)
                    step_t0 = t
                    step_t1 = t + dur
                t += dur
            if step_t0 is None or i >= len(sweeps_im):
                continue
            i0 = max(0, int(round(step_t0 * sr)))
            i1 = min(sweeps_im[i].size, int(round(step_t1 * sr)))
            if i1 <= i0:
                continue
            step_im = float(np.mean(sweeps_im[i][i0:i1]))
            ps = result["per_sweep"][i]
            ps["im_mean_pa"] = step_im
            if ps.get("spike_rate_hz") is not None:
                new_fi_im.append(step_im)
                new_fi_rate.append(ps["spike_rate_hz"])
                new_fi_sweep.append(int(sweep_idx))
        if new_fi_im:
            result["fi_curve"] = {"im": new_fi_im, "rate": new_fi_rate, "sweep": new_fi_sweep}

    result["sampling_rate"] = sr
    result["im_onset_s"] = im_onset_s
    return result


# ---------------------------------------------------------------------------
# /phase_plot — Vm vs dV/dt around one spike
# ---------------------------------------------------------------------------

@router.get("/phase_plot")
async def ap_phase_plot(
    group: int = Query(...),
    series: int = Query(...),
    trace: int = Query(...),
    sweep: int = Query(...),
    peak_t_s: float = Query(..., description="Time of the spike's peak (seconds within sweep)"),
    window_ms: float = Query(5.0, description="Half-width of the slice around the peak"),
    interp_factor: int = Query(10, ge=1, le=200, description="1 = no upsampling; 10 = 10× cubic-style interp"),
):
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    if sweep < 0 or sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail="Sweep out of range")
    sw = ser.sweeps[sweep]
    if trace < 0 or trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail="Trace out of range")
    tr = sw.traces[trace]
    return phase_plot_for_spike(
        np.asarray(tr.data, dtype=float),
        float(tr.sampling_rate),
        peak_t_s=peak_t_s,
        window_ms=window_ms,
        interp_factor=interp_factor,
    )


# ---------------------------------------------------------------------------
# /auto_im_params — read step / ramp params from .pgf for prefill
# ---------------------------------------------------------------------------

@router.get("/auto_im_params")
async def ap_auto_im_params(
    group: int = Query(...),
    series: int = Query(...),
):
    """Return either a step or ramp description parsed from the
    stimulation protocol, or ``{type: 'none'}`` if nothing useful is
    on the .pgf side. Used to prefill the manual ramp-rheobase inputs
    in the AP window when the recording has no Im channel.

    The .pgf channel structure is shared with FPsp/IV — we lean on
    ``_stim_for_series`` + the segment list to identify a step or ramp.
    """
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    target = _stim_for_series(rec, group, series)
    if target is None:
        return {"type": "none"}

    # Walk segments on the most-active channel; classify the first
    # nonzero segment as either a constant step (level uniform) or a
    # ramp (linearly varying). Heuristics are intentionally simple —
    # the user can always override via the manual ramp inputs.
    n_sweeps = ser.sweep_count
    best_channel = None
    best_score = -1.0
    for ch in target.channels:
        if not ch.segments:
            continue
        # Score: how much the channel level varies across sweeps for
        # any one segment. A current ramp typically varies sweep-to-
        # sweep on at least one step.
        score = 0.0
        for seg in ch.segments:
            try:
                lv0 = seg.voltage_at_sweep(0)
                lvN = seg.voltage_at_sweep(max(0, n_sweeps - 1))
                score = max(score, abs(lvN - lv0))
            except Exception:
                pass
        if score > best_score:
            best_score = score; best_channel = ch
    if best_channel is None:
        return {"type": "none"}

    # Find the first significant segment. Detect ramp by checking if
    # the start and end levels differ within the SAME sweep (the
    # PgfSegment carries that distinction).
    t = 0.0
    for seg in best_channel.segments:
        try:
            dur = seg.duration_at_sweep(0)
            level0 = seg.voltage_at_sweep(0)
        except Exception:
            continue
        if dur <= 0:
            continue
        # Heuristic ramp detection — if the segment carries distinct
        # start/end voltages on a single sweep, it's a ramp.
        try:
            level_end = getattr(seg, "voltage_end_at_sweep", None)
            end_level = level_end(0) if callable(level_end) else level0
        except Exception:
            end_level = level0
        if abs(level0 - end_level) > 1e-9:
            return {
                "type": "ramp",
                "t_start_s": float(t),
                "t_end_s": float(t + dur),
                "im_start_pa": float(level0),
                "im_end_pa": float(end_level),
            }
        if abs(level0) > 1e-9:
            # Plain step — reported as a step type with the constant
            # current and the segment timing. The frontend can decide
            # whether to use it.
            return {
                "type": "step",
                "t_start_s": float(t),
                "t_end_s": float(t + dur),
                "im_pa": float(level0),
            }
        t += dur

    return {"type": "none"}
