import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, IVCurveData, IVResponseMetric, CursorPositions } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'

const BASELINE_COLOR_VAR = '--cursor-baseline'
const PEAK_COLOR_VAR = '--cursor-peak'

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

export function IVCurveWindow({
  backendUrl,
  fileInfo,
  currentSweep,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    ivCurves,
    runIVCurve, clearIVCurve, selectIVPoint, setIVResponseMetric, exportIVCSV,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // Selections. Preselect from main window on first mount.
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
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

  // Reset group/series bounds when file changes.
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

  const key = `${group}:${series}`
  const entry = ivCurves[key]

  // Mode + per-sweep range controls. "all" runs every sweep; "range" runs a
  // user-picked half-open [from, to] range; "one" runs just one sweep and
  // appends to the existing table.
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  // When series changes, reset the range to the full series.
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // ---- Manual Im fallback (when the stimulus trace isn't recorded) ----
  const [manualImEnabled, setManualImEnabled] = useState(false)
  const [manualImStartS, setManualImStartS] = useState(0.1)
  const [manualImEndS, setManualImEndS] = useState(0.6)
  const [manualImStartPA, setManualImStartPA] = useState(-100)
  const [manualImStepPA, setManualImStepPA] = useState(20)

  // ---- Mini-viewer state ----
  const [previewSweep, setPreviewSweep] = useState(currentSweep)
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [traceUnits, setTraceUnits] = useState<string>('')
  // Per-window zero-offset toggle for the mini-viewer.
  const [zeroOffset, setZeroOffset] = useState(false)
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])
  // Clamp preview sweep to [0, totalSweeps) whenever the series changes.
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [group, series, totalSweeps])
  // Fetch the preview sweep whenever it changes.
  useEffect(() => {
    if (!backendUrl || totalSweeps === 0) { setTraceTime(null); setTraceValues(null); return }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(group), series: String(series),
      sweep: String(previewSweep), trace: String(channel),
      max_points: '0',
    })
    if (zeroOffset) qs.set('zero_offset', 'true')
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        setTraceTime(d.time ?? [])
        setTraceValues(d.values ?? [])
        setTraceUnits(d.units ?? '')
      })
      .catch(() => { if (!cancelled) { setTraceTime(null); setTraceValues(null) } })
    return () => { cancelled = true }
  }, [backendUrl, group, series, channel, previewSweep, totalSweeps, zeroOffset])

  // Cursor changes from drag → push up to the main store AND broadcast
  // so the main trace viewer's bands move in lockstep.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    useAppStore.getState().setCursors(next)
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [])

  // Exclusion badge for the preview sweep.
  const isPreviewExcluded = useAppStore((s) => s.isSweepExcluded(group, series, previewSweep))

  // Splitter between plot and table.
  const [plotHeight, setPlotHeight] = useState(340)
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      setPlotHeight(Math.max(150, Math.min(800, startH + dy)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onRun = () => {
    // Build the sweep selection based on mode. Backend accepts an optional
    // array of sweep indices; absent = run all.
    let sweepIndices: number[] | null = null
    let appendToExisting = false
    const store = useAppStore.getState()
    if (runMode === 'all') {
      const included = store.includedSweepsFor(group, series, totalSweeps)
      if (included.length !== totalSweeps) sweepIndices = included
    } else if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      const range: number[] = []
      for (let i = lo - 1; i <= hi - 1; i++) range.push(i)
      sweepIndices = store.filterExcludedSweeps(group, series, range)
    } else if (runMode === 'one') {
      const sw = Math.max(1, Math.min(sweepOne, totalSweeps))
      sweepIndices = [sw - 1]
      appendToExisting = true
    }
    // Pull the windows from the main-window cursors (now also
    // draggable inside the mini-viewer below). baseline = baseline
    // cursor, peak/SS = peak cursor.
    runIVCurve(group, series, channel, {
      baselineStartS: cursors.baselineStart,
      baselineEndS: cursors.baselineEnd,
      peakStartS: cursors.peakStart,
      peakEndS: cursors.peakEnd,
      sweepIndices,
      appendToExisting,
      manualImEnabled,
      manualImStartS,
      manualImEndS,
      manualImStartPA,
      manualImStepPA,
    })
  }
  const onSelectRow = (idx: number) => {
    selectIVPoint(group, series, idx)
    // Jump the main viewer to the sweep this point belongs to.
    const p = entry?.points[idx]
    if (p != null) {
      try {
        const ch = new BroadcastChannel('neurotrace-sync')
        ch.postMessage({ type: 'sweep-update', sweep: p.sweepIndex })
        ch.close()
      } catch { /* ignore */ }
    }
  }

  const metric: IVResponseMetric = entry?.responseMetric ?? 'steady'
  const onMetricChange = (m: IVResponseMetric) => {
    if (!entry) return
    setIVResponseMetric(group, series, m)
  }

  // Linear fit over the current (stim, response) points. Slope = dV/dI for
  // VC data → in that case it's the INVERSE of input resistance (dI/dV),
  // since stim is mV and response is pA: R = 1 / slope × 1000 (to get MΩ).
  // For CC data (stim = pA, response = mV), the slope itself IS R in GΩ
  // (mV / pA = GΩ), which we convert to MΩ via ×1000.
  const fit = useMemo(() => {
    if (!entry || entry.points.length < 2) return null
    const xs: number[] = []
    const ys: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const r = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(r)
    }
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx
      num += dx * (ys[i] - my)
      den += dx * dx
    }
    if (den === 0) return null
    const slope = num / den
    const intercept = my - slope * mx
    // R² for quick sanity.
    let ssRes = 0
    let ssTot = 0
    for (let i = 0; i < n; i++) {
      const yHat = slope * xs[i] + intercept
      ssRes += (ys[i] - yHat) ** 2
      ssTot += (ys[i] - my) ** 2
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1
    // Input resistance interpretation:
    //   VC: stim mV, response pA  → slope (pA/mV) → R = 1000 / slope  [MΩ]
    //   CC: stim pA, response mV  → slope (mV/pA) → R = slope × 1000  [MΩ]
    //   otherwise — not meaningful.
    let rInMOhm: number | null = null
    const stimU = entry.stimUnit.toLowerCase()
    const respU = entry.responseUnit.toLowerCase()
    if (stimU === 'mv' && respU === 'pa' && slope !== 0) {
      rInMOhm = 1000 / slope  // signed; take abs in UI
    } else if (stimU === 'pa' && respU === 'mv') {
      rInMOhm = slope * 1000
    }
    return { slope, intercept, r2, rInMOhm }
  }, [entry])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Top bar: selectors */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
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

        {/* Sweep navigator — kept at the top of every analysis window
            next to the selectors so users don't hunt for it. */}
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.max(0, s - 1))}
              disabled={previewSweep <= 0 || totalSweeps === 0}
              title="Previous sweep">←</button>
            <span style={{ minWidth: 58, textAlign: 'center', fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
              {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))}
              disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0}
              title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Cursor windows (mirrored from the main viewer, read-only here) +
          response-metric dropdown. Drag the cursor bands on the main
          trace to change the measurement windows. */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        padding: 8,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span style={{
          color: 'var(--cursor-baseline)',
          fontWeight: 600,
        }}>
          Baseline:
        </span>
        <span>{cursors.baselineStart.toFixed(4)}s → {cursors.baselineEnd.toFixed(4)}s</span>
        <span style={{
          color: 'var(--cursor-peak)',
          fontWeight: 600,
        }}>
          Peak / SS:
        </span>
        <span>{cursors.peakStart.toFixed(4)}s → {cursors.peakEnd.toFixed(4)}s</span>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
          fontFamily: 'var(--font-ui)',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Y metric:</span>
          <select
            value={metric}
            onChange={(e) => onMetricChange(e.target.value as IVResponseMetric)}
            disabled={!entry}
            title="Steady-state = mean of the peak-cursor window. Transient peak = most-deviant sample within the peak-cursor window."
          >
            <option value="steady">Steady-state (mean)</option>
            <option value="peak">Transient peak</option>
          </select>
        </label>
      </div>

      {/* Manual Im fallback — for recordings where the stimulus trace
          wasn't saved. When enabled, bypasses the .pgf lookup and
          reconstructs Im per sweep from start_pA + sweep_index * step_pA. */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        fontSize: 'var(--font-size-label)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Use this when the stimulus channel wasn't recorded or the .pgf doesn't expose Im">
          <input type="checkbox" checked={manualImEnabled}
            onChange={(e) => setManualImEnabled(e.target.checked)} />
          <span style={{ fontWeight: 600 }}>Manual Im</span>
        </label>
        {manualImEnabled ? (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ color: 'var(--text-muted)' }}>start</span>
              <NumInput value={manualImStartS} step={0.01}
                onChange={setManualImStartS} style={{ width: 64 }} />
              <span style={{ color: 'var(--text-muted)' }}>s</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ color: 'var(--text-muted)' }}>end</span>
              <NumInput value={manualImEndS} step={0.01}
                onChange={setManualImEndS} style={{ width: 64 }} />
              <span style={{ color: 'var(--text-muted)' }}>s</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ color: 'var(--text-muted)' }}>start Im</span>
              <NumInput value={manualImStartPA} step={1}
                onChange={setManualImStartPA} style={{ width: 68 }} />
              <span style={{ color: 'var(--text-muted)' }}>pA</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ color: 'var(--text-muted)' }}>step</span>
              <NumInput value={manualImStepPA} step={1}
                onChange={setManualImStepPA} style={{ width: 60 }} />
              <span style={{ color: 'var(--text-muted)' }}>pA</span>
            </label>
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginLeft: 'auto' }}>
              Im(sweep n) = startPA + n · stepPA
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            off — Im is read from the stimulus trace. Turn on if the stimulus isn't recorded.
          </span>
        )}
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
          <input type="radio" name="iv-run-mode" value="all"
            checked={runMode === 'all'}
            onChange={() => setRunMode('all')} />
          all sweeps
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="iv-run-mode" value="range"
            checked={runMode === 'range'}
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
          <input type="radio" name="iv-run-mode" value="one"
            checked={runMode === 'one'}
            onChange={() => setRunMode('one')} />
          single sweep
        </label>
        {runMode === 'one' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
              {' · appends to table'}
            </span>
          </span>
        )}

        <button
          className="btn btn-primary"
          onClick={onRun}
          disabled={loading || !fileInfo}
          style={{ marginLeft: 8 }}
        >
          {loading ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={() => clearIVCurve(group, series)} disabled={!entry}>
          Clear
        </button>
        <button
          className="btn"
          onClick={() => exportIVCSV()}
          disabled={Object.keys(ivCurves).length === 0}
          style={{ marginLeft: 'auto' }}
        >
          Export CSV
        </button>
      </div>

      {error && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-error, #5c1b1b)',
          color: '#fff',
          borderRadius: 3,
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 'var(--font-size-xs)',
        }}>
          <span style={{ flex: 1 }}>⚠ {error}</span>
          <button className="btn" onClick={() => setError(null)}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>dismiss</button>
        </div>
      )}

      {/* Summary — left: point count / pulse window / units; right: slope
          of the linear fit to the I-V curve (input resistance). The fit
          updates as points accumulate across Run invocations. */}
      {entry && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--bg-primary)',
          padding: '4px 8px',
          borderRadius: 3,
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span>
            <strong style={{ color: 'var(--text-primary)' }}>{entry.points.length}</strong> points ·
            windows BL {entry.baselineStartS.toFixed(3)}→{entry.baselineEndS.toFixed(3)}s ·
            PK {entry.peakStartS.toFixed(3)}→{entry.peakEndS.toFixed(3)}s ·
            stim {entry.stimUnit || '—'} · response {entry.responseUnit || '—'}
          </span>
          {fit && (
            <span style={{
              marginLeft: 'auto',
              color: 'var(--text-primary)',
              display: 'flex',
              gap: 12,
            }}>
              <span title="Slope of the linear fit to the I-V points">
                slope = {formatSlope(fit.slope, entry)} · R² = {fit.r2.toFixed(3)}
              </span>
              {fit.rInMOhm != null && (
                <span
                  style={{ color: 'var(--accent)', fontWeight: 600 }}
                  title="Input resistance derived from the I-V slope"
                >
                  Rin = {Math.abs(fit.rInMOhm).toFixed(1)} MΩ
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Mini-viewer + tabbed results split */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        <div style={{ height: plotHeight, minHeight: 160, flexShrink: 0 }}>
          <TraceMiniViewer
            traceTime={traceTime}
            traceValues={traceValues}
            traceUnits={traceUnits}
            cursors={cursors}
            updateCursors={updateCursors}
            previewSweep={previewSweep}
            totalSweeps={totalSweeps}
            isExcluded={isPreviewExcluded}
            onRunPreview={() => {
              runIVCurve(group, series, channel, {
                baselineStartS: cursors.baselineStart,
                baselineEndS: cursors.baselineEnd,
                peakStartS: cursors.peakStart,
                peakEndS: cursors.peakEnd,
                sweepIndices: [previewSweep],
                appendToExisting: true,
                manualImEnabled,
                manualImStartS,
                manualImEndS,
                manualImStartPA,
                manualImStepPA,
              })
            }}
            loading={loading}
            theme={theme}
            fontSize={fontSize}
            zeroOffset={zeroOffset}
            onZeroOffsetChange={setZeroOffset}
            resetCursorsInView={(xMin, xMax) => {
              const span = xMax - xMin
              updateCursors({
                baselineStart: xMin + 0.05 * span,
                baselineEnd: xMin + 0.20 * span,
                peakStart: xMin + 0.35 * span,
                peakEnd: xMin + 0.65 * span,
              })
            }}
          />
        </div>

        <div
          onMouseDown={onSplitterMouseDown}
          style={{
            height: 6,
            cursor: 'row-resize',
            background: 'var(--border)',
            flexShrink: 0,
            position: 'relative',
          }}
          title="Drag to resize"
        >
          <div style={{
            position: 'absolute', left: '50%', top: 1,
            transform: 'translateX(-50%)',
            width: 40, height: 4,
            background: 'var(--text-muted)',
            borderRadius: 2, opacity: 0.5,
          }} />
        </div>

        {/* Bottom tab strip: I-V curve / Table */}
        <ResultsTabs
          entry={entry}
          fit={fit}
          onSelectRow={onSelectRow}
        />
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------

function formatSlope(slope: number, entry: IVCurveData): string {
  const u = `${entry.responseUnit || '?'}/${entry.stimUnit || '?'}`
  return `${slope.toFixed(4)} ${u}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function IVPlot({
  entry, heightSignal, onSelectIdx, fit,
}: {
  entry: IVCurveData | undefined
  heightSignal: number
  onSelectIdx: (idx: number) => void
  fit: { slope: number; intercept: number; r2: number; rInMOhm: number | null } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Build data arrays from the points, sorted by stim level.
  // If a fit is available, also emit the regression line evaluated at the
  // x-extremes — added as a second uPlot series.
  const { xs, ys, yFit, sweepByIdx } = useMemo(() => {
    if (!entry || entry.points.length === 0) {
      return {
        xs: [] as number[], ys: [] as number[],
        yFit: [] as (number | null)[], sweepByIdx: [] as number[],
      }
    }
    const xs: number[] = []
    const ys: number[] = []
    const sweepByIdx: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(resp)
      sweepByIdx.push(p.sweepIndex)
    }
    const yFit: (number | null)[] = fit
      ? xs.map((x) => fit.slope * x + fit.intercept)
      : xs.map(() => null)
    return { xs, ys, yFit, sweepByIdx }
  }, [entry, fit])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!entry || xs.length === 0) return

    const xLabel = `Stim${entry.stimUnit ? ` (${entry.stimUnit})` : ''}`
    const yLabel = `Response Δ${entry.responseUnit ? ` (${entry.responseUnit})` : ''}`
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: {
        x: { time: false },
        y: {
          range: (_u, dMin, dMax) => {
            // Pad the range and include zero so reversal is visible.
            const lo = Math.min(0, dMin)
            const hi = Math.max(0, dMax)
            const pad = (hi - lo) * 0.1 || 1
            return [lo - pad, hi + pad]
          },
        },
      },
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
          label: yLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          label: 'I-V',
          stroke: cssVar('--trace-color-1'),
          width: 1.5,
          points: { size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--bg-surface') },
        },
        {
          label: 'fit',
          stroke: cssVar('--accent'),
          width: 1,
          dash: [4, 4],
          points: { show: false },
        },
      ],
      hooks: {
        // Click anywhere: find the nearest data point, select it.
        init: [(u) => {
          u.over.addEventListener('click', () => {
            const idx = u.cursor.idx
            if (idx != null && idx >= 0) onSelectIdx(idx as number)
          })
        }],
        draw: [(u) => drawSelectedMarker(u, selectedRef.current)],
      },
    }
    plotRef.current = new uPlot(opts, [xs, ys, yFit as any], el)

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
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.points, entry?.responseMetric, entry?.stimUnit, entry?.responseUnit])

  // Re-fit size synchronously on splitter drag.
  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  // Redraw to update the selected-marker highlight.
  useEffect(() => {
    plotRef.current?.redraw()
  }, [entry?.selectedIdx])

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No I-V points for this series.' : 'Click Run to compute the I-V for this series.'}
      </div>
    )
  }

  void sweepByIdx  // kept for potential future use
  return (
    <div style={{
      height: '100%',
      border: '1px solid var(--border)',
      borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawSelectedMarker(u: uPlot, selectedIdx: number | null) {
  if (selectedIdx == null) return
  const xArr = u.data[0] as number[]
  const yArr = u.data[1] as (number | null)[]
  if (selectedIdx < 0 || selectedIdx >= xArr.length) return
  const x = xArr[selectedIdx]
  const y = yArr[selectedIdx]
  if (y == null || !isFinite(x) || !isFinite(y)) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(x, 'x', true) / dpr
  const py = u.valToPos(y, 'y', true) / dpr
  const ctx = u.ctx
  // Draw in CSS pixels.
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.arc(px, py, 8, 0, Math.PI * 2)
  ctx.fillStyle = cssVar('--accent')
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function IVTable({
  entry, onSelect,
}: {
  entry: IVCurveData | undefined
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
        {entry ? 'No I-V points.' : 'Click Run to populate the table.'}
      </div>
    )
  }

  const stimUnit = entry.stimUnit || ''
  const respUnit = entry.responseUnit || ''

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
            <Th>Sweep</Th>
            <Th>Stim ({stimUnit})</Th>
            <Th>Baseline ({respUnit})</Th>
            <Th>Steady-state ({respUnit})</Th>
            <Th>Transient peak ({respUnit})</Th>
            <Th>Response ({respUnit})</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
            return (
              <tr
                key={i}
                onClick={() => onSelect(i)}
                style={{
                  background: i === entry.selectedIdx ? 'var(--bg-selected, rgba(100,181,246,0.2))' : 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td>{p.sweepIndex + 1}</Td>
                <Td>{p.stimLevel.toFixed(2)}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.steadyState.toFixed(3)}</Td>
                <Td>{p.transientPeak.toFixed(3)}</Td>
                <Td><strong>{resp.toFixed(3)}</strong></Td>
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
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{children}</td>
)

// ---------------------------------------------------------------------------
// TraceMiniViewer — fetches and displays one sweep's trace with draggable
// Baseline (green) and Peak (blue) cursor bands. Wheel/pan/Reset locked-
// zoom pattern mirrors the Cursor and Resistance windows.
// ---------------------------------------------------------------------------

function TraceMiniViewer({
  traceTime, traceValues, traceUnits,
  cursors, updateCursors,
  previewSweep, totalSweeps, isExcluded,
  onRunPreview, loading,
  theme, fontSize,
  zeroOffset, onZeroOffsetChange,
  resetCursorsInView,
}: {
  traceTime: number[] | null
  traceValues: number[] | null
  traceUnits: string
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  previewSweep: number
  totalSweeps: number
  isExcluded: boolean
  onRunPreview: () => void
  loading: boolean
  theme: string
  fontSize: number
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  /** Parent-supplied "put the cursor bands back on screen" action.
   *  Called with the CURRENT visible X range so the parent can drop
   *  each cursor pair to a sensible position inside that window. */
  resetCursorsInView: (xMin: number, xMax: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // Keep the latest cursors reachable from hook closures.
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Refs that back the uPlot scale range functions — locked-zoom pattern.
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const hasRealDataRef = useRef(false)

  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'peak-edge'; edge: 'start' | 'end' }
    | { kind: 'peak-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'pan'; startX: number; xMin: number; xMax: number; startY: number; yMin: number; yMax: number }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = plotRef.current
    if (!u) return
    xRangeRef.current = null
    yRangeRef.current = null
    const d = u.data as unknown as [number[], number[]] | undefined
    if (!d || !d[0] || d[0].length === 0) { u.redraw(); return }
    const xs = d[0], ys = d[1]
    const xmin = xs[0], xmax = xs[xs.length - 1]
    let ymin = Infinity, ymax = -Infinity
    for (const v of ys) { if (v < ymin) ymin = v; if (v > ymax) ymax = v }
    if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) u.setScale('x', { min: xmin, max: xmax })
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  const drawOverlays = (u: uPlot) => {
    const cur = cursorsRef.current
    const ctx = u.ctx
    const yTop = u.bbox.top
    const yBot = u.bbox.top + u.bbox.height
    const drawBand = (xs: number, xe: number, colorVar: string, label: string) => {
      const px0 = u.valToPos(xs, 'x', true)
      const px1 = u.valToPos(xe, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = cssVar(colorVar) || '#888'
      ctx.fillRect(Math.min(px0, px1), yTop, Math.abs(px1 - px0), yBot - yTop)
      ctx.globalAlpha = 1
      ctx.fillStyle = cssVar(colorVar) || '#888'
      const dpr = devicePixelRatio || 1
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, yTop + 12 * dpr)
      ctx.restore()
    }
    drawBand(cur.baselineStart, cur.baselineEnd, BASELINE_COLOR_VAR, 'BL')
    drawBand(cur.peakStart, cur.peakEnd, PEAK_COLOR_VAR, 'PK/SS')
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !traceTime || !traceValues) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frameId = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)
      hasRealDataRef.current = true
      const opts: uPlot.Options = {
        width: w, height: h,
        scales: {
          x: {
            time: false,
            range: (_u, dataMin, dataMax) => {
              if (xRangeRef.current) return xRangeRef.current
              const lo = isFinite(dataMin) ? dataMin : 0
              const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
              const r: [number, number] = [lo, hi]
              if (hasRealDataRef.current) xRangeRef.current = r
              return r
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              if (yRangeRef.current) return yRangeRef.current
              let r: [number, number]
              if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) r = [0, 1]
              else {
                const pad = (dataMax - dataMin) * 0.05
                r = [dataMin - pad, dataMax + pad]
              }
              if (hasRealDataRef.current) yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: traceUnits || '', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { label: 'Trace', stroke: cssVar('--trace-color-1'), width: 1.25, points: { show: false } },
        ],
        hooks: { draw: [(u) => drawOverlays(u)] },
      }
      plotRef.current = new uPlot(opts, [traceTime, traceValues], container)

      const u = plotRef.current
      const over = container.querySelector<HTMLDivElement>('.u-over')
      const EDGE_THRESHOLD_PX = 6

      const xToPx = (x: number) => u.valToPos(x, 'x', false)
      const pxToX = (px: number) => u.posToVal(px, 'x')
      const pxToY = (py: number) => u.posToVal(py, 'y')

      const findHit = (pxX: number): DragTarget | null => {
        const cur = cursorsRef.current
        const pairs: Array<{
          start: number; end: number
          edge: (e: 'start' | 'end') => DragTarget
          band: (startPxX: number) => DragTarget
        }> = [
          {
            start: cur.baselineStart, end: cur.baselineEnd,
            edge: (e) => ({ kind: 'baseline-edge', edge: e }),
            band: (startPxX) => ({
              kind: 'baseline-band', startPxX,
              startStart: cur.baselineStart, startEnd: cur.baselineEnd,
            }),
          },
          {
            start: cur.peakStart, end: cur.peakEnd,
            edge: (e) => ({ kind: 'peak-edge', edge: e }),
            band: (startPxX) => ({
              kind: 'peak-band', startPxX,
              startStart: cur.peakStart, startEnd: cur.peakEnd,
            }),
          },
        ]
        let best: { dist: number; target: DragTarget } | null = null
        for (const r of pairs) {
          const ds = Math.abs(xToPx(r.start) - pxX)
          const de = Math.abs(xToPx(r.end) - pxX)
          if (ds < EDGE_THRESHOLD_PX && (!best || ds < best.dist)) best = { dist: ds, target: r.edge('start') }
          if (de < EDGE_THRESHOLD_PX && (!best || de < best.dist)) best = { dist: de, target: r.edge('end') }
        }
        if (best) return best.target
        for (let i = pairs.length - 1; i >= 0; i--) {
          const r = pairs[i]
          const p0 = xToPx(r.start), p1 = xToPx(r.end)
          const lo = Math.min(p0, p1), hi = Math.max(p0, p1)
          if (pxX > lo && pxX < hi) return r.band(pxX)
        }
        return null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (!over) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const hit = findHit(pxX)
        if (hit) dragRef.current = hit
        else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (xMin == null || xMax == null || yMin == null || yMax == null) return
          dragRef.current = {
            kind: 'pan', startX: pxX, xMin, xMax,
            startY: ev.clientY - rect.top, yMin, yMax,
          }
        }
        over.setPointerCapture(ev.pointerId)
        ev.preventDefault()
      }

      const onPointerMove = (ev: PointerEvent) => {
        if (!over) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const t = dragRef.current
        if (!t) {
          const hit = findHit(pxX)
          over.style.cursor = !hit ? 'grab'
            : (hit.kind === 'baseline-edge' || hit.kind === 'peak-edge') ? 'ew-resize' : 'move'
          return
        }
        if (t.kind === 'pan') {
          const x = pxToX(pxX)
          const x0 = u.posToVal(t.startX, 'x')
          const y = pxToY(pxY)
          const y0 = u.posToVal(t.startY, 'y')
          const dx = x - x0, dy = y - y0
          xRangeRef.current = [t.xMin - dx, t.xMax - dx]
          yRangeRef.current = [t.yMin - dy, t.yMax - dy]
          u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
          u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
          over.style.cursor = 'grabbing'
          return
        }
        const x = pxToX(pxX)
        const shift = (pxStart: number) => pxToX(pxX) - pxToX(pxStart)
        switch (t.kind) {
          case 'baseline-edge':
            updateCursors({ [t.edge === 'start' ? 'baselineStart' : 'baselineEnd']: x } as Partial<CursorPositions>)
            break
          case 'baseline-band': {
            const dx = shift(t.startPxX)
            updateCursors({ baselineStart: t.startStart + dx, baselineEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
          case 'peak-edge':
            updateCursors({ [t.edge === 'start' ? 'peakStart' : 'peakEnd']: x } as Partial<CursorPositions>)
            break
          case 'peak-band': {
            const dx = shift(t.startPxX)
            updateCursors({ peakStart: t.startStart + dx, peakEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
        }
      }

      const onPointerUp = (ev: PointerEvent) => {
        if (dragRef.current && over) {
          dragRef.current = null
          try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          over.style.cursor = ''
        }
      }

      const onWheel = (ev: WheelEvent) => {
        if (!over) return
        ev.preventDefault()
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        if (ev.altKey) {
          const yAtCur = u.posToVal(pxY, 'y')
          yRangeRef.current = [
            yAtCur - (yAtCur - yMin) * factor,
            yAtCur + (yMax - yAtCur) * factor,
          ]
          xRangeRef.current = [xMin, xMax]
        } else {
          const xAtCur = u.posToVal(pxX, 'x')
          xRangeRef.current = [
            xAtCur - (xAtCur - xMin) * factor,
            xAtCur + (xMax - xAtCur) * factor,
          ]
          yRangeRef.current = [yMin, yMax]
        }
        u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
        u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
      }

      if (over) {
        over.addEventListener('pointerdown', onPointerDown)
        over.addEventListener('pointermove', onPointerMove)
        over.addEventListener('pointerup', onPointerUp)
        over.addEventListener('pointercancel', onPointerUp)
        over.addEventListener('wheel', onWheel, { passive: false })
      }
      ;(plotRef.current as any)._teardownIV = () => {
        if (over) {
          over.removeEventListener('pointerdown', onPointerDown)
          over.removeEventListener('pointermove', onPointerMove)
          over.removeEventListener('pointerup', onPointerUp)
          over.removeEventListener('pointercancel', onPointerUp)
          over.removeEventListener('wheel', onWheel)
        }
      }
    })
    return () => {
      cancelAnimationFrame(frameId)
      const teardown = (plotRef.current as any)?._teardownIV
      if (teardown) teardown()
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues])

  // Redraw bands on cursor / theme changes.
  useEffect(() => { plotRef.current?.redraw() }, [cursors])
  useEffect(() => { plotRef.current?.redraw() }, [theme, fontSize])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0)
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)', background: 'var(--bg-secondary)',
        display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {/* Sweep arrows moved to the top-of-window selector row. Only
            the single-sweep Run button stays in the viewer header. */}
        <span style={{ minWidth: 58, textAlign: 'center' }}>
          Sweep {totalSweeps > 0 ? previewSweep + 1 : '—'}
        </span>
        <button className="btn btn-primary"
          onClick={onRunPreview} disabled={loading || totalSweeps === 0}
          style={{ marginLeft: 6 }}
          title="Run I-V on this sweep and append the point to the table">
          Run sweep {previewSweep + 1}
        </button>
        {isExcluded && (
          <span style={{
            fontSize: 'var(--font-size-label)', fontWeight: 600,
            color: '#fff', background: '#e65100',
            padding: '1px 6px', borderRadius: 3,
          }}>⊘ Excluded</span>
        )}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 3,
          fontSize: 'var(--font-size-label)', marginLeft: 'auto',
        }} title="Subtract a baseline computed from the first ~3 ms of each sweep">
          <input type="checkbox" checked={zeroOffset}
            onChange={(e) => onZeroOffsetChange(e.target.checked)} />
          Zero offset
        </label>
        <button className="btn"
          onClick={() => {
            const u = plotRef.current
            let xMin: number | null = u?.scales.x.min ?? null
            let xMax: number | null = u?.scales.x.max ?? null
            if ((xMin == null || xMax == null || xMax <= xMin) && traceTime && traceTime.length > 0) {
              xMin = traceTime[0]
              xMax = traceTime[traceTime.length - 1]
            }
            if (xMin != null && xMax != null && xMax > xMin) resetCursorsInView(xMin, xMax)
          }}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Bring cursor bands into the current view">Reset cursors</button>
        <button className="btn"
          onClick={resetZoom}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Reset zoom to full sweep">Reset zoom</button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 120 }} />
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y · drag empty = pan · drag band = move · drag edge = resize
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResultsTabs — bottom-section tab strip. Two tabs: the I-V plot and the
// full points table. Switching tabs does NOT destroy the other's state.
// ---------------------------------------------------------------------------

function ResultsTabs({
  entry, fit, onSelectRow,
}: {
  entry: IVCurveData | undefined
  fit: { slope: number; intercept: number; r2: number; rInMOhm: number | null } | null
  onSelectRow: (idx: number) => void
}) {
  const [activeTab, setActiveTab] = useState<'iv' | 'table'>('iv')
  const pointCount = entry?.points.length ?? 0
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      minHeight: 0, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'stretch',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', flexShrink: 0,
      }}>
        {([
          { id: 'iv' as const, label: 'I-V curve' },
          { id: 'table' as const, label: 'Table' },
        ]).map((t) => {
          const active = activeTab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                padding: '6px 14px',
                border: 'none',
                borderBottom: active ? '3px solid var(--accent)' : '3px solid transparent',
                background: active ? 'var(--bg-primary)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-ui)',
                fontWeight: active ? 700 : 400,
              }}
            >
              {t.label}
              {pointCount > 0 && t.id === 'iv' && (
                <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', fontWeight: 400 }}>
                  ({pointCount})
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Keep both mounted — switching tabs shouldn't destroy the plot.
            Visibility toggles via display: none. */}
        <div style={{ display: activeTab === 'iv' ? 'block' : 'none', height: '100%' }}>
          <IVPlot entry={entry} heightSignal={0} onSelectIdx={onSelectRow} fit={fit} />
        </div>
        <div style={{ display: activeTab === 'table' ? 'block' : 'none', height: '100%', overflow: 'auto' }}>
          <IVTable entry={entry} onSelect={onSelectRow} />
        </div>
      </div>
    </div>
  )
}
