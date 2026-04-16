"""Macro API — the 'stf' module available to user scripts.

Provides convenient access to trace data, analysis functions, and result output.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from readers.models import Recording
from analysis.base import get_analysis
from utils.filters import lowpass_filter, highpass_filter, bandpass_filter, median_filter


class NeuroTraceMacroAPI:
    """The `stf` object available in macro scripts."""

    def __init__(self, recording: Recording):
        self._rec = recording
        self._group = 0
        self._series = 0
        self._sweep = 0
        self._trace = 0
        self._cursors = {
            "baselineStart": 0,
            "baselineEnd": 0.01,
            "peakStart": 0.01,
            "peakEnd": 0.05,
            "fitStart": 0.01,
            "fitEnd": 0.1,
        }
        self._table_results: list[dict] = []
        self._plot_data: list[dict] = []

    # --- Data access ---

    def get_trace(self, group=None, series=None, sweep=None, trace=None) -> np.ndarray:
        """Get trace data as numpy array."""
        g = group if group is not None else self._group
        s = series if series is not None else self._series
        sw = sweep if sweep is not None else self._sweep
        t = trace if trace is not None else self._trace
        return self._rec.groups[g].series_list[s].sweeps[sw].traces[t].data.copy()

    def get_sampling_rate(self, group=None, series=None, sweep=None, trace=None) -> float:
        g = group if group is not None else self._group
        s = series if series is not None else self._series
        sw = sweep if sweep is not None else self._sweep
        t = trace if trace is not None else self._trace
        return self._rec.groups[g].series_list[s].sweeps[sw].traces[t].sampling_rate

    def get_time(self, group=None, series=None, sweep=None, trace=None) -> np.ndarray:
        """Get time array for current trace."""
        g = group if group is not None else self._group
        s = series if series is not None else self._series
        sw = sweep if sweep is not None else self._sweep
        t = trace if trace is not None else self._trace
        return self._rec.groups[g].series_list[s].sweeps[sw].traces[t].time_array

    def get_units(self) -> str:
        return self._rec.groups[self._group].series_list[self._series].sweeps[self._sweep].traces[self._trace].units

    def n_groups(self) -> int:
        return self._rec.group_count

    def n_series(self, group=None) -> int:
        g = group if group is not None else self._group
        return self._rec.groups[g].series_count

    def n_sweeps(self, group=None, series=None) -> int:
        g = group if group is not None else self._group
        s = series if series is not None else self._series
        return self._rec.groups[g].series_list[s].sweep_count

    def select(self, group=None, series=None, sweep=None, trace=None):
        """Set the current selection."""
        if group is not None:
            self._group = group
        if series is not None:
            self._series = series
        if sweep is not None:
            self._sweep = sweep
        if trace is not None:
            self._trace = trace

    # --- Cursors ---

    def set_cursors(self, baseline_start=None, baseline_end=None,
                    peak_start=None, peak_end=None,
                    fit_start=None, fit_end=None):
        if baseline_start is not None:
            self._cursors["baselineStart"] = baseline_start
        if baseline_end is not None:
            self._cursors["baselineEnd"] = baseline_end
        if peak_start is not None:
            self._cursors["peakStart"] = peak_start
        if peak_end is not None:
            self._cursors["peakEnd"] = peak_end
        if fit_start is not None:
            self._cursors["fitStart"] = fit_start
        if fit_end is not None:
            self._cursors["fitEnd"] = fit_end

    # --- Measurements ---

    def measure(self, analysis_type="cursors", **kwargs) -> dict:
        """Run an analysis on the current trace."""
        data = self.get_trace()
        sr = self.get_sampling_rate()
        params = {**self._cursors, **kwargs}
        analysis = get_analysis(analysis_type)
        return analysis.run(data, sr, params)

    def measure_peak(self) -> float:
        result = self.measure("cursors")
        return result.get("amplitude", 0)

    def measure_baseline(self) -> float:
        result = self.measure("cursors")
        return result.get("baseline", 0)

    def get_rs(self, v_step=5.0) -> float | None:
        result = self.measure("resistance", v_step=v_step)
        return result.get("rs")

    def get_rin(self, v_step=5.0) -> float | None:
        result = self.measure("resistance", v_step=v_step)
        return result.get("rin")

    def fit_exp(self, n=1) -> dict:
        fit_type = "mono_exp" if n == 1 else "bi_exp"
        return self.measure("kinetics", fit_type=fit_type)

    def fepsp_slope(self) -> float:
        result = self.measure("field_potential", measure="slope")
        return result.get("slope", 0)

    # --- Filtering ---

    def apply_filter(self, filter_type: str, cutoff=None, low=None, high=None, order=4):
        """Apply a filter to the current trace (returns filtered copy, does not modify original)."""
        data = self.get_trace()
        sr = self.get_sampling_rate()

        if filter_type == "lowpass" and cutoff:
            return lowpass_filter(data, cutoff, sr, order)
        elif filter_type == "highpass" and cutoff:
            return highpass_filter(data, cutoff, sr, order)
        elif filter_type == "bandpass" and low and high:
            return bandpass_filter(data, low, high, sr, order)
        elif filter_type == "median":
            kernel = int(cutoff) if cutoff else 5
            return median_filter(data, kernel)
        else:
            raise ValueError(f"Unknown filter: {filter_type}")

    # --- Batch processing ---

    def batch(self, func, sweep_range=None, series_range=None):
        """Apply a function to a range of sweeps/series."""
        results = []
        if sweep_range is not None:
            for sw in sweep_range:
                self._sweep = sw
                result = func(self)
                if result is not None:
                    results.append({"sweep": sw, **result} if isinstance(result, dict) else {"sweep": sw, "value": result})
        elif series_range is not None:
            for s in series_range:
                self._series = s
                result = func(self)
                if result is not None:
                    results.append({"series": s, **result} if isinstance(result, dict) else {"series": s, "value": result})
        return results

    # --- Output ---

    def to_table(self, data: dict | list):
        """Send results to the results table."""
        if isinstance(data, dict):
            self._table_results.append(data)
        elif isinstance(data, list):
            self._table_results.extend(data)

    def plot(self, y_data, x_data=None, label=""):
        """Add data to the plot output."""
        self._plot_data.append({
            "y": np.asarray(y_data).tolist(),
            "x": np.asarray(x_data).tolist() if x_data is not None else None,
            "label": label,
        })


def create_macro_api(recording: Recording) -> NeuroTraceMacroAPI:
    return NeuroTraceMacroAPI(recording)
