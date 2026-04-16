"""Baseline subtraction methods."""

import numpy as np
from scipy.signal import savgol_filter


def constant_baseline(data: np.ndarray, start: int, end: int) -> np.ndarray:
    """Subtract mean of baseline region."""
    baseline = np.mean(data[start:end])
    return data - baseline


def linear_baseline(data: np.ndarray, start: int, end: int) -> np.ndarray:
    """Subtract linear fit between two regions."""
    x = np.arange(len(data))
    x_bl = np.concatenate([np.arange(start, end)])
    y_bl = data[x_bl]
    coeffs = np.polyfit(x_bl, y_bl, 1)
    baseline = np.polyval(coeffs, x)
    return data - baseline


def polynomial_baseline(data: np.ndarray, order: int = 3, n_iter: int = 10) -> np.ndarray:
    """Iterative polynomial baseline estimation (asymmetric least squares style)."""
    x = np.arange(len(data))
    baseline = data.copy()

    for _ in range(n_iter):
        coeffs = np.polyfit(x, baseline, order)
        fitted = np.polyval(coeffs, x)
        baseline = np.minimum(baseline, fitted)

    return data - np.polyval(np.polyfit(x, baseline, order), x)
