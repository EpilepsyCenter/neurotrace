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
  // Each fetch carries its channel's pre-detection filter params
  // (when enabled) so the displayed trace matches what detection
  // sees. Re-fetches when any filter knob changes, so the user sees
  // the effect of toggling the filter live.
  const [preData, setPreData] = useState<{ time: number[]; values: number[] } | null>(null)
  const [postData, setPostData] = useState<{ time: number[]; values: number[] } | null>(null)

  // Pre filter params live snake_case'd inside ``preParams``; post
  // is camelCase via the typed PostParams. Pull both into a stable
  // signature for the effect's dependency list so the fetch only
  // re-runs when something actually changed.
  const preFilterEnabled = Boolean(form.preParams.filter_enabled ?? false)
  const preFilterType = String(form.preParams.filter_type ?? 'lowpass')
  const preFilterLow = Number(form.preParams.filter_low ?? 0)
  const preFilterHigh = Number(form.preParams.filter_high ?? 0)
  const preFilterOrder = Number(form.preParams.filter_order ?? 4)

  useEffect(() => {
    let cancelled = false
    const fetchOne = async (
      traceIdx: number,
      filter: {
        enabled: boolean
        type: string
        low: number
        high: number
        order: number
      },
      setter: (v: { time: number[]; values: number[] } | null) => void,
    ) => {
      try {
        const params = new URLSearchParams({
          group: String(group), series: String(series),
          sweep: String(sweep), trace: String(traceIdx),
          max_points: '4000',
        })
        if (filter.enabled) {
          params.set('filter_type', filter.type)
          params.set('filter_low', String(filter.low))
          params.set('filter_high', String(filter.high))
          params.set('filter_order', String(filter.order))
        }
        const r = await fetch(`${backendUrl}/api/traces/data?${params}`)
        if (!r.ok) { setter(null); return }
        const d = await r.json()
        if (cancelled) return
        setter({ time: d.time as number[], values: d.values as number[] })
      } catch {
        if (!cancelled) setter(null)
      }
    }
    if (totalSweeps > 0 && channels.length > 0) {
      fetchOne(preTrace, {
        enabled: preFilterEnabled, type: preFilterType,
        low: preFilterLow, high: preFilterHigh, order: preFilterOrder,
      }, setPreData)
      if (preTrace !== postTrace) {
        fetchOne(postTrace, {
          enabled: form.postParams.filterEnabled,
          type: form.postParams.filterType,
          low: form.postParams.filterLow,
          high: form.postParams.filterHigh,
          order: form.postParams.filterOrder,
        }, setPostData)
      } else {
        setPostData(null)
      }
    }
    return () => { cancelled = true }
  }, [
    backendUrl, group, series, sweep, preTrace, postTrace,
    totalSweeps, channels.length,
    preFilterEnabled, preFilterType, preFilterLow, preFilterHigh, preFilterOrder,
    form.postParams.filterEnabled, form.postParams.filterType,
    form.postParams.filterLow, form.postParams.filterHigh, form.postParams.filterOrder,
  ])

  // ---- Shared X axis ----
  // Parent owns the single source of truth for the X range. Both
  // viewers read this and write through ``setXRange`` so wheel-zoom
  // / pan on either drives both in lockstep.
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  // Reset shared X when we switch series.
  useEffect(() => { setXRange(null) }, [group, series])

  // ---- Post-detection bounds (analysis cursors on the post viewer) ----
  // ``null`` start = no clip (use post_ms only). When both are set,
  // peak search per trial is intersected with [start, end] in
  // absolute sweep time. Persisted per-series as part of PairedData
  // so the cursors survive series switches and Run.
  const [postBounds, setPostBounds] = useState<{ start: number | null; end: number | null }>(
    { start: null, end: null },
  )
  // Show/hide checkboxes for the cursor bands on the (now combined)
  // viewer. Defaults to off — users opt-in. ``showPostBounds`` ties
  // to whether the bounds are actually applied to detection.
  const [showPreBounds, setShowPreBounds] = useState(false)
  const [showPostBounds, setShowPostBounds] = useState(false)
  // Hydrate post-bounds from a stored entry on series change.
  useEffect(() => {
    const stored = pairedAnalyses[`${group}:${series}`]
    if (stored && stored.postSearchStartS != null && stored.postSearchEndS != null) {
      setPostBounds({
        start: stored.postSearchStartS,
        end: stored.postSearchEndS,
      })
    } else {
      setPostBounds({ start: null, end: null })
    }
  }, [group, series, pairedAnalyses])

  // ---- Splitter heights / widths (persisted in Electron prefs) ----
  // ``topHeight`` = pixel height of the viewers area; result region
  // takes whatever's below. ``leftPanelWidth`` = sidebar pixel width.
  // Both hydrate from ``pairedWindowUI`` on mount and write back at
  // mouseup to avoid spamming prefs writes during the drag.
  const [topHeight, setTopHeight] = useState(360)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.pairedWindowUI?.topHeight
        if (!cancelled && typeof saved === 'number' && saved >= 150 && saved <= 800) {
          setTopHeight(saved)
        }
        const savedW = prefs?.pairedWindowUI?.leftPanelWidth
        if (!cancelled && typeof savedW === 'number' && savedW >= 240 && savedW <= 600) {
          setLeftPanelWidth(savedW)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const writePairedUIPref = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.pairedWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, pairedWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onTopSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = topHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      latest = Math.max(150, Math.min(800, startH + dy))
      setTopHeight(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writePairedUIPref({ topHeight: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [topHeight, writePairedUIPref])

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
          // Optional absolute-time clip from the post-search cursors.
          // Only applied when the user has the cursors visible —
          // unchecking the box treats them as inactive even if the
          // numeric values are still in state. Backend treats null /
          // undefined as "no clip".
          post_search_start_s: showPostBounds ? postBounds.start : null,
          post_search_end_s:   showPostBounds ? postBounds.end   : null,
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
          decayTauMs: t.decay_tau_ms,
          halfWidthMs: t.half_width_ms,
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
        staAll: mapSta(d.sta_all),
        staSuccess: mapSta(d.sta_success),
        staFailure: mapSta(d.sta_failure),
        selectedTrialIdx: null,
        postSearchStartS: postBounds.start,
        postSearchEndS: postBounds.end,
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
  const onSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      latest = Math.max(240, Math.min(600, startW + dx))
      setLeftPanelWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writePairedUIPref({ leftPanelWidth: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftPanelWidth, writePairedUIPref])

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
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 0, padding: 8 }}>
        {/* Left sidebar — same shell shape as APWindow's left panel:
            bg-secondary tone, padded, bordered, with a scrollable param
            region above a pinned Run-controls card. */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8,
          borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          {/* Scrollable param sections. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            <PreSourceCard form={form} onChange={updateForm}
              showBounds={showPreBounds}
              setShowBounds={setShowPreBounds} />
            <PostWindowCard form={form} onChange={updateForm}
              bounds={postBounds}
              onBoundsChange={setPostBounds}
              showBounds={showPostBounds}
              setShowBounds={setShowPostBounds} />
            <FailureThresholdCard form={form} onChange={updateForm} />
            <LatencyCard form={form} onChange={updateForm} />
          </div>
          {/* Pinned footer: Run controls — same chrome as the AP / FPsp
              run footer (bordered card with primary Run button + small
              Clear secondary, sweep-scope dropdown progressively
              disclosing range / single rows). */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={running || totalSweeps === 0}
              style={{
                width: '100%', padding: '8px 0',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
              }}>
              {running ? 'Running…' : 'Run'}
            </button>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Run on</span>
              <select value={runMode} style={{ minWidth: 130 }}
                onChange={(e) => setRunMode(e.target.value as RunMode)}>
                <option value="all">All sweeps</option>
                <option value="range">Range</option>
                <option value="one">Single</option>
              </select>
            </label>
            {runMode === 'range' && (
              <div style={{
                display: 'flex', gap: 6, alignItems: 'center',
                fontSize: 'var(--font-size-label)',
              }}>
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
              <div style={{
                display: 'flex', gap: 6, alignItems: 'center',
                fontSize: 'var(--font-size-label)',
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Sweep</span>
                <NumInput value={sweepOne} min={1} max={totalSweeps}
                  onChange={(v) => setSweepOne(Math.max(1, Math.min(totalSweeps, Math.round(v))))}
                  style={{ width: 60 }} />
              </div>
            )}
            <button className="btn"
              onClick={() => clearPairedAnalysis(group, series)}
              disabled={!stored}
              style={{
                fontSize: 'var(--font-size-label)', padding: '4px 10px',
              }}
              title="Clear stored results for this series">
              Clear results
            </button>
            {runError && (
              <div style={{
                color: '#e57373', fontSize: 'var(--font-size-label)',
                whiteSpace: 'pre-wrap',
              }}>{runError}</div>
            )}
          </div>
        </div>

        {/* Vertical splitter between sidebar and main column. */}
        <div onMouseDown={onSidebarDrag} style={{
          width: 4, cursor: 'col-resize', flexShrink: 0,
          background: 'var(--border)',
          marginLeft: 4, marginRight: 4,
        }} />

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Single overlay viewer — pre on left Y axis, post on right
              Y axis. Fixed pixel height driven by the row-resize
              splitter below. */}
          <div style={{
            height: topHeight, minHeight: 180, flexShrink: 0,
            display: 'flex', flexDirection: 'column', minWidth: 0,
          }}>
            <OverlayViewer
              preData={preData}
              postData={postData}
              preColor="#64b5f6"
              postColor="#81c784"
              preUnits={channels[preTrace]?.units ?? ''}
              postUnits={channels[postTrace]?.units ?? ''}
              xRange={xRange}
              onXRangeChange={setXRange}
              heightSignal={topHeight}
              detectionMarkers={stored && stored.preTrace === preTrace
                ? stored.perTrial
                    .filter((t) => t.sweep === sweep)
                    .map((t) => ({ t: t.preTS, manual: t.manual }))
                : []}
              postPeakMarkers={stored && stored.postTrace === postTrace
                ? stored.perTrial.filter((t) => t.sweep === sweep).map((t) => ({
                  t: t.postPeakTS, y: t.postPeak, success: t.success,
                }))
                : []}
              preBounds={{
                start: Number(form.preParams.bounds_start_s ?? 0),
                end:   Number(form.preParams.bounds_end_s ?? 0),
              }}
              onPreBoundsChange={(next) => updateForm({
                preParams: {
                  ...form.preParams,
                  bounds_start_s: next.start,
                  bounds_end_s: next.end,
                },
              })}
              showPreBounds={showPreBounds}
              postBounds={postBounds}
              onPostBoundsChange={setPostBounds}
              showPostBounds={showPostBounds}
            />
          </div>
          {/* Horizontal splitter between viewers and result region. */}
          <div onMouseDown={onTopSplitMouseDown} style={{
            height: 4, cursor: 'row-resize', flexShrink: 0,
            background: 'var(--border)',
          }} />

          {/* Tab strip — AP-style: flex bar with a hairline bottom
              border that the active tab "joins" via a 3 px accent
              underline + matching bg-primary tone. */}
          <div style={{
            flexShrink: 0, display: 'flex', gap: 2,
            borderBottom: '1px solid var(--border)',
            alignItems: 'flex-end',
            padding: '0 8px',
            background: 'var(--bg-secondary)',
          }}>
            {(['trials', 'statistics', 'sta'] as Tab[]).map((t) => {
              const label = t === 'trials' ? 'Trials'
                : t === 'statistics' ? 'Statistics'
                : 'STA / Average'
              const active = tab === t
              return (
                <button key={t} className="btn"
                  onClick={() => setTab(t)}
                  style={{
                    padding: '8px 22px',
                    borderBottomLeftRadius: 0,
                    borderBottomRightRadius: 0,
                    borderBottom: active ? '3px solid var(--accent, #4a90e2)' : '3px solid transparent',
                    marginBottom: -1,
                    background: active ? 'var(--bg-primary)' : 'transparent',
                    color: active ? 'var(--accent, #4a90e2)' : 'var(--text-muted)',
                    fontWeight: active ? 700 : 500,
                    fontSize: 'var(--font-size-sm)',
                    fontFamily: 'var(--font-ui)',
                  }}>{label}</button>
              )
            })}
          </div>

          {/* Result region — absorbs whatever's below the splitter. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden',
            background: 'var(--bg-secondary)',
            display: 'flex', flexDirection: 'column',
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
//
// Match the AP / Events / FPsp convention: each card is a single
// bordered + rounded two-column grid; section dividers come from
// ``SubHeader`` strips with a hairline top border. ``Field`` wraps a
// label-above-input pair for dropdowns; ``ParamRow`` does the same
// with a fixed-width NumInput so columns line up vertically across
// cards.
// ---------------------------------------------------------------------------

function ParamGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: 8, padding: 8,
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function ParamRow({
  label, value, step, min, max, onChange,
}: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span className="selector-label" style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange}
        style={{ width: 110 }} />
    </label>
  )
}

/** Pre-detection filter row — used inside both pre and post param
 *  cards. Reads / writes whatever shape the parent passes in (pre
 *  uses snake_case keys, post uses camelCase via PostParams), so the
 *  caller wires this up via getter / setter callbacks. */
function FilterRow({
  enabled, type, low, high, order, onChange,
}: {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  low: number
  high: number
  order: number
  onChange: (patch: {
    enabled?: boolean
    type?: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
    low?: number
    high?: number
    order?: number
  }) => void
}) {
  return (
    <>
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}>
        <input type="checkbox" checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span>Pre-detection filter</span>
      </label>
      {enabled && (
        <>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Type">
              <select value={type}
                onChange={(e) => onChange({ type: e.target.value as any })}>
                <option value="lowpass">Lowpass</option>
                <option value="highpass">Highpass</option>
                <option value="bandpass">Bandpass</option>
                <option value="notch">Notch</option>
              </select>
            </Field>
          </div>
          {(type === 'highpass' || type === 'bandpass' || type === 'notch') && (
            <ParamRow label="Low (Hz)"
              value={low} step={1} min={0}
              onChange={(v) => onChange({ low: v })} />
          )}
          {(type === 'lowpass' || type === 'bandpass' || type === 'notch') && (
            <ParamRow label="High (Hz)"
              value={high} step={50} min={1}
              onChange={(v) => onChange({ high: v })} />
          )}
          <ParamRow label="Order"
            value={order} step={1} min={1} max={8}
            onChange={(v) => onChange({ order: Math.max(1, Math.min(8, Math.round(v))) })} />
        </>
      )}
    </>
  )
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      gridColumn: '1 / -1',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--text-muted)',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      paddingTop: 4,
      borderTop: '1px solid var(--border)',
      marginTop: 4,
    }}>{children}</div>
  )
}

