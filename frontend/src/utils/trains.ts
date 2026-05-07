/**
 * Group an ordered list of events into "trains" (clusters of closely
 * spaced events). Pure function — no I/O, no state. The same algorithm
 * exists in backend/analysis/trains.py; the two MUST stay in sync. See
 * tests/trains_parity.* for the fixture used to verify that.
 *
 * The algorithm is a single forward pass: walk consecutive pairs, start
 * a candidate train when the gap is small enough, append while it stays
 * small, close it when the gap widens. After the pass, drop trains
 * shorter than the minimum count or duration, then optionally merge
 * adjacent trains separated by less than min_inter_train_ms.
 *
 * Designed so point events (APs, synaptic peak times) and extended
 * events (epileptiform bursts) share one code path: a point event has
 * tStart === tEnd === t.
 */

export type TrainMetric = 'gap' | 'peak_to_peak'

export interface TrainEvent {
  /** Reference time, seconds. For point events this is the only time
   *  that matters; for extended events it is typically the peak. */
  t: number
  /** Event onset, seconds. Defaults to t for point events. */
  tStart?: number
  /** Event offset, seconds. Defaults to t for point events. */
  tEnd?: number
}

export interface TrainParams {
  metric: TrainMetric
  /** Maximum inter-event interval (ms) for two events to belong to the
   *  same train. Interpretation depends on metric. */
  maxIeiMs: number
  /** Minimum number of events to count as a train. */
  minCount: number
  /** Minimum total train duration (ms). 0 disables the floor. */
  minDurationMs?: number
  /** Minimum silence (ms) between two trains; trains separated by less
   *  than this get merged after initial grouping. 0 disables. */
  minInterTrainMs?: number
}

export interface TrainSummary {
  id: number
  startS: number
  endS: number
  durationMs: number
  nEvents: number
  meanIeiMs: number | null
  intraFreqHz: number | null
  memberIndices: number[]
}

export interface TrainResult {
  /** Same length as the input event list. null = isolated event. */
  trainIdByIndex: (number | null)[]
  trainSummaries: TrainSummary[]
}

const EMPTY: TrainResult = { trainIdByIndex: [], trainSummaries: [] }

function ieiMs(
  prev: TrainEvent,
  next: TrainEvent,
  metric: TrainMetric,
): number {
  if (metric === 'peak_to_peak') {
    return (next.t - prev.t) * 1000
  }
  // gap (end of prev → start of next)
  const prevEnd = prev.tEnd ?? prev.t
  const nextStart = next.tStart ?? next.t
  return (nextStart - prevEnd) * 1000
}

function summarize(
  events: TrainEvent[],
  members: number[],
  id: number,
  metric: TrainMetric,
): TrainSummary {
  const first = events[members[0]]
  const last = events[members[members.length - 1]]
  const startS = first.tStart ?? first.t
  const endS = last.tEnd ?? last.t
  const durationMs = (endS - startS) * 1000
  let meanIeiMs: number | null = null
  let intraFreqHz: number | null = null
  if (members.length >= 2) {
    let sum = 0
    for (let i = 1; i < members.length; i++) {
      sum += ieiMs(events[members[i - 1]], events[members[i]], metric)
    }
    meanIeiMs = sum / (members.length - 1)
    if (meanIeiMs > 0) intraFreqHz = 1000 / meanIeiMs
  }
  return {
    id,
    startS,
    endS,
    durationMs,
    nEvents: members.length,
    meanIeiMs,
    intraFreqHz,
    memberIndices: members.slice(),
  }
}

export function computeTrains(
  events: TrainEvent[] | null | undefined,
  params: TrainParams,
): TrainResult {
  if (!events || events.length === 0) return EMPTY
  const n = events.length
  if (n < 2) return { trainIdByIndex: new Array(n).fill(null), trainSummaries: [] }

  const minCount = Math.max(2, Math.floor(params.minCount))
  const minDurationMs = Math.max(0, params.minDurationMs ?? 0)
  const minInterTrainMs = Math.max(0, params.minInterTrainMs ?? 0)
  const maxIeiMs = params.maxIeiMs
  const metric = params.metric

  // Forward pass: candidate clusters.
  const candidates: number[][] = []
  let current: number[] = [0]
  for (let i = 1; i < n; i++) {
    const dt = ieiMs(events[i - 1], events[i], metric)
    if (dt <= maxIeiMs) {
      current.push(i)
    } else {
      candidates.push(current)
      current = [i]
    }
  }
  candidates.push(current)

  // Filter by min count and min duration.
  let kept = candidates.filter((m) => {
    if (m.length < minCount) return false
    if (minDurationMs > 0) {
      const f = events[m[0]]
      const l = events[m[m.length - 1]]
      const dur = ((l.tEnd ?? l.t) - (f.tStart ?? f.t)) * 1000
      if (dur < minDurationMs) return false
    }
    return true
  })

  // Optional merge: trains separated by < min_inter_train_ms.
  if (minInterTrainMs > 0 && kept.length > 1) {
    const merged: number[][] = [kept[0]]
    for (let i = 1; i < kept.length; i++) {
      const prev = merged[merged.length - 1]
      const a = events[prev[prev.length - 1]]
      const b = events[kept[i][0]]
      const gapMs = ieiMs(a, b, metric)
      if (gapMs < minInterTrainMs) {
        merged[merged.length - 1] = prev.concat(kept[i])
      } else {
        merged.push(kept[i])
      }
    }
    kept = merged
  }

  const trainIdByIndex: (number | null)[] = new Array(n).fill(null)
  const trainSummaries: TrainSummary[] = []
  kept.forEach((members, idx) => {
    for (const i of members) trainIdByIndex[i] = idx
    trainSummaries.push(summarize(events, members, idx, metric))
  })

  return { trainIdByIndex, trainSummaries }
}
