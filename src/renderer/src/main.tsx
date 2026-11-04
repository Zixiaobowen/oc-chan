import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SettingsProvider from './settings'
import TrayView from './TrayView'
import './styles.css'

const isTray = new URLSearchParams(location.search).get('view') === 'tray'
createRoot(document.getElementById('root')!).render(<React.StrictMode><SettingsProvider>{isTray ? <TrayView /> : <App />}</SettingsProvider></React.StrictMode>)
