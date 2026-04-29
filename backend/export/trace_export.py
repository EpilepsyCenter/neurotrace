"""Figure builder for Trace Export.

Renders a single matplotlib figure from a render-config payload.
The data processing pipeline (filter / baseline / blanking /
decimation) is shared with the live preview via ``trace_processing``,
so the figure the user exports is exactly the trace they were just
looking at in uPlot — only the rendering differs.
"""

from __future__ import annotations

import io
from typing import Optional

import numpy as np

from export.scalebar import ScalebarCfg, draw_scalebar
from export.trace_processing import (
    BaselineCfg, BlankingCfg, DecimationCfg, FilterCfg, SeriesCfg,
    average_traces, process_trace,
)


# ----- Header / matplotlib setup -------------------------------------------

def _ensure_mpl_backend():
    """Use the non-interactive Agg backend so rendering works without
    a display server (matters when the bundled backend runs headless
    inside Electron)."""
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt  # noqa: F401  (side-effect import)


_ensure_mpl_backend()


# ----- Public API ----------------------------------------------------------

def build_figure(payload: dict, *, registry):
    """Build and return a matplotlib Figure from a render payload.

    ``registry`` is anything that exposes ``get_recording(file_path)``
    returning a :class:`Recording` — see ``api/trace_export.py`` for
    the cached implementation.
    """
    import matplotlib.pyplot as plt
    from utils.fonts import apply_mono_rc, ensure_jetbrains_mono_registered

    # Figure size in cm (everything user-facing in the app speaks cm);
    # matplotlib figsize takes inches, so convert at the edge.
    width_cm = float(payload.get("width_cm", 15.0))
    height_cm = float(payload.get("height_cm", 10.0))
    width = width_cm / 2.54
    height = height_cm / 2.54
    dpi = int(payload.get("dpi", 300))
    axis_style = payload.get("axis_style", "scalebars")
    panel_layout = payload.get("panel_layout", "overlay")
    items = payload.get("items", [])
    series_cfgs_raw: dict = payload.get("series_cfgs", {})
    axes_req = payload.get("axes", [])

    # Apply JetBrains Mono if available — same convention as cohort graphs
    try:
        ensure_jetbrains_mono_registered()
        apply_mono_rc(plt.rcParams)
    except Exception:
        pass

    fig = plt.figure(figsize=(width, height), dpi=dpi)

    # Build axis layout — one of two shapes:
    #
    #   overlay  → single subplot, every extra y-axis is twinx() of the
    #              first. All axes paint into the same drawing area.
    #
    #   stacked  → N subplots stacked vertically with sharex. Each
    #              y-axis owns a panel; the bottom panel is the
    #              "ground" for the x-axis (xticks, x-scalebar, etc.).
    #
    # ``axes_by_id`` is the lookup the rest of the function uses; the
    # two paths produce the same map shape so downstream code stays
    # branch-free.
    axes_by_id: dict[str, "object"] = {}
    bottom_ax_id: str = axes_req[0]["id"] if axes_req else "y0"

    if panel_layout == "stacked" and len(axes_req) > 1:
        weights = [max(0.25, float(a.get("height_weight", 1.0))) for a in axes_req]
        gs = fig.add_gridspec(
            nrows=len(axes_req), ncols=1,
            height_ratios=weights,
            hspace=0.12,
        )
        prev_ax = None
        for idx, a in enumerate(axes_req):
            ax = fig.add_subplot(gs[idx, 0], sharex=prev_ax)
            ax.set_facecolor("white")
            axes_by_id[a["id"]] = ax
            prev_ax = ax
        # In stacked, the LAST subplot is the bottom — that's where
        # xticks / xlabel / x-scalebar belong. Top subplots hide their
        # x ticks below to avoid clutter.
        bottom_ax_id = axes_req[-1]["id"]
        primary_ax = axes_by_id[axes_req[0]["id"]]
    else:
        # Overlay: single panel + twinx siblings (existing behavior).
        primary_ax = fig.add_subplot(111)
        primary_ax.set_facecolor("white")
        side_counter = {"left": 0, "right": 0}
        for idx, a in enumerate(axes_req):
            aid = a["id"]
            if idx == 0:
                ax = primary_ax
            else:
                ax = primary_ax.twinx()
                side = a.get("side", "right")
                if side.startswith("right"):
                    side_counter["right"] += 1
                    if side_counter["right"] > 1:
                        ax.spines["right"].set_position(
                            ("axes", 1.0 + 0.08 * (side_counter["right"] - 1))
                        )
            axes_by_id[aid] = ax
        bottom_ax_id = axes_req[0]["id"] if axes_req else "y0"

    legend_cfg = payload.get("legend") or {}
    legend_enabled = bool(legend_cfg.get("enabled", False))
    only_named = bool(legend_cfg.get("only_named", False))

    # Render each trace item onto its assigned axis
    item_payloads: list[dict] = []
    for item in items:
        ax_id = item.get("axis_id") or (axes_req[0]["id"] if axes_req else "left")
        ax = axes_by_id.get(ax_id, primary_ax)
        cfg = _decode_series_cfg(series_cfgs_raw, item)
        sweeps = item.get("_resolved")
        if sweeps is None:
            sweeps = _resolve_traces(item, registry=registry)
        # Resolve the legend label for this item. ``display_name`` is
        # the user's custom override (entered in the TraceEditor); if
        # empty we fall back to the verbose source path so the export
        # is still readable. ``only_named`` filters out the verbose
        # auto-labels for users who want a curated legend.
        label = (item.get("display_name") or "").strip()
        if not label and not only_named:
            label = item.get("label") or item.get("file_name") or item.get("id") or ""
        legend_label = label if (legend_enabled and label) else None
        rendered = _render_item(ax, item, cfg, sweeps, legend_label=legend_label)
        item_payloads.append({**rendered, "axis_id": ax_id})

    # Apply axis labels / limits / style
    is_stacked = panel_layout == "stacked" and len(axes_req) > 1
    for idx, a in enumerate(axes_req):
        ax = axes_by_id[a["id"]]
        label = a.get("label", "")
        unit = a.get("unit", "")
        title = label if not unit else (f"{label} ({unit})" if label else unit)
        is_bottom = (a["id"] == bottom_ax_id)
        if axis_style == "axes":
            if is_bottom:
                ax.set_xlabel("Time (s)")
            else:
                # Hide xticks on top subplots so the shared x reads
                # cleanly only at the bottom.
                ax.tick_params(axis="x", which="both",
                               labelbottom=False, bottom=False)
            ax.set_ylabel(title)
        else:
            # Scalebar mode — strip every axis decoration; scalebars
            # below will provide the only scale info.
            ax.set_yticks([])
            for spine in ("top", "right", "left", "bottom"):
                ax.spines[spine].set_visible(False)
            ax.set_xticks([])
        if not a.get("auto_limits", True):
            ymin = a.get("min")
            ymax = a.get("max")
            if ymin is not None and ymax is not None:
                ax.set_ylim(ymin, ymax)

    # Overlay-only: hide x-axis ticks on the secondary (twinx) axes so
    # we don't get duplicate tick rows. In stacked, the loop above
    # already did this per non-bottom subplot.
    if not is_stacked:
        for idx, a in enumerate(axes_req[1:], start=1):
            axes_by_id[a["id"]].set_xticks([])

    # X-limits: prefer the live preview's snapshot (set by the user
    # via wheel-zoom / pan in the uPlot panel) so the export matches
    # what's on screen. Fall back to the data envelope across items
    # when no snapshot is sent (e.g. a programmatic export or a
    # never-touched figure). In stacked layout sharex propagates the
    # range to all panels automatically; in overlay we set on primary.
    fxr = payload.get("figure_x_range")
    if isinstance(fxr, (list, tuple)) and len(fxr) == 2:
        primary_ax.set_xlim(float(fxr[0]), float(fxr[1]))
    elif item_payloads:
        x_lo = min(p["t_min"] for p in item_payloads if p.get("t_min") is not None)
        x_hi = max(p["t_max"] for p in item_payloads if p.get("t_max") is not None)
        if np.isfinite(x_lo) and np.isfinite(x_hi) and x_hi > x_lo:
            primary_ax.set_xlim(x_lo, x_hi)

    # Scalebars
    if axis_style == "scalebars":
        sb_payload = payload.get("scalebar", {}) or {}
        sb = ScalebarCfg(
            enabled=bool(sb_payload.get("enabled", True)),
            corner=sb_payload.get("corner", "br"),
            pad_x=float(sb_payload.get("pad_x", 0.04)),
            pad_y=float(sb_payload.get("pad_y", 0.06)),
            thickness_pt=float(sb_payload.get("thickness_pt", 1.8)),
            color=sb_payload.get("color", "#222"),
            show_labels=bool(sb_payload.get("show_labels", True)),
            label_gap_pt=float(sb_payload.get("label_gap_pt", 4.0)),
            font_size=float(sb_payload.get("font_size", 10.0)),
            x_value=sb_payload.get("x_value"),
            x_unit=sb_payload.get("x_unit"),
            y_overrides=sb_payload.get("y_overrides", {}) or {},
        )
        # Compute ranges per axis. In stacked layout, the time bar
        # belongs ONLY to the bottom panel (publication convention),
        # so y-axes are split: bottom panel keeps its y-bar in the
        # shared corner alongside the time bar; top panels get their
        # y-bar drawn in their own corner without a time bar.
        t_lo, t_hi = primary_ax.get_xlim()
        if is_stacked:
            bottom_ax = axes_by_id[bottom_ax_id]
            bottom_axis_req = next(a for a in axes_req if a["id"] == bottom_ax_id)
            blo, bhi = bottom_ax.get_ylim()
            draw_scalebar(
                bottom_ax,
                cfg=sb,
                t_range=t_hi - t_lo,
                y_axes=[(bottom_axis_req["id"], bhi - blo, bottom_axis_req.get("unit", ""), bottom_ax)],
            )
            # Top panels: y-only scalebar via a config copy with no
            # time-bar drawing. We achieve "no time bar" by passing a
            # zero-length t_range — the scalebar helper still renders
            # the y-bar at the chosen corner. (Cleaner alternative is
            # a flag, but the helper already handles t_range <= 0.)
            for a in axes_req:
                if a["id"] == bottom_ax_id:
                    continue
                ax = axes_by_id[a["id"]]
                ylo, yhi = ax.get_ylim()
                draw_scalebar(
                    ax,
                    cfg=sb,
                    t_range=0,
                    y_axes=[(a["id"], yhi - ylo, a.get("unit", ""), ax)],
                )
        else:
            y_axes_info = []
            for a in axes_req:
                ax = axes_by_id[a["id"]]
                ylo, yhi = ax.get_ylim()
                y_axes_info.append((a["id"], yhi - ylo, a.get("unit", ""), ax))
            draw_scalebar(primary_ax, cfg=sb, t_range=t_hi - t_lo, y_axes=y_axes_info)

    if legend_enabled:
        # Map the JSON corner code to matplotlib's ``loc`` strings.
        loc_map = {
            "tl": "upper left", "tr": "upper right",
            "bl": "lower left", "br": "lower right",
            "outside-right": "center left",  # paired with bbox below
        }
        pos = legend_cfg.get("position", "tr")
        loc = loc_map.get(pos, "upper right")
        kwargs = {
            "loc": loc,
            "fontsize": float(legend_cfg.get("font_size", 10.0)),
            "frameon": True,
            "framealpha": 0.85,
        }
        if pos == "outside-right":
            kwargs["bbox_to_anchor"] = (1.02, 0.5)
        if is_stacked:
            # Per-panel legend: each subplot only legends its own
            # series. Visually keeps trace ↔ panel association tight.
            for a in axes_req:
                ax = axes_by_id[a["id"]]
                h, l = ax.get_legend_handles_labels()
                if h:
                    ax.legend(h, l, **kwargs)
        else:
            # Single combined legend on the primary axis (overlay
            # mode — twinx siblings share the same drawing area).
            handles, labels = primary_ax.get_legend_handles_labels()
            for ax in axes_by_id.values():
                if ax is primary_ax:
                    continue
                h, l = ax.get_legend_handles_labels()
                handles += h
                labels += l
            if handles:
                primary_ax.legend(handles, labels, **kwargs)

    fig.tight_layout()
    return fig