function PreSourceCard({
  form, onChange, showBounds, setShowBounds,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
  showBounds: boolean
  setShowBounds: (v: boolean) => void
}) {
  const setPP = (patch: Record<string, unknown>) =>
    onChange({ preParams: { ...form.preParams, ...patch } })
  return (
    <ParamGrid>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Pre-event source">
          <select value={form.preMode}
            onChange={(e) => onChange({ preMode: e.target.value as PairedFormState['preMode'] })}>
            <option value="ap">AP detect</option>
            <option value="stim">Stim artifact</option>
            <option value="ttl">TTL pulse</option>
            <option value="manual">Manual only</option>
          </select>
        </Field>
      </div>

      {form.preMode === 'ap' && (
        <>
          <SubHeader>AP detection</SubHeader>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Method">
              <select value={String(form.preParams.ap_method ?? 'auto_rec')}
                onChange={(e) => setPP({ ap_method: e.target.value })}>
                <option value="auto_rec">Auto (adaptive)</option>
                <option value="auto_spike">Auto (single pass)</option>
                <option value="manual">Manual threshold</option>
              </select>
            </Field>
          </div>
          {String(form.preParams.ap_method ?? 'auto_rec') === 'manual' ? (
            <ParamRow label="Manual threshold (mV)"
              value={Number(form.preParams.ap_manual_threshold_mv ?? -10)}
              step={5}
              onChange={(v) => setPP({ ap_manual_threshold_mv: v })} />
          ) : (
            <>
              <ParamRow label="Min amplitude (mV)"
                value={Number(form.preParams.ap_min_amplitude_mv ?? 50)} step={5} min={0}
                onChange={(v) => setPP({ ap_min_amplitude_mv: v })} />
              <ParamRow label="+dV/dt (mV/ms)"
                value={Number(form.preParams.ap_pos_dvdt_mv_ms ?? 10)} step={1} min={0}
                onChange={(v) => setPP({ ap_pos_dvdt_mv_ms: v })} />
              <ParamRow label="−dV/dt (mV/ms)"
                value={Number(form.preParams.ap_neg_dvdt_mv_ms ?? -10)} step={1}
                onChange={(v) => setPP({ ap_neg_dvdt_mv_ms: v })} />
              <ParamRow label="Max width (ms)"
                value={Number(form.preParams.ap_width_ms ?? 5)} step={0.5} min={0.1}
                onChange={(v) => setPP({ ap_width_ms: v })} />
            </>
          )}
        </>
      )}

      {form.preMode === 'stim' && (
        <>
          <SubHeader>Stim artifact</SubHeader>
          <ParamRow label="|d/dt| threshold (units/s)"
            value={Number(form.preParams.stim_dvdt_threshold ?? 1.0e3)} step={100}
            onChange={(v) => setPP({ stim_dvdt_threshold: v })} />
        </>
      )}

      {form.preMode === 'ttl' && (
        <>
          <SubHeader>TTL pulse</SubHeader>
          <label style={{
            gridColumn: '1 / -1',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 'var(--font-size-label)',
          }}
            title="Uncheck for auto threshold (midway between sweep min and max)">
            <input type="checkbox"
              checked={form.preParams.ttl_level_threshold !== null
                && form.preParams.ttl_level_threshold !== undefined}
              onChange={(e) => setPP({ ttl_level_threshold: e.target.checked ? 2.5 : null })} />
            <span>Manual level threshold</span>
          </label>
          {form.preParams.ttl_level_threshold !== null
            && form.preParams.ttl_level_threshold !== undefined && (
            <ParamRow label="Level threshold"
              value={Number(form.preParams.ttl_level_threshold)} step={0.5}
              onChange={(v) => setPP({ ttl_level_threshold: v })} />
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Edge">
              <select value={String(form.preParams.ttl_edge ?? 'rising')}
                onChange={(e) => setPP({ ttl_edge: e.target.value })}>
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </div>
          <ParamRow label="Min pulse (ms)"
            value={Number(form.preParams.ttl_min_pulse_ms ?? 1.0)} step={0.5} min={0}
            onChange={(v) => setPP({ ttl_min_pulse_ms: v })} />
        </>
      )}

      <SubHeader>Filter</SubHeader>
      <FilterRow
        enabled={Boolean(form.preParams.filter_enabled ?? false)}
        type={(form.preParams.filter_type as any) ?? 'lowpass'}
        low={Number(form.preParams.filter_low ?? 1)}
        high={Number(form.preParams.filter_high ?? 1000)}
        order={Number(form.preParams.filter_order ?? 1)}
        onChange={(p) => setPP({
          ...(p.enabled !== undefined ? { filter_enabled: p.enabled } : {}),
          ...(p.type !== undefined ? { filter_type: p.type } : {}),
          ...(p.low !== undefined ? { filter_low: p.low } : {}),
          ...(p.high !== undefined ? { filter_high: p.high } : {}),
          ...(p.order !== undefined ? { filter_order: p.order } : {}),
        })}
      />

      <SubHeader>Spacing & bounds</SubHeader>
      <ParamRow label="Min distance (ms)"
        value={Number(form.preParams.min_distance_ms ?? 5.0)} step={0.5} min={0.1}
        onChange={(v) => setPP({ min_distance_ms: v })} />
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}
        title="Show pre-detection analysis bounds on the viewer. Drag the cursors or edit the start/end values below.">
        <input type="checkbox" checked={showBounds}
          onChange={(e) => setShowBounds(e.target.checked)} />
        <span>Show pre-detection cursors</span>
      </label>
      <ParamRow label="Start (ms)"
        value={Number(form.preParams.bounds_start_s ?? 0) * 1000} step={5} min={0}
        onChange={(v) => setPP({ bounds_start_s: Math.max(0, v / 1000) })} />
      <ParamRow label="End (ms, 0=auto)"
        value={Number(form.preParams.bounds_end_s ?? 0) * 1000} step={5} min={0}
        onChange={(v) => setPP({ bounds_end_s: Math.max(0, v / 1000) })} />
    </ParamGrid>
  )
}

function PostWindowCard({
  form, onChange,
  bounds, onBoundsChange, showBounds, setShowBounds,
}: {
  form: PairedFormState
  onChange: (patch: Partial<PairedFormState>) => void
  bounds: { start: number | null; end: number | null }
  onBoundsChange: (next: { start: number | null; end: number | null }) => void
  showBounds: boolean
  setShowBounds: (v: boolean) => void
}) {
  const set = (patch: Partial<PairedFormState['postParams']>) =>
    onChange({ postParams: { ...form.postParams, ...patch } })
  const startMs = bounds.start != null ? bounds.start * 1000 : 0
  const endMs   = bounds.end   != null ? bounds.end   * 1000 : 0
  return (
    <ParamGrid>
      <SubHeader>Post window</SubHeader>
      <ParamRow label="Pre-anchor (ms)"
        value={form.postParams.preMs} step={0.5} min={0}
        onChange={(v) => set({ preMs: v })} />
      <ParamRow label="Post-anchor (ms)"
        value={form.postParams.postMs} step={1} min={0.1}
        onChange={(v) => set({ postMs: v })} />
      <ParamRow label="Baseline (ms)"
        value={form.postParams.baselineMs} step={0.5} min={0.1}
        onChange={(v) => set({ baselineMs: v })} />
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Peak direction">
          <select value={form.postParams.peakDirection}
            onChange={(e) => set({ peakDirection: e.target.value as any })}>
            <option value="auto">Auto</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
          </select>
        </Field>
      </div>

      <SubHeader>Filter</SubHeader>
      <FilterRow
        enabled={form.postParams.filterEnabled}
        type={form.postParams.filterType}
        low={form.postParams.filterLow}
        high={form.postParams.filterHigh}
        order={form.postParams.filterOrder}
        onChange={(p) => set({
          ...(p.enabled !== undefined ? { filterEnabled: p.enabled } : {}),
          ...(p.type !== undefined ? { filterType: p.type } : {}),
          ...(p.low !== undefined ? { filterLow: p.low } : {}),
          ...(p.high !== undefined ? { filterHigh: p.high } : {}),
          ...(p.order !== undefined ? { filterOrder: p.order } : {}),
        })}
      />

      <SubHeader>Search cursors</SubHeader>
      <label style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 'var(--font-size-label)',
      }}
        title="When checked, peak detection per trial is clipped to the [start, end] window in absolute sweep time. Drag the cursors on the viewer or edit the values below.">
        <input type="checkbox" checked={showBounds}
          onChange={(e) => {
            const v = e.target.checked
            setShowBounds(v)
            if (v && (bounds.start == null || bounds.end == null)) {
              // Seed default cursors at 100–500 ms — sensible for
              // typical paired-recording protocols. User adjusts.
              onBoundsChange({
                start: bounds.start ?? 0.10,
                end: bounds.end ?? 0.50,
              })
            }
          }} />
        <span>Show post-search cursors</span>
      </label>
      <ParamRow label="Start (ms)"
        value={startMs} step={5}
        onChange={(v) => onBoundsChange({ start: v / 1000, end: bounds.end })} />
      <ParamRow label="End (ms)"
        value={endMs} step={5}
        onChange={(v) => onBoundsChange({ start: bounds.start, end: v / 1000 })} />
    </ParamGrid>
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
    <ParamGrid>
      <SubHeader>Failure threshold</SubHeader>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Rule">
          <select value={form.failureParams.rule}
            onChange={(e) => set({ rule: e.target.value as any })}>
            <option value="k_sd">k × baseline SD</option>
            <option value="absolute">Absolute amplitude</option>
          </select>
        </Field>
      </div>
      {form.failureParams.rule === 'k_sd' ? (
        <ParamRow label="k"
          value={form.failureParams.kSd} step={0.5} min={0}
          onChange={(v) => set({ kSd: v })} />
      ) : (
        <ParamRow label="|amplitude| ≥"
          value={form.failureParams.absolute} step={1} min={0}
          onChange={(v) => set({ absolute: v })} />
      )}
    </ParamGrid>
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
    <ParamGrid>
      <SubHeader>Latency rule</SubHeader>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Method">
          <select value={form.latencyParams.rule}
            onChange={(e) => set({ rule: e.target.value as any })}>
            <option value="fraction">Fraction of peak</option>
            <option value="onset_d2">Onset (d²V/dt²)</option>
          </select>
        </Field>
      </div>
      {form.latencyParams.rule === 'fraction' && (
        <ParamRow label="Fraction"
          value={form.latencyParams.fraction} step={0.05} min={0} max={1}
          onChange={(v) => set({ fraction: v })} />
      )}
    </ParamGrid>
  )
}

