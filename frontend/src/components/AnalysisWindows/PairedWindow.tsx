import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  PairedData, PairedFormState, PairedTrial,
  defaultPairedForm, useAppStore,
} from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'

// ---------------------------------------------------------------------------
// Types and helpers
// ---------------------------------------------------------------------------

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

export function PairedWindow({
  backendUrl, fileInfo, mainGroup, mainSeries,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
}) {
  const {
    pairedAnalyses, pairedForm, setPairedAnalysis, clearPairedAnalysis, setPairedForm,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  void theme; void fontSize  // referenced only to make uPlot rebuilds reactive to theme

  // ---- Selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [preTrace, setPreTrace] = useState(0)
  const [postTrace, setPostTrace] = useState(1)
  const [sweep, setSweep] = useState(0)

  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
  }, [mainGroup, mainSeries])

  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0) {
      if (preTrace >= channels.length) setPreTrace(0)
      if (postTrace >= channels.length) setPostTrace(Math.min(1, channels.length - 1))
      if (preTrace === postTrace && channels.length > 1) {
        setPostTrace(preTrace === 0 ? 1 : 0)
      }
    }
  }, [channels, preTrace, postTrace])

  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  useEffect(() => {
    if (sweep >= totalSweeps) setSweep(Math.max(0, totalSweeps - 1))
  }, [totalSweeps, sweep])

  // ---- Form state — global last-used, with per-series rehydration ----
  // The store carries last-used defaults; per-series saved entries (from
  // a previous Run) override them when this window opens onto a series
  // that already has results. ``rehydratedKeyRef`` ensures we don't
  // clobber the user's edits when an async state-update arrives later.
  const [form, setLocalForm] = useState<PairedFormState>(() => pairedForm ?? defaultPairedForm())
  const rehydratedKeyRef = useRef<string | null>(null)
  const formKey = `${group}:${series}`
  useEffect(() => {
    if (rehydratedKeyRef.current === formKey) return
    rehydratedKeyRef.current = formKey
    const stored = pairedAnalyses[formKey]
    if (stored) {
      setLocalForm({
        preMode: stored.preMode,
        preParams: stored.preParams,
        postParams: stored.postParams,
        failureParams: stored.failureParams,
        latencyParams: stored.latencyParams,
      })
    } else {
      setLocalForm(pairedForm ?? defaultPairedForm())
    }
  }, [formKey, pairedAnalyses, pairedForm])

  const updateForm = useCallback((patch: Partial<PairedFormState>) => {
    setLocalForm((prev) => ({ ...prev, ...patch }))
  }, [])

  // ---- Run mode ----
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  useEffect(() => {
    if (totalSweeps > 0 && sweepTo > totalSweeps) setSweepTo(totalSweeps)
  }, [totalSweeps, sweepTo])

  // ---- Tab ----
  type Tab = 'trials' | 'statistics' | 'sta'
  const [tab, setTab] = useState<Tab>('trials')

  // ---- Sweep data (pre + post) ----
  const [preData, setPreData] = useState<{ time: number[]; values: number[] } | null>(null)
  const [postData, setPostData] = useState<{ time: number[]; values: number[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    const fetchOne = async (traceIdx: number, setter: (v: { time: number[]; values: number[] } | null) => void) => {
      try {
        const url = `${backendUrl}/api/traces/data?group=${group}&series=${series}&sweep=${sweep}&trace=${traceIdx}&max_points=4000`
        const r = await fetch(url)
        if (!r.ok) { setter(null); return }
        const d = await r.json()
        if (cancelled) return
        setter({ time: d.time as number[], values: d.values as number[] })
      } catch {
        if (!cancelled) setter(null)
      }
    }
    if (totalSweeps > 0 && channels.length > 0) {
      fetchOne(preTrace, setPreData)
      if (preTrace !== postTrace) fetchOne(postTrace, setPostData)
      else setPostData(null)
    }
    return () => { cancelled = true }
  }, [backendUrl, group, series, sweep, preTrace, postTrace, totalSweeps, channels.length])

  // ---- Shared X axis ----
  // Parent owns the single source of truth for the X range. Both
  // viewers read this and write through ``setXRange`` so wheel-zoom
  // / pan on either drives both in lockstep.
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  // Reset shared X when we switch series.
  useEffect(() => { setXRange(null) }, [group, series])

  // ---- Run ----
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const onRun = useCallback(async () => {
    if (totalSweeps === 0) return
    if (preTrace === postTrace) {
      setRunError('Pre and post channels must differ.')
      return
    }
    setRunning(true)
    setRunError(null)
    try {
      const sweeps =
        runMode === 'all' ? Array.from({ length: totalSweeps }, (_, i) => i)
        : runMode === 'range' ? Array.from({
          length: Math.max(0, sweepTo - sweepFrom + 1),
        }, (_, i) => sweepFrom - 1 + i)
        : [sweepOne - 1]

      const body = {
        group, series,
        pre_trace: preTrace,
        post_trace: postTrace,
        sweeps,
        pre_mode: form.preMode,
        pre_params: form.preParams,
        post_params: {
          pre_ms: form.postParams.preMs,
          post_ms: form.postParams.postMs,
          baseline_ms: form.postParams.baselineMs,
          peak_direction: form.postParams.peakDirection,
          filter_enabled: form.postParams.filterEnabled,
          filter_type: form.postParams.filterType,
          filter_low: form.postParams.filterLow,
          filter_high: form.postParams.filterHigh,
          filter_order: form.postParams.filterOrder,
        },
        failure_params: {
          rule: form.failureParams.rule,
          k_sd: form.failureParams.kSd,
          absolute: form.failureParams.absolute,
        },
        latency_params: {
          rule: form.latencyParams.rule,
          fraction: form.latencyParams.fraction,
        },
        manual_edits: pairedAnalyses[formKey]?.manualEdits ?? null,
      }
      const r = await fetch(`${backendUrl}/api/paired/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const text = await r.text()
        setRunError(`Run failed: ${r.status} ${text}`)
        return
      }
      const d = await r.json()
      const data: PairedData = {
        group, series,
        preTrace, postTrace,
        sweeps,
        samplingRate: d.sampling_rate,
        preMode: form.preMode,
        preParams: form.preParams,
        postParams: form.postParams,
        failureParams: form.failureParams,
        latencyParams: form.latencyParams,
        manualEdits: pairedAnalyses[formKey]?.manualEdits ?? { added: {}, removed: {} },
        perTrial: (d.per_trial as any[]).map((t: any): PairedTrial => ({
          sweep: t.sweep,
          trialIdx: t.trial_idx,
          preTS: t.pre_t_s,
          preAmp: t.pre_amp,
          baselineMean: t.baseline_mean,
          baselineSd: t.baseline_sd,
          postPeak: t.post_peak,
          postPeakTS: t.post_peak_t_s,
          amplitude: t.amplitude,
          success: t.success,
          latencyMs: t.latency_ms,
          riseMs: t.rise_ms,
          decayMs: t.decay_ms,
          truncated: t.truncated,
          manual: t.manual,
        })),
        perSweepSummary: (d.per_sweep_summary as any[]).map((s: any) => ({
          sweep: s.sweep, nTrials: s.n_trials, nSuccess: s.n_success,
          nFailures: s.n_failures, ppr21: s.ppr_2_1,
        })),
        seriesSummary: {
          nTrials: d.series_summary.n_trials,
          nSuccess: d.series_summary.n_success,
          nFailures: d.series_summary.n_failures,
          failureRate: d.series_summary.failure_rate,
          meanAmplitude: d.series_summary.mean_amplitude,
          meanAmplitudeZeroed: d.series_summary.mean_amplitude_zeroed,
          potency: d.series_summary.potency,
          cvSuccess: d.series_summary.cv_success,
          invCv2: d.series_summary.inv_cv2,
          latencyMeanMs: d.series_summary.latency_mean_ms,
          latencySdMs: d.series_summary.latency_sd_ms,
          pprN1: (d.series_summary.ppr_n1 as any[]).map((p) => ({
            n: p.n, ratio: p.ratio, nSweeps: p.n_sweeps,
          })),
        },
        staAll: d.sta_all,
        staSuccess: d.sta_success,
        staFailure: d.sta_failure,
        selectedTrialIdx: null,
      }
      setPairedAnalysis(group, series, data)
      setPairedForm(form)
    } catch (e: any) {
      setRunError(`Run failed: ${e?.message ?? String(e)}`)
    } finally {
      setRunning(false)
    }
  }, [
    backendUrl, group, series, preTrace, postTrace, totalSweeps,
    runMode, sweepFrom, sweepTo, sweepOne, form, pairedAnalyses,
    formKey, setPairedAnalysis, setPairedForm,
  ])

  const stored = pairedAnalyses[formKey] ?? null

  // ---- Resizable left sidebar ----
  const [leftPanelWidth, setLeftPanelWidth] = useState(360)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onSidebarDrag = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: leftPanelWidth }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const next = Math.max(260, Math.min(640, dragRef.current.startW + dx))
      setLeftPanelWidth(next)
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [leftPanelWidth])

  // ---- UI ----
  const channelOptions = channels.map((c: any, i: number) => ({
    value: c.index ?? i, label: c.label || `Ch ${(c.index ?? i) + 1}`,
  }))
  const sweepLabel = totalSweeps > 0 ? `${sweep + 1}/${totalSweeps}` : '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ───── Top header: selectors + sweep arrows ───── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        gap: 8, padding: '6px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-size-sm)',
      }}>
        <Selector label="Group" value={group}
          onChange={setGroup}
          options={Array.from({ length: fileInfo?.groupCount ?? 0 }, (_, i) => ({
            value: i, label: `${i + 1}`,
          }))}
        />
        <Selector label="Series" value={series}
          onChange={setSeries}
          options={(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => ({
            value: i, label: s.label || `S${i + 1}`,
          }))}
        />
        <Selector label="Pre" value={preTrace}
          onChange={setPreTrace}
          options={channelOptions}
        />
        <Selector label="Post" value={postTrace}
          onChange={setPostTrace}
          options={channelOptions}
        />
        <div style={{ flex: 1 }} />
        {/* Sweep arrow cluster */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep === 0}
            onClick={() => setSweep(0)} title="First sweep">⟨⟨</button>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep === 0}
            onClick={() => setSweep(Math.max(0, sweep - 10))} title="−10">⟪</button>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep === 0}
            onClick={() => setSweep(Math.max(0, sweep - 1))} title="Prev sweep">◀</button>
          <span style={{
            display: 'inline-flex', minWidth: 60, justifyContent: 'center',
            color: 'var(--text-muted)',
          }}>Sweep {sweepLabel}</span>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep >= totalSweeps - 1}
            onClick={() => setSweep(Math.min(totalSweeps - 1, sweep + 1))}
            title="Next sweep">▶</button>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep >= totalSweeps - 1}
            onClick={() => setSweep(Math.min(totalSweeps - 1, sweep + 10))}
            title="+10">⟫</button>
          <button className="btn" style={{ padding: '2px 8px' }}
            disabled={totalSweeps === 0 || sweep >= totalSweeps - 1}
            onClick={() => setSweep(Math.max(0, totalSweeps - 1))}
            title="Last sweep">⟩⟩</button>
        </span>
      </div>

      {/* ───── Body: left sidebar + main ───── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left sidebar */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          borderRight: '1px solid var(--border)',
        }}>
          {/* Scrollable param region */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            padding: 10, display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <PreSourceCard form={form} onChange={updateForm} />
            <PostWindowCard form={form} onChange={updateForm} />
            <FailureThresholdCard form={form} onChange={updateForm} />
            <LatencyCard form={form} onChange={updateForm} />
          </div>
          {/* Pinned bottom: Run controls */}
          <div style={{
            flexShrink: 0, padding: 10, gap: 8,
            display: 'flex', flexDirection: 'column',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Run on</span>
              <select value={runMode} style={{ minWidth: 130 }}
                onChange={(e) => setRunMode(e.target.value as RunMode)}>
                <option value="all">All sweeps</option>
                <option value="range">Range</option>
                <option value="one">Single</option>
              </select>
            </label>
            {runMode === 'range' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>From</span>
                <NumInput value={sweepFrom} min={1} max={totalSweeps}
                  onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>to</span>
                <NumInput value={sweepTo} min={1} max={totalSweeps}
                  onChange={(v) => setSweepTo(Math.max(sweepFrom, Math.round(v)))}
                  style={{ width: 60 }} />
              </div>
            )}
            {runMode === 'one' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Sweep</span>
                <NumInput value={sweepOne} min={1} max={totalSweeps}
                  onChange={(v) => setSweepOne(Math.max(1, Math.min(totalSweeps, Math.round(v))))}
                  style={{ width: 60 }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={onRun}
                disabled={running || totalSweeps === 0}
                style={{ flex: 1 }}>
                {running ? 'Running…' : 'Run'}
              </button>
              <button className="btn"
                onClick={() => clearPairedAnalysis(group, series)}
                disabled={!stored}
                title="Clear stored results for this series">
                Clear
              </button>
            </div>
            {runError && (
              <div style={{
                color: '#e57373', fontSize: 'var(--font-size-label)',
                whiteSpace: 'pre-wrap',
              }}>{runError}</div>
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div onMouseDown={onSidebarDrag} style={{
          width: 4, cursor: 'col-resize', flexShrink: 0,
          background: 'transparent',
        }} />

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Stacked viewers */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <MiniViewer
              title={`Pre — ${channelOptions.find((c) => c.value === preTrace)?.label ?? `ch ${preTrace}`}`}
              data={preData}
              xRange={xRange}
              onXRangeChange={setXRange}
              color="#64b5f6"
              units={channels[preTrace]?.units ?? ''}
              detectionMarkers={stored && stored.preTrace === preTrace
                ? stored.perTrial.filter((t) => t.sweep === sweep).map((t) => t.preTS)
                : []}
            />
            <MiniViewer
              title={`Post — ${channelOptions.find((c) => c.value === postTrace)?.label ?? `ch ${postTrace}`}`}
              data={postData}
              xRange={xRange}
              onXRangeChange={setXRange}
              color="#81c784"
              units={channels[postTrace]?.units ?? ''}
              detectionMarkers={[]}
              postPeakMarkers={stored && stored.postTrace === postTrace
                ? stored.perTrial.filter((t) => t.sweep === sweep).map((t) => ({
                  t: t.postPeakTS, y: t.postPeak, success: t.success,
                }))
                : []}
            />
          </div>

          {/* Tab strip */}
          <div style={{
            flexShrink: 0, display: 'flex', gap: 4, padding: '6px 10px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}>
            {(['trials', 'statistics', 'sta'] as Tab[]).map((t) => (
              <button key={t} className="btn"
                onClick={() => setTab(t)}
                style={{
                  padding: '4px 14px',
                  background: tab === t ? 'var(--bg-primary)' : 'transparent',
                  borderColor: tab === t ? 'var(--accent)' : 'var(--border)',
                  textTransform: 'capitalize',
                }}>
                {t === 'sta' ? 'STA / Average' : t}
              </button>
            ))}
          </div>

          {/* Result region */}
          <div style={{
            flexShrink: 0, height: 280, overflow: 'auto',
            borderTop: '1px solid var(--border)',
          }}>
            {tab === 'trials' && <TrialsTab data={stored} />}
            {tab === 'statistics' && <StatisticsTab data={stored} />}
            {tab === 'sta' && <STATab data={stored} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top-bar selector
// ---------------------------------------------------------------------------

function Selector({
  label, value, onChange, options,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  options: { value: number; label: string }[]
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ minWidth: 80 }}>
        {options.length === 0 && <option value={0}>—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Param cards (left sidebar)
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        padding: '4px 8px', fontWeight: 600,
        fontSize: 'var(--font-size-label)',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
      }}>{title}</div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', flex: 1 }}>{label}</span>
      {children}
    </label>
  )
}

function PreSourceCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const setPP = (patch: Record<string, unknown>) =>
    onChange({ preParams: { ...form.preParams, ...patch } })
  return (
    <Card title="Pre-event source">
      <Row label="Mode">
        <select value={form.preMode} style={{ width: 140 }}
          onChange={(e) => onChange({ preMode: e.target.value as PairedFormState['preMode'] })}>
          <option value="ap">AP detect</option>
          <option value="stim">Stim artifact</option>
          <option value="ttl">TTL pulse</option>
          <option value="manual">Manual only</option>
        </select>
      </Row>
      {form.preMode === 'ap' && (
        <>
          <Row label="Method">
            <select value={String(form.preParams.ap_method ?? 'auto_rec')}
              onChange={(e) => setPP({ ap_method: e.target.value })}>
              <option value="auto_rec">Auto (recursive)</option>
              <option value="auto_spike">Auto (per-spike)</option>
              <option value="manual">Manual threshold</option>
            </select>
          </Row>
          <Row label="Min amp (mV)">
            <NumInput value={Number(form.preParams.ap_min_amplitude_mv ?? 50)}
              onChange={(v) => setPP({ ap_min_amplitude_mv: v })}
              style={{ width: 70 }} />
          </Row>
          <Row label="+dV/dt (mV/ms)">
            <NumInput value={Number(form.preParams.ap_pos_dvdt_mv_ms ?? 10)}
              onChange={(v) => setPP({ ap_pos_dvdt_mv_ms: v })}
              style={{ width: 70 }} />
          </Row>
          <Row label="Manual thr (mV)">
            <NumInput value={Number(form.preParams.ap_manual_threshold_mv ?? -10)}
              onChange={(v) => setPP({ ap_manual_threshold_mv: v })}
              style={{ width: 70 }} />
          </Row>
        </>
      )}
      {form.preMode === 'stim' && (
        <Row label="|d/dt| threshold (units/s)">
          <NumInput value={Number(form.preParams.stim_dvdt_threshold ?? 1.0e3)}
            onChange={(v) => setPP({ stim_dvdt_threshold: v })}
            style={{ width: 90 }} />
        </Row>
      )}
      {form.preMode === 'ttl' && (
        <>
          <Row label="Level threshold">
            <input type="checkbox"
              checked={form.preParams.ttl_level_threshold !== null && form.preParams.ttl_level_threshold !== undefined}
              onChange={(e) => setPP({
                ttl_level_threshold: e.target.checked ? 2.5 : null,
              })}
              title="Uncheck for auto threshold (midway between min and max)" />
            {form.preParams.ttl_level_threshold !== null && form.preParams.ttl_level_threshold !== undefined && (
              <NumInput value={Number(form.preParams.ttl_level_threshold)}
                onChange={(v) => setPP({ ttl_level_threshold: v })}
                style={{ width: 70 }} />
            )}
          </Row>
          <Row label="Edge">
            <select value={String(form.preParams.ttl_edge ?? 'rising')}
              onChange={(e) => setPP({ ttl_edge: e.target.value })}>
              <option value="rising">Rising</option>
              <option value="falling">Falling</option>
              <option value="both">Both</option>
            </select>
          </Row>
          <Row label="Min pulse (ms)">
            <NumInput value={Number(form.preParams.ttl_min_pulse_ms ?? 1.0)}
              onChange={(v) => setPP({ ttl_min_pulse_ms: v })}
              style={{ width: 70 }} />
          </Row>
        </>
      )}
      <Row label="Min distance (ms)">
        <NumInput value={Number(form.preParams.min_distance_ms ?? 5.0)}
          onChange={(v) => setPP({ min_distance_ms: v })}
          style={{ width: 70 }} />
      </Row>
      <Row label="Bounds start (s)">
        <NumInput value={Number(form.preParams.bounds_start_s ?? 0)}
          onChange={(v) => setPP({ bounds_start_s: v })}
          style={{ width: 70 }} />
      </Row>
      <Row label="Bounds end (s, 0=auto)">
        <NumInput value={Number(form.preParams.bounds_end_s ?? 0)}
          onChange={(v) => setPP({ bounds_end_s: v })}
          style={{ width: 70 }} />
      </Row>
    </Card>
  )
}

function PostWindowCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const set = (patch: Partial<PairedFormState['postParams']>) =>
    onChange({ postParams: { ...form.postParams, ...patch } })
  return (
    <Card title="Post window">
      <Row label="Pre-anchor (ms)">
        <NumInput value={form.postParams.preMs}
          onChange={(v) => set({ preMs: v })} style={{ width: 70 }} />
      </Row>
      <Row label="Post-anchor (ms)">
        <NumInput value={form.postParams.postMs}
          onChange={(v) => set({ postMs: v })} style={{ width: 70 }} />
      </Row>
      <Row label="Baseline (ms)">
        <NumInput value={form.postParams.baselineMs}
          onChange={(v) => set({ baselineMs: v })} style={{ width: 70 }} />
      </Row>
      <Row label="Peak direction">
        <select value={form.postParams.peakDirection}
          onChange={(e) => set({ peakDirection: e.target.value as any })}>
          <option value="auto">Auto</option>
          <option value="positive">Positive</option>
          <option value="negative">Negative</option>
        </select>
      </Row>
    </Card>
  )
}

function FailureThresholdCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const set = (patch: Partial<PairedFormState['failureParams']>) =>
    onChange({ failureParams: { ...form.failureParams, ...patch } })
  return (
    <Card title="Failure threshold">
      <Row label="Rule">
        <select value={form.failureParams.rule}
          onChange={(e) => set({ rule: e.target.value as any })}>
          <option value="k_sd">k × baseline SD</option>
          <option value="absolute">Absolute amplitude</option>
        </select>
      </Row>
      {form.failureParams.rule === 'k_sd' ? (
        <Row label="k">
          <NumInput value={form.failureParams.kSd}
            onChange={(v) => set({ kSd: v })} style={{ width: 70 }} />
        </Row>
      ) : (
        <Row label="|amplitude| ≥">
          <NumInput value={form.failureParams.absolute}
            onChange={(v) => set({ absolute: v })} style={{ width: 70 }} />
        </Row>
      )}
    </Card>
  )
}

function LatencyCard({
  form, onChange,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
}) {
  const set = (patch: Partial<PairedFormState['latencyParams']>) =>
    onChange({ latencyParams: { ...form.latencyParams, ...patch } })
  return (
    <Card title="Latency rule">
      <Row label="Method">
        <select value={form.latencyParams.rule}
          onChange={(e) => set({ rule: e.target.value as any })}>
          <option value="fraction">Fraction of peak</option>
          <option value="onset_d2">Onset (d²V/dt²)</option>
        </select>
      </Row>
      {form.latencyParams.rule === 'fraction' && (
        <Row label="Fraction">
          <NumInput value={form.latencyParams.fraction}
            onChange={(v) => set({ fraction: v })} style={{ width: 70 }} />
        </Row>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Mini-viewer (uPlot, rebuild-on-data, shared X via parent ref)
// ---------------------------------------------------------------------------

function MiniViewer({
  title, data, xRange, onXRangeChange, color, units,
  detectionMarkers, postPeakMarkers,
}: {
  title: string
  data: { time: number[]; values: number[] } | null
  xRange: [number, number] | null
  onXRangeChange: (r: [number, number] | null) => void
  color: string
  units: string
  detectionMarkers: number[]
  postPeakMarkers?: { t: number; y: number; success: boolean }[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const xRangeRef = useRef<[number, number] | null>(xRange)
  xRangeRef.current = xRange
  const detectionRef = useRef(detectionMarkers)
  detectionRef.current = detectionMarkers
  const postPeakRef = useRef(postPeakMarkers ?? [])
  postPeakRef.current = postPeakMarkers ?? []
  const onXRef = useRef(onXRangeChange)
  onXRef.current = onXRangeChange
  // Bumped on Reset / Fit Y so any disabled-state buttons re-render.
  const [, setVer] = useState(0)
  const bump = useCallback(() => setVer((n) => n + 1), [])

  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || !containerRef.current) return
    const accent = cssVar('--text-primary')
    const muted = cssVar('--text-muted')
    const border = cssVar('--border')
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      cursor: { drag: { setScale: false } },
      scales: {
        x: { range: (_u, dMin, dMax) => xRangeRef.current ?? [dMin, dMax] },
        y: { range: (_u, dMin, dMax) => yRangeRef.current ?? [dMin, dMax] },
      },
      axes: [
        { stroke: muted, grid: { stroke: border, width: 0.5 } },
        { stroke: muted, grid: { stroke: border, width: 0.5 },
          label: units, labelSize: 14, labelGap: 6, labelFont: '11px sans-serif',
        },
      ],
      hooks: {
        draw: [(u) => {
          // Detection marker dots (pre-event peaks).
          const ctx = u.ctx
          const markers = detectionRef.current
          if (markers.length > 0) {
            ctx.save()
            ctx.fillStyle = '#ffb74d'
            for (const t of markers) {
              const yIdx = bisect(data.time, t)
              if (yIdx < 0 || yIdx >= data.values.length) continue
              const px = u.valToPos(t, 'x', true)
              const py = u.valToPos(data.values[yIdx], 'y', true)
              ctx.beginPath()
              ctx.arc(px, py, 4, 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.restore()
          }
          // Post-peak markers (success = green, failure = red).
          const ppm = postPeakRef.current
          if (ppm.length > 0) {
            ctx.save()
            for (const m of ppm) {
              ctx.fillStyle = m.success ? '#66bb6a' : '#e57373'
              const px = u.valToPos(m.t, 'x', true)
              const py = u.valToPos(m.y, 'y', true)
              ctx.beginPath()
              ctx.arc(px, py, 3.5, 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.restore()
          }
        }],
      },
      series: [
        {},
        { stroke: color, width: 1, label: title, points: { show: false } },
      ],
    }
    plotRef.current = new uPlot(opts, [data.time, data.values], containerRef.current)
    if (yRangeRef.current === null) {
      // Auto-fit Y on first paint for this data.
      const arr = data.values
      let lo = Infinity, hi = -Infinity
      for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v }
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        const pad = (hi - lo) * 0.05
        yRangeRef.current = [lo - pad, hi + pad]
        plotRef.current?.redraw()
      }
    }
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
  }, [data, color, title, units, accent_for_theme()])

  // Wheel zoom + drag-to-pan + double-click reset.
  useEffect(() => {
    const cont = containerRef.current
    if (!cont || !data) return
    let drag: { x: number; t0: number; t1: number; y0: number; y1: number; panning: boolean } | null = null

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const u = plotRef.current
      if (!u) return
      const rect = cont.getBoundingClientRect()
      const px = e.clientX - rect.left
      const factor = e.deltaY < 0 ? 1 / 1.2 : 1.2
      if (e.altKey) {
        // Y zoom.
        const cur = yRangeRef.current
        if (!cur) return
        const py = e.clientY - rect.top
        const yV = u.posToVal(py, 'y')
        const lo = yV - (yV - cur[0]) * factor
        const hi = yV + (cur[1] - yV) * factor
        yRangeRef.current = [lo, hi]
        u.redraw()
        bump()
      } else {
        const cur = xRangeRef.current ?? [data.time[0], data.time[data.time.length - 1]]
        const xV = u.posToVal(px, 'x')
        const lo = xV - (xV - cur[0]) * factor
        const hi = xV + (cur[1] - xV) * factor
        onXRef.current([lo, hi])
      }
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const u = plotRef.current
      if (!u) return
      const rect = cont.getBoundingClientRect()
      const xR = xRangeRef.current ?? [data.time[0], data.time[data.time.length - 1]]
      const yR = yRangeRef.current ?? [0, 1]
      drag = {
        x: e.clientX - rect.left,
        t0: xR[0], t1: xR[1], y0: yR[0], y1: yR[1],
        panning: false,
      }
    }
    const onMove = (e: MouseEvent) => {
      if (!drag) return
      const u = plotRef.current
      if (!u) return
      const rect = cont.getBoundingClientRect()
      const dx = (e.clientX - rect.left) - drag.x
      if (!drag.panning && Math.abs(dx) < 3) return
      drag.panning = true
      const xPerPx = (drag.t1 - drag.t0) / Math.max(1, u.bbox.width / window.devicePixelRatio)
      const newLo = drag.t0 - dx * xPerPx
      const newHi = drag.t1 - dx * xPerPx
      onXRef.current([newLo, newHi])
    }
    const onUp = () => { drag = null }
    const onDbl = () => {
      onXRef.current(null)
      yRangeRef.current = null
      // Recompute Y autofit.
      const arr = data.values
      let lo = Infinity, hi = -Infinity
      for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v }
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        const pad = (hi - lo) * 0.05
        yRangeRef.current = [lo - pad, hi + pad]
      }
      plotRef.current?.redraw()
      bump()
    }

    cont.addEventListener('wheel', onWheel, { passive: false })
    cont.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    cont.addEventListener('dblclick', onDbl)
    return () => {
      cont.removeEventListener('wheel', onWheel)
      cont.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      cont.removeEventListener('dblclick', onDbl)
    }
  }, [data, bump])

  // Redraw when shared X range changes from outside.
  useEffect(() => {
    plotRef.current?.redraw()
  }, [xRange])

  // Resize observer keeps the plot sized to its container.
  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u) return
      u.setSize({ width: cont.clientWidth, height: cont.clientHeight })
    })
    ro.observe(cont)
    return () => ro.disconnect()
  }, [])

  // Header buttons.
  const onResetZoom = useCallback(() => {
    yRangeRef.current = null
    onXRef.current(null)
    if (data) {
      const arr = data.values
      let lo = Infinity, hi = -Infinity
      for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v }
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        const pad = (hi - lo) * 0.05
        yRangeRef.current = [lo - pad, hi + pad]
      }
    }
    plotRef.current?.redraw()
    bump()
  }, [data, bump])
  const onFitY = useCallback(() => {
    const u = plotRef.current
    if (!u || !data) return
    const xR = xRangeRef.current ?? [data.time[0], data.time[data.time.length - 1]]
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < data.time.length; i++) {
      if (data.time[i] < xR[0] || data.time[i] > xR[1]) continue
      const v = data.values[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (isFinite(lo) && isFinite(hi) && hi > lo) {
      const pad = (hi - lo) * 0.05
      yRangeRef.current = [lo - pad, hi + pad]
      u.redraw()
      bump()
    }
  }, [data, bump])

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 10px',
        background: 'var(--bg-secondary)',
        fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onFitY}
          style={{ padding: '2px 8px' }} title="Fit Y to visible X">Fit Y</button>
        <button className="btn" onClick={onResetZoom}
          style={{ padding: '2px 8px' }} title="Reset both axes (or double-click)">Reset zoom</button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }} />
    </div>
  )
}

function accent_for_theme() {
  // Reading any theme-driven CSS var counts as a dependency for the
  // outer effect; this trivial reader rebuilds the plot when theme
  // changes (text/border colours otherwise stale).
  return cssVar('--bg-primary')
}

function bisect(arr: number[], t: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m] < t) lo = m + 1; else hi = m
  }
  return lo
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return n.toFixed(decimals)
}

function TrialsTab({ data }: { data: PairedData | null }) {
  if (!data) {
    return <Empty msg="Run analysis to see trials." />
  }
  return (
    <div style={{ padding: 8 }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)',
      }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
            <Th>Sweep</Th>
            <Th>#</Th>
            <Th>pre t (s)</Th>
            <Th>amp</Th>
            <Th>success</Th>
            <Th>latency (ms)</Th>
            <Th>rise (ms)</Th>
            <Th>decay (ms)</Th>
            <Th>baseline σ</Th>
            <Th>truncated</Th>
          </tr>
        </thead>
        <tbody>
          {data.perTrial.map((t, i) => (
            <tr key={i}
              style={{ background: t.success ? 'transparent' : 'rgba(229,115,115,0.08)' }}>
              <Td>{t.sweep + 1}</Td>
              <Td>{t.trialIdx + 1}{t.manual ? '*' : ''}</Td>
              <Td>{fmt(t.preTS, 4)}</Td>
              <Td>{fmt(t.amplitude)}</Td>
              <Td style={{ color: t.success ? '#66bb6a' : '#e57373' }}>
                {t.success ? 'yes' : 'no'}
              </Td>
              <Td>{fmt(t.latencyMs)}</Td>
              <Td>{fmt(t.riseMs)}</Td>
              <Td>{fmt(t.decayMs)}</Td>
              <Td>{fmt(t.baselineSd, 3)}</Td>
              <Td>{t.truncated ? 'yes' : ''}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatisticsTab({ data }: { data: PairedData | null }) {
  if (!data) {
    return <Empty msg="Run analysis to see statistics." />
  }
  const s = data.seriesSummary
  const items: { label: string; value: string }[] = [
    { label: 'n trials',           value: String(s.nTrials) },
    { label: 'n successes',        value: String(s.nSuccess) },
    { label: 'n failures',         value: String(s.nFailures) },
    { label: 'failure rate',       value: fmt(s.failureRate, 3) },
    { label: 'mean amplitude',     value: fmt(s.meanAmplitude) },
    { label: 'mean amp (zero-fail)', value: fmt(s.meanAmplitudeZeroed) },
    { label: 'potency',            value: fmt(s.potency) },
    { label: 'CV (success)',       value: fmt(s.cvSuccess, 3) },
    { label: '1 / CV²',            value: fmt(s.invCv2, 2) },
    { label: 'latency mean (ms)',  value: fmt(s.latencyMeanMs, 2) },
    { label: 'jitter (ms, SD)',    value: fmt(s.latencySdMs, 3) },
  ]
  return (
    <div style={{ padding: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 320 }}>
        <table style={{
          fontSize: 'var(--font-size-label)', borderCollapse: 'collapse',
        }}>
          <tbody>
            {items.map((it) => (
              <tr key={it.label}>
                <td style={{ color: 'var(--text-muted)', padding: '2px 12px 2px 0' }}>{it.label}</td>
                <td style={{ padding: '2px 0', fontFamily: 'monospace' }}>{it.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.pprN1.length > 0 && (
        <div>
          <div style={{
            fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            marginBottom: 4,
          }}>Paired-pulse ratios (pulse_N / pulse_1, success-1 only)</div>
          <table style={{
            fontSize: 'var(--font-size-label)', borderCollapse: 'collapse',
          }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <Th>N</Th><Th>ratio</Th><Th>n sweeps</Th>
              </tr>
            </thead>
            <tbody>
              {s.pprN1.map((p) => (
                <tr key={p.n}>
                  <Td>{p.n}</Td>
                  <Td>{fmt(p.ratio, 3)}</Td>
                  <Td>{p.nSweeps}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function STATab({ data }: { data: PairedData | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  type Series = 'all' | 'success' | 'failure'
  const [seriesPick, setSeriesPick] = useState<Series>('all')

  const sta = data
    ? (seriesPick === 'success' ? data.staSuccess
       : seriesPick === 'failure' ? data.staFailure
       : data.staAll)
    : null

  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!sta || !containerRef.current) return
    const muted = cssVar('--text-muted')
    const border = cssVar('--border')
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    const upper = sta.mean.map((m, i) => m + sta.sem[i])
    const lower = sta.mean.map((m, i) => m - sta.sem[i])
    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      cursor: { drag: { setScale: false } },
      axes: [
        { stroke: muted, grid: { stroke: border, width: 0.5 },
          label: 'time vs t_pre (s)', labelSize: 14, labelGap: 6,
          labelFont: '11px sans-serif',
        },
        { stroke: muted, grid: { stroke: border, width: 0.5 } },
      ],
      series: [
        {},
        { stroke: '#9e9e9e', width: 0.5, label: '+SEM', points: { show: false } },
        { stroke: '#9e9e9e', width: 0.5, label: '−SEM', points: { show: false } },
        { stroke: '#64b5f6', width: 1.5, label: `STA (n=${sta.n})`, points: { show: false } },
      ],
    }
    plotRef.current = new uPlot(opts, [
      sta.time, upper, lower, sta.mean,
    ], containerRef.current)
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
  }, [sta])

  if (!data) return <Empty msg="Run analysis to see the spike-triggered average." />
  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 6, fontSize: 'var(--font-size-label)' }}>
        {(['all', 'success', 'failure'] as Series[]).map((k) => (
          <button key={k} className="btn" onClick={() => setSeriesPick(k)}
            style={{
              padding: '2px 10px',
              background: seriesPick === k ? 'var(--bg-primary)' : 'transparent',
              borderColor: seriesPick === k ? 'var(--accent)' : 'var(--border)',
              textTransform: 'capitalize',
            }}>{k}</button>
        ))}
        <span style={{ color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 12 }}>
          {sta ? `n = ${sta.n}` : '—'}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, marginTop: 6 }} />
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontStyle: 'italic',
      fontSize: 'var(--font-size-label)',
    }}>
      {msg}
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '2px 10px 2px 0', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '2px 10px 2px 0', fontFamily: 'monospace', ...(style ?? {}) }}>{children}</td>
)
