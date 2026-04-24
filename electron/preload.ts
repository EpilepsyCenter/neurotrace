import { contextBridge, ipcRenderer } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'

// ---------------------------------------------------------------------------
// Read preferences SYNCHRONOUSLY at preload time
// ---------------------------------------------------------------------------
function getPrefsPath(): string {
  const home = homedir()
  const p = platform()
  if (p === 'darwin') {
    return join(home, 'Library', 'Application Support', 'neurotrace', 'preferences.json')
  } else if (p === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'neurotrace', 'preferences.json')
  } else {
    return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'neurotrace', 'preferences.json')
  }
}

let syncPrefs: Record<string, unknown> = {}
try {
  const path = getPrefsPath()
  if (existsSync(path)) {
    syncPrefs = JSON.parse(readFileSync(path, 'utf-8'))
  }
} catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Expose API to the renderer
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('electronAPI', {
  syncPreferences: syncPrefs,

  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('save-file-dialog', defaultName, filters),
  getPreferences: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('get-preferences'),
  setPreferences: (prefs: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('set-preferences', prefs),

  // Per-recording sidecar files. Each recording at ``<path>`` has an
  // optional ``<path>.neurotrace`` JSON next to it carrying all
  // analysis params + results for that recording. Writes are atomic
  // (tmp + rename). Reads return null when absent or corrupt.
  readSidecar: (recordingPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('read-sidecar', recordingPath),
  writeSidecar: (recordingPath: string, payload: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('write-sidecar', recordingPath, payload),

  // Analysis windows
  openAnalysisWindow: (type: string): Promise<boolean> => ipcRenderer.invoke('open-analysis-window', type),
  closeAnalysisWindow: (type: string): Promise<boolean> => ipcRenderer.invoke('close-analysis-window', type),
  getOpenAnalysisWindows: (): Promise<string[]> => ipcRenderer.invoke('get-open-analysis-windows'),
  onAnalysisWindowClosed: (callback: (type: string) => void) => {
    const handler = (_event: any, type: string) => callback(type)
    ipcRenderer.on('analysis-window-closed', handler)
    return () => ipcRenderer.removeListener('analysis-window-closed', handler)
  },
})