// ---------------------------------------------------------------------------
// Mini-viewer (uPlot, rebuild-on-data, shared X via parent ref)
// ---------------------------------------------------------------------------

const BOUND_COLOR = '#64b5f6'    // analysis-bounds band (post viewer)
const PRE_MARKER_COLOR = '#ffb74d'
const SUCCESS_COLOR = '#66bb6a'
const FAILURE_COLOR = '#e57373'
const MARKER_RADIUS = 5          // matches AP / Bursts spike-marker size
const MARKER_RING_RADIUS = 9     // for manually-added markers
const BAND_EDGE_PX = 6           // grab tolerance on bounds edges
const DRAG_THRESHOLD_PX = 3      // click-vs-drag

/**
 * Overlay viewer — single uPlot showing pre + post on the same X axis
 * with two independent Y axes (left = pre, right = post). Replaces
 * the old stacked-mini-viewer arrangement so the user can read latencies
 * across both channels without eye-jumping.
 *
 * Conventions copied from the main TraceViewer / AP sweep viewer:
 *
 * - ``cursor.drag.{x,y}: false`` disables uPlot's native rectangle
 *   selection. Wheel + pointer-drag are wired by hand on ``.u-over``.
 * - All zoom / pan goes through ``u.setScale(scale, {min, max})`` so
 *   the same frame's draw call sees the new range. Plain ``redraw()``
 *   doesn't re-evaluate ``scales.*.range()`` callbacks.
 * - X axis values are stored in seconds; the bottom axis displays them
 *   as milliseconds via the ``values:`` formatter. ``time: false`` on
 *   the X scale stops uPlot from formatting them as Unix dates.
 * - Marker dots match AP / Bursts: 5 px radius, 1.2 px white outline;
 *   manual ones get a 9 px ring. Pre-event dots ride the ``y`` scale,
 *   post-peak dots ride ``y_post`` so they sit on the right-axis trace.
 *
 * Bounds bands (analysis-bounds cursors) are drawn for both pre and
 * post when their show-flag is true. Both sets of edges + bodies are
 * drag-targets; pre uses an orange band, post uses blue, so they're
 * easy to tell apart when they overlap.
 */
