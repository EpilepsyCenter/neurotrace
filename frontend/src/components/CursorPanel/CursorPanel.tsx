import React, { useMemo, useEffect, useRef, useState } from 'react'
import { useAppStore, CursorPositions } from '../../stores/appStore'

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

  return { baseline, peak: peakVal, amplitude: peakVal - baseline, peakTime: peakIdx / sr }
}

export function CursorPanel() {
  const {
    cursors, setCursors, traceData,
    showCursors, toggleCursors, resetCursorsToDefaults,
    cursorVisibility, setCursorVisibility,
    filter, setFilter,
  } = useAppStore()

  const measurements = useMemo(() => {
    if (!traceData) return null
    return quickMeasure(traceData.time, traceData.values, cursors, traceData.samplingRate)
  }, [traceData, cursors])

  // Broadcast cursors + sweep to analysis windows
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      channelRef.current = ch
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'state-request' || ev.data?.type === 'cursor-request') {
          const state = useAppStore.getState()
          ch.postMessage({ type: 'state-update', cursors: state.cursors, sweep: state.currentSweep })
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'cursor-update', cursors })
  }, [cursors])

  const currentSweep = useAppStore((s) => s.currentSweep)
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'sweep-update', sweep: currentSweep })
  }, [currentSweep])

  // ---- Axis range state (local, synced to uPlot via broadcast) ----
  const [xMin, setXMin] = useState('')
  const [xMax, setXMax] = useState('')
  const [yMin, setYMin] = useState('')
  const [yMax, setYMax] = useState('')

  const applyAxisRange = () => {
    const ch = new BroadcastChannel('neurotrace-axis-range')
    const range: any = {}
    if (xMin !== '' && xMax !== '') range.x = { min: parseFloat(xMin), max: parseFloat(xMax) }
    if (yMin !== '' && yMax !== '') range.y = { min: parseFloat(yMin), max: parseFloat(yMax) }
    ch.postMessage({ type: 'set-axis-range', ...range })
    ch.close()
  }

  // Sections
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 4,
      }}>{title}</div>
      {children}
    </div>
  )

  const CursorInput = ({
    label, color, startKey, endKey, visKey,
  }: {
    label: string; color: string
    startKey: keyof CursorPositions; endKey: keyof CursorPositions
    visKey: 'baseline' | 'peak' | 'fit'
  }) => (
    <div style={{ marginBottom: 8, opacity: cursorVisibility[visKey] ? 1 : 0.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        <input
          type="checkbox"
          checked={cursorVisibility[visKey]}
          onChange={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}
          style={{ margin: 0, accentColor: color }}
        />
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color, cursor: 'pointer' }}
              onClick={() => setCursorVisibility({ [visKey]: !cursorVisibility[visKey] })}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', paddingLeft: 18 }}>
        <input type="number" step={0.001} value={cursors[startKey]}
          onChange={(e) => setCursors({ [startKey]: parseFloat(e.target.value) || 0 })}
          style={{ width: 70 }} />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
        <input type="number" step={0.001} value={cursors[endKey]}
          onChange={(e) => setCursors({ [endKey]: parseFloat(e.target.value) || 0 })}
          style={{ width: 70 }} />
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

      {/* ---- Axis Ranges ---- */}
      <Section title="Axis ranges">
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>X</span>
          <input type="number" step={0.01} placeholder="min" value={xMin}
            onChange={(e) => setXMin(e.target.value)} style={{ width: 65 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <input type="number" step={0.01} placeholder="max" value={xMax}
            onChange={(e) => setXMax(e.target.value)} style={{ width: 65 }} />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>s</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', width: 14 }}>Y</span>
          <input type="number" step={1} placeholder="min" value={yMin}
            onChange={(e) => setYMin(e.target.value)} style={{ width: 65 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{'\u2192'}</span>
          <input type="number" step={1} placeholder="max" value={yMax}
            onChange={(e) => setYMax(e.target.value)} style={{ width: 65 }} />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>{traceData?.units || ''}</span>
        </div>
        <button className="btn" onClick={applyAxisRange} style={{ width: '100%', fontSize: 'var(--font-size-xs)' }}>
          Apply ranges
        </button>
      </Section>

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
              <input type="number" value={filter.lowCutoff} min={0.1} step={1}
                onChange={(e) => setFilter({ lowCutoff: parseFloat(e.target.value) || 1 })}
                style={{ width: 55 }} />
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
            </div>
          )}
          {(filter.type === 'lowpass' || filter.type === 'bandpass') && (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>High</span>
              <input type="number" value={filter.highCutoff} min={1} step={100}
                onChange={(e) => setFilter({ highCutoff: parseFloat(e.target.value) || 5000 })}
                style={{ width: 55 }} />
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Hz</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>Order</span>
            <input type="number" value={filter.order} min={1} max={8} step={1}
              onChange={(e) => setFilter({ order: parseInt(e.target.value) || 4 })}
              style={{ width: 40 }} />
          </div>
        </div>
        <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4 }}>
          {filter.enabled ? 'Filter applied to display' : 'Filter disabled'}
        </p>
      </Section>
    </div>
  )
}
