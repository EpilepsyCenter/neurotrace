"""Analysis base class and registry."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import numpy as np


class AnalysisBase(ABC):
    """Base class for all analysis types."""

    name: str = ""
    description: str = ""

    @abstractmethod
    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict[str, Any]:
        """Run the analysis and return results dict."""
        ...


# Registry of available analyses
_registry: dict[str, AnalysisBase] = {}


def register_analysis(analysis: AnalysisBase):
    _registry[analysis.name] = analysis


def get_analysis(name: str) -> AnalysisBase:
    if name not in _registry:
        raise ValueError(f"Unknown analysis: {name}. Available: {list(_registry.keys())}")
    return _registry[name]


def list_analyses() -> list[dict]:
    return [{"name": a.name, "description": a.description} for a in _registry.values()]
