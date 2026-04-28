"""Cohort plot rendering — Phase B.6.

Three plot kinds, dispatched by ``kind``:

* ``scalar``       — strip plot of per-cell values per group, with
                     mean horizontal line + SEM whisker. No bars
                     (lab convention forbids bar-only). Significance
                     brackets above pairs whose post-hoc p < 0.05.
* ``distribution`` — per-cell ECDF lines (faded) + group mean ECDF
                     (bold). Reads K-S annotation from the stats
                     payload when supplied by the caller.
* ``timeseries``   — per-cell light traces + group mean ± SEM band.
                     X axis is bin index by default; if the caller
                     supplies a consistent ``bin_width_s`` across
                     all cells, switches to minutes.

Output: an SVG XML string + a small metadata dict (axis bounds,
time-axis used, etc.) so the frontend's modal can offer axis
overrides without re-asking the backend for layout info.

Matplotlib is imported lazily inside the render function so the
``cohort.aggregate_folder`` path stays import-light. We use the
``Agg`` backend (no GUI required, server-process safe).
"""

from __future__ import annotations

import io
import math
from typing import Any, Optional

import numpy as np


# ---------------------------------------------------------------------
# Significance star convention — matches the standard most journals
# use (* p<.05, ** p<.01, *** p<.001, ns otherwise).
# ---------------------------------------------------------------------

def _stars(p: Optional[float]) -> str:
    if p is None or math.isnan(p):
        return ''
    if p < 0.001:
        return '***'
    if p < 0.01:
        return '**'
    if p < 0.05:
        return '*'
    return 'ns'


# ---------------------------------------------------------------------
# Default per-group color palette. Picked to be colour-blind-friendly
# (Wong 2011 modified) and reasonably distinct on both light and dark
# backgrounds.
# ---------------------------------------------------------------------

DEFAULT_PALETTE = [
    '#0072B2',  # blue
    '#D55E00',  # vermillion
    '#009E73',  # bluish green
    '#CC79A7',  # reddish purple
    '#F0E442',  # yellow
    '#56B4E9',  # sky blue
    '#E69F00',  # orange
    '#999999',  # grey
]


def _theme_colors(theme: str) -> dict[str, str]:
    """Resolve theme name → matplotlib-friendly hex colour set.
    Mirrors the CSS variable values in ``frontend/src/styles/global.css``
    so the rendered SVG visually matches the rest of the app."""
    if theme == 'light':
        return {
            'fg': '#1a1a1a',
            'fg_muted': '#666666',
            'bg': '#ffffff',
            'grid': '#dddddd',
            'border': '#cccccc',
        }
    # default = dark
    return {
        'fg': '#e0e0e0',
        'fg_muted': '#888888',
        'bg': '#1e1e1e',
        'grid': '#3a3a3a',
        'border': '#444444',
    }


def _style_axes(ax, colors: dict, ylabel: str, xlabel: str = ''):
    ax.set_facecolor(colors['bg'])
    ax.tick_params(colors=colors['fg'], labelsize=9)
    for spine_name, spine in ax.spines.items():
        if spine_name in ('top', 'right'):
            spine.set_visible(False)
        else:
            spine.set_color(colors['border'])
    ax.set_ylabel(ylabel, color=colors['fg'], fontsize=10)
    if xlabel:
        ax.set_xlabel(xlabel, color=colors['fg'], fontsize=10)
    ax.yaxis.label.set_color(colors['fg'])
    ax.xaxis.label.set_color(colors['fg'])
    ax.grid(True, axis='y', color=colors['grid'], linestyle='-', linewidth=0.5, alpha=0.6)


def _figure(theme: str, width_in: float = 5.5, height_in: float = 4.0):
    """Create a (fig, ax) with the cohort theme applied. Caller is
    responsible for closing the figure when done."""
    import matplotlib
    matplotlib.use('Agg', force=True)
    import matplotlib.pyplot as plt
    # Register + apply the bundled JetBrains Mono family before the
    # figure is built so every text element drawn from here on
    # (titles, axis labels, ticks, legends, p-value annotations,
    # significance brackets) inherits the theme mono. Idempotent
    # across calls. Failure here is non-fatal — ``apply_mono_rc``
    # leaves a sensible fallback chain in rcParams.
    from utils.fonts import ensure_jetbrains_mono_registered, apply_mono_rc
    ensure_jetbrains_mono_registered()
    apply_mono_rc(plt.rcParams)
    colors = _theme_colors(theme)
    fig, ax = plt.subplots(figsize=(width_in, height_in), dpi=110)
    fig.patch.set_facecolor(colors['bg'])
    return fig, ax, colors


def _to_svg(fig) -> str:
    """Render figure to SVG XML string and close it."""
    import matplotlib.pyplot as plt
    buf = io.StringIO()
    fig.savefig(buf, format='svg', bbox_inches='tight', transparent=False)
    plt.close(fig)
    return buf.getvalue()


def _to_png_b64(fig, dpi: int = 150) -> str:
    import base64
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', transparent=False, dpi=dpi)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def _to_pdf_b64(fig) -> str:
    """Render figure to a single-page PDF and base64-encode it.

    Used for the modal's "Save as PDF" export. PDF embeds a Type 42
    subset of JetBrains Mono so the file is portable to any machine
    even without the font installed (whereas SVG with
    ``svg.fonttype='none'`` falls back to whatever the viewer has).
    """
    import base64
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    # ``bbox_inches='tight'`` gives the same trimmed result as the
    # SVG path so the modal's WYSIWYG match across formats holds.
    fig.savefig(buf, format='pdf', bbox_inches='tight', transparent=False)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def _display(g: dict) -> str:
    """Visible label for a group — honor ``display_tag`` override
    (set by the dispatcher when the user renames a group in the
    modal) and fall back to the canonical ``tag``. Posthoc lookup
    code keeps using ``g['tag']`` so significance brackets still
    match the right groups regardless of display name."""
    dt = g.get('display_tag')
    if dt is not None and str(dt) != '':
        return str(dt)
    return str(g.get('tag', ''))


