import { contextBridge, ipcRenderer } from 'electron'
import type { MonitorApi, MonitorUpdate } from '../shared/types'
import type { SettingsApi, SettingsSnapshot } from '../shared/settings'
import type { UpdatesApi, UpdateSnapshot } from '../shared/updates'

const api: MonitorApi = {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  refresh: (section) => ipcRenderer.invoke('monitor:refresh', section),
  focusAgentInTern: (agentId) => ipcRenderer.invoke('monitor:focus-agent-in-tern', agentId),
  scheduleHistory: (jobId, offset) => ipcRenderer.invoke('monitor:schedule-history', jobId, offset),
  cancelScheduleHistory: () => ipcRenderer.send('monitor:cancel-schedule-history'),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: MonitorUpdate) => listener(update)
    ipcRenderer.on('monitor:changed', handler)
    return () => ipcRenderer.removeListener('monitor:changed', handler)
  }
}
contextBridge.exposeInMainWorld('monitor', api)

const desktopSettings: SettingsApi = {
  snapshot: () => ipcRenderer.invoke('settings:snapshot'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  showMainWindow: () => ipcRenderer.invoke('settings:show-main-window'),
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