function OverlayViewer({
  preData, postData,
  preColor, postColor,
  preUnits, postUnits,
  xRange, onXRangeChange, heightSignal,
  detectionMarkers, postPeakMarkers,
  preBounds, onPreBoundsChange, showPreBounds,
  postBounds, onPostBoundsChange, showPostBounds,
}: {
  preData: { time: number[]; values: number[] } | null
  postData: { time: number[]; values: number[] } | null
  preColor: string
  postColor: string
  preUnits: string
  postUnits: string
  xRange: [number, number] | null
  onXRangeChange: (r: [number, number] | null) => void
  heightSignal?: number
  detectionMarkers: { t: number; manual: boolean }[]
  postPeakMarkers?: { t: number; y: number; success: boolean }[]
  preBounds: { start: number; end: number }
  onPreBoundsChange: (next: { start: number; end: number }) => void
  showPreBounds: boolean
  postBounds: { start: number | null; end: number | null }
  onPostBoundsChange: (next: { start: number | null; end: number | null }) => void
  showPostBounds: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Y ranges per scale (left = pre, right = post). X is shared with
  // the parent via xRangeRef + onXRangeChange.
  const yPreRangeRef = useRef<[number, number] | null>(null)
  const yPostRangeRef = useRef<[number, number] | null>(null)
  const xRangeRef = useRef<[number, number] | null>(xRange)
  xRangeRef.current = xRange
  // Refs that the draw hook + pointer handlers read so we don't have
  // to rebuild the plot when these change frame-to-frame.
  const detectionRef = useRef(detectionMarkers)
  detectionRef.current = detectionMarkers
  const postPeakRef = useRef(postPeakMarkers ?? [])
  postPeakRef.current = postPeakMarkers ?? []
  const preBoundsRef = useRef(preBounds)
  preBoundsRef.current = preBounds
  const postBoundsRef = useRef(postBounds)
  postBoundsRef.current = postBounds
  const showPreBoundsRef = useRef(showPreBounds)
  showPreBoundsRef.current = showPreBounds
  const showPostBoundsRef = useRef(showPostBounds)
  showPostBoundsRef.current = showPostBounds
  const onXRef = useRef(onXRangeChange)
  onXRef.current = onXRangeChange
  const onPreBoundsRef = useRef(onPreBoundsChange)
  onPreBoundsRef.current = onPreBoundsChange
  const onPostBoundsRef = useRef(onPostBoundsChange)
  onPostBoundsRef.current = onPostBoundsChange
  const [, setVer] = useState(0)
  const bump = useCallback(() => setVer((n) => n + 1), [])

  // ── Build / rebuild the plot ───────────────────────────────────
  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!containerRef.current) return
    if (!preData && !postData) return

    // Use pre's time grid as the master X array. Interpolate post
    // onto it so uPlot can plot both as parallel series. When pre
    // is missing, fall back to post's grid as the X.
    const masterT = preData?.time ?? postData!.time
    const preY: (number | null)[] = preData
      ? preData.values.map((v) => v)
      : new Array(masterT.length).fill(null)
    const postY: (number | null)[] = postData
      ? interpolateOnto(postData.time, postData.values, masterT)
      : new Array(masterT.length).fill(null)

    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight

    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      legend: { show: false },
      // ``cursor.focus.prox`` is uPlot's series-focus mechanism: when
      // the cursor sits within ``prox`` pixels of a series sample,
      // that series becomes "focused" and the others get drawn at
      // ``series[i].alpha`` (kept in our ``setSeries`` hook below).
      // Same UX as the main TraceViewer.
      cursor: {
        drag: { x: false, y: false },
        focus: { prox: 30 },
      },
      scales: {
        x: {
          time: false,
          range: (_u, dMin, dMax) => xRangeRef.current ?? [dMin, dMax],
        },
        y: {
          range: (_u, dMin, dMax) => {
            if (yPreRangeRef.current) return yPreRangeRef.current
            if (!isFinite(dMin) || !isFinite(dMax) || dMin === dMax) return [0, 1]
            const pad = (dMax - dMin) * 0.05
            const r: [number, number] = [dMin - pad, dMax + pad]
            yPreRangeRef.current = r
            return r
          },
        },
        y_post: {
          range: (_u, dMin, dMax) => {
            if (yPostRangeRef.current) return yPostRangeRef.current
            if (!isFinite(dMin) || !isFinite(dMax) || dMin === dMax) return [0, 1]
            const pad = (dMax - dMin) * 0.05
            const r: [number, number] = [dMin - pad, dMax + pad]
            yPostRangeRef.current = r
            return r
          },
        },
      },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          values: (_u, splits) => splits.map((s) => fmtMs(s * 1000)),
          label: 'Time (ms)', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: preColor,
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: `Pre (${preUnits || 'Vm'})`, labelSize: 22,
          scale: 'y',
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: postColor,
          grid: { show: false },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: `Post (${postUnits || 'I'})`, labelSize: 22,
          scale: 'y_post', side: 1,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
      ],
      hooks: {
        draw: [(u) => drawOverlay(u)],
        // Series-focus dim: when uPlot picks a focused series via
        // ``cursor.focus.prox``, drop the other trace's stroke alpha
        // so the hovered one stands out. Reset on unfocus so both
        // come back to full opacity. Triggers a redraw via
        // ``u.redraw()`` so the canvas re-renders with the new alpha.
        setSeries: [
          (u, focusedIdx) => {
            for (let i = 1; i < u.series.length; i++) {
              const dimmed = focusedIdx != null && i !== focusedIdx
              ;(u.series[i] as any).alpha = dimmed ? 0.25 : 1
            }
            u.redraw()
          },
        ],
      },
      series: [
        {},
        { stroke: preColor, width: 1.25, label: 'Pre',
          scale: 'y', points: { show: false } },
        { stroke: postColor, width: 1.25, label: 'Post',
          scale: 'y_post', points: { show: false } },
      ],
    }
    plotRef.current = new uPlot(opts, [masterT, preY, postY] as any, containerRef.current)
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preData, postData, preColor, postColor, preUnits, postUnits])

  function drawOverlay(u: uPlot) {
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const top = u.bbox.top
    const bottom = u.bbox.top + u.bbox.height

    // Bounds bands.
    const drawBand = (x0: number, x1: number, fill: string, label: string) => {
      const px0 = u.valToPos(x0, 'x', true)
      const px1 = u.valToPos(x1, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.14
      ctx.fillStyle = fill
      ctx.fillRect(Math.min(px0, px1), top, Math.abs(px1 - px0), bottom - top)
      ctx.globalAlpha = 1
      ctx.fillStyle = fill
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, top + 12 * dpr)
      ctx.restore()
    }
    if (showPreBoundsRef.current) {
      const b = preBoundsRef.current
      const xMax = u.scales.x.max ?? b.start
      const effEnd = b.end > b.start ? b.end : xMax
      drawBand(b.start, effEnd, '#ffb74d', 'pre bounds')
    }
    if (showPostBoundsRef.current) {
      const b = postBoundsRef.current
      if (b.start != null) {
        const xMax = u.scales.x.max ?? b.start
        const effEnd = b.end != null ? b.end : xMax
        drawBand(b.start, effEnd, '#64b5f6', 'post-search bounds')
      }
    }

    // Marker drawing helper — shared between pre-event dots and
    // post-peak dots. ``scaleKey`` picks which Y axis the marker's
    // y value is positioned against.
    const dot = (px: number, py: number, fill: string, ring: boolean) => {
      ctx.beginPath()
      ctx.arc(px, py, MARKER_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = fill; ctx.fill()
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.stroke()
      if (ring) {
        ctx.beginPath()
        ctx.arc(px, py, MARKER_RING_RADIUS, 0, Math.PI * 2)
        ctx.strokeStyle = fill; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }
    // Detection markers (pre-event peaks) — sample the pre series
    // at marker time so dots ride the visible trace.
    const markers = detectionRef.current
    if (markers.length > 0 && preData) {
      ctx.save()
      for (const m of markers) {
        const idx = bisect(preData.time, m.t)
        if (idx < 0 || idx >= preData.values.length) continue
        const px = u.valToPos(m.t, 'x', true)
        const py = u.valToPos(preData.values[idx], 'y', true)
        dot(px, py, PRE_MARKER_COLOR, m.manual)
      }
      ctx.restore()
    }
    // Post-peak markers (success / failure) — y is in post units, so
    // route through the y_post scale.
    const ppm = postPeakRef.current
    if (ppm.length > 0) {
      ctx.save()
      for (const m of ppm) {
        const px = u.valToPos(m.t, 'x', true)
        const py = u.valToPos(m.y, 'y_post', true)
        dot(px, py, m.success ? SUCCESS_COLOR : FAILURE_COLOR, false)
      }
      ctx.restore()
    }
  }

  // ── Pointer + wheel ───────────────────────────────────────────
  useEffect(() => {
    const cont = containerRef.current
    if (!cont || !plotRef.current) return
    if (!preData && !postData) return
    const u = plotRef.current
    const over = cont.querySelector<HTMLDivElement>('.u-over')
    if (!over) return

    type Drag =
      | { kind: 'maybe-pan'; startX: number; startY: number; xMin: number; xMax: number; yKey: 'y' | 'y_post'; yMin: number; yMax: number; panning: boolean }
      | { kind: 'pre-edge'; which: 'start' | 'end' }
      | { kind: 'pre-band'; startX: number; startStart: number; startEnd: number }
      | { kind: 'post-edge'; which: 'start' | 'end' }
      | { kind: 'post-band'; startX: number; startStart: number; startEnd: number }
    let drag: Drag | null = null
    const xToPx = (x: number) => u.valToPos(x, 'x', false)
    const pxToX = (px: number) => u.posToVal(px, 'x')

    // Pick the Y axis the cursor is currently nearest to — same
    // approach as the main TraceViewer's ``pickYScale``: at the
    // cursor's X, locate each series's sample point and pick
    // whichever sits closer in canvas pixels to the cursor's Y.
    const pickYScale = (cssX: number, cssY: number): 'y' | 'y_post' => {
      const xs = u.data[0] as number[] | undefined
      if (!xs || xs.length === 0) return 'y'
      const xVal = u.posToVal(cssX, 'x')
      if (!isFinite(xVal)) return 'y'
      let lo = 0, hi = xs.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (xs[mid] < xVal) lo = mid + 1
        else hi = mid
      }
      const sampleIdx = lo
      let bestKey: 'y' | 'y_post' = 'y'
      let bestDist = Infinity
      for (let i = 1; i < u.series.length; i++) {
        const s = u.series[i]
        const sk = (s.scale ?? 'y') as string
        if (sk !== 'y' && sk !== 'y_post') continue
        const arr = u.data[i] as (number | null)[] | undefined
        if (!arr) continue
        const v = arr[sampleIdx]
        if (v == null || !isFinite(v)) continue
        const py = u.valToPos(v, sk as any, false)
        const d = Math.abs(py - cssY)
        if (d < bestDist) { bestDist = d; bestKey = sk as 'y' | 'y_post' }
      }
      return bestKey
    }

    const findHit = (pxX: number): Drag | null => {
      // Test post bounds first (drawn on top, more interactive).
      if (showPostBoundsRef.current) {
        const b = postBoundsRef.current
        if (b.start != null) {
          const startPx = xToPx(b.start)
          const endVal = b.end != null ? b.end : (u.scales.x.max ?? b.start)
          const endPx = xToPx(endVal)
          if (Math.abs(pxX - startPx) <= BAND_EDGE_PX) return { kind: 'post-edge', which: 'start' }
          if (b.end != null && Math.abs(pxX - endPx) <= BAND_EDGE_PX) return { kind: 'post-edge', which: 'end' }
          if (pxX > Math.min(startPx, endPx) + BAND_EDGE_PX
              && pxX < Math.max(startPx, endPx) - BAND_EDGE_PX) {
            return {
              kind: 'post-band', startX: pxX,
              startStart: b.start,
              startEnd: b.end != null ? b.end : (u.scales.x.max ?? b.start),
            }
          }
        }
      }
      if (showPreBoundsRef.current) {
        const b = preBoundsRef.current
        const startPx = xToPx(b.start)
        const endVal = b.end > b.start ? b.end : (u.scales.x.max ?? b.start)
        const endPx = xToPx(endVal)
        if (Math.abs(pxX - startPx) <= BAND_EDGE_PX) return { kind: 'pre-edge', which: 'start' }
        if (b.end > b.start && Math.abs(pxX - endPx) <= BAND_EDGE_PX) return { kind: 'pre-edge', which: 'end' }
        if (pxX > Math.min(startPx, endPx) + BAND_EDGE_PX
            && pxX < Math.max(startPx, endPx) - BAND_EDGE_PX) {
          return {
            kind: 'pre-band', startX: pxX,
            startStart: b.start, startEnd: b.end > b.start ? b.end : endVal,
          }
        }
      }
      return null
    }

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const hit = findHit(pxX)
      if (hit) {
        drag = hit
      } else {
        // Pick the Y axis to pan based on cursor proximity at
        // mousedown — sticky for the whole drag so panning across
        // the other trace doesn't switch axes mid-drag.
        const yKey = pickYScale(pxX, pxY)
        const ys = (u.scales as any)[yKey]
        drag = {
          kind: 'maybe-pan',
          startX: pxX, startY: pxY,
          xMin: u.scales.x.min ?? 0, xMax: u.scales.x.max ?? 1,
          yKey,
          yMin: ys?.min ?? 0, yMax: ys?.max ?? 1,
          panning: false,
        }
      }
      try { over.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
    }
    const onPointerMove = (ev: PointerEvent) => {
      const rect = over.getBoundingClientRect()
      if (!drag) {
        const hit = findHit(ev.clientX - rect.left)
        over.style.cursor = hit
          ? (hit.kind.endsWith('-edge') ? 'ew-resize' : 'grab')
          : ''
        return
      }
      if (drag.kind === 'pre-edge') {
        const t = pxToX(ev.clientX - rect.left)
        const cur = preBoundsRef.current
        const next = { ...cur }
        if (drag.which === 'start') next.start = Math.max(0, t)
        else next.end = Math.max(0, t)
        if (next.start > next.end && next.end > 0) {
          [next.start, next.end] = [next.end, next.start]
          drag.which = drag.which === 'start' ? 'end' : 'start'
        }
        onPreBoundsRef.current(next)
        u.redraw()
      } else if (drag.kind === 'pre-band') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const xMin = u.scales.x.min ?? 0
        const xMax = u.scales.x.max ?? 1
        const xPerPx = (xMax - xMin) / Math.max(1, u.bbox.width / (devicePixelRatio || 1))
        const dx = dxPx * xPerPx
        onPreBoundsRef.current({
          start: Math.max(0, drag.startStart + dx),
          end: Math.max(0, drag.startEnd + dx),
        })
        u.redraw()
      } else if (drag.kind === 'post-edge') {
        const t = pxToX(ev.clientX - rect.left)
        const cur = postBoundsRef.current
        const next = { ...cur }
        if (drag.which === 'start') next.start = t
        else next.end = t
        if (next.start != null && next.end != null && next.start > next.end) {
          [next.start, next.end] = [next.end, next.start]
          drag.which = drag.which === 'start' ? 'end' : 'start'
        }
        onPostBoundsRef.current(next)
        u.redraw()
      } else if (drag.kind === 'post-band') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const xMin = u.scales.x.min ?? 0
        const xMax = u.scales.x.max ?? 1
        const xPerPx = (xMax - xMin) / Math.max(1, u.bbox.width / (devicePixelRatio || 1))
        const dx = dxPx * xPerPx
        onPostBoundsRef.current({
          start: drag.startStart + dx,
          end: drag.startEnd + dx,
        })
        u.redraw()
      } else if (drag.kind === 'maybe-pan') {
        const dxPx = (ev.clientX - rect.left) - drag.startX
        const dyPx = (ev.clientY - rect.top) - drag.startY
        if (!drag.panning) {
          if (Math.abs(dxPx) < DRAG_THRESHOLD_PX && Math.abs(dyPx) < DRAG_THRESHOLD_PX) return
          drag.panning = true
          over.style.cursor = 'grabbing'
        }
        const bboxW = u.bbox.width / (devicePixelRatio || 1)
        const bboxH = u.bbox.height / (devicePixelRatio || 1)
        // X is shared between traces — pan affects both. The Y pan
        // sticks to the axis picked at mousedown, so the user can
        // shift one trace vertically without dragging the other.
        const dxX = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
        const dyY = (dyPx / bboxH) * (drag.yMax - drag.yMin)
        const nx: [number, number] = [drag.xMin + dxX, drag.xMax + dxX]
        const ny: [number, number] = [drag.yMin + dyY, drag.yMax + dyY]
        xRangeRef.current = nx
        if (drag.yKey === 'y') yPreRangeRef.current = ny
        else yPostRangeRef.current = ny
        u.setScale('x', { min: nx[0], max: nx[1] })
        u.setScale(drag.yKey, { min: ny[0], max: ny[1] })
        onXRef.current(nx)
      }
    }
    const onPointerUp = () => { drag = null; over.style.cursor = '' }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      if (ev.altKey) {
        // Y zoom — picks whichever axis the cursor is closest to so
        // the user can zoom each trace independently. Hover the
        // trace you want, ⌥-scroll. Same pattern as the main
        // TraceViewer's pickYScale-driven wheel.
        const key = pickYScale(pxX, pxY)
        const sMin = (u.scales as any)[key].min, sMax = (u.scales as any)[key].max
        if (sMin == null || sMax == null) return
        const yAtCur = u.posToVal(pxY, key as any)
        const newMin = yAtCur - (yAtCur - sMin) * factor
        const newMax = yAtCur + (sMax - yAtCur) * factor
        if (key === 'y') yPreRangeRef.current = [newMin, newMax]
        else yPostRangeRef.current = [newMin, newMax]
        u.setScale(key as any, { min: newMin, max: newMax })
      } else {
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        if (xMin == null || xMax == null) return
        const xAtCur = u.posToVal(pxX, 'x')
        const newMin = xAtCur - (xAtCur - xMin) * factor
        const newMax = xAtCur + (xMax - xAtCur) * factor
        xRangeRef.current = [newMin, newMax]
        u.setScale('x', { min: newMin, max: newMax })
        onXRef.current([newMin, newMax])
      }
    }
    const onDbl = () => doResetZoom()

    over.addEventListener('pointerdown', onPointerDown)
    over.addEventListener('pointermove', onPointerMove)
    over.addEventListener('pointerup', onPointerUp)
    over.addEventListener('pointercancel', onPointerUp)
    over.addEventListener('wheel', onWheel, { passive: false })
    over.addEventListener('dblclick', onDbl)
    return () => {
      over.removeEventListener('pointerdown', onPointerDown)
      over.removeEventListener('pointermove', onPointerMove)
      over.removeEventListener('pointerup', onPointerUp)
      over.removeEventListener('pointercancel', onPointerUp)
      over.removeEventListener('wheel', onWheel)
      over.removeEventListener('dblclick', onDbl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preData, postData])

  // Apply parent-driven X range changes (after a sibling triggers
  // them — though there's no sibling now, the prop still routes here
  // for cross-window cursor sync).
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    if (xRange) {
      u.setScale('x', { min: xRange[0], max: xRange[1] })
    } else {
      const t = preData?.time ?? postData?.time
      if (t && t.length > 1) u.setScale('x', { min: t[0], max: t[t.length - 1] })
    }
  }, [xRange, preData, postData])

  // Redraw on overlay-data changes (refs already hold the values).
  useEffect(() => { plotRef.current?.redraw() },
    [detectionMarkers, postPeakMarkers,
     preBounds, postBounds, showPreBounds, showPostBounds])

  // Resize handling — observer + parent splitter signal.
  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u) return
      const w = cont.clientWidth, h = cont.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(cont)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [heightSignal])

  // Compute & apply Y autofit. ``scale`` picks which Y axis to act
  // on; ``preserveX`` controls whether X stays put (Fit Y) or also
  // resets (Reset zoom).
  const fitY = useCallback((scale: 'y' | 'y_post' | 'both', preserveX: boolean) => {
    const u = plotRef.current
    if (!u) return
    const scales: Array<'y' | 'y_post'> = scale === 'both' ? ['y', 'y_post'] : [scale]
    let xLo: number, xHi: number
    const masterT = preData?.time ?? postData?.time
    if (!masterT || masterT.length === 0) return
    if (preserveX) {
      xLo = u.scales.x.min ?? masterT[0]
      xHi = u.scales.x.max ?? masterT[masterT.length - 1]
    } else {
      xLo = masterT[0]; xHi = masterT[masterT.length - 1]
      xRangeRef.current = null
      u.setScale('x', { min: xLo, max: xHi })
      onXRef.current(null)
    }
    for (const s of scales) {
      const src = s === 'y' ? preData : postData
      if (!src) continue
      let yLo = Infinity, yHi = -Infinity
      for (let i = 0; i < src.time.length; i++) {
        const t = src.time[i]
        if (t < xLo || t > xHi) continue
        const v = src.values[i]
        if (v < yLo) yLo = v
        if (v > yHi) yHi = v
      }
      if (!isFinite(yLo) || !isFinite(yHi) || yHi <= yLo) continue
      const pad = (yHi - yLo) * 0.05
      const ny: [number, number] = [yLo - pad, yHi + pad]
      if (s === 'y') yPreRangeRef.current = ny; else yPostRangeRef.current = ny
      u.setScale(s, { min: ny[0], max: ny[1] })
    }
    bump()
  }, [preData, postData, bump])

  const doResetZoom = useCallback(() => fitY('both', false), [fitY])
  const onFitYPre = useCallback(() => fitY('y', true), [fitY])
  const onFitYPost = useCallback(() => fitY('y_post', true), [fitY])
  const onResetZoom = doResetZoom

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--bg-primary)', position: 'relative',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <ChannelSwatch color={preColor} label="Pre" />
        <ChannelSwatch color={postColor} label="Post" />
        <PairedMarkerLegend role="overlay" />
        <button className="btn" onClick={onFitYPre}
          style={{ marginLeft: 'auto', padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Fit Y on the pre (left) axis to currently-visible X">Fit Y (pre)</button>
        <button className="btn" onClick={onFitYPost}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Fit Y on the post (right) axis to currently-visible X">Fit Y (post)</button>
        <button className="btn" onClick={onResetZoom}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Reset both Y axes + X to data bounds (also: double-click)">Reset zoom</button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }} />
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y (nearest trace) · drag = pan X + nearest Y · drag bounds edge to resize · double-click = reset
      </div>
    </div>
  )
}

