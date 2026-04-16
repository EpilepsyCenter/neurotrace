"""Kinetics analysis: exponential fitting, rise time, decay constants."""

from __future__ import annotations

import numpy as np
from scipy.optimize import curve_fit
from .base import AnalysisBase, register_analysis


def _mono_exp(t, a, tau, offset):
    return a * np.exp(-t / tau) + offset


def _bi_exp(t, a1, tau1, a2, tau2, offset):
    return a1 * np.exp(-t / tau1) + a2 * np.exp(-t / tau2) + offset


def _boltzmann(x, vhalf, slope, top, bottom):
    return bottom + (top - bottom) / (1 + np.exp((vhalf - x) / slope))


class KineticsAnalysis(AnalysisBase):
    name = "kinetics"
    description = "Exponential decay fitting (mono/bi), Boltzmann activation/inactivation"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        fit_type = params.get("fit_type", "mono_exp")
        fit_start = params.get("fitStart", 0.01)
        fit_end = params.get("fitEnd", 0.1)

        i0 = max(0, int(fit_start * sampling_rate))
        i1 = min(len(data), int(fit_end * sampling_rate))

        if i1 - i0 < 5:
            return {"error": "Fit region too short"}

        y = data[i0:i1]
        t = np.arange(len(y)) / sampling_rate * 1000  # ms

        if fit_type == "mono_exp":
            return self._fit_mono_exp(t, y)
        elif fit_type == "bi_exp":
            return self._fit_bi_exp(t, y)
        elif fit_type == "boltzmann":
            return self._fit_boltzmann(data, params)
        else:
            return {"error": f"Unknown fit type: {fit_type}"}

    def _fit_mono_exp(self, t, y):
        try:
            a0 = float(y[0] - y[-1])
            tau0 = float(t[-1] / 3)
            offset0 = float(y[-1])

            popt, pcov = curve_fit(
                _mono_exp, t, y,
                p0=[a0, tau0, offset0],
                maxfev=10000,
            )

            perr = np.sqrt(np.diag(pcov))
            fitted = _mono_exp(t, *popt)
            residual = float(np.sum((y - fitted) ** 2))

            return {
                "fit_type": "mono_exp",
                "amplitude": float(popt[0]),
                "tau": float(popt[1]),
                "offset": float(popt[2]),
                "amplitude_err": float(perr[0]),
                "tau_err": float(perr[1]),
                "residual_ss": residual,
                "fitted_values": fitted.tolist(),
                "time_ms": t.tolist(),
            }
        except (RuntimeError, ValueError) as e:
            return {"error": f"Fit failed: {e}"}

    def _fit_bi_exp(self, t, y):
        try:
            a0 = float(y[0] - y[-1])
            popt, pcov = curve_fit(
                _bi_exp, t, y,
                p0=[a0 * 0.7, t[-1] / 5, a0 * 0.3, t[-1] / 2, float(y[-1])],
                maxfev=10000,
            )

            perr = np.sqrt(np.diag(pcov))
            fitted = _bi_exp(t, *popt)
            residual = float(np.sum((y - fitted) ** 2))

            # Sort by tau (fast, slow)
            if popt[1] > popt[3]:
                popt = [popt[2], popt[3], popt[0], popt[1], popt[4]]
                perr = [perr[2], perr[3], perr[0], perr[1], perr[4]]

            return {
                "fit_type": "bi_exp",
                "a_fast": float(popt[0]),
                "tau_fast": float(popt[1]),
                "a_slow": float(popt[2]),
                "tau_slow": float(popt[3]),
                "offset": float(popt[4]),
                "weighted_tau": float(
                    (abs(popt[0]) * popt[1] + abs(popt[2]) * popt[3])
                    / (abs(popt[0]) + abs(popt[2]))
                ),
                "residual_ss": residual,
                "fitted_values": fitted.tolist(),
                "time_ms": t.tolist(),
            }
        except (RuntimeError, ValueError) as e:
            return {"error": f"Fit failed: {e}"}

    def _fit_boltzmann(self, data, params):
        x_values = np.array(params.get("x_values", []))
        y_values = np.array(params.get("y_values", []))

        if len(x_values) < 4 or len(y_values) < 4:
            return {"error": "Need at least 4 data points for Boltzmann fit"}

        try:
            popt, pcov = curve_fit(
                _boltzmann, x_values, y_values,
                p0=[np.median(x_values), 5.0, np.max(y_values), np.min(y_values)],
                maxfev=10000,
            )
            perr = np.sqrt(np.diag(pcov))
            fitted = _boltzmann(x_values, *popt)

            return {
                "fit_type": "boltzmann",
                "v_half": float(popt[0]),
                "slope": float(popt[1]),
                "top": float(popt[2]),
                "bottom": float(popt[3]),
                "v_half_err": float(perr[0]),
                "slope_err": float(perr[1]),
                "fitted_values": fitted.tolist(),
            }
        except (RuntimeError, ValueError) as e:
            return {"error": f"Fit failed: {e}"}


register_analysis(KineticsAnalysis())
