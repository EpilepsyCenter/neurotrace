import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  CursorPositions,
  FPspData,
  FPspPoint,
  FPspMeasurementMethod,
  FPspPeakDirection,
  FPspTimeAxis,
} from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

const MARKER = {
  baseline: '#9e9e9e',
  volley: '#64b5f6',
  fepsp: '#e57373',
  slopeLo: '#ffb74d',
  slopeHi: '#ffb74d',
}

export function FPspWindow({
  backendUrl,
  fileInfo,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    fpspCurves,
    runFPsp,
    clearFPsp,
    selectFPspPoint,
    setFPspTimeAxis,
    setFPspNormalize,
    exportFPspCSV,
    setCursors: _mainSetCursors,  // for Auto-place via BroadcastChannel
    loading,
    error,
    setError,
  } = useAppStore()
  void _mainSetCursors

  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [seriesB, setSeriesB] = useState<number | null>(null)  // LTP series
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])

  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  // Params local to the window — not persisted until Run commits them.
  const [method, setMethod] = useState<FPspMeasurementMethod>('range_slope')
  const [slopeLow, setSlopeLow] = useState(20)
  const [slopeHigh, setSlopeHigh] = useState(80)
  const [peakDir, setPeakDir] = useState<FPspPeakDirection>('auto')
  const [avgN, setAvgN] = useState(1)
  // Pre-detection filter, same shape as bursts. Default off.
  const [filterEnabled, setFilterEnabled] = useState(false)
  const [filterType, setFilterType] = useState<'lowpass' | 'highpass' | 'bandpass'>('lowpass')
  const [filterLow, setFilterLow] = useState(1)
  // Lowpass 2 kHz, order 1: higher orders (or lower cutoffs) ring the
  // volley flank and artificially inflate its amplitude — the volley is
  // a fast deflection (~0.5 ms rise), so keep the filter gentle.
  const [filterHigh, setFilterHigh] = useState(2000)
  const [filterOrder, setFilterOrder] = useState(1)

  // Run-mode controls (mirror the FieldBurstWindow pattern).
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // Splitters.
  const [topHeight, setTopHeight] = useState(300)
  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = topHeight
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      setTopHeight(Math.max(150, Math.min(800, startH + dy)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const key = `${group}:${series}`
  const entry = fpspCurves[key]

  // Rehydrate the form from the persisted entry whenever we "land on" a
  // (group, series) pair that has results stored — either because the
  // user opened the window fresh and state-sync delivered fpspCurves
  // from disk, or because they switched selector to a pair that was
  // previously analysed. Without this, closing and reopening the window
  // leaves the form showing defaults even though the plot+table below
  // show the persisted run.
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    setSeriesB(entry.seriesB)
    setChannel(entry.channel)
    setMethod(entry.measurementMethod)
    setSlopeLow(entry.slopeLowPct)
    setSlopeHigh(entry.slopeHighPct)
    setPeakDir(entry.peakDirection)
    setAvgN(entry.avgN)
    setFilterEnabled(entry.filterEnabled)
    setFilterType(entry.filterType)
    setFilterLow(entry.filterLow)
    setFilterHigh(entry.filterHigh)
    setFilterOrder(entry.filterOrder)
  }, [entry, key])

  /** Auto-place cursors: detect stim onset from the backend, then place
   *  baseline / volley / fEPSP windows at sensible defaults around it.
   *  Writes cursors through the main store's setCursors so the main viewer
   *  updates instantly, AND broadcasts a cursor-update so the main window
   *  picks them up regardless of which window we're running in. */
  const onAutoPlace = async () => {
    if (!backendUrl || !fileInfo) return
    try {
      // Do a tiny, no-op run just to read stim_onset_s back. Using a trivial
      // set of windows so it returns fast, without side effects to data.
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(channel),
        baseline_start_s: '0', baseline_end_s: '0.001',
        volley_start_s: '0.001', volley_end_s: '0.002',
        fepsp_start_s: '0.002', fepsp_end_s: '0.003',
        method: 'amplitude', slope_low_pct: '20', slope_high_pct: '80',
        peak_direction: 'auto', avg_n: '1',
        sweeps: '0',
      })
      const resp = await fetch(`${backendUrl}/api/fpsp/run?${qs}`)
      if (!resp.ok) return
      const data = await resp.json()
      const t0 = Number(data.stim_onset_s ?? 0)
      // Defaults (e.g. for a 1 ms stim pulse starting at t0):
      //   Baseline: [0, t0 − 0.5 ms]
      //   Volley:  [t0 + 1 ms, t0 + 2 ms]    (1 ms wide, right after stim pulse)
      //   fEPSP:   [t0 + 2 ms, t0 + 5 ms]    (3 ms wide, starts at end of volley)
      // Map to main cursor pairs:
      //   baseline cursor pair → baseline window
      //   fit cursor pair      → volley window
      //   peak cursor pair     → fEPSP window
      const newCursors: Partial<CursorPositions> = {
        baselineStart: 0,
        baselineEnd: Math.max(0, t0 - 0.0005),
        fitStart: t0 + 0.001,
        fitEnd: t0 + 0.002,
        peakStart: t0 + 0.002,
        peakEnd: t0 + 0.005,
      }
      // Push to this window's store (so the read-out row updates).
      useAppStore.getState().setCursors(newCursors)
      // Broadcast so the MAIN window's cursor state updates too — its
      // viewer can only adopt via the neurotrace-sync channel.
      try {
        const ch = new BroadcastChannel('neurotrace-sync')
        const merged = { ...useAppStore.getState().cursors, ...newCursors }
        ch.postMessage({ type: 'cursor-update', cursors: merged })
        ch.close()
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  const onRun = () => {
    let sweepIndices: number[] | null = null
    let appendToExisting = false
    if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      sweepIndices = []
      for (let i = lo - 1; i <= hi - 1; i++) sweepIndices.push(i)
    } else if (runMode === 'one') {
      const sw = Math.max(1, Math.min(sweepOne, totalSweeps))
      sweepIndices = [sw - 1]
      appendToExisting = true
    }
    runFPsp(group, series, channel, {
      seriesB,
      baselineStartS: cursors.baselineStart,
      baselineEndS: cursors.baselineEnd,
      volleyStartS: cursors.fitStart,
      volleyEndS: cursors.fitEnd,
      fepspStartS: cursors.peakStart,
      fepspEndS: cursors.peakEnd,
      method,
      slopeLowPct: slopeLow,
      slopeHighPct: slopeHigh,
      peakDirection: peakDir,
      avgN,
      sweepIndices,
      appendToExisting,
      filterEnabled,
      filterType,
      filterLow,
      filterHigh,
      filterOrder,
    })
  }

  const onSelectPoint = (idx: number) => {
    selectFPspPoint(group, series, idx)
    // Broadcast the first sweep of this bin so the main viewer jumps to it.
    const p = entry?.points[idx]
    if (p && p.sweepIndices.length > 0) {
      try {
        const ch = new BroadcastChannel('neurotrace-sync')
        ch.postMessage({ type: 'sweep-update', sweep: p.sweepIndices[0] })
        ch.close()
      } catch { /* ignore */ }
    }
  }

  const flaggedCount = entry ? entry.points.filter((p) => p.flagged).length : 0

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Selectors */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Baseline series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <Field label="LTP series (optional)">
          <select
            value={seriesB ?? ''}
            onChange={(e) => setSeriesB(e.target.value === '' ? null : Number(e.target.value))}
            disabled={!fileInfo}
          >
            <option value="">— none —</option>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              i !== series ? (
                <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
              ) : null
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Cursor readout + Auto-place */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
        padding: 8,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ color: MARKER.baseline, fontWeight: 600 }}>Baseline:</span>
        <span>{cursors.baselineStart.toFixed(4)}→{cursors.baselineEnd.toFixed(4)}s</span>
        <span style={{ color: MARKER.volley, fontWeight: 600 }}>Volley:</span>
        <span>{cursors.fitStart.toFixed(4)}→{cursors.fitEnd.toFixed(4)}s</span>
        <span style={{ color: MARKER.fepsp, fontWeight: 600 }}>fEPSP:</span>
        <span>{cursors.peakStart.toFixed(4)}→{cursors.peakEnd.toFixed(4)}s</span>
        <button
          className="btn"
          onClick={onAutoPlace}
          disabled={!backendUrl || !fileInfo}
          style={{ marginLeft: 'auto' }}
          title="Detect stim onset from the .pgf channel and place baseline / volley / fEPSP cursors at sensible defaults"
        >
          Auto-place cursors
        </button>
      </div>

      {/* Pre-detection filter (optional) */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: 8, border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={filterEnabled}
            onChange={(e) => setFilterEnabled(e.target.checked)} />
          <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
        </label>
        {filterEnabled && (
          <>
            <select value={filterType}
              onChange={(e) => setFilterType(e.target.value as 'lowpass' | 'highpass' | 'bandpass')}
              style={{ fontSize: 'var(--font-size-label)' }}>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
              <option value="bandpass">Bandpass</option>
            </select>
            {(filterType === 'highpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>low</span>
                <NumInput value={filterLow} step={0.1} min={0}
                  onChange={setFilterLow} style={{ width: 64 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            {(filterType === 'lowpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>high</span>
                <NumInput value={filterHigh} step={10} min={1}
                  onChange={setFilterHigh} style={{ width: 70 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)' }}>order</span>
              <NumInput value={filterOrder} step={1} min={1} max={8}
                onChange={(v) => setFilterOrder(Math.max(1, Math.min(8, Math.round(v))))}
                style={{ width: 42 }} />
            </label>
          </>
        )}
        {!filterEnabled && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', fontStyle: 'italic' }}>
            off (default) — applied per-sweep before averaging; try 2 kHz lowpass order 1 to clean HF noise without inflating the volley
          </span>
        )}
      </div>

      {/* Params */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 8,
        padding: 8,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <Field label="Measurement">
          <select value={method} onChange={(e) => setMethod(e.target.value as FPspMeasurementMethod)}>
            <option value="amplitude">Amplitude (peak)</option>
            <option value="full_slope">Slope (10%→peak)</option>
            <option value="range_slope">Slope (low%→high%)</option>
          </select>
        </Field>
        {method === 'range_slope' && (
          <>
            <ParamRow label="Low %" value={slopeLow} step={5} min={0} max={100}
              onChange={(v) => setSlopeLow(Math.max(0, Math.min(100, v)))} />
            <ParamRow label="High %" value={slopeHigh} step={5} min={0} max={100}
              onChange={(v) => setSlopeHigh(Math.max(0, Math.min(100, v)))} />
          </>
        )}
        <Field label="Peak direction">
          <select value={peakDir} onChange={(e) => setPeakDir(e.target.value as FPspPeakDirection)}>
            <option value="auto">Auto (|max dev|)</option>
            <option value="negative">Negative</option>
            <option value="positive">Positive</option>
          </select>
        </Field>
        <ParamRow label="Average N sweeps" value={avgN} step={1} min={1}
          onChange={(v) => setAvgN(Math.max(1, Math.round(v)))} />
      </div>

      {/* Run controls */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Run on:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="fpsp-run-mode" checked={runMode === 'all'}
            onChange={() => setRunMode('all')} />
          all sweeps
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="fpsp-run-mode" checked={runMode === 'range'}
            onChange={() => setRunMode('range')} />
          range
        </label>
        {runMode === 'range' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>–</span>
            <NumInput value={sweepTo} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepTo(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="fpsp-run-mode" checked={runMode === 'one'}
            onChange={() => setRunMode('one')} />
          single sweep
        </label>
        {runMode === 'one' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'} · appends
            </span>
          </span>
        )}
        <button className="btn btn-primary" onClick={onRun} disabled={loading || !fileInfo}
          style={{ marginLeft: 8 }}>
          {loading ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={() => clearFPsp(group, series)} disabled={!entry}>
          Clear
        </button>
        <button className="btn" onClick={() => exportFPspCSV()}
          disabled={Object.keys(fpspCurves).length === 0}
          style={{ marginLeft: 'auto' }}>
          Export CSV
        </button>
      </div>

      {error && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-error, #5c1b1b)',
          color: '#fff', borderRadius: 3,
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 'var(--font-size-xs)',
        }}>
          <span style={{ flex: 1 }}>⚠ {error}</span>
          <button className="btn" onClick={() => setError(null)}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>dismiss</button>
        </div>
      )}

      {/* Summary + graph-mode toggles */}
      {entry && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--bg-primary)',
          padding: '4px 8px',
          borderRadius: 3,
          border: '1px solid var(--border)',
          display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span>
            <strong style={{ color: 'var(--text-primary)' }}>{entry.points.length}</strong> bins ·
            stim onset {entry.stimOnsetS.toFixed(4)}s ·
            unit {entry.responseUnit || '—'} ·
            avg N {entry.avgN}
          </span>
          {flaggedCount > 0 && (
            <span style={{ color: '#e57373' }}>
              ⚠ {flaggedCount} with ratio {'<'} 3
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-ui)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <input type="radio" checked={entry.timeAxis === 'timestamp'}
                onChange={() => setFPspTimeAxis(group, series, 'timestamp')} />
              time
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <input type="radio" checked={entry.timeAxis === 'index'}
                onChange={() => setFPspTimeAxis(group, series, 'index')} />
              index
            </label>
            <span style={{ color: 'var(--border)' }}>|</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <input type="checkbox" checked={entry.normalize}
                onChange={(e) => setFPspNormalize(group, series, e.target.checked)} />
              normalize
            </label>
            {entry.normalize && (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                (% of mean across all baseline-series points)
              </span>
            )}
          </span>
        </div>
      )}

      {/* Top: mini-viewer + over-time graph side-by-side */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      }}>
        <div style={{
          height: topHeight, minHeight: 150,
          display: 'flex', gap: 6, flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <FPspMiniViewer
              backendUrl={backendUrl}
              entry={entry}
              group={group} series={series} channel={channel}
              heightSignal={topHeight}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <FPspOverTimeGraph
              entry={entry}
              onSelectIdx={onSelectPoint}
              heightSignal={topHeight}
            />
          </div>
        </div>

        <div
          onMouseDown={onSplitMouseDown}
          style={{
            height: 6, cursor: 'row-resize', background: 'var(--border)',
            flexShrink: 0, position: 'relative',
          }}
          title="Drag to resize"
        >
          <div style={{
            position: 'absolute', left: '50%', top: 1,
            transform: 'translateX(-50%)',
            width: 40, height: 4, background: 'var(--text-muted)',
            borderRadius: 2, opacity: 0.5,
          }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <FPspTable
            entry={entry}
            onSelect={onSelectPoint}
          />
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function ParamRow({
  label, value, step, min, max, onChange,
}: {
  label: string; value: number; step: number; min?: number; max?: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange} />
    </label>
  )
}

// ----------------------------------------------------------------------
// Mini-viewer: zoomed waveform of the selected bin, with markers.
// ----------------------------------------------------------------------

function FPspMiniViewer({
  backendUrl, entry, group, series, channel, heightSignal,
}: {
  backendUrl: string
  entry: FPspData | undefined
  group: number; series: number; channel: number
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const selected: FPspPoint | null =
    entry && entry.selectedIdx != null && entry.selectedIdx < entry.points.length
      ? entry.points[entry.selectedIdx]
      : null

  const [data, setData] = useState<{ time: Float64Array; values: Float64Array } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Fetch the AVERAGED waveform for the bin's sweeps via the new
  // /api/fpsp/bin_waveform endpoint. The mini-viewer then shows exactly
  // the signal the baseline/volley/fEPSP/slope measurements were
  // computed on. Note: uses the point's sourceSeries (baseline or LTP).
  useEffect(() => {
    if (!selected || !backendUrl || !entry) { setData(null); return }
    // X window: from 0 to 2 × fEPSP end-cursor (so the event sits in the
    // left half and we show an equal chunk of tail after it).
    const tStart = 0
    const tEnd = Math.max(entry.fepspEndS * 2, entry.fepspEndS + 0.005)
    const qs = new URLSearchParams({
      group: String(group),
      series: String(selected.sourceSeries),
      trace: String(channel),
      sweeps: selected.sweepIndices.join(','),
      t_start: String(tStart),
      t_end: String(tEnd),
      max_points: '4000',
    })
    // Replay the same pre-detection filter used by the run so the mini-
    // viewer shows what the measurements were computed on.
    if (entry.filterEnabled) {
      qs.set('filter_enabled', 'true')
      qs.set('filter_type', entry.filterType)
      qs.set('filter_low', String(entry.filterLow))
      qs.set('filter_high', String(entry.filterHigh))
      qs.set('filter_order', String(entry.filterOrder))
    }
    let cancelled = false
    fetch(`${backendUrl}/api/fpsp/bin_waveform?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [selected, backendUrl, group, channel, entry])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0 || !selected) return

    // Y-axis range: the stim artifact dominates auto-scaling and buries
    // the actual volley/fEPSP deflections. Instead, center the y view on
    // the bin's baseline and size it to 2× the larger of volley/fEPSP
    // amplitudes — that zooms straight onto the event regardless of how
    // big the artifact is. Falls back to data bounds for edge cases.
    const sel = selected
    const maxAmp = Math.max(
      Math.abs(sel.volleyAmp),
      Math.abs(sel.fepspAmp),
    )
    // Y: 2 × max amplitude on each side of the baseline level.
    const yRange = (maxAmp > 0)
      ? [sel.baseline - 2 * maxAmp, sel.baseline + 2 * maxAmp] as [number, number]
      : null
    // X: 0 → 2 × fEPSP end-cursor, pinned so the stim artifact + event
    // fill the left half of the plot and are never clipped by auto-scale.
    const xRange: [number, number] = [
      0,
      Math.max(entry!.fepspEndS * 2, entry!.fepspEndS + 0.005),
    ]

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: {
        x: { time: false, range: () => xRange },
        y: yRange
          ? { range: () => yRange }
          : {},
      },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        { label: 'trace', stroke: cssVar('--trace-color-1'), width: 1.25 },
      ],
      hooks: {
        draw: [() => drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)],
      },
    }
    const payload: uPlot.AlignedData = [Array.from(data.time), Array.from(data.values)]
    plotRef.current = new uPlot(opts, payload, el)
    drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)
  }, [data, entry, selected])

  // Resize handling.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [selected != null])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      {!selected ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: 'var(--text-muted)', fontStyle: 'italic',
          fontSize: 'var(--font-size-label)',
        }}>
          Select a bin in the table to preview it here.
        </div>
      ) : (
        <>
          <div style={{
            padding: '3px 8px', fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span>bin #{(entry?.selectedIdx ?? 0) + 1}</span>
            <span>sweeps {selected.sweepIndices.map((s) => s + 1).join(',')}</span>
            <span>volley {selected.volleyAmp.toFixed(3)}</span>
            <span>fEPSP {selected.fepspAmp.toFixed(3)}</span>
            {selected.ratio != null && (
              <span style={{ color: selected.flagged ? '#e57373' : undefined }}>
                ratio {selected.ratio.toFixed(2)}
                {selected.flagged && ' ⚠'}
              </span>
            )}
            {selected.slope != null && <span>slope {selected.slope.toFixed(3)}</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <LegendDot color={MARKER.baseline} label="baseline" />
              <LegendDot color={MARKER.volley} label="volley" />
              <LegendDot color={MARKER.fepsp} label="fEPSP" />
              {entry?.measurementMethod !== 'amplitude' && (
                <LegendDot color={MARKER.slopeLo} label="slope %" />
              )}
            </span>
          </div>
          <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <canvas ref={overlayRef}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%' }} />
          </div>
          {err && (
            <div style={{ position: 'absolute', top: 30, left: 10, color: '#f44336', fontSize: 'var(--font-size-label)' }}>
              fetch: {err}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, border: '1px solid rgba(255,255,255,0.6)',
      }} />
      {label}
    </span>
  )
}

function drawMiniOverlay(
  u: uPlot | null,
  canvas: HTMLCanvasElement | null,
  entry: FPspData | undefined,
  selected: FPspPoint | null,
) {
  if (!u || !canvas || !selected || !entry) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr; canvas.height = cssH * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const toPx = (x: number, y: number): [number, number] => [
    u.valToPos(x, 'x', true) / dpr,
    u.valToPos(y, 'y', true) / dpr,
  ]

  const dot = (px: number, py: number, color: string) => {
    if (!isFinite(px) || !isFinite(py)) return
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke()
  }

  // Baseline level marker — midpoint of the baseline cursor window.
  const blTMid = (entry.baselineStartS + entry.baselineEndS) / 2
  {
    const [px, py] = toPx(blTMid, selected.baseline)
    dot(px, py, MARKER.baseline)
  }
  // Volley peak
  {
    const [px, py] = toPx(selected.volleyPeakTs, selected.volleyPeak)
    dot(px, py, MARKER.volley)
  }
  // fEPSP peak
  {
    const [px, py] = toPx(selected.fepspPeakTs, selected.fepspPeak)
    dot(px, py, MARKER.fepsp)
  }
  // Slope % crossings (two dots only, no fit line per user preference).
  if (selected.slopeLow) {
    const [px, py] = toPx(selected.slopeLow.t, selected.slopeLow.v)
    dot(px, py, MARKER.slopeLo)
  }
  if (selected.slopeHigh) {
    const [px, py] = toPx(selected.slopeHigh.t, selected.slopeHigh.v)
    dot(px, py, MARKER.slopeHi)
  }
}

// ----------------------------------------------------------------------
// Over-time graph: fEPSP slope/amplitude vs time (or bin index).
// ----------------------------------------------------------------------

function FPspOverTimeGraph({
  entry, onSelectIdx, heightSignal,
}: {
  entry: FPspData | undefined
  onSelectIdx: (idx: number) => void
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Decide what y-value to plot per point, and how to compute the x-axis
  // (real time from the .pgf's inter-sweep interval when available; bin
  // index otherwise). Series B (LTP) points get appended to the X axis
  // after series A's last point plus a visible gap, with a vertical
  // separator drawn in the plot's draw hook below.
  const { xs, ys, splitX, metricLabel, xLabel } = useMemo(() => {
    const empty = { xs: [] as number[], ys: [] as number[], splitX: null as number | null, metricLabel: '', xLabel: '' }
    if (!entry || entry.points.length === 0) return empty

    // Split points by source series, preserving per-series ordering.
    const a = entry.points.filter((p) => p.sourceSeries === entry.seriesA)
    const b = entry.seriesB != null
      ? entry.points.filter((p) => p.sourceSeries === entry.seriesB)
      : []

    const useTime = entry.timeAxis === 'timestamp'
    // In time mode, show minutes — LTP experiments run on the 10s-of-
    // minutes scale so seconds produce awkwardly large numbers.
    const toMin = (s: number) => s / 60

    // Per-series X in minutes from the start of that series (or raw bin
    // index in index mode).
    const xA = a.map((p) => (useTime && entry.sweepIntervalA > 0
      ? toMin(p.meanSweepIndex * entry.sweepIntervalA)
      : p.binIndex + 1))
    // Offset B so it follows A on the same axis.
    const lastA = xA.length > 0 ? xA[xA.length - 1] : 0
    // Visible gap between series: in time mode, max(1 min, 2×bin-interval);
    // in index mode, a single-step gap.
    const gap = useTime
      ? Math.max(1, toMin(2 * (entry.sweepIntervalA || 15) * entry.avgN))
      : 1
    const rawSplit = b.length > 0 ? (lastA + gap / 2) : null
    const xB = b.map((p) => (useTime && entry.sweepIntervalB > 0
      ? toMin(p.meanSweepIndex * entry.sweepIntervalB) + lastA + gap
      : p.binIndex + 1 + lastA + gap))

    // Re-origin the x axis so the tetanus (splitX) is at 0 — baseline
    // points sit at negative x, LTP points at positive x. That's the
    // conventional way to display LTP time courses. Only applied when
    // there's actually a seriesB (otherwise there's no tetanus).
    let splitX: number | null = rawSplit
    if (rawSplit != null) {
      for (let i = 0; i < xA.length; i++) xA[i] -= rawSplit
      for (let i = 0; i < xB.length; i++) xB[i] -= rawSplit
      splitX = 0
    }

    const yOf = (p: FPspPoint) =>
      entry.measurementMethod === 'amplitude' ? p.fepspAmp : (p.slope ?? 0)
    const rawYs = [...a.map(yOf), ...b.map(yOf)]
    const xs = [...xA, ...xB]

    // Normalization: the denominator is the mean of the chosen metric
    // (slope or amplitude) across ALL baseline-series (series A)
    // averaged-sweep points. Each point — baseline AND LTP — is then
    // expressed as % of that common mean, so the LTP-induced change
    // reads as a deviation from the flat 100 % baseline.
    let finalYs: number[]
    if (entry.normalize) {
      const baselineYs = a.map(yOf)
      const mean = baselineYs.length > 0
        ? baselineYs.reduce((s, v) => s + v, 0) / baselineYs.length
        : 0
      finalYs = Math.abs(mean) > 1e-12
        ? rawYs.map((y) => 100 * (y / mean))
        : rawYs.slice()
    } else {
      finalYs = rawYs.slice()
    }

    const yUnit = entry.measurementMethod === 'amplitude'
      ? entry.responseUnit
      : `${entry.responseUnit || '?'}/s`
    const metricLabel = entry.measurementMethod === 'amplitude'
      ? `fEPSP amplitude${entry.normalize ? ' (% of baseline)' : ` (${yUnit})`}`
      : `fEPSP slope${entry.normalize ? ' (% of baseline)' : ` (${yUnit})`}`

    const xLabel = useTime
      ? (entry.sweepIntervalA > 0 ? 'Time (min)' : 'Sweep index (≈ time)')
      : 'Bin #'

    return { xs, ys: finalYs, splitX, metricLabel, xLabel }
    // Deliberately NOT depending on `entry` as a whole. selectedIdx changes
    // produce a new entry object but the same `points` reference — so
    // listing individual fields keeps the memo stable across selection
    // clicks, avoiding a full plot-destroy/rebuild cycle (which was
    // flashing the graph blank when the user clicked a table row).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry?.points,
    entry?.seriesA,
    entry?.seriesB,
    entry?.timeAxis,
    entry?.sweepIntervalA,
    entry?.sweepIntervalB,
    entry?.measurementMethod,
    entry?.responseUnit,
    entry?.normalize,
    entry?.normBaselineFrom,
    entry?.normBaselineTo,
    entry?.avgN,
  ])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (xs.length === 0) return

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: { x: { time: false }, y: {} },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: xLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: metricLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          label: metricLabel,
          stroke: cssVar('--trace-color-1'),
          width: 1.5,
          points: { size: 5, stroke: cssVar('--trace-color-1'), fill: cssVar('--bg-surface') },
        },
      ],
      hooks: {
        init: [(u) => {
          u.over.addEventListener('click', () => {
            const idx = u.cursor.idx
            if (idx != null && idx >= 0) onSelectIdx(idx as number)
          })
        }],
        draw: [
          (u) => drawSeriesSplit(u, splitX),
          (u) => drawGraphSelected(u, selectedRef.current),
        ],
      },
    }
    plotRef.current = new uPlot(opts, [xs, ys], el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xs, ys, splitX, metricLabel, xLabel])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  useEffect(() => { plotRef.current?.redraw() }, [entry?.selectedIdx])

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No points yet.' : 'Run to populate the over-time graph.'}
      </div>
    )
  }

  return (
    <div style={{
      height: '100%',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawSeriesSplit(u: uPlot, splitX: number | null) {
  if (splitX == null) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(splitX, 'x', true) / dpr
  if (!isFinite(px)) return
  const ctx = u.ctx
  const top = u.bbox.top / dpr
  const bottom = (u.bbox.top + u.bbox.height) / dpr
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.strokeStyle = 'rgba(229,115,115,0.6)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(px, top)
  ctx.lineTo(px, bottom)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(229,115,115,0.85)'
  ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`
  ctx.fillText('tetanus', px + 4, top + 12)
  ctx.restore()
}

function drawGraphSelected(u: uPlot, selectedIdx: number | null) {
  if (selectedIdx == null) return
  const xArr = u.data[0] as number[]
  const yArr = u.data[1] as (number | null)[]
  if (selectedIdx < 0 || selectedIdx >= xArr.length) return
  const x = xArr[selectedIdx], y = yArr[selectedIdx]
  if (y == null || !isFinite(x) || !isFinite(y)) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(x, 'x', true) / dpr
  const py = u.valToPos(y, 'y', true) / dpr
  const ctx = u.ctx
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.arc(px, py, 7, 0, Math.PI * 2)
  ctx.fillStyle = cssVar('--accent')
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.fill(); ctx.stroke()
  ctx.restore()
}

// ----------------------------------------------------------------------
// Table
// ----------------------------------------------------------------------

function FPspTable({
  entry, onSelect,
}: {
  entry: FPspData | undefined
  onSelect: (idx: number) => void
}) {
  if (!entry || entry.points.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
      }}>
        {entry ? 'No bins.' : 'Run to populate the table.'}
      </div>
    )
  }

  const u = entry.responseUnit || ''

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%',
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Series</Th>
            <Th>Sweeps</Th>
            <Th>Baseline ({u})</Th>
            <Th>Volley amp ({u})</Th>
            <Th>fEPSP amp ({u})</Th>
            <Th>Ratio</Th>
            <Th>Slope / Amp</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const isLtp = entry.seriesB != null && p.sourceSeries === entry.seriesB
            const selectedBg = i === entry.selectedIdx
              ? 'var(--bg-selected, rgba(100,181,246,0.2))'
              : undefined
            const flaggedBg = p.flagged ? 'rgba(229,115,115,0.12)' : undefined
            const ltpBg = isLtp ? 'rgba(255,183,77,0.08)' : undefined
            return (
              <tr
                key={i}
                onClick={() => onSelect(i)}
                style={{
                  background: selectedBg ?? flaggedBg ?? ltpBg ?? 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td style={{ color: isLtp ? '#ffb74d' : 'var(--text-muted)' }}>
                  {isLtp ? 'LTP' : 'BL'} ({p.sourceSeries + 1})
                </Td>
                <Td>{p.sweepIndices.map((s) => s + 1).join(',')}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.volleyAmp.toFixed(3)}</Td>
                <Td>{p.fepspAmp.toFixed(3)}</Td>
                <Td style={p.flagged ? { color: '#e57373', fontWeight: 600 } : undefined}>
                  {p.ratio != null ? p.ratio.toFixed(2) : '—'}
                  {p.flagged && ' ⚠'}
                </Td>
                <Td>
                  {entry.measurementMethod === 'amplitude'
                    ? p.fepspAmp.toFixed(3)
                    : (p.slope != null ? p.slope.toFixed(3) : '—')}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)