/** Linear interpolation of (srcT, srcY) onto refT. Both srcT and refT
 *  must be sorted ascending. Out-of-range refT values get clamped to
 *  the source endpoints rather than NaN — keeps the line continuous
 *  when the two channels were LTTB'd to slightly different time
 *  arrays. */
function interpolateOnto(srcT: number[], srcY: number[], refT: number[]): number[] {
  const out: number[] = new Array(refT.length)
  if (srcT.length === 0) {
    for (let i = 0; i < refT.length; i++) out[i] = NaN
    return out
  }
  let j = 0
  for (let i = 0; i < refT.length; i++) {
    const t = refT[i]
    if (t <= srcT[0]) { out[i] = srcY[0]; continue }
    if (t >= srcT[srcT.length - 1]) { out[i] = srcY[srcY.length - 1]; continue }
    while (j < srcT.length - 1 && srcT[j + 1] < t) j++
    const t0 = srcT[j], t1 = srcT[j + 1]
    const y0 = srcY[j], y1 = srcY[j + 1]
    const f = (t - t0) / Math.max(1e-12, t1 - t0)
    out[i] = y0 + f * (y1 - y0)
  }
  return out
}

/** Channel colour swatch + label for the overlay viewer's header. */
function ChannelSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        display: 'inline-block', width: 14, height: 3,
        background: color,
      }} />
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{label}</span>
    </span>
  )
}

