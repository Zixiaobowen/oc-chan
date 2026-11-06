import { app, ipcMain, BrowserWindow } from 'electron'
import { ChildProcess } from 'node:child_process'
import { AsyncResource } from 'node:async_hooks'
import { readFileSync, statSync } from 'node:fs'
import { watch } from 'node:fs'
import { serialize } from 'node:v8'
import path from 'node:path'
import { readNotificationJournal } from '../../src/main/events/notification-journal'
import { Monitor } from '../../src/main/monitor'
import { createAgentsPlugin } from '../../src/main/plugins/agents'
import { CollectionPluginRegistry } from '../../src/main/plugins/registry'
import { SessionActivityReader } from '../../src/main/collectors/agent-activity'
import { collectionResources } from '../../src/main/resource-budget'
import { eventKeys, stamp } from './event-keys.mjs'

if (app.isPackaged || !process.env.OC_CHAN_DEV_INSTANCE || process.env.OC_CHAN_HEADLESS !== '1') throw new Error('Performance probe requires an isolated headless development instance')
const configFile = process.env.OC_CHAN_PERFORMANCE_CONFIG
if (!configFile || statSync(configFile).size > 128 * 1024) throw new Error('Invalid performance configuration')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
if (!['L0', 'L1', 'L2'].includes(config.level)) throw new Error('Invalid performance level')
// Inspector evaluation may interrupt an active collection lease. Controls are
// separate diagnostic requests, so bind them before any collector starts.
const controlContext = new AsyncResource('OCChanPerformanceControl')
let queued = []
let timer
let finished = false
function flush() {
  clearTimeout(timer)
  timer = undefined
  if (!queued.length) return
  if (process.stdout.writableLength > 1024 * 1024) throw new Error('Performance output backpressure budget exceeded')
  process.stdout.write('__OC_PERF__' + JSON.stringify(queued) + '\n')
  queued = []
}
function report(row) {
  if (finished) return
  queued.push(row)
  if (queued.length >= 128 || row[0] === 'spawn' || row[0] === 'exit') flush()
  else timer ??= setTimeout(flush, 25)
}
report(['main', stamp(), process.pid, process.versions.electron, process.versions.chrome])
const payloadSizes = new WeakMap()
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _path, error) => { console.error('Performance preload failed:', error); app.exit(1) })
  const send = contents.send.bind(contents)
  contents.send = (channel, ...args) => {
    const sent = send(channel, ...args)
    if (channel === 'monitor:changed') {
      const update = args[0]
      let bytes = payloadSizes.get(update)
      if (bytes === undefined) { bytes = serialize(update).byteLength; payloadSizes.set(update, bytes) }
      const url = contents.getURL()
      const view = !url ? 'unloaded' : new URL(url).searchParams.get('view') === 'tray' ? 'tray' : 'main'
      report(['ipc-payload', stamp(), update.section, view, bytes])
    }
    return sent
  }
})
const spawn = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (...args) {
  const result = spawn.apply(this, args)
  if (this.pid) {
    report(['spawn', stamp(), this.pid, process.pid])
    this.once('exit', () => report(['exit', stamp(), this.pid]))
  }
  return result
}

ipcMain.on('performance:metric', (event, row) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame || !Array.isArray(row) || row.length > 8 ||
      !['i', 'c', 'commit-ready', 'probe-error', 'input'].includes(row[0]) || !Number.isFinite(row[1])) {
    throw new Error('Invalid performance renderer metric')
  }
  if (row[0] === 'probe-error') throw new Error(String(row[3]))
  report(row)
})

