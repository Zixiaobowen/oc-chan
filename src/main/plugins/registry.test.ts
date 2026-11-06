import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { MAX_SOURCE_ID_LENGTH, type AgentSnapshot, type ScheduledJob, type ScheduleHistory } from '../../shared/types'
import { collectionResources, resourceAbortError, ResourceCleanupError } from '../resource-budget'
import type { AnyCollectionPlugin, CollectionPluginContext, CollectionPluginDefinition, PluginObserver, PluginPublication, PluginStatus } from './contracts'
import { CollectionPluginRegistry } from './registry'

const snapshot: AgentSnapshot = { collectedAt: '2026-11-05T00:00:00.000Z', agents: [], sources: [], activeSubagentCount: 0 }
const definition = (id = 'sample', patch: Partial<CollectionPluginDefinition<'agents'>> = {}): CollectionPluginDefinition<'agents'> => ({
  id, section: 'agents', capabilities: ['read'], intervalMs: 100, timeoutMs: 1000,
  create: () => ({ collect: async () => snapshot, stop() {} }), ...patch
})
function observe() {
  const snapshots: PluginPublication[] = [], errors: Array<{ id: string; error: unknown; sourceId?: string }> = [], states: PluginStatus[] = []
  const observer: PluginObserver = {
    onSnapshot: publication => { snapshots.push(publication) },
    onError: (id, _section, error, sourceId) => { errors.push({ id, error, sourceId }) },
    onState: state => { states.push(state) }
  }
  return { snapshots, errors, states, observer }
}

function code(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

test('registration rejects invalid metadata and dependency graphs without constructing plugins', async () => {
  let constructed = 0
  const valid = definition('valid', { create: () => { constructed++; return { collect: async () => snapshot, stop() {} } } })
  const invalidFields: Record<string, unknown>[] = [
    { id: '' }, { id: 'A' }, { id: '1name' }, { id: '-name' }, { id: 'has_space' }, { id: '非ascii' }, { id: `a${'b'.repeat(64)}` },
    { id: 12 }, { section: 'other' }, { create: undefined }, { capabilities: undefined }, { capabilities: 'read' },
    { capabilities: ['same', 'same'] }, { capabilities: ['Read'] }, { capabilities: ['a'.repeat(65)] },
    { capabilities: Array.from({ length: 17 }, (_, index) => `cap-${index}`) },
    { dependencies: null }, { dependencies: 'valid' }, { dependencies: ['valid', 'valid'] }, { dependencies: ['BAD'] },
    { dependencies: Array.from({ length: 17 }, (_, index) => `dep-${index}`) },
    { retrySources: null }, { retrySources: 'source' }, { retrySources: [''] }, { retrySources: ['source', 'source'] },
    { retrySources: ['source\ninvalid'] }, { retrySources: ['with space'] }, { retrySources: [42] },
    { retrySources: ['a'.repeat(MAX_SOURCE_ID_LENGTH + 1)] },
    { retrySources: Array.from({ length: 17 }, (_, index) => `source-${index}`) }
  ]
  for (const field of ['intervalMs', 'timeoutMs']) {
    for (const value of [undefined, null, 0, 9, 60_001, 10.5, NaN, Infinity, '100']) invalidFields.push({ [field]: value })
  }
  for (const fields of invalidFields) {
    assert.throws(() => new CollectionPluginRegistry([valid, { ...definition('invalid'), ...fields } as AnyCollectionPlugin], observe().observer))
  }
  for (const invalid of [
    [valid, valid],
    [definition('missing', { dependencies: ['absent'] })],
    [definition('self', { dependencies: ['self'] })],
    [definition('a', { dependencies: ['b'] }), definition('b', { dependencies: ['c'] }), definition('c', { dependencies: ['a'] })],
    Array.from({ length: 17 }, (_, index) => definition(`plugin-${index}`))
  ]) assert.throws(() => new CollectionPluginRegistry(invalid, observe().observer))
  assert.equal(constructed, 0)
  const boundary = new CollectionPluginRegistry(Array.from({ length: 16 }, (_, index) => definition(index ? `plugin-${index}` : 'a'.repeat(64), {
    intervalMs: index % 2 ? 10 : 60_000, timeoutMs: index % 2 ? 60_000 : 10,
    capabilities: Array.from({ length: 16 }, (_, capability) => `cap-${capability}`)
  })), observe().observer)
  assert.equal(boundary.statuses().length, 16)
  assert.equal(boundary.diagnostics().pending, 0)
  await boundary.close()
})

test('registration snapshots mutable definitions, dependencies and scheduling metadata', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const events: string[] = []
  const dependencies = ['base'], capabilities = ['read'], sources = ['launchctl:gui/501']
  const original = { ...definition('consumer', { intervalMs: 10, dependencies, capabilities, retrySources: sources,
    create(this: CollectionPluginDefinition<'agents'>) {
      events.push(`create:${this.id}:${this.capabilities.join(',')}`)
      return { collect: async () => { events.push('collect:consumer'); return snapshot }, stop() {} }
    }
  }) }
  const observer = observe()
  const registry = new CollectionPluginRegistry([original, definition('base', { create: () => ({
    start: () => { events.push('start:base') }, collect: async () => snapshot, stop() {}
  }) })], observer.observer)
  t.after(() => registry.close())
  Object.assign(original, { id: 'mutated', section: 'system', intervalMs: 60_000, create: () => { throw new Error('mutated factory') } })
  dependencies[0] = 'missing'
  capabilities[0] = 'changed'
  sources[0] = 'changed'
  assert.equal(registry.supportsSource('consumer', 'launchctl:gui/501'), true)
  assert.equal(registry.supportsSource('consumer', 'changed'), false)
  registry.start()
  await registry.collect('consumer')
  assert.deepEqual(events, ['start:base', 'create:consumer:read', 'collect:consumer'])
  assert.equal(observer.snapshots.find(value => value.id === 'consumer')?.section, 'agents')
  t.mock.timers.tick(10)
  await setImmediate()
  assert.equal(events.filter(value => value === 'collect:consumer').length, 2)
})

