"""Group an ordered list of events into "trains" (clusters of closely
spaced events). Pure function — no FastAPI, no numpy required.

Twin of ``frontend/src/utils/trains.ts``. The two implementations MUST
produce identical output for the same input; ``tests/trains_parity.py``
verifies this against a fixture JSON. If you change the algorithm
here, change the TS version too (or vice versa) and re-run the test.

Designed so point events (APs, synaptic peak times) and extended events
(epileptiform bursts) share one code path: a point event has
``t_start == t_end == t``.
"""

from __future__ import annotations

from typing import Optional


def _iei_ms(prev: dict, nxt: dict, metric: str) -> float:
    if metric == "peak_to_peak":
        return (float(nxt["t"]) - float(prev["t"])) * 1000.0
    # gap
    prev_end = float(prev.get("t_end", prev["t"]))
    next_start = float(nxt.get("t_start", nxt["t"]))
    return (next_start - prev_end) * 1000.0


def _summarize(
    events: list[dict],
    members: list[int],
    train_id: int,
    metric: str,
) -> dict:
    first = events[members[0]]
    last = events[members[-1]]
    start_s = float(first.get("t_start", first["t"]))
    end_s = float(last.get("t_end", last["t"]))
    duration_ms = (end_s - start_s) * 1000.0
    mean_iei_ms: Optional[float] = None
    intra_freq_hz: Optional[float] = None
    if len(members) >= 2:
        total = 0.0
        for i in range(1, len(members)):
            total += _iei_ms(events[members[i - 1]], events[members[i]], metric)
        mean_iei_ms = total / (len(members) - 1)
        if mean_iei_ms > 0:
            intra_freq_hz = 1000.0 / mean_iei_ms
    return {
        "id": train_id,
        "start_s": start_s,
        "end_s": end_s,
        "duration_ms": duration_ms,
        "n_events": len(members),
        "mean_iei_ms": mean_iei_ms,
        "intra_freq_hz": intra_freq_hz,
        "member_indices": list(members),
    }


def group_into_trains(
    events: list[dict],
    *,
    metric: str = "gap",
    max_iei_ms: float,
    min_count: int = 2,
    min_duration_ms: float = 0.0,
    min_inter_train_ms: float = 0.0,
) -> tuple[list[Optional[int]], list[dict]]:
    """Cluster consecutive events whose IEI is below ``max_iei_ms``.

    ``events`` must be sorted by ``t``. Each event is a dict with at
    least ``t`` (seconds); extended events also carry ``t_start`` and
    ``t_end``. Returns ``(train_id_per_event, train_summaries)`` where
    ``train_id_per_event[i]`` is None for isolated events.
    """
    if not events:
        return [], []
    n = len(events)
    if n < 2:
        return [None] * n, []

    min_count = max(2, int(min_count))
    min_duration_ms = max(0.0, float(min_duration_ms))
    min_inter_train_ms = max(0.0, float(min_inter_train_ms))

    # Forward pass.
    candidates: list[list[int]] = []
    current: list[int] = [0]
    for i in range(1, n):
        dt = _iei_ms(events[i - 1], events[i], metric)
        if dt <= max_iei_ms:
            current.append(i)
        else:
            candidates.append(current)
            current = [i]
    candidates.append(current)

    # Filter by min count and min duration.
    kept: list[list[int]] = []
    for m in candidates:
        if len(m) < min_count:
            continue
        if min_duration_ms > 0:
            f = events[m[0]]
            l = events[m[-1]]
            dur = (float(l.get("t_end", l["t"])) - float(f.get("t_start", f["t"]))) * 1000.0
            if dur < min_duration_ms:
                continue
        kept.append(m)

    # Optional merge of close-but-separated trains.
    if min_inter_train_ms > 0 and len(kept) > 1:
        merged: list[list[int]] = [kept[0]]
        for i in range(1, len(kept)):
            prev = merged[-1]
            a = events[prev[-1]]
            b = events[kept[i][0]]
            gap_ms = _iei_ms(a, b, metric)
            if gap_ms < min_inter_train_ms:
                merged[-1] = prev + kept[i]
            else:
                merged.append(kept[i])
        kept = merged

    train_id_per_event: list[Optional[int]] = [None] * n
    summaries: list[dict] = []
    for idx, members in enumerate(kept):
        for i in members:
            train_id_per_event[i] = idx
        summaries.append(_summarize(events, members, idx, metric))

    return train_id_per_event, summaries
