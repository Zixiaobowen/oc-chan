import { contextBridge, ipcRenderer } from 'electron'
import { eventKeys, stamp } from './event-keys.mjs'

const view = new URLSearchParams(location.search).get('view') === 'tray' ? 'tray' : 'main'
const seen = new Map()
const on = ipcRenderer.on.bind(ipcRenderer)
const removeListener = ipcRenderer.removeListener.bind(ipcRenderer)
const handlers = new WeakMap()
function received(update) {
  if (update.section !== 'agents') return
  const keys = eventKeys(update.state.data, seen)
  if (keys.length) ipcRenderer.send('performance:metric', ['i', stamp(), view, keys])
}
ipcRenderer.on = (channel, listener) => {
  if (channel !== 'monitor:changed') return on(channel, listener)
  const wrapped = (event, update) => { received(update); listener(event, update) }
  handlers.set(listener, wrapped)
  return on(channel, wrapped)
}
ipcRenderer.removeListener = (channel, listener) => {
  const wrapped = channel === 'monitor:changed' ? handlers.get(listener) : undefined
  handlers.delete(listener)
  return removeListener(channel, wrapped ?? listener)
}
contextBridge.exposeInMainWorld('__ocPerformance', {
  report(row) {
    if (!Array.isArray(row) || row.length > 6) throw new Error('Invalid performance metric')
    ipcRenderer.send('performance:metric', row)
  }
})
