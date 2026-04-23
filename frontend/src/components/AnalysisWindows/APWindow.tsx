import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  APData, APDetectionMethod, APDetectionParams, APKineticsParams,
  APThresholdMethod, APRampParams, APRheobaseMode, APManualEdits,
  APPoint,
} from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { ImSourceCard } from '../common/ImSourceCard'
import { ChannelsOverlaySelect, STIMULUS_OVERLAY_KEY } from '../common/ChannelsOverlaySelect'
import { OverlayTraceViewer, OverlayChannel } from '../common/OverlayTraceViewer'

/**
 * Action Potentials analysis window.
 *
 * One detection stage feeds three tabs:
 * - **Counting** — spikes/sweep, F-I curve, rheobase.
 * - **Kinetics** — per-spike table (threshold, peak, amp, rise/decay,
 *   FWHM, fAHP, mAHP, max rise/decay slopes). 8 threshold methods.
 * - **Phase plot** — Vm vs dV/dt for one spike at a time.
 *
 * Mini-viewer on the left shows the current preview sweep with
 * draggable analysis-bounds bands + spike markers. Tab-specific
 * results panel on the right.
 *
 * Persistence: `apAnalyses[group:series]`. Auto-seed series on window
 * reopen from the saved entry's series.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const BOUND_COLOR = '#64b5f6'    // analysis-bounds bands (blue)
const SPIKE_COLOR = '#e57373'    // detected spike peak dots
const MANUAL_COLOR = '#ffb74d'   // manually-added spike ring

// Default detection params — match what `analysis/ap.py` falls back to
// when fields are missing. Values picked to work on a typical 10 kHz
// current-clamp recording with healthy spikes (~100 mV amplitude).
const DEFAULT_DETECTION: APDetectionParams = {
  method: 'auto_rec',
  manual_threshold_mv: -10,
  min_amplitude_mv: 50,
  pos_dvdt_mv_ms: 10,
  neg_dvdt_mv_ms: -10,
  width_ms: 5,
  min_distance_ms: 2,
  bounds_start_s: 0,
  bounds_end_s: 0,            // 0 = use full sweep length (backend default)
  filter_enabled: false,
  filter_type: 'lowpass',
  filter_low: 1,
  filter_high: 2000,
  filter_order: 2,
}

const DEFAULT_KINETICS: APKineticsParams = {
  threshold_method: 'sekerli_I',
  threshold_cutoff_mv_ms: 20,
  threshold_search_ms_before_peak: 5,
  sekerli_lower_bound_mv_ms: 5,
  rise_low_pct: 10,
  rise_high_pct: 90,
  decay_low_pct: 10,
  decay_high_pct: 90,
  decay_end: 'to_threshold',
  fahp_search_start_ms: 0,
  fahp_search_end_ms: 5,
  mahp_search_start_ms: 5,
  mahp_search_end_ms: 100,
  max_slope_window_ms: 0.5,
  interpolate_to_200khz: true,
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

export function APWindow({
  backendUrl, fileInfo, mainGroup, mainSeries, mainTrace,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
}) {
  const {
    apAnalyses, runAP, clearAP, selectAPSpike,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // ---- Selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [trace, setTrace] = useState(mainTrace ?? 0)
  // Im source — matches IV's manual-Im fallback. Auto (default) means
  // the backend reconstructs Im from the recording's stimulus protocol.
  // Manual bypasses that with user-supplied start/step/window values.
  // The old "Im series" + "Im channel" selectors are gone; users who
  // need to override auto-detect use Manual instead. See ImSourceCard
  // + /api/ap/run's manual_im_* params.
  const [manualImEnabled, setManualImEnabled] = useState(false)
  const [manualImStartS, setManualImStartS] = useState(0)
  const [manualImEndS, setManualImEndS] = useState(0)
  const [manualImStartPA, setManualImStartPA] = useState(0)
  const [manualImStepPA, setManualImStepPA] = useState(0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setTrace(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])
  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && trace >= channels.length) setTrace(0)
  }, [channels, trace])

  // Overlay channels — extra channels / stimulus to display as
  // stacked subplots under the primary viewer. Analysis never runs
  // on overlay channels; they're for visual context only (e.g. see
  // the stim step while placing analysis bounds on Vm).
  const [overlayChannels, setOverlayChannels] = useState<number[]>([])
  // Drop any overlay that stops existing after a series/channel change.
  useEffect(() => {
    setOverlayChannels((prev) => prev.filter((idx) => {
      if (idx === STIMULUS_OVERLAY_KEY) return true
      return channels.some((c: any) => c.index === idx)
    }))
  }, [channels])
  const hasStimulus = useMemo(() => {
    const ser = fileInfo?.groups?.[group]?.series?.[series]
    return Boolean(ser?.stimulus)
  }, [fileInfo, group, series])
  // Current X range from the primary viewer — drives all overlay
  // subplots. null = auto-fit (each subplot falls back to its own data
  // extents). React state rather than a ref so setter propagates a
  // re-render to overlays.
  const [primaryXRange, setPrimaryXRange] = useState<[number, number] | null>(null)

  // ---- Tab ----
  type APTab = 'counting' | 'kinetics'
  const [tab, setTab] = useState<APTab>('counting')
  // Per-tab visibility signals — bumped when the user switches tabs
  // so each panel's uPlot re-fits + redraws after coming back into
  // view. Without this the kinetics phase plot stayed blank or
  // wrongly-sized until something else triggered a rebuild.
  const [countingVis, setCountingVis] = useState(0)
  const [kineticsVis, setKineticsVis] = useState(0)
  useEffect(() => {
    if (tab === 'counting') setCountingVis((n) => n + 1)
    if (tab === 'kinetics') setKineticsVis((n) => n + 1)
  }, [tab])
  void countingVis  // reserved for future Counting-tab plot resizes

  // When the user enters the Kinetics tab and there's a result with
  // at least one spike, auto-select the first one (so the right-side
  // phase plot has something to draw and the left viewer auto-zooms).
  // Skipped when a spike is already selected so we don't override
  // the user's pick from a previous kinetics session.
  useEffect(() => {
    if (tab !== 'kinetics') return
    const e = useAppStore.getState().apAnalyses[`${group}:${series}`]
    if (!e || e.perSpike.length === 0) return
    if (e.selectedSpikeIdx == null) {
      selectAPSpike(group, series, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, group, series, apAnalyses])

  // ---- Detection / kinetics / rheobase / ramp ----
  // Initially pull filter from main viewer if it's enabled, mirroring
  // the burst / FPsp behaviour. Saved entry for the active series
  // overrides this via the rehydration effect below.
  const [detection, setDetection] = useState<APDetectionParams>(() => {
    const mf = useAppStore.getState().filter
    if (mf.enabled) {
      return {
        ...DEFAULT_DETECTION,
        filter_enabled: true,
        filter_type: mf.type,
        filter_low: mf.lowCutoff,
        filter_high: mf.highCutoff,
        filter_order: mf.order,
      }
    }
    return DEFAULT_DETECTION
  })
  const [kinetics, setKinetics] = useState<APKineticsParams>(DEFAULT_KINETICS)
  const [rheobaseMode, setRheobaseMode] = useState<APRheobaseMode>('record')
  const [rampParams, setRampParams] = useState<APRampParams>({
    t_start_s: 0, t_end_s: 1, im_start_pa: 0, im_end_pa: 200,
  })

  // ---- Manual edits — local until next run ----
  const [manualEdits, setManualEdits] = useState<APManualEdits>({ added: {}, removed: {} })

  // ---- Multi-spike selection (Kinetics tab) ----
  // Independent from the per-row "active" selection (selectedSpikeIdx
  // in the entry). When the user checks multiple spikes, the kinetics
  // viewer overlays them (zoomed, time-aligned to peak) and the phase
  // plot overlays their loops. Empty set → fall back to the active
  // single-spike selection so the panel never has nothing to show.
  const [selectedSpikeSet, setSelectedSpikeSet] = useState<Set<number>>(new Set())
  const toggleSpikeSelected = useCallback((idx: number) => {
    setSelectedSpikeSet((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }, [])
  const clearSpikeSelection = useCallback(() => setSelectedSpikeSet(new Set()), [])
  const selectAllSpikes = useCallback(() => {
    const e = useAppStore.getState().apAnalyses[`${group}:${series}`]
    if (!e) return
    setSelectedSpikeSet(new Set(e.perSpike.map((_, i) => i)))
  }, [group, series])
  // "Hide markers" — toggles the threshold/peak/half/AHP dots on
  // both the zoomed-spike viewer and the phase plot. Useful when
  // overlaying many spikes — markers from N spikes get noisy.
  const [hideMarkers, setHideMarkers] = useState(false)
  // Reset selection when the entry changes (new run, new series).
  useEffect(() => {
    setSelectedSpikeSet(new Set())
  }, [`${group}:${series}`])  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Run controls ----
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

  // ---- Preview sweep ----
  const [previewSweep, setPreviewSweep] = useState(0)
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [totalSweeps])

  // Zoom-to-spike request: bumped each time a kinetics row is
  // clicked OR when the kinetics tab becomes active with a spike
  // already selected. The viewer watches `bump` and applies x range
  // = peakT ± halfMs. Counter-based so re-clicking the SAME spike
  // re-zooms (e.g. after the user has panned away to inspect).
  const [zoomRequest, setZoomRequest] = useState<
    { bump: number; centerT: number; halfMs: number } | null
  >(null)
  const requestZoomToSpike = useCallback((peakT: number, halfMs: number = 10) => {
    setZoomRequest((prev) => ({ bump: (prev?.bump ?? 0) + 1, centerT: peakT, halfMs }))
  }, [])

  // Auto-zoom the kinetics-tab left viewer to the selected spike
  // whenever (a) the tab is active and (b) the selection changes
  // (or the tab just became active with a non-null selection). The
  // entry lookup happens inline because `entry` is declared further
  // down in the component and we don't want a circular dep.
  const apAnalysesRef = useRef(apAnalyses)
  apAnalysesRef.current = apAnalyses
  useEffect(() => {
    if (tab !== 'kinetics') return
    const e = apAnalysesRef.current[`${group}:${series}`]
    if (!e || e.selectedSpikeIdx == null) return
    const sp = e.perSpike[e.selectedSpikeIdx]
    if (!sp) return
    setPreviewSweep(sp.sweep)
    requestZoomToSpike(sp.peakT, 15)
    // Trigger on tab change, on series change, and on the apAnalyses
    // identity changing (a Run completed, selection changed, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, group, series, apAnalyses, requestZoomToSpike])

  // ---- Per-window splitter (persisted) ----
  // The mini-viewer reads `topHeight` as a heightSignal — every time
  // the splitter (or window resize via ResizeObserver inside the
  // viewer) bumps it, the viewer's uPlot re-fits to the container.
  // The value persists in Electron prefs under `apWindowUI.topHeight`
  // so the user's preferred split survives close/reopen and
  // app-restart cycles. Other analysis windows can adopt the same
  // pattern (FPsp / Burst still default-only).
  const [topHeight, setTopHeight] = useState(280)
  // Hydrate from prefs once on mount. Sync (state-update) doesn't
  // help here because this is local UI state, not shared via the
  // BroadcastChannel.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.apWindowUI?.topHeight
        if (!cancelled && typeof saved === 'number'
            && saved >= 150 && saved <= 800) {
          setTopHeight(saved)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  // Persist on splitter mouseup (one write per drag, not per pixel
  // — typing/dragging UI shouldn't spam prefs writes).
  const writeTopHeightToPrefs = useCallback(async (h: number) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.apWindowUI ?? {}), topHeight: h }
      await api.setPreferences({ ...prefs, apWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  // Left-panel width (vertical splitter between params column and
  // viewer+results). Same prefs-persistence recipe as topHeight:
  // hydrate on mount, write on mouseup-end-of-drag, clamp the saved
  // value on restore so a pathologically small / large persisted
  // width can't wedge the UI.
  const [leftPanelWidth, setLeftPanelWidth] = useState(320)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const saved = prefs?.apWindowUI?.leftPanelWidth
        if (!cancelled && typeof saved === 'number'
            && saved >= 200 && saved <= 500) {
          setLeftPanelWidth(saved)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const writeLeftPanelWidthToPrefs = useCallback(async (w: number) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.apWindowUI ?? {}), leftPanelWidth: w }
      await api.setPreferences({ ...prefs, apWindowUI: next })
    } catch { /* ignore */ }
  }, [])
  const onLeftSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      latest = Math.max(200, Math.min(500, startW + dx))
      setLeftPanelWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeLeftPanelWidthToPrefs(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onSplitMouseDown = (e: React.MouseEvent) => {
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
      // Save once at end-of-drag rather than per-pixel.
      writeTopHeightToPrefs(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }


  // ---- Lookup + rehydrate ----
  const key = `${group}:${series}`
  const entry: APData | undefined = apAnalyses[key]
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    setTrace(entry.trace)
    setManualImEnabled(entry.manualImEnabled ?? false)
    setManualImStartS(entry.manualImStartS ?? 0)
    setManualImEndS(entry.manualImEndS ?? 0)
    setManualImStartPA(entry.manualImStartPA ?? 0)
    setManualImStepPA(entry.manualImStepPA ?? 0)
    setDetection(entry.detection)
    setKinetics(entry.kinetics)
    setRheobaseMode(entry.rheobaseMode)
    if (entry.rampParams) setRampParams(entry.rampParams)
    setManualEdits(entry.manualEdits ?? { added: {}, removed: {} })
  }, [entry, key])

  // ---- Auto-seed series on window reopen from the saved AP entries
  // for this group, falling back to the main viewer's series if none. ----
  const autoSeededRef = useRef(false)
  const manuallyChangedSeriesRef = useRef(false)
  useEffect(() => {
    if (autoSeededRef.current) return
    if (manuallyChangedSeriesRef.current) return
    if (!fileInfo) return
    const prefix = `${group}:`
    let best: number | null = null
    for (const k of Object.keys(apAnalyses)) {
      if (!k.startsWith(prefix)) continue
      const parts = k.split(':')
      if (parts.length !== 2) continue
      const s = Number(parts[1])
      if (!isFinite(s)) continue
      if (best == null || s > best) best = s
    }
    if (best != null && best !== series) {
      autoSeededRef.current = true
      setSeries(best)
    }
  }, [apAnalyses, group, fileInfo, series])
  const onSeriesChange = (v: number) => {
    manuallyChangedSeriesRef.current = true
    setSeries(v)
  }

  // ---- Sweep trace fetch (mini-viewer) ----
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [traceUnits, setTraceUnits] = useState<string>('mV')
  const [zeroOffset, setZeroOffset] = useState(false)
  const [zeroOffsetApplied, setZeroOffsetApplied] = useState(0)
  useEffect(() => {
    if (!backendUrl || totalSweeps === 0) {
      setTraceTime(null); setTraceValues(null); return
    }
    const qs = new URLSearchParams({
      group: String(group), series: String(series),
      sweep: String(previewSweep), trace: String(trace),
      max_points: '0',  // full resolution — sweeps are short for AP
    })
    if (zeroOffset) qs.set('zero_offset', 'true')
    if (detection.filter_enabled) {
      qs.set('filter_type', detection.filter_type)
      qs.set('filter_low', String(detection.filter_low))
      qs.set('filter_high', String(detection.filter_high))
      qs.set('filter_order', String(detection.filter_order))
    }
    let cancelled = false
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((d) => {
        if (cancelled) return
        setTraceTime(d.time ?? [])
        setTraceValues(d.values ?? [])
        setTraceUnits(d.units ?? 'mV')
        setZeroOffsetApplied(Number(d.zero_offset ?? 0))
      })
      .catch(() => { if (!cancelled) { setTraceTime(null); setTraceValues(null) } })
    return () => { cancelled = true }
  }, [
    backendUrl, group, series, trace, previewSweep, totalSweeps, zeroOffset,
    detection.filter_enabled, detection.filter_type,
    detection.filter_low, detection.filter_high, detection.filter_order,
  ])

  // ---- Run ----
  const onRun = async () => {
    let sweepIndices: number[] | null = null
    if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      sweepIndices = []
      for (let i = lo - 1; i <= hi - 1; i++) sweepIndices.push(i)
    } else if (runMode === 'one') {
      sweepIndices = [Math.max(0, Math.min(sweepOne - 1, totalSweeps - 1))]
    }
    await runAP(
      group, series, trace,
      {
        manualEnabled: manualImEnabled,
        manualStartS: manualImStartS,
        manualEndS: manualImEndS,
        manualStartPA: manualImStartPA,
        manualStepPA: manualImStepPA,
      },
      sweepIndices,
      detection, kinetics,
      rheobaseMode,
      rheobaseMode === 'ramp' ? rampParams : null,
      manualEdits,
      true,
    )
  }

  // Per-spike measurements for the current preview sweep — used by
  // the mini-viewer to overlay threshold / peak / fAHP / mAHP /
  // half-width markers. When kinetics weren't measured we fall back
  // to the peak-time-only list from per-sweep counting.
  const previewSpikes: APPoint[] = useMemo(() => {
    if (!entry) return []
    const matched = entry.perSpike.filter((sp) => sp.sweep === previewSweep)
    if (matched.length > 0) return matched
    // Fall back to peak-times-only from the per-sweep counting result.
    const ps = entry.perSweep.find((p) => p.sweep === previewSweep)
    return (ps?.peakTimes ?? []).map((t, i) => ({
      sweep: previewSweep,
      spikeIndex: i,
      thresholdVm: 0, thresholdT: 0,
      peakVm: 0, peakT: t,
      amplitudeMv: 0,
      riseTimeS: null, decayTimeS: null, halfWidthS: null,
      fahpVm: null, fahpT: null,
      mahpVm: null, mahpT: null,
      maxRiseSlopeMvMs: null, maxDecaySlopeMvMs: null,
      manual: false,
    }))
  }, [entry, previewSweep])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Selectors — stay as a thin top row (always visible). All
          other param sections + Run controls + error banner live in
          the LEFT panel below; the viewer + results panel live in
          the RIGHT panel. The vertical splitter between them is
          draggable and persists its width to Electron prefs under
          apWindowUI.leftPanelWidth. */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        // Match the main-window tree sidebar tone so the window's
        // "chrome" (selectors + left panel) reads as one cohesive
        // region distinct from the content (viewer + results).
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={series} onChange={(e) => onSeriesChange(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <ChannelsOverlaySelect
          channels={channels.map((c: any) => ({ index: c.index, label: c.label, units: c.units }))}
          primary={trace}
          onPrimaryChange={(i) => setTrace(i)}
          overlay={overlayChannels}
          onOverlayChange={setOverlayChannels}
          hasStimulus={hasStimulus}
        />
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

      {/* Tab bar — spans the full window width so it's visually above
          BOTH columns. The tab choice drives which params show in
          the left column (Rheobase for Counting, Kinetics for
          Kinetics) and which results show on the right; placing the
          bar inside the right column made it look like a local viewer
          toggle, which misread its actual scope. */}
      <div style={{
        display: 'flex', gap: 2, borderBottom: '1px solid var(--border)',
        alignItems: 'flex-end', flexShrink: 0,
      }}>
        {(['counting', 'kinetics'] as APTab[]).map((t) => {
          const label = t === 'counting' ? 'Counting' : 'Kinetics'
          const active = tab === t
          return (
            <button
              key={t}
              className="btn"
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
              }}
            >{label}</button>
          )
        })}
      </div>

      {/* Main body: two-column flex. LEFT = params column (scrollable
          with Run controls pinned to its bottom); RIGHT = viewer +
          results. */}
      <div style={{
        flex: 1, display: 'flex', minHeight: 0, gap: 0,
      }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8,
          borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          {/* Scrollable param sections. Run controls + error banner
              sit outside this scrollable so they're always visible. */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,  // room for the scrollbar
          }}>
            {/* Im source — Auto reconstructs from the recording's
                stimulus protocol; Manual falls back to start/step
                values. Shared with the IV window via ImSourceCard. */}
            <ImSourceCard
              mode={manualImEnabled ? 'manual' : 'auto'}
              onModeChange={(m) => setManualImEnabled(m === 'manual')}
              manual={{
                startS: manualImStartS,
                endS: manualImEndS,
                startPA: manualImStartPA,
                stepPA: manualImStepPA,
              }}
              onManualChange={(p) => {
                if (p.startS !== undefined) setManualImStartS(p.startS)
                if (p.endS !== undefined) setManualImEndS(p.endS)
                if (p.startPA !== undefined) setManualImStartPA(p.startPA)
                if (p.stepPA !== undefined) setManualImStepPA(p.stepPA)
              }}
              detected={entry?.imSource ?? null}
            />
            {/* Detection params (filter + method + bounds) live here. */}
            <APDetectionPanel detection={detection} setDetection={setDetection} />
            {/* Tab-specific params. */}
            {tab === 'counting' && (
              <APRheobasePanel
                rheobaseMode={rheobaseMode}
                setRheobaseMode={setRheobaseMode}
                rampParams={rampParams}
                setRampParams={setRampParams}
                backendUrl={backendUrl}
                group={group} series={series}
              />
            )}
            {tab === 'kinetics' && (
              <APKineticsPanel kinetics={kinetics} setKinetics={setKinetics} />
            )}
          </div>
          {/* Pinned footer: Run controls + error banner.
              Primary: Run. Secondary (smaller): Clear, Clear edits.
              Sweep-scope selector is a dropdown (progressive
              disclosure) — "All sweeps" is the default; Range and
              Single reveal their inline input rows only when chosen.
              This replaces the earlier radios-on-one-row layout,
              which got cramped in a narrow left column. */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={loading || !fileInfo}
              style={{
                width: '100%', padding: '8px 0',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
              }}>
              {loading ? 'Running…' : 'Run'}
            </button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Sweeps:</span>
              <select value={runMode}
                onChange={(e) => setRunMode(e.target.value as RunMode)}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                <option value="all">All sweeps</option>
                <option value="range">Range</option>
                <option value="one">Single sweep</option>
              </select>
            </div>
            {runMode === 'range' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>from</span>
                <NumInput value={sweepFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span>to</span>
                <NumInput value={sweepTo} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepTo(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'}</span>
              </div>
            )}
            {runMode === 'one' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                <span>sweep</span>
                <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
                  onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))} style={{ width: 60 }} />
                <span style={{ marginLeft: 'auto' }}>/ {totalSweeps || '—'}</span>
              </div>
            )}
            {/* Secondary actions — smaller, visually subordinate. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn"
                onClick={() => clearAP(group, series)} disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => { setManualEdits({ added: {}, removed: {} }) }}
                disabled={
                  Object.keys(manualEdits.added).length === 0 &&
                  Object.keys(manualEdits.removed).length === 0
                }
                title="Drop manual spike additions / removals (next Run will use raw auto-detection)"
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear edits
              </button>
            </div>
          </div>
          {error && (
            <div style={{
              flexShrink: 0,
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
        </div>{/* close LEFT panel */}

        {/* Vertical splitter between LEFT and RIGHT. */}
        <div
          onMouseDown={onLeftSplitMouseDown}
          title="Drag to resize"
          style={{
            width: 3, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)',
            position: 'relative',
          }}
        >
          <div style={{
            position: 'absolute', top: '50%', left: 0,
            transform: 'translateY(-50%)',
            width: 2, height: 40, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>

        {/* RIGHT PANEL: tab bar + viewer + results. */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>

      {/* Top: mode-dependent viewer area. Counting tab gets the full
          sweep viewer (whole trace + spike markers + draggable bounds),
          optionally with stacked overlay subplots beneath for extra
          channels / the stimulus protocol. Kinetics tab swaps in
          [zoomed-spike (left) | phase-plot (right)] so the user can
          verify detection markers up close AND see the characteristic
          phase loop side-by-side. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ height: topHeight, minHeight: 180, flexShrink: 0,
          display: 'flex', gap: 6,
        }}>
          {tab === 'counting' && (
            <div style={{
              flex: 1, minWidth: 0,
              display: 'flex', flexDirection: 'column', minHeight: 0,
            }}>
              {/* Primary subplot: APSweepViewer with all analysis
                  bands + spike markers. Cursor bands are drawn only
                  here — overlay subplots below are display-only.
                  5:2 primary-to-each-overlay ratio so one overlay
                  takes ~29% of the viewer height (small enough to
                  stay out of the way, tall enough to read off stim
                  amplitude and timing). */}
              <div style={{
                flex: overlayChannels.length > 0 ? 5 : 1,
                minHeight: 0,
              }}>
                <APSweepViewer
                  traceTime={traceTime}
                  traceValues={traceValues}
                  traceUnits={traceUnits}
                  previewSweep={previewSweep}
                  totalSweeps={totalSweeps}
                  theme={theme}
                  fontSize={fontSize}
                  zeroOffset={zeroOffset}
                  onZeroOffsetChange={setZeroOffset}
                  zeroOffsetApplied={zeroOffsetApplied}
                  boundsStartS={detection.bounds_start_s}
                  boundsEndS={detection.bounds_end_s}
                  onBoundsChange={(start, end) => {
                    setDetection((d) => ({ ...d, bounds_start_s: start, bounds_end_s: end }))
                  }}
                  previewSpikes={previewSpikes}
                  entry={entry}
                  heightSignal={topHeight}
                  zoomToSpikeRequest={zoomRequest}
                  onXRangeChange={(xMin, xMax) => setPrimaryXRange([xMin, xMax])}
                />
              </div>
              {/* Overlay subplots — one per selected overlay channel.
                  Thin divider between each, 5:2 primary-to-each ratio
                  (overlay ≈ 29% of the viewer height when there's
                  one; halves from there if more are added). Display-
                  only, X-synced from primary. */}
              {overlayChannels.map((ch) => {
                const label = ch === STIMULUS_OVERLAY_KEY
                  ? 'Stimulus'
                  : channels.find((c: any) => c.index === ch)?.label ?? `Ch ${ch}`
                const units = ch === STIMULUS_OVERLAY_KEY
                  ? 'pA'
                  : channels.find((c: any) => c.index === ch)?.units ?? ''
                const overlayConfig: OverlayChannel = ch === STIMULUS_OVERLAY_KEY
                  ? { kind: 'stimulus', label, units }
                  : { kind: 'channel', index: ch, label, units }
                return (
                  <React.Fragment key={ch}>
                    <div style={{
                      height: 3, flexShrink: 0,
                      background: 'var(--border)',
                    }} />
                    <div style={{ flex: 2, minHeight: 0 }}>
                      <OverlayTraceViewer
                        backendUrl={backendUrl}
                        group={group}
                        series={series}
                        sweep={previewSweep}
                        channel={overlayConfig}
                        xRange={primaryXRange}
                        heightSignal={topHeight}
                      />
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          )}
          {tab === 'kinetics' && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <APSpikesOverlayViewer
                  backendUrl={backendUrl}
                  entry={entry}
                  group={group} series={series} trace={trace}
                  selectedSpikeIndices={selectedSpikeSet}
                  hideMarkers={hideMarkers}
                  onHideMarkersChange={setHideMarkers}
                  onSelectAll={selectAllSpikes}
                  onClearSelection={clearSpikeSelection}
                  onSelectSpike={(idx) => {
                    // Drive both the table-active selection + the
                    // auto-zoom (so prev/next behaves exactly like
                    // clicking a kinetics-table row).
                    selectAPSpike(group, series, idx)
                    const sp = entry?.perSpike[idx]
                    if (sp) {
                      setPreviewSweep(sp.sweep)
                      requestZoomToSpike(sp.peakT, 15)
                    }
                  }}
                  filter={detection.filter_enabled ? {
                    type: detection.filter_type,
                    low: detection.filter_low,
                    high: detection.filter_high,
                    order: detection.filter_order,
                  } : null}
                  zeroOffset={zeroOffset}
                  visibilitySignal={kineticsVis}
                  heightSignal={topHeight}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <APPhasePlotPanel
                  backendUrl={backendUrl}
                  entry={entry}
                  group={group} series={series} trace={trace}
                  visibilitySignal={kineticsVis}
                  heightSignal={topHeight}
                  selectedSpikeIndices={selectedSpikeSet}
                  hideMarkers={hideMarkers}
                />
              </div>
            </>
          )}
        </div>
        <div onMouseDown={onSplitMouseDown}
          style={{
            height: 3, cursor: 'row-resize', background: 'var(--border)',
            flexShrink: 0, position: 'relative',
          }}
          title="Drag to resize">
          <div style={{
            position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)',
            width: 40, height: 2, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* All three result panels stay mounted (display-toggle) so
              uPlot instances + zoom survive tab round-trips. */}
          <div style={{
            display: tab === 'counting' ? 'flex' : 'none', height: '100%',
          }}>
            <APCountingPanel
              entry={entry}
              previewSweep={previewSweep}
              setPreviewSweep={setPreviewSweep}
              heightSignal={topHeight}
            />
          </div>
          <div style={{
            display: tab === 'kinetics' ? 'flex' : 'none', height: '100%',
          }}>
            <APKineticsTable
              entry={entry}
              onSelectSpike={(idx) => {
                selectAPSpike(group, series, idx)
                const sp = entry?.perSpike[idx]
                if (sp) {
                  // Pan the preview to the spike's sweep AND zoom in
                  // around the peak so the user can verify the
                  // detection markers without manually zooming.
                  setPreviewSweep(sp.sweep)
                  requestZoomToSpike(sp.peakT, 15)
                }
              }}
              selectedSpikeSet={selectedSpikeSet}
              onToggleSpike={toggleSpikeSelected}
            />
          </div>
        </div>
      </div>
        </div>{/* close RIGHT panel */}
      </div>{/* close two-column body */}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detection params panel — shared by all three tabs
// ---------------------------------------------------------------------------

function APDetectionPanel({
  detection, setDetection,
}: {
  detection: APDetectionParams
  setDetection: React.Dispatch<React.SetStateAction<APDetectionParams>>
}) {
  const set = <K extends keyof APDetectionParams>(k: K, v: APDetectionParams[K]) =>
    setDetection((d) => ({ ...d, [k]: v }))
  return (
    <>
      {/* Pre-detection filter */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: 8, border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={detection.filter_enabled}
            onChange={(e) => set('filter_enabled', e.target.checked)} />
          <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
        </label>
        {detection.filter_enabled && (
          <>
            <select value={detection.filter_type}
              onChange={(e) => set('filter_type', e.target.value as 'lowpass' | 'highpass' | 'bandpass')}
              style={{ fontSize: 'var(--font-size-label)' }}>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
              <option value="bandpass">Bandpass</option>
            </select>
            {(detection.filter_type === 'highpass' || detection.filter_type === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>low</span>
                <NumInput value={detection.filter_low} step={0.1} min={0}
                  onChange={(v) => set('filter_low', v)} style={{ width: 64 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            {(detection.filter_type === 'lowpass' || detection.filter_type === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>high</span>
                <NumInput value={detection.filter_high} step={50} min={1}
                  onChange={(v) => set('filter_high', v)} style={{ width: 70 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)' }}>order</span>
              <NumInput value={detection.filter_order} step={1} min={1} max={8}
                onChange={(v) => set('filter_order', Math.max(1, Math.min(8, Math.round(v))))}
                style={{ width: 42 }} />
            </label>
          </>
        )}
      </div>

      {/* Detection params. Two-column grid with wider controls
          (dropdowns) spanning both columns via gridColumn '1 / -1'.
          Thin sub-header strips group related fields so the user can
          scan the panel quickly. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8, padding: 8,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Detection method">
            <select value={detection.method}
              onChange={(e) => set('method', e.target.value as APDetectionMethod)}>
              <option value="auto_rec">Auto (adaptive)</option>
              <option value="auto_spike">Auto (single pass)</option>
              <option value="manual">Manual threshold</option>
            </select>
          </Field>
        </div>
        {detection.method === 'manual' && (
          <ParamRow label="Manual threshold (mV)"
            value={detection.manual_threshold_mv} step={5}
            onChange={(v) => set('manual_threshold_mv', v)} />
        )}
        {detection.method !== 'manual' && (
          <>
            <SubHeader>Thresholds</SubHeader>
            <ParamRow label="Min amplitude (mV)"
              value={detection.min_amplitude_mv} step={5} min={0}
              onChange={(v) => set('min_amplitude_mv', v)} />
            <ParamRow label="+dV/dt (mV/ms)"
              value={detection.pos_dvdt_mv_ms} step={1} min={0}
              onChange={(v) => set('pos_dvdt_mv_ms', v)} />
            <ParamRow label="−dV/dt (mV/ms)"
              value={detection.neg_dvdt_mv_ms} step={1}
              onChange={(v) => set('neg_dvdt_mv_ms', v)} />
          </>
        )}
        <SubHeader>Spike shape</SubHeader>
        <ParamRow label="Max width (ms)"
          value={detection.width_ms} step={0.5} min={0.1}
          onChange={(v) => set('width_ms', v)} />
        <ParamRow label="Min distance (ms)"
          value={detection.min_distance_ms} step={0.5} min={0.1}
          onChange={(v) => set('min_distance_ms', v)} />
        <SubHeader>Analysis bounds</SubHeader>
        <ParamRow label="Bounds start (s)"
          value={detection.bounds_start_s} step={0.05} min={0}
          onChange={(v) => set('bounds_start_s', Math.max(0, v))} />
        <ParamRow label="Bounds end (s)"
          value={detection.bounds_end_s} step={0.05} min={0}
          onChange={(v) => set('bounds_end_s', Math.max(0, v))} />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Kinetics params panel
// ---------------------------------------------------------------------------

function APKineticsPanel({
  kinetics, setKinetics,
}: {
  kinetics: APKineticsParams
  setKinetics: React.Dispatch<React.SetStateAction<APKineticsParams>>
}) {
  const set = <K extends keyof APKineticsParams>(k: K, v: APKineticsParams[K]) =>
    setKinetics((kk) => ({ ...kk, [k]: v }))
  const isCutoff = kinetics.threshold_method === 'first_deriv_cutoff'
    || kinetics.threshold_method === 'third_deriv_cutoff'
  const isSekerli = kinetics.threshold_method === 'sekerli_I'
    || kinetics.threshold_method === 'sekerli_II'
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: 8, padding: 8,
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Threshold method">
          <select value={kinetics.threshold_method}
            onChange={(e) => set('threshold_method', e.target.value as APThresholdMethod)}>
            <option value="first_deriv_cutoff">First-deriv cutoff</option>
            <option value="first_deriv_max">First-deriv max</option>
            <option value="third_deriv_cutoff">Third-deriv cutoff</option>
            <option value="third_deriv_max">Third-deriv max</option>
            <option value="sekerli_I">Sekerli I</option>
            <option value="sekerli_II">Sekerli II</option>
            <option value="leading_inflection">Leading inflection</option>
            <option value="max_curvature">Max curvature</option>
          </select>
        </Field>
      </div>
      {isCutoff && (
        <ParamRow label="Cutoff (mV/ms)"
          value={kinetics.threshold_cutoff_mv_ms} step={1} min={0}
          onChange={(v) => set('threshold_cutoff_mv_ms', v)} />
      )}
      {isSekerli && (
        <ParamRow label="Sekerli mask (mV/ms)"
          value={kinetics.sekerli_lower_bound_mv_ms} step={1} min={0}
          onChange={(v) => set('sekerli_lower_bound_mv_ms', v)} />
      )}
      <ParamRow label="Search before peak (ms)"
        value={kinetics.threshold_search_ms_before_peak} step={0.5} min={0.1}
        onChange={(v) => set('threshold_search_ms_before_peak', v)} />

      <SubHeader>Rise / decay</SubHeader>
      <ParamRow label="Rise low %" value={kinetics.rise_low_pct} step={5} min={0} max={100}
        onChange={(v) => set('rise_low_pct', v)} />
      <ParamRow label="Rise high %" value={kinetics.rise_high_pct} step={5} min={0} max={100}
        onChange={(v) => set('rise_high_pct', v)} />
      <ParamRow label="Decay low %" value={kinetics.decay_low_pct} step={5} min={0} max={100}
        onChange={(v) => set('decay_low_pct', v)} />
      <ParamRow label="Decay high %" value={kinetics.decay_high_pct} step={5} min={0} max={100}
        onChange={(v) => set('decay_high_pct', v)} />
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Decay end">
          <select value={kinetics.decay_end}
            onChange={(e) => set('decay_end', e.target.value as 'to_threshold' | 'to_fahp')}>
            <option value="to_threshold">to threshold</option>
            <option value="to_fahp">to fAHP</option>
          </select>
        </Field>
      </div>

      <SubHeader>AHP windows</SubHeader>
      <ParamRow label="fAHP start (ms)"
        value={kinetics.fahp_search_start_ms} step={1} min={0}
        onChange={(v) => set('fahp_search_start_ms', v)} />
      <ParamRow label="fAHP end (ms)"
        value={kinetics.fahp_search_end_ms} step={1} min={0}
        onChange={(v) => set('fahp_search_end_ms', v)} />
      <ParamRow label="mAHP start (ms)"
        value={kinetics.mahp_search_start_ms} step={5} min={0}
        onChange={(v) => set('mahp_search_start_ms', v)} />
      <ParamRow label="mAHP end (ms)"
        value={kinetics.mahp_search_end_ms} step={10} min={0}
        onChange={(v) => set('mahp_search_end_ms', v)} />

      <SubHeader>Slope</SubHeader>
      <ParamRow label="Max-slope window (ms)"
        value={kinetics.max_slope_window_ms} step={0.1} min={0.1}
        onChange={(v) => set('max_slope_window_ms', v)} />
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={kinetics.interpolate_to_200khz}
            onChange={(e) => set('interpolate_to_200khz', e.target.checked)} />
          Interp to 200 kHz
        </label>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rheobase panel — mode picker + ramp params, with auto-fill from .pgf
// ---------------------------------------------------------------------------

function APRheobasePanel({
  rheobaseMode, setRheobaseMode,
  rampParams, setRampParams,
  backendUrl, group, series,
}: {
  rheobaseMode: APRheobaseMode
  setRheobaseMode: (m: APRheobaseMode) => void
  rampParams: APRampParams
  setRampParams: React.Dispatch<React.SetStateAction<APRampParams>>
  backendUrl: string
  group: number
  series: number
}) {
  const setRamp = <K extends keyof APRampParams>(k: K, v: APRampParams[K]) =>
    setRampParams((r) => ({ ...r, [k]: v }))

  const onAutoFill = async () => {
    if (!backendUrl) return
    try {
      const r = await fetch(`${backendUrl}/api/ap/auto_im_params?group=${group}&series=${series}`)
      if (!r.ok) return
      const d = await r.json()
      if (d?.type === 'ramp') {
        setRampParams({
          t_start_s: Number(d.t_start_s ?? 0),
          t_end_s: Number(d.t_end_s ?? 0),
          im_start_pa: Number(d.im_start_pa ?? 0),
          im_end_pa: Number(d.im_end_pa ?? 0),
        })
      } else if (d?.type === 'step') {
        // No ramp parsed — use the step's bounds with constant Im so
        // the user can edit instead of starting from zero.
        setRampParams({
          t_start_s: Number(d.t_start_s ?? 0),
          t_end_s: Number(d.t_end_s ?? 0),
          im_start_pa: Number(d.im_pa ?? 0),
          im_end_pa: Number(d.im_pa ?? 0),
        })
      }
    } catch { /* ignore */ }
  }

  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', fontSize: 'var(--font-size-label)',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>Rheobase:</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'record'}
          onChange={() => setRheobaseMode('record')} />
        Record (mean Im of first sweep with AP)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'exact'}
          onChange={() => setRheobaseMode('exact')} />
        Exact (Im at first AP sample)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input type="radio" name="ap-rheobase-mode" checked={rheobaseMode === 'ramp'}
          onChange={() => setRheobaseMode('ramp')} />
        Ramp (manual)
      </label>
      {rheobaseMode === 'ramp' && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>t0 (s)</span>
            <NumInput value={rampParams.t_start_s} step={0.05} min={0}
              onChange={(v) => setRamp('t_start_s', Math.max(0, v))} style={{ width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>t1 (s)</span>
            <NumInput value={rampParams.t_end_s} step={0.05} min={0}
              onChange={(v) => setRamp('t_end_s', Math.max(0, v))} style={{ width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>I0 (pA)</span>
            <NumInput value={rampParams.im_start_pa} step={10}
              onChange={(v) => setRamp('im_start_pa', v)} style={{ width: 70 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>I1 (pA)</span>
            <NumInput value={rampParams.im_end_pa} step={10}
              onChange={(v) => setRamp('im_end_pa', v)} style={{ width: 70 }} />
          </label>
          <button className="btn" onClick={onAutoFill}
            title="Try to fill from the stimulus protocol"
            style={{ padding: '1px 8px' }}>
            Auto-fill from protocol
          </button>
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Counting tab — per-sweep table + F-I curve + rheobase badge
// ---------------------------------------------------------------------------

function APCountingPanel({
  entry, previewSweep, setPreviewSweep, heightSignal,
}: {
  entry: APData | undefined
  previewSweep: number
  setPreviewSweep: (n: number) => void
  /** Forwarded to the F-I curve so the plot resizes on splitter
   *  drag (flexbox layout updates don't always trigger uPlot's
   *  internal ResizeObserver predictably). */
  heightSignal?: number
}) {
  if (!entry || entry.perSweep.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run to populate the counting table.
      </div>
    )
  }
  return (
    <div style={{ flex: 1, display: 'flex', gap: 6, minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <APPerSweepTable entry={entry} previewSweep={previewSweep}
          onSelectSweep={setPreviewSweep} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <APRheobaseBadge entry={entry} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <APFICurve entry={entry} onSelectSweep={setPreviewSweep}
            heightSignal={heightSignal} />
        </div>
      </div>
    </div>
  )
}

function APRheobaseBadge({ entry }: { entry: APData }) {
  const r = entry.rheobase
  if (!r) return null
  const value = r.value != null ? `${r.value.toFixed(1)} pA` : '—'
  return (
    <div style={{
      padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
      display: 'flex', gap: 10, alignItems: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-label)',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>Rheobase</span>
      <strong style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-sm)' }}>{value}</strong>
      <span style={{
        padding: '1px 6px', borderRadius: 2,
        background: 'var(--bg-secondary)', color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
      }}>{r.mode}</span>
    </div>
  )
}

function APPerSweepTable({
  entry, previewSweep, onSelectSweep,
}: {
  entry: APData
  previewSweep: number
  onSelectSweep: (sweep: number) => void
}) {
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
            <Th>Sweep</Th>
            <Th>Spikes</Th>
            <Th>Rate (Hz)</Th>
            <Th>Im (pA)</Th>
            <Th>Latency (s)</Th>
            <Th>Mean ISI (s)</Th>
            <Th>SFA</Th>
            <Th>LV</Th>
          </tr>
        </thead>
        <tbody>
          {entry.perSweep.map((p) => {
            const selected = p.sweep === previewSweep
            return (
              <tr
                key={p.sweep}
                onClick={() => onSelectSweep(p.sweep)}
                style={{
                  background: selected ? 'var(--bg-selected, rgba(100,181,246,0.2))' : 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{p.sweep + 1}</Td>
                <Td>{p.spikeCount}</Td>
                <Td>{p.spikeRateHz != null ? p.spikeRateHz.toFixed(2) : '—'}</Td>
                <Td>{p.imMean != null ? p.imMean.toFixed(1) : '—'}</Td>
                <Td>{p.firstSpikeLatency != null ? p.firstSpikeLatency.toFixed(4) : '—'}</Td>
                <Td>{p.meanISI != null ? p.meanISI.toFixed(4) : '—'}</Td>
                <Td>{p.sfaDivisor != null ? p.sfaDivisor.toFixed(2) : '—'}</Td>
                <Td>{p.localVariance != null ? p.localVariance.toFixed(3) : '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function APFICurve({
  entry, onSelectSweep, heightSignal,
}: {
  entry: APData
  onSelectSweep: (sweep: number) => void
  /** Parent splitter height — explicit setSize on every bump because
   *  ResizeObserver alone misses some flexbox-redistribute cases. */
  heightSignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const fi = entry.fiCurve

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!fi || fi.im.length === 0) return
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 200),
      scales: { x: { time: false }, y: {} },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'Im (pA)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'Rate (Hz)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          stroke: cssVar('--trace-color-1'), width: 1.5,
          points: { show: true, size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--trace-color-1') },
        },
      ],
    }
    plotRef.current = new uPlot(opts, [fi.im, fi.rate], el)
    // Click → jump to the sweep at the nearest x.
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const onClick = (ev: MouseEvent) => {
        const rect = over.getBoundingClientRect()
        const u = plotRef.current
        if (!u) return
        const xVal = u.posToVal(ev.clientX - rect.left, 'x')
        let best = -1; let bestDist = Infinity
        for (let i = 0; i < fi.im.length; i++) {
          const d = Math.abs(fi.im[i] - xVal)
          if (d < bestDist) { bestDist = d; best = i }
        }
        if (best >= 0) onSelectSweep(fi.sweep[best])
      }
      over.addEventListener('click', onClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fi])

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
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  // Splitter / window resize signal — same double-rAF pattern as
  // the phase plot (single rAF runs before the post-height-change
  // layout pass in some browsers).
  useEffect(() => {
    if (heightSignal == null) return
    let r1 = 0, r2 = 0
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const u = plotRef.current
        const el = containerRef.current
        if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
          u.setSize({ width: el.clientWidth, height: el.clientHeight })
          u.redraw()
        }
      })
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [heightSignal])

  if (!fi || fi.im.length === 0) {
    return (
      <div style={{
        height: '100%', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)', padding: 8, textAlign: 'center',
      }}>
        F-I curve needs an Im channel — pick one above and re-run.
      </div>
    )
  }
  return (
    <div style={{
      height: '100%', border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kinetics tab — per-spike table
// ---------------------------------------------------------------------------

function APKineticsTable({
  entry, onSelectSpike, selectedSpikeSet, onToggleSpike,
}: {
  entry: APData | undefined
  onSelectSpike: (idx: number) => void
  /** Set of spike indices the user has checked for multi-spike
   *  overlay in the upper viewer / phase plot. Independent from the
   *  per-row "active" selectedSpikeIdx — that one drives the auto-
   *  zoom; this one drives overlay rendering. */
  selectedSpikeSet: Set<number>
  onToggleSpike: (idx: number) => void
}) {
  if (!entry || entry.perSpike.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run to populate the per-spike kinetics table.
      </div>
    )
  }
  return (
    <div style={{
      flex: 1, border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', minHeight: 0,
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>✓</Th>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>Threshold (mV)</Th>
            <Th>Peak (mV)</Th>
            <Th>Amp (mV)</Th>
            <Th>Rise (ms)</Th>
            <Th>Decay (ms)</Th>
            <Th>FWHM (ms)</Th>
            <Th>fAHP (mV)</Th>
            <Th>mAHP (mV)</Th>
            <Th>+slope</Th>
            <Th>−slope</Th>
          </tr>
        </thead>
        <tbody>
          {entry.perSpike.map((sp, i) => {
            const selected = i === entry.selectedSpikeIdx
            const checked = selectedSpikeSet.has(i)
            return (
              <tr
                key={i}
                onClick={() => onSelectSpike(i)}
                style={{
                  background: selected ? 'var(--bg-selected, rgba(100,181,246,0.2))' : 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                  fontStyle: sp.manual ? 'italic' : 'normal',
                }}
              >
                <td style={{ padding: '3px 8px' }}
                  onClick={(e) => { e.stopPropagation(); onToggleSpike(i) }}>
                  <input type="checkbox" checked={checked}
                    onChange={() => onToggleSpike(i)}
                    onClick={(e) => e.stopPropagation()} />
                </td>
                <Td>{sp.manual ? '★ ' : ''}{i + 1}</Td>
                <Td>{sp.sweep + 1}</Td>
                <Td>{sp.thresholdVm.toFixed(2)}</Td>
                <Td>{sp.peakVm.toFixed(2)}</Td>
                <Td>{sp.amplitudeMv.toFixed(2)}</Td>
                <Td>{sp.riseTimeS != null ? (sp.riseTimeS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.decayTimeS != null ? (sp.decayTimeS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.halfWidthS != null ? (sp.halfWidthS * 1000).toFixed(3) : '—'}</Td>
                <Td>{sp.fahpVm != null ? sp.fahpVm.toFixed(2) : '—'}</Td>
                <Td>{sp.mahpVm != null ? sp.mahpVm.toFixed(2) : '—'}</Td>
                <Td>{sp.maxRiseSlopeMvMs != null ? sp.maxRiseSlopeMvMs.toFixed(1) : '—'}</Td>
                <Td>{sp.maxDecaySlopeMvMs != null ? sp.maxDecaySlopeMvMs.toFixed(1) : '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase plot tab — Vm vs dV/dt for one selected spike
// ---------------------------------------------------------------------------

function APPhasePlotPanel({
  backendUrl, entry, group, series, trace, visibilitySignal, heightSignal,
  selectedSpikeIndices, hideMarkers,
}: {
  backendUrl: string
  entry: APData | undefined
  group: number; series: number; trace: number
  visibilitySignal?: number
  /** Parent splitter height — the panel sets uPlot size on every
   *  bump so dragging the splitter re-fits the plot. */
  heightSignal?: number
  /** When non-empty, overlay one phase loop per selected spike
   *  (colour-cycled). When empty, fall back to the entry's
   *  selectedSpikeIdx so the panel always shows something. */
  selectedSpikeIndices: Set<number>
  /** When true, suppress the threshold/peak/AHP marker dots in the
   *  loop. Useful when overlaying many spikes — markers stack. */
  hideMarkers: boolean
}) {
  void hideMarkers  // not yet used inside the loop; reserved for future per-spike marker dots
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Default 10 ms window — big enough to capture the full AP loop
  // (rising phase → peak → repolarisation → AHP back to baseline).
  const [windowMs, setWindowMs] = useState(10)
  // Default 1× (no upsampling) — the kinetics measurements are
  // already computed at the acquisition rate, and 10× was making
  // the phase-loop look over-smoothed on typical 20-50 kHz recordings.
  const [interp, setInterp] = useState(1)

  // Which spikes to plot. If the user has checked any, use that set;
  // otherwise fall back to a single-spike view of the table-active
  // selection so the panel never goes blank just because nothing is
  // checked.
  const spikesToPlot: APPoint[] = useMemo(() => {
    if (!entry || entry.perSpike.length === 0) return []
    if (selectedSpikeIndices.size > 0) {
      return [...selectedSpikeIndices]
        .sort((a, b) => a - b)
        .map((i) => entry.perSpike[i])
        .filter((sp): sp is APPoint => !!sp)
    }
    const fallback = entry.selectedSpikeIdx ?? 0
    const sp = entry.perSpike[fallback]
    return sp ? [sp] : []
  }, [entry, selectedSpikeIndices])
  const total = entry?.perSpike.length ?? 0
  const selectedIdx = entry?.selectedSpikeIdx ?? 0
  const selectedSpike: APPoint | null = entry?.perSpike[selectedIdx] ?? null

  // Per-spike fetched phase-plot data. Keyed by `${sweep}:${peakT}`
  // so re-rendering with the same set doesn't refetch.
  const [phaseSlices, setPhaseSlices] = useState<Record<string, { vm: number[]; dvdt: number[] } | null>>({})

  useEffect(() => {
    if (!backendUrl || spikesToPlot.length === 0) { setPhaseSlices({}); return }
    let cancelled = false
    const fetches = spikesToPlot.map(async (sp) => {
      const key = `${sp.sweep}:${sp.peakT}`
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(trace),
        sweep: String(sp.sweep),
        peak_t_s: String(sp.peakT),
        window_ms: String(windowMs),
        interp_factor: String(interp),
      })
      try {
        const r = await fetch(`${backendUrl}/api/ap/phase_plot?${qs}`)
        if (!r.ok) return [key, null] as const
        const d = await r.json()
        return [key, { vm: d.vm ?? [], dvdt: d.dvdt ?? [] }] as const
      } catch {
        return [key, null] as const
      }
    })
    Promise.all(fetches).then((entries) => {
      if (cancelled) return
      const next: Record<string, { vm: number[]; dvdt: number[] } | null> = {}
      for (const [k, v] of entries) next[k] = v
      setPhaseSlices(next)
    })
    return () => { cancelled = true }
  }, [backendUrl, group, series, trace, spikesToPlot, windowMs, interp])

  // Single representative slice for the legacy max-Vm/max-dV/dt
  // header readout (use the active row's slice).
  const data = selectedSpike ? phaseSlices[`${selectedSpike.sweep}:${selectedSpike.peakT}`] ?? null : null

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    // Collect all the loops we have data for, in the same order as
    // spikesToPlot so colours stay consistent with the per-spike
    // rows in the table.
    const loops: { vm: number[]; dvdt: number[] }[] = []
    for (const sp of spikesToPlot) {
      const k = `${sp.sweep}:${sp.peakT}`
      const slice = phaseSlices[k]
      if (slice && slice.vm.length >= 2) loops.push(slice)
    }
    if (loops.length === 0) return

    // uPlot's AlignedData layout requires a SHARED x array across
    // series. For overlaid phase plots we need each loop to have
    // its OWN Vm vector — they're not aligned. Cleanest workaround:
    // build a synthetic shared "sample index" x and feed each loop
    // as a (synthetic-x, vm) pair... no, that doesn't work either.
    //
    // Actual approach: build a single padded x/y per series. The
    // x array becomes the LONGEST loop's Vm. Shorter loops get
    // null-padded. uPlot then plots each series on its own y vs
    // the SAME x, but the x values per series are also stored as
    // ALIGNED to one master. To overlay loops with different Vm
    // ranges, we use the trick: the Vm array goes into POSITION 0
    // (the common x). For multi-loop, we'd need a different approach.
    //
    // In practice the simplest reliable thing: concatenate all loops
    // into one (vm, dvdt) pair separated by NaN gaps. uPlot honours
    // null/undefined breaks in the path, so each loop draws as its
    // own segment without connecting lines between them. Loses the
    // per-spike colour distinction though.
    //
    // Better: render each loop as its own series. uPlot allows that
    // if we use the same x but each y can have different valid spans.
    // Trick: pick the FIRST loop's vm as the canonical x; subsequent
    // loops are projected onto it via index. Loops with different
    // lengths get padded/clipped. This loses fidelity if loops have
    // wildly different lengths but the typical case (similar window,
    // similar AP shape) works fine.
    //
    // Pragma: use the longest loop as the canonical x; pad shorter
    // ones with nulls; assign each its own series with its own colour.
    let longest = loops[0]
    for (const l of loops) if (l.vm.length > longest.vm.length) longest = l
    const xData = longest.vm.slice()
    const yArrays = loops.map((l) => {
      // For the canonical loop, no padding needed.
      if (l === longest) return l.dvdt.slice()
      // For others, repeat-pad/truncate so the array length matches.
      // This is a visual approximation — the loop will be drawn
      // against the canonical x positions, not its own. Acceptable
      // for similar-shaped APs.
      const out: (number | null)[] = new Array(xData.length).fill(null)
      const stride = l.vm.length / xData.length
      for (let i = 0; i < xData.length; i++) {
        const j = Math.min(l.vm.length - 1, Math.floor(i * stride))
        out[i] = l.dvdt[j]
      }
      return out
    })

    // Pin x/y ranges to the union extent of all loops + a little pad.
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
    for (const l of loops) {
      for (let i = 0; i < l.vm.length; i++) {
        const x = l.vm[i], y = l.dvdt[i]
        if (x < xmin) xmin = x; if (x > xmax) xmax = x
        if (y < ymin) ymin = y; if (y > ymax) ymax = y
      }
    }
    const xpad = (xmax - xmin) * 0.05 || 1
    const ypad = (ymax - ymin) * 0.05 || 1
    const xRange: [number, number] = [xmin - xpad, xmax + xpad]
    const yRange: [number, number] = [ymin - ypad, ymax + ypad]

    // Colour cycle — first loop = primary trace colour, others
    // shifted around the wheel by HSL rotation.
    const palette = [
      cssVar('--trace-color-1') || '#42a5f5',
      '#e57373', '#81c784', '#ba68c8', '#ffb74d', '#4dd0e1',
      '#aed581', '#f06292', '#9575cd', '#fff176',
    ]
    const seriesOpts: uPlot.Series[] = [{}]
    for (let i = 0; i < loops.length; i++) {
      seriesOpts.push({
        stroke: palette[i % palette.length],
        width: 1.25,
        points: { show: false },
      })
    }

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(180, el.clientHeight || 280),
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: () => yRange },
      },
      legend: { show: false },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'Vm (mV)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'dV/dt (mV/ms)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: seriesOpts,
    }
    const payload: uPlot.AlignedData = [xData, ...yArrays] as any
    plotRef.current = new uPlot(opts, payload, el)
  }, [phaseSlices, spikesToPlot])

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
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  // Visibility signal — when the Phase tab becomes active the parent
  // bumps this; we resize+redraw on the next frame so the plot snaps
  // to the now-real container size (it was display:none before).
  useEffect(() => {
    if (visibilitySignal == null) return
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visibilitySignal])

  // Splitter / window resize signal from the parent. ResizeObserver
  // doesn't always fire reliably when the parent flexbox redistributes
  // height, so we explicitly setSize on every heightSignal bump. Two
  // rAFs deep so layout has actually flushed (a single rAF still runs
  // before the layout pass that follows the height change in some
  // browsers).
  useEffect(() => {
    if (heightSignal == null) return
    let r1 = 0, r2 = 0
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const u = plotRef.current
        const el = containerRef.current
        if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
          u.setSize({ width: el.clientWidth, height: el.clientHeight })
          u.redraw()
        }
      })
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [heightSignal])

  // setSel helper removed — prev/next now live in the overlay
  // viewer's header (single source of truth for spike navigation).

  return (
    // height: '100%' (not flex: 1) — the parent wrapper isn't a flex
    // container, so flex: 1 here was a no-op and the panel sized to
    // its content. That made the splitter's height changes invisible.
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', fontSize: 'var(--font-size-label)',
      }}>
        {/* Prev / next moved to the overlay viewer's header —
            they drive BOTH panels (zoomed spike + phase loop),
            so it made more sense to co-locate them with the
            primary viewer rather than embed them here. */}
        <span style={{ marginRight: 4, color: 'var(--text-muted)' }}>window ±</span>
        <NumInput value={windowMs} step={1} min={1}
          onChange={(v) => setWindowMs(Math.max(1, v))} style={{ width: 56 }} />
        <span style={{ color: 'var(--text-muted)' }}>ms</span>
        <span style={{ marginLeft: 16, color: 'var(--text-muted)' }}>interp</span>
        <select value={interp}
          onChange={(e) => setInterp(Number(e.target.value))}
          style={{ fontSize: 'var(--font-size-label)' }}>
          <option value="1">1×</option>
          <option value="10">10×</option>
          <option value="50">50×</option>
          <option value="100">100×</option>
        </select>
        {data && data.vm.length > 0 && (() => {
          // Header readout: peak / max-dV/dt / min-dV/dt for the
          // table-active spike. Computed locally now that we no
          // longer carry a metrics blob in the per-spike fetch.
          let mv = -Infinity, mdv = -Infinity, mndv = Infinity
          for (let i = 0; i < data.vm.length; i++) {
            if (data.vm[i] > mv) mv = data.vm[i]
            if (data.dvdt[i] > mdv) mdv = data.dvdt[i]
            if (data.dvdt[i] < mndv) mndv = data.dvdt[i]
          }
          return (
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              max Vm {mv.toFixed(1)} ·
              max dV/dt {mdv.toFixed(1)} ·
              min dV/dt {mndv.toFixed(1)}
            </span>
          )
        })()}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        {/* Always-mounted plot container so ResizeObserver attaches
            on first mount, not after data arrives. The empty-state
            overlay sits on top via absolute positioning when the plot
            has nothing to show yet. */}
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
        {(!data || data.vm.length < 2) && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
            background: 'var(--bg-primary)',
            pointerEvents: 'none',
          }}>
            {entry && total > 0
              ? 'Loading phase plot…'
              : 'Run to populate the phase plot, then pick a spike.'}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AP sweep viewer — Vm trace + draggable bounds bands + spike markers
// ---------------------------------------------------------------------------

function APSweepViewer({
  traceTime, traceValues, traceUnits,
  previewSweep, totalSweeps,
  theme, fontSize,
  zeroOffset, onZeroOffsetChange, zeroOffsetApplied,
  boundsStartS, boundsEndS, onBoundsChange,
  previewSpikes,
  entry,
  heightSignal,
  zoomToSpikeRequest,
  onXRangeChange,
}: {
  traceTime: number[] | null
  traceValues: number[] | null
  traceUnits: string
  previewSweep: number
  totalSweeps: number
  theme: string
  fontSize: number
  zeroOffset: boolean
  onZeroOffsetChange: (v: boolean) => void
  zeroOffsetApplied: number
  boundsStartS: number
  boundsEndS: number
  onBoundsChange: (start: number, end: number) => void
  /** Per-spike measurements for the current preview sweep — drives
   *  the threshold/peak/half-width/fAHP/mAHP overlay markers. */
  previewSpikes: APPoint[]
  entry: APData | undefined
  /** Parent splitter / window height. uPlot resizes on change. */
  heightSignal?: number
  /** Bumped by the parent when a kinetics row is clicked: viewer
   *  zooms its x range to centre ± half-width-ms around the spike. */
  zoomToSpikeRequest?: { bump: number; centerT: number; halfMs: number } | null
  /** Fired when the user pans / wheel-zooms / resets, so stacked
   *  overlay viewers can mirror the x range. */
  onXRangeChange?: (xMin: number, xMax: number) => void
}) {
  void previewSweep; void totalSweeps; void traceUnits
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const boundsRef = useRef({ start: boundsStartS, end: boundsEndS })
  boundsRef.current = { start: boundsStartS, end: boundsEndS }
  const spikesRef = useRef<APPoint[]>(previewSpikes)
  spikesRef.current = previewSpikes
  const offsetRef = useRef(zeroOffsetApplied)
  offsetRef.current = zeroOffsetApplied
  const entryRef = useRef(entry)
  entryRef.current = entry
  // Stash the X-range-change callback in a ref so the wheel/pan/reset
  // handlers (which are wired once and never rebuilt) always see the
  // latest prop value without forcing a remount.
  const onXRangeChangeRef = useRef(onXRangeChange)
  onXRangeChangeRef.current = onXRangeChange
  const emitXRange = (xMin: number, xMax: number) => {
    try { onXRangeChangeRef.current?.(xMin, xMax) } catch { /* ignore */ }
  }

  const drawOverlays = (u: uPlot) => {
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1
    const top = u.bbox.top
    const bottom = u.bbox.top + u.bbox.height
    // Bounds bands — translucent blue, label inside.
    const drawBand = (x0: number, x1: number, color: string, label: string) => {
      const px0 = u.valToPos(x0, 'x', true)
      const px1 = u.valToPos(x1, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.14
      ctx.fillStyle = color
      ctx.fillRect(Math.min(px0, px1), top, Math.abs(px1 - px0), bottom - top)
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, top + 12 * dpr)
      ctx.restore()
    }
    const b = boundsRef.current
    // Effective end — when set to 0, treat as full sweep so the band
    // visually spans the whole trace rather than collapsing to a line.
    const effEnd = b.end > b.start
      ? b.end
      : (u.scales.x.max ?? b.start)
    drawBand(b.start, effEnd, BOUND_COLOR, 'analysis bounds')

    // Per-spike markers on the trace. Drawn on the overlay canvas
    // (separate from the uPlot canvas so they don't interact with
    // its scale callbacks). Five marker types per spike — colours
    // match the kinetics-table semantics and are tooltipped in the
    // legend strip.
    const offset = offsetRef.current
    const spikes = spikesRef.current
    const overlayCanvas = overlayRef.current
    if (!overlayCanvas) return
    const oCtx = overlayCanvas.getContext('2d')
    if (!oCtx) return
    const cssW = overlayCanvas.clientWidth
    const cssH = overlayCanvas.clientHeight
    if (overlayCanvas.width !== cssW * dpr || overlayCanvas.height !== cssH * dpr) {
      overlayCanvas.width = cssW * dpr; overlayCanvas.height = cssH * dpr
    }
    oCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    oCtx.clearRect(0, 0, cssW, cssH)
    if (spikes.length === 0) return

    const toPx = (t: number, v: number): [number, number] => [
      u.valToPos(t, 'x', true) / dpr,
      u.valToPos(v - offset, 'y', true) / dpr,
    ]
    const dot = (px: number, py: number, color: string, ring: boolean = false) => {
      if (!isFinite(px) || !isFinite(py)) return
      oCtx.beginPath()
      oCtx.arc(px, py, 5, 0, Math.PI * 2)
      oCtx.fillStyle = color; oCtx.fill()
      oCtx.strokeStyle = '#ffffff'; oCtx.lineWidth = 1.2; oCtx.stroke()
      if (ring) {
        oCtx.beginPath()
        oCtx.arc(px, py, 9, 0, Math.PI * 2)
        oCtx.strokeStyle = color; oCtx.lineWidth = 1.5
        oCtx.stroke()
      }
    }

    // Find the nearest trace sample for a given peak time — used
    // when the spike record only has the peak time (kinetics not
    // measured) so we can still place a peak dot on the trace.
    const tt = traceTime
    const tv = traceValues
    const nearestY = (t: number): number | null => {
      if (!tt || !tv || tt.length === 0) return null
      let idx = 0; let best = Infinity
      for (let i = 0; i < tt.length; i++) {
        const d = Math.abs(tt[i] - t)
        if (d < best) { best = d; idx = i }
      }
      return tv[idx]
    }

    for (const sp of spikes) {
      // Peak — always present (manual flag rings it).
      if (sp.peakVm !== 0 || sp.thresholdVm !== 0) {
        const [px, py] = toPx(sp.peakT, sp.peakVm)
        dot(px, py, SPIKE_COLOR, sp.manual)
      } else {
        // Fallback (no kinetics) — place peak at the nearest sample y.
        const y = nearestY(sp.peakT)
        if (y != null) {
          const [px, py] = toPx(sp.peakT, y)
          dot(px, py, SPIKE_COLOR, sp.manual)
        }
      }
      // Threshold dot (foot of the spike).
      if (sp.thresholdVm !== 0 || sp.thresholdT !== 0) {
        const [px, py] = toPx(sp.thresholdT, sp.thresholdVm)
        dot(px, py, '#9e9e9e')
      }
      // Half-width markers — find the actual times where the trace
      // crosses (threshold + amplitude/2) on the rising and falling
      // sides of the spike. The backend returns half_width in
      // duration only; positioning the markers via algebraic
      // approximation drifted off the trace, so we walk the displayed
      // samples here. Slightly more code, dots actually land on it.
      if (sp.halfWidthS != null && sp.amplitudeMv > 0 && tt && tv) {
        const halfV = sp.thresholdVm + sp.amplitudeMv / 2
        // Clip search to a sensible window: from threshold time to
        // peak time + half-width-extra (so we catch the falling
        // crossing even if it sits slightly past peak + halfWidth).
        const tLo = sp.thresholdT
        const tHi = sp.peakT + sp.halfWidthS + 0.005
        // Linear-interp the rising crossing (between threshold and peak)
        // and the falling crossing (between peak and tHi).
        const findCrossing = (t0: number, t1: number, ascending: boolean): number | null => {
          let prevT = -Infinity, prevV = NaN
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i]
            if (t < t0) { prevT = t; prevV = tv[i]; continue }
            if (t > t1) break
            const v = tv[i]
            const above = v >= halfV
            const wasAbove = isFinite(prevV) ? prevV >= halfV : null
            if (wasAbove != null) {
              if (ascending && !wasAbove && above) {
                const frac = (halfV - prevV) / (v - prevV)
                return prevT + frac * (t - prevT)
              }
              if (!ascending && wasAbove && !above) {
                const frac = (halfV - prevV) / (v - prevV)
                return prevT + frac * (t - prevT)
              }
            }
            prevT = t; prevV = v
          }
          return null
        }
        const tLeft = findCrossing(tLo, sp.peakT, true)
        const tRight = findCrossing(sp.peakT, tHi, false)
        if (tLeft != null && tRight != null) {
          const [pxL, pyL] = toPx(tLeft, halfV)
          const [pxR, pyR] = toPx(tRight, halfV)
          if (isFinite(pxL) && isFinite(pyL) && isFinite(pxR) && isFinite(pyR)) {
            oCtx.save()
            oCtx.strokeStyle = '#ffeb3b'
            oCtx.lineWidth = 1
            oCtx.setLineDash([3, 3])
            oCtx.beginPath()
            oCtx.moveTo(pxL, pyL); oCtx.lineTo(pxR, pyR)
            oCtx.stroke()
            oCtx.setLineDash([])
            oCtx.restore()
            dot(pxL, pyL, '#ffeb3b'); dot(pxR, pyR, '#ffeb3b')
          }
        }
      }
      // fAHP marker (post-peak fast undershoot).
      if (sp.fahpVm != null && sp.fahpT != null) {
        const [px, py] = toPx(sp.fahpT, sp.fahpVm)
        dot(px, py, '#ffb74d')
      }
      // mAHP marker (slower medium undershoot).
      if (sp.mahpVm != null && sp.mahpT != null) {
        const [px, py] = toPx(sp.mahpT, sp.mahpVm)
        dot(px, py, '#ff7043')
      }
    }
  }

  const resetZoom = () => {
    const u = plotRef.current
    if (!u || !traceTime || !traceValues) return
    xRangeRef.current = null
    yRangeRef.current = null
    if (traceTime.length === 0) return
    const xmin = traceTime[0], xmax = traceTime[traceTime.length - 1]
    let ymin = Infinity, ymax = -Infinity
    for (const v of traceValues) {
      const vv = v - zeroOffsetApplied
      if (vv < ymin) ymin = vv; if (vv > ymax) ymax = vv
    }
    if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) {
      u.setScale('x', { min: xmin, max: xmax })
      emitXRange(xmin, xmax)
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !traceTime || !traceValues) {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      return
    }
    const frame = requestAnimationFrame(() => {
      if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)
      const offset = zeroOffsetApplied
      const adjusted = traceValues.map((v) => v - offset)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: {
            time: false,
            range: (_u, dataMin, dataMax) => {
              if (xRangeRef.current) return xRangeRef.current
              const lo = isFinite(dataMin) ? dataMin : 0
              const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
              const r: [number, number] = [lo, hi]
              xRangeRef.current = r
              // Notify overlay viewers of the initial auto-fit range
              // on the very first draw, so they mirror it immediately
              // rather than waiting for the user to interact.
              emitXRange(lo, hi)
              return r
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              if (yRangeRef.current) return yRangeRef.current
              if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) return [0, 1]
              const pad = (dataMax - dataMin) * 0.05
              const r: [number, number] = [dataMin - pad, dataMax + pad]
              yRangeRef.current = r
              return r
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'mV', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25, points: { show: false } },
        ],
        hooks: { draw: [(u) => drawOverlays(u)] },
      }
      plotRef.current = new uPlot(opts, [traceTime, adjusted], container)
      // ---- Wheel zoom + drag-to-pan + drag bounds-band edges ----
      const u = plotRef.current
      const over = container.querySelector<HTMLDivElement>('.u-over')
      if (!over) return
      const EDGE_PX = 6

      const xToPx = (x: number) => u.valToPos(x, 'x', false)
      const pxToX = (px: number) => u.posToVal(px, 'x')

      type Drag =
        | { kind: 'bound-edge'; which: 'start' | 'end' }
        | { kind: 'bound-band'; startPxX: number; startStart: number; startEnd: number }
        | { kind: 'pan'; startPxX: number; startPxY: number;
            xMin: number; xMax: number; yMin: number; yMax: number }
      let drag: Drag | null = null

      const findHit = (pxX: number): Drag | null => {
        const b = boundsRef.current
        const effEnd = b.end > b.start ? b.end : (u.scales.x.max ?? b.start)
        const pxStart = xToPx(b.start)
        const pxEnd = xToPx(effEnd)
        if (Math.abs(pxX - pxStart) <= EDGE_PX) return { kind: 'bound-edge', which: 'start' }
        if (b.end > b.start && Math.abs(pxX - pxEnd) <= EDGE_PX) return { kind: 'bound-edge', which: 'end' }
        if (pxX > Math.min(pxStart, pxEnd) + EDGE_PX && pxX < Math.max(pxStart, pxEnd) - EDGE_PX) {
          return { kind: 'bound-band', startPxX: pxX, startStart: b.start, startEnd: b.end }
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
          // Empty area → pan both axes.
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (xMin == null || xMax == null || yMin == null || yMax == null) return
          drag = { kind: 'pan', startPxX: pxX, startPxY: pxY, xMin, xMax, yMin, yMax }
        }
        over.setPointerCapture(ev.pointerId)
        over.style.cursor = drag.kind === 'pan' ? 'grabbing' : 'ew-resize'
      }
      const onPointerMove = (ev: PointerEvent) => {
        if (!drag) {
          // Hover affordance for bound edges.
          const rect = over.getBoundingClientRect()
          const hit = findHit(ev.clientX - rect.left)
          over.style.cursor = hit ? (hit.kind === 'bound-edge' ? 'ew-resize' : 'grab') : ''
          return
        }
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        if (drag.kind === 'bound-edge') {
          const newT = pxToX(pxX)
          const b = boundsRef.current
          if (drag.which === 'start') {
            onBoundsChange(Math.max(0, newT), b.end)
          } else {
            onBoundsChange(b.start, Math.max(b.start + 0.001, newT))
          }
        } else if (drag.kind === 'bound-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          onBoundsChange(
            Math.max(0, drag.startStart + dx),
            Math.max(drag.startStart + dx + 0.001, drag.startEnd + dx),
          )
        } else if (drag.kind === 'pan') {
          const bboxW = u.bbox.width / (devicePixelRatio || 1)
          const bboxH = u.bbox.height / (devicePixelRatio || 1)
          const dxPx = pxX - drag.startPxX
          const dyPx = pxY - drag.startPxY
          const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
          const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
          const nx: [number, number] = [drag.xMin + dx, drag.xMax + dx]
          const ny: [number, number] = [drag.yMin + dy, drag.yMax + dy]
          xRangeRef.current = nx
          yRangeRef.current = ny
          u.setScale('x', { min: nx[0], max: nx[1] })
          u.setScale('y', { min: ny[0], max: ny[1] })
          emitXRange(nx[0], nx[1])
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        drag = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
      }
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        if (ev.altKey) {
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (yMin == null || yMax == null) return
          const yAtCur = u.posToVal(pxY, 'y')
          const newMin = yAtCur - (yAtCur - yMin) * factor
          const newMax = yAtCur + (yMax - yAtCur) * factor
          yRangeRef.current = [newMin, newMax]
          u.setScale('y', { min: newMin, max: newMax })
        } else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          if (xMin == null || xMax == null) return
          const xAtCur = u.posToVal(pxX, 'x')
          const newMin = xAtCur - (xAtCur - xMin) * factor
          const newMax = xAtCur + (xMax - xAtCur) * factor
          xRangeRef.current = [newMin, newMax]
          u.setScale('x', { min: newMin, max: newMax })
          emitXRange(newMin, newMax)
        }
      }
      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues, zeroOffsetApplied])

  useEffect(() => { plotRef.current?.redraw() }, [boundsStartS, boundsEndS])
  useEffect(() => { plotRef.current?.redraw() }, [previewSpikes, entry, theme, fontSize])

  // Resize on container size changes (splitter drag, window resize)
  // and on heightSignal bumps (parent's topHeight). Same 0-dim guard
  // we settled on for the FPsp viewer.
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
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
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

  // Zoom to a spike when the parent issues a request — e.g. user
  // clicked a kinetics row and wants to inspect the markers up close.
  useEffect(() => {
    if (!zoomToSpikeRequest) return
    const u = plotRef.current
    if (!u) return
    const half = zoomToSpikeRequest.halfMs / 1000
    const lo = zoomToSpikeRequest.centerT - half
    const hi = zoomToSpikeRequest.centerT + half
    xRangeRef.current = [lo, hi]
    u.setScale('x', { min: lo, max: hi })
    u.redraw()
    emitXRange(lo, hi)
  }, [zoomToSpikeRequest])

  // Emit the initial auto-fit range so overlay viewers mirror it
  // before the user does anything. Fires once per plot build.
  useEffect(() => {
    const u = plotRef.current
    if (!u) return
    const r = xRangeRef.current
    if (r) emitXRange(r[0], r[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <span>sweep {previewSweep + 1}</span>
        <span>{previewSpikes.length} spike{previewSpikes.length === 1 ? '' : 's'}</span>
        <APMarkerLegend />
        <label style={{
          display: 'flex', alignItems: 'center', gap: 3, marginLeft: 'auto',
        }} title="Subtract per-sweep baseline (first ~3 ms) from the displayed trace">
          <input type="checkbox" checked={zeroOffset}
            onChange={(e) => onZeroOffsetChange(e.target.checked)} />
          Zero offset
        </label>
        <button className="btn" onClick={resetZoom}
          style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}
          title="Reset X+Y to data bounds">Reset zoom</button>
      </div>
      <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <canvas ref={overlayRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%' }} />
      </div>
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y · drag = pan · drag bounds edge / band to move
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  label: string
  value: number
  step: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  // Explicit narrow width for the left-column layout — without it
  // NumInput stretches to fill the full column (~300 px in a
  // single-column grid), which wastes horizontal space when the
  // actual typed values are 3–4 digits.
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange}
        style={{ width: 110 }} />
    </label>
  )
}

/** Thin section divider inside a two-column param grid. Spans the
 *  full grid width via gridColumn. Small uppercase label + a hairline
 *  top border gives the panel a scannable structure without stealing
 *  vertical space. */
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

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)

// Shut up unused-import warnings until we add a manual-edit polish pass.
void MANUAL_COLOR

// ---------------------------------------------------------------------------
// APSpikesOverlayViewer — Kinetics-tab left side
//
// Fetches a per-spike trace slice (peak ± window) for every spike in
// `selectedSpikeIndices` and overlays them on a single uPlot, time-
// aligned to t=0 at each spike's peak. When the selection is empty,
// falls back to the entry's selectedSpikeIdx so the panel always
// shows something.
//
// "Hide markers" suppresses the per-spike threshold/peak/AHP overlay
// dots (useful when overlaying many spikes — markers stack into a
// blob otherwise).
// ---------------------------------------------------------------------------

const OVERLAY_PALETTE = [
  '#42a5f5', '#e57373', '#81c784', '#ba68c8', '#ffb74d',
  '#4dd0e1', '#aed581', '#f06292', '#9575cd', '#fff176',
]

function APSpikesOverlayViewer({
  backendUrl, entry, group, series, trace,
  selectedSpikeIndices, hideMarkers, onHideMarkersChange,
  onSelectAll, onClearSelection, onSelectSpike,
  filter, zeroOffset,
  visibilitySignal, heightSignal,
}: {
  backendUrl: string
  entry: APData | undefined
  group: number; series: number; trace: number
  selectedSpikeIndices: Set<number>
  hideMarkers: boolean
  onHideMarkersChange: (v: boolean) => void
  onSelectAll: () => void
  onClearSelection: () => void
  /** Spike-navigation setter — moves the table-active spike index.
   *  Lives here (instead of in the phase-plot header) because this
   *  viewer is the primary one; prev/next affect both panels. */
  onSelectSpike: (idx: number) => void
  /** Echo the AP detection filter so the displayed slice matches the
   *  signal the detector ran on (mirrors what FPsp does). null = off. */
  filter: { type: 'lowpass' | 'highpass' | 'bandpass'; low: number; high: number; order: number } | null
  /** Apply the same per-sweep zero-offset the AP sweep viewer uses
   *  so overlaid spikes align in y when from different baselines. */
  zeroOffset: boolean
  visibilitySignal?: number
  heightSignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [windowMs, setWindowMs] = useState(15)

  // Spikes to display: the user's checkbox set, or fall back to the
  // active row when nothing's checked.
  const spikesToShow: APPoint[] = useMemo(() => {
    if (!entry || entry.perSpike.length === 0) return []
    if (selectedSpikeIndices.size > 0) {
      return [...selectedSpikeIndices]
        .sort((a, b) => a - b)
        .map((i) => entry.perSpike[i])
        .filter((sp): sp is APPoint => !!sp)
    }
    const fallback = entry.selectedSpikeIdx ?? 0
    const sp = entry.perSpike[fallback]
    return sp ? [sp] : []
  }, [entry, selectedSpikeIndices])

  // Per-spike fetched slice. Keyed on `${sweep}:${peakT}` so the same
  // selection (or selection subset) doesn't re-fetch.
  const [slices, setSlices] = useState<Record<string, { time: number[]; values: number[] } | null>>({})
  // Mirror slices into a ref so drawMarkerOverlay — which is called
  // from the uPlot draw hook without state access — can look up the
  // per-spike trace data to compute FWHM crossings on the fly.
  const slicesRef = useRef(slices)
  slicesRef.current = slices

  useEffect(() => {
    if (!backendUrl || spikesToShow.length === 0) { setSlices({}); return }
    let cancelled = false
    const half = windowMs / 1000
    const fetches = spikesToShow.map(async (sp) => {
      const key = `${sp.sweep}:${sp.peakT}`
      const t0 = Math.max(0, sp.peakT - half)
      const t1 = sp.peakT + half
      const qs = new URLSearchParams({
        group: String(group), series: String(series), trace: String(trace),
        sweep: String(sp.sweep),
        t_start: String(t0), t_end: String(t1),
        max_points: '0',
      })
      if (zeroOffset) qs.set('zero_offset', 'true')
      if (filter) {
        qs.set('filter_type', filter.type)
        qs.set('filter_low', String(filter.low))
        qs.set('filter_high', String(filter.high))
        qs.set('filter_order', String(filter.order))
      }
      try {
        const r = await fetch(`${backendUrl}/api/traces/data?${qs}`)
        if (!r.ok) return [key, null] as const
        const d = await r.json()
        return [key, { time: d.time ?? [], values: d.values ?? [] }] as const
      } catch {
        return [key, null] as const
      }
    })
    Promise.all(fetches).then((entries) => {
      if (cancelled) return
      const next: Record<string, { time: number[]; values: number[] } | null> = {}
      for (const [k, v] of entries) next[k] = v
      setSlices(next)
    })
    return () => { cancelled = true }
  }, [backendUrl, group, series, trace, spikesToShow, windowMs, zeroOffset, filter])

  const drawMarkerOverlay = (u: uPlot) => {
    if (hideMarkers) {
      const c = overlayRef.current
      if (c) {
        const ctx = c.getContext('2d')
        const dpr = devicePixelRatio || 1
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, c.clientWidth, c.clientHeight)
        }
      }
      return
    }
    const c = overlayRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const dpr = devicePixelRatio || 1
    const cssW = c.clientWidth, cssH = c.clientHeight
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    // Standard marker colours per quantity (peak / threshold / FWHM /
    // fAHP / mAHP) — same scheme on every viewer so users learn the
    // legend once. The trace LINES are colour-cycled per spike; only
    // the marker dots use these semantic colours.
    spikesToShow.forEach((sp) => {
      const dotAt = (xRel: number, y: number, colour: string) => {
        const px = u.valToPos(xRel, 'x', true) / dpr
        const py = u.valToPos(y, 'y', true) / dpr
        if (!isFinite(px) || !isFinite(py)) return
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
        ctx.stroke()
      }
      // x is time-relative-to-peak (s).
      dotAt(0, sp.peakVm, '#e57373')                            // peak (red)
      if (sp.thresholdT !== 0 || sp.thresholdVm !== 0) {
        dotAt(sp.thresholdT - sp.peakT, sp.thresholdVm, '#9e9e9e')  // threshold
      }
      if (sp.fahpT != null && sp.fahpVm != null) {
        dotAt(sp.fahpT - sp.peakT, sp.fahpVm, '#ffb74d')        // fAHP
      }
      if (sp.mahpT != null && sp.mahpVm != null) {
        dotAt(sp.mahpT - sp.peakT, sp.mahpVm, '#ff7043')        // mAHP
      }
      // FWHM crossings — walk the per-spike slice to find the two
      // times the trace actually crosses (threshold + amp/2). Dots
      // land on the trace, not on an approximation.
      if (sp.halfWidthS != null && sp.amplitudeMv > 0) {
        const slice = slicesRef.current[`${sp.sweep}:${sp.peakT}`]
        if (slice && slice.time.length > 1) {
          const halfV = sp.thresholdVm + sp.amplitudeMv / 2
          // Bound the search to threshold → peak (rising) and
          // peak → peak+halfWidth+slop (falling), in absolute time.
          const tLo = sp.thresholdT
          const tHi = sp.peakT + sp.halfWidthS + 0.005
          const findCross = (t0: number, t1: number, ascending: boolean): number | null => {
            let prevT = -Infinity, prevV = NaN
            for (let i = 0; i < slice.time.length; i++) {
              const t = slice.time[i]
              if (t < t0) { prevT = t; prevV = slice.values[i]; continue }
              if (t > t1) break
              const v = slice.values[i]
              if (isFinite(prevV)) {
                const above = v >= halfV
                const wasAbove = prevV >= halfV
                if (ascending && !wasAbove && above) {
                  const frac = (halfV - prevV) / (v - prevV)
                  return prevT + frac * (t - prevT)
                }
                if (!ascending && wasAbove && !above) {
                  const frac = (halfV - prevV) / (v - prevV)
                  return prevT + frac * (t - prevT)
                }
              }
              prevT = t; prevV = v
            }
            return null
          }
          const tLeft = findCross(tLo, sp.peakT, true)
          const tRight = findCross(sp.peakT, tHi, false)
          if (tLeft != null && tRight != null) {
            // Rel-to-peak x for the overlay's time-aligned axis.
            dotAt(tLeft - sp.peakT, halfV, '#ffeb3b')
            dotAt(tRight - sp.peakT, halfV, '#ffeb3b')
          }
        }
      }
    })
  }

  // (Re)build the plot whenever the slices map changes. Each spike
  // is its own series with its own colour. X axis = time relative
  // to peak (s) → −window ... +window.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (spikesToShow.length === 0) return
    const ready = spikesToShow.every((sp) => slices[`${sp.sweep}:${sp.peakT}`])
    if (!ready) return

    // Build per-spike (xRel, y) arrays. Each spike's time vector is
    // shifted so peak lands at x=0.
    const longest = spikesToShow.reduce((acc, sp) => {
      const sl = slices[`${sp.sweep}:${sp.peakT}`]
      return sl && sl.time.length > acc.length ? sl.time.map((t) => t - sp.peakT) : acc
    }, [] as number[])
    if (longest.length === 0) return

    const seriesY = spikesToShow.map((sp) => {
      const sl = slices[`${sp.sweep}:${sp.peakT}`]
      if (!sl) return new Array(longest.length).fill(null)
      // Map onto the longest x grid by linear interpolation using
      // sample-index proportionality (cheap and good enough for
      // visual overlay; spikes have similar sample counts).
      const out: (number | null)[] = new Array(longest.length).fill(null)
      const stride = sl.time.length / longest.length
      for (let i = 0; i < longest.length; i++) {
        const j = Math.min(sl.values.length - 1, Math.floor(i * stride))
        out[i] = sl.values[j]
      }
      return out
    })

    // Range — union extent + tiny pad so all overlaid spikes fit.
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
    for (let i = 0; i < longest.length; i++) {
      if (longest[i] < xmin) xmin = longest[i]
      if (longest[i] > xmax) xmax = longest[i]
    }
    for (const ys of seriesY) {
      for (const y of ys) {
        if (y == null) continue
        if (y < ymin) ymin = y; if (y > ymax) ymax = y
      }
    }
    const xpad = (xmax - xmin) * 0.02 || 1
    const ypad = (ymax - ymin) * 0.05 || 1
    const xRange: [number, number] = [xmin - xpad, xmax + xpad]
    const yRange: [number, number] = [ymin - ypad, ymax + ypad]

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(180, el.clientHeight || 280),
      legend: { show: false },
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: () => yRange },
      },
      axes: [
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'Time relative to peak (s)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}` },
        { stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          label: 'Vm (mV)', labelSize: 22,
          labelFont: `${cssVar('--font-size-label')} ${cssVar('--font-ui')}` },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        ...spikesToShow.map((_, i) => ({
          stroke: OVERLAY_PALETTE[i % OVERLAY_PALETTE.length],
          width: 1.25,
          points: { show: false },
        })),
      ],
      hooks: { draw: [(u) => drawMarkerOverlay(u)] },
    }
    const payload: uPlot.AlignedData = [longest, ...seriesY] as any
    plotRef.current = new uPlot(opts, payload, el)
    drawMarkerOverlay(plotRef.current)

    // Wheel-zoom + drag-pan, same UX as the sweep viewer. Without
    // this the overlay viewer felt cramped — users couldn't zoom
    // into a specific region of the AP loop.
    const u = plotRef.current
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (!over) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      if (ev.altKey) {
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (yMin == null || yMax == null) return
        const yAtCur = u.posToVal(pxY, 'y')
        u.setScale('y', {
          min: yAtCur - (yAtCur - yMin) * factor,
          max: yAtCur + (yMax - yAtCur) * factor,
        })
      } else {
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        if (xMin == null || xMax == null) return
        const xAtCur = u.posToVal(pxX, 'x')
        u.setScale('x', {
          min: xAtCur - (xAtCur - xMin) * factor,
          max: xAtCur + (xMax - xAtCur) * factor,
        })
      }
    }
    let drag: null | {
      startPxX: number; startPxY: number
      xMin: number; xMax: number; yMin: number; yMax: number
    } = null
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return
      const rect = over.getBoundingClientRect()
      const xMin = u.scales.x.min, xMax = u.scales.x.max
      const yMin = u.scales.y.min, yMax = u.scales.y.max
      if (xMin == null || xMax == null || yMin == null || yMax == null) return
      drag = {
        startPxX: ev.clientX - rect.left,
        startPxY: ev.clientY - rect.top,
        xMin, xMax, yMin, yMax,
      }
      over.setPointerCapture(ev.pointerId)
      over.style.cursor = 'grabbing'
    }
    const onMove = (ev: PointerEvent) => {
      if (!drag) return
      const rect = over.getBoundingClientRect()
      const dxPx = (ev.clientX - rect.left) - drag.startPxX
      const dyPx = (ev.clientY - rect.top) - drag.startPxY
      const bboxW = u.bbox.width / (devicePixelRatio || 1)
      const bboxH = u.bbox.height / (devicePixelRatio || 1)
      const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
      const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
      u.setScale('x', { min: drag.xMin + dx, max: drag.xMax + dx })
      u.setScale('y', { min: drag.yMin + dy, max: drag.yMax + dy })
    }
    const onUp = (ev: PointerEvent) => {
      if (!drag) return
      drag = null
      try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      over.style.cursor = ''
    }
    over.addEventListener('wheel', onWheel, { passive: false })
    over.addEventListener('pointerdown', onDown)
    over.addEventListener('pointermove', onMove)
    over.addEventListener('pointerup', onUp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slices, spikesToShow, hideMarkers])

  useEffect(() => { plotRef.current?.redraw() }, [hideMarkers])

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
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    }
    window.addEventListener('resize', onWin)
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin) }
  }, [])

  useEffect(() => {
    if (visibilitySignal == null && heightSignal == null) return
    const raf = requestAnimationFrame(() => {
      const u = plotRef.current
      const el = containerRef.current
      if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
        u.redraw()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visibilitySignal, heightSignal])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      }}>
        {(() => {
          // Prev/next spike navigation — affects this viewer AND
          // the phase plot (both read from entry.selectedSpikeIdx).
          // Lives here since this viewer is the primary one.
          const total = entry?.perSpike.length ?? 0
          const active = entry?.selectedSpikeIdx ?? 0
          return (
            <>
              <button className="btn"
                onClick={() => onSelectSpike(Math.max(0, active - 1))}
                disabled={total === 0 || active <= 0}
                style={{ padding: '1px 8px' }}
                title="Previous spike (also drives the phase plot)">← prev</button>
              <span>
                spike {total > 0 ? active + 1 : '—'} / {total || '—'}
              </span>
              <button className="btn"
                onClick={() => onSelectSpike(Math.min(total - 1, active + 1))}
                disabled={total === 0 || active >= total - 1}
                style={{ padding: '1px 8px' }}
                title="Next spike (also drives the phase plot)">next →</button>
              <span style={{ color: 'var(--text-muted)' }}>·</span>
            </>
          )
        })()}
        <span>{spikesToShow.length} shown</span>
        <span style={{ color: 'var(--text-muted)' }}>· window ±</span>
        <NumInput value={windowMs} step={1} min={1}
          onChange={(v) => setWindowMs(Math.max(1, v))} style={{ width: 56 }} />
        <span style={{ color: 'var(--text-muted)' }}>ms</span>
        {!hideMarkers && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <APMarkerLegend />
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn" onClick={onSelectAll}
            style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}>
            Select all
          </button>
          <button className="btn" onClick={onClearSelection}
            disabled={selectedSpikeIndices.size === 0}
            style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)' }}>
            Clear
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}
            title="Hide threshold / peak / fAHP / mAHP marker dots — useful when overlaying many spikes.">
            <input type="checkbox" checked={hideMarkers}
              onChange={(e) => onHideMarkersChange(e.target.checked)} />
            Hide markers
          </label>
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <canvas ref={overlayRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, width: '100%', height: '100%' }} />
      </div>
      <div style={{
        padding: '2px 8px', fontSize: 'var(--font-size-label)',
        color: 'var(--text-muted)', fontStyle: 'italic',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y · drag = pan
      </div>
    </div>
  )
}

/** Tiny inline legend for the AP detection marker colours. Used in
 *  both the Counting-tab sweep viewer and the Kinetics-tab overlay
 *  viewer so the color → quantity mapping is consistent and
 *  discoverable without a separate help popup. */
function APMarkerLegend() {
  const items: { color: string; label: string }[] = [
    { color: '#e57373', label: 'peak' },
    { color: '#9e9e9e', label: 'threshold' },
    { color: '#ffeb3b', label: 'FWHM' },
    { color: '#ffb74d', label: 'fAHP' },
    { color: '#ff7043', label: 'mAHP' },
  ]
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: it.color, border: '1px solid rgba(255,255,255,0.6)',
          }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>{it.label}</span>
        </span>
      ))}
    </span>
  )
}
