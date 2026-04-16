import React, { useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ResistancePanel } from './panels/ResistancePanel'
import { GenericJsonPanel } from './panels/GenericJsonPanel'

export type AnalysisType =
  | 'cursors' | 'resistance' | 'kinetics' | 'events'
  | 'field_potential' | 'bursts' | 'spectral'

const ANALYSIS_OPTIONS: { value: AnalysisType; label: string }[] = [
  { value: 'cursors', label: 'Cursor Measurements' },
  { value: 'resistance', label: 'Rs / Rin / Cm' },
  { value: 'kinetics', label: 'Kinetics (Fit)' },
  { value: 'events', label: 'Event Detection' },
  { value: 'field_potential', label: 'Field Potential' },
  { value: 'bursts', label: 'Burst Detection' },
  { value: 'spectral', label: 'Spectral Analysis' },
]

export function AnalysisPanel() {
  const { traceData } = useAppStore()
  const [analysisType, setAnalysisType] = useState<AnalysisType>('resistance')

  return (
    <div className="panel" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="panel-title">Analysis</div>
      <select
        value={analysisType}
        onChange={(e) => setAnalysisType(e.target.value as AnalysisType)}
        style={{ width: '100%', marginBottom: 10 }}
        disabled={!traceData}
      >
        {ANALYSIS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      {!traceData ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>
          Load a trace to run analyses
        </p>
      ) : analysisType === 'resistance' ? (
        <ResistancePanel />
      ) : (
        <GenericJsonPanel analysisType={analysisType} />
      )}
    </div>
  )
}
