import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore, CursorPositions } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

// ---- Stable, module-level sub-components ----
//
// Previously these were defined INSIDE CursorPanel. Every re-render of the
// parent created a new function identity for each, so React saw them as
// different component types and fully unmounted + remounted all descendants.
// That killed focus on any `<input>` the user was typing into whenever a
// sibling input caused the parent to re-render — which is exactly why typing
// in the axis-range boxes kept dropping on the second keystroke. Hoisting
// these out fixes it.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {title && (
        <div
          style={{
            fontSize: 'var(--font-size-label)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--text-muted)',
            marginBottom: 6,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

function Divider() {
  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        margin: '6px 0 14px 0',
      }}
      aria-hidden="true"
    />
  )
}

function Readout({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
        {value.toFixed(2)} {unit}
      </span>
    </div>
  )
}

function CursorInput({
  label, color, startKey, endKey, visKey,
}: {
  label: string; color: string
  startKey: keyof CursorPositions; endKey: keyof CursorPositions
  visKey: 'baseline' | 'peak' | 'fit'
}) {
  // Read what we need directly from the store — keeps this a stable
  // module-level component and avoids threading props through every render.
  const cursors = useAppStore((s) => s.cursors)
  const setCursors = useAppStore((s) => s.setCursors)
  const cursorVisibility = useAppStore((s) => s.cursorVisibility)
  const setCursorVisibility = useAppStore((s) => s.setCursorVisibility)

  return (
    <div style={{ marginBottom: 6, opacity: cursorVisibility[visKey] ? 1 : 0.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <input
          type="checkbox"
          checked={cursorVisibility[visKey]}
          onChange={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}
          style={{ margin: 0, accentColor: color }}
        />
        <span
          style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color, cursor: 'pointer' }}
          onClick={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}
        >
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', paddingLeft: 18 }}>
        <NumInput
          value={cursors[startKey]}
          step={0.001}
          onChange={(v) => setCursors({ [startKey]: v })}
          style={{ width: 70 }}
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
        <NumInput
          value={cursors[endKey]}
          step={0.001}
          onChange={(v) => setCursors({ [endKey]: v })}
          style={{ width: 70 }}
        />
      </div>
    </div>
  )
}

