import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../../stores/appStore'

type RunMode = 'single' | 'averaged' | 'monitor'

/** Format a possibly-null number with a unit. */
function fmt(v: number | null | undefined, digits: number, unit: string): string {
  if (v == null || !isFinite(v)) return '—'
  return `${v.toFixed(digits)} ${unit}`
}

export function ResistancePanel() {
  const {
    loading,
    cursors,
    recording,
    currentGroup,
    currentSeries,
    currentSweep,
    resistanceResult,
    runResistanceOnSweep,
    runResistanceOnAverage,
    loadResistanceMonitor,
    clearResistanceResult,
  } = useAppStore()

  const [vStep, setVStep] = useState(5)
  const [vStepAuto, setVStepAuto] = useState(true)
  const [avgFrom, setAvgFrom] = useState(1)
  const [avgTo, setAvgTo] = useState(1)
  const [lastMode, setLastMode] = useState<RunMode | null>(null)

  const currentSeriesInfo = recording?.groups[currentGroup]?.series[currentSeries]
  const totalSweeps = currentSeriesInfo?.sweepCount ?? 0
  const stimulus = currentSeriesInfo?.stimulus

  // When series changes, reset the averaged sweep range to the full series,
  // and snap V_step to the stimulus-derived value (unless user has overridden).
  useEffect(() => {
    if (totalSweeps > 0) {
      setAvgFrom(1)
      setAvgTo(totalSweeps)
    }
    if (vStepAuto && stimulus) {
      // Use the absolute pulse level (e.g. -5 mV), not the delta from holding.
      setVStep(Number(stimulus.vStepAbsolute.toFixed(2)))
    }
    // intentionally not depending on vStepAuto to avoid resnapping
    // immediately after the user clicks "Restore auto"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, currentSeries, totalSweeps, stimulus?.vStepAbsolute])

  // If the user edits V_step manually, turn off the auto-bind.
  const onChangeVStep = (val: number) => {
    setVStep(val)
    setVStepAuto(false)
  }
  const onRestoreAuto = () => {
    setVStepAuto(true)
    if (stimulus) setVStep(Number(stimulus.vStepAbsolute.toFixed(2)))
  }

  const onRunSingle = async () => {
    setLastMode('single')
    await runResistanceOnSweep(vStep)
  }

  const onRunAveraged = async () => {
    if (totalSweeps === 0) return
    // Convert 1-based UI values to 0-based sweep indices
    const from = Math.max(1, Math.min(avgFrom, totalSweeps))
    const to = Math.max(from, Math.min(avgTo, totalSweeps))
    const indices: number[] = []
    for (let i = from - 1; i <= to - 1; i++) indices.push(i)
    setLastMode('averaged')
    await runResistanceOnAverage(vStep, indices)
  }

  const onRunMonitor = async () => {
    setLastMode('monitor')
    await loadResistanceMonitor(vStep)
  }

  const r = resistanceResult

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* V_step input */}
      <div>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 'var(--font-size-label)',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 3,
        }}>
          <span>Test pulse amplitude</span>
          {stimulus && vStepAuto && (
            <span style={{
              fontSize: 'var(--font-size-label)',
              color: 'var(--accent)',
              textTransform: 'none',
              letterSpacing: 0,
              fontWeight: 500,
            }}>
              from stimulus
            </span>
          )}
          {stimulus && !vStepAuto && (
            <button
              onClick={onRestoreAuto}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--accent)',
                fontSize: 'var(--font-size-label)',
                cursor: 'pointer',
                textTransform: 'none',
                letterSpacing: 0,
              }}
              title="Reset to stimulus-derived value"
            >
              restore auto
            </button>
          )}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="number"
            value={vStep}
            step={1}
            onChange={(e) => onChangeVStep(parseFloat(e.target.value) || 0)}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>mV</span>
        </div>
        {stimulus && (
          <div style={{
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            marginTop: 3,
          }}>
            V<sub>hold</sub>&nbsp;= {stimulus.vHold.toFixed(1)} mV
            &nbsp;→&nbsp; V<sub>pulse</sub>&nbsp;= {stimulus.vStepAbsolute.toFixed(1)} mV
          </div>
        )}
        {!stimulus && (
          <div style={{
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            marginTop: 3,
          }}>
            No stimulus info in file — enter V<sub>step</sub> manually
          </div>
        )}
      </div>

      {/* Cursor readout */}
      <div style={{
        fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        background: 'var(--bg-primary)',
        padding: '6px 8px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <div>baseline: {cursors.baselineStart.toFixed(4)}s → {cursors.baselineEnd.toFixed(4)}s</div>
        <div>pulse: {cursors.peakStart.toFixed(4)}s → {cursors.peakEnd.toFixed(4)}s</div>
        <div style={{ marginTop: 3, fontStyle: 'italic', color: 'var(--text-muted)' }}>
          Drag dashed lines on the plot to adjust
        </div>
      </div>

      {/* Run buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          className="btn btn-primary"
          onClick={onRunSingle}
          disabled={loading}
          style={{ width: '100%' }}
        >
          {loading && lastMode === 'single' ? 'Running…' : `Run on sweep ${currentSweep + 1}`}
        </button>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: 'var(--bg-primary)',
          padding: '4px 6px',
          borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>sweeps</span>
          <input
            type="number"
            value={avgFrom}
            min={1}
            max={totalSweeps}
            onChange={(e) => setAvgFrom(parseInt(e.target.value) || 1)}
            style={{ width: 48 }}
          />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>–</span>
          <input
            type="number"
            value={avgTo}
            min={1}
            max={totalSweeps}
            onChange={(e) => setAvgTo(parseInt(e.target.value) || 1)}
            style={{ width: 48 }}
          />
        </div>
        <button
          className="btn"
          onClick={onRunAveraged}
          disabled={loading || totalSweeps === 0}
          style={{ width: '100%' }}
        >
          {loading && lastMode === 'averaged' ? 'Running…' : 'Run on averaged sweeps'}
        </button>

        <button
          className="btn"
          onClick={onRunMonitor}
          disabled={loading || totalSweeps === 0}
          style={{ width: '100%' }}
        >
          {loading && lastMode === 'monitor' ? 'Running…' : 'Run across all sweeps'}
        </button>
      </div>

      {/* Result card */}
      {r && (
        <div style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="panel-title" style={{ marginBottom: 0 }}>Result</div>
            <button
              onClick={clearResistanceResult}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: 'var(--font-size-label)',
                cursor: 'pointer',
              }}
              title="Clear result"
            >
              ✕
            </button>
          </div>

          <ResistanceMetric label="Rs" value={r.rs} digits={1} unit="MΩ" />
          <ResistanceMetric label="Rin" value={r.rin} digits={1} unit="MΩ" />
          <ResistanceMetric label="Cm" value={r.cm ?? null} digits={1} unit="pF" />
          <ResistanceMetric label="τ" value={r.tau ?? null} digits={2} unit="ms" small />

          <div style={{
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            marginTop: 4,
          }}>
            I_base: {fmt(r.baseline, 1, 'pA')}
            <br />
            I_peak: {fmt(r.peak_current, 1, 'pA')}
            <br />
            I_ss: {fmt(r.steady_state_current, 1, 'pA')}
          </div>

          {r.source && (
            <div style={{
              fontSize: 'var(--font-size-label)',
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              marginTop: 2,
            }}>
              {r.source}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ResistanceMetric({
  label,
  value,
  digits,
  unit,
  small = false,
}: {
  label: string
  value: number | null | undefined
  digits: number
  unit: string
  small?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{
        fontSize: small ? 'var(--font-size-label)' : 'var(--font-size-xs)',
        color: 'var(--text-secondary)',
        fontWeight: 600,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: small ? 'var(--font-size-xs)' : 'var(--font-size-base)',
        color: value == null ? 'var(--text-muted)' : 'var(--text-primary)',
      }}>
        {fmt(value, digits, unit)}
      </span>
    </div>
  )
}
