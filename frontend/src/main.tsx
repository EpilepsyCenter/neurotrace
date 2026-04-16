import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AnalysisWindow } from './AnalysisWindow'
import './styles/global.css'

// Check if this window was opened as an analysis view
const params = new URLSearchParams(window.location.search)
const view = params.get('view')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view ? <AnalysisWindow view={view} /> : <App />}
  </React.StrictMode>
)
