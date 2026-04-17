"""Signal filtering utilities.

All filters use zero-phase forward-backward application (``sosfiltfilt``) so
there is no phase distortion and no initial transient at t=0 — important for
ephys traces where a spurious bump at the start would mess up baseline
estimation and event detection.
"""

import numpy as np
from scipy.signal import butter, sosfilt, sosfiltfilt, medfilt


def _apply_sos(sos: np.ndarray, data: np.ndarray) -> np.ndarray:
    """Run sosfiltfilt when the signal is long enough, otherwise fall back
    to one-way sosfilt so we don't raise on tiny traces.

    We use ``padtype='constant'`` (pad with the edge sample's value) instead
    of the default ``'odd'`` reflection. Odd reflection mirrors the signal
    around the first/last sample with a sign flip, which for ephys traces —
    where the signal starts at a non-zero DC level (e.g. −65 mV resting) —
    injects a large step at t=0 and produces a visible ringing artifact at
    the very beginning of the filtered trace. Constant padding simply holds
    the edge value, which for reasonable cutoffs produces negligible edge
    error.
    """
    min_len = 6 * sos.shape[0]
    if len(data) > min_len:
        return sosfiltfilt(sos, data, padtype='constant')
    return sosfilt(sos, data)


def lowpass_filter(data: np.ndarray, cutoff: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth lowpass filter (zero-phase)."""
    nyq = sr / 2
    if cutoff >= nyq:
        return data
    sos = butter(order, cutoff / nyq, btype="low", output="sos")
    return _apply_sos(sos, data)


def highpass_filter(data: np.ndarray, cutoff: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth highpass filter (zero-phase)."""
    nyq = sr / 2
    if cutoff <= 0:
        return data
    sos = butter(order, cutoff / nyq, btype="high", output="sos")
    return _apply_sos(sos, data)


def bandpass_filter(data: np.ndarray, low: float, high: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth bandpass filter (zero-phase)."""
    nyq = sr / 2
    if high >= nyq:
        high = nyq * 0.99
    sos = butter(order, [low / nyq, high / nyq], btype="band", output="sos")
    return _apply_sos(sos, data)


def median_filter(data: np.ndarray, kernel_size: int = 5) -> np.ndarray:
    """Median filter for noise removal."""
    if kernel_size % 2 == 0:
        kernel_size += 1
    return medfilt(data, kernel_size)
