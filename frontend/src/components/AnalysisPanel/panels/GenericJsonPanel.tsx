import React, { useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import type { AnalysisType } from '../AnalysisPanel'

/**
 * Temporary generic panel: Run button + JSON dump of results.
 * Used for all analysis types until they get dedicated panels.
 */
export function GenericJsonPanel({ analysisType }: { analysisType: AnalysisType }) {
  const { backendUrl, cursors, currentGroup, currentSeries, currentSweep, currentTrace, addResult } = useAppStore()
  const [running, setRunning] = useState(false)
  const [lastResult, setLastResult] = useState<any>(null)

  const runAnalysis = async () => {
    setRunning(true)
    setLastResult(null)
    try {
      const resp = await fetch(`${backendUrl}/api/analysis/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: analysisType,
          group: currentGroup,
          series: currentSeries,
          sweep: currentSweep,
          trace: currentTrace,
          cursors,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || resp.statusText)
      }
      const result = await resp.json()
      setLastResult(result)
      if (result.measurement) {
        addResult({
          sweepIndex: currentSweep,
          seriesIndex: currentSeries,
          ...result.measurement,
        })
      }
    } catch (err: any) {
      setLastResult({ error: err.message })
    }
    setRunning(false)
  }

  return (
    <div>
      <button
        className="btn btn-primary"
        style={{ width: '100%', marginBottom: 8 }}
        onClick={runAnalysis}
        disabled={running}
      >
        {running ? 'Running...' : 'Run Analysis'}
      </button>

      {lastResult && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: lastResult.error ? 'var(--error)' : 'var(--text-secondary)' }}>
          {lastResult.error ? (
            <span>{lastResult.error}</span>
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-label)' }}>
              {JSON.stringify(lastResult.measurement || lastResult, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
