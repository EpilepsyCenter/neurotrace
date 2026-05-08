import { useAppStore } from '../stores/appStore'

/** Bag of fields auto-collected from the renderer + store and shipped
 *  alongside the user's bug-report description. The shape matches the
 *  hidden-field labels on the Tally form (form ID ``ZjvoQB``); see
 *  components/BugReportModal/BugReportModal.tsx for the prefill URL.
 *
 *  Fields we can't fill cheaply (``python_version``, ``last_action``,
 *  ``log_tail``) are sent as empty strings — Tally treats those the
 *  same as unset and the report still goes through. We can wire them
 *  up later without touching the form schema. */
export interface BugDiagnostics {
  app_version: string
  os: string
  python_version: string
  view: string
  recording_format: string
  recording_size: string
  last_action: string
  last_error: string
  log_tail: string
  submission_id: string
}

/** Parse a coarse "Mac OS X 10.15.7" / "Windows NT 10.0" / "Linux x86_64"
 *  out of the user-agent string. Electron sets navigator.userAgent on
 *  the renderer with the host OS embedded; we don't need a precise
 *  build, just enough to triage by platform. */
function _osFromUA(): string {
  const ua = navigator.userAgent
  const platform = (window.electronAPI?.platform as string | undefined) ?? ''
  // Try to extract a marketing-style OS string from the UA.
  const macMatch = /Mac OS X ([\d_]+)/.exec(ua)
  if (macMatch) return `macOS ${macMatch[1].replace(/_/g, '.')}`
  const winMatch = /Windows NT ([\d.]+)/.exec(ua)
  if (winMatch) return `Windows NT ${winMatch[1]}`
  const linuxMatch = /\bLinux ([^;)\s]+)/.exec(ua)
  if (linuxMatch) return `Linux ${linuxMatch[1]}`
  return platform || 'unknown'
}

/** Summarise the open recording without leaking the file name or path
 *  — those tend to embed patient codes / collaborator names / private
 *  conventions and we don't want them in a public bug report. */
function _recordingSummary(): { format: string; size: string } {
  const recording = useAppStore.getState().recording
  if (!recording) return { format: '(none open)', size: '' }
  const fmt = recording.format ?? '(unknown)'
  const groupCount = recording.groups?.length ?? 0
  let seriesCount = 0
  for (const g of recording.groups ?? []) {
    seriesCount += (g as { series?: unknown[] }).series?.length ?? 0
  }
  return {
    format: fmt,
    size: groupCount > 0
      ? `${groupCount} group${groupCount === 1 ? '' : 's'}, `
        + `${seriesCount} series total`
      : '(no series)',
  }
}

/** Gather the current snapshot of diagnostic info. Pure — safe to
 *  call any time. The ``view`` arg is provided by the caller because
 *  each Electron window knows its own identity (main vs analysis); a
 *  store lookup wouldn't disambiguate. */
export function gatherDiagnostics(view: string): BugDiagnostics {
  const state = useAppStore.getState()
  const { format, size } = _recordingSummary()
  return {
    app_version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    os: _osFromUA(),
    // Backend version isn't currently exposed on /api/files/info;
    // wire it up later if useful for triage.
    python_version: '',
    view,
    recording_format: format,
    recording_size: size,
    // Action / log capture infra not yet built — placeholder fields
    // already exist on the Tally form so we can fill them later
    // without touching the form schema.
    last_action: '',
    last_error: state.error ?? '',
    log_tail: '',
    submission_id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  }
}

/** Build the Tally embed URL with all diagnostic fields prefilled.
 *  Tally's hidden-field URL parameter name is the field's label
 *  (verbatim, URL-encoded), so this stays in lockstep with the form
 *  configuration as long as both sides use the same snake_case names.
 *  Form ID is the part after ``tally.so/r/``. */
export const TALLY_FORM_ID = 'ZjvoQB'

export function buildTallyEmbedUrl(diag: BugDiagnostics): string {
  const params = new URLSearchParams()
  // Hidden field prefill — one entry per Tally hidden block.
  params.set('app_version', diag.app_version)
  params.set('os', diag.os)
  params.set('python_version', diag.python_version)
  params.set('view', diag.view)
  params.set('recording_format', diag.recording_format)
  params.set('recording_size', diag.recording_size)
  params.set('last_action', diag.last_action)
  params.set('last_error', diag.last_error)
  params.set('log_tail', diag.log_tail)
  params.set('submission_id', diag.submission_id)
  // Cosmetic embed flags so the iframe blends with our modal.
  params.set('alignLeft', '1')
  params.set('hideTitle', '1')
  params.set('transparentBackground', '1')
  params.set('dynamicHeight', '1')
  return `https://tally.so/embed/${TALLY_FORM_ID}?${params.toString()}`
}