def _clean(xs) -> list[float]:
    out: list[float] = []
    for x in xs or []:
        if x is None:
            continue
        try:
            f = float(x)
        except (TypeError, ValueError):
            continue
        if math.isnan(f):
            continue
        out.append(f)
    return out


# ---------------------------------------------------------------------
# Scalar dot plot
# ---------------------------------------------------------------------

# Pairing of central tendency with sensible spread choices. The
# modal exposes both ``central_tendency`` and ``error_bar`` as free
# pickers, but documents which combinations make statistical sense:
#   * mean   → SEM (default), SD, 95 % CI, none
#   * median → IQR (default), range, none
# Mismatches (e.g. median + SEM) still render — we don't gate
# user choices — but the auto-caption labels what was actually
# drawn so the figure stays self-documenting either way.
_VALID_ERROR_BARS = {'sem', 'sd', 'ci95', 'iqr', 'range', 'none'}


def _summary_for_strip(vals, central_tendency: str, error_bar: str
                       ) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """Compute the (centre, lo, hi) y-values for one group's strip.

    ``lo`` / ``hi`` are absolute y-values (NOT offsets) so callers
    can hlines/vlines them directly. Returns ``(centre, None, None)``
    when n < 2 or the user explicitly picked ``none``. Treats ``sem``,
    ``sd``, ``ci95`` as symmetric around the centre; ``iqr`` and
    ``range`` are asymmetric (Q1/Q3 or min/max).
    """
    arr = np.asarray(vals, dtype=float)
    n = arr.size
    if n == 0:
        return None, None, None
    centre = float(np.median(arr)) if central_tendency == 'median' else float(np.mean(arr))
    if error_bar == 'none' or n < 2:
        return centre, None, None
    if error_bar == 'sem':
        s = float(np.std(arr, ddof=1) / math.sqrt(n))
        return centre, centre - s, centre + s
    if error_bar == 'sd':
        s = float(np.std(arr, ddof=1))
        return centre, centre - s, centre + s
    if error_bar == 'ci95':
        # Normal-approx CI — adequate at the n we typically see in
        # cohort plots. For tiny n the t-distribution is more
        # accurate but the visual difference is usually within the
        # marker size, and Pingouin's stats already handle the test
        # side rigorously.
        s = 1.96 * float(np.std(arr, ddof=1) / math.sqrt(n))
        return centre, centre - s, centre + s
    if error_bar == 'iqr':
        return centre, float(np.percentile(arr, 25)), float(np.percentile(arr, 75))
    if error_bar == 'range':
        return centre, float(arr.min()), float(arr.max())
    return centre, None, None


def _strip_caption(central_tendency: str, error_bar: str) -> str:
    """Build the human-readable descriptor placed in the figure
    corner so a saved chart documents what's actually shown without
    cross-referencing the modal state."""
    centre = 'median' if central_tendency == 'median' else 'mean'
    spreads = {
        'sem':   'SEM',
        'sd':    'SD',
        'ci95':  '95 % CI',
        'iqr':   'IQR',
        'range': 'range',
        'none':  None,
    }
    spread_label = spreads.get(error_bar)
    if spread_label is None:
        return f'{centre} (dots = cells)'
    # Symmetric error bars use ``±`` — sensible for SEM/SD/CI but
    # not for IQR/range which are asymmetric. Use a different
    # connector for those.
    if error_bar in ('sem', 'sd', 'ci95'):
        return f'{centre} ± {spread_label} (dots = cells)'
    return f'{centre} with {spread_label} (dots = cells)'