// ---- String input for axis ranges (allows empty = "auto") ----
// Uses type="text" with inputMode="decimal" so intermediate states like
// "", "-", "1.", "-1.2e" stay editable — the browser's native type="number"
// control rejects these and forces React to reset the value mid-keystroke.
// State is updated on every keystroke so the Apply button reads fresh values.
function RangeInput({
  value, onChange, step: _step, placeholder, style,
}: {
  value: string; onChange: (v: string) => void; step?: number; placeholder?: string; style?: React.CSSProperties
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      style={style}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function quickMeasure(
  time: Float64Array, values: Float64Array, cursors: CursorPositions, sr: number,
) {
  // Binary-search the time array for the index whose sample time is >= t.
  // traceData.time comes from the backend's LTTB decimator — the spacing is
  // non-uniform, so `Math.round(t * sr)` (which assumes time[i] = i / sr)
  // would return indices pointing to wrong samples, especially for cursors
  // later in the sweep. Search explicitly instead.
  const n = values.length
  if (n === 0 || time.length === 0) {
    return { baseline: 0, peak: 0, amplitude: 0, peakTime: 0 }
  }
  const idx = (t: number): number => {
    if (t <= time[0]) return 0
    if (t >= time[n - 1]) return n - 1
    let lo = 0, hi = n - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (time[mid] <= t) lo = mid
      else hi = mid
    }
    // lo has time[lo] <= t < time[hi]. Pick the closer of the two.
    return (t - time[lo]) <= (time[hi] - t) ? lo : hi
  }

  const blI0 = idx(cursors.baselineStart)
  const blI1 = Math.max(blI0 + 1, idx(cursors.baselineEnd))
  const pkI0 = idx(cursors.peakStart)
  const pkI1 = Math.max(pkI0 + 1, idx(cursors.peakEnd))

  let blSum = 0
  let blN = 0
  for (let i = blI0; i < blI1 && i < n; i++) { blSum += values[i]; blN++ }
  const baseline = blN > 0 ? blSum / blN : (values[blI0] ?? 0)

  let peakVal = values[pkI0] ?? 0
  let peakIdx = pkI0
  for (let i = pkI0; i < pkI1 && i < n; i++) {
    if (Math.abs(values[i] - baseline) > Math.abs(peakVal - baseline)) {
      peakVal = values[i]; peakIdx = i
    }
  }
  void sr
  return { baseline, peak: peakVal, amplitude: peakVal - baseline, peakTime: time[peakIdx] }
}

export function CursorPanel() {
  const {
    cursors, setCursors, traceData,
    showCursors, toggleCursors, resetCursorsToDefaults,
    cursorVisibility, setCursorVisibility,
    filter, setFilter,
    zeroOffset, toggleZeroOffset,
    showBurstMarkers, toggleBurstMarkers,
    fieldBursts,
  } = useAppStore()

  // Does the CURRENT sweep in the CURRENT series have any detected bursts?
  // Drives the enabled/disabled state of the Bursts visibility checkbox.
  const hasBurstsInCurrentSweep = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    const entry = s.fieldBursts[key]
    if (!entry || entry.bursts.length === 0) return false
    return entry.bursts.some((b) => b.sweepIndex === s.currentSweep)
  })
  // Total burst count in the current series (shown next to the label).
  const currentSeriesBurstCount = useAppStore((s) => {
    const key = `${s.currentGroup}:${s.currentSeries}`
    return s.fieldBursts[key]?.bursts.filter((b) => b.sweepIndex === s.currentSweep).length ?? 0
  })
  void fieldBursts  // subscribe the component to changes

  const measurements = useMemo(() => {
    if (!traceData) return null
    return quickMeasure(traceData.time, traceData.values, cursors, traceData.samplingRate)
  }, [traceData, cursors])

  // Broadcast cursors + sweep to analysis windows; also receive pushes from
  // analysis windows (burst-detection results + filter config).
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      channelRef.current = ch
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'state-request' || ev.data?.type === 'cursor-request') {
          const state = useAppStore.getState()
          ch.postMessage({
            type: 'state-update',
            cursors: state.cursors,
            sweep: state.currentSweep,
            group: state.currentGroup,
            series: state.currentSeries,
            trace: state.currentTrace,
            fieldBursts: state.fieldBursts,
            burstFormParams: state.burstFormParams,
            ivCurves: state.ivCurves,
            fpspCurves: state.fpspCurves,
            cursorAnalyses: state.cursorAnalyses,
            excludedSweeps: state.excludedSweeps,
            averagedSweeps: state.averagedSweeps,
          })
        }
        // Bursts pushed from an analysis window → adopt them here so the
        // main TraceViewer's burst-marker overlay has data to draw.
        if (ev.data?.type === 'bursts-update' && ev.data.fieldBursts) {
          useAppStore.setState({ fieldBursts: ev.data.fieldBursts })
        }
        // Burst-detection form state (method + params) pushed from the
        // analysis window — adopt so the main-window store can persist
        // it to electron prefs. Without this the settings wouldn't
        // survive an app restart because only the main window has
        // `recording.filePath` set for the persistence subscribe.
        if (ev.data?.type === 'burst-form-params-update' && ev.data.burstFormParams) {
          useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
        }
        // I-V curves pushed from an analysis window → adopt here so the main
        // window's store has them for persistence.
        if (ev.data?.type === 'iv-update' && ev.data.ivCurves) {
          useAppStore.setState({ ivCurves: ev.data.ivCurves })
        }
        // fPSP data from analysis window.
        if (ev.data?.type === 'fpsp-update' && ev.data.fpspCurves) {
          useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
        }
        // Cursor analysis data from analysis window → adopt here so
        // the main store's subscribe can persist to electron prefs.
        // Without this, the analysis window's broadcasts were ignored
        // and nothing ever got saved to disk, which is why reopening
        // the window showed defaults.
        if (ev.data?.type === 'cursor-analyses-update' && ev.data.cursorAnalyses) {
          useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
        }
        // Excluded-sweep changes from any window — adopt so the main
        // store persists to electron prefs and other windows see the
        // same exclusion set.
        if (ev.data?.type === 'excluded-update' && ev.data.excludedSweeps) {
          useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
        }
        // User-created averaged sweeps (virtual tree entries).
        if (ev.data?.type === 'averaged-update' && ev.data.averagedSweeps) {
          useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
        }
        // Detection filter pushed from an analysis window → adopt in the
        // main viewer's filter panel so the displayed trace has the same
        // processing as what the markers were computed against.
        if (ev.data?.type === 'detection-filter' && ev.data.filter) {
          const f = ev.data.filter
          useAppStore.getState().setFilter({
            enabled: !!f.enabled,
            type: f.type,
            lowCutoff: Number(f.lowCutoff ?? 1),
            highCutoff: Number(f.highCutoff ?? 50),
            order: Number(f.order ?? 4),
          })
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'cursor-update', cursors })
  }, [cursors])

  const currentSweep = useAppStore((s) => s.currentSweep)
  const currentGroup = useAppStore((s) => s.currentGroup)
  const currentSeries = useAppStore((s) => s.currentSeries)
  const currentTrace = useAppStore((s) => s.currentTrace)
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'sweep-update', sweep: currentSweep })
  }, [currentSweep])
  // Live-sync the group/series/trace selection so analysis windows can
  // follow along (e.g. FieldBurstWindow preselects the same series as the
  // main tree).
  useEffect(() => {
    channelRef.current?.postMessage({
      type: 'selection-update',
      group: currentGroup,
      series: currentSeries,
      trace: currentTrace,
    })
  }, [currentGroup, currentSeries, currentTrace])

  // Axis range state (local strings, applied on button click)
  const [xMin, setXMin] = useState('')
  const [xMax, setXMax] = useState('')
  const [yMin, setYMin] = useState('')
  const [yMax, setYMax] = useState('')

  const applyAxisRange = () => {
    try {
      const ch = new BroadcastChannel('neurotrace-axis-range')
      const range: any = {}
      if (xMin !== '' && xMax !== '') range.x = { min: parseFloat(xMin), max: parseFloat(xMax) }
      if (yMin !== '' && yMax !== '') range.y = { min: parseFloat(yMin), max: parseFloat(yMax) }
      ch.postMessage({ type: 'set-axis-range', ...range })
      ch.close()
    } catch { /* ignore */ }
  }

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ---- Cursors ---- */}
      <Section title="">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 5,
            cursor: 'pointer', userSelect: 'none',
            fontSize: 'var(--font-size-label)', fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)',
          }}>
            <input type="checkbox" checked={showCursors} onChange={toggleCursors}
              style={{ margin: 0, accentColor: 'var(--accent)' }} />
            Cursors
          </label>
          <button className="btn" onClick={resetCursorsToDefaults} disabled={!traceData}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>
            reset
          </button>
        </div>
        <CursorInput label="Baseline" color="var(--cursor-baseline)" startKey="baselineStart" endKey="baselineEnd" visKey="baseline" />
        <CursorInput label="Peak" color="var(--cursor-peak)" startKey="peakStart" endKey="peakEnd" visKey="peak" />
        <CursorInput label="Fit" color="var(--cursor-fit)" startKey="fitStart" endKey="fitEnd" visKey="fit" />
      </Section>

      {/* ---- Quick Readout ---- */}
      {measurements && (
        <Section title="Readout">
          <Readout label="Baseline" value={measurements.baseline} unit={traceData?.units || ''} />
          <Readout label="Peak" value={measurements.peak} unit={traceData?.units || ''} />
          <Readout label="Amplitude" value={measurements.amplitude} unit={traceData?.units || ''} />
          <Readout label="Peak time" value={measurements.peakTime * 1000} unit="ms" />
        </Section>
      )}

      <Divider />

      {/* ---- Detected events visibility toggle ----
           Generic label ("Show/hide detected events") so this reuses cleanly
           when we add minis, action potentials, etc. — not just bursts. */}
      <Section title="">
        <label
          title={
            hasBurstsInCurrentSweep
              ? 'Toggle markers (baseline / threshold lines + event dots) for all detected events on the main viewer'
              : 'No detected events for the current sweep — run detection in an Analyses window first'
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            cursor: hasBurstsInCurrentSweep ? 'pointer' : 'not-allowed',
            userSelect: 'none',
            fontSize: 'var(--font-size-label)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: hasBurstsInCurrentSweep ? 'var(--text-muted)' : 'var(--text-disabled, #666)',
            opacity: hasBurstsInCurrentSweep ? 1 : 0.5,
          }}
        >
          <input
            type="checkbox"
            checked={showBurstMarkers}
            onChange={toggleBurstMarkers}
            disabled={!hasBurstsInCurrentSweep}
            style={{ margin: 0, accentColor: 'var(--accent)' }}
          />
          Show/hide detected events
          {hasBurstsInCurrentSweep && (
            <span style={{
              marginLeft: 4, fontWeight: 400, letterSpacing: 0,
              textTransform: 'none',
            }}>
              ({currentSeriesBurstCount})
            </span>
          )}
        </label>
      </Section>

      <Divider />

      {/* ---- Axis Ranges ---- */}
      <Section title="Axis ranges">
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>X</span>
          <RangeInput step={0.01} placeholder="min" value={xMin} onChange={setXMin} style={{ width: 65 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <RangeInput step={0.01} placeholder="max" value={xMax} onChange={setXMax} style={{ width: 65 }} />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>s</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>Y</span>
          <RangeInput
            step={1}
            placeholder="min"
            value={yMin}
            onChange={(v) => {
              setYMin(v)
              // When zero-offset is on, mirror to enforce symmetry around 0.
              if (zeroOffset && v !== '') {
                const n = parseFloat(v)
                if (isFinite(n)) setYMax(String(Math.abs(n)))
              }
            }}
            style={{ width: 65 }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <RangeInput
            step={1}
            placeholder="max"
            value={yMax}
            onChange={(v) => {
              setYMax(v)
              if (zeroOffset && v !== '') {
                const n = parseFloat(v)
                if (isFinite(n)) setYMin(String(-Math.abs(n)))
              }
            }}
            style={{ width: 65 }}
          />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
            {traceData?.units || ''}{zeroOffset && ' (symmetric)'}
          </span>
        </div>
        <button className="btn" onClick={applyAxisRange} style={{ width: '100%', fontSize: 'var(--font-size-xs)' }}>
          Apply ranges
        </button>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 5, marginTop: 6,
          cursor: 'pointer', userSelect: 'none', fontSize: 'var(--font-size-xs)',
        }}>
          <input type="checkbox" checked={zeroOffset} onChange={toggleZeroOffset}
            style={{ margin: 0 }} />
          Subtract zero offset
        </label>
        {zeroOffset && (
          <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>
            Baseline (first 3 ms) subtracted — traces start at 0
          </p>
        )}
      </Section>

      <Divider />

      {/* ---- Filter ---- */}
      <Section title="Filter">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <input type="checkbox" checked={filter.enabled}
            onChange={() => setFilter({ enabled: !filter.enabled })}
            style={{ margin: 0 }} />
          <select value={filter.type} onChange={(e) => setFilter({ type: e.target.value as any })}
            style={{ flex: 1 }}>
            <option value="lowpass">Lowpass</option>
            <option value="highpass">Highpass</option>
            <option value="bandpass">Bandpass</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {(filter.type === 'highpass' || filter.type === 'bandpass') && (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Low</span>
              <NumInput value={filter.lowCutoff} min={0.1} step={1}
                onChange={(v) => setFilter({ lowCutoff: v })} style={{ width: 55 }} />
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
            </div>
          )}
          {(filter.type === 'lowpass' || filter.type === 'bandpass') && (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>High</span>
              <NumInput value={filter.highCutoff} min={1} step={100}
                onChange={(v) => setFilter({ highCutoff: v })} style={{ width: 55 }} />
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Order</span>
            <NumInput value={filter.order} min={1} max={8} step={1}
              onChange={(v) => setFilter({ order: v })} style={{ width: 40 }} />
          </div>
        </div>
        <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4 }}>
          {filter.enabled ? 'Filter applied to display' : 'Filter disabled'}
        </p>
      </Section>
    </div>
  )
}