/** Tiny inline legend matching the AP / Events marker convention —
 *  small coloured dots with one-word labels, mono font, muted text. */
function PairedMarkerLegend({ role }: { role: 'pre' | 'post' | 'overlay' }) {
  const items =
    role === 'pre' ? [{ color: '#ffb74d', label: 'pre event' }]
    : role === 'post' ? [
      { color: '#66bb6a', label: 'success' },
      { color: '#e57373', label: 'failure' },
    ]
    : [
      { color: '#ffb74d', label: 'pre event' },
      { color: '#66bb6a', label: 'success' },
      { color: '#e57373', label: 'failure' },
    ]
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%', background: it.color,
          }} />
          <span>{it.label}</span>
        </span>
      ))}
    </span>
  )
}

/** Format a number of milliseconds for an axis tick — keeps the
 *  precision short so labels don't overlap. Trailing zeros after the
 *  decimal point are trimmed; integers come out unsuffixed. */
function fmtMs(ms: number): string {
  if (!isFinite(ms)) return ''
  const abs = Math.abs(ms)
  // Pick decimals based on magnitude — typical uPlot tick spacing on
  // a sweep window of seconds means ticks are every 50–500 ms; sub-
  // millisecond ticks only show up when the user zooms way in.
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3
  const s = ms.toFixed(decimals)
  return s.replace(/\.?0+$/, '')
}