def render_to_bytes(fig, fmt: str = "svg") -> bytes:
    """Serialize a figure to bytes in the chosen format."""
    buf = io.BytesIO()
    fmt = fmt.lower()
    if fmt not in ("svg", "pdf", "png"):
        raise ValueError(f"Unsupported export format: {fmt}")
    fig.savefig(buf, format=fmt, bbox_inches="tight")
    return buf.getvalue()


# ----- Internal helpers ----------------------------------------------------

def _decode_series_cfg(raw: dict, item: dict) -> SeriesCfg:
    key = f"{item['file_path']}|{item['group']}:{item['series']}"
    s = raw.get(key, {}) if raw else {}
    f = s.get("filter", {})
    b = s.get("baseline", {})
    bl = s.get("blanking", {})
    return SeriesCfg(
        filter=FilterCfg(
            enabled=bool(f.get("enabled", False)),
            type=f.get("type", "lowpass"),
            low_hz=float(f.get("low_hz", 0.0)),
            high_hz=float(f.get("high_hz", 0.0)),
            order=int(f.get("order", 4)),
        ),
        baseline=BaselineCfg(
            enabled=bool(b.get("enabled", False)),
            t0=float(b.get("t0", 0.0)),
            t1=float(b.get("t1", 0.05)),
        ),
        blanking=BlankingCfg(
            enabled=bool(bl.get("enabled", False)),
            t0=float(bl.get("t0", 0.0)),
            t1=float(bl.get("t1", 0.0)),
            mode=bl.get("mode", "interp"),
        ),
    )


