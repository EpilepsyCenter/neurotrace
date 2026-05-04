import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AnalysisWindow } from './AnalysisWindow'
import './styles/global.css'
// Telegraph theme — imported AFTER global.css so its :root token
// values override the defaults. Loading it via main.tsx (instead of
// an @import at the bottom of global.css) sidesteps the CSS spec
// rule that @import must appear before any other rule — otherwise
// the override stylesheet is silently dropped by the parser.
import './styles/telegraph.css'
import './styles/precision.css'

// Tag <body> with the host platform so CSS can apply platform-
// specific styling (macOS traffic-light gutter on the toolbar etc.)
// before first paint. Falls back to "web" when running outside
// Electron — useful for the Vite dev server in a regular browser.
{
  const plat = (window as any).electronAPI?.platform
  let tag = 'web'
  if (plat === 'darwin') tag = 'mac'
  else if (plat === 'win32') tag = 'win'
  else if (plat === 'linux') tag = 'linux'
  document.body.setAttribute('data-platform', tag)
}

// Check if this window was opened as an analysis view
const params = new URLSearchParams(window.location.search)
const view = params.get('view')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view ? <AnalysisWindow view={view} /> : <App />}
  </React.StrictMode>
)
