#!/usr/bin/env python3
"""One-shot migration: copy analyses from the legacy Electron prefs
file into ``.neurotrace`` sidecars next to each recording.

Why this exists
---------------
Before the sidecar persistence layer landed, NeuroTrace stored every
analysis under ``~/Library/Application Support/neurotrace/preferences.json``
keyed by ``saved<Slice>[recording_path]``. Files with prefs entries
load fine when opened in the app (the legacy hydration path runs),
but the **cohort module reads only sidecars** — it has no knowledge
of the prefs file. So files that haven't been re-opened (and
therefore re-saved to sidecar) are invisible to cohort even though
their analyses are right there.

The frontend now does an eager prefs → sidecar migration at openFile
time, but that requires opening each file. This script is the
batched equivalent for users with many recordings.

Usage
-----
    python3 scripts/migrate_prefs_to_sidecars.py [--dry-run]

Reads ``~/Library/Application Support/neurotrace/preferences.json``
(macOS path; tweak for your platform if needed). For every recording
path that has at least one ``saved<Slice>`` entry:

  1. Read the existing sidecar (or start with an empty payload)
  2. Merge in every prefs slice that the sidecar doesn't already
     have data for (sidecar wins on conflict — the sidecar is
     considered the more recent source)
  3. Write the merged payload back to the sidecar via tmp + rename
     (matches the atomic-write pattern in electron/main.ts)

Skips recording files that no longer exist on disk (their sidecar
would be orphaned anyway).

Idempotent — running twice does nothing the second time.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

# Mapping: prefs key → sidecar slice name. Mirrors the openFile
# legacy hydration code in frontend/src/stores/appStore.ts.
PREFS_TO_SIDECAR = {
    'savedFieldBursts':   ('analyses', 'bursts'),
    'savedEventsAnalyses': ('analyses', 'events'),
    'savedAPAnalyses':     ('analyses', 'ap'),
    'savedIVCurves':       ('analyses', 'iv_curves'),
    'savedFPspCurves':     ('analyses', 'fpsp_curves'),
    'savedCursorAnalyses': ('analyses', 'cursor_analyses'),
    'savedBurstFormParams': ('burst_form_params', None),
    'savedExcludedSweeps': ('excluded_sweeps', None),
    'savedAveragedSweeps': ('averaged_sweeps', None),
}


def _prefs_path() -> Path:
    """macOS prefs location. Adjust for win32 / linux as needed."""
    home = Path.home()
    return home / 'Library' / 'Application Support' / 'neurotrace' / 'preferences.json'


def _load_sidecar(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with path.open('r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _atomic_write(path: Path, payload: dict):
    """tmp + rename, same pattern as electron/main.ts. Best-effort
    crash-safe."""
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true',
                    help="Show what would be migrated; don't write anything.")
    ap.add_argument('--prefs', type=Path, default=None,
                    help="Override prefs file location.")
    args = ap.parse_args()

    prefs_path = args.prefs or _prefs_path()
    if not prefs_path.exists():
        print(f"Prefs file not found: {prefs_path}", file=sys.stderr)
        return 1

    with prefs_path.open('r', encoding='utf-8') as f:
        prefs = json.load(f)

    # Collect all recording paths mentioned in any saved<Slice> block.
    recording_paths: set[str] = set()
    for prefs_key in PREFS_TO_SIDECAR:
        block = prefs.get(prefs_key) or {}
        if isinstance(block, dict):
            recording_paths.update(block.keys())

    if not recording_paths:
        print("No legacy analysis data in prefs — nothing to migrate.")
        return 0

    migrated = 0
    skipped_missing = 0
    skipped_already = 0
    for rp in sorted(recording_paths):
        if not os.path.exists(rp):
            skipped_missing += 1
            continue
        sidecar_path = Path(str(rp) + '.neurotrace')
        existing = _load_sidecar(sidecar_path)
        # Start with the existing sidecar as the base; merge in only
        # slices the sidecar doesn't already have data for.
        next_payload = dict(existing)
        next_payload.setdefault('format', 'neurotrace-sidecar')
        next_payload.setdefault('version', 2)
        analyses = dict(next_payload.get('analyses') or {})

        anything_migrated = False
        for prefs_key, (top_field, sub_field) in PREFS_TO_SIDECAR.items():
            block = prefs.get(prefs_key) or {}
            if not isinstance(block, dict):
                continue
            slice_data = block.get(rp)
            if not slice_data:
                continue
            # Only fill slices that aren't already in the sidecar.
            if sub_field is None:
                # Top-level field (excluded_sweeps, averaged_sweeps,
                # burst_form_params).
                if next_payload.get(top_field):
                    continue
                next_payload[top_field] = slice_data
                anything_migrated = True
            else:
                # Nested under analyses.
                if analyses.get(sub_field):
                    continue
                analyses[sub_field] = slice_data
                anything_migrated = True
        if anything_migrated:
            next_payload['analyses'] = analyses
        else:
            skipped_already += 1
            continue

        rel = os.path.basename(rp)
        if args.dry_run:
            slices_added = sorted(set(analyses.keys()) - set((existing.get('analyses') or {}).keys()))
            top_added = sorted(set(next_payload.keys()) - set(existing.keys()) - {'analyses', 'format', 'version'})
            print(f"  would migrate {rel}: analyses+={slices_added}, top+={top_added}")
        else:
            _atomic_write(sidecar_path, next_payload)
            print(f"  migrated {rel}")
        migrated += 1

    print()
    print(f"Migrated:        {migrated}")
    print(f"Already in sidecar: {skipped_already}")
    print(f"Recording missing:  {skipped_missing}")
    if args.dry_run:
        print()
        print("Dry-run — re-run without --dry-run to actually write the sidecars.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