def plot_scalar(
    groups: list[dict],
    *,
    title: str = '',
    ylabel: str = '',
    theme: str = 'dark',
    posthoc: Optional[list[dict]] = None,
    p_value: Optional[float] = None,
    test_label: Optional[str] = None,
    palette: Optional[list[str]] = None,
    width_in: Optional[float] = None,
    height_in: Optional[float] = None,
    central_tendency: str = 'mean',
    error_bar: str = 'sem',
) -> tuple[Any, dict]:
    """Strip plot per group + central-tendency line + spread whisker.

    ``groups`` shape: ``[{'tag': str, 'values_per_cell': [[v]]}, …]``
    For scalar metrics each cell contributes one number, so
    ``values_per_cell`` is a list of singleton lists; we flatten.

    ``central_tendency`` ∈ {'mean', 'median'} controls the heavy
    horizontal line drawn through each strip. ``error_bar`` ∈
    {'sem', 'sd', 'ci95', 'iqr', 'range', 'none'} controls the
    vertical whisker. The chart auto-captions itself in the bottom-
    left corner so screenshots stay self-documenting (e.g. "mean ±
    SEM (dots = cells)" or "median with IQR (dots = cells)").

    Significance bars are drawn for every post-hoc pair with p<.05
    (the ``standard`` significance threshold the user picked). For
    two-group designs without a posthoc list, a single bracket with
    the overall ``p_value`` is drawn when significant.
    """
    if error_bar not in _VALID_ERROR_BARS:
        error_bar = 'sem'
    if central_tendency not in ('mean', 'median'):
        central_tendency = 'mean'
    fig, ax, colors = _figure(theme,
                              width_in=width_in or 5.5,
                              height_in=height_in or 4.0)
    palette = palette or DEFAULT_PALETTE

    # Collapse per-cell values to flat per-group arrays. Each
    # singleton/multi-value list contributes its mean (so multi-row
    # cells get one number per group, matching what the stats
    # runner used).
    flat_values: list[list[float]] = []
    for g in groups:
        per_cell = g.get('values_per_cell', [])
        flat: list[float] = []
        for cell_vals in per_cell:
            cleaned = _clean(cell_vals)
            if cleaned:
                flat.append(float(np.mean(cleaned)))
        flat_values.append(flat)

    n_groups = len(groups)
    x_positions = np.arange(n_groups)
    rng = np.random.default_rng(42)  # deterministic jitter for reproducibility

    for i, (g, vals) in enumerate(zip(groups, flat_values)):
        color = g.get('color') or palette[i % len(palette)]
        if not vals:
            continue
        # Strip with deterministic horizontal jitter so overlapping
        # points don't pile on top of each other.
        jitter = rng.uniform(-0.18, 0.18, size=len(vals))
        ax.scatter(
            x_positions[i] + jitter,
            vals,
            color=color,
            edgecolors=colors['fg'],
            linewidths=0.5,
            s=42,
            alpha=0.85,
            zorder=3,
        )
        # Central-tendency line + spread whisker.
        centre, lo, hi = _summary_for_strip(vals, central_tendency, error_bar)
        if centre is None:
            continue
        # Heavy horizontal line at the chosen central value.
        ax.hlines(centre, x_positions[i] - 0.30, x_positions[i] + 0.30,
                  color=colors['fg'], linewidth=2.2, zorder=4)
        # Whiskers — drawn only when the spread choice yields a
        # finite [lo, hi] (n < 2 or 'none' → no whiskers).
        if lo is not None and hi is not None and lo != hi:
            ax.vlines(x_positions[i], lo, hi,
                      color=colors['fg'], linewidth=1.4, zorder=4)
            ax.hlines([lo, hi],
                      x_positions[i] - 0.10, x_positions[i] + 0.10,
                      color=colors['fg'], linewidth=1.2, zorder=4)

    ax.set_xticks(x_positions)
    ax.set_xticklabels([_display(g) for g in groups], color=colors['fg'])
    if title:
        ax.set_title(title, color=colors['fg'], fontsize=11, pad=8)
    _style_axes(ax, colors, ylabel)

    # Y-range with padding so significance bars have room to draw.
    all_vals = [v for vs in flat_values for v in vs]
    if all_vals:
        ymin, ymax = float(min(all_vals)), float(max(all_vals))
        span = max(ymax - ymin, 1e-9)
        ax.set_ylim(ymin - 0.10 * span, ymax + 0.30 * span)

    # Significance brackets.
    pairs_to_draw: list[tuple[int, int, str]] = []
    if posthoc:
        # Multi-group: only significant pairs.
        for ph in posthoc:
            try:
                p = float(ph.get('p'))
            except (TypeError, ValueError):
                continue
            if p >= 0.05:
                continue
            try:
                a_idx = next(i for i, g in enumerate(groups) if g['tag'] == ph['a'])
                b_idx = next(i for i, g in enumerate(groups) if g['tag'] == ph['b'])
            except StopIteration:
                continue
            pairs_to_draw.append((min(a_idx, b_idx), max(a_idx, b_idx), _stars(p)))
    elif n_groups == 2 and p_value is not None and p_value < 0.05:
        # Two-group design without explicit posthoc — annotate the
        # overall test instead.
        pairs_to_draw.append((0, 1, _stars(p_value)))

    if pairs_to_draw and all_vals:
        ymin, ymax = ax.get_ylim()
        span = ymax - ymin
        bar_y = ymax - 0.18 * span
        step = 0.07 * span
        for k, (i, j, label) in enumerate(pairs_to_draw):
            y = bar_y + k * step
            ax.plot([i, i, j, j], [y - step * 0.18, y, y, y - step * 0.18],
                    color=colors['fg'], linewidth=1.0)
            ax.text((i + j) / 2.0, y + step * 0.08, label,
                    ha='center', va='bottom',
                    color=colors['fg'], fontsize=10)
        # Bump the y-limit so the highest bracket fits comfortably.
        ax.set_ylim(ymin, bar_y + len(pairs_to_draw) * step + 0.10 * span)

    if test_label and p_value is not None:
        # Stats subtitle in the corner — small, muted; the title
        # carries the metric name.
        ax.text(0.99, 0.01, f"{test_label}, p={_p_label(p_value)}",
                transform=ax.transAxes,
                ha='right', va='bottom',
                color=colors['fg_muted'], fontsize=8)

    # Auto-caption describing the central / spread choice — anchored
    # in the bottom-left corner. Pinned to the axes coords (not data
    # coords) so it stays put through any axis-limit overrides the
    # user applies in the modal. Uses the same muted style as the
    # stats annotation in the bottom-right; together they bookend
    # the figure with metadata without crowding the main strip area.
    ax.text(0.01, 0.01, _strip_caption(central_tendency, error_bar),
            transform=ax.transAxes,
            ha='left', va='bottom',
            color=colors['fg_muted'], fontsize=8)

    fig.tight_layout()
    return fig, {
        'kind': 'scalar',
        'ymin': ax.get_ylim()[0],
        'ymax': ax.get_ylim()[1],
        'central_tendency': central_tendency,
        'error_bar': error_bar,
    }


def _p_label(p: float) -> str:
    if p < 0.001:
        return '<0.001'
    return f'{p:.3f}'


# ---------------------------------------------------------------------
# Distribution ECDF
# ---------------------------------------------------------------------

