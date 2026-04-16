"""Analysis results storage — persists results in memory, keyed by
(analysis_type, file_path, group, series).

Results accumulate: running single-sweep resistance on sweep 1, then sweep 2,
appends both rows. Running "all sweeps" replaces only the monitor data, not
the individual measurements.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# In-memory store: { "resistance:/path/file.dat:0:0": { measurements: [...], monitor: {...} } }
_store: dict[str, dict[str, Any]] = {}


def _key(analysis_type: str, file_path: str, group: int, series: int) -> str:
    return f"{analysis_type}:{file_path}:{group}:{series}"


class StoreRequest(BaseModel):
    analysis_type: str
    file_path: str
    group: int
    series: int
    slot: str = "measurements"  # "measurements" (append) or "monitor" (replace)
    data: Any


class GetRequest(BaseModel):
    analysis_type: str
    file_path: str
    group: int
    series: int


@router.post("/store")
async def store_result(req: StoreRequest):
    """Store or append an analysis result."""
    k = _key(req.analysis_type, req.file_path, req.group, req.series)

    if k not in _store:
        _store[k] = {"measurements": [], "monitor": None}

    if req.slot == "measurements":
        # Append: single-sweep or averaged results accumulate
        if isinstance(req.data, list):
            _store[k]["measurements"].extend(req.data)
        else:
            _store[k]["measurements"].append(req.data)
    elif req.slot == "monitor":
        # Replace: monitor data is the full sweep-by-sweep run
        _store[k]["monitor"] = req.data

    return {"status": "ok", "n_measurements": len(_store[k]["measurements"])}


@router.post("/get")
async def get_results(req: GetRequest):
    """Retrieve stored results for a given analysis + file + series."""
    k = _key(req.analysis_type, req.file_path, req.group, req.series)
    entry = _store.get(k, {"measurements": [], "monitor": None})
    return entry


@router.post("/clear")
async def clear_results(req: GetRequest):
    """Clear stored results for a given analysis + file + series."""
    k = _key(req.analysis_type, req.file_path, req.group, req.series)
    _store.pop(k, None)
    return {"status": "cleared"}


@router.get("/clear_all")
async def clear_all():
    """Clear all stored results (e.g. when a new file is opened)."""
    _store.clear()
    return {"status": "cleared"}
