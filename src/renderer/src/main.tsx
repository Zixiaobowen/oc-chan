import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SettingsProvider from './settings'
import TrayView from './TrayView'
import StartupRecoveryView from './StartupRecoveryView'
import UpdatesProvider from './updates'
import MarketplaceProvider from './marketplace'
import { desktopError, initializeDesktop, reportDesktopCommit, reportDesktopFailure } from './desktop-api'
import './styles.css'

function DesktopCommit() {
  React.useLayoutEffect(() => { void reportDesktopCommit().catch(reportDesktopFailure) }, [])
  return null
}
const view = new URLSearchParams(location.search).get('view')
const root = createRoot(document.getElementById('root')!)
function connectionFailure(error: Error): void {
  root.render(<main className="settings-loading" role="alert"><h1>桌面连接失败 / Desktop connection failed</h1><p>{error.message}</p></main>)
}
void initializeDesktop(connectionFailure).then(dispose => {
  import.meta.hot?.dispose(dispose)
  root.render(<React.StrictMode>{view === 'recovery'
    ? <><StartupRecoveryView /><DesktopCommit /></>
    : <SettingsProvider><MarketplaceProvider>{view === 'tray' ? <><TrayView /><DesktopCommit /></> : <UpdatesProvider><App /><DesktopCommit /></UpdatesProvider>}</MarketplaceProvider></SettingsProvider>}</React.StrictMode>)
}).catch(error => connectionFailure(desktopError(error)))