def plot_ecdf(
    groups: list[dict],
    *,
    title: str = '',
    xlabel: str = '',
    theme: str = 'dark',
    p_value: Optional[float] = None,
    test_label: Optional[str] = None,
    palette: Optional[list[str]] = None,
    width_in: Optional[float] = None,
    height_in: Optional[float] = None,
    abs_values: bool = False,
    show_individuals: bool = True,
    show_mean: bool = True,
    gaussian_overlay: bool = False,
) -> tuple[Any, dict]:
    """Per-cell ECDF lines (faded) + group mean ECDF (bold), with
    optional toggles surfaced through the modal:

    * ``abs_values``       — fold values to ``|x|`` before sorting,
                             so signed amplitudes (EPSC events at
                             negative pA) become positive magnitudes.
                             Required for log-X on signed data.
    * ``show_individuals`` — toggle the faded per-cell ECDFs. Off
                             when the user wants only the group
                             summary, on by default.
    * ``show_mean``        — toggle the bold per-group mean ECDF.
                             Off when the user wants only individual
                             cells (useful for IEI distributions
                             where cells with very different ranges
                             produce a misleading-looking mean).
    * ``gaussian_overlay`` — overlay each group's fitted N(μ, σ) CDF
                             as a dashed line in the group colour.
                             μ, σ are computed from the pooled events
                             of that group. A visual Lilliefors test:
                             how far each empirical curve sits from
                             its best-fit normal.

    Mean ECDF is computed by interpolating each cell's ECDF onto a
    common x grid (per-group pooled-data range) and averaging the
    fractions. Less misleading than pooling all events from all
    cells (which would weight the most-event cells most heavily —
    pseudoreplication trap).

    The ``log_x`` axis toggle is handled in ``_apply_axis_overrides``
    after the main draw, since it's a viewport setting that applies
    cleanly post-hoc.
    """
    fig, ax, colors = _figure(theme,
                              width_in=width_in or 5.5,
                              height_in=height_in or 4.0)
    palette = palette or DEFAULT_PALETTE

    # Collect cleaned per-cell arrays per group. Apply ``abs_values``
    # at this stage — before sorting and before the ECDF computation —
    # so the fold is consistent everywhere downstream (per-cell
    # lines, mean curve, Gaussian overlay, x-grid range).
    per_group_cells: list[list[list[float]]] = []
    for g in groups:
        cells = []
        for cell_vals in g.get('values_per_cell', []):
            cleaned = _clean(cell_vals)
            if not cleaned:
                continue
            if abs_values:
                cleaned = [abs(v) for v in cleaned]
            cells.append(sorted(cleaned))
        per_group_cells.append(cells)

    # Common x grid for the group-mean ECDFs and Gaussian overlay.
    # CRUCIAL: use the union of all observed values across cells —
    # NOT a uniform linspace — so the grid inherits the density
    # structure of the data. For long-tailed distributions like
    # IEI (most events <100 ms but tail extends to seconds), a
    # uniform 200-point linspace wastes resolution on the empty
    # tail and the mean curve "skips" through the dense region
    # with only a handful of grid points. Following the data
    # density gives a mean curve that visually tracks the
    # individual cell ECDFs faithfully.
    #
    # Cap at 2000 sampled points to keep SVG size bounded for
    # huge event arrays (tens of thousands of events). Sampling by
    # index across the sorted union preserves density structure —
    # we're decimating the resolution uniformly along the curve's
    # natural arc, not its x-axis range.
    all_pooled = [v for cells in per_group_cells for c in cells for v in c]
    if not all_pooled:
        ax.text(0.5, 0.5, 'No data', transform=ax.transAxes,
                ha='center', va='center', color=colors['fg_muted'])
        _style_axes(ax, colors, 'cumulative probability', xlabel)
        return fig, {'kind': 'distribution'}

    all_unique = np.unique(np.asarray(all_pooled, dtype=float))
    MAX_GRID_POINTS = 2000
    if all_unique.size > MAX_GRID_POINTS:
        idx = np.linspace(0, all_unique.size - 1, MAX_GRID_POINTS).astype(int)
        x_grid = all_unique[idx]
    elif all_unique.size >= 2:
        x_grid = all_unique
    else:
        # Single unique value across the whole dataset — pad a tiny
        # interval so downstream linspace-based logic doesn't
        # divide by zero. Real-world this almost never happens.
        v = float(all_unique[0])
        eps = max(abs(v) * 1e-3, 1e-9)
        x_grid = np.array([v - eps, v + eps])

    # Lazy scipy import — only needed for the Gaussian overlay path.
    norm = None
    if gaussian_overlay:
        try:
            from scipy.stats import norm as _norm  # type: ignore
            norm = _norm
        except Exception:
            # Scipy missing or broken — skip the overlay rather than
            # fail the whole plot. The toggle visibly does nothing,
            # which is the right behaviour for an optional reference.
            norm = None

    for i, (g, cells) in enumerate(zip(groups, per_group_cells)):
        color = g.get('color') or palette[i % len(palette)]
        # Build per-cell ECDFs even when individuals are hidden — we
        # still need them for the mean curve. Only the visible ``ax.step``
        # call is gated on ``show_individuals``.
        per_cell_ecdfs: list[np.ndarray] = []
        for c in cells:
            if not c:
                continue
            arr = np.asarray(c)
            # Interpolate ECDF: fraction of values ≤ x for x in grid.
            ranks = np.searchsorted(arr, x_grid, side='right') / len(arr)
            per_cell_ecdfs.append(ranks)
            if show_individuals:
                ax.step(arr, np.linspace(1.0 / len(arr), 1.0, len(arr)),
                        where='post', color=color, alpha=0.25, linewidth=0.8,
                        zorder=2)
        # Group mean ECDF — bold. Always carries the legend label so
        # legend stays meaningful even when the mean line is hidden
        # via ``show_mean`` (we still need to label the colour).
        if per_cell_ecdfs and show_mean:
            mean_ecdf = np.mean(per_cell_ecdfs, axis=0)
            ax.plot(x_grid, mean_ecdf, color=color, linewidth=2.2,
                    label=_display(g), zorder=4)
        elif show_individuals and cells:
            # When only individuals are shown, attach a dummy line
            # to anchor the legend entry — otherwise the legend
            # disappears and the user can't tell which colour is
            # which group.
            ax.plot([], [], color=color, linewidth=2.2,
                    label=_display(g), zorder=4)

        # Gaussian overlay — fit N(μ, σ²) on this group's pooled
        # events (across all its cells), then plot the analytic CDF
        # along ``x_grid``. Pooled fit because the user is typically
        # asking "is this distribution overall normal?" rather than
        # "is each cell normal?". For groups with <2 valid points we
        # skip (σ undefined).
        if gaussian_overlay and norm is not None and cells:
            pooled = np.concatenate([np.asarray(c, dtype=float) for c in cells])
            if pooled.size >= 2:
                mu = float(np.mean(pooled))
                sd = float(np.std(pooled, ddof=1))
                if sd > 0 and np.isfinite(sd):
                    y_norm = norm.cdf(x_grid, loc=mu, scale=sd)
                    ax.plot(x_grid, y_norm, color=color,
                            linestyle='--', linewidth=1.2, alpha=0.8,
                            zorder=3)

    ax.set_ylim(0, 1.02)
    # Build the legend only when there's actually a labelled artist —
    # silences matplotlib's "no handles with labels" warning when both
    # ``show_individuals`` and ``show_mean`` are off.
    handles, labels = ax.get_legend_handles_labels()
    if handles:
        ax.legend(loc='lower right', framealpha=0.9, fontsize=9,
                  facecolor=colors['bg'], edgecolor=colors['border'],
                  labelcolor=colors['fg'])
    if title:
        ax.set_title(title, color=colors['fg'], fontsize=11, pad=8)
    _style_axes(ax, colors, 'cumulative probability', xlabel)

    if test_label and p_value is not None:
        ax.text(0.99, 0.01, f"{test_label}, p={_p_label(p_value)}",
                transform=ax.transAxes,
                ha='right', va='bottom',
                color=colors['fg_muted'], fontsize=8)

    fig.tight_layout()
    return fig, {
        'kind': 'distribution',
        'xmin': float(x_grid[0]),
        'xmax': float(x_grid[-1]),
        'abs_values': bool(abs_values),
        'show_individuals': bool(show_individuals),
        'show_mean': bool(show_mean),
        'gaussian_overlay': bool(gaussian_overlay and norm is not None),
    }


