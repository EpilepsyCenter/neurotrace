import type { BurstRecord } from '../stores/appStore'
import type { TrainEvent, TrainParams, TrainSummary } from './trains'
import { computeTrains } from './trains'

/** Apply the generic train-grouping algorithm to a list of detected
 *  bursts, walking sweep by sweep so trains never span two trials.
 *  Sorts each sweep's bursts by start time before calling
 *  ``computeTrains`` so manual additions / deletions can't put us
 *  out of order. Train IDs are assigned globally (across sweeps,
 *  per recording series) so the on-screen labels and CSV exports
 *  agree.
 *
 *  Used by both ``FieldBurstWindow`` (for the live overlay + tables)
 *  and ``exportFieldBurstsCSV`` / ``exportFieldBurstTrainsCSV`` (for
 *  the CSV writers). The two MUST agree on the IDs — that's why the
 *  algorithm lives here, not duplicated.
 *
 *  Returns ``idByGlobalIdx`` of length ``bursts.length`` (``null`` =
 *  isolated) and ``flatSummaries`` annotated with the sweep each
 *  train belongs to. */
export function computeBurstTrainIds(
  bursts: BurstRecord[],
  cfg: TrainParams & { enabled?: boolean },
): {
  idByGlobalIdx: (number | null)[]
  flatSummaries: Array<TrainSummary & { sweep: number }>
  summariesBySweep: Map<number, TrainSummary[]>
} {
  const idByGlobalIdx: (number | null)[] = new Array(bursts.length).fill(null)
  const flatSummaries: Array<TrainSummary & { sweep: number }> = []
  const summariesBySweep = new Map<number, TrainSummary[]>()
  if (!cfg.enabled || bursts.length < 2) {
    return { idByGlobalIdx, flatSummaries, summariesBySweep }
  }

  const indicesBySweep = new Map<number, number[]>()
  for (let gi = 0; gi < bursts.length; gi++) {
    const sw = bursts[gi].sweepIndex
    const list = indicesBySweep.get(sw) ?? []
    list.push(gi)
    indicesBySweep.set(sw, list)
  }
  let trainCounter = 0
  const sortedSweeps = Array.from(indicesBySweep.keys()).sort((a, b) => a - b)
  for (const sw of sortedSweeps) {
    const sweepIdxs = indicesBySweep.get(sw)!
    sweepIdxs.sort((a, b) => bursts[a].startS - bursts[b].startS)
    const events: TrainEvent[] = sweepIdxs.map((gi) => ({
      t: bursts[gi].peakTimeS,
      tStart: bursts[gi].startS,
      tEnd: bursts[gi].endS,
    }))
    const result = computeTrains(events, {
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
