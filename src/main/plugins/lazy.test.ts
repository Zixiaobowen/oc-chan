import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { lazyCollectionPlugin } from './lazy'
import { createBuiltinCollectionPlugins } from './catalog'
import { CollectionPluginRegistry } from './registry'
import type { CollectionPluginContext, CollectionPluginDefinition, PluginPublication } from './contracts'

const payload = { collectedAt: '2026-11-09T00:00:00.000Z', agents: [], sources: [], activeSubagentCount: 0 }
const metadata = { id: 'sample', section: 'agents' as const, capabilities: ['read'], intervalMs: 2000, timeoutMs: 1000 }

test('disabled entry never loads; disable during import drains without constructing or publishing', async () => {
  let loads = 0, creates = 0
  const loading = Promise.withResolvers<CollectionPluginDefinition<'agents'>>()
  const publications: PluginPublication[] = []
  const definition = lazyCollectionPlugin(metadata, () => { loads++; return loading.promise })
  const registry = new CollectionPluginRegistry([definition], { onSnapshot: value => publications.push(value), onError() {} })
  await registry.setEnabled('sample', false)
  registry.start()
  assert.equal(loads, 0)
  const enabling = registry.setEnabled('sample', true)
  await setImmediate()
  assert.equal(loads, 1)
  // A pending enable is a serialized lifecycle transition; global close cancels it immediately.
  const stopped = registry.close()
  let drained = false
  void stopped.then(() => { drained = true })
  await setImmediate()
  assert.equal(drained, false)
  loading.resolve({ ...metadata, create: () => { creates++; return { collect: async () => payload, stop() {} } } })
  await assert.rejects(enabling, { name: 'AbortError' })
  await stopped
  assert.equal(creates, 0)
  assert.equal(publications.length, 0)
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(registry.diagnostics().timers, 0)
})

test('disable during an automatic lazy start waits for import and suppresses instance creation', async () => {
  const loaded = Promise.withResolvers<CollectionPluginDefinition<'agents'>>()
  let constructed = 0
  const registry = new CollectionPluginRegistry([lazyCollectionPlugin(metadata, () => loaded.promise)], { onSnapshot() {}, onError() {} })
  registry.start()
  await setImmediate()
  const disable = registry.setEnabled('sample', false)
  loaded.resolve({ ...metadata, create() { constructed++; return { collect: async () => payload, stop() {} } } })
  await disable
  assert.equal(constructed, 0)
  assert.equal(registry.statuses()[0].phase, 'disabled')
  await registry.close()
})

test('dynamic registrations reject dependencies and drain collection before freeing their slots', async () => {
  const gate = Promise.withResolvers<void>()
  let released = 0, collections = 0, signal: AbortSignal | undefined
  const registry = new CollectionPluginRegistry([], { onSnapshot() {}, onError() {} })
  await registry.register({ ...metadata, create(context: CollectionPluginContext<'agents'>) {
    signal = context.signal
    return { collect: async () => { if (++collections > 1) await gate.promise; return payload }, stop() { released++ } }
  } })
  await registry.register({ ...metadata, id: 'child', dependencies: ['sample'], create: () => ({ collect: async () => payload, stop() {} }) })
  await assert.rejects(registry.unregister('sample'), /required by child/)
  await registry.unregister('child')
  const collecting = registry.collect('sample')
  const cancelled = assert.rejects(collecting, { name: 'AbortError' })
  await setImmediate()
  const removal = registry.unregister('sample')
  assert.equal(signal?.aborted, true)
  assert.equal(registry.statuses().length, 1)
  assert.equal(registry.unregister('sample'), removal)
  gate.resolve()
  await Promise.all([removal, cancelled])
  assert.equal(released, 1)
  assert.equal(registry.statuses().length, 0)
  assert.equal(registry.diagnostics().timers, 0)
  await registry.close()
})