# ---------------------------------------------------------------------
# Time-series — per-cell traces + group mean ± SEM band
# ---------------------------------------------------------------------

def plot_timeseries(
    groups: list[dict],
    *,
    title: str = '',
    ylabel: str = '',
    theme: str = 'dark',
    palette: Optional[list[str]] = None,
    bin_widths_s: Optional[list[Optional[float]]] = None,
    bins_consistent: Optional[list[Optional[bool]]] = None,
    reference_y: Optional[float] = None,
    induction_bins: Optional[list[Optional[float]]] = None,
    width_in: Optional[float] = None,
    height_in: Optional[float] = None,
    connect_lines: bool = False,
    show_band: bool = False,
    show_individuals: bool = True,
    error_bar: str = 'sem',
    align_to_induction: bool = True,
) -> tuple[Any, dict]:
    """Per-bin markers + error bars per group, with optional toggles
    surfaced through the modal:

    * ``connect_lines``    — draw a thin line connecting each group's
                             bin means. Off by default — the canonical
                             LTP / fEPSP plot is markers only at each
                             timepoint with vertical error bars
                             (Bliss/Lømo style). On for users who
                             prefer the connected-line aesthetic.
    * ``show_band``        — draw a filled ±spread band under the
                             markers. Off by default — discrete
                             error bars are clearer at the bin
                             granularity these plots use. On for
                             users with smooth-trajectory data.
    * ``show_individuals`` — draw faint per-cell traces. On by
                             default; off when the cell traces add
                             too much visual noise.
    * ``error_bar``        — 'sem' (default), 'sd', 'ci95', 'none'.
                             Same convention as ``plot_scalar`` for
                             consistency. Discrete error bars
                             always draw with caps; the fill_between
                             band uses the same spread when on.
    * ``align_to_induction`` — re-zero each group's time axis at its
                             own induction bin so baseline bins
                             have negative time, post-tetanus bins
                             have positive time, and tetanus is at
                             0. The canonical LTP plot layout. On
                             by default; falls through silently to
                             absolute time when induction metadata
                             is absent. Each group aligns to ITS
                             OWN induction bin, so designs with
                             different baseline lengths (e.g. WT 20
                             min, KO 15 min) still line up at 0.

    X axis defaults to bin index. If every contributing cell across
    every group reports the SAME ``bin_width_s`` (within 1% rounding)
    AND ``bins_consistent`` is True for all of them, switches to
    minutes — the canonical LTP figure unit. Otherwise stays on bin
    index and surfaces a flag in the returned metadata so the
    frontend can render a "axis: bin index (bin widths inconsistent)"
    note next to the plot.

    ``reference_y`` draws a horizontal dashed line — pass 1.0 for
    the LTP "100% of baseline" reference.
    """
    if error_bar not in ('sem', 'sd', 'ci95', 'none'):
        error_bar = 'sem'
    fig, ax, colors = _figure(theme,
                              width_in=width_in or 5.5,
                              height_in=height_in or 4.0)
    palette = palette or DEFAULT_PALETTE

    # Decide X-axis units before any plotting.
    use_minutes = False
    bin_width_used: Optional[float] = None
    inconsistency_reason = ''
    if bin_widths_s and bins_consistent:
        valid_widths = [w for w in bin_widths_s if w is not None and w > 0]
        all_consistent = all(c is True for c in bins_consistent)
        if (valid_widths
                and len(valid_widths) == len(bin_widths_s)
                and all_consistent):
            # Within 1% of the median width counts as "the same".
            median_w = float(np.median(valid_widths))
            within_tol = all(abs(w - median_w) / median_w <= 0.01
                             for w in valid_widths)
            if within_tol:
                use_minutes = True
                bin_width_used = median_w
            else:
                inconsistency_reason = 'bin widths differ across cells'
        elif not all_consistent:
            inconsistency_reason = 'one or more cells have inconsistent bin sizes'
        elif not valid_widths:
            inconsistency_reason = 'no bin-width metadata in sidecars'

    # Determine the longest bin count across cells for the axis.
    max_bins = 0
    for g in groups:
        for c in g.get('values_per_cell', []):
            cleaned = _clean(c)
            if len(cleaned) > max_bins:
                max_bins = len(cleaned)

    # x-step in plot units (minutes if use_minutes, otherwise raw bins).
    step = (bin_width_used / 60.0) if use_minutes and bin_width_used else 1.0

    def xs_for_bin(n: int, offset: float = 0.0) -> np.ndarray:
        """X coordinates for ``n`` bins, optionally shifted so that
        bin index ``offset / step`` lands at x=0. Used to re-zero
        each group's time axis at its own induction bin when
        ``align_to_induction`` is on."""
        return np.arange(n).astype(float) * step - offset

    # Precompute per-group time offsets. When ``align_to_induction``
    # is on AND a group has a usable induction_bin_idx, that group
    # gets shifted so its tetanus moment lands at x=0 (baseline bins
    # negative, post-tetanus positive). Groups without induction
    # metadata stay anchored at the absolute origin — we don't
    # silently misalign them.
    group_offsets: list[float] = []
    any_aligned = False
    for i in range(len(groups)):
        if (align_to_induction
                and induction_bins
                and i < len(induction_bins)
                and induction_bins[i] is not None
                and induction_bins[i] > 0):
            group_offsets.append(float(induction_bins[i]) * step)
            any_aligned = True
        else:
            group_offsets.append(0.0)

    for i, g in enumerate(groups):
        color = g.get('color') or palette[i % len(palette)]
        offset = group_offsets[i]
        per_cell_arrays: list[np.ndarray] = []
        for c in g.get('values_per_cell', []):
            cleaned = _clean(c)
            if not cleaned:
                continue
            arr = np.asarray(cleaned, dtype=float)
            per_cell_arrays.append(arr)
            if show_individuals:
                ax.plot(xs_for_bin(len(arr), offset), arr,
                        color=color, alpha=0.25, linewidth=0.8, zorder=2)
        if per_cell_arrays:
            # Mean (and chosen spread) at each bin index. Cells with
            # shorter traces only contribute up to their length —
            # handle ragged arrays via masking.
            n = max(len(a) for a in per_cell_arrays)
            stack = np.full((len(per_cell_arrays), n), np.nan)
            for k, a in enumerate(per_cell_arrays):
                stack[k, :len(a)] = a
            mean = np.nanmean(stack, axis=0)
            count = np.sum(~np.isnan(stack), axis=0)
            std = np.nanstd(stack, axis=0, ddof=1)
            # Compute the chosen spread per bin. ``yerr`` is fed to
            # ax.errorbar (symmetric) and to fill_between when the
            # band is on. Bins with count<2 get yerr=0 (no whisker).
            if error_bar == 'sd':
                yerr = np.where(count > 1, std, 0.0)
            elif error_bar == 'ci95':
                yerr = np.where(count > 1,
                                1.96 * std / np.sqrt(np.maximum(count, 1)),
                                0.0)
            elif error_bar == 'none':
                yerr = np.zeros_like(mean)
            else:  # 'sem' default
                yerr = np.where(count > 1,
                                std / np.sqrt(np.maximum(count, 1)),
                                0.0)
            xs = xs_for_bin(n, offset)
            label = f"{_display(g)} (n={len(per_cell_arrays)})"
            # Optional connecting line. Drawn first (under markers /
            # error bars) so the dots sit ON TOP of the line. zorder=4
            # for the line keeps it above the per-cell faint traces.
            if connect_lines:
                ax.plot(xs, mean, color=color, linewidth=1.4,
                        zorder=4, alpha=0.9)
            # Optional ±spread band. Same convention as the original
            # plot — kept opt-in for users who prefer continuous-
            # signal styling. Off by default since discrete error
            # bars are clearer at LTP-bin granularity.
            if show_band and error_bar != 'none':
                ax.fill_between(xs, mean - yerr, mean + yerr,
                                color=color, alpha=0.18,
                                linewidth=0, zorder=3)
            # Markers + error bars — the new default. ``fmt='o'``
            # disables matplotlib's automatic line so we get pure
            # discrete points; the optional connector above handles
            # that case explicitly. ``capsize=3`` gives the small
            # horizontal whisker caps that read as standard
            # error-bar style at journal-figure scale. ``elinewidth``
            # matches the strip-plot whiskers so the visual weight
            # is consistent across plot kinds.
            ax.errorbar(
                xs, mean,
                yerr=yerr if error_bar != 'none' else None,
                fmt='o', color=color,
                markersize=5,
                markeredgecolor=colors['fg'],
                markeredgewidth=0.5,
                ecolor=color,
                elinewidth=1.4,
                capsize=3,
                capthick=1.2,
                label=label,
                zorder=5,
            )

    if reference_y is not None:
        ax.axhline(reference_y, color=colors['fg_muted'],
                   linestyle='--', linewidth=0.9, zorder=1)

    # Induction marker — vertical dashed line at the bin where post-
    # tetanus data starts. ``induction_bins`` is one optional value
    # per group; we draw a line at the median across groups when
    # multiple ones are provided. Skip if every entry is None or all
    # values agree at 0 (no meaningful baseline window).
    #
    # When ``align_to_induction`` aligned every group at x=0, the
    # marker also lands at 0 — its position becomes the natural
    # tetanus reference. When alignment is off (or absent), the
    # marker still falls at the median absolute induction bin.
    if induction_bins:
        valid_ind = [b for b in induction_bins if b is not None and b > 0]
        if valid_ind:
            if any_aligned:
                ind_x = 0.0
            else:
                ind_bin = float(np.median(valid_ind))
                ind_x = ind_bin * step
            ax.axvline(ind_x, color=colors['fg_muted'],
                       linestyle=':', linewidth=1.2, zorder=1)
            # Subtle label so the user knows what the line is
            ymin_now, ymax_now = ax.get_ylim()
            ax.text(ind_x, ymax_now,
                    ' induction',
                    va='top', ha='left',
                    color=colors['fg_muted'],
                    fontsize=8, fontstyle='italic')

    if title:
        ax.set_title(title, color=colors['fg'], fontsize=11, pad=8)
    # Axis label tells the reader when zero is — relative to
    # induction (the LTP convention) vs absolute time. The
    # difference matters for interpreting the leftmost data point
    # (negative time = baseline observed BEFORE tetanus).
    if any_aligned and use_minutes:
        xlabel = 'Time from induction (min)'
    elif any_aligned:
        xlabel = 'Bin index from induction'
    elif use_minutes:
        xlabel = 'Time (min)'
    else:
        xlabel = 'Bin index'
    if inconsistency_reason:
        xlabel += f"  —  {inconsistency_reason}"
    _style_axes(ax, colors, ylabel, xlabel)
    ax.legend(loc='best', framealpha=0.9, fontsize=9,
              facecolor=colors['bg'], edgecolor=colors['border'],
              labelcolor=colors['fg'])

    fig.tight_layout()
    return fig, {
        'kind': 'timeseries',
        'x_unit': 'minutes' if use_minutes else 'bin_index',
        'bin_width_s': bin_width_used,
        'bins_inconsistent_reason': inconsistency_reason or None,
        'n_bins_max': max_bins,
        'connect_lines': bool(connect_lines),
        'show_band': bool(show_band),
        'show_individuals': bool(show_individuals),
        'error_bar': error_bar,
        'align_to_induction': bool(any_aligned),
    }


