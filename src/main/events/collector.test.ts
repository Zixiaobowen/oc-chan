import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { collectionResources } from '../resource-budget'
import { Monitor } from '../monitor'
import { createEventsPlugin } from '../plugins/events'
import { EventCollector, observeSourceEvents, type EventObservation } from './collector'
import type { SourceEventCursor } from './contracts'
import { EventStore } from './store'
import { HermesEventReader } from './hermes'
import type { MonitorSnapshot } from '../../shared/types'

const start = Date.parse('2026-11-05T01:00:00.000Z')
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString()
const observation = (seconds: number, state: EventObservation['state'], id = 'test-source'): EventObservation => ({ id, section: 'schedules', state, observedAt: at(seconds) })

test('one sustained outage and one recovery survive repeated samples and persisted state', () => {
  let state: SourceEventCursor[] = []
  const ids: string[] = []
  const types: string[] = []
  for (let sample = 0; sample < 100; sample++) {
    const result = observeSourceEvents(state, [observation(sample * 30, 'error')], at(sample * 30))
    state = JSON.parse(JSON.stringify(result.sources))
    ids.push(...result.events.map(event => event.id)); types.push(...result.events.map(event => event.type))
  }
  assert.deepEqual(types, ['source-unavailable'])
  const recovered = observeSourceEvents(state, [observation(3000, 'ok')], at(3000))
  assert.deepEqual(recovered.events.map(event => event.type), ['source-recovered'])
  assert.notEqual(recovered.events[0].id, ids[0])
  assert.deepEqual(observeSourceEvents(recovered.sources, [observation(3030, 'ok')], at(3030)).events, [])
})

test('reused snapshots, deliberate disable and sleep do not manufacture outages', () => {
  const first = observeSourceEvents([], [observation(0, 'error')], at(0))
  assert.deepEqual(observeSourceEvents(first.sources, [observation(0, 'error')], at(600)).events, [])
  const resumed = observeSourceEvents(first.sources, [observation(600, 'error')], at(600))
  assert.equal(resumed.gap, true)
  assert.deepEqual(resumed.events, [])
  const disabled = observeSourceEvents(resumed.sources, [observation(630, 'disabled')], at(630))
  assert.deepEqual(disabled.events, [])
  const reenabled = observeSourceEvents(disabled.sources, [observation(660, 'ok')], at(660))
  assert.deepEqual(reenabled.events, [])
})

test('partial evidence neither recovers a known outage nor announces it again', () => {
  let state = observeSourceEvents([], [observation(0, 'error')], at(0)).sources
  state = observeSourceEvents(state, [observation(60, 'error')], at(60)).sources
  const partial = observeSourceEvents(state, [observation(90, 'partial')], at(90))
  assert.deepEqual(partial.events, [])
  assert.deepEqual(observeSourceEvents(partial.sources, [observation(150, 'error')], at(150)).events, [])
  assert.equal(observeSourceEvents(partial.sources, [observation(150, 'ok')], at(150)).events[0].type, 'source-recovered')
})

test('source burst is backpressured without losing deferred transitions or reusing episode ids', () => {
  const rows = (seconds: number) => Array.from({ length: 40 }, (_, index) => observation(seconds, 'error', `source-${index}`))
  let state = observeSourceEvents([], rows(0), at(0)).sources
  const all = []
  for (const second of [60, 90, 120]) {
    const result = observeSourceEvents(state, rows(second), at(second))
    assert(result.events.length <= 16)
    all.push(...result.events)
    state = result.sources
  }
  assert.equal(new Set(all.map(event => event.id)).size, 40)
  const disappeared = observeSourceEvents(state, [], at(150))
  const back = observeSourceEvents(disappeared.sources, [observation(180, 'error', 'source-0')], at(180))
  const newEpisode = observeSourceEvents(back.sources, [observation(240, 'error', 'source-0')], at(240)).events[0]
  assert(!all.some(event => event.id === newEpisode.id))
})

