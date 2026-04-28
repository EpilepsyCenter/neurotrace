"""Bundled-font registration for matplotlib.

The cohort graph renderer (and any future plotting code) wants to draw
in JetBrains Mono so the exported SVGs match the app's telegraph
aesthetic — every other UI surface is mono. Matplotlib cannot read
CSS variables, and the user's machine may not have JetBrains Mono
installed, so we ship the four core TTFs in
``backend/assets/fonts/`` and register them with matplotlib's
``font_manager`` once per process.

The registration is idempotent and lazy: call
``ensure_jetbrains_mono_registered()`` from any plot path — the first
call adds the fonts to the manager, subsequent calls are no-ops.

Falls back gracefully if the bundled font files are missing (warns
once, then everything falls through to matplotlib's default
sans-serif). This means a malformed install doesn't break cohort
rendering — it just looks less consistent with the rest of the app.
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path

# Sentinel so registration only runs once per process even if the
# helper is called from many sites. The matplotlib font cache
# itself is also process-local, so this is just a fast-path guard.
_JBM_REGISTERED = False

# Resolve the bundled-font directory relative to this file. ``utils/``
# sits next to ``assets/`` under ``backend/``, so:
#   backend/utils/fonts.py  →  backend/assets/fonts/
_FONT_DIR = (Path(__file__).resolve().parent.parent / 'assets' / 'fonts').resolve()

# The 4 core variants we ship. Italics + bold cover everything
# matplotlib's text engine asks for at standard rcParams (titles
# default to regular, math italics use the italic variant, etc.).
_JBM_FILES = [
    'JetBrainsMono-Regular.ttf',
    'JetBrainsMono-Bold.ttf',
    'JetBrainsMono-Italic.ttf',
    'JetBrainsMono-BoldItalic.ttf',
]

JETBRAINS_MONO_NAME = 'JetBrains Mono'


def ensure_jetbrains_mono_registered() -> bool:
    """Register the bundled JetBrains Mono TTFs with matplotlib.

    Returns True if the family is available (either freshly registered
    or previously registered in this process), False if registration
    failed (e.g. font files missing). Callers should fall back to
    matplotlib's default font in the False case rather than failing
    the whole render.
    """
    global _JBM_REGISTERED
    if _JBM_REGISTERED:
        return True

    try:
        from matplotlib import font_manager
    except Exception:
        # Matplotlib not importable — caller will hit the same error
        # the moment it tries to plot, so let that surface there.
        return False

    if not _FONT_DIR.is_dir():
        warnings.warn(
            f"JetBrains Mono font dir missing at {_FONT_DIR}; "
            f"plots will use matplotlib's default sans-serif.",
            stacklevel=2,
        )
        return False

    added_any = False
    for fname in _JBM_FILES:
        fpath = _FONT_DIR / fname
        if not fpath.is_file():
            # One missing variant doesn't disqualify the others —
            # matplotlib will substitute (e.g. fake-bold a regular)
            # rather than crash.
            continue
        try:
            font_manager.fontManager.addfont(os.fspath(fpath))
            added_any = True
        except Exception as e:
            warnings.warn(
                f"Failed to register font {fname}: {e}",
                stacklevel=2,
            )

    if not added_any:
        warnings.warn(
            f"No JetBrains Mono variants found in {_FONT_DIR}; "
            f"plots will use matplotlib's default sans-serif.",
            stacklevel=2,
        )
        return False

    _JBM_REGISTERED = True
    return True


def apply_mono_rc(rcParams) -> None:
    """Mutate a matplotlib rcParams dict in-place to use JetBrains Mono
    everywhere — text, math, and legend.

    Idempotent. Safe to call after ``ensure_jetbrains_mono_registered``
    even if registration failed: the rcParams update still happens, and
    matplotlib will fall back through the family list to ``monospace``
    (which always resolves to *something* on every platform).
    """
    # ``font.family`` accepts a list — matplotlib walks it in order
    # until one resolves. Putting the literal name first is what makes
    # matplotlib pick our registered TTFs; ``monospace`` is the
    # safety-net so the chart still renders even if the registration
    # silently fell back to a metric-incompatible family.
    rcParams['font.family'] = [JETBRAINS_MONO_NAME, 'monospace']
    rcParams['font.monospace'] = [
        JETBRAINS_MONO_NAME, 'JetBrains Mono NL', 'Fira Code',
        'DejaVu Sans Mono', 'Consolas', 'monospace',
    ]
    # Use the registered family for math text too. ``custom`` lets us
    # name our own font for math; without this, matplotlib ignores
    # ``font.family`` for math labels and uses its built-in DejaVu
    # variant — visually inconsistent with the surrounding ticks.
    rcParams['mathtext.fontset'] = 'custom'
    rcParams['mathtext.rm'] = JETBRAINS_MONO_NAME
    rcParams['mathtext.it'] = f'{JETBRAINS_MONO_NAME}:italic'
    rcParams['mathtext.bf'] = f'{JETBRAINS_MONO_NAME}:bold'

    # Emit text in SVG output as `<text>` elements with a
    # ``font-family`` attribute, NOT as glyph `<path>`s. The Electron
    # renderer that displays the cohort graphs already loads
    # JetBrains Mono via @font-face (see frontend/src/styles/
    # global.css), so the host can render the text natively. Wins:
    #   * smaller SVGs (no path data per glyph)
    #   * sharper antialiasing (browser's text renderer is better
    #     than rasterised vector paths at small label sizes)
    #   * selectable / searchable text in the inline display
    #   * editable in Illustrator / Inkscape downstream — important
    #     for the figure-prep workflow this exporter feeds into
    # Trade-off: an exported SVG opened on a machine without
    # JetBrains Mono installed falls back to the next monospace.
    # Acceptable; matplotlib also writes the fallback chain via
    # ``font.family`` so the result is still mono.
    rcParams['svg.fonttype'] = 'none'
    # PDF export keeps the embedded subset by default (Type 42), which
    # is right — fully portable, font subsetted, no fallback risk.
    # We don't change ``pdf.fonttype`` here.
