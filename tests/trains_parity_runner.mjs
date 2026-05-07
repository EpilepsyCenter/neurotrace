// Tiny Node runner for the TS train-grouping twin. Reads the fixture,
// calls computeTrains, prints the result as JSON to stdout in the same
// shape Python emits, so trains_parity.py can diff the two.
//
// Requires Node >= 22.6 (native TS type stripping).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { computeTrains } from '../frontend/src/utils/trains.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = process.argv[2] ?? path.join(here, 'trains_fixture.json')
const cases = JSON.parse(readFileSync(fixturePath, 'utf8'))

function paramsToTs(p) {
  return {
    metric: p.metric,
    maxIeiMs: p.max_iei_ms,
    minCount: p.min_count ?? 2,
    minDurationMs: p.min_duration_ms ?? 0,
    minInterTrainMs: p.min_inter_train_ms ?? 0,
  }
}

function eventToTs(e) {
  const out = { t: e.t }
  if ('t_start' in e) out.tStart = e.t_start
  if ('t_end' in e) out.tEnd = e.t_end
  return out
}

function summaryToPyShape(s) {
  return {
    id: s.id,
    start_s: s.startS,
    end_s: s.endS,
    duration_ms: s.durationMs,
    n_events: s.nEvents,
    mean_iei_ms: s.meanIeiMs,
    intra_freq_hz: s.intraFreqHz,
    member_indices: s.memberIndices,
  }
}

const out = []
for (const c of cases) {
  const events = c.events.map(eventToTs)
  const result = computeTrains(events, paramsToTs(c.params))
  out.push({
    name: c.name,
    ids: result.trainIdByIndex,
    summaries: result.trainSummaries.map(summaryToPyShape),
  })
}

process.stdout.write(JSON.stringify(out))
