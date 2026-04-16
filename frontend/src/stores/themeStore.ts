import { create } from 'zustand'

export type ThemeName = 'dark' | 'light'

export const FONT_FAMILIES = [
  { value: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: 'Inter' },
  { value: "'SF Pro Text', 'SF Pro', -apple-system, BlinkMacSystemFont, sans-serif", label: 'SF Pro' },
  { value: "'Helvetica Neue', Helvetica, Arial, sans-serif", label: 'Helvetica Neue' },
  { value: "'IBM Plex Sans', 'Inter', sans-serif", label: 'IBM Plex Sans' },
  { value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: 'System Default' },
] as const

export const MONO_FONTS = [
  { value: "'Fira Code', 'Consolas', 'SF Mono', monospace", label: 'Fira Code' },
  { value: "'JetBrains Mono', 'Consolas', monospace", label: 'JetBrains Mono' },
  { value: "'SF Mono', 'Menlo', 'Monaco', monospace", label: 'SF Mono' },
  { value: "'Consolas', 'Courier New', monospace", label: 'Consolas' },
] as const

export const FONT_SIZES = [11, 12, 13, 14, 15] as const

interface ThemeState {
  theme: ThemeName
  fontFamily: string
  monoFont: string
  fontSize: number

  setTheme: (t: ThemeName) => void
  toggleTheme: () => void
  setFontFamily: (f: string) => void
  setMonoFont: (f: string) => void
  setFontSize: (s: number) => void
  initTheme: () => Promise<void>
}

const LS_KEY = 'neurotrace-theme-prefs'

interface PersistedPrefs {
  theme?: ThemeName
  fontFamily?: string
  monoFont?: string
  fontSize?: number
}

/** Load preferences synchronously — tries Electron's preload-read file first,
 *  then falls back to localStorage. */
function loadPrefsSync(): PersistedPrefs {
  // Primary: sync-read from the Electron preload (always fresh from file)
  try {
    const sp = (window as any).electronAPI?.syncPreferences
    if (sp && (sp.theme || sp.fontFamily || sp.fontSize)) return sp as PersistedPrefs
  } catch { /* ignore */ }
  // Fallback: localStorage
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** Load preferences from Electron's userData file if available, else localStorage. */
async function loadPrefsAsync(): Promise<PersistedPrefs> {
  if (window.electronAPI?.getPreferences) {
    try {
      const prefs = await window.electronAPI.getPreferences()
      return prefs as PersistedPrefs
    } catch { /* fall through */ }
  }
  return loadPrefsSync()
}

/** Save preferences to BOTH localStorage and Electron userData file. */
function savePrefs(state: ThemeState) {
  const data: PersistedPrefs = {
    theme: state.theme,
    fontFamily: state.fontFamily,
    monoFont: state.monoFont,
    fontSize: state.fontSize,
  }

  // Always write to localStorage — lets the next sync-init pick it up
  // immediately on reload, even before the async file read completes.
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch { /* ignore */ }

  // Also persist to the Electron userData file (survives origin changes).
  if (window.electronAPI?.setPreferences) {
    window.electronAPI.setPreferences(data as Record<string, unknown>).catch(() => { /* ignore */ })
  }
}

/** Push current theme values to the DOM so CSS variables take effect */
function applyToDOM(state: ThemeState) {
  const root = document.documentElement
  root.dataset.theme = state.theme
  root.style.setProperty('--font-ui', state.fontFamily)
  root.style.setProperty('--font-mono', state.monoFont)
  root.style.setProperty('--font-size-base', `${state.fontSize}px`)
  root.style.setProperty('--font-size-sm', `${state.fontSize - 1}px`)
  root.style.setProperty('--font-size-xs', `${state.fontSize - 2}px`)
  root.style.setProperty('--font-size-label', `${state.fontSize - 3}px`)
}

const defaults = {
  theme: 'dark' as ThemeName,
  fontFamily: FONT_FAMILIES[0].value,
  monoFont: MONO_FONTS[0].value,
  fontSize: 13,
}

// Sync load for immediate store creation (prevents first-paint flash)
const saved = loadPrefsSync()

function validateTheme(t: unknown): ThemeName {
  return t === 'light' || t === 'dark' ? t : defaults.theme
}

function validateFontSize(s: unknown): number {
  const n = typeof s === 'number' ? s : defaults.fontSize
  return (FONT_SIZES as readonly number[]).includes(n) ? n : defaults.fontSize
}

function validateFontFamily(f: unknown): string {
  return typeof f === 'string' && f.length > 0 ? f : defaults.fontFamily
}

function validateMonoFont(f: unknown): string {
  return typeof f === 'string' && f.length > 0 ? f : defaults.monoFont
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: validateTheme(saved.theme),
  fontFamily: validateFontFamily(saved.fontFamily),
  monoFont: validateMonoFont(saved.monoFont),
  fontSize: validateFontSize(saved.fontSize),

  setTheme: (t) => {
    set({ theme: t })
    const s = get(); applyToDOM(s); savePrefs(s)
  },

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    set({ theme: next })
    const s = get(); applyToDOM(s); savePrefs(s)
  },

  setFontFamily: (f) => {
    set({ fontFamily: f })
    const s = get(); applyToDOM(s); savePrefs(s)
  },

  setMonoFont: (f) => {
    set({ monoFont: f })
    const s = get(); applyToDOM(s); savePrefs(s)
  },

  setFontSize: (sz) => {
    set({ fontSize: sz })
    const s = get(); applyToDOM(s); savePrefs(s)
  },

  /**
   * Called once on app mount. Applies current values (from sync localStorage)
   * to the DOM immediately, then asynchronously hydrates from the Electron
   * userData file if it has newer/different values.
   */
  initTheme: async () => {
    // First: apply whatever we loaded synchronously
    applyToDOM(get())

    // Second: hydrate from the Electron file (may be newer than localStorage)
    const filePrefs = await loadPrefsAsync()
    if (filePrefs && Object.keys(filePrefs).length > 0) {
      set({
        theme: validateTheme(filePrefs.theme),
        fontFamily: validateFontFamily(filePrefs.fontFamily),
        monoFont: validateMonoFont(filePrefs.monoFont),
        fontSize: validateFontSize(filePrefs.fontSize),
      })
      const s = get()
      applyToDOM(s)
      // Also backfill localStorage so next reload has fresh sync data
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          theme: s.theme,
          fontFamily: s.fontFamily,
          monoFont: s.monoFont,
          fontSize: s.fontSize,
        }))
      } catch { /* ignore */ }
    }
  },
}))
