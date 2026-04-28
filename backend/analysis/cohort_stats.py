"""Cohort statistical tests via Pingouin.

Phase B.4 deliverable. The cohort wizard (Phase B.3) classifies the
study design and assigns cells to groups; this module takes the
per-group numeric values, runs the appropriate test, and returns a
JSON-serialisable result with the test name, statistic, p-value,
effect size, and per-group descriptive stats.

# Design taxonomy

The wizard hands us one of four design kinds:

* ``unpaired_2``  — two independent groups (between recordings)
* ``oneway_n``    — three+ independent groups (between recordings)
* ``paired_2``    — two conditions in the same cells (within)
* ``rm_n``        — three+ conditions in the same cells (within RM)

Plus a ``test_override`` of ``auto`` / ``parametric`` / ``nonparametric``.
``auto`` runs Shapiro-Wilk on each group and picks the parametric
branch only if every group passes (p > .05); otherwise the rank-based
test runs. The override forces one branch and skips the normality
check.

# Why Pingouin

Pingouin's tidy-DataFrame APIs return effect sizes (Cohen's d, η²,
rank-biserial, …) alongside the stat + p, which is what reviewers
want to see in the table without a second computation step. It also
covers the post-hoc menu (Tukey, Dunn, pairwise t-tests with various
corrections) under one umbrella.

# What's NOT in here

* Methods-section blurb generation (intentionally dropped — see the
  spec; reviewers don't trust auto-generated methods text)
* Plot rendering (B.6 — matplotlib lives in a different module)
* Multi-metric runs (the metric tree in B.5 will iterate this
  runner; here we test one metric per call)
"""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np

# Pingouin is heavy (pulls statsmodels + scikit-learn). Import is
# top-level since this module is only imported when the cohort stats
# endpoint is actually called.
import pingouin as pg


# Significance threshold for the Shapiro-Wilk normality gate. Hard-
# coded to the universal 0.05 — making it user-configurable in the
# UI is technically feasible but invites the wrong kind of fiddling.
SHAPIRO_ALPHA = 0.05


def _clean(xs) -> list[float]:
    """Drop None/NaN, coerce to float. Matches ``cohort._clean`` —
    duplicated to keep this module independently testable."""
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


def _descriptives(values: list[float]) -> dict:
    """Per-group mean / SD / SEM / median / IQR for the result table.
    Returns ``None``-shaped scalars when the group is too small."""
    n = len(values)
    if n == 0:
        return {'n': 0, 'mean': None, 'sd': None, 'sem': None,
                'median': None, 'q1': None, 'q3': None}
    arr = np.array(values, dtype=float)
    mean = float(np.mean(arr))
    sd = float(np.std(arr, ddof=1)) if n >= 2 else None
    sem = (sd / math.sqrt(n)) if sd is not None else None
    median = float(np.median(arr))
    q1 = float(np.percentile(arr, 25))
    q3 = float(np.percentile(arr, 75))
    return {
        'n': int(n), 'mean': mean, 'sd': sd, 'sem': sem,
        'median': median, 'q1': q1, 'q3': q3,
    }


def _shapiro(values: list[float]) -> dict:
    """Shapiro-Wilk normality. Returns p plus a verdict. Skipped
    (verdict 'unknown') when n < 3 (Pingouin requires that)."""
    n = len(values)
    if n < 3:
        return {'n': n, 'p': None, 'is_normal': None, 'verdict': 'unknown'}
    df = pg.normality(np.array(values, dtype=float))
    p = float(df.iloc[0]['pval'])
    is_normal = bool(p > SHAPIRO_ALPHA)
    return {
        'n': n, 'p': p, 'is_normal': is_normal,
        'verdict': 'normal' if is_normal else 'non-normal',
    }


