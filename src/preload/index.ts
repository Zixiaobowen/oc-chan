import { contextBridge, ipcRenderer } from 'electron'
import type { MonitorApi, MonitorUpdate } from '../shared/types'
import type { SettingsApi, SettingsSnapshot } from '../shared/settings'

const api: MonitorApi = {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  refresh: (section) => ipcRenderer.invoke('monitor:refresh', section),
  focusAgentInTern: (agentId) => ipcRenderer.invoke('monitor:focus-agent-in-tern', agentId),
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
