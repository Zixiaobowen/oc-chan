import { contextBridge, ipcRenderer } from 'electron'
import type { MonitorApi, MonitorUpdate, SourceHeartbeat } from '../shared/types'
import type { SettingsApi, SettingsSnapshot } from '../shared/settings'
import type { UpdatesApi, UpdateSnapshot } from '../shared/updates'
import type { StartupRecoveryApi } from '../shared/startup-recovery'
import type { MarketplaceApi, MarketplaceSnapshot } from '../shared/marketplace'

if (new URLSearchParams(location.search).get('view') === 'recovery') {
  const recovery: StartupRecoveryApi = {
    snapshot: () => ipcRenderer.invoke('recovery:snapshot'),
    retry: () => ipcRenderer.invoke('recovery:retry'),
    quit: () => ipcRenderer.invoke('recovery:quit')
  }
  contextBridge.exposeInMainWorld('startupRecovery', recovery)
} else {
type MonitorMessages = { 'monitor:changed': MonitorUpdate; 'monitor:sources': SourceHeartbeat }
const listeners: Record<keyof MonitorMessages, number> = { 'monitor:changed': 0, 'monitor:sources': 0 }
function updateSubscription(): void {
  ipcRenderer.send('monitor:subscription', listeners['monitor:changed'] > 0, listeners['monitor:sources'] > 0)
}
function subscribe<K extends keyof MonitorMessages>(channel: K, listener: (value: MonitorMessages[K]) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: MonitorMessages[K]) => listener(value)
  let active = true
  ipcRenderer.on(channel, handler)
  if (++listeners[channel] === 1) updateSubscription()
  return () => {
    if (!active) return
    active = false
    ipcRenderer.removeListener(channel, handler)
    if (--listeners[channel] === 0) updateSubscription()
  }
}

const api: MonitorApi = {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  refresh: (section) => ipcRenderer.invoke('monitor:refresh', section),
  retrySource: (sourceId) => ipcRenderer.invoke('monitor:retry-source', sourceId),
  focusAgentInTern: (agentId) => ipcRenderer.invoke('monitor:focus-agent-in-tern', agentId),
  scheduleHistory: (jobId, offset) => ipcRenderer.invoke('monitor:schedule-history', jobId, offset),
  cancelScheduleHistory: () => ipcRenderer.send('monitor:cancel-schedule-history'),
  events: query => ipcRenderer.invoke('monitor:events', query),
  cancelEvents: () => ipcRenderer.send('monitor:cancel-events'),
  generateDiagnostics: () => ipcRenderer.invoke('diagnostics:generate'),
  copyDiagnostics: id => ipcRenderer.invoke('diagnostics:copy', id),
  saveDiagnostics: id => ipcRenderer.invoke('diagnostics:save', id),
  cancelDiagnostics: () => ipcRenderer.invoke('diagnostics:cancel'),
  navigation: () => ipcRenderer.invoke('monitor:navigation'),
  acknowledgeNavigation: (sequence) => ipcRenderer.invoke('monitor:acknowledge-navigation', sequence),
  onNavigation: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('monitor:navigation', handler)
    return () => ipcRenderer.removeListener('monitor:navigation', handler)
  },
  subscribe: listener => subscribe('monitor:changed', listener),
  subscribeSources: listener => subscribe('monitor:sources', listener)
}
contextBridge.exposeInMainWorld('monitor', api)

const desktopSettings: SettingsApi = {
  snapshot: () => ipcRenderer.invoke('settings:snapshot'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  previewGlass: intensity => ipcRenderer.invoke('settings:preview-glass', intensity),
  retryGeometry: () => ipcRenderer.invoke('settings:retry-geometry'),
  updateLoginItem: enabled => ipcRenderer.invoke('settings:update-login-item', enabled),
  requestNotificationPermission: () => ipcRenderer.invoke('settings:request-notification-permission'),
  accessibilityState: () => ipcRenderer.invoke('settings:accessibility-state'),
  openPermissionSettings: target => ipcRenderer.invoke('settings:open-permission-settings', target),
  showMainWindow: (target) => ipcRenderer.invoke('settings:show-main-window', target),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SettingsSnapshot) => listener(snapshot)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  }
}
contextBridge.exposeInMainWorld('desktopSettings', desktopSettings)

const appUpdates: UpdatesApi = {
  snapshot: () => ipcRenderer.invoke('updates:snapshot'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  cancel: () => ipcRenderer.invoke('updates:cancel'),
  install: () => ipcRenderer.invoke('updates:install'),
  openReleaseNotes: () => ipcRenderer.invoke('updates:release-notes'),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: UpdateSnapshot) => listener(snapshot)
    ipcRenderer.on('updates:changed', handler)
    return () => ipcRenderer.removeListener('updates:changed', handler)
  }
}
contextBridge.exposeInMainWorld('appUpdates', appUpdates)

const pluginMarketplace: MarketplaceApi = {
  snapshot: () => ipcRenderer.invoke('plugins:snapshot'),
  check: () => ipcRenderer.invoke('plugins:check'),
  install: id => ipcRenderer.invoke('plugins:install', id),
  update: id => ipcRenderer.invoke('plugins:update', id),
  uninstall: id => ipcRenderer.invoke('plugins:uninstall', id),
  cancel: () => ipcRenderer.invoke('plugins:cancel'),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: MarketplaceSnapshot) => listener(snapshot)
    ipcRenderer.on('plugins:changed', handler)
    return () => ipcRenderer.removeListener('plugins:changed', handler)
  }
}
contextBridge.exposeInMainWorld('pluginMarketplace', pluginMarketplace)
}
