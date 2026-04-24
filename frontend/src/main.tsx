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

// Check if this window was opened as an analysis view
const params = new URLSearchParams(window.location.search)
const view = params.get('view')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view ? <AnalysisWindow view={view} /> : <App />}
  </React.StrictMode>
)
