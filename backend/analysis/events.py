"""Event detection: template matching, threshold-based, and derivative-based methods."""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks
from scipy.ndimage import uniform_filter1d
from .base import AnalysisBase, register_analysis


class EventDetection(AnalysisBase):
    name = "events"
    description = "Detect synaptic events (EPSCs/IPSCs/minis) using template matching or threshold"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        method = params.get("method", "threshold")

        if method == "threshold":
            return self._threshold_detection(data, sampling_rate, params)
        elif method == "derivative":
            return self._derivative_detection(data, sampling_rate, params)
        elif method == "template":
            return self._template_matching(data, sampling_rate, params)
        else:
            return {"error": f"Unknown method: {method}"}

    def _threshold_detection(self, data, sr, params):
        """Simple threshold-based event detection."""
        # Subtract baseline
        bl_samples = int(params.get("baselineEnd", 0.01) * sr)
        baseline = np.mean(data[:max(bl_samples, 10)])
        trace = data - baseline

        # Parameters
        threshold = params.get("threshold", None)
        direction = params.get("direction", "negative")
        min_interval = params.get("min_interval_ms", 5.0) / 1000  # convert to seconds

        if threshold is None:
            # Auto threshold: 3x SD of baseline
            bl_sd = np.std(data[:max(bl_samples, 100)])
            threshold = 3 * bl_sd

        # Detect peaks
        if direction == "negative":
            peaks, properties = find_peaks(-trace, height=threshold, distance=int(min_interval * sr))
            amplitudes = -trace[peaks]
        else:
            peaks, properties = find_peaks(trace, height=threshold, distance=int(min_interval * sr))
            amplitudes = trace[peaks]

        events = []
        for i, (peak_idx, amp) in enumerate(zip(peaks, amplitudes)):
            event = {
                "index": int(peak_idx),
                "time": float(peak_idx / sr),
                "amplitude": float(amp),
            }
            events.append(event)

        # Inter-event intervals
        if len(peaks) > 1:
            ieis = np.diff(peaks) / sr * 1000  # ms
            mean_iei = float(np.mean(ieis))
            frequency = 1000.0 / mean_iei if mean_iei > 0 else 0  # Hz
        else:
            mean_iei = 0
            frequency = 0

        return {
            "method": "threshold",
            "n_events": len(events),
            "events": events[:1000],  # limit for JSON
            "mean_amplitude": float(np.mean(amplitudes)) if len(amplitudes) > 0 else 0,
            "sd_amplitude": float(np.std(amplitudes)) if len(amplitudes) > 0 else 0,
            "mean_iei_ms": mean_iei,
            "frequency_hz": frequency,
            "threshold_used": float(threshold),
        }

    def _derivative_detection(self, data, sr, params):
        """Detect events based on the first derivative (for fast events like APs)."""
        # Smooth slightly
        smooth_ms = params.get("smooth_ms", 0.2)
        smooth_samples = max(1, int(smooth_ms / 1000 * sr))
        smoothed = uniform_filter1d(data, smooth_samples)

        # First derivative
        deriv = np.diff(smoothed) * sr  # units/s

        threshold = params.get("deriv_threshold", None)
        if threshold is None:
            threshold = 5 * np.std(deriv)

        direction = params.get("direction", "negative")
        min_interval = params.get("min_interval_ms", 2.0) / 1000

        if direction == "negative":
            peaks, _ = find_peaks(-deriv, height=threshold, distance=int(min_interval * sr))
        else:
            peaks, _ = find_peaks(deriv, height=threshold, distance=int(min_interval * sr))

        events = [{"index": int(p), "time": float(p / sr)} for p in peaks]

        return {
            "method": "derivative",
            "n_events": len(events),
            "events": events[:1000],
        }

    def _template_matching(self, data, sr, params):
        """Template matching via sliding normalized dot product."""
        template = params.get("template", None)

        if template is None:
            # Auto-generate template: idealized EPSC/IPSC
            rise_ms = params.get("template_rise_ms", 0.5)
            decay_ms = params.get("template_decay_ms", 5.0)
            duration_ms = params.get("template_duration_ms", 20.0)

            t = np.arange(0, duration_ms, 1000 / sr) / 1000  # seconds
            rise_tau = rise_ms / 1000
            decay_tau = decay_ms / 1000
            template = -np.exp(-t / decay_tau) + np.exp(-t / rise_tau)
            template = template / np.max(np.abs(template))  # normalize
        else:
            template = np.array(template)

        # Sliding dot product (correlation)
        template_norm = template - np.mean(template)
        template_norm = template_norm / np.sqrt(np.sum(template_norm ** 2))

        n = len(data)
        m = len(template_norm)
        if m >= n:
            return {"error": "Template longer than data"}

        correlation = np.correlate(data - np.mean(data), template_norm, mode="valid")

        # Normalize by local std
        local_std = np.array([
            np.std(data[i:i + m]) for i in range(len(correlation))
        ])
        local_std[local_std < 1e-10] = 1e-10
        score = correlation / (local_std * m)

        threshold = params.get("match_threshold", 4.0)
        min_interval = params.get("min_interval_ms", 5.0) / 1000

        peaks, _ = find_peaks(np.abs(score), height=threshold, distance=int(min_interval * sr))

        events = [
            {"index": int(p), "time": float(p / sr), "score": float(score[p])}
            for p in peaks
        ]

        return {
            "method": "template",
            "n_events": len(events),
            "events": events[:1000],
            "template_length_ms": float(len(template) / sr * 1000),
        }


register_analysis(EventDetection())
