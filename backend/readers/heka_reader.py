"""HEKA Patchmaster .dat file reader using myokit's PatchMasterFile.

Myokit provides a robust, well-tested parser for HEKA's bundled .dat format,
handling endianness, version differences, and the full tree hierarchy
(Group > Series > Sweep > Trace) with amplifier metadata.

Install: pip install myokit
"""

from __future__ import annotations

import os
import warnings

import numpy as np

from .base import BaseReader
from .models import Recording, Group, Series, StimulusInfo, StimulusSegment, Sweep, Trace


class HekaReader(BaseReader):
    """Reader for HEKA Patchmaster .dat bundle files."""

    @staticmethod
    def can_read(file_path: str) -> bool:
        if not file_path.lower().endswith(".dat"):
            return False
        try:
            with open(file_path, "rb") as f:
                magic = f.read(4)
                return magic in (b"DATA", b"DAT1", b"DAT2")
        except (IOError, OSError):
            return False

    def read(self, file_path: str) -> Recording:
        from myokit.formats.heka import PatchMasterFile

        recording = Recording(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            format="HEKA",
        )

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                pf = PatchMasterFile(file_path)
        except Exception as e:
            raise IOError(f"Failed to open HEKA file: {e}") from e

        try:
            self._parse_patchmaster(pf, recording)
        finally:
            pf.close()

        return recording

    def _parse_patchmaster(self, pf, recording: Recording):
        """Walk the PatchMasterFile tree and populate our data model."""

        for group_idx, pm_group in enumerate(pf):
            group = Group(
                index=group_idx,
                label=pm_group.label() or f"Group {group_idx + 1}",
            )

            for series_idx, pm_series in enumerate(pm_group):
                series = Series(
                    index=series_idx,
                    label=pm_series.label() or f"Series {series_idx + 1}",
                )

                # Extract amplifier metadata if available.
                # myokit returns convenient units: Rs in MOhm, Cm in pF, Vh in mV.
                try:
                    amp = pm_series.amplifier_state()
                    if amp is not None:
                        rs = amp.r_series()
                        if rs is not None and rs > 0:
                            series.rs = float(rs)  # already MOhm

                        cm = amp.c_slow()
                        if cm is not None and cm > 0:
                            series.cm = float(cm)  # already pF

                        vh = amp.v_hold()
                        if vh is not None:
                            series.holding = float(vh)  # already mV
                except Exception:
                    pass

                # Channel info
                try:
                    n_channels = pm_series.channel_count()
                    channel_names = pm_series.channel_names()
                    channel_units = pm_series.channel_units()
                except Exception:
                    n_channels = 1
                    channel_names = ["Trace"]
                    channel_units = ["[A]"]

                # Extract the test-pulse / stimulus info from the DA protocol.
                # Use the recorded ADC unit on channel 0 to infer whether the
                # stimulus is voltage (→ recording is current → pA) or
                # current (→ recording is voltage → mV).
                primary_trace_unit = str(channel_units[0]) if channel_units else ""
                try:
                    series.stimulus = _extract_stimulus_info(
                        pm_series, series.holding, primary_trace_unit
                    )
                except Exception:
                    series.stimulus = None

                # Iterate sweeps
                n_sweeps = pm_series.sweep_count()
                for sweep_idx in range(n_sweeps):
                    sweep = Sweep(
                        index=sweep_idx,
                        label=f"Sweep {sweep_idx + 1}",
                    )

                    for ch_idx in range(n_channels):
                        try:
                            # Navigate: series[sweep][channel]
                            pm_sweep = pm_series[sweep_idx]
                            pm_trace = pm_sweep[ch_idx]

                            values = np.array(pm_trace.values(), dtype=np.float64)
                            times = np.array(pm_trace.times(), dtype=np.float64)

                            if len(values) == 0:
                                continue

                            # Sampling rate
                            if len(times) >= 2:
                                dt = times[1] - times[0]
                                sampling_rate = 1.0 / dt if dt > 0 else 20000.0
                            else:
                                sampling_rate = 20000.0

                            # Unit string from trace (e.g. "[A]", "[V]")
                            raw_unit = ""
                            try:
                                raw_unit = pm_trace.value_unit()
                            except Exception:
                                if ch_idx < len(channel_units):
                                    raw_unit = channel_units[ch_idx]

                            # Convert SI to display units
                            display_unit, values = _convert_units(raw_unit, values)

                            ch_label = (
                                channel_names[ch_idx]
                                if ch_idx < len(channel_names)
                                else f"Ch{ch_idx}"
                            )

                            trace = Trace(
                                data=values,
                                sampling_rate=sampling_rate,
                                units=display_unit,
                                label=f"{ch_label} ({display_unit})",
                            )
                            sweep.traces.append(trace)

                        except Exception:
                            continue

                    if sweep.traces:
                        series.sweeps.append(sweep)

                if series.sweeps:
                    group.series_list.append(series)

            if group.series_list:
                recording.groups.append(group)

        if not recording.groups:
            raise IOError("No readable data found in HEKA file")


