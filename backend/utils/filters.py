"""Signal filtering utilities."""

import numpy as np
from scipy.signal import butter, sosfilt, medfilt


def lowpass_filter(data: np.ndarray, cutoff: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth lowpass filter."""
    nyq = sr / 2
    if cutoff >= nyq:
        return data
    sos = butter(order, cutoff / nyq, btype="low", output="sos")
    return sosfilt(sos, data)


def highpass_filter(data: np.ndarray, cutoff: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth highpass filter."""
    nyq = sr / 2
    if cutoff <= 0:
        return data
    sos = butter(order, cutoff / nyq, btype="high", output="sos")
    return sosfilt(sos, data)


def bandpass_filter(data: np.ndarray, low: float, high: float, sr: float, order: int = 4) -> np.ndarray:
    """Butterworth bandpass filter."""
    nyq = sr / 2
    if high >= nyq:
        high = nyq * 0.99
    sos = butter(order, [low / nyq, high / nyq], btype="band", output="sos")
    return sosfilt(sos, data)


def median_filter(data: np.ndarray, kernel_size: int = 5) -> np.ndarray:
    """Median filter for noise removal."""
    if kernel_size % 2 == 0:
        kernel_size += 1
    return medfilt(data, kernel_size)
