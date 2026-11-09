import { runBudgetedCommand } from '../resource-io'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { watch } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { AgentSnapshot } from '../../shared/types'
import type { AgentDiscovery } from '../collectors/agents'
import { collectionResources, resourceAbortError } from '../resource-budget'
import { createAgentsPlugin } from './agents'

const snapshot: AgentSnapshot = { collectedAt: '2026-11-05T00:00:00.000Z', agents: [], sources: [], activeSubagentCount: null }

test('agent factories are lazy and each instance starts with a fresh discovery baseline', async () => {
  let discoveries = 0
  const definition = createAgentsPlugin({ discover: async () => ({ snapshot: { ...snapshot, collectedAt: String(++discoveries) }, sessions: [] }) })
  assert.equal(discoveries, 0)
  for (let cycle = 1; cycle <= 2; cycle++) {
    const lifetime = new AbortController()
    const updates: { data: AgentSnapshot; incremental?: boolean }[] = []
    const plugin = await definition.create({ signal: lifetime.signal, resources: collectionResources, command: runBudgetedCommand,
      publish: (data, incremental) => updates.push({ data, incremental }) })
    assert.equal(discoveries, cycle - 1)
    const data = await plugin.collect(new AbortController().signal)
    assert.ok(data)
    assert.equal(data.collectedAt, String(cycle))
    assert.equal(data, updates.at(-1)?.data)
    assert.equal(updates.at(-1)?.incremental, true)
    await plugin.stop()
    assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
    await assert.rejects(plugin.collect(new AbortController().signal), { name: 'AbortError' })
  }
})

test('collection cancellation reaches discovery without disabling subsequent collection', async () => {
  const lifetime = new AbortController()
  const operation = new AbortController()
  let observed: AbortSignal | undefined
  let attempts = 0
  const plugin = await createAgentsPlugin({ discover: signal => {
    if (++attempts > 1) return Promise.resolve({ snapshot, sessions: [] })
    observed = signal
    const { promise, reject } = Promise.withResolvers<AgentDiscovery>()
    signal!.addEventListener('abort', () => reject(resourceAbortError()), { once: true })
    return promise
  } }).create({ signal: lifetime.signal, resources: collectionResources, command: runBudgetedCommand, publish() {} })
  const collecting = assert.rejects(plugin.collect(operation.signal), { name: 'AbortError' })
  operation.abort()
  assert.equal(observed?.aborted, true)
  await collecting
  assert.equal(lifetime.signal.aborted, false)
  const recovered = await plugin.collect(new AbortController().signal)
  assert.ok(recovered)
  assert.equal(recovered.collectedAt, snapshot.collectedAt)
  await plugin.stop()
})

test('stop drains late discovery and preserves cleanup failures without publishing stale results', async () => {
  const gate = Promise.withResolvers<AgentDiscovery>()
  let published = 0
  const failure = new Error('discovery release failed')
  const plugin = await createAgentsPlugin({ discover: () => gate.promise }).create({ signal: new AbortController().signal,
    resources: collectionResources, command: runBudgetedCommand, publish: () => { published++ } })
  const collecting = assert.rejects(plugin.collect(new AbortController().signal), error => error === failure)
  let stopped = false
  const stopping = assert.rejects(Promise.resolve(plugin.stop()).finally(() => { stopped = true }), error => {
    assert(error instanceof AggregateError)
    assert.equal(error.errors[0], failure)
    return true
  })
  await setImmediate()
  assert.equal(stopped, false)
  gate.reject(failure)
  await Promise.all([collecting, stopping])
  assert.equal(published, 0)
})

test('100 plugin lifetimes close real file watchers, cancel timers and discard activity baselines', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-agent-plugin-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  t.after(() => rm(directory, { recursive: true, force: true }))
  let watchers = 0
  let publications = 0
  const definition = createAgentsPlugin({
    discover: async () => ({ snapshot: { ...snapshot, agents: [{ id: 'omp:owned', name: 'owned', runtime: 'OMP',
      kind: 'main', state: 'running', pid: 40, sessionId: 'owned', source: 'owned session' }] }, sessions: [{ file, sessionId: 'owned' }] }),
    watchFile(path, listener) {
      const watcher = watch(path, listener)
      watchers++
      watcher.once('close', () => { watchers-- })
      return watcher
    }
  })
  for (let cycle = 0; cycle < 100; cycle++) {
    const lifetime = new AbortController()
    const plugin = await definition.create({ signal: lifetime.signal, resources: collectionResources, command: runBudgetedCommand,
      publish: () => { publications++ } })
    try {
      const data = await plugin.collect(lifetime.signal)
      assert.ok(data)
      assert.equal(data.agents[0].activity, undefined)
      assert.equal(watchers, 1)
      const count = publications
      lifetime.abort()
      await plugin.stop()
      assert.equal(watchers, 0)
      assert.equal(publications, count)
      assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
    } finally { await plugin.stop() }
  }
  assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
})