# ---------------------------------------------------------------------
# Override application — used by the dispatcher to apply user-driven
# axis / label / scale changes from the modal AFTER the main plot has
# been laid out. Done post-hoc (rather than threaded through every
# plot kind) so the override surface stays the same regardless of
# plot type, and so the inline-render code path (no overrides) keeps
# working unchanged.
# ---------------------------------------------------------------------

def _apply_axis_overrides(fig, overrides: Optional[dict]) -> None:
    """Mutate ``fig.axes[0]`` per ``overrides``.

    Recognised keys (all optional, all None means "leave the plot's
    own choice alone"):
      * ``xlim`` / ``ylim`` — ``[min, max]`` pairs.
      * ``xlabel`` / ``ylabel`` / ``title`` — empty string is allowed
        and clears the label; ``None`` leaves it.
      * ``log_y`` — bool. Switches the Y axis to log scale.
    Any unknown key is ignored. Calls ``tight_layout`` after, so
    extending labels don't clip the figure.
    """
    if not overrides or not fig.axes:
        return
    ax = fig.axes[0]

    # Each axis range is a 2-element list ``[min, max]`` where either
    # element may be ``None`` to mean "keep matplotlib's autoscale
    # for this side". Lets the user pin one bound (e.g. "force min
    # to 0 but let max float") without having to type both. The
    # frontend sends ``None`` for any input the user left blank.
    def _apply_lim(setter, getter, lim):
        if not lim or len(lim) != 2:
            return
        cur_lo, cur_hi = getter()
        try:
            new_lo = cur_lo if lim[0] is None else float(lim[0])
            new_hi = cur_hi if lim[1] is None else float(lim[1])
        except (TypeError, ValueError):
            return
        setter(new_lo, new_hi)

    _apply_lim(ax.set_xlim, ax.get_xlim, overrides.get('xlim'))
    _apply_lim(ax.set_ylim, ax.get_ylim, overrides.get('ylim'))

    title = overrides.get('title')
    if title is not None:
        # Re-apply with the same theme color as the original. Pull it
        # off the existing title rather than threading colors through
        # — works for both light and dark themes without extra state.
        existing = ax.title
        ax.set_title(str(title), color=existing.get_color() or 'black',
                     fontsize=11, pad=8)

    xlabel = overrides.get('xlabel')
    if xlabel is not None:
        ax.set_xlabel(str(xlabel), color=ax.xaxis.label.get_color() or 'black',
                      fontsize=10)

    ylabel = overrides.get('ylabel')
    if ylabel is not None:
        ax.set_ylabel(str(ylabel), color=ax.yaxis.label.get_color() or 'black',
                      fontsize=10)

    if overrides.get('log_y'):
        try:
            ax.set_yscale('log')
        except Exception:
            # ECDF y is already [0, 1] — log there breaks. Silently
            # skip rather than fail the whole render.
            pass

    # Log-X is the natural scale for distributions of inter-event
    # intervals, event amplitudes, fluorescence intensities, etc.
    # — anything spanning multiple orders of magnitude. Negative or
    # zero values are silently clipped by matplotlib's log scaler;
    # the user can pair this with ``abs_values`` (distribution-only)
    # to fold signed amplitudes into the positive half-line first.
    if overrides.get('log_x'):
        try:
            ax.set_xscale('log')
        except Exception:
            pass

    fig.tight_layout()


