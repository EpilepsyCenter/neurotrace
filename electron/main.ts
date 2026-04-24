import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { createServer } from 'net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'

// Pin the app name BEFORE the app ready event so the macOS application
// menu + dock both read "NeuroTrace" instead of "Electron". In packaged
// builds electron-builder bakes ``productName`` into the bundle's
// Info.plist, but in dev the menu bar otherwise shows "Electron".
app.setName('NeuroTrace')

// Absolute path to the app icon PNG. electron-builder auto-generates
// the platform-native icons (icns / ico) from this PNG at package
// time; in dev we also pass it directly to BrowserWindow so the dock
// / taskbar / window chrome picks it up live.
const ICON_PATH = join(__dirname, '..', 'build', 'icon.png')

let mainWindow: BrowserWindow | null = null
let pythonProcess: ChildProcess | null = null
let backendPort: number = 0

// Track open analysis windows by type
const analysisWindows: Map<string, BrowserWindow> = new Map()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Could not find free port'))
      }
    })
    server.on('error', reject)
  })
}

async function startPythonBackend(port: number): Promise<void> {
  const isDev = !app.isPackaged
  const pythonPath = isDev ? 'python3' : join(process.resourcesPath, 'backend', 'main')
  const args = isDev ? [join(__dirname, '..', 'backend', 'main.py'), '--port', String(port)] : ['--port', String(port)]

  return new Promise((resolve, reject) => {
    pythonProcess = spawn(pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NEUROTRACE_PORT: String(port) },
    })

    pythonProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.log('[Python]', output)
      if (output.includes('Application startup complete') || output.includes('Uvicorn running')) {
        resolve()
      }
    })

    pythonProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.error('[Python]', output)
      if (output.includes('Application startup complete') || output.includes('Uvicorn running')) {
        resolve()
      }
    })

    pythonProcess.on('error', (err) => {
      console.error('Failed to start Python backend:', err)
      reject(err)
    })

    pythonProcess.on('exit', (code) => {
      console.log(`Python backend exited with code ${code}`)
      pythonProcess = null
    })

    // First-run Gatekeeper / SmartScreen can add 20–30s of startup delay
    // for unsigned bundled backends; be generous with the safety timeout.
    setTimeout(() => resolve(), 60000)
  })
}

// -----------------------------------------------------------------
// Preferences
// -----------------------------------------------------------------
function prefsFilePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'preferences.json')
}

function loadWindowBounds(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  try {
    const path = prefsFilePath()
    if (existsSync(path)) {
      const prefs = JSON.parse(readFileSync(path, 'utf-8'))
      if (prefs.windowBounds) return prefs.windowBounds
    }
  } catch { /* ignore */ }
  return { width: 1400, height: 900 }
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const maximized = mainWindow.isMaximized()
    const path = prefsFilePath()
    let prefs: Record<string, unknown> = {}
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* ignore */ }
    prefs.windowBounds = { ...bounds, maximized }
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

// -----------------------------------------------------------------
// Main window
// -----------------------------------------------------------------
function createWindow() {
  const bounds = loadWindowBounds()

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 700,
    title: 'NeuroTrace',
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (bounds.maximized) {
    mainWindow.maximize()
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('resize', saveWindowBounds)
  mainWindow.on('move', saveWindowBounds)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// -----------------------------------------------------------------
// IPC handlers
// -----------------------------------------------------------------
ipcMain.handle('get-backend-url', () => {
  return `http://localhost:${backendPort}`
})

ipcMain.handle('open-file-dialog', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Electrophysiology Files', extensions: ['dat', 'abf', 'h5', 'nwb', 'wcp', 'axgd', 'smr'] },
      { name: 'HEKA Patchmaster', extensions: ['dat'] },
      { name: 'Axon Binary', extensions: ['abf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('save-file-dialog', async (_event, defaultName: string, filters: Electron.FileFilter[]) => {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel', extensions: ['xlsx'] },
    ],
  })
  return result.canceled ? null : result.filePath
})

ipcMain.handle('get-preferences', () => {
  try {
    const path = prefsFilePath()
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    console.error('Failed to load preferences:', err)
    return {}
  }
})

ipcMain.handle('set-preferences', (_event, prefs: Record<string, unknown>) => {
  try {
    const path = prefsFilePath()
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
    return true
  } catch (err) {
    console.error('Failed to save preferences:', err)
    return false
  }
})

// -----------------------------------------------------------------
// Per-recording sidecar (.neurotrace JSON next to the recording file)
// -----------------------------------------------------------------
//
// Convention: for a recording at ``/path/to/file.dat``, the sidecar
// lives at ``/path/to/file.dat.neurotrace``. Appending the extension
// (rather than replacing) keeps things unambiguous when labs have
// same-stemmed files in different formats.
//
// Writes go through a ``*.tmp`` + rename-over so a crash mid-write
// can't corrupt an existing sidecar. Reads silently return null on
// any parse / IO error; the caller treats that as "no sidecar".

