"""Scalebar primitives for Trace Export.

Auto-picks "nice" round values (1 / 2 / 5 × 10ⁿ) for both axes and
draws an L-shape scalebar in matplotlib axes coordinates so the
scalebar lives in a corner regardless of data limits.

The user can override every parameter (values, units, position,
thickness, gap, label visibility) — these helpers are the auto-pick
seed plus a single draw routine the figure builder calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np

# Time-unit ladder for auto-prefixing — covers ephys typical ranges.
TIME_UNITS = [
    ("min", 60.0),
    ("s",   1.0),
    ("ms",  1e-3),
    ("µs",  1e-6),
]

# Y-unit prefix ladder. We never CHANGE the base unit (pA stays pA, mV
# stays mV) — only choose a sensible numeric size for the scalebar.
NICE_STEPS = [1, 2, 5]


def _nice_value(target: float) -> float:
    """Round ``target`` to the nearest 1/2/5 × 10ⁿ.

    Aims for a value that's <= target so the scalebar always fits
    inside the visible range.
    """
    if target <= 0 or not np.isfinite(target):
        return 1.0
    exp = int(np.floor(np.log10(target)))
    base = 10 ** exp
    candidates = [s * base for s in NICE_STEPS]
    candidates += [s * base * 10 for s in NICE_STEPS]  # one decade up
    feasible = [c for c in candidates if c <= target]
    return max(feasible) if feasible else candidates[0]


def auto_time_scalebar(t_range: float) -> tuple[float, str]:
    """Return ``(value_in_seconds, display_unit)`` for a time scalebar.

    Targets ~25 % of the visible time range, snapped to a nice value
    in whichever time unit reads naturally. ``t_range`` is in seconds.
    """
    if t_range <= 0:
        return 1e-3, "ms"
    target = t_range * 0.25
    # Pick the unit whose magnitude best matches the target. We require
    # the target to be ≥ 1× the unit's scale before picking it, so a
    # 30-second target reads as "30 s" rather than "0.5 min".
    for label, scale in TIME_UNITS:
        if target >= scale:
            value_in_unit = _nice_value(target / scale)
            return value_in_unit * scale, label
    label, scale = TIME_UNITS[-1]
    return _nice_value(target / scale) * scale, label


def auto_y_scalebar(y_range: float, unit: str) -> tuple[float, str]:
    """Return ``(value, display_unit)`` for a y-axis scalebar.

    We don't try to retro-prefix a base unit (e.g. pA → nA); we leave
    the unit as-given and pick a nice numeric value that's ~25 % of
    the visible range. Users can override the unit string in the UI
    if they want.
    """
    if y_range <= 0:
        return 1.0, unit
    return _nice_value(y_range * 0.25), unit


@dataclass
class ScalebarCfg:
    """Per-figure scalebar configuration (when axisStyle == 'scalebars')."""
    enabled: bool = True
    corner: Literal["br", "bl", "tr", "tl"] = "br"
    pad_x: float = 0.04          # axes-relative offset from chosen corner
    pad_y: float = 0.06
    thickness_pt: float = 1.8    # line width in points
    color: str = "#222"
    show_labels: bool = True
    label_gap_pt: float = 4.0    # gap between bar and label, in points
    font_size: float = 10.0

    # x (time) bar
    x_value: Optional[float] = None  # in seconds; None = auto-pick
    x_unit: Optional[str] = None     # display unit override

    # y bars — one entry per axis_id (in figure order). When the user
    # has multiple y-axes we draw one y-bar per axis sharing the corner.
    # Each entry: (axis_id, value_or_none, unit_or_none).
    y_overrides: dict[str, dict] = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.y_overrides is None:
            self.y_overrides = {}


def draw_scalebar(
    ax,
    *,
    cfg: ScalebarCfg,
    t_range: float,
    y_axes: list[tuple[str, float, str, "object"]],
):
    """Draw an L-shape scalebar on ``ax``.

    ``y_axes`` is a list of ``(axis_id, y_range, unit, mpl_axes)`` —
    we draw the time bar on the bottom axis (the first one) and one
    short y-bar per axis stacked at the corner.
    """
    if not cfg.enabled or not y_axes:
        return

    # ``t_range <= 0`` is the caller's signal that this axis is one of
    # the top panels in a stacked layout — it gets a y-bar only, no
    # time bar (the time bar lives on the bottom panel only).
    skip_time_bar = t_range <= 0

    # Pick the time bar
    if cfg.x_value is not None and cfg.x_value > 0:
        x_val = cfg.x_value
        x_unit = cfg.x_unit or "s"
    else:
        x_val, x_unit = auto_time_scalebar(t_range)

    fig = ax.figure
    # Convert axes-fraction pad into data coordinates for the primary axis.
    # We'll draw the time bar on the primary x-axis using a single short
    # horizontal segment, and y-bars on each y-axis using vertical segments.

    # Use blended transforms so the bar lengths are in data units while
    # the corner anchor is in axes coordinates.
    from matplotlib.transforms import blended_transform_factory

    # Anchor point in axes coords:
    if "r" in cfg.corner:
        ax_x = 1.0 - cfg.pad_x
        ha = "right"
    else:
        ax_x = cfg.pad_x
        ha = "left"
    if "b" in cfg.corner:
        ax_y = cfg.pad_y
        va = "bottom"
    else:
        ax_y = 1.0 - cfg.pad_y
        va = "top"

    # Convert anchor to data coords on the primary axis to compute bar ends
    inv = ax.transAxes.transform((ax_x, ax_y))
    anchor_data = ax.transData.inverted().transform(inv)
    x0, y0 = anchor_data

    # Time bar endpoints in data units (primary x-axis). When we're
    # on a top panel of a stacked layout (skip_time_bar), we still
    # need an x anchor for the y-bar to share but we don't draw the
    # horizontal segment or its label.
    if "r" in cfg.corner:
        x_end = x0
        x_start = x0 - (0 if skip_time_bar else x_val)
    else:
        x_start = x0
        x_end = x0 + (0 if skip_time_bar else x_val)

    if not skip_time_bar:
        ax.plot(
            [x_start, x_end], [y0, y0],
            color=cfg.color, linewidth=cfg.thickness_pt,
            solid_capstyle="butt", clip_on=False, zorder=10,
        )
        if cfg.show_labels:
            ax.annotate(
                f"{_fmt_value(x_val * _to_unit_factor(x_unit))} {x_unit}",
                xy=((x_start + x_end) / 2, y0),
                xytext=(0, -cfg.label_gap_pt),
                textcoords="offset points",
                ha="center", va="top",
                color=cfg.color, fontsize=cfg.font_size, clip_on=False,
            )

    # Y bars — one per axis, stacked at the corner side.
    # Use the rightmost/leftmost x as the bar's x position.
    bar_x = x_end if "r" in cfg.corner else x_start
    for axis_id, y_range, unit, ax_y_mpl in y_axes:
        override = cfg.y_overrides.get(axis_id, {}) if cfg.y_overrides else {}
        y_val = override.get("value")
        y_unit_display = override.get("unit") or unit
        if not y_val or y_val <= 0:
            y_val, y_unit_display = auto_y_scalebar(y_range, unit)

        # Re-anchor on this y-axis since data y-coords differ
        inv2 = ax_y_mpl.transAxes.transform((ax_x, ax_y))
        anchor2 = ax_y_mpl.transData.inverted().transform(inv2)
        _, y_anchor = anchor2

        ax_y_mpl.plot(
            [bar_x, bar_x], [y_anchor, y_anchor + y_val],
            color=cfg.color, linewidth=cfg.thickness_pt,
            solid_capstyle="butt", clip_on=False, zorder=10,
        )
        if cfg.show_labels:
            ax_y_mpl.annotate(
                f"{_fmt_value(y_val)} {y_unit_display}",
                xy=(bar_x, y_anchor + y_val / 2),
                xytext=(cfg.label_gap_pt if "l" in cfg.corner else -cfg.label_gap_pt, 0),
                textcoords="offset points",
                ha="left" if "l" in cfg.corner else "right",
                va="center",
                color=cfg.color, fontsize=cfg.font_size, clip_on=False,
                rotation=90 if "r" in cfg.corner else -90,
            )


def _to_unit_factor(unit: str) -> float:
    for label, scale in TIME_UNITS:
        if label == unit:
            return 1.0 / scale
    return 1.0


def _fmt_value(v: float) -> str:
    """Trim trailing zeros for cleaner labels (5.0 → 5, 2.5 → 2.5)."""
    if v == int(v):
        return str(int(v))
    return f"{v:g}"
