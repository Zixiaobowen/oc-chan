import { app, BrowserWindow, ipcMain } from 'electron'
import { constants, openSync, readSync, fstatSync, closeSync, writeFileSync, realpathSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { collectionResources } from '../../src/main/resource-budget'
import { EventStore } from '../../src/main/events/store'
import { scheduleTarget } from '../../src/shared/navigation'

function eventDatabase() {
  const instance = process.env.OC_CHAN_DEV_INSTANCE
  if (!instance || !path.isAbsolute(instance) || !/^instance-[\w-]+$/.test(path.basename(instance)) ||
      path.basename(path.dirname(instance)) !== '.dev-instances' || realpathSync(instance) !== instance ||
      app.getPath('userData') !== path.join(instance, 'user-data')) throw new Error('Event seed requires the owned disposable instance')
  for (const directory of [instance, path.join(instance, 'user-data'), path.join(instance, 'user-data', 'events')]) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Unsafe event seed directory')
  }
  const filename = path.join(instance, 'user-data', 'events', 'events.sqlite')
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 20 * 1024 * 1024)
    throw new Error('Unsafe event seed database')
  return filename
}

function configuration() {
  const filename = process.env.OC_CHAN_SMOKE_CONFIG
  if (app.isPackaged || !process.env.OC_CHAN_DEV_INSTANCE || process.env.OC_CHAN_HEADLESS !== '1' ||
      !filename || filename !== process.env.OC_CHAN_PERFORMANCE_CONFIG)
    throw new Error('Smoke probe requires the isolated headless launcher')
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid smoke configuration size')
    const bytes = Buffer.alloc(stat.size + 1)
    const count = readSync(fd, bytes, 0, bytes.length, 0)
    if (count !== stat.size) throw new Error('Smoke configuration changed while reading')
    const config = JSON.parse(bytes.subarray(0, count).toString('utf8'))
    if (config.level !== 'L1' || !path.isAbsolute(config.smoke?.exitReport ?? '')) throw new Error('Invalid smoke configuration')
    return config
  } finally { closeSync(fd) }
}