test('real plugin records fresh failures once, preserves baseline, restarts and releases on disable', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-events-collector-'))
  const upstream = path.join(directory, 'upstream.sqlite'), local = path.join(directory, 'events', 'events.sqlite')
  const db = new DatabaseSync(upstream)
  db.exec('CREATE TABLE executions(id TEXT PRIMARY KEY,job_id TEXT,status TEXT,claimed_at TEXT,finished_at TEXT,delivery_outcome TEXT)')
  const insert = db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?)')
  let now = new Date().toISOString()
  insert.run('baseline-failure', 'daily', 'failed', now, now, 'failed')
  const empty = { data: null, error: null, refreshing: false }
  const snapshot: MonitorSnapshot = { agents: empty, system: empty, events: empty,
    schedules: { ...empty, data: { collectedAt: now, sources: [], jobs: [{ id: 'hermes-job:daily', name: 'Do not retain title',
      source: 'Hermes', scope: 'user', origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }] } } }
  const enabled = { agents: true, schedules: true, system: true, events: true }
  const monitor = new Monitor({ plugins: [createEventsPlugin({ databasePath: () => local, hermesDatabasePath: upstream, inputs: () => ({ snapshot, enabled }), clock: () => now })] })
  t.after(async () => { await monitor.stop(); db.close(); await rm(directory, { recursive: true, force: true }) })
  await monitor.refresh('events')
  assert.equal(monitor.state.events.error, null)
  assert.deepEqual((await monitor.readEvents()).entries, [])
  insert.run('new-failure', 'daily', 'failed', now, now, 'delivered')
  insert.run('new-delivery', 'daily', 'completed', now, now, 'failed')
  for (let sample = 0; sample < 5; sample++) await monitor.refresh('events')
  const page = await monitor.readEvents()
  assert.deepEqual(page.entries.map(event => event.type).sort(), ['delivery-failed', 'execution-failed'])
  assert(page.entries.every(event => event.target?.kind === 'schedule' && event.entityId === 'hermes-job:daily'))
  assert(page.entries.every(event => !JSON.stringify(event).includes('Do not retain title')))
  const lock = new DatabaseSync(local)
  lock.exec('BEGIN IMMEDIATE')
  const queryController = new AbortController()
  const query = monitor.readEvents({}, queryController.signal).then(
    () => ({ cancelled: false }),
    error => ({ cancelled: error?.name === 'AbortError' && error?.code === 'ABORT_ERR' })
  )
  try {
    const deadline = Date.now() + 3000
    while (!collectionResources.snapshot().sources.some(source => source.source === 'event-store' && source.current.commands > 0)) {
      assert(Date.now() < deadline, 'the query must enter the actual storage command before cancellation')
      await delay(1)
    }
    queryController.abort()
    assert.deepEqual(await query, { cancelled: true }, 'cancelling a query must abort the real locked SQLite request')
    const resources = collectionResources.snapshot().sources.find(source => source.source === 'event-store')!
    assert(Object.values(resources.current).every(value => value === 0), 'cancelled query must release its process and output budgets')
  } finally {
    queryController.abort()
    await query
    lock.exec('ROLLBACK')
    lock.close()
  }
  assert.deepEqual((await monitor.readEvents()).entries.map(event => event.id), page.entries.map(event => event.id), 'query cancellation must preserve the plugin and stored events')
  await monitor.setPluginEnabled('events', false)
  await assert.rejects(monitor.readEvents(), { name: 'AbortError', code: 'ABORT_ERR' })
  assert.equal(monitor.diagnostics().plugins.pending, 0)
  await monitor.setPluginEnabled('events', true)
  assert.deepEqual((await monitor.readEvents()).entries.map(event => event.id).sort(), page.entries.map(event => event.id).sort())
  insert.run('second-failure', 'daily', 'failed', now, now, 'delivered')
  await monitor.refresh('events')
  assert.equal((await monitor.readEvents()).entries.filter(event => event.type === 'execution-failed').length, 2)
})

test('upstream errors retain cursor and remain visible while store errors fail the section', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-events-errors-'))
  const upstream = path.join(directory, 'upstream.sqlite')
  const db = new DatabaseSync(upstream)
  db.exec('CREATE TABLE executions(id TEXT PRIMARY KEY,job_id TEXT,status TEXT,claimed_at TEXT,finished_at TEXT,delivery_outcome TEXT)')
  const state = { data: null, error: null, refreshing: false }
  const inputs = () => ({ snapshot: { agents: state, schedules: state, system: state, events: state }, enabled: { agents: true, schedules: true, system: true, events: true } })
  const store = new EventStore(path.join(directory, 'local', 'events.sqlite'))
  const collector = new EventCollector(store, new HermesEventReader(upstream), inputs, new AbortController().signal)
  t.after(async () => { await collector.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  await collector.collect(new AbortController().signal)
  const before = (await store.load()).checkpoint!.hermes
  db.exec('DROP TABLE executions')
  const error = await collector.collect(new AbortController().signal)
  assert.equal(error.coverage[0].state, 'unavailable')
  assert.equal(error.sources.find(source => source.id === 'hermes-events')?.state, 'error')
  assert.deepEqual((await store.load()).checkpoint!.hermes, before)
  assert.deepEqual((await collector.query({})).entries, [])
  await store.close()
  await assert.rejects(collector.collect(new AbortController().signal), /closed/i)
})

test('source samples arriving during checkpoint I/O are not treated as future observations', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-events-fresh-source-'))
  const upstream = path.join(directory, 'upstream.sqlite')
  const db = new DatabaseSync(upstream)
  db.exec('CREATE TABLE executions(id TEXT PRIMARY KEY,job_id TEXT,status TEXT,claimed_at TEXT,finished_at TEXT,delivery_outcome TEXT)')
  const empty = { data: null, error: null, refreshing: false }
  const inputs = () => {
    const observed = new Date().toISOString()
    return { snapshot: { agents: empty, schedules: empty, events: empty,
      system: { ...empty, lastAttemptAt: observed, lastSuccessAt: observed } },
    enabled: { agents: true, schedules: true, system: true, events: true } }
  }
  const collector = new EventCollector(new EventStore(path.join(directory, 'local', 'events.sqlite')),
    new HermesEventReader(upstream), inputs, new AbortController().signal)
  t.after(async () => { await collector.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const snapshot = await collector.collect(new AbortController().signal)
  assert.equal(snapshot.coverage.find(item => item.sourceId === 'source-events')?.state, 'observing')
  assert.deepEqual((await collector.query({})).entries, [])
})
