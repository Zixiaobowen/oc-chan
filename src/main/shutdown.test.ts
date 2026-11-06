import assert from 'node:assert/strict'
import test from 'node:test'
import { drainShutdown, type ShutdownOperations } from './shutdown'
import { summarizeDiagnostic } from '../shared/diagnostics'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { CollectionPluginRegistry } from './plugins/registry'
import { readSettings, SettingsStore } from './settings'

const operations = (patch: Partial<ShutdownOperations>): ShutdownOperations => ({
  monitor: () => {}, navigation: () => {}, diagnostics: () => {}, settings: () => {}, desktop: () => {}, tray: () => {}, theme: () => {}, ...patch
})

test('shutdown drains settings before dependent resources and waits for independent cleanup', async () => {
  const monitor = Promise.withResolvers<void>(), settings = Promise.withResolvers<void>()
  const navigation = Promise.withResolvers<void>(), diagnostics = Promise.withResolvers<void>()
  const started: string[] = []
  let done = false
  const closing = drainShutdown(operations({
    monitor: () => { started.push('monitor'); return monitor.promise },
    navigation: () => { started.push('navigation'); return navigation.promise },
    settings: () => { started.push('settings'); return settings.promise },
    diagnostics: () => { started.push('diagnostics'); return diagnostics.promise }
  })).then(() => { done = true })
  assert.deepEqual(new Set(started), new Set(['navigation', 'settings', 'diagnostics']))
  settings.resolve()
  await settings.promise
  assert.ok(started.includes('monitor'))
  monitor.resolve()
  await monitor.promise
  assert.equal(done, false)
  navigation.resolve()
  await navigation.promise
  assert.equal(done, false)
  diagnostics.resolve()
  await closing
  assert.equal(done, true)
})

test('shutdown attempts every cleanup after a synchronous failure and preserves asynchronous failure', async () => {
  const tray = Promise.withResolvers<void>()
  let disposed = false
  const closing = drainShutdown(operations({
    settings: () => { throw Object.assign(new Error('private-preference'), { code: 'EACCES' }) },
    monitor: () => { throw Object.assign(new Error('secret-path'), { code: 'EIO' }) },
    tray: () => tray.promise,
    desktop: () => { disposed = true }
  }))
  const rejected = assert.rejects(closing, error => {
    const details = summarizeDiagnostic(error, 'shutdown').details
    return details.includes('resource=settings') && details.includes('EACCES') && details.includes('resource=monitor') && details.includes('resource=tray') && details.includes('EIO') && !details.includes('secret-path') && !details.includes('private-preference')
  })
  assert.equal(disposed, true)
  tray.reject(new Error('secret-path'))
  await rejected
})

test('deadline identifies unfinished cleanup and never reports a successful drain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const monitor = Promise.withResolvers<void>()
  const closing = drainShutdown(operations({ monitor: () => monitor.promise }))
  const rejected = assert.rejects(closing, error => {
    const diagnostic = summarizeDiagnostic(error, 'shutdown')
    return diagnostic.details.includes('OC_SHUTDOWN_TIMEOUT') && diagnostic.details.includes('resource=monitor') && !diagnostic.details.includes('resource=tray')
  })
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await rejected
  // The caller must force exit; the child did not pretend it was already released.
  monitor.reject(new Error('late release failure'))
  await Promise.resolve()
})

test('undefined and primitive rejections cannot be mistaken for cleanup success', async () => {
  for (const error of [undefined, null, 'private-data']) {
    await assert.rejects(drainShutdown(operations({ monitor: () => Promise.reject(error) })), reason => {
      const details = summarizeDiagnostic(reason, 'shutdown').details
      return details.includes('resource=monitor') && !details.includes('private-data')
    })
  }
})

test('shutdown persists final geometry before closing the plugins used by settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-shutdown-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const registry = new CollectionPluginRegistry([{
    id: 'agents', section: 'agents', capabilities: ['read'], intervalMs: 1000, timeoutMs: 1000,
    create: () => ({ collect: async () => ({ collectedAt: '2026-11-05T00:00:00Z', agents: [], sources: [], activeSubagentCount: 0 }), stop() {} })
  }], { onSnapshot() {}, onError() {}, onState() {} })
  t.after(() => registry.close())
  await registry.collect('agents')
  const store = new SettingsStore(filename, DEFAULT_SETTINGS, async value => {
    for (const plugin of registry.statuses()) {
      if (plugin.enabled !== value.plugins[plugin.section]) await registry.setEnabled(plugin.id, value.plugins[plugin.section])
    }
  })
  const bounds = { x: 20, y: 30, width: 880, height: 640 }
  await drainShutdown(operations({
    settings: async () => { await store.update({ windowBounds: bounds }); await store.idle() },
    monitor: () => registry.close()
  }))
  assert.deepEqual((await readSettings(filename)).windowBounds, bounds)
  assert.equal(store.value.plugins.agents, true)
  assert.equal(registry.diagnostics().closed, true)
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(registry.diagnostics().timers, 0)
})
