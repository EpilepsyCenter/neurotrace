import React, { useMemo, useEffect, useRef } from 'react'
import { useAppStore, CursorPositions } from '../../stores/appStore'

/** Compute quick measurements from cursor positions without calling the backend */
function quickMeasure(
  time: Float64Array,
  values: Float64Array,
  cursors: CursorPositions,
  sr: number,
) {
  const idx = (t: number) => Math.max(0, Math.min(values.length - 1, Math.round(t * sr)))

  const blI0 = idx(cursors.baselineStart)
  const blI1 = idx(cursors.baselineEnd)
  const pkI0 = idx(cursors.peakStart)
  const pkI1 = idx(cursors.peakEnd)

  let blSum = 0
  const blN = Math.max(1, blI1 - blI0)
  for (let i = blI0; i < blI1 && i < values.length; i++) blSum += values[i]
  const baseline = blSum / blN

  let peakVal = values[pkI0] ?? 0
  let peakIdx = pkI0
  for (let i = pkI0; i < pkI1 && i < values.length; i++) {
    if (Math.abs(values[i] - baseline) > Math.abs(peakVal - baseline)) {
      peakVal = values[i]
      peakIdx = i
    }
  }

  return {
    baseline,
    peak: peakVal,
    amplitude: peakVal - baseline,
    peakTime: peakIdx / sr,
  }
}

export function CursorPanel() {
  const {
    cursors,
    setCursors,
    traceData,
    showCursors,
    toggleCursors,
    resetCursorsToDefaults,
  } = useAppStore()

  const measurements = useMemo(() => {
    if (!traceData) return null
    return quickMeasure(traceData.time, traceData.values, cursors, traceData.samplingRate)
  }, [traceData, cursors])

  // Broadcast cursor + sweep state to analysis windows via BroadcastChannel
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      channelRef.current = ch
      // Respond to state requests from newly-opened analysis windows
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'state-request' || ev.data?.type === 'cursor-request') {
          const state = useAppStore.getState()
          ch.postMessage({
            type: 'state-update',
            cursors: state.cursors,
            sweep: state.currentSweep,
          })
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // Push cursor updates whenever they change
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'cursor-update', cursors })
  }, [cursors])

  // Push sweep changes from the app store
  const currentSweep = useAppStore((s) => s.currentSweep)
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'sweep-update', sweep: currentSweep })
  }, [currentSweep])

  // Header row shared by both empty and loaded states, with
  // show/hide checkbox + reset button next to the title.
  const Header = () => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
      gap: 6,
    }}>
      <label
        className="panel-title"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
          marginBottom: 0,
        }}
        title="Toggle cursors visibility on the trace plot"
      >
        <input
          type="checkbox"
          checked={showCursors}
          onChange={toggleCursors}
          style={{ margin: 0, accentColor: 'var(--accent)' }}
        />
        Cursors
      </label>
      <button
        className="btn"
        onClick={resetCursorsToDefaults}
        disabled={!traceData}
        style={{
          padding: '2px 8px',
          fontSize: 'var(--font-size-label)',
        }}
        title="Reset cursors to default positions (0–20%, 30–50%, 60–80% of trace)"
      >
        reset
      </button>
    </div>
  )

  if (!traceData) {
    return (
      <div className="panel">
        <Header />
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>Load a trace first</p>
      </div>
    )
  }

  const CursorInput = ({
    label,
    color,
    startKey,
    endKey,
  }: {
    label: string
    color: string
    startKey: keyof CursorPositions
    endKey: keyof CursorPositions
  }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color }}>{label}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="number"
          step={0.001}
          value={cursors[startKey]}
          onChange={(e) => setCursors({ [startKey]: parseFloat(e.target.value) || 0 })}
          style={{ width: 76 }}
          title={`${label} start (s) — drag on plot to adjust`}
        />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
        <input
          type="number"
          step={0.001}
          value={cursors[endKey]}
          onChange={(e) => setCursors({ [endKey]: parseFloat(e.target.value) || 0 })}
          style={{ width: 76 }}
          title={`${label} end (s) — drag on plot to adjust`}
        />
      </div>
    </div>
  )

  const Readout = ({ label, value, unit }: { label: string; value: number; unit: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
        {value.toFixed(2)} {unit}
      </span>
    </div>
  )

  return (
    <div className="panel">
      <Header />
      {showCursors && (
        <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', marginBottom: 8, fontStyle: 'italic' }}>
          Drag dashed lines on the plot to reposition
        </p>
      )}

      <CursorInput label="Baseline" color="var(--cursor-baseline)" startKey="baselineStart" endKey="baselineEnd" />
      <CursorInput label="Peak" color="var(--cursor-peak)" startKey="peakStart" endKey="peakEnd" />
      <CursorInput label="Fit" color="var(--cursor-fit)" startKey="fitStart" endKey="fitEnd" />

      {measurements && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
          <div className="panel-title">Quick Readout</div>
          <Readout label="Baseline" value={measurements.baseline} unit={traceData.units} />
          <Readout label="Peak" value={measurements.peak} unit={traceData.units} />
          <Readout label="Amplitude" value={measurements.amplitude} unit={traceData.units} />
          <Readout label="Peak time" value={measurements.peakTime * 1000} unit="ms" />
        </div>
      )}
    </div>
  )
}