def _decide_branch(group_normality: list[dict], override: str) -> str:
    """Map (Shapiro results, override) → 'parametric' or 'nonparametric'.

    Default policy when override = 'auto':
      * Every group with n ≥ 3 must pass Shapiro to qualify as
        parametric.
      * Groups with n < 3 are inconclusive — we err on the side of
        parametric there since the alternative is more likely to
        reject given small samples are noisy.
    """
    if override in ('parametric', 'nonparametric'):
        return override
    for g in group_normality:
        # 'unknown' (n<3) doesn't disqualify; 'non-normal' does.
        if g.get('verdict') == 'non-normal':
            return 'nonparametric'
    return 'parametric'


# ---------------------------------------------------------------------
# Test runners — one per design kind. Each returns a dict with the
# canonical fields the response carries:
#   test, statistic, statistic_label, p, effect_size, effect_size_label,
#   df (when applicable), posthoc (None or list of dicts)
# ---------------------------------------------------------------------

def _col(df, *candidates):
    """Return the first existing column from ``candidates``, or
    ``None`` if none match. Pingouin renamed several columns between
    0.5.x (``p-val``, ``cohen-d``) and 0.6.x (``p_val``, ``cohen_d``)
    — this lets the runner work across both."""
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _row_get(df, *candidates):
    """Same as :func:`_col` but returns the value at row 0 already
    coerced to float, or ``None``."""
    c = _col(df, *candidates)
    if c is None:
        return None
    val = df[c].iloc[0]
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _run_unpaired_2(group_values: list[list[float]],
                     group_tags: list[str], branch: str) -> dict:
    """Two independent groups — unpaired t / Mann-Whitney U."""
    a, b = np.array(group_values[0], dtype=float), np.array(group_values[1], dtype=float)
    if branch == 'parametric':
        # Welch's t-test by default — drops the equal-variance
        # assumption that Student's t needs; essentially free.
        df = pg.ttest(a, b, paired=False, correction='auto')
        return {
            'test': "Welch's t-test",
            'statistic': _row_get(df, 'T'),
            'statistic_label': 't',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': _row_get(df, 'dof'),
            'effect_size': _row_get(df, 'cohen_d', 'cohen-d'),
            'effect_size_label': "Cohen's d",
            'posthoc': None,
        }
    else:
        df = pg.mwu(a, b)
        return {
            'test': 'Mann-Whitney U',
            'statistic': _row_get(df, 'U_val', 'U-val'),
            'statistic_label': 'U',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': None,
            'effect_size': _row_get(df, 'RBC'),
            'effect_size_label': 'rank-biserial r',
            'posthoc': None,
        }


def _run_paired_2(group_values: list[list[float]],
                   group_tags: list[str], branch: str) -> dict:
    """Two paired conditions — paired t / Wilcoxon signed-rank."""
    a = np.array(group_values[0], dtype=float)
    b = np.array(group_values[1], dtype=float)
    if branch == 'parametric':
        df = pg.ttest(a, b, paired=True)
        return {
            'test': 'Paired t-test',
            'statistic': _row_get(df, 'T'),
            'statistic_label': 't',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': _row_get(df, 'dof'),
            'effect_size': _row_get(df, 'cohen_d', 'cohen-d'),
            'effect_size_label': "Cohen's d (paired)",
            'posthoc': None,
        }
    else:
        df = pg.wilcoxon(a, b)
        return {
            'test': 'Wilcoxon signed-rank',
            'statistic': _row_get(df, 'W_val', 'W-val'),
            'statistic_label': 'W',
            'p': _row_get(df, 'p_val', 'p-val'),
            'df': None,
            'effect_size': _row_get(df, 'RBC'),
            'effect_size_label': 'matched-pairs rank-biserial r',
            'posthoc': None,
        }