test('import failure is attributed to its plugin and does not block another plugin', async () => {
  const errors: string[] = []
  const registry = new CollectionPluginRegistry([
    lazyCollectionPlugin(metadata, async () => { throw new Error('module unavailable') }),
    { ...metadata, id: 'healthy', create: () => ({ collect: async () => payload, stop() {} }) }
  ], { onSnapshot() {}, onError: id => { errors.push(id) } })
  await assert.rejects(registry.collect('sample'), /module unavailable/)
  await registry.collect('healthy')
  assert.deepEqual(errors, ['sample'])
  assert.equal(registry.statuses().find(item => item.id === 'healthy')?.phase, 'running')
  await registry.close()
})

test('unregister serializes mutations and concurrent close drains a stable owner list exactly once', async () => {
  const stops = new Map<string, number>()
  const gates = new Map(['first', 'second', 'third'].map(id => [id, Promise.withResolvers<void>()]))
  const registry = new CollectionPluginRegistry([], { onSnapshot() {}, onError() {} })
  for (const id of gates.keys()) await registry.register({ ...metadata, id,
    create: () => ({ collect: async () => payload, async stop() {
      stops.set(id, (stops.get(id) ?? 0) + 1)
      await gates.get(id)!.promise
    } })
  })
  const removal = registry.unregister('first')
  assert.equal(registry.unregister('first'), removal)
  await assert.rejects(registry.unregister('second'), /registration change is in progress/)
  await assert.rejects(registry.setEnabled('first', true), /registration change is in progress/)
  await assert.rejects(registry.register({ ...metadata, id: 'dependent', dependencies: ['first'],
    create: () => ({ collect: async () => payload, stop() {} }) }), /registration change is in progress/)
  const closing = registry.close()
  await setImmediate()
  gates.get('first')!.resolve()
  await removal
  gates.get('second')!.resolve()
  gates.get('third')!.resolve()
  await closing
  assert.deepEqual([...stops.entries()].sort(), [['first', 1], ['second', 1], ['third', 1]])
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(registry.diagnostics().timers, 0)
})

test('builtin collection catalog contains only core sources and allocates no event resources while disabled', async () => {
  const plugins = createBuiltinCollectionPlugins({
    databasePath: () => { throw new Error('disabled events must not open storage') },
    inputs: () => { throw new Error('disabled events must not read inputs') }
  })
  assert.deepEqual(plugins.map(plugin => plugin.section), ['agents', 'schedules', 'events'])
  const registry = new CollectionPluginRegistry(plugins, { onSnapshot() {}, onError() {} })
  for (const plugin of plugins) await registry.setEnabled(plugin.id, false)
  registry.start()
  assert.equal(registry.diagnostics().timers, 0)
  assert.equal(registry.statuses().every(plugin => plugin.generation === 0), true)
  await registry.close()
})

test('dynamic lazy registration does not load while disabled and cancellation drains an import before freeing its slot', async () => {
  const loaded = Promise.withResolvers<CollectionPluginDefinition<'agents'>>()
  const entered = Promise.withResolvers<void>()
  let loads = 0, creates = 0, stops = 0, cancelled = false
  const definition = lazyCollectionPlugin(metadata, () => { loads++; entered.resolve(); return loaded.promise })
  const registry = new CollectionPluginRegistry([], { onSnapshot() {}, onError() {} })
  await registry.register(definition, false)
  assert.equal(loads, 0)
  await registry.unregister(metadata.id)
  const operation = new AbortController()
  const registration = assert.rejects(registry.register(definition, true, operation.signal), { name: 'AbortError' })
    .then(() => { cancelled = true })
  await entered.promise
  operation.abort()
  await setImmediate()
  assert.equal(cancelled, false)
  assert.equal(registry.statuses().length, 1)
  loaded.resolve({ ...metadata, create() { creates++; return { collect: async () => payload, stop() { stops++ } } } })
  await registration
  assert.equal(creates, 0)
  assert.deepEqual(registry.statuses(), [])
  await registry.register(definition)
  assert.equal(loads, 2)
  assert.equal(creates, 1)
  await registry.unregister(metadata.id)
  assert.equal(stops, 1)
  await registry.close()
  assert.equal(registry.diagnostics().timers, 0)
  assert.equal(registry.diagnostics().pending, 0)
})