def _extract_stimulus_info(
    pm_series,
    fallback_vhold: float | None,
    primary_trace_unit: str,
) -> StimulusInfo | None:
    """Parse a series' stimulus and return a StimulusInfo if a pulse can be
    identified, else None.

    Tries two extraction paths:

    1. `Series.da_protocol()` — works for most simple square-pulse protocols
       and returns levels in mV / pA directly.
    2. `stim.reconstruction()` — works for some protocols where myokit's
       da_protocol representation loses the step amplitudes (we see levels
       come back all-zero). Values are in SI (V / A / nA); we convert back
       to mV / pA via a unit check on the channel.

    The stimulus unit (mV vs pA) is inferred from the ADC channel unit:
    if the recording is current (pA), the command must be voltage (mV), and
    vice versa.
    """
    # Determine unit from the recorded channel
    adc_unit = str(primary_trace_unit).strip().strip("[]").strip().lower()
    if adc_unit in ("a", "amp", "ampere", "pa", "na"):
        unit_label = "mV"        # voltage clamp → DA = voltage command
    elif adc_unit in ("v", "volt", "mv"):
        unit_label = "pA"        # current clamp → DA = current command
    else:
        unit_label = "mV"

    # Sweep timing (needed by both extraction paths)
    try:
        stim = pm_series.stimulus()
        sweep_samples = stim.sweep_samples()
        sampling_interval_s = stim.sampling_interval()
        if sweep_samples is None or len(sweep_samples) == 0:
            return None
        dt_s = float(sampling_interval_s)
        sweep_duration_ms = float(sweep_samples[0]) * dt_s * 1000.0
    except Exception:
        return None

    # ------- Path 1: da_protocol() -------
    info = _extract_from_da_protocol(
        pm_series, sweep_duration_ms, unit_label, fallback_vhold, dt_s
    )
    if info is not None:
        return info

    # ------- Path 2: reconstruction() -------
    return _extract_from_reconstruction(
        stim, unit_label, fallback_vhold, dt_s
    )


def _extract_from_da_protocol(
    pm_series,
    sweep_duration_ms: float,
    unit_label: str,
    fallback_vhold: float | None,
    dt_s: float,
) -> StimulusInfo | None:
    """Try extraction via myokit's DA protocol events. Returns None if the
    protocol produces only degenerate (same-level or all-zero) events."""
    try:
        proto = pm_series.da_protocol()
    except Exception:
        return None

    first_sweep_events: list[tuple[float, float, float]] = []
    for ev in proto:
        try:
            start_ms = float(ev.start())
            dur_ms = float(ev.duration())
            level = float(ev.level())
        except Exception:
            continue
        if start_ms >= sweep_duration_ms:
            break
        first_sweep_events.append((start_ms, dur_ms, level))

    if not first_sweep_events:
        return None

    # Reject degenerate protocols: all levels identical.
    unique_levels = {round(lvl, 6) for _, _, lvl in first_sweep_events}
    if len(unique_levels) <= 1:
        return None

    # v_hold: longest-duration level
    level_durations: dict[float, float] = {}
    for _, dur, lvl in first_sweep_events:
        if dur <= 0:
            continue
        level_durations[lvl] = level_durations.get(lvl, 0.0) + dur

    if not level_durations:
        return None

    v_hold = max(level_durations.items(), key=lambda kv: kv[1])[0]

    if fallback_vhold is not None:
        for lvl in level_durations:
            if abs(lvl - fallback_vhold) < 1.0:
                v_hold = lvl
                break

    # First non-holding segment = pulse
    pulse_event: tuple[float, float, float] | None = None
    for start_ms, dur_ms, lvl in first_sweep_events:
        if dur_ms <= 0:
            continue
        if abs(lvl - v_hold) >= 0.5:
            pulse_event = (start_ms, dur_ms, lvl)
            break

    if pulse_event is None:
        return None

    pulse_start_ms, pulse_dur_ms, pulse_level = pulse_event
    return _make_stimulus_info(
        unit_label=unit_label,
        v_hold=v_hold,
        pulse_start_s=pulse_start_ms / 1000.0,
        pulse_end_s=(pulse_start_ms + pulse_dur_ms) / 1000.0,
        pulse_level=pulse_level,
        dt_s=dt_s,
    )


