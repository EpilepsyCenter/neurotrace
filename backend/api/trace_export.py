"""Trace Export API endpoints.

The exporter pulls traces from arbitrary recordings — the user can
overlay sweeps from different files in one figure — so we keep a
small in-process LRU of opened :class:`Recording`s rather than
relying on the single ``_current_recording`` slot used elsewhere.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.files import READERS
from export.trace_export import build_figure, render_data, render_to_bytes
from readers.models import Recording

router = APIRouter()


# ----- Recording registry -------------------------------------------------

class _RecordingRegistry:
    """LRU cache of opened recordings, keyed by absolute file path.

    Trace Export needs sweeps from many files in one render call. Re-
    parsing the source on every request is wasteful for large HEKA
    bundles, so we cache up to ``MAX`` recordings and evict on insert.
    """

    MAX = 8

    def __init__(self) -> None:
        self._cache: OrderedDict[str, Recording] = OrderedDict()

    def get_recording(self, file_path: str) -> Recording:
        if file_path in self._cache:
            self._cache.move_to_end(file_path)
            return self._cache[file_path]
        rec = self._open(file_path)
        self._cache[file_path] = rec
        if len(self._cache) > self.MAX:
            self._cache.popitem(last=False)
        return rec

    @staticmethod
    def _open(file_path: str) -> Recording:
        for reader in READERS:
            if reader.can_read(file_path):
                try:
                    return reader.read(file_path)
                except Exception as e:
                    raise HTTPException(
                        status_code=500,
                        detail=f"Error reading {file_path}: {e}",
                    )
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {file_path}",
        )


_registry = _RecordingRegistry()


# ----- Pydantic models -----------------------------------------------------

class FilterReq(BaseModel):
    enabled: bool = False
    type: str = "lowpass"
    low_hz: float = 0.0
    high_hz: float = 0.0
    order: int = 4


class BaselineReq(BaseModel):
    enabled: bool = False
    t0: float = 0.0
    t1: float = 0.05


class BlankingReq(BaseModel):
    enabled: bool = False
    t0: float = 0.0
    t1: float = 0.0
    mode: str = "interp"


class SeriesCfgReq(BaseModel):
    filter: FilterReq = Field(default_factory=FilterReq)
    baseline: BaselineReq = Field(default_factory=BaselineReq)
    blanking: BlankingReq = Field(default_factory=BlankingReq)


class StyleReq(BaseModel):
    color: str = "#1f77b4"
    weight: float = 1.5
    dash: str = ""
    alpha: float = 1.0
    individuals_alpha: float = 0.25
    mean_color: str | None = None
    mean_weight: float | None = None
    mean_dash: str | None = None
    mean_alpha: float | None = None


class TraceItemReq(BaseModel):
    id: str
    file_path: str
    group: int
    series: int
    trace: int = 0
    sweeps: list[int]
    show_individuals: bool = False
    show_mean: bool = True
    style: StyleReq = Field(default_factory=StyleReq)
    x_offset: float = 0.0
    y_offset: float = 0.0
    x_range: list[float] | None = None
    axis_id: str = "left"
    display_name: str = ""


class YAxisReq(BaseModel):
    id: str
    side: str = "left"  # 'left' | 'right' | 'right2' | ...
    label: str = ""
    unit: str = ""
    auto_limits: bool = True
    min: float | None = None
    max: float | None = None
    height_weight: float = 1.0


class LegendReq(BaseModel):
    enabled: bool = False
    position: str = "tr"   # tl | tr | bl | br | outside-right
    font_size: float = 10.0
    only_named: bool = False


class ScalebarReq(BaseModel):
    enabled: bool = True
    corner: str = "br"
    pad_x: float = 0.04
    pad_y: float = 0.06
    thickness_pt: float = 1.8
    color: str = "#222"
    show_labels: bool = True
    label_gap_pt: float = 4.0
    font_size: float = 10.0
    x_value: float | None = None
    x_unit: str | None = None
    y_overrides: dict[str, dict] = Field(default_factory=dict)


class RenderDataReq(BaseModel):
    items: list[TraceItemReq]
    series_cfgs: dict[str, SeriesCfgReq] = Field(default_factory=dict)
    decim_max_points: int = 8000


class RenderReq(BaseModel):
    items: list[TraceItemReq]
    series_cfgs: dict[str, SeriesCfgReq] = Field(default_factory=dict)
    axes: list[YAxisReq]
    scalebar: ScalebarReq = Field(default_factory=ScalebarReq)
    legend: LegendReq = Field(default_factory=LegendReq)
    axis_style: str = "scalebars"
    panel_layout: str = "overlay"  # "overlay" | "stacked"
    # Figure size is sent in centimeters (matplotlib's figsize wants
    # inches — the renderer converts at the edge).
    width_cm: float = 15.0
    height_cm: float = 10.0
    dpi: int = 300
    format: str = "svg"  # svg | pdf | png
    decim_max_points: int = 8000
    # Snapshot of the live preview's x-axis range. When present the
    # exporter uses this instead of computing the data envelope, so
    # the SVG/PDF/PNG matches the user's current zoom on screen.
    figure_x_range: list[float] | None = None


# ----- Endpoints -----------------------------------------------------------

@router.get("/file_info")
async def get_file_info(path: str) -> dict[str, Any]:
    """Return the group/series/sweep structure of a recording.

    The Trace Export window pulls sweeps from arbitrary files — it
    needs the structure of each file *without* installing it as the
    application's "current recording". The registry caches the
    parsed file so subsequent render calls are fast.
    """
    rec = _registry.get_recording(path)
    return rec.to_dict()


@router.post("/render_data")
async def post_render_data(req: RenderDataReq) -> dict[str, Any]:
    """Return processed sample arrays per trace item for the live preview."""
    payload = req.model_dump()
    return render_data(payload, registry=_registry)


@router.post("/render")
async def post_render(req: RenderReq) -> Response:
    """Render the figure and return raw bytes in the requested format."""
    payload = req.model_dump()
    fmt = req.format.lower()
    fig = build_figure(payload, registry=_registry)
    try:
        data = render_to_bytes(fig, fmt=fmt)
    finally:
        import matplotlib.pyplot as plt
        plt.close(fig)
    media_type = {
        "svg": "image/svg+xml",
        "pdf": "application/pdf",
        "png": "image/png",
    }[fmt]
    return Response(content=data, media_type=media_type)