function sidecarPathFor(recordingPath: string): string {
  return `${recordingPath}.neurotrace`
}

ipcMain.handle('read-sidecar', (_event, recordingPath: string) => {
  try {
    if (!recordingPath) return null
    const path = sidecarPathFor(recordingPath)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    // Basic shape guard — reject anything that doesn't look like ours.
    if (parsed && typeof parsed === 'object'
        && parsed.format === 'neurotrace-sidecar') {
      return parsed
    }
    return null
  } catch (err) {
    console.error('Failed to read sidecar:', err)
    return null
  }
})

ipcMain.handle('write-sidecar', (_event, recordingPath: string, payload: Record<string, unknown>) => {
  try {
    if (!recordingPath) return false
    const path = sidecarPathFor(recordingPath)
    const tmp = `${path}.tmp`
    // Always stamp format + saved_at so the file is self-describing.
    const withMeta = {
      format: 'neurotrace-sidecar',
      version: 1,
      saved_at: new Date().toISOString(),
      ...payload,
    }
    writeFileSync(tmp, JSON.stringify(withMeta, null, 2), 'utf-8')
    renameSync(tmp, path)
    return true
  } catch (err) {
    console.error('Failed to write sidecar:', err)
    try { unlinkSync(sidecarPathFor(recordingPath) + '.tmp') } catch { /* ignore */ }
    return false
  }
})

// -----------------------------------------------------------------
// Analysis windows — one per analysis type, opened on demand
// -----------------------------------------------------------------
const ANALYSIS_WINDOW_TITLES: Record<string, string> = {
  cursors: 'Cursor Measurements',
  resistance: 'Rs / Rin / Cm',
  iv: 'I-V Curve',
  action_potential: 'Action Potentials',
  events: 'Event Detection',
  // Sub-windows of Event Detection — open via a button in the main
  // events window. Open at the same time as the parent (keyed by
  // unique view names so they don't collide).
  events_template_generator: 'Events — Template Generator',
  events_template_refinement: 'Events — Refine Template',
  events_browser: 'Events — Browser & Overlay',
  bursts: 'Burst Detection',
  kinetics: 'Kinetics & Fitting',
  field_potential: 'Field PSP',
  spectral: 'Spectral Analysis',
}

function loadAnalysisWindowBounds(analysisType: string): { x?: number; y?: number; width: number; height: number } {
  try {
    const path = prefsFilePath()
    if (existsSync(path)) {
      const prefs = JSON.parse(readFileSync(path, 'utf-8'))
      const bounds = prefs.analysisWindowBounds?.[analysisType]
      if (bounds) return bounds
    }
  } catch { /* ignore */ }
  return { width: 900, height: 650 }
}

function saveAnalysisWindowBounds(analysisType: string) {
  const win = analysisWindows.get(analysisType)
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getBounds()
    const path = prefsFilePath()
    let prefs: Record<string, any> = {}
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* ignore */ }
    if (!prefs.analysisWindowBounds) prefs.analysisWindowBounds = {}
    prefs.analysisWindowBounds[analysisType] = bounds
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

ipcMain.handle('open-analysis-window', (_event, analysisType: string) => {
  // If already open, focus it
  const existing = analysisWindows.get(analysisType)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return true
  }

  const title = ANALYSIS_WINDOW_TITLES[analysisType] || analysisType
  const bounds = loadAnalysisWindowBounds(analysisType)

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 500,
    minHeight: 400,
    title: `NeuroTrace — ${title}`,
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=${analysisType}`)
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'), {
      query: { view: analysisType },
    })
  }

  analysisWindows.set(analysisType, win)

  // Persist window bounds on move/resize
  win.on('resize', () => saveAnalysisWindowBounds(analysisType))
  win.on('move', () => saveAnalysisWindowBounds(analysisType))

  win.on('closed', () => {
    analysisWindows.delete(analysisType)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('analysis-window-closed', analysisType)
    }
  })

  return true
})

ipcMain.handle('close-analysis-window', (_event, analysisType: string) => {
  const win = analysisWindows.get(analysisType)
  if (win && !win.isDestroyed()) {
    win.close()
  }
  analysisWindows.delete(analysisType)
  return true
})

ipcMain.handle('get-open-analysis-windows', () => {
  const open: string[] = []
  for (const [type, win] of analysisWindows) {
    if (!win.isDestroyed()) open.push(type)
  }
  return open
})

// -----------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------
app.whenReady().then(async () => {
  try {
    backendPort = await findFreePort()
    console.log(`Starting Python backend on port ${backendPort}...`)
    await startPythonBackend(backendPort)
    console.log('Python backend started successfully')
  } catch (err) {
    console.error('Failed to start Python backend:', err)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
})