def _extract_from_reconstruction(
    stim,
    unit_label: str,
    fallback_vhold: float | None,
    dt_s: float,
) -> StimulusInfo | None:
    """Try extraction via `stim.reconstruction()`. Values come in SI
    (V for voltage, A / nA for current), so we scale to mV / pA."""
    try:
        time_list, val_list = stim.reconstruction()
    except Exception:
        return None

    if not val_list or len(val_list) == 0:
        return None

    # Use sweep 0 as the template. (myokit doesn't fully handle per-sweep
    # increments for many protocols — all sweeps are often identical.)
    try:
        arr = np.asarray(val_list[0], dtype=np.float64)
    except Exception:
        return None

    if arr.size == 0:
        return None

    # Unit conversion: SI → mV / pA.
    # Check what myokit thinks the DA channel unit is.
    try:
        import myokit
        ch_unit = stim._supported_channel._unit
        if ch_unit == myokit.units.V:
            arr_display = arr * 1000.0          # V → mV
            unit_label = "mV"
        elif ch_unit == myokit.units.A:
            arr_display = arr * 1e12            # A → pA
            unit_label = "pA"
        elif ch_unit == myokit.units.nA:
            arr_display = arr * 1000.0          # nA → pA
            unit_label = "pA"
        else:
            # Unknown unit — leave values raw and hope for the best
            arr_display = arr
    except Exception:
        arr_display = arr

    # Reject degenerate waveforms (all equal, or zero span)
    min_v = float(np.min(arr_display))
    max_v = float(np.max(arr_display))
    if abs(max_v - min_v) < 1e-6:
        return None

    # Round to tolerance to merge very-close values, then run-length encode
    # to find the segments.
    rounded = np.round(arr_display, 3)
    segments_samples: list[tuple[int, int, float]] = []  # (start_idx, end_idx, level)
    start = 0
    curr = rounded[0]
    for i in range(1, len(rounded)):
        if rounded[i] != curr:
            segments_samples.append((start, i, float(curr)))
            start = i
            curr = rounded[i]
    segments_samples.append((start, len(rounded), float(curr)))

    # v_hold: longest-duration level (in samples)
    level_durations: dict[float, int] = {}
    for s_idx, e_idx, lvl in segments_samples:
        level_durations[lvl] = level_durations.get(lvl, 0) + (e_idx - s_idx)

    if not level_durations:
        return None

    v_hold = max(level_durations.items(), key=lambda kv: kv[1])[0]

    if fallback_vhold is not None:
        for lvl in level_durations:
            if abs(lvl - fallback_vhold) < 1.0:
                v_hold = lvl
                break

    # Find first non-holding segment
    pulse_seg: tuple[int, int, float] | None = None
    for s_idx, e_idx, lvl in segments_samples:
        if abs(lvl - v_hold) >= 0.5 and (e_idx - s_idx) > 0:
            pulse_seg = (s_idx, e_idx, lvl)
            break

    if pulse_seg is None:
        return None

    s_idx, e_idx, pulse_level = pulse_seg
    return _make_stimulus_info(
        unit_label=unit_label,
        v_hold=v_hold,
        pulse_start_s=s_idx * dt_s,
        pulse_end_s=e_idx * dt_s,
        pulse_level=pulse_level,
        dt_s=dt_s,
    )


def _make_stimulus_info(
    unit_label: str,
    v_hold: float,
    pulse_start_s: float,
    pulse_end_s: float,
    pulse_level: float,
    dt_s: float,
) -> StimulusInfo:
    """Assemble a StimulusInfo with suggested baseline cursor placement."""
    guard_s = max(0.0005, 2 * dt_s)
    bl_end_s = max(0.0, pulse_start_s - guard_s)
    bl_duration_s = min(0.1, max(0.002, bl_end_s))
    bl_start_s = max(0.0, bl_end_s - bl_duration_s)

    return StimulusInfo(
        unit=unit_label,
        v_hold=v_hold,
        v_step=pulse_level - v_hold,
        v_step_absolute=pulse_level,
        pulse_start=pulse_start_s,
        pulse_end=pulse_end_s,
        baseline_start=bl_start_s,
        baseline_end=bl_end_s,
        segments=[],  # no longer used
    )


def _convert_units(raw_unit, values: np.ndarray) -> tuple[str, np.ndarray]:
    """Convert SI base units (as stored in HEKA files) to display units.

    HEKA stores trace data in SI (Amperes, Volts, Siemens, etc.).
    myokit returns a Unit object whose str() gives e.g. "[A]", "[V]".
    """
    # Convert to string, then strip brackets: "[A]" -> "A"
    unit = str(raw_unit).strip().strip("[]").strip()

    if unit in ("A", "Amp", "Ampere"):
        return "pA", values * 1e12
    elif unit == "V":
        return "mV", values * 1e3
    elif unit == "S":
        return "nS", values * 1e9
    elif unit == "F":
        return "pF", values * 1e12
    elif unit == "Ohm":
        return "MOhm", values / 1e6
    elif unit in ("pA", "mV", "nS", "pF", "MOhm", "nA", "uV"):
        return unit, values
    elif unit:
        return unit, values
    else:
        return "pA", values * 1e12  # default: assume Amperes