def _apply_group_overrides(groups: list[dict], overrides: Optional[dict]) -> list[dict]:
    """Build a shallow-copied groups list with ``display_tag`` and
    ``color`` injected per ``overrides['group_labels']`` and
    ``overrides['group_colors']``.

    Both maps are keyed by the canonical ``tag`` so the modal's
    rename + recolor surface targets groups stably regardless of the
    display name. Posthoc lookup code keeps using ``g['tag']`` so
    significance brackets still match correctly after a rename.
    Returns the input unchanged when overrides is None / empty so
    the inline path doesn't pay any allocation cost.
    """
    if not overrides:
        return groups
    label_map = overrides.get('group_labels') or {}
    color_map = overrides.get('group_colors') or {}
    if not label_map and not color_map:
        return groups
    out: list[dict] = []
    for g in groups:
        g2 = dict(g)
        tag = str(g2.get('tag', ''))
        if tag in label_map:
            new_label = label_map[tag]
            if new_label is not None and str(new_label) != '':
                g2['display_tag'] = str(new_label)
        if tag in color_map:
            new_color = color_map[tag]
            if new_color:
                g2['color'] = str(new_color)
        out.append(g2)
    return out


# ---------------------------------------------------------------------
# Public dispatcher — one entry the API endpoint calls.
# ---------------------------------------------------------------------

