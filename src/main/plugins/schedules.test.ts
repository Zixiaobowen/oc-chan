import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { HISTORY_PAGE_SIZE, type ScheduleHistory, type ScheduledJob, type ScheduleSnapshot } from '../../shared/types'
import type { ScheduleCollector } from '../collectors/schedules'
import { collectionResources } from '../resource-budget'
import { ScheduleHistoryReader } from '../schedule-history'
import { createSchedulesPlugin } from './schedules'

const snapshot: ScheduleSnapshot = { collectedAt: '2026-11-05T00:00:00.000Z', jobs: [], sources: [] }
const job: ScheduledJob = { id: 'hermes-job:daily', name: 'Daily', source: 'Hermes', scope: 'user',
  origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }
const page: ScheduleHistory = { jobId: job.id, source: 'hermes', entries: [], offset: 0,
  limit: HISTORY_PAGE_SIZE, hasMore: false, collectedAt: snapshot.collectedAt }

function collector(): Pick<ScheduleCollector, 'collect' | 'retry' | 'supports' | 'dispose'> {
  return { collect: async () => snapshot, retry: async () => snapshot, supports: () => true, dispose() {} }
}

test('schedule factories are lazy and route retry and collection signals through their public collector', async () => {
  let collectors = 0, readers = 0, disposed = 0
  let lifetimeSignal: AbortSignal | undefined
  const calls: { sourceId?: string; signal?: AbortSignal }[] = []
  const definition = createSchedulesPlugin({ uid: 502,
    createCollector: signal => {
      collectors++
      lifetimeSignal = signal
      return { collect: async signal => { calls.push({ signal }); return snapshot },
        retry: async (sourceId, signal) => { calls.push({ sourceId, signal }); return snapshot },
        supports: sourceId => sourceId === 'launchctl:gui/502', dispose: () => { disposed++ } }
    },
    createHistory: () => { readers++; return new ScheduleHistoryReader({ providers: [] }) }
  })
  assert.equal(collectors, 0)
  assert.equal(readers, 0)
  assert.deepEqual(definition.retrySources, ['launchctl:gui/502', 'launchctl:user/502', 'launchctl:system'])
  const lifetime = new AbortController(), operation = new AbortController()
  const plugin = definition.create({ signal: lifetime.signal, resources: collectionResources, publish() {} })
  assert.equal(lifetimeSignal, lifetime.signal)
  assert.equal(await plugin.collect(operation.signal), snapshot)
  assert.equal(await plugin.collect(operation.signal, 'launchctl:gui/502'), snapshot)
  assert.deepEqual(calls, [{ signal: operation.signal }, { sourceId: 'launchctl:gui/502', signal: operation.signal }])
  await assert.rejects(plugin.collect(operation.signal, 'launchctl:unknown'), /Source does not support/)
  assert.equal(calls.length, 2)
  const stopping = plugin.stop()
  assert.equal(plugin.stop(), stopping)
  await stopping
  assert.equal(disposed, 1)
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
  await assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
  await assert.rejects(plugin.collect(operation.signal), { name: 'AbortError' })
})

test('100 schedule lifetimes cancel history immediately, await provider release and isolate each reader', async () => {
  let created = 0, disposed = 0, active = 0
  for (let cycle = 0; cycle < 100; cycle++) {
    const release = Promise.withResolvers<ScheduleHistory>()
    let providerSignal: AbortSignal | undefined
    const history = new ScheduleHistoryReader({ providers: [{ supports: () => true,
      read: (_job, _offset, signal) => { providerSignal = signal; active++; return release.promise.finally(() => { active-- }) } }] })
    const definition = createSchedulesPlugin({ createCollector: () => ({ ...collector(), dispose: () => { disposed++ } }),
      createHistory: () => { created++; return history } })
    const lifetime = new AbortController()
    const plugin = definition.create({ signal: lifetime.signal, resources: collectionResources, publish() {} })
    const request = assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
    assert.equal(active, 1)
    lifetime.abort()
    assert.equal(providerSignal?.aborted, true)
    await request
    let stopped = false
    const stopping = Promise.resolve(plugin.stop()).then(() => { stopped = true })
    await setImmediate()
    assert.equal(stopped, false)
    assert.equal(history.diagnostics().active, true)
    release.resolve(page)
    await stopping
    assert.equal(active, 0)
    assert.equal(history.diagnostics().closed, true)
    assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
    await assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
  }
  assert.equal(created, 100)
  assert.equal(disposed, 100)
})

test('a synchronous collector disposal failure still closes and drains history and preserves both errors', async () => {
  const release = Promise.withResolvers<ScheduleHistory>()
  const history = new ScheduleHistoryReader({ providers: [{ supports: () => true, read: () => release.promise }] })
  const collectorFailure = new Error('collector cleanup failed')
  const historyFailure = new Error('history release failed')
  const lifetime = new AbortController()
  const plugin = createSchedulesPlugin({ createCollector: () => ({ ...collector(), dispose() { throw collectorFailure } }),
    createHistory: () => history }).create({ signal: lifetime.signal, resources: collectionResources, publish() {} })
  const request = assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
  let stopped = false
  const stopping = assert.rejects(Promise.resolve(plugin.stop()).finally(() => { stopped = true }), error => {
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors, [collectorFailure, historyFailure])
    return true
  })
  await request
  assert.equal(history.diagnostics().closed, true)
  assert.equal(stopped, false)
  release.reject(historyFailure)
  await stopping
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
})

test('a synchronous history close failure does not skip asynchronous collector disposal', async () => {
  const release = Promise.withResolvers<void>()
  const failure = new Error('history close failed')
  let disposed = false
  class FailingHistory extends ScheduleHistoryReader {
    override close(): Promise<void> { throw failure }
  }
  const plugin = createSchedulesPlugin({ createCollector: () => ({ ...collector(), async dispose() { await release.promise; disposed = true } }),
    createHistory: () => new FailingHistory({ providers: [] }) }).create({ signal: new AbortController().signal,
    resources: collectionResources, publish() {} })
  let stopped = false
  const stopping = assert.rejects(Promise.resolve(plugin.stop()).finally(() => { stopped = true }), error => error === failure)
  await setImmediate()
  assert.equal(stopped, false)
  release.resolve()
  await stopping
  assert.equal(disposed, true)
})
