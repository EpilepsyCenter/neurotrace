"""Burst detection algorithms for field potential recordings.

Three methods:
1. Threshold: rectify + smooth, detect epochs above N*SD
2. ISI-based: detect spikes, cluster by inter-spike interval
3. Oscillation-based: bandpass filter, Hilbert envelope, threshold on power
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt, hilbert, find_peaks
from scipy.ndimage import uniform_filter1d
from .base import AnalysisBase, register_analysis


class BurstDetection(AnalysisBase):
    name = "bursts"
    description = "Burst detection (threshold, ISI-based, oscillation-based)"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        method = params.get("method", "threshold")

        if method == "threshold":
            return self._threshold_method(data, sampling_rate, params)
        elif method == "isi":
            return self._isi_method(data, sampling_rate, params)
        elif method == "oscillation":
            return self._oscillation_method(data, sampling_rate, params)
        else:
            return {"error": f"Unknown method: {method}"}

    def _threshold_method(self, data, sr, params):
        """Detect bursts by thresholding rectified + smoothed signal."""
        # Parameters
        n_sd = params.get("n_sd", 3.0)
        smooth_ms = params.get("smooth_ms", 10.0)
        min_duration_ms = params.get("min_duration_ms", 50.0)
        min_gap_ms = params.get("min_gap_ms", 100.0)

        smooth_samples = max(1, int(smooth_ms / 1000 * sr))
        min_dur_samples = int(min_duration_ms / 1000 * sr)
        min_gap_samples = int(min_gap_ms / 1000 * sr)

        # Baseline and SD from first 10% of recording (or specified baseline)
        bl_end = int(params.get("baselineEnd", len(data) / sr * 0.1) * sr)
        bl_end = max(100, min(bl_end, len(data)))
        baseline = np.mean(data[:bl_end])
        bl_sd = np.std(data[:bl_end])

        # Rectify and smooth
        rectified = np.abs(data - baseline)
        smoothed = uniform_filter1d(rectified, smooth_samples)

        threshold = n_sd * bl_sd

        # Find epochs above threshold
        above = smoothed > threshold
        bursts = self._extract_epochs(above, min_dur_samples, min_gap_samples, sr)

        # Compute burst properties
        for burst in bursts:
            i0, i1 = burst["start_idx"], burst["end_idx"]
            segment = data[i0:i1]
            burst["peak_amplitude"] = float(np.max(np.abs(segment - baseline)))
            burst["mean_amplitude"] = float(np.mean(np.abs(segment - baseline)))

        return {
            "method": "threshold",
            "n_bursts": len(bursts),
            "bursts": bursts[:500],
            "threshold_used": float(threshold),
            "total_burst_time_s": sum(b["duration_ms"] for b in bursts) / 1000,
        }

    def _isi_method(self, data, sr, params):
        """Detect spikes first, then cluster into bursts by ISI."""
        # Detect spikes
        spike_threshold = params.get("spike_threshold", None)
        if spike_threshold is None:
            spike_threshold = 4 * np.std(data)

        min_spike_dist = params.get("min_spike_dist_ms", 2.0) / 1000
        peaks, _ = find_peaks(
            np.abs(data - np.mean(data)),
            height=spike_threshold,
            distance=int(min_spike_dist * sr),
        )

        if len(peaks) < 2:
            return {"method": "isi", "n_bursts": 0, "bursts": [], "n_spikes": len(peaks)}

        # Cluster by ISI
        max_isi_ms = params.get("max_isi_ms", 100.0)
        min_spikes = params.get("min_spikes_per_burst", 3)

        isis = np.diff(peaks) / sr * 1000  # ms

        bursts = []
        current_burst_spikes = [peaks[0]]

        for i, isi in enumerate(isis):
            if isi <= max_isi_ms:
                current_burst_spikes.append(peaks[i + 1])
            else:
                if len(current_burst_spikes) >= min_spikes:
                    bursts.append(self._spike_cluster_to_burst(current_burst_spikes, sr))
                current_burst_spikes = [peaks[i + 1]]

        # Don't forget last cluster
        if len(current_burst_spikes) >= min_spikes:
            bursts.append(self._spike_cluster_to_burst(current_burst_spikes, sr))

        # Inter-burst intervals
        if len(bursts) > 1:
            ibis = [bursts[i + 1]["start_s"] - bursts[i]["end_s"] for i in range(len(bursts) - 1)]
            mean_ibi = float(np.mean(ibis))
        else:
            mean_ibi = 0

        return {
            "method": "isi",
            "n_bursts": len(bursts),
            "n_spikes_total": len(peaks),
            "bursts": bursts[:500],
            "mean_ibi_s": mean_ibi,
        }

    def _oscillation_method(self, data, sr, params):
        """Detect bursts from oscillatory power (bandpass + Hilbert envelope)."""
        low_freq = params.get("low_freq", 4.0)
        high_freq = params.get("high_freq", 30.0)
        n_sd = params.get("n_sd", 2.0)
        min_duration_ms = params.get("min_duration_ms", 100.0)

        # Bandpass filter
        nyq = sr / 2
        if high_freq >= nyq:
            high_freq = nyq * 0.9
        sos = butter(4, [low_freq / nyq, high_freq / nyq], btype="band", output="sos")
        filtered = sosfilt(sos, data)

        # Hilbert transform for instantaneous amplitude
        analytic = hilbert(filtered)
        envelope = np.abs(analytic)

        # Smooth envelope
        smooth_samples = max(1, int(0.05 * sr))  # 50ms smoothing
        envelope_smooth = uniform_filter1d(envelope, smooth_samples)

        # Threshold on envelope
        bl_end = int(len(data) * 0.1)
        bl_mean = np.mean(envelope_smooth[:bl_end])
        bl_sd = np.std(envelope_smooth[:bl_end])
        threshold = bl_mean + n_sd * bl_sd

        above = envelope_smooth > threshold
        min_dur_samples = int(min_duration_ms / 1000 * sr)
        min_gap_samples = int(params.get("min_gap_ms", 200.0) / 1000 * sr)

        bursts = self._extract_epochs(above, min_dur_samples, min_gap_samples, sr)

        # Add power info
        for burst in bursts:
            i0, i1 = burst["start_idx"], burst["end_idx"]
            burst["mean_power"] = float(np.mean(envelope_smooth[i0:i1]))
            burst["peak_power"] = float(np.max(envelope_smooth[i0:i1]))

        return {
            "method": "oscillation",
            "band": [low_freq, high_freq],
            "n_bursts": len(bursts),
            "bursts": bursts[:500],
            "threshold_used": float(threshold),
        }

    def _extract_epochs(self, above: np.ndarray, min_dur: int, min_gap: int, sr: float) -> list[dict]:
        """Extract contiguous epochs from boolean array, merge close ones."""
        # Find transitions
        diff = np.diff(above.astype(int))
        starts = np.where(diff == 1)[0] + 1
        ends = np.where(diff == -1)[0] + 1

        # Handle edge cases
        if above[0]:
            starts = np.concatenate([[0], starts])
        if above[-1]:
            ends = np.concatenate([ends, [len(above)]])

        if len(starts) == 0 or len(ends) == 0:
            return []

        # Ensure starts/ends are paired
        pairs = list(zip(starts[:len(ends)], ends[:len(starts)]))

        # Merge close epochs
        merged = []
        for start, end in pairs:
            if merged and (start - merged[-1][1]) < min_gap:
                merged[-1] = (merged[-1][0], end)
            else:
                merged.append((start, end))

        # Filter by minimum duration
        bursts = []
        for start, end in merged:
            duration = end - start
            if duration >= min_dur:
                bursts.append({
                    "start_idx": int(start),
                    "end_idx": int(end),
                    "start_s": float(start / sr),
                    "end_s": float(end / sr),
                    "duration_ms": float(duration / sr * 1000),
                })

        return bursts

    def _spike_cluster_to_burst(self, spike_indices: list[int], sr: float) -> dict:
        spikes = np.array(spike_indices)
        isis = np.diff(spikes) / sr * 1000  # ms
        return {
            "start_idx": int(spikes[0]),
            "end_idx": int(spikes[-1]),
            "start_s": float(spikes[0] / sr),
            "end_s": float(spikes[-1] / sr),
            "duration_ms": float((spikes[-1] - spikes[0]) / sr * 1000),
            "n_spikes": len(spikes),
            "mean_isi_ms": float(np.mean(isis)) if len(isis) > 0 else 0,
            "frequency_hz": float(1000 / np.mean(isis)) if len(isis) > 0 and np.mean(isis) > 0 else 0,
        }


register_analysis(BurstDetection())
