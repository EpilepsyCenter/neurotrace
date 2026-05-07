import type { EventRow } from '../stores/appStore'
import type { TrainEvent, TrainParams, TrainSummary } from './trains'
import { computeTrains } from './trains'

/** Apply the generic train-grouping algorithm to a list of detected
 *  synaptic events, walking sweep by sweep so trains never span two
 *  sweeps. Sorts each sweep's events by peakTimeS before calling
 *  ``computeTrains`` so manual additions / deletions can't put us
 *  out of order. Train IDs are assigned globally (across sweeps,
 *  per recording series) so the on-screen labels and CSV exports
 *  agree.
 *
 *  Twin of ``utils/burstTrains.ts::computeBurstTrainIds``. The two
 *  share an algorithm but differ in input shape — events are point
 *  events (peakTimeS only), bursts are extended (start/end/peak).
 *
 *  Returns ``idByGlobalIdx`` of length ``events.length`` (``null`` =
 *  isolated) and ``flatSummaries`` annotated with the sweep each
 *  train belongs to. */
export function computeEventTrainIds(
  events: EventRow[],
  cfg: TrainParams & { enabled?: boolean },
): {
  idByGlobalIdx: (number | null)[]
  flatSummaries: Array<TrainSummary & { sweep: number }>
  summariesBySweep: Map<number, TrainSummary[]>
} {
  const idByGlobalIdx: (number | null)[] = new Array(events.length).fill(null)
  const flatSummaries: Array<TrainSummary & { sweep: number }> = []
  const summariesBySweep = new Map<number, TrainSummary[]>()
  if (!cfg.enabled || events.length < 2) {
    return { idByGlobalIdx, flatSummaries, summariesBySweep }
  }

  const indicesBySweep = new Map<number, number[]>()
  for (let gi = 0; gi < events.length; gi++) {
    const sw = events[gi].sweep
    const list = indicesBySweep.get(sw) ?? []
    list.push(gi)
    indicesBySweep.set(sw, list)
  }
  let trainCounter = 0
  const sortedSweeps = Array.from(indicesBySweep.keys()).sort((a, b) => a - b)
  for (const sw of sortedSweeps) {
    const sweepIdxs = indicesBySweep.get(sw)!
    sweepIdxs.sort((a, b) => events[a].peakTimeS - events[b].peakTimeS)
    const trainEvents: TrainEvent[] = sweepIdxs.map((gi) => ({
      t: events[gi].peakTimeS,
    }))
    const result = computeTrains(trainEvents, {
      metric: cfg.metric,
      maxIeiMs: cfg.maxIeiMs,
      minCount: cfg.minCount,
      minDurationMs: cfg.minDurationMs,
      minInterTrainMs: cfg.minInterTrainMs,
    })
    const sweepSummaries: TrainSummary[] = []
    for (const orig of result.trainSummaries) {
      const newId = trainCounter++
      const remappedMembers = orig.memberIndices.map((li) => sweepIdxs[li])
      for (const gi of remappedMembers) idByGlobalIdx[gi] = newId
      const remapped: TrainSummary = {
        ...orig,
        id: newId,
        memberIndices: remappedMembers,
      }
      sweepSummaries.push(remapped)
      flatSummaries.push({ ...remapped, sweep: sw })
    }
    summariesBySweep.set(sw, sweepSummaries)
  }
  return { idByGlobalIdx, flatSummaries, summariesBySweep }
}