test('disabled plugins stay uninitialized, and manual collection lazily merges concurrent requests', async () => {
  const release = Promise.withResolvers<AgentSnapshot>(), entered = Promise.withResolvers<void>()
  let factories = 0, collections = 0
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    factories++
    return { collect: () => { collections++; entered.resolve(); return release.promise }, stop() {} }
  } })], observer.observer)
  assert.equal(factories, 0)
  await registry.setEnabled('sample', true)
  assert.equal(factories, 0)
  const work = registry.collect('sample')
  for (let index = 0; index < 100; index++) assert.equal(registry.collect('sample'), work)
  await entered.promise
  assert.equal(factories, 1)
  assert.equal(collections, 1)
  assert.equal(registry.diagnostics().pending, 1)
  release.resolve(snapshot)
  await work
  assert.equal(observer.snapshots.length, 1)
  assert.equal(registry.diagnostics().timers, 0, 'manual collection does not turn on recurring scheduling')
  await registry.close()

  const disabled = new CollectionPluginRegistry([definition('disabled', { create: () => {
    factories++; return { collect: async () => snapshot, stop() {} }
  } })], observer.observer)
  await disabled.setEnabled('disabled', false)
  await disabled.setEnabled('disabled', false)
  disabled.start()
  await assert.rejects(disabled.collect('disabled'), error => code(error) === 'OC_PLUGIN_DISABLED')
  assert.equal(factories, 1)
  assert.equal(disabled.diagnostics().timers, 0)
  await disabled.close()
})

test('repeated start and manual refresh keep one periodic timer and one collection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let starts = 0, collections = 0, stops = 0
  const registry = new CollectionPluginRegistry([definition('sample', { intervalMs: 10, create: () => ({
    start() { starts++ }, collect: async () => { collections++; return snapshot }, stop() { stops++ }
  }) })], observe().observer)
  registry.start()
  registry.start()
  await registry.collect('sample')
  assert.equal(starts, 1)
  assert.equal(collections, 1)
  assert.equal(registry.diagnostics().timers, 1)
  t.mock.timers.tick(9)
  await setImmediate()
  assert.equal(collections, 1)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(collections, 2)
  assert.equal(registry.diagnostics().timers, 1)
  for (let index = 0; index < 100; index++) registry.start()
  await registry.collect('sample')
  assert.equal(collections, 3)
  assert.equal(registry.diagnostics().timers, 1)
  const closing = registry.close()
  assert.equal(registry.close(), closing)
  await closing
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.equal(stops, 1)
  assert.equal(collections, 3)
  assert.equal(registry.diagnostics().timers, 0)
  assert.equal(registry.diagnostics().pending, 0)
})

test('periodic sampling keeps its cadence across collection latency and manual refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const release = Promise.withResolvers<AgentSnapshot>()
  let collections = 0
  const registry = new CollectionPluginRegistry([definition('sample', { intervalMs: 10, create: () => ({
    collect: () => ++collections === 2 ? release.promise : Promise.resolve(snapshot), stop() {}
  }) })], observe().observer)
  t.after(() => registry.close())
  registry.start()
  await registry.collect('sample')
  t.mock.timers.tick(10)
  await setImmediate()
  assert.equal(collections, 2)
  t.mock.timers.tick(5)
  release.resolve(snapshot)
  await setImmediate()
  t.mock.timers.tick(5)
  await setImmediate()
  assert.equal(collections, 3, 'collection latency must not postpone the next scheduled sample')
  t.mock.timers.tick(2)
  await registry.collect('sample')
  assert.equal(collections, 4)
  t.mock.timers.tick(8)
  await setImmediate()
  assert.equal(collections, 5, 'manual refresh must not postpone the next scheduled sample')
})

