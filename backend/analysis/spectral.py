"""Spectral analysis: power spectrum, spectrogram, band power, coherence."""

from __future__ import annotations

import numpy as np
from scipy.signal import welch, spectrogram as scipy_spectrogram, coherence as scipy_coherence
from .base import AnalysisBase, register_analysis

# NumPy >=2.0 renamed trapz to trapezoid
_trapz = getattr(np, 'trapezoid', None) or np.trapz

# Standard frequency bands
FREQUENCY_BANDS = {
    "delta": (0.5, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "low_gamma": (30.0, 50.0),
    "high_gamma": (50.0, 100.0),
}


class SpectralAnalysis(AnalysisBase):
    name = "spectral"
    description = "Power spectrum, spectrogram, band power, coherence"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        measure = params.get("measure", "psd")

        if measure == "psd":
            return self._power_spectrum(data, sampling_rate, params)
        elif measure == "spectrogram":
            return self._spectrogram(data, sampling_rate, params)
        elif measure == "band_power":
            return self._band_power(data, sampling_rate, params)
        else:
            return {"error": f"Unknown measure: {measure}"}

    def _power_spectrum(self, data, sr, params):
        """Compute power spectral density using Welch's method."""
        nperseg = params.get("nperseg", min(4096, len(data)))
        noverlap = params.get("noverlap", nperseg // 2)
        max_freq = params.get("max_freq", sr / 2)

        freqs, psd = welch(data, fs=sr, nperseg=nperseg, noverlap=noverlap)

        # Limit to max frequency
        mask = freqs <= max_freq
        freqs = freqs[mask]
        psd = psd[mask]

        # Downsample for JSON if needed
        if len(freqs) > 2000:
            step = len(freqs) // 2000
            freqs = freqs[::step]
            psd = psd[::step]

        return {
            "measure": "psd",
            "frequencies": freqs.tolist(),
            "power": psd.tolist(),
            "units": "power/Hz",
            "peak_freq": float(freqs[np.argmax(psd)]),
            "total_power": float(_trapz(psd, freqs)),
        }

    def _spectrogram(self, data, sr, params):
        """Compute spectrogram (time-frequency representation)."""
        nperseg = params.get("nperseg", min(1024, len(data) // 4))
        noverlap = params.get("noverlap", nperseg * 3 // 4)
        max_freq = params.get("max_freq", 100.0)

        freqs, times, Sxx = scipy_spectrogram(
            data, fs=sr, nperseg=nperseg, noverlap=noverlap
        )

        mask = freqs <= max_freq
        freqs = freqs[mask]
        Sxx = Sxx[mask, :]

        # Convert to dB
        Sxx_db = 10 * np.log10(Sxx + 1e-30)

        # Downsample for JSON
        max_time_bins = 500
        max_freq_bins = 200
        if Sxx_db.shape[1] > max_time_bins:
            step = Sxx_db.shape[1] // max_time_bins
            times = times[::step]
            Sxx_db = Sxx_db[:, ::step]
        if Sxx_db.shape[0] > max_freq_bins:
            step = Sxx_db.shape[0] // max_freq_bins
            freqs = freqs[::step]
            Sxx_db = Sxx_db[::step, :]

        return {
            "measure": "spectrogram",
            "times": times.tolist(),
            "frequencies": freqs.tolist(),
            "power_db": Sxx_db.tolist(),
        }

    def _band_power(self, data, sr, params):
        """Compute power in standard frequency bands."""
        nperseg = params.get("nperseg", min(4096, len(data)))
        freqs, psd = welch(data, fs=sr, nperseg=nperseg)

        bands = params.get("bands", FREQUENCY_BANDS)
        if isinstance(bands, list):
            bands = {b: FREQUENCY_BANDS[b] for b in bands if b in FREQUENCY_BANDS}

        total_power = float(_trapz(psd, freqs))
        band_results = {}

        for name, (low, high) in bands.items():
            mask = (freqs >= low) & (freqs <= high)
            if np.any(mask):
                band_power = float(_trapz(psd[mask], freqs[mask]))
                band_results[name] = {
                    "power": band_power,
                    "relative_power": band_power / total_power if total_power > 0 else 0,
                    "range_hz": [low, high],
                    "peak_freq": float(freqs[mask][np.argmax(psd[mask])]),
                }

        return {
            "measure": "band_power",
            "total_power": total_power,
            "bands": band_results,
        }


register_analysis(SpectralAnalysis())