def _build_long_df(group_values: list[list[float]],
                   group_tags: list[str], paired: bool):
    """Tidy long-format DataFrame for pingouin's RM/ANOVA APIs.
    Columns: ``subject`` (only meaningful for paired/RM), ``group``,
    ``value``."""
    import pandas as pd
    rows = []
    if paired:
        # All groups have the same length (paired design); each row
        # index is the same subject across groups.
        n = min(len(v) for v in group_values)
        for i in range(n):
            for tag, vals in zip(group_tags, group_values):
                rows.append({'subject': i, 'group': tag, 'value': vals[i]})
    else:
        # Independent groups — assign unique subject IDs across groups
        # since pingouin's anova still needs a subject column for some
        # APIs (we'll use ``between`` design which doesn't need it,
        # but keep the column for shape consistency).
        sid = 0
        for tag, vals in zip(group_tags, group_values):
            for v in vals:
                rows.append({'subject': sid, 'group': tag, 'value': v})
                sid += 1
    return pd.DataFrame(rows)


def _ph_row(row, *p_candidates):
    """Helper for pairwise_tukey / pairwise_tests row extraction —
    handles both the ``A``/``B`` group columns and the per-method
    p-value column rename across pingouin versions."""
    return {
        'a': str(row['A']), 'b': str(row['B']),
        'p': next((float(row[c]) for c in p_candidates if c in row.index), None),
    }


def _run_oneway_n(group_values: list[list[float]],
                   group_tags: list[str], branch: str) -> dict:
    """3+ independent groups — one-way ANOVA + Tukey / Kruskal-Wallis + Dunn."""
    df = _build_long_df(group_values, group_tags, paired=False)
    if branch == 'parametric':
        anova = pg.anova(df, dv='value', between='group', detailed=True)
        row = anova.iloc[0]
        ph = pg.pairwise_tukey(df, dv='value', between='group')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_tukey', 'p-tukey')
            entry['mean_diff'] = float(r['diff']) if 'diff' in r.index else None
            entry['method'] = 'Tukey HSD'
            posthoc.append(entry)
        return {
            'test': 'One-way ANOVA',
            'statistic': float(row['F']),
            'statistic_label': 'F',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['DF']),
            'effect_size': float(row['np2']) if 'np2' in row.index else None,
            'effect_size_label': 'partial η²',
            'posthoc': posthoc,
        }
    else:
        kw = pg.kruskal(df, dv='value', between='group')
        row = kw.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', between='group',
                               parametric=False, padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Dunn (Holm-corrected)'
            posthoc.append(entry)
        return {
            'test': 'Kruskal-Wallis',
            'statistic': float(row['H']),
            'statistic_label': 'H',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['ddof1']),
            'effect_size': None,
            'effect_size_label': None,
            'posthoc': posthoc,
        }


def _run_rm_n(group_values: list[list[float]],
               group_tags: list[str], branch: str) -> dict:
    """3+ paired conditions — RM-ANOVA + post-hoc / Friedman + Dunn."""
    df = _build_long_df(group_values, group_tags, paired=True)
    if branch == 'parametric':
        rm = pg.rm_anova(df, dv='value', within='group', subject='subject',
                         detailed=True)
        row = rm.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', within='group',
                               subject='subject', parametric=True,
                               padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Paired t (Holm-corrected)'
            posthoc.append(entry)
        # RM-ANOVA effect size in pingouin 0.6 uses ``ng2`` (generalized
        # eta-squared); older versions had ``np2``. Fall back across
        # both so the runner doesn't bias the report towards one
        # pingouin release.
        eff = float(row['np2']) if 'np2' in row.index \
            else float(row['ng2']) if 'ng2' in row.index \
            else None
        return {
            'test': 'Repeated-measures ANOVA',
            'statistic': float(row['F']),
            'statistic_label': 'F',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['DF']) if 'DF' in row.index else None,
            'effect_size': eff,
            'effect_size_label': 'generalized η²' if 'ng2' in row.index else 'partial η²',
            'posthoc': posthoc,
        }
    else:
        fr = pg.friedman(df, dv='value', within='group', subject='subject')
        row = fr.iloc[0]
        ph = pg.pairwise_tests(df, dv='value', within='group',
                               subject='subject', parametric=False,
                               padjust='holm')
        posthoc = []
        for _, r in ph.iterrows():
            entry = _ph_row(r, 'p_corr', 'p-corr')
            entry['method'] = 'Wilcoxon (Holm-corrected)'
            posthoc.append(entry)
        return {
            'test': 'Friedman',
            'statistic': float(row['Q']),
            'statistic_label': 'Q',
            'p': float(row.get('p_unc', row.get('p-unc'))),
            'df': float(row['ddof1']) if 'ddof1' in row.index else None,
            'effect_size': None,
            'effect_size_label': None,
            'posthoc': posthoc,
        }


