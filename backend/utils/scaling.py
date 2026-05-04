"""Per-trace numeric scaling.

All sample-value reads from a `Trace` should go through `scaled(trace)` so
user-applied unit overrides (stored on `Trace.y_scale` / `Trace.y_offset`) are
applied uniformly before any analysis or rendering sees the data.

The default `y_scale=1.0, y_offset=0.0` short-circuits to the original array
with no copy, so this is free for files that don't need overrides.
"""

from __future__ import annotations

import numpy as np

from readers.models import Trace


def scaled(trace: Trace) -> np.ndarray:
    if trace.y_scale == 1.0 and trace.y_offset == 0.0:
        return trace.data
    return trace.data * trace.y_scale + trace.y_offset
