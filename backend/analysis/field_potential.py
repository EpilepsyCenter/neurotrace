"""Field potential analyses: fEPSP slope, population spike, paired-pulse ratio, LTP/LTD."""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks
from scipy.stats import linregress
from .base import AnalysisBase, register_analysis


class FieldPotentialAnalysis(AnalysisBase):
    name = "field_potential"
    description = "fEPSP slope, population spike amplitude, paired-pulse ratio"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        measure = params.get("measure", "slope")

        if measure == "slope":
            return self._fepsp_slope(data, sampling_rate, params)
        elif measure == "pop_spike":
            return self._population_spike(data, sampling_rate, params)
        elif measure == "paired_pulse":
            return self._paired_pulse_ratio(data, sampling_rate, params)
        else:
            return {"error": f"Unknown measure: {measure}"}

    def _fepsp_slope(self, data, sr, params):
        """Compute fEPSP initial slope via linear regression on rising phase."""
        pk_start = params.get("peakStart", 0.01)
        pk_end = params.get("peakEnd", 0.05)

        i0 = int(pk_start * sr)
        i1 = int(pk_end * sr)
        i0, i1 = max(0, i0), min(len(data), i1)

        segment = data[i0:i1]
        if len(segment) < 5:
            return {"error": "Segment too short"}

        # Find the negative peak (fEPSP trough)
        min_idx = np.argmin(segment)
        min_val = segment[min_idx]

        # Baseline before the response
        bl_samples = max(5, int(0.002 * sr))
        baseline = np.mean(segment[:bl_samples]) if min_idx > bl_samples else segment[0]

        amplitude = min_val - baseline

        # Slope: fit line to 10-90% of rising phase (onset to peak)
        level_10 = baseline + 0.1 * amplitude
        level_90 = baseline + 0.9 * amplitude

        # Find 10% and 90% crossing points
        slope_start = 0
        slope_end = min_idx

        for i in range(min_idx):
            if segment[i] <= level_10:
                slope_start = i
                break

        for i in range(min_idx):
            if segment[i] <= level_90:
                slope_end = i
                break

        if slope_end <= slope_start:
            slope_end = min_idx

        # Linear regression on slope region
        slope_segment = segment[slope_start:slope_end + 1]
        if len(slope_segment) < 3:
            slope_segment = segment[max(0, min_idx - 5):min_idx + 1]

        t = np.arange(len(slope_segment)) / sr * 1000  # ms
        if len(t) >= 2:
            result = linregress(t, slope_segment)
            slope = float(result.slope)  # units/ms
            r_squared = float(result.rvalue ** 2)
        else:
            slope = 0
            r_squared = 0

        return {
            "slope": slope,
            "r_squared": r_squared,
            "amplitude": float(amplitude),
            "peak_time_ms": float((i0 + min_idx) / sr * 1000),
            "slope_region_ms": [
                float((i0 + slope_start) / sr * 1000),
                float((i0 + slope_end) / sr * 1000),
            ],
        }

    def _population_spike(self, data, sr, params):
        """Measure population spike amplitude.

        Measured from the interpolated line between two positive peaks
        flanking the negative spike, down to the negative trough.
        """
        pk_start = params.get("peakStart", 0.01)
        pk_end = params.get("peakEnd", 0.05)

        i0 = int(pk_start * sr)
        i1 = int(pk_end * sr)
        segment = data[max(0, i0):min(len(data), i1)]

        if len(segment) < 10:
            return {"error": "Segment too short"}

        # Find negative trough
        trough_idx = np.argmin(segment)
        trough_val = segment[trough_idx]

        # Find positive peaks flanking the trough
        # Left peak: max before trough
        left_segment = segment[:trough_idx] if trough_idx > 0 else segment[:1]
        left_peak_idx = np.argmax(left_segment)
        left_peak_val = left_segment[left_peak_idx]

        # Right peak: max after trough
        right_segment = segment[trough_idx:] if trough_idx < len(segment) else segment[-1:]
        right_peak_idx = trough_idx + np.argmax(right_segment)
        right_peak_val = segment[right_peak_idx]

        # Interpolated baseline at trough position
        if right_peak_idx != left_peak_idx:
            frac = (trough_idx - left_peak_idx) / (right_peak_idx - left_peak_idx)
            interp_baseline = left_peak_val + frac * (right_peak_val - left_peak_val)
        else:
            interp_baseline = (left_peak_val + right_peak_val) / 2

        pop_spike_amp = interp_baseline - trough_val

        return {
            "pop_spike_amplitude": float(pop_spike_amp),
            "trough_value": float(trough_val),
            "left_peak": float(left_peak_val),
            "right_peak": float(right_peak_val),
            "interp_baseline": float(interp_baseline),
            "trough_time_ms": float((i0 + trough_idx) / sr * 1000),
        }

    def _paired_pulse_ratio(self, data, sr, params):
        """Compute paired-pulse ratio (PPR = response2 / response1)."""
        pulse1_start = params.get("pulse1_start", 0.005)
        pulse1_end = params.get("pulse1_end", 0.025)
        pulse2_start = params.get("pulse2_start", 0.055)
        pulse2_end = params.get("pulse2_end", 0.075)
        measure_type = params.get("ppr_measure", "amplitude")  # "amplitude" or "slope"

        # Measure first pulse
        p1_params = {**params, "peakStart": pulse1_start, "peakEnd": pulse1_end}
        if measure_type == "slope":
            r1 = self._fepsp_slope(data, sr, p1_params)
            val1 = r1.get("slope", 0)
        else:
            i0 = int(pulse1_start * sr)
            i1 = int(pulse1_end * sr)
            seg = data[max(0, i0):min(len(data), i1)]
            baseline = np.mean(data[:max(10, int(0.005 * sr))])
            val1 = float(np.min(seg) - baseline)

        # Measure second pulse
        p2_params = {**params, "peakStart": pulse2_start, "peakEnd": pulse2_end}
        if measure_type == "slope":
            r2 = self._fepsp_slope(data, sr, p2_params)
            val2 = r2.get("slope", 0)
        else:
            i0 = int(pulse2_start * sr)
            i1 = int(pulse2_end * sr)
            seg = data[max(0, i0):min(len(data), i1)]
            baseline = np.mean(data[:max(10, int(0.005 * sr))])
            val2 = float(np.min(seg) - baseline)

        ppr = abs(val2 / val1) if abs(val1) > 1e-10 else None

        return {
            "pulse1_value": float(val1),
            "pulse2_value": float(val2),
            "paired_pulse_ratio": float(ppr) if ppr else None,
            "measure_type": measure_type,
            "facilitation": ppr > 1 if ppr else None,
        }


register_analysis(FieldPotentialAnalysis())