def _resolve_traces(item: dict, *, registry) -> list[tuple[np.ndarray, float, str]]:
    """Return [(values, sr, unit), ...] for each requested sweep.

    Honors the ``averaged`` source mode by reading the precomputed
    averaged sweep stored in the sidecar's ``averaged`` block (Phase A).
    For a regular sweep, reads from the live recording.
    """
    rec = registry.get_recording(item["file_path"])
    grp = rec.groups[int(item["group"])]
    ser = grp.series_list[int(item["series"])]
    trace_idx = int(item.get("trace", 0))
    out: list[tuple[np.ndarray, float, str]] = []
    for sw_idx in item.get("sweeps", []):
        if sw_idx < 0 or sw_idx >= ser.sweep_count:
            continue
        sw = ser.sweeps[sw_idx]
        if trace_idx >= sw.trace_count:
            continue
        tr = sw.traces[trace_idx]
        out.append((np.asarray(tr.data, dtype=np.float64), float(tr.sampling_rate), tr.units))
    return out


def _render_item(ax, item: dict, cfg: SeriesCfg, sweeps: list, *, legend_label: str | None) -> dict:
    """Draw one trace item on the given axes; return summary metadata.

    ``legend_label`` is attached to whichever line is the canonical
    representative for this item (mean if shown + ≥2 sweeps, else the
    base line). Other lines stay anonymous so matplotlib doesn't fan
    them out into N legend entries per overlay.
    """
    style = item.get("style", {}) or {}
    color = style.get("color", "#1f77b4")
    weight = float(style.get("weight", 1.5))
    dash = style.get("dash", "")
    alpha = float(style.get("alpha", 1.0))
    individuals_alpha = float(style.get("individuals_alpha", 0.25))
    # Mean-overlay style — fall back to the individual style if the
    # caller didn't send a mean override (keeps single-sweep traces
    # and old payloads working unchanged).
    mean_color = style.get("mean_color") or color
    mean_weight = float(style.get("mean_weight") if style.get("mean_weight") is not None else weight)
    mean_dash = style.get("mean_dash") if style.get("mean_dash") is not None else dash
    mean_alpha = float(style.get("mean_alpha") if style.get("mean_alpha") is not None else alpha)
    show_mean = bool(item.get("show_mean", True))
    show_individuals = bool(item.get("show_individuals", False))
    x_offset = float(item.get("x_offset", 0.0))
    y_offset = float(item.get("y_offset", 0.0))
    x_range = item.get("x_range")
    if isinstance(x_range, (list, tuple)) and len(x_range) == 2:
        x_window = (float(x_range[0]), float(x_range[1]))
    else:
        x_window = None
    decim = DecimationCfg(enabled=True, max_points=int(item.get("decim_max_points", 8000)))

    if not sweeps:
        return {"t_min": None, "t_max": None}

    processed: list[tuple[np.ndarray, np.ndarray]] = []
    for values, sr, _unit in sweeps:
        t, v = process_trace(values, sr, cfg, x_window=x_window, x_offset=x_offset, decimation=decim)
        if len(t) > 0:
            if y_offset != 0.0:
                v = v + y_offset
            processed.append((t, v))

    if not processed:
        return {"t_min": None, "t_max": None}

    linestyle = "-" if not dash else dash
    mean_linestyle = "-" if not mean_dash else mean_dash

    if show_individuals or not show_mean:
        # When the mean isn't drawn, attach the legend label to the
        # FIRST individual so the trace gets exactly one legend entry.
        # When the mean IS drawn alongside, the mean line below carries
        # the label and individuals stay unlabeled.
        for idx, (t, v) in enumerate(processed):
            this_label = legend_label if (idx == 0 and not show_mean) else None
            ax.plot(t, v, color=color, linewidth=weight,
                    linestyle=linestyle,
                    alpha=individuals_alpha if show_mean else alpha,
                    label=this_label)

    if show_mean and len(processed) > 1:
        # Interpolate all sweeps onto the first sweep's time grid before averaging.
        ref_t = processed[0][0]
        stacked = np.stack([
            np.interp(ref_t, t, v) for t, v in processed
        ], axis=0)
        mean_v = np.mean(stacked, axis=0)
        ax.plot(ref_t, mean_v, color=mean_color, linewidth=mean_weight,
                linestyle=mean_linestyle, alpha=mean_alpha,
                label=legend_label)
    elif show_mean and len(processed) == 1:
        # Single sweep: render with the base (individuals) style, not
        # the mean style — there's no aggregation happening.
        t, v = processed[0]
        ax.plot(t, v, color=color, linewidth=weight,
                linestyle=linestyle, alpha=alpha,
                label=legend_label)

    t_min = min(t[0] for t, _ in processed if len(t) > 0)
    t_max = max(t[-1] for t, _ in processed if len(t) > 0)
    return {"t_min": float(t_min), "t_max": float(t_max)}