test('disabling drains the actual collection, merges stops, rejects reversal and blocks retired publications', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  const stopping = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>()
  const contexts: CollectionPluginContext<'agents'>[] = []
  let generations = 0, stops = 0, drained = false
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { create: context => {
    contexts.push(context)
    const generation = ++generations
    return {
      collect: async () => {
        if (generation === 1) { entered.resolve(); return release.promise }
        return { ...snapshot, collectedAt: `generation-${generation}` }
      },
      stop: async () => { stops++; if (generation === 1) { stopping.resolve(); await stopped.promise } }
    }
  } })], observer.observer)
  const collecting = registry.collect('sample')
  const cancelled = assert.rejects(collecting, { name: 'AbortError' })
  await entered.promise
  const disable = registry.setEnabled('sample', false)
  assert.equal(registry.setEnabled('sample', false), disable)
  const finished = disable.then(() => { drained = true })
  assert.equal(contexts[0].signal.aborted, true)
  await assert.rejects(registry.setEnabled('sample', true), error => code(error) === 'OC_PLUGIN_BUSY')
  await assert.rejects(registry.collect('sample'), error => code(error) === 'OC_PLUGIN_DISABLED')
  contexts[0].publish(snapshot)
  await setImmediate()
  assert.equal(stops, 0)
  assert.equal(drained, false)
  assert.equal(registry.diagnostics().plugins[0].collecting, true)
  release.resolve(snapshot)
  await stopping.promise
  assert.equal(drained, false)
  assert.equal(registry.diagnostics().plugins[0].stopping, true)
  stopped.resolve()
  await Promise.all([cancelled, finished])
  assert.equal(observer.snapshots.length, 0)
  assert.equal(registry.statuses()[0].phase, 'disabled')
  await registry.setEnabled('sample', false)
  assert.equal(stops, 1)
  const enabling = registry.setEnabled('sample', true)
  assert.equal(registry.setEnabled('sample', true), enabling)
  await assert.rejects(registry.setEnabled('sample', false), error => code(error) === 'OC_PLUGIN_BUSY')
  await enabling
  assert.equal(generations, 2)
  assert.equal(contexts[1].signal.aborted, false)
  assert.equal(observer.snapshots[0].snapshot.collectedAt, 'generation-2')
  contexts[0].publish({ ...snapshot, collectedAt: 'retired' })
  assert.equal(observer.snapshots.length, 1)
  assert.equal(registry.statuses()[0].generation, 2)
  await registry.close()
  contexts[1].publish(snapshot)
  assert.equal(observer.snapshots.length, 1)
})

test('close during initialization aborts start and waits for both initialization and cleanup', async () => {
  const starting = Promise.withResolvers<void>(), releaseStart = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>(), releaseStop = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined, collections = 0, stops = 0, done = false
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => ({
    start: async value => { signal = value; starting.resolve(); await releaseStart.promise },
    collect: async () => { collections++; return snapshot },
    stop: async () => { stops++; stopping.resolve(); await releaseStop.promise }
  }) })], observer.observer)
  const work = registry.collect('sample')
  const rejected = assert.rejects(work, { name: 'AbortError' })
  await starting.promise
  const closing = registry.close()
  const complete = closing.then(() => { done = true })
  assert.equal(registry.close(), closing)
  assert.equal(signal?.aborted, true)
  await setImmediate()
  assert.equal(done, false)
  assert.equal(stops, 0)
  assert.equal(registry.diagnostics().plugins[0].starting, true)
  releaseStart.resolve()
  await stopping.promise
  assert.equal(collections, 0)
  assert.equal(done, false)
  releaseStop.resolve()
  await Promise.all([rejected, complete])
  assert.equal(stops, 1)
  assert.equal(observer.errors.length, 0)
  assert.equal(registry.diagnostics().pending, 0)
})

test('close before queued initialization prevents factory execution and permanently rejects reuse', async () => {
  let factories = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    factories++; return { collect: async () => snapshot, stop() {} }
  } })], observe().observer)
  const work = registry.collect('sample')
  const closing = registry.close()
  await Promise.all([assert.rejects(work, { name: 'AbortError' }), closing])
  assert.equal(factories, 0)
  assert.throws(() => registry.start(), error => code(error) === 'OC_PLUGIN_CLOSED')
  await assert.rejects(registry.collect('sample'), error => code(error) === 'OC_PLUGIN_CLOSED')
  await assert.rejects(registry.setEnabled('sample', true), error => code(error) === 'OC_PLUGIN_CLOSED')
  assert.equal(registry.diagnostics().pending, 0)
})

test('close supersedes a queued enable without constructing a fresh instance', async () => {
  let factories = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    factories++; return { collect: async () => snapshot, stop() {} }
  } })], observe().observer)
  await registry.setEnabled('sample', false)
  const enabling = registry.setEnabled('sample', true)
  const closing = registry.close()
  await Promise.all([assert.rejects(enabling, { name: 'AbortError' }), closing])
  assert.equal(factories, 0)
  assert.equal(registry.diagnostics().pending, 0)
})

test('reentrant close from a factory prevents start and still releases its returned instance once', async () => {
  let starts = 0, stops = 0, closing: Promise<void> | undefined
  const registry: CollectionPluginRegistry = new CollectionPluginRegistry([definition('sample', { create: () => {
    closing = registry.close()
    return { start() { starts++ }, collect: async () => snapshot, stop() { stops++ } }
  } })], observe().observer)
  await assert.rejects(registry.collect('sample'), { name: 'AbortError' })
  await closing
  assert.equal(starts, 0)
  assert.equal(stops, 1)
})

