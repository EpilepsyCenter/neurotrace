"""General curve fitting utilities."""

from __future__ import annotations

import numpy as np
from scipy.optimize import curve_fit
from .base import AnalysisBase, register_analysis


# Common fit functions
FIT_FUNCTIONS = {
    "linear": {
        "func": lambda x, a, b: a * x + b,
        "p0": lambda x, y: [1.0, float(y[0])],
        "param_names": ["slope", "intercept"],
    },
    "mono_exp": {
        "func": lambda x, a, tau, c: a * np.exp(-x / tau) + c,
        "p0": lambda x, y: [float(y[0] - y[-1]), float(x[-1] / 3), float(y[-1])],
        "param_names": ["amplitude", "tau", "offset"],
    },
    "bi_exp": {
        "func": lambda x, a1, t1, a2, t2, c: a1 * np.exp(-x / t1) + a2 * np.exp(-x / t2) + c,
        "p0": lambda x, y: [float(y[0] - y[-1]) * 0.7, float(x[-1] / 5),
                            float(y[0] - y[-1]) * 0.3, float(x[-1] / 2), float(y[-1])],
        "param_names": ["a_fast", "tau_fast", "a_slow", "tau_slow", "offset"],
    },
    "gaussian": {
        "func": lambda x, a, mu, sigma: a * np.exp(-((x - mu) ** 2) / (2 * sigma ** 2)),
        "p0": lambda x, y: [float(np.max(y)), float(x[np.argmax(y)]), float(np.std(x) / 2)],
        "param_names": ["amplitude", "center", "sigma"],
    },
    "boltzmann": {
        "func": lambda x, vhalf, k, top, bottom: bottom + (top - bottom) / (1 + np.exp((vhalf - x) / k)),
        "p0": lambda x, y: [float(np.median(x)), 5.0, float(np.max(y)), float(np.min(y))],
        "param_names": ["v_half", "slope_factor", "top", "bottom"],
    },
    "hill": {
        "func": lambda x, ec50, n, top, bottom: bottom + (top - bottom) / (1 + (ec50 / (x + 1e-30)) ** n),
        "p0": lambda x, y: [float(np.median(x)), 1.0, float(np.max(y)), float(np.min(y))],
        "param_names": ["ec50", "hill_coefficient", "top", "bottom"],
    },
}


class GeneralFitting(AnalysisBase):
    name = "fitting"
    description = "General curve fitting (linear, exponential, Gaussian, Boltzmann, Hill)"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        fit_type = params.get("fit_type", "mono_exp")
        fit_start = params.get("fitStart", 0)
        fit_end = params.get("fitEnd", len(data) / sampling_rate)

        if fit_type not in FIT_FUNCTIONS:
            return {"error": f"Unknown fit type: {fit_type}. Available: {list(FIT_FUNCTIONS.keys())}"}

        i0 = max(0, int(fit_start * sampling_rate))
        i1 = min(len(data), int(fit_end * sampling_rate))

        y = data[i0:i1]
        x = np.arange(len(y)) / sampling_rate * 1000  # ms

        if len(x) < 3:
            return {"error": "Not enough data points"}

        spec = FIT_FUNCTIONS[fit_type]

        try:
            p0 = spec["p0"](x, y)
            popt, pcov = curve_fit(spec["func"], x, y, p0=p0, maxfev=10000)
            perr = np.sqrt(np.diag(pcov))
            fitted = spec["func"](x, *popt)
            residuals = y - fitted
            ss_res = float(np.sum(residuals ** 2))
            ss_tot = float(np.sum((y - np.mean(y)) ** 2))
            r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0

            result = {
                "fit_type": fit_type,
                "r_squared": r_squared,
                "residual_ss": ss_res,
                "fitted_values": fitted.tolist(),
                "time_ms": x.tolist(),
                "parameters": {},
            }

            for name, val, err in zip(spec["param_names"], popt, perr):
                result["parameters"][name] = {"value": float(val), "error": float(err)}

            return result

        except (RuntimeError, ValueError) as e:
            return {"error": f"Fit failed: {e}"}


register_analysis(GeneralFitting())