def render_data(payload: dict, *, registry) -> dict:
    """Compute processed arrays for the live (uPlot) preview.

    Mirrors :func:`build_figure` but skips matplotlib entirely — we
    return raw time/value arrays per trace item so the frontend can
    draw them. Same processing pipeline → same shape on screen.
    """
    items = payload.get("items", [])
    series_cfgs_raw = payload.get("series_cfgs", {}) or {}
    decim_max = int(payload.get("decim_max_points", 8000))

    out_items = []
    for item in items:
        cfg = _decode_series_cfg(series_cfgs_raw, item)
        sweeps = _resolve_traces(item, registry=registry)
        if not sweeps:
            out_items.append({"id": item["id"], "series": []})
            continue

        x_offset = float(item.get("x_offset", 0.0))
        # NOTE: y_offset is intentionally NOT applied here. Drag-to-move
        # in the live preview updates y_offset on every mousemove, and
        # if the backend applied it we'd re-fetch on every drag tick.
        # The frontend adds y_offset locally when building the uPlot
        # data (cheap, no round-trip). The export path (build_figure)
        # DOES apply y_offset because there's no live drag there.
        x_range = item.get("x_range")
        if isinstance(x_range, (list, tuple)) and len(x_range) == 2:
            x_window = (float(x_range[0]), float(x_range[1]))
        else:
            x_window = None
        decim = DecimationCfg(enabled=True, max_points=decim_max)

        series_payload = []
        processed: list[tuple[np.ndarray, np.ndarray]] = []
        for values, sr, _unit in sweeps:
            t, v = process_trace(values, sr, cfg, x_window=x_window, x_offset=x_offset, decimation=decim)
            if len(t) == 0:
                continue
            processed.append((t, v))

        show_mean = bool(item.get("show_mean", True))
        show_individuals = bool(item.get("show_individuals", False))

        if show_individuals or not show_mean:
            for idx, (t, v) in enumerate(processed):
                series_payload.append({
                    "kind": "sweep",
                    "sweep_index": int(item["sweeps"][idx]) if idx < len(item.get("sweeps", [])) else idx,
                    "time": t.tolist(),
                    "values": v.tolist(),
                })

        if show_mean and len(processed) > 1:
            ref_t = processed[0][0]
            stacked = np.stack([np.interp(ref_t, t, v) for t, v in processed], axis=0)
            mean_v = np.mean(stacked, axis=0)
            series_payload.append({
                "kind": "mean",
                "time": ref_t.tolist(),
                "values": mean_v.tolist(),
            })
        elif show_mean and len(processed) == 1:
            t, v = processed[0]
            series_payload.append({
                "kind": "single",
                "time": t.tolist(),
                "values": v.tolist(),
            })

        # Source unit (use first sweep's unit) — used for axis label hints
        unit = sweeps[0][2] if sweeps else ""
        out_items.append({
            "id": item["id"],
            "axis_id": item.get("axis_id"),
            "unit": unit,
            "series": series_payload,
        })

    return {"items": out_items}


