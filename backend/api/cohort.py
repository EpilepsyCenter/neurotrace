"""Cohort Analysis API.

Phase B.1 deliverable — folder aggregation only. Stats running,
graph rendering, and export endpoints come in later phases.

# Endpoints

- ``GET  /api/cohort/analyses`` — list of analysis types the
  extractor registry knows about. Drives the wizard's analysis-type
  dropdown so the UI doesn't need to hardcode the list.

- ``POST /api/cohort/aggregate`` — walk a folder of ``.neurotrace``
  sidecars and return per-cell metric rows for the chosen analysis.
  Optional ``file_filter`` and ``series_filter`` honor the user's
  per-file checkbox selection and per-recording series trimming
  from the wizard.

# Why GET + POST split

Listing analyses is a constant-time lookup (no body needed → GET).
Aggregation has a meaningful body (filters, future stats config) and
returns a payload that can be MB-scale once distributions are
included → POST is the right verb.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from analysis import cohort

router = APIRouter()


class AggregateRequest(BaseModel):
    folder: str = Field(..., description="Absolute path to the folder containing .neurotrace sidecars.")
    analysis_type: str = Field(
        ..., description="One of the keys returned by /api/cohort/analyses."
    )
    file_filter: Optional[list[str]] = Field(
        default=None,
        description=(
            "Optional allow-list of recording file paths. When given, "
            "only sidecars next to these recordings contribute. Lets "
            "the cohort UI honor per-file checkbox selection."
        ),
    )
    series_filter: Optional[dict[str, list[str]]] = Field(
        default=None,
        description=(
            "Per-recording allow-list of '{group}:{series}' keys. "
            "When set for a recording, only those series contribute. "
            "Lets the user trim multi-series files."
        ),
    )


@router.get("/analyses")
def list_analyses() -> dict:
    """Return the analysis types the extractor registry handles.

    Also returns the curated default-checked metric lists so the
    metric tree (Phase B.5) doesn't have to call a separate endpoint.
    """
    return {
        "analyses": cohort.list_supported_analyses(),
        "default_metrics": cohort.DEFAULT_METRICS,
    }


@router.post("/aggregate")
def aggregate(req: AggregateRequest) -> dict:
    """Walk the folder and return per-cell metrics.

    Errors raised by individual extractors are caught inside
    :func:`cohort.aggregate_folder` and reported in ``errors`` so a
    single bad sidecar never aborts the whole scan. The HTTP layer
    only raises 400 for caller-fault problems (bad analysis type,
    folder not a string).
    """
    try:
        return cohort.aggregate_folder(
            folder=req.folder,
            analysis_type=req.analysis_type,
            file_filter=req.file_filter,
            series_filter=req.series_filter,
        )
    except ValueError as exc:
        # Unknown analysis_type — caller error.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
