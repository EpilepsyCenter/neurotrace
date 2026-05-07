"""Parity test for the train-grouping algorithm.

Runs the Python implementation (``backend/analysis/trains.py``) against
the fixture, then shells out to Node to run the TypeScript twin
(``frontend/src/utils/trains.ts``), and checks that both produce the
same output.

Run:    python tests/trains_parity.py

Requires Node >= 22.6 (for native TS type stripping). Tested on 25.x.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.analysis.trains import group_into_trains  # noqa: E402

FIXTURE = ROOT / "tests" / "trains_fixture.json"
TS_RUNNER = ROOT / "tests" / "trains_parity_runner.mjs"


def normalize(obj):
    """Recursively round floats so cross-language IEEE-754 noise doesn't
    cause spurious diffs. 1e-9 is well below any electrophysiology
    relevance and well above what 64-bit float arithmetic produces."""
    if isinstance(obj, float):
        if math.isnan(obj):
            return "NaN"
        return round(obj, 9)
    if isinstance(obj, dict):
        return {k: normalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [normalize(x) for x in obj]
    return obj


def run_python(cases: list[dict]) -> list[dict]:
    out = []
    for case in cases:
        ids, summaries = group_into_trains(case["events"], **case["params"])
        out.append({"name": case["name"], "ids": ids, "summaries": summaries})
    return out


def run_ts(cases: list[dict]) -> list[dict]:
    proc = subprocess.run(
        ["node", str(TS_RUNNER), str(FIXTURE)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise RuntimeError(f"TS runner failed (exit {proc.returncode})")
    return json.loads(proc.stdout)


def main() -> int:
    cases = json.loads(FIXTURE.read_text())
    py = normalize(run_python(cases))
    ts = normalize(run_ts(cases))

    failures = []
    for p, t in zip(py, ts):
        if p != t:
            failures.append((p["name"], p, t))

    if failures:
        print(f"FAIL — {len(failures)}/{len(py)} cases diverge")
        for name, p, t in failures:
            print(f"\n[{name}]")
            print(f"  python: {json.dumps(p, sort_keys=True)}")
            print(f"  ts:     {json.dumps(t, sort_keys=True)}")
        return 1

    print(f"OK — all {len(py)} cases match across Python and TypeScript")
    for c in py:
        n_trains = len(c["summaries"])
        n_in = sum(1 for x in c["ids"] if x is not None)
        print(f"  {c['name']:30s}  trains={n_trains}  in_train={n_in}/{len(c['ids'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