let nodeCount = config.level === 'L2' ? 128 : 32
export function createPerformanceAgentsPlugin() {
  if (config.level === 'L0') return createAgentsPlugin()
  const manifest = config.fixture
  if (!manifest || manifest.sessions.length !== 128) throw new Error('Performance fixture must contain 128 sessions')
  const fileIndex = new Map(manifest.sessions.map((session, index) => [session.file, index]))
  const events = new Map()
  return createAgentsPlugin({
    discover: async () => ({
      snapshot: {
        collectedAt: new Date().toISOString(), activeSubagentCount: null,
        agents: Array.from({ length: nodeCount }, (_, index) => ({
          id: `performance:${index}`, name: `Performance session ${index}`, summary: `Seed ${config.seed} · bounded synthetic metadata ${index}`,
          runtime: 'OMP', kind: index % 8 === 0 ? 'main' : 'subagent', state: 'idle', pid: 900000 + index,
          parentId: index % 8 ? `performance:${index - index % 8}` : undefined,
          sessionId: manifest.sessions[index % 128].sessionId + (index >= 128 ? `-node-${index}` : ''),
          source: 'Performance fixture (synthetic)', startedAt: '2026-01-01T00:00:00.000Z'
        })),
        sources: [{ id: 'performance-fixture', label: 'Performance fixture', state: 'ok', detail: `Synthetic workload, seed ${config.seed}; no upstream process execution` }]
      }, sessions: manifest.sessions.slice(0, Math.min(128, nodeCount))
    }),
    watchFile(file, listener) {
      return watch(file, { persistent: false }, kind => { if (!events.has(file)) events.set(file, stamp()); listener(kind) })
    },
    createReader() {
      const reader = new SessionActivityReader()
      return { async read(file, now, signal) {
        const began = stamp()
        const eventAt = events.get(file)
        events.delete(file)
        const result = await reader.read(file, now, signal)
        const match = /^perf_(\d+)$/.exec(result.activity?.name ?? '')
        report(['r', stamp(), fileIndex.get(file), match ? Number(match[1]) : null, began, result.bytesRead, eventAt ?? null, result.issues.length])
        if (result.issues.length) report(['read-issue', stamp(), fileIndex.get(file), result.issues])
        return result
      } }
    }
  })
}

const start = Monitor.prototype.start
const pluginCollect = CollectionPluginRegistry.prototype.collect
if (typeof pluginCollect !== 'function') throw new Error('Performance collector instrumentation no longer matches the public collection lifecycle')
const observedCollections = new WeakSet()
CollectionPluginRegistry.prototype.collect = function (id, sourceId) {
  const began = stamp()
  const work = pluginCollect.call(this, id, sourceId)
  if (!observedCollections.has(work)) {
    observedCollections.add(work)
    const status = this.statuses().find(status => status.id === id)
    if (!status) throw new Error('Measured plugin is not registered')
    work.then(() => report(['sample', stamp(), status.section, began, true]), () => report(['sample', stamp(), status.section, began, false]))
  }
  return work
}
Monitor.prototype.start = async function () {
  const monitor = this
  const previous = new Map()
  const first = new Set()
  monitor.prependListener('change', update => {
    report(['publish-batch', stamp(), update.section])
    if (update.state.data && !first.has(update.section)) { first.add(update.section); report(['first', stamp(), update.section]) }
    if (update.section === 'agents') {
      const keys = eventKeys(update.state.data, previous)
      if (keys.length) report(['p', stamp(), keys])
    }
  })
  if (config.level !== 'L0') {
    // Exposed only in this probe entry, never in the production build or renderer bridge.
    globalThis.__ocPerformanceControl = {
      resources() { return collectionResources.snapshot() },
      diagnostics() { return monitor.diagnostics() },
      async notificationJournal() {
        const filename = path.join(app.getPath('userData'), 'events', 'notifications.json')
        const journal = await readNotificationJournal(filename)
        let bytes = 0
        try { bytes = statSync(filename).size } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (bytes > 64 * 1024) throw new Error('Notification journal exceeds 64 KiB')
        return { bytes, identity: journal.identity, cursor: journal.cursor, summaryCount: journal.summaryCount,
          cooldowns: journal.cooldowns.length, sentAt: journal.sentAt.length }
      },
      sessions(sessions) {
        if (!Array.isArray(sessions) || sessions.length !== 128 || sessions.some((session, index) =>
          session.file !== config.fixture.sessions[index].file || typeof session.sessionId !== 'string')) throw new Error('Invalid rotated performance sessions')
        config.fixture.sessions = sessions
      },
      async plugins(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid plugin state')
        const statuses = monitor.pluginStatuses()
        if (statuses.length !== 4) throw new Error('Expected four built-in plugins')
        for (const plugin of statuses) await monitor.setPluginEnabled(plugin.id, enabled)
        return monitor.diagnostics()
      },
      async stop() {
        await monitor.stop()
        const notificationJournal = await this.notificationJournal()
        return { diagnostics: monitor.diagnostics(), resources: collectionResources.snapshot(), notificationJournal,
          notifications: globalThis.__ocPerformanceTray.notifications() }
      },
      async nodes(value) {
        if (![32, 128, 500, 2000].includes(value)) throw new Error('Invalid performance topology size')
        nodeCount = value
        await monitor.refresh('agents')
      }
    }
    const controls = globalThis.__ocPerformanceControl
    for (const [name, operation] of Object.entries(controls)) {
      controls[name] = (...args) => controlContext.runInAsyncScope(operation, controls, ...args)
    }
  }
  return start.call(this)
}
app.on('before-quit', () => { flush(); finished = true; controlContext.emitDestroy() })
process.on('exit', () => { if (!finished) flush() })