# ---------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------

DESIGN_KINDS = {'unpaired_2', 'oneway_n', 'paired_2', 'rm_n'}
TEST_OVERRIDES = {'auto', 'parametric', 'nonparametric'}


def run_test(
    groups: list[dict],
    design_kind: str,
    test_override: str = 'auto',
) -> dict:
    """Run the appropriate stats test for ``design_kind`` over the
    per-group numeric ``values``.

    Parameters
    ----------
    groups
        ``[{'tag': str, 'values': [float | None]}, …]`` — one entry
        per group. Order matters for paired designs (rows must align
        across groups).
    design_kind
        One of :data:`DESIGN_KINDS`.
    test_override
        One of :data:`TEST_OVERRIDES`. ``auto`` lets Shapiro decide.

    Returns
    -------
    dict
        Self-describing result payload. ``error`` is set instead of
        the test fields when something went wrong (e.g. degenerate
        sample, paired groups of unequal length).
    """
    if design_kind not in DESIGN_KINDS:
        return {'error': f'Unknown design_kind: {design_kind!r}'}
    if test_override not in TEST_OVERRIDES:
        return {'error': f'Unknown test_override: {test_override!r}'}

    # Clean numeric input. Drops None/NaN per group.
    cleaned = [_clean(g.get('values', [])) for g in groups]
    tags = [str(g.get('tag', f'group_{i}')) for i, g in enumerate(groups)]

    descriptives = [_descriptives(v) for v in cleaned]

    # Sanity: paired designs need every group at the same length AND
    # row alignment. Caller is responsible for alignment but we catch
    # the length mismatch here with a clear error rather than letting
    # pingouin throw.
    paired = design_kind in ('paired_2', 'rm_n')
    if paired:
        lens = [len(v) for v in cleaned]
        if min(lens) != max(lens):
            return {
                'error': (f'Paired design requires equal-length groups; '
                          f'got {dict(zip(tags, lens))}'),
                'descriptives': dict(zip(tags, descriptives)),
            }

    # Need ≥ 2 per group for any test to be meaningful.
    too_small = [tags[i] for i, v in enumerate(cleaned) if len(v) < 2]
    if too_small:
        return {
            'error': f'Groups too small (n < 2): {too_small}',
            'descriptives': dict(zip(tags, descriptives)),
        }

    # Normality per group (skipped if override forces a branch).
    normality = [_shapiro(v) for v in cleaned]
    branch = _decide_branch(normality, test_override)

    runner = {
        'unpaired_2': _run_unpaired_2,
        'oneway_n': _run_oneway_n,
        'paired_2': _run_paired_2,
        'rm_n': _run_rm_n,
    }[design_kind]

    try:
        test_result = runner(cleaned, tags, branch)
    except Exception as exc:  # noqa: BLE001 — surface, don't crash
        return {
            'error': f'{type(exc).__name__}: {exc}',
            'descriptives': dict(zip(tags, descriptives)),
            'normality': dict(zip(tags, normality)),
            'branch': branch,
        }

    return {
        **test_result,
        'branch': branch,
        'override': test_override,
        'normality': dict(zip(tags, normality)),
        'descriptives': dict(zip(tags, descriptives)),
        'design_kind': design_kind,
        'group_tags': tags,
        'alpha': SHAPIRO_ALPHA,
    }
