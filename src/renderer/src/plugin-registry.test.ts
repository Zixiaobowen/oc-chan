import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { RendererRegistry, MAX_RENDERER_PLUGINS, MAX_TRAY_PANELS, type RendererEntry } from './plugins/registry'
import type { RendererContribution, RendererPluginModule } from './plugins/types'
import type { PluginSettings } from '../../shared/settings'

const enabled: PluginSettings = { agents: true, schedules: true, events: true, system: true }
const disabled = { ...enabled, system: false }
const contribution: RendererContribution = { id: 'system', section: 'system' }
test('disabled plugins never load; late imports cannot resurrect an unloaded generation', async () => {
  let loads = 0
  const first = Promise.withResolvers<RendererPluginModule>(), second = Promise.withResolvers<RendererPluginModule>()
  const registry = new RendererRegistry([{ id: 'system', section: 'system', load: () => (++loads === 1 ? first : second).promise }])
  registry.reconcile(disabled)
  await setImmediate()
  assert.equal(loads, 0)
  registry.reconcile(enabled)
  await setImmediate()
  registry.reconcile(disabled)
  registry.reconcile(enabled)
  await setImmediate()
  first.resolve({ default: contribution })
  await setImmediate()
  assert.deepEqual(registry.getSnapshot().contributions, [])
  second.resolve({ default: contribution })
  await setImmediate()
  assert.deepEqual(registry.getSnapshot().contributions, [contribution])
  registry.reconcile(disabled)
  assert.deepEqual(registry.getSnapshot().contributions, [])
  registry.dispose()
})

test('registration handles cannot remove a later registration of the same contribution object', () => {
  const registry = new RendererRegistry([{ id: 'system', section: 'system', load: async () => ({ default: contribution }) }])
  const removeFirst = registry.register(contribution)
  assert.throws(() => registry.register(contribution), /Duplicate/)
  removeFirst()
  const removeSecond = registry.register(contribution)
  removeFirst()
  assert.deepEqual(registry.getSnapshot().contributions, [contribution])
  removeSecond()
  assert.deepEqual(registry.getSnapshot().contributions, [])
  registry.dispose()
})

test('load failures remain explicit until retry; unrelated retained contributions survive', async () => {
  let attempts = 0
  const retained: RendererContribution = { id: 'agents', section: 'agents', retainWhenDisabled: true }
  const registry = new RendererRegistry([
    { id: 'agents', section: 'agents', retainWhenDisabled: true, load: async () => ({ default: retained }) },
    { id: 'system', section: 'system', load: async () => { if (++attempts === 1) throw new Error('chunk unavailable'); return { default: contribution } } }
  ])
  registry.reconcile(enabled)
  await setImmediate()
  assert.equal(registry.getSnapshot().errors.system, 'chunk unavailable')
  assert.deepEqual(registry.getSnapshot().contributions, [retained])
  registry.reconcile(enabled)
  await setImmediate()
  assert.equal(attempts, 1)
  registry.retry()
  registry.reconcile(enabled)
  await setImmediate()
  assert.deepEqual(registry.getSnapshot().contributions, [retained, contribution])
  registry.reconcile({ ...disabled, agents: false })
  assert.deepEqual(registry.getSnapshot().contributions, [retained])
  registry.dispose()
})

test('dispose drops pending work and listeners, and permits a StrictMode remount', async () => {
  const pending = Promise.withResolvers<RendererPluginModule>()
  let loads = 0, oldNotifications = 0, newNotifications = 0
  const registry = new RendererRegistry([{ id: 'system', section: 'system', load: () => ++loads === 1 ? pending.promise : Promise.resolve({ default: contribution }) }])
  registry.subscribe(() => { oldNotifications++ })
  registry.reconcile(enabled)
  await setImmediate()
  registry.dispose()
  registry.subscribe(() => { newNotifications++ })
  registry.reconcile(enabled)
  pending.reject(new Error('cancelled old generation'))
  await setImmediate()
  assert.equal(oldNotifications, 0)
  assert.equal(newNotifications, 1)
  assert.deepEqual(registry.getSnapshot().errors, {})
  assert.deepEqual(registry.getSnapshot().contributions, [contribution])
  registry.dispose()
})

test('catalog and tray resource limits reject excess registrations and cross-plugin collisions', () => {
  const entry: RendererEntry = { id: 'system', section: 'system', load: async () => ({ default: contribution }) }
  assert.throws(() => new RendererRegistry(Array.from({ length: MAX_RENDERER_PLUGINS + 1 }, (_, index) => ({ ...entry, id: `plugin-${index}` }))), /limit/)
  const registry = new RendererRegistry([entry, { ...entry, id: 'other' }])
  const panel = { id: 'cpu', label: ['CPU', 'CPU'] as const, sections: ['system'] as const, Component: () => null }
  assert.throws(() => registry.register({ ...contribution, tray: Array.from({ length: MAX_TRAY_PANELS + 1 }, (_, index) => ({ ...panel, id: `metric-${index}` })) }), /Invalid tray/)
  const unregister = registry.register({ ...contribution, tray: [panel] })
  assert.throws(() => registry.register({ ...contribution, id: 'other', tray: [panel] }), /Invalid tray/)
  unregister()
  registry.register({ ...contribution, id: 'other', tray: [panel] })()
  registry.dispose()
})