def render_graph(
    kind: str,
    groups: list[dict],
    *,
    title: str = '',
    ylabel: str = '',
    xlabel: str = '',
    theme: str = 'dark',
    palette: Optional[list[str]] = None,
    p_value: Optional[float] = None,
    posthoc: Optional[list[dict]] = None,
    test_label: Optional[str] = None,
    bin_widths_s: Optional[list[Optional[float]]] = None,
    bins_consistent: Optional[list[Optional[bool]]] = None,
    reference_y: Optional[float] = None,
    induction_bins: Optional[list[Optional[float]]] = None,
    output_format: str = 'svg',
    overrides: Optional[dict] = None,
    width_in: Optional[float] = None,
    height_in: Optional[float] = None,
    dpi: int = 150,
) -> dict:
    """Render the cohort plot and return ``{format, payload, meta}``.

    ``payload`` is:
      * SVG XML string when ``output_format='svg'``
      * base64-encoded PNG when ``output_format='png'``
      * base64-encoded PDF when ``output_format='pdf'``
    The frontend inlines the SVG directly (no img tag) so it can
    style it and bind click handlers; PNG and PDF are exports the
    user kicks off from the modal's "Save as…" menu.

    ``overrides`` is the user's modal-driven axis/label/color/log
    customisations. None for the inline-card render path; populated
    when the user opens the modal and tweaks the chart. See
    ``_apply_axis_overrides`` and ``_apply_group_overrides`` for the
    accepted shape.

    ``width_in``/``height_in`` let the modal request a larger render
    than the inline card uses (the modal canvas is much wider). When
    None, each plot kind picks its standard 5.5×4 in.
    """
    # Group-level overrides (display names + colors) need to land on
    # the groups dicts BEFORE the plot kind processes them, since
    # legends and tick labels are emitted during plotting. Axis-level
    # overrides (xlim/title/log_y/etc.) get applied AFTER plotting.
    groups = _apply_group_overrides(groups, overrides)

    if kind == 'scalar':
        # Scalar-only flags carried inside ``overrides`` so the
        # modal can drive them without expanding the request shape.
        # Defaults preserve historical mean ± SEM behaviour.
        ov = overrides or {}
        fig, meta = plot_scalar(
            groups, title=title, ylabel=ylabel, theme=theme,
            posthoc=posthoc, p_value=p_value, test_label=test_label,
            palette=palette,
            width_in=width_in, height_in=height_in,
            central_tendency=str(ov.get('central_tendency') or 'mean'),
            error_bar=str(ov.get('error_bar') or 'sem'),
        )
    elif kind == 'distribution':
        # Distribution-only flags live inside the overrides block so
        # the modal can drive them without an additional payload
        # surface. ``None`` overrides → fall back to the kind's own
        # defaults (individuals on, mean on, abs+gaussian off).
        ov = overrides or {}
        fig, meta = plot_ecdf(
            groups, title=title, xlabel=xlabel, theme=theme,
            p_value=p_value, test_label=test_label, palette=palette,
            width_in=width_in, height_in=height_in,
            abs_values=bool(ov.get('abs_values', False)),
            show_individuals=bool(ov.get('show_individuals', True)),
            show_mean=bool(ov.get('show_mean', True)),
            gaussian_overlay=bool(ov.get('gaussian_overlay', False)),
        )
    elif kind == 'timeseries':
        # Fall back to per-group ``bin_width_s`` / ``bins_consistent``
        # carried inside the groups dicts when the caller didn't pass
        # them as separate kwargs. Lets both the API-endpoint path
        # (which strips them out into kwargs) and direct-call tests
        # work without duplicating the extraction logic.
        if bin_widths_s is None:
            bin_widths_s = [g.get('bin_width_s') for g in groups]
        if bins_consistent is None:
            bins_consistent = [g.get('bins_consistent') for g in groups]
        if induction_bins is None:
            induction_bins = [g.get('induction_bin_idx') for g in groups]
        # Timeseries-specific flags carried inside ``overrides`` —
        # same pattern as scalar / distribution.
        ov = overrides or {}
        fig, meta = plot_timeseries(
            groups, title=title, ylabel=ylabel, theme=theme,
            palette=palette,
            bin_widths_s=bin_widths_s,
            bins_consistent=bins_consistent,
            reference_y=reference_y,
            induction_bins=induction_bins,
            width_in=width_in, height_in=height_in,
            connect_lines=bool(ov.get('connect_lines', False)),
            show_band=bool(ov.get('show_band', False)),
            show_individuals=bool(ov.get('show_individuals', True)),
            error_bar=str(ov.get('error_bar') or 'sem'),
            align_to_induction=bool(ov.get('align_to_induction', True)),
        )
    else:
        return {'error': f'Unknown plot kind: {kind!r}'}

    # Apply user-driven axis-level overrides after the plot kind has
    # finished its own layout decisions. This includes axis-limit /
    # label / title overrides and the log-Y toggle.
    _apply_axis_overrides(fig, overrides)

    if output_format == 'png':
        return {
            'format': 'png',
            'payload': _to_png_b64(fig, dpi=dpi),
            'meta': meta,
        }
    if output_format == 'pdf':
        return {
            'format': 'pdf',
            'payload': _to_pdf_b64(fig),
            'meta': meta,
        }
    return {
        'format': 'svg',
        'payload': _to_svg(fig),
        'meta': meta,
    }