/** Convert a backend STA payload into the camelCase ``PairedSta``
 *  shape stored in the frontend. Returns null for null inputs. */
function mapSta(s: any): import('../../stores/appStore').PairedSta | null {
  if (!s) return null
  return {
    time: s.time, mean: s.mean, sem: s.sem, n: s.n,
    traces: s.traces, traceSuccess: s.trace_success,
  }
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
  const headers = [
    'Sweep', '#', 'pre t (s)', 'amplitude',
    'success', 'latency (ms)', 'rise (ms)', 'decay (ms)',
    'τ_decay (ms)', 'half-width (ms)',
    'baseline σ', 'truncated',
  ]
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%', margin: 8,
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{
            background: 'var(--bg-secondary)', textAlign: 'left',
            position: 'sticky', top: 0,
          }}>
            {headers.map((h, i) => <Th key={i}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {data.perTrial.map((t, i) => (
            <tr key={i}
              style={{
                borderTop: '1px solid var(--border)',
                background: t.success ? 'transparent' : 'rgba(229,115,115,0.08)',
              }}>
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
              <Td>{fmt(t.decayTauMs)}</Td>
              <Td>{fmt(t.halfWidthMs)}</Td>
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
    { label: 'n trials',             value: String(s.nTrials) },
    { label: 'n successes',          value: String(s.nSuccess) },
    { label: 'n failures',           value: String(s.nFailures) },
    { label: 'failure rate',         value: fmt(s.failureRate, 3) },
    { label: 'mean amplitude',       value: fmt(s.meanAmplitude) },
    { label: 'mean amp (zero-fail)', value: fmt(s.meanAmplitudeZeroed) },
    { label: 'potency',              value: fmt(s.potency) },
    { label: 'CV (success)',         value: fmt(s.cvSuccess, 3) },
    { label: '1 / CV²',              value: fmt(s.invCv2, 2) },
    { label: 'latency mean (ms)',    value: fmt(s.latencyMeanMs, 2) },
    { label: 'jitter (ms, SD)',      value: fmt(s.latencySdMs, 3) },
  ]
  return (
    <div style={{
      padding: 8, display: 'flex', gap: 8, flexWrap: 'wrap',
      height: '100%', boxSizing: 'border-box',
    }}>
      <div style={{
        flex: '1 1 320px', minWidth: 320,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', overflow: 'auto',
      }}>
        <div style={{
          padding: '4px 10px', fontSize: 'var(--font-size-label)',
          fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>Series summary</div>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
        }}>
          <tbody>
            {items.map((it) => (
              <tr key={it.label} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{
                  color: 'var(--text-muted)', padding: '3px 10px',
                  whiteSpace: 'nowrap',
                }}>{it.label}</td>
                <td style={{ padding: '3px 10px', textAlign: 'right' }}>{it.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{
        flex: '1 1 260px', minWidth: 260,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', overflow: 'auto',
      }}>
        <div style={{
          padding: '4px 10px', fontSize: 'var(--font-size-label)',
          fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>Paired-pulse ratios</div>
        {s.pprN1.length === 0 ? (
          <div style={{
            padding: 12, color: 'var(--text-muted)',
            fontStyle: 'italic', fontSize: 'var(--font-size-label)',
          }}>
            Sweeps need ≥ 2 pre-events with pulse 1 = success to contribute.
          </div>
        ) : (
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
          }}>
            <thead>
              <tr style={{
                background: 'var(--bg-secondary)', textAlign: 'left',
                position: 'sticky', top: 0,
              }}>
                <Th>Pulse N</Th><Th>ratio (N / 1)</Th><Th>n sweeps</Th>
              </tr>
            </thead>
            <tbody>
              {s.pprN1.map((p) => (
                <tr key={p.n} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td>{p.n}</Td>
                  <Td>{fmt(p.ratio, 3)}</Td>
                  <Td>{p.nSweeps}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function STATab({ data }: { data: PairedData | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  type SeriesPick = 'all' | 'success' | 'failure'
  const [seriesPick, setSeriesPick] = useState<SeriesPick>('all')
  const [showOverlay, setShowOverlay] = useState(false)
  const [overlayIncludesFailures, setOverlayIncludesFailures] = useState(false)

  const sta = data
    ? (seriesPick === 'success' ? data.staSuccess
       : seriesPick === 'failure' ? data.staFailure
       : data.staAll)
    : null

  useEffect(() => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!sta || !containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    const upper = sta.mean.map((m, i) => m + sta.sem[i])
    const lower = sta.mean.map((m, i) => m - sta.sem[i])

    // Optional individual-sweep overlay. Each row of ``traces`` becomes
    // its own faint series; failure rows are filtered out unless the
    // user opted in.
    const overlayRows: { values: number[]; success: boolean }[] = []
    if (showOverlay && sta.traces && sta.traceSuccess) {
      for (let i = 0; i < sta.traces.length; i++) {
        const ok = sta.traceSuccess[i]
        if (!overlayIncludesFailures && !ok) continue
        overlayRows.push({ values: sta.traces[i], success: ok })
      }
    }

    // Series order: x · +SEM · −SEM · overlays (failures first so
    // they paint underneath successes) · MEAN on top.
    const series: uPlot.Series[] = [
      {},
      { stroke: '#9e9e9e', width: 0.5, label: '+SEM', points: { show: false } },
      { stroke: '#9e9e9e', width: 0.5, label: '−SEM', points: { show: false } },
    ]
    const overlayValues: number[][] = []
    // Sort failures-first so successes paint over them.
    overlayRows.sort((a, b) => Number(a.success) - Number(b.success))
    for (const r of overlayRows) {
      series.push({
        stroke: r.success ? 'rgba(100,181,246,0.35)' : 'rgba(229,115,115,0.35)',
        width: 0.5, points: { show: false },
      })
      overlayValues.push(r.values)
    }
    series.push({
      stroke: '#64b5f6', width: 1.75,
      label: `Mean (n=${sta.n})`, points: { show: false },
    })

    const opts: uPlot.Options = {
      width: Math.max(200, w),
      height: Math.max(80, h),
      cursor: { drag: { x: false, y: false }, focus: { prox: 30 } },
      legend: { show: false },
      scales: {
        // ``time: false`` — same fix as the OverlayViewer; without it
        // uPlot interprets the X numbers as Unix timestamps and
        // shows dates on the axis. Underlying values stay in seconds
        // (relative to t_pre, so they're already small) and the
        // ``values`` formatter converts to ms for display.
        x: { time: false },
      },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          values: (_u, splits) => splits.map((s) => fmtMs(s * 1000)),
          label: 'Time relative to pre-event (ms)', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Post amplitude', labelSize: 22,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-ui')}` },
      ],
      series,
    }
    plotRef.current = new uPlot(opts, [
      sta.time, upper, lower, ...overlayValues, sta.mean,
    ] as any, containerRef.current)
    return () => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    }
  }, [sta, showOverlay, overlayIncludesFailures])

  if (!data) return <Empty msg="Run analysis to see the spike-triggered average." />
  return (
    <div style={{
      padding: 8, display: 'flex', flexDirection: 'column',
      height: '100%', boxSizing: 'border-box',
    }}>
      {/* Header strip — segmented picker + overlay toggles, mono
          font, hairline border, same chrome as the viewer header. */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        flexWrap: 'wrap',
        padding: '3px 8px',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>STA / Average</span>
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {(['all', 'success', 'failure'] as SeriesPick[]).map((k) => {
            const active = seriesPick === k
            const label = k === 'all' ? 'All trials'
              : k === 'success' ? 'Successes only' : 'Failures only'
            return (
              <button key={k} className="btn" onClick={() => setSeriesPick(k)}
                style={{
                  padding: '2px 10px',
                  fontSize: 'var(--font-size-label)',
                  background: active ? 'var(--bg-primary)' : 'transparent',
                  borderColor: active ? 'var(--accent, #4a90e2)' : 'var(--border)',
                  color: active ? 'var(--accent, #4a90e2)' : 'inherit',
                  fontWeight: active ? 600 : 400,
                }}>{label}</button>
            )
          })}
        </span>
        {/* Overlay toggles. ``Show sweeps`` superimposes every aligned
            trial as a faint trace; ``include failures`` decides
            whether 0-amplitude / sub-threshold trials appear in red.
            Both default off so the average is uncluttered on first
            view. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title="Overlay each individual trial's post-window aligned to t_pre, in the same colour scheme as the success / failure dots.">
          <input type="checkbox" checked={showOverlay}
            onChange={(e) => setShowOverlay(e.target.checked)} />
          Show sweeps
        </label>
        {showOverlay && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="When unchecked, only successful trials are overlaid. Failures usually sit near baseline and clutter the picture.">
            <input type="checkbox" checked={overlayIncludesFailures}
              onChange={(e) => setOverlayIncludesFailures(e.target.checked)} />
            Include failures
          </label>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {sta ? `n = ${sta.n}` : 'no trials'}
        </span>
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0, marginTop: 6,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }} />
      {/* Inline note: explain the two grey lines flanking the mean.
          Spelled out fully because the ribbon convention isn't
          obvious from the picture alone. */}
      <div style={{
        flexShrink: 0, marginTop: 4,
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 4,
      }}>
        Blue line: per-sample mean across the {seriesPick === 'all' ? 'selected' : seriesPick} trials. Grey lines: ±1 SEM
        (standard error of the mean), i.e. the per-sample SD divided
        by √n. They give a confidence band for the average — narrow
        bands = the trials cluster tightly around the mean, wide bands
        = the average is dominated by trial-to-trial variability.
      </div>
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
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)