export function installSmokeControl(monitor) {
  const config = configuration()
  if (Object.hasOwn(globalThis, '__ocSmokeControl')) throw new Error('Duplicate smoke control installation')
  const handle = ipcMain.handle.bind(ipcMain)
  let snapshotHandler
  let eventsHandler
  let eventsFaulted = false
  let seeded = false
  let seeding = false
  const eventQueries = { total: 0, active: 0, rejected: 0, cancelled: 0, recent: [] }
  let faulted = false
  let quitScheduled = false
  // Capture the handler at its public registration boundary, including IPC validation.
  ipcMain.handle = (channel, listener) => {
    if (channel === 'monitor:snapshot') {
      if (snapshotHandler) throw new Error('Duplicate snapshot handler in smoke build')
      snapshotHandler = listener
    }
    if (channel === 'monitor:events') {
      if (eventsHandler) throw new Error('Duplicate events handler in smoke build')
      eventsHandler = async (...args) => {
        eventQueries.total++; eventQueries.active++
        eventQueries.recent.push(args[1] ?? {})
        if (eventQueries.recent.length > 12) eventQueries.recent.shift()
        try { return await listener(...args) }
        catch (error) {
          eventQueries.rejected++
          if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') eventQueries.cancelled++
          throw error
        } finally { eventQueries.active-- }
      }
      return handle(channel, eventsHandler)
    }
    return handle(channel, listener)
  }
  const info = () => ({
    userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({
      id: window.id, url: window.webContents.getURL(), visible: window.isVisible(), focusable: window.isFocusable(), contentBounds: window.getContentBounds()
    })),
    monitor: monitor.diagnostics(), resources: collectionResources.snapshot(), eventQueries
  })
  const exit = app.exit.bind(app)
  app.exit = (code = 0) => {
    let resultCode = code
    try {
      const report = JSON.stringify({ schema: 1, at: new Date().toISOString(), code, ...info() }) + '\n'
      if (Buffer.byteLength(report) > 128 * 1024) throw new Error('Smoke exit evidence budget exceeded')
      writeFileSync(config.smoke.exitReport, report, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      console.error('[oc-chan-smoke] Exit evidence failed:', error)
      resultCode = 1
    }
    return exit(resultCode)
  }
  Object.defineProperty(globalThis, '__ocSmokeControl', { value: Object.freeze({
    info,
    eventDatabase,
    setViewportSize(width, height) {
      if (![width, height].every(value => Number.isSafeInteger(value) && value >= 320 && value <= 2048))
        throw new Error('Smoke viewport dimensions exceed the supported bounds')
      const windows = BrowserWindow.getAllWindows()
      if (windows.length !== 1 || windows[0].isVisible() || windows[0].isFocusable())
        throw new Error('Smoke viewport sizing requires one hidden, non-focusable window')
      const before = windows[0].getContentBounds()
      windows[0].setContentSize(width, height)
      const after = windows[0].getContentBounds()
      if (after.width !== width || after.height !== height) throw new Error('Native smoke viewport did not accept the requested size')
      return { before, after }
    },
    faultEvents(enabled) {
      if (typeof enabled !== 'boolean' || !eventsHandler) throw new Error('Events handler is not ready or invalid fault flag')
      if (enabled !== eventsFaulted) {
        if (enabled) ipcMain.removeHandler('monitor:events')
        else handle('monitor:events', eventsHandler)
        eventsFaulted = enabled
      }
      return { faulted: eventsFaulted }
    },
    async seedEvents() {
      if (seeded || seeding) throw new Error('Event seed is single-use')
      const filename = eventDatabase()
      const job = monitor.state.schedules.data?.jobs.find(job => config.fixture?.hermesJobIds?.includes(job.id))
      if (!job || !path.isAbsolute(config.fixture?.root ?? '') || !job.file?.startsWith(config.fixture.root + path.sep))
        throw new Error('Event seed requires the current synthetic schedule identity')
      const target = scheduleTarget(job)
      if (!monitor.pluginStatuses().find(plugin => plugin.id === 'events')?.enabled) throw new Error('Event plugin must be enabled before seed')
      seeding = true
      let store, failure
      try {
        await monitor.setPluginEnabled('events', false)
        store = new EventStore(filename)
        let loaded = await store.load()
        if (!loaded.checkpoint) throw new Error('F04 checkpoint must exist before F05 seed')
        const countBefore = loaded.retention.count
        const now = Date.now(), timestamp = new Date(now).toISOString()
        const types = ['execution-failed', 'delivery-failed', 'source-unavailable', 'source-recovered']
        const sources = ['smoke-events-a', 'smoke-events-b', 'collection:system']
        for (let start = 0; start < 5000; start += 100) {
          const events = Array.from({ length: 100 }, (_, offset) => {
            const index = start + offset
            const age = index >= 4997 ? 60_000 : (index % 3 === 0 ? 30 * 60_000 : index % 3 === 1 ? 12 * 3600_000 : 3 * 86400_000)
            return {
              id: `smoke-f05-${String(index).padStart(5, '0')}`,
              sourceId: sources[index % sources.length],
              entityId: index === 4999 ? 'synthetic-long-entity-'.repeat(11) : target.id,
              type: types[index % types.length], observedAt: new Date(now - age).toISOString(),
              occurredAt: index === 4997 ? null : new Date(now - age - 3_600_000).toISOString(),
              resultCode: index === 4999 ? 'synthetic-long-result-'.repeat(2) : 'SMOKE_SYNTHETIC',
              target: index === 4997 ? null : index === 4998 ? { ...target, identity: JSON.stringify(['smoke-obsolete-identity']) } : target
            }
          })
          loaded = await store.commit({ revision: loaded.revision, checkpoint: loaded.checkpoint, events, now: timestamp })
        }
        if (loaded.retention.count !== countBefore + 5000) throw new Error('Event seed did not preserve existing records')
        seeded = true
        return { count: 5000, batches: 50, batchSize: 100, countBefore, retention: loaded.retention, target,
          validId: 'smoke-f05-04999', obsoleteId: 'smoke-f05-04998', nullId: 'smoke-f05-04997', now: timestamp }
      } catch (error) { failure = error; throw error }
      finally {
        const errors = []
        if (store) { try { await store.close() } catch (error) { errors.push(error) } }
        try { await monitor.setPluginEnabled('events', true); await monitor.refresh('events') } catch (error) { errors.push(error) }
        seeding = false
        if (errors.length) throw new AggregateError([failure, ...errors].filter(Boolean), 'Event seed cleanup/restart failed')
      }
    },
    faultSnapshot(enabled) {
      if (typeof enabled !== 'boolean' || !snapshotHandler) throw new Error('Snapshot handler is not ready or invalid fault flag')
      if (enabled !== faulted) {
        if (enabled) ipcMain.removeHandler('monitor:snapshot')
        else handle('monitor:snapshot', snapshotHandler)
        faulted = enabled
      }
      return { faulted }
    },
    quit() {
      if (!quitScheduled) { quitScheduled = true; setTimeout(() => app.quit(), 50) }
      return { scheduled: true }
    }
  }) })
}
