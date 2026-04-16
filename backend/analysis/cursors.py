"""Cursor-based measurements: baseline, peak, rise time, half-width, area."""

from __future__ import annotations

import numpy as np
from .base import AnalysisBase, register_analysis


class CursorMeasurements(AnalysisBase):
    name = "cursors"
    description = "Cursor-based measurements (baseline, peak, amplitude, rise time, half-width, area)"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        dt = 1.0 / sampling_rate

        # Cursor positions (in seconds)
        bl_start = params.get("baselineStart", 0)
        bl_end = params.get("baselineEnd", 0.01)
        pk_start = params.get("peakStart", 0.01)
        pk_end = params.get("peakEnd", 0.05)

        # Convert to sample indices
        bl_i0 = max(0, int(bl_start * sampling_rate))
        bl_i1 = min(len(data), int(bl_end * sampling_rate))
        pk_i0 = max(0, int(pk_start * sampling_rate))
        pk_i1 = min(len(data), int(pk_end * sampling_rate))

        # Baseline
        if bl_i1 > bl_i0:
            baseline = float(np.mean(data[bl_i0:bl_i1]))
            baseline_sd = float(np.std(data[bl_i0:bl_i1]))
        else:
            baseline = 0.0
            baseline_sd = 0.0

        # Peak (find both min and max, return the one with larger absolute deviation)
        if pk_i1 > pk_i0:
            segment = data[pk_i0:pk_i1]
            min_val = float(np.min(segment))
            max_val = float(np.max(segment))

            if abs(min_val - baseline) >= abs(max_val - baseline):
                peak = min_val
                peak_idx = pk_i0 + int(np.argmin(segment))
                direction = -1  # negative-going
            else:
                peak = max_val
                peak_idx = pk_i0 + int(np.argmax(segment))
                direction = 1  # positive-going
        else:
            peak = baseline
            peak_idx = 0
            direction = -1

        amplitude = peak - baseline
        peak_time = peak_idx * dt

        result = {
            "baseline": baseline,
            "baseline_sd": baseline_sd,
            "peak": peak,
            "amplitude": amplitude,
            "peak_time": peak_time,
        }

        # Rise time (10-90%)
        rise_time = self._compute_rise_time(data, baseline, peak, peak_idx, direction, sampling_rate, pk_i0)
        if rise_time is not None:
            result["riseTime"] = rise_time

        # Half-width
        half_width = self._compute_half_width(data, baseline, amplitude, peak_idx, direction, sampling_rate, pk_i0, pk_i1)
        if half_width is not None:
            result["halfWidth"] = half_width

        # Area (charge transfer) in cursor region
        if pk_i1 > pk_i0:
            _trapz = getattr(np, 'trapezoid', np.trapz) if hasattr(np, 'trapz') else np.trapezoid
            area = float(_trapz(data[pk_i0:pk_i1] - baseline, dx=dt))
            result["area"] = area

        return result

    def _compute_rise_time(
        self, data, baseline, peak, peak_idx, direction, sr, start_idx
    ):
        """Compute 10-90% rise time with interpolation."""
        amplitude = peak - baseline
        if abs(amplitude) < 1e-15:
            return None

        level_10 = baseline + 0.1 * amplitude
        level_90 = baseline + 0.9 * amplitude

        # Search backwards from peak to find crossing points
        segment = data[start_idx : peak_idx + 1]
        if len(segment) < 2:
            return None

        dt = 1.0 / sr
        t10 = None
        t90 = None

        for i in range(len(segment) - 1):
            y0, y1 = segment[i], segment[i + 1]

            if direction < 0:
                # Negative-going: look for downward crossings
                if t10 is None and ((y0 >= level_10 >= y1) or (y0 <= level_10 <= y1)):
                    frac = (level_10 - y0) / (y1 - y0) if y1 != y0 else 0
                    t10 = (start_idx + i + frac) * dt
                if t90 is None and ((y0 >= level_90 >= y1) or (y0 <= level_90 <= y1)):
                    frac = (level_90 - y0) / (y1 - y0) if y1 != y0 else 0
                    t90 = (start_idx + i + frac) * dt
            else:
                # Positive-going
                if t10 is None and ((y0 <= level_10 <= y1) or (y0 >= level_10 >= y1)):
                    frac = (level_10 - y0) / (y1 - y0) if y1 != y0 else 0
                    t10 = (start_idx + i + frac) * dt
                if t90 is None and ((y0 <= level_90 <= y1) or (y0 >= level_90 >= y1)):
                    frac = (level_90 - y0) / (y1 - y0) if y1 != y0 else 0
                    t90 = (start_idx + i + frac) * dt

        if t10 is not None and t90 is not None:
            return abs(t90 - t10)
        return None

    def _compute_half_width(
        self, data, baseline, amplitude, peak_idx, direction, sr, start_idx, end_idx
    ):
        """Compute half-width (duration at 50% amplitude)."""
        half_level = baseline + 0.5 * amplitude
        dt = 1.0 / sr

        # Find crossing before peak
        t_before = None
        for i in range(peak_idx - 1, start_idx - 1, -1):
            if i < 0 or i + 1 >= len(data):
                continue
            y0, y1 = data[i], data[i + 1]
            if (y0 - half_level) * (y1 - half_level) <= 0:
                frac = (half_level - y0) / (y1 - y0) if y1 != y0 else 0
                t_before = (i + frac) * dt
                break

        # Find crossing after peak
        t_after = None
        for i in range(peak_idx, min(end_idx, len(data) - 1)):
            y0, y1 = data[i], data[i + 1]
            if (y0 - half_level) * (y1 - half_level) <= 0:
                frac = (half_level - y0) / (y1 - y0) if y1 != y0 else 0
                t_after = (i + frac) * dt
                break

        if t_before is not None and t_after is not None:
            return t_after - t_before
        return None


# Register
register_analysis(CursorMeasurements())