for (const operation of ['start', 'collect'] as const) {
  test(`${operation} timeout reports ETIMEDOUT immediately but owns work until settlement and permits a clean new generation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const observer = observe()
    const contexts: CollectionPluginContext<'agents'>[] = []
    let factories = 0, collects = 0, finished = false
    const registry = new CollectionPluginRegistry([definition('sample', { intervalMs: 10, timeoutMs: 20, create: context => {
      contexts.push(context)
      const generation = ++factories
      const stall = async () => { entered.resolve(); await release.promise }
      return {
        start: async () => { if (generation === 1 && operation === 'start') await stall() },
        collect: async () => { collects++; if (generation === 1 && operation === 'collect') await stall(); return snapshot },
        stop() {}
      }
    } })], observer.observer)
    registry.start()
    const work = registry.collect('sample')
    const rejected = assert.rejects(work, error => code(error) === 'ETIMEDOUT').then(() => { finished = true })
    await entered.promise
    t.mock.timers.tick(20)
    assert.equal(observer.errors.length, 1)
    assert.equal(code(observer.errors[0].error), 'ETIMEDOUT')
    assert.equal(registry.statuses()[0].phase, 'failed')
    assert.equal(contexts[0].signal.aborted, true)
    contexts[0].publish(snapshot)
    t.mock.timers.tick(1000)
    await setImmediate()
    assert.equal(finished, false)
    assert.equal(registry.collect('sample'), work)
    assert.equal(registry.diagnostics().plugins[0].collecting, true)
    assert.equal(registry.diagnostics().timers, 0)
    assert.equal(factories, 1)
    const disabling = registry.setEnabled('sample', false)
    release.resolve()
    await Promise.all([rejected, disabling])
    assert.equal(observer.snapshots.length, 0)
    assert.equal(observer.errors.length, 1, 'timeout must not be downgraded or reported again as cancellation')
    await registry.setEnabled('sample', true)
    assert.equal(factories, 2)
    assert.equal(collects, operation === 'start' ? 1 : 2)
    assert.equal(observer.snapshots.length, 1)
    assert.equal(registry.statuses()[0].phase, 'running')
    assert.equal(registry.statuses()[0].error, null)
    assert.equal(registry.diagnostics().timers, 1)
    await registry.close()
  })
}

test('stop timeout remains visible, owns cleanup until settle, and permanently rejects restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const observer = observe()
  let stops = 0, finished = false
  const registry = new CollectionPluginRegistry([definition('sample', { timeoutMs: 20, create: () => ({
    collect: async () => snapshot,
    stop: async () => { stops++; entered.resolve(); await release.promise }
  }) })], observer.observer)
  await registry.collect('sample')
  const disabling = registry.setEnabled('sample', false)
  const rejected = assert.rejects(disabling, error => code(error) === 'ETIMEDOUT').then(() => { finished = true })
  await entered.promise
  t.mock.timers.tick(20)
  await setImmediate()
  assert.equal(finished, false)
  assert.equal(code(observer.errors[0].error), 'ETIMEDOUT')
  assert.equal(registry.diagnostics().plugins[0].stopping, true)
  assert.equal(registry.setEnabled('sample', false), disabling)
  release.resolve()
  await rejected
  await assert.rejects(registry.setEnabled('sample', true), error => code(error) === 'ETIMEDOUT')
  await assert.rejects(registry.setEnabled('sample', false), error => code(error) === 'ETIMEDOUT')
  await assert.rejects(registry.close(), error => summarizeDiagnostic(error, 'shutdown').details.includes('ETIMEDOUT'))
  assert.equal(stops, 1)
  assert.equal(registry.statuses()[0].phase, 'failed')
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(registry.diagnostics().timers, 0)
})

test('ordinary scheduled collection errors are visible and recover without overlapping work or stopping healthy plugins', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const failure = new Error('collector unavailable')
  const observer = observe()
  let attempts = 0, healthy = 0
  const registry = new CollectionPluginRegistry([
    definition('broken', { intervalMs: 10, create: () => ({ collect: async () => {
      if (++attempts === 1) throw failure
      return snapshot
    }, stop() {} }) }),
    definition('healthy', { intervalMs: 10, create: () => ({ collect: async () => { healthy++; return snapshot }, stop() {} }) })
  ], observer.observer)
  registry.start()
  await assert.rejects(registry.collect('broken'), error => error === failure)
  await registry.collect('healthy')
  assert.equal(observer.errors.length, 1)
  assert.equal(observer.errors[0].id, 'broken')
  assert.equal(registry.statuses()[0].phase, 'failed')
  assert.ok(healthy >= 1)
  t.mock.timers.tick(10)
  await setImmediate()
  assert.equal(attempts, 2)
  assert.equal(registry.statuses()[0].error, null)
  assert.equal(registry.statuses()[0].phase, 'running')
  assert.equal(registry.diagnostics().timers, 2)
  await registry.close()
})

test('failed startup does not repeatedly call its factory and can recover only after disable and cleanup', async () => {
  const failure = new Error('initialization failed')
  const observer = observe()
  let factories = 0, stops = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    const generation = ++factories
    return { start() { if (generation === 1) throw failure }, collect: async () => snapshot, stop() { stops++ } }
  } })], observer.observer)
  await assert.rejects(registry.collect('sample'), error => error === failure)
  await assert.rejects(registry.collect('sample'), error => error === failure)
  await assert.rejects(registry.setEnabled('sample', true), error => error === failure)
  assert.equal(factories, 1)
  assert.equal(observer.errors[0].error, failure)
  await registry.setEnabled('sample', false)
  assert.equal(stops, 1)
  await registry.setEnabled('sample', true)
  assert.equal(factories, 2)
  assert.equal(observer.snapshots.length, 1)
  await registry.close()
})

test('dependencies initialize first and cannot be disabled while a consumer is enabled or still draining', async () => {
  const events: string[] = []
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const registry = new CollectionPluginRegistry([
    definition('consumer', { dependencies: ['base'], create: () => ({
      start() { events.push('consumer') }, collect: async () => snapshot,
      stop: async () => { entered.resolve(); await release.promise }
    }) }),
    definition('base', { create: () => ({ start() { events.push('base') }, collect: async () => snapshot, stop() {} }) })
  ], observe().observer)
  await registry.collect('consumer')
  assert.deepEqual(events, ['base', 'consumer'])
  await assert.rejects(registry.setEnabled('base', false), error => code(error) === 'OC_PLUGIN_DEPENDENCY')
  const disabling = registry.setEnabled('consumer', false)
  await entered.promise
  await assert.rejects(registry.setEnabled('base', false), error => code(error) === 'OC_PLUGIN_DEPENDENCY')
  release.resolve()
  await disabling
  await registry.setEnabled('base', false)
  await assert.rejects(registry.setEnabled('consumer', true), error => code(error) === 'OC_PLUGIN_DEPENDENCY')
  assert.equal(registry.statuses().find(state => state.id === 'consumer')?.enabled, false)
  await registry.setEnabled('base', true)
  await registry.setEnabled('consumer', true)
  assert.deepEqual(events, ['base', 'consumer', 'base', 'consumer'])
  await registry.close()
})

test('close aborts all owners immediately and drains consumers before dependencies even after a stop failure', async () => {
  const events: string[] = []
  const contexts: CollectionPluginContext<'agents'>[] = []
  const observer = observe()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const failure = Object.assign(new Error('private-path'), { code: 'EIO' })
  const registry = new CollectionPluginRegistry([
    definition('base', { create: context => {
      contexts.push(context)
      return { collect: async () => snapshot, stop() { events.push('base') } }
    } }),
    definition('middle', { dependencies: ['base'], create: context => {
      contexts.push(context)
      return { collect: async () => snapshot, stop() { events.push('middle'); throw failure } }
    } }),
    definition('consumer', { dependencies: ['middle'], create: context => {
      contexts.push(context)
      return { collect: async () => snapshot, stop: async () => { events.push('consumer'); entered.resolve(); await release.promise } }
    } })
  ], observer.observer)
  await registry.collect('consumer')
  const closing = registry.close()
  const rejected = assert.rejects(closing, error => {
    const summary = summarizeDiagnostic(error, 'shutdown').details
    return summary.includes('resource=agents') && summary.includes('EIO') && !summary.includes('private-path')
  })
  assert.equal(contexts.every(context => context.signal.aborted), true)
  await entered.promise
  assert.deepEqual(events, ['consumer'])
  release.resolve()
  await rejected
  assert.deepEqual(events, ['consumer', 'middle', 'base'])
  assert.equal(observer.errors.find(value => value.id === 'middle')?.error, failure)
  assert.equal(registry.statuses().find(state => state.id === 'middle')?.phase, 'failed')
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(registry.diagnostics().timers, 0)
})

test('all stop rejection values remain failures and are retained across repeated disable and close', async () => {
  for (const failure of [undefined, null, 'stop failed', resourceAbortError()]) {
    let stops = 0, otherStops = 0
    const observer = observe()
    const registry = new CollectionPluginRegistry([
      definition('broken', { create: () => ({ collect: async () => snapshot, stop: () => { stops++; return Promise.reject(failure) } }) }),
      definition('healthy', { create: () => ({ collect: async () => snapshot, stop() { otherStops++ } }) })
    ], observer.observer)
    await Promise.all([registry.collect('broken'), registry.collect('healthy')])
    await assert.rejects(registry.setEnabled('broken', false), error => error === failure)
    assert.equal(observer.errors.length, 1)
    assert.equal(observer.errors[0].error, failure)
    await assert.rejects(registry.setEnabled('broken', true), error => error === failure)
    await assert.rejects(registry.setEnabled('broken', false), error => error === failure)
    await assert.rejects(registry.close(), AggregateError)
    assert.equal(stops, 1)
    assert.equal(otherStops, 1)
    assert.equal(registry.statuses()[0].phase, 'failed')
  }
})

test('a primitive collection rejection during close is reported and cannot be mistaken for a drained success', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => ({
    collect: () => { entered.resolve(); return release.promise }, stop() {}
  }) })], observer.observer)
  const work = assert.rejects(registry.collect('sample'), error => error === undefined)
  await entered.promise
  const closing = assert.rejects(registry.close(), AggregateError)
  release.reject(undefined)
  await Promise.all([work, closing])
  assert.equal(observer.errors.length, 1)
  assert.equal(observer.errors[0].error, undefined)
})

test('resource cleanup failures already reported by collection remain shutdown failures', async () => {
  const failure = new ResourceCleanupError('file', Object.assign(new Error(), { code: 'EIO' }))
  const observer = observe()
  let stops = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => ({
    collect: async () => { throw failure }, stop() { stops++ }
  }) })], observer.observer)
  await assert.rejects(registry.collect('sample'), error => error === failure)
  await assert.rejects(registry.close(), error => summarizeDiagnostic(error, 'shutdown').details.includes('OC_RESOURCE_CLOSE'))
  assert.equal(observer.errors.length, 1)
  assert.equal(stops, 1)
})

test('100 lifecycle cycles share the existing resource budget and detach the external abort listener after real drain', async () => {
  for (let cycle = 0; cycle < 100; cycle++) {
    const parent = new AbortController()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const observer = observe()
    let contextSignal: AbortSignal | undefined
    const registry = new CollectionPluginRegistry([definition('sample', { create: context => {
      assert.equal(context.resources, collectionResources)
      contextSignal = context.signal
      return {
        collect: signal => context.resources.run({ source: 'plugin-lifecycle-cycle', kind: 'file', bytes: 1, signal }, async () => {
          entered.resolve()
          await release.promise
          throw resourceAbortError()
        }),
        stop() {}
      }
    } })], observer.observer, { signal: parent.signal })
    assert.equal(getEventListeners(parent.signal, 'abort').length, 1)
    const work = assert.rejects(registry.collect('sample'), { name: 'AbortError' })
    await entered.promise
    if (cycle % 2) parent.abort()
    const closing = registry.close()
    let drained = false
    const finished = closing.then(() => { drained = true })
    assert.equal(contextSignal?.aborted, true)
    await setImmediate()
    assert.equal(drained, false)
    assert.equal(collectionResources.snapshot().global.current.files, 1)
    release.resolve()
    await Promise.all([work, finished])
    assert.equal(collectionResources.snapshot().global.current.files, 0)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    assert.equal(registry.diagnostics().pending, 0)
    assert.equal(registry.diagnostics().timers, 0)
    assert.equal(observer.errors.length, 0)
  }
})

test('an already aborted parent leaves every plugin disabled without factories or listeners', async () => {
  let factories = 0
  const parent = new AbortController()
  parent.abort()
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    factories++; return { collect: async () => snapshot, stop() {} }
  } })], observe().observer, { signal: parent.signal })
  assert.equal(registry.diagnostics().closed, true)
  assert.equal(registry.statuses()[0].phase, 'disabled')
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  await assert.rejects(registry.collect('sample'), error => code(error) === 'OC_PLUGIN_CLOSED')
  await registry.close()
  assert.equal(factories, 0)
})

test('a timed out plugin cannot block collection or cleanup of an independent plugin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  const observer = observe()
  let healthyCollections = 0, healthyStops = 0
  const registry = new CollectionPluginRegistry([
    definition('slow', { timeoutMs: 20, create: () => ({
      collect: () => { entered.resolve(); return release.promise }, stop() {}
    }) }),
    definition('healthy', { intervalMs: 10, create: () => ({
      collect: async () => { healthyCollections++; return snapshot }, stop() { healthyStops++ }
    }) })
  ], observer.observer)
  registry.start()
  const rejected = assert.rejects(registry.collect('slow'), error => code(error) === 'ETIMEDOUT')
  await entered.promise
  await registry.collect('healthy')
  t.mock.timers.tick(20)
  await setImmediate()
  assert.ok(healthyCollections >= 2)
  assert.equal(registry.diagnostics().plugins.find(plugin => plugin.id === 'slow')?.collecting, true)
  assert.equal(observer.errors[0].id, 'slow')
  assert.equal(observer.snapshots.every(publication => publication.id === 'healthy'), true)
  const closing = registry.close()
  await setImmediate()
  assert.equal(healthyStops, 1)
  release.resolve(snapshot)
  await Promise.all([rejected, closing])
  assert.equal(registry.diagnostics().pending, 0)
})

test('throwing and malformed factories report failure and release any valid cleanup method', async () => {
  const failure = new Error('factory failed')
  let stops = 0
  const factories = [
    () => { throw failure },
    () => ({ collect: undefined, stop() { stops++ } }),
    () => ({ collect: async () => snapshot, stop: undefined }),
    () => null
  ]
  for (const create of factories) {
    const observer = observe()
    const registry = new CollectionPluginRegistry([definition('sample', {
      create: create as unknown as CollectionPluginDefinition<'agents'>['create']
    })], observer.observer)
    await assert.rejects(registry.collect('sample'), error => error === failure || code(error) === 'OC_PLUGIN_DEFINITION')
    assert.equal(observer.errors.length, 1)
    assert.equal(registry.statuses()[0].phase, 'failed')
    await registry.close()
  }
  assert.equal(stops, 1)
})

test('a late non-cancellation failure after timeout remains visible alongside the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  const observer = observe()
  const failure = Object.assign(new Error('late release failed'), { code: 'EIO' })
  const registry = new CollectionPluginRegistry([definition('sample', { timeoutMs: 20, create: () => ({
    collect: () => { entered.resolve(); return release.promise }, stop() {}
  }) })], observer.observer)
  const work = assert.rejects(registry.collect('sample'), error => {
    const summary = summarizeDiagnostic(error, 'shutdown').details
    return summary.includes('ETIMEDOUT') && summary.includes('EIO')
  })
  await entered.promise
  t.mock.timers.tick(20)
  const closing = assert.rejects(registry.close(), AggregateError)
  release.reject(failure)
  await Promise.all([work, closing])
  assert.equal(observer.errors.length, 2)
  assert.equal(code(observer.errors[0].error), 'ETIMEDOUT')
  assert.equal(observer.errors[1].error, failure)
})

test('declared source retries coalesce and stay bounded behind one serial collection chain', async () => {
  const full = Promise.withResolvers<AgentSnapshot>()
  const entered = Promise.withResolvers<void>(), sourceEntered = Promise.withResolvers<void>()
  const first = Promise.withResolvers<AgentSnapshot>()
  const sources = Array.from({ length: 16 }, (_, index) => `launchctl:user/${index}`)
  const calls: Array<string | undefined> = []
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { retrySources: sources, create: () => ({
    collect: async (_signal, sourceId) => {
      calls.push(sourceId)
      if (sourceId === undefined) { entered.resolve(); return full.promise }
      if (sourceId === sources[0]) { sourceEntered.resolve(); return first.promise }
      return snapshot
    }, stop() {}
  }) })], observer.observer)
  const collecting = registry.collect('sample')
  await entered.promise
  const retries = sources.map(source => registry.collect('sample', source))
  for (let burst = 0; burst < 100; burst++) {
    sources.forEach((source, index) => assert.equal(registry.collect('sample', source), retries[index]))
    assert.equal(registry.collect('sample'), retries.at(-1))
  }
  await assert.rejects(registry.collect('sample', 'undeclared'), error => code(error) === 'OC_PLUGIN_CAPABILITY')
  assert.equal(registry.diagnostics().pending, 17)
  assert.equal(registry.diagnostics().plugins[0].retrying, 16)
  assert.deepEqual(calls, [undefined])
  full.resolve(snapshot)
  await collecting
  await sourceEntered.promise
  assert.equal(registry.collect('sample'), retries.at(-1), 'the completed full collection must not clear a later retry slot')
  assert.deepEqual(calls, [undefined, sources[0]])
  first.resolve(snapshot)
  await Promise.all(retries)
  assert.deepEqual(calls, [undefined, ...sources])
  assert.deepEqual(observer.snapshots.map(publication => publication.sourceId), [undefined, ...sources])
  assert.equal(registry.diagnostics().pending, 0)
  await registry.close()
})

test('retry failures retain source ownership and neither incremental events nor source success erase a full collection failure', async () => {
  let context: CollectionPluginContext<'agents'> | undefined, failFull = true
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { retrySources: ['one', 'two'], create: current => {
    context = current
    return { collect: async (_signal, sourceId) => {
      if (!sourceId && failFull) throw new Error('discovery unavailable')
      if (sourceId === 'one') throw new Error('one unavailable')
      return snapshot
    }, stop() {} }
  } })], observer.observer)
  await assert.rejects(registry.collect('sample'), /discovery unavailable/)
  context!.publish(snapshot, true)
  assert.equal(observer.snapshots[0].incremental, true)
  assert.equal(registry.statuses()[0].error, 'discovery unavailable')
  const first = registry.collect('sample', 'one')
  const second = registry.collect('sample', 'two')
  await Promise.all([assert.rejects(first, /one unavailable/), second])
  assert.equal(observer.errors[0].sourceId, undefined)
  assert.equal(observer.errors[1].sourceId, 'one')
  assert.equal(registry.statuses()[0].error, 'discovery unavailable')
  failFull = false
  await registry.collect('sample')
  assert.equal(registry.statuses()[0].error, null)
  await registry.close()
})

test('periodic collection skips busy retries and resumes on its original deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  let full = 0
  const registry = new CollectionPluginRegistry([definition('sample', { intervalMs: 10, retrySources: ['source'], create: () => ({
    collect: async (_signal, sourceId) => {
      if (sourceId) { entered.resolve(); return release.promise }
      full++
      return snapshot
    }, stop() {}
  }) })], observe().observer)
  t.after(() => registry.close())
  registry.start()
  await registry.collect('sample')
  const retry = registry.collect('sample', 'source')
  await entered.promise
  t.mock.timers.tick(25)
  await setImmediate()
  assert.equal(full, 1)
  release.resolve(snapshot)
  await retry
  t.mock.timers.tick(5)
  await setImmediate()
  assert.equal(full, 2)
})

test('disable cancels and drains the full collection and all queued retries without losing a late failure', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<AgentSnapshot>()
  let retries = 0, stops = 0
  const observer = observe()
  const registry = new CollectionPluginRegistry([definition('sample', { retrySources: ['one', 'two'], create: () => ({
    collect: async (_signal, sourceId) => {
      if (sourceId) { retries++; return snapshot }
      entered.resolve()
      return release.promise
    }, stop() { stops++ }
  }) })], observer.observer)
  const work = assert.rejects(registry.collect('sample'), /late collection failure/)
  await entered.promise
  const retryOne = assert.rejects(registry.collect('sample', 'one'), { name: 'AbortError' })
  const retryTwo = assert.rejects(registry.collect('sample', 'two'), { name: 'AbortError' })
  const disabling = assert.rejects(registry.setEnabled('sample', false), /late collection failure/)
  await setImmediate()
  assert.equal(stops, 0)
  release.reject(new Error('late collection failure'))
  await Promise.all([work, retryOne, retryTwo, disabling])
  assert.equal(retries, 0)
  assert.equal(stops, 1)
  assert.equal(registry.diagnostics().pending, 0)
  assert.equal(observer.errors[0].sourceId, undefined)
  await assert.rejects(registry.close(), AggregateError)
})

const historyJob: ScheduledJob = { id: 'job', name: 'Job', source: 'Hermes', scope: 'user', origin: 'personal', kind: 'calendar', schedule: '* * * * *', state: 'waiting' }
const historyResult: ScheduleHistory = { jobId: historyJob.id, source: 'hermes', entries: [], offset: 0, limit: 50, hasMore: false, collectedAt: snapshot.collectedAt }

test('history cancellation and disabled reads never initialize unused plugins, and capability errors remain explicit', async () => {
  let factories = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    factories++
    return { collect: async () => snapshot, stop() {} }
  } })], observe().observer)
  registry.cancelHistory('sample')
  await registry.setEnabled('sample', false)
  await assert.rejects(registry.readHistory('sample', historyJob), error => code(error) === 'OC_PLUGIN_DISABLED')
  registry.cancelHistory('sample')
  assert.equal(factories, 0)
  assert.throws(() => registry.cancelHistory('unknown'), error => code(error) === 'OC_PLUGIN_UNKNOWN')
  await assert.rejects(registry.readHistory('unknown', historyJob), error => code(error) === 'OC_PLUGIN_UNKNOWN')
  await registry.setEnabled('sample', true)
  await assert.rejects(registry.readHistory('sample', historyJob), error => code(error) === 'OC_PLUGIN_CAPABILITY')
  assert.equal(factories, 1)
  await registry.close()
})

test('history cancellation invalidates a late successful read and an initialization still in flight', async () => {
  const starting = Promise.withResolvers<void>(), start = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>(), result = Promise.withResolvers<ScheduleHistory>()
  let reads = 0, cancels = 0
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => ({
    start: async () => { starting.resolve(); await start.promise }, collect: async () => snapshot, stop() {},
    history: { read: async () => { reads++; entered.resolve(); return result.promise }, cancel: () => { cancels++ } }
  }) })], observe().observer)
  const duringStart = assert.rejects(registry.readHistory('sample', historyJob), { name: 'AbortError' })
  await starting.promise
  registry.cancelHistory('sample')
  start.resolve()
  await duringStart
  assert.equal(reads, 0)
  const reading = assert.rejects(registry.readHistory('sample', historyJob), { name: 'AbortError' })
  await entered.promise
  registry.cancelHistory('sample')
  result.resolve(historyResult)
  await reading
  assert.equal(cancels, 2)
  await registry.close()
})

test('history disable waits for real reader release and a fresh generation cannot accept retired history', async () => {
  const entered = Promise.withResolvers<void>(), result = Promise.withResolvers<ScheduleHistory>()
  const stopping = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let factories = 0, stopped = false
  const registry = new CollectionPluginRegistry([definition('sample', { create: () => {
    const generation = ++factories
    return { collect: async () => snapshot,
      history: { read: async (_job, offset) => {
        if (generation === 1) { entered.resolve(); return result.promise }
        return { ...historyResult, offset: offset ?? 0, collectedAt: 'fresh-generation' }
      }, cancel() {} },
      stop: async () => { if (generation === 1) { stopping.resolve(); await release.promise } }
    }
  } })], observe().observer)
  const oldRead = assert.rejects(registry.readHistory('sample', historyJob), { name: 'AbortError' })
  await entered.promise
  const disabling = registry.setEnabled('sample', false).then(() => { stopped = true })
  await stopping.promise
  await setImmediate()
  assert.equal(stopped, false)
  result.resolve(historyResult)
  await oldRead
  release.resolve()
  await disabling
  await registry.setEnabled('sample', true)
  const fresh = await registry.readHistory('sample', historyJob, 50)
  assert.equal(fresh.collectedAt, 'fresh-generation')
  assert.equal(fresh.offset, 50)
  assert.equal(factories, 2)
  await registry.close()
})
