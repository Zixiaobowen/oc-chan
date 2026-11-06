import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { setImmediate } from 'node:timers/promises'
import type { EventCheckpoint, EventCommit } from './contracts'
import type { LocalEvent } from '../../shared/events'
import { collectionResources } from '../resource-budget'
import { EventStore } from './store'

const exec = promisify(execFile)
const now = new Date().toISOString()
const before = (days: number): string => new Date(Date.parse(now) - days * 86400000).toISOString()
const checkpoint = (observedAt = now): EventCheckpoint => ({ version: 1, hermes: null, sources: [], observedAt,
  coverage: [{ sourceId: 'hermes', state: 'observing', since: now, observedAt, code: null }] })
const event = (id: string, observedAt = now): LocalEvent => ({ id, sourceId: 'hermes', entityId: 'daily', type: 'execution-failed',
  occurredAt: observedAt, observedAt, resultCode: 'failed', target: null })
const commit = (revision: number, events: LocalEvent[], state = checkpoint()): EventCommit => ({ revision, events, checkpoint: state, now })
const hermesIdentity = createHash('sha256').update('disk:inode').digest('hex').slice(0, 16)
function hermesCheckpoint(): EventCheckpoint {
  return { ...checkpoint(), hermes: { identity: 'disk:inode', baseline: 0, high: 100000, revisit: 0, floor: 0,
    since: now, lastObservedAt: now, pending: [], pendingIndex: 0 },
    coverage: [{ sourceId: 'hermes-events', state: 'observing', since: now, observedAt: now, code: null }] }
}
function hermesEvent(rowid: number, observedAt = now): LocalEvent {
  return { ...event(`h:${hermesIdentity}:${rowid}:${createHash('sha256').update(String(rowid)).digest('hex').slice(0, 32)}`, observedAt), sourceId: 'hermes-events' }
}

async function fixture(t: TestContext): Promise<{ file: string; store: EventStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-event-store-'))
  const file = path.join(directory, 'private', 'events.sqlite')
  const store = new EventStore(file)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { file, store }
}

async function sql(file: string, source: string, args: string[] = []): Promise<string> {
  const result = await exec(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]); try { ${source} } finally {db.close();}`, file, ...args],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000, maxBuffer: 64 * 1024 })
  return result.stdout
}

// Fixtures populate the real schema through SQLite, avoiding thousands of child starts in retention tests.
async function seed(file: string, count: number, padded = false, hermes = false): Promise<void> {
  await sql(file, `const base=JSON.parse(process.argv[2]);
    db.exec('BEGIN');
    const insert=db.prepare('INSERT INTO events(id,source_id,type,observed_at,payload,payload_bytes) VALUES(?,?,?,?,?,?)');
    for(let i=0;i<Number(process.argv[3]);i++) {
      const value={...base,id:'seed-'+String(i).padStart(5,'0')};
      if(process.argv[5]) value.id='h:'+process.argv[5]+':'+(i+1)+':'+require('node:crypto').createHash('sha256').update(String(i+1)).digest('hex').slice(0,32);
      if(process.argv[4]==='yes') value.target={kind:'schedule',id:'daily',identity:'x'.repeat(1400)};
      const payload=JSON.stringify(value);
      insert.run(value.id,value.sourceId,value.type,value.observedAt,payload,Buffer.byteLength(payload));
    }
    db.exec('COMMIT');`, [JSON.stringify(hermes ? hermesEvent(1) : event('seed')), String(count), padded ? 'yes' : 'no', hermes ? hermesIdentity : ''])
}

async function lock(file: string): Promise<() => Promise<void>> {
  const ready = Promise.withResolvers<void>(), done = Promise.withResolvers<void>()
  const child = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('ready');
    process.stdin.resume();process.stdin.on('end',()=>{db.exec('ROLLBACK');db.close();});`, file],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.once('data', () => ready.resolve())
  child.stderr.resume()
  child.once('error', error => { ready.reject(error); done.reject(error) })
  child.once('close', code => {
    if (code === 0) done.resolve()
    else done.reject(new Error(`Lock helper exited: ${code}`))
    ready.reject(new Error('Lock helper closed before readiness'))
  })
  await ready.promise
  return async () => { child.stdin.end(); await done.promise }
}

function resourcesIdle(): void {
  const source = collectionResources.snapshot().sources.find(entry => entry.source === 'event-store')
  if (source) assert.equal(Object.values(source.current).every(value => value === 0), true)
}

test('100 duplicate samples persist once; distinct executions and event types remain distinct', async t => {
  const { file, store } = await fixture(t)
  assert.deepEqual(await store.load(), { revision: 0, checkpoint: null, retention: {
    count: 0, newestSequence: 0, oldestObservedAt: null, deletedCount: 0, deletedThrough: null, reason: null, diskBytes: (await stat(file)).size,
  } })
  let databaseIdentity: string | undefined
  for (let sample = 0; sample < 100; sample++) {
    const saved = await store.commit(commit(sample, [event('execution-1:failed')]))
    if (sample === 0) databaseIdentity = saved.identity
    assert.equal(saved.identity, databaseIdentity)
    assert.deepEqual(saved.added, sample === 0 ? [{ sequence: 1, index: 0 }] : [], 'duplicate samples cannot re-enter notification delivery')
  }
  assert.deepEqual((await store.commit(commit(100, Array.from({ length: 100 }, () => event('execution-1:failed'))))).added, [])
  const state = checkpoint()
  state.hermes = { identity: 'disk:inode', baseline: 10, high: 12, revisit: 10, floor: 0, since: now, lastObservedAt: now,
    pending: [{ rowid: 12, id: 'execution-2', status: 'failed', delivery: null }], pendingIndex: 0 }
  const inserted = await store.commit(commit(101, [event('execution-1:failed'), event('execution-2:failed'),
    { ...event('execution-2:delivery'), type: 'delivery-failed' }], state))
  assert.deepEqual(inserted.added, [{ sequence: 2, index: 1 }, { sequence: 3, index: 2 }])
  const page = await store.query()
  assert.deepEqual(page.entries.map(row => row.id), ['execution-2:delivery', 'execution-2:failed', 'execution-1:failed'])
  assert.equal(page.retention.count, 3)
  const newestSequence = page.retention.newestSequence
  await store.commit(commit(102, [event('execution-1:failed')], state))
  const duplicate = await store.query()
  assert.equal(duplicate.retention.newestSequence, newestSequence, 'duplicate sampling must not announce new events')
  assert(duplicate.retention.newestSequence <= page.upper)
  assert.deepEqual(page.coverage, state.coverage)
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await store.close()
  const restarted = new EventStore(file)
  t.after(() => restarted.close())
  const loaded = await restarted.load()
  assert.equal(loaded.revision, 103)
  assert.deepEqual(loaded.checkpoint, state)
  assert.equal((await restarted.query()).entries.length, 3)
  const afterRestart = await restarted.commit(commit(103, [event('execution-2:failed'), event('execution-3:failed')], loaded.checkpoint!))
  assert.equal(afterRestart.identity, databaseIdentity)
  assert.deepEqual(afterRestart.added, [{ sequence: 4, index: 1 }])
})

test('checkpoint and events roll back together on stale revision and SQLite write failure', async t => {
  const { file, store } = await fixture(t)
  await store.commit(commit(0, [event('accepted')]))
  const updated = checkpoint(new Date(Date.parse(now) + 1000).toISOString())
  await assert.rejects(store.commit(commit(0, [event('stale')], updated)), { code: 'EVENT_STORE_STALE' })
  // A genuine constraint failure after the checkpoint/event transaction begins.
  await sql(file, `db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'private sql detail'); END;")`)
  await assert.rejects(store.commit(commit(1, [event('blocked')], updated)), error => {
    assert(error instanceof Error)
    assert.doesNotMatch(error.message, /private sql detail/)
    return true
  })
  await sql(file, 'db.exec("DROP TRIGGER reject_event")')
  const state = await store.load()
  assert.equal(state.revision, 1)
  assert.deepEqual(state.checkpoint, checkpoint())
  assert.deepEqual((await store.query()).entries.map(row => row.id), ['accepted'])
})

test('descending keyset pages remain stable across insertion and support all metadata filters', async t => {
  const { store } = await fixture(t)
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...event(`row-${i}`),
    sourceId: i % 2 ? 'hermes' : 'sources', type: i % 2 ? 'execution-failed' as const : 'source-unavailable' as const }))
  await store.commit(commit(0, rows))
  const first = await store.query()
  assert.equal(first.entries.length, 50)
  assert.notEqual(first.next, null)
  await store.commit(commit(1, [event('new-arrival')]))
  const second = await store.query({ before: first.next!, upper: first.upper })
  assert.equal(second.entries.length, 50)
  assert.equal(second.next, null)
  assert.equal(second.upper, first.upper)
  assert(second.retention.newestSequence > first.upper, 'a new event is visible without changing the current page')
  const ids = [...first.entries, ...second.entries].map(row => row.id)
  assert.equal(new Set(ids).size, 100)
  assert(!ids.includes('new-arrival'))
  assert.equal((await store.query()).entries[0].id, 'new-arrival')
  const filtered = await store.query({ sourceId: 'sources', type: 'source-unavailable', from: now, to: now })
  assert.equal(filtered.entries.length, 50)
  assert.equal(filtered.next, null)
  assert(filtered.entries.every(row => row.sourceId === 'sources' && row.type === 'source-unavailable'))
  assert.deepEqual((await store.query({ upper: 0 })).entries, [])
  await assert.rejects(store.query({ from: now, to: before(1) }), /Invalid event time range/)
  assert.deepEqual((await store.query({ sourceId: "hermes' OR 1=1 --" })).entries, [])
})

test('10000-record retention and seven-day age retention are independent and durable', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  await seed(file, 10000)
  const count = await store.commit(commit(0, Array.from({ length: 100 }, (_, i) => event(`added-${i}`))))
  assert.equal(count.retention.count, 10000)
  assert.equal(count.retention.deletedCount, 100)
  assert.equal(count.retention.deletedThrough, now)
  assert.equal(count.retention.reason, 'count')
  assert(count.retention.diskBytes <= 20 * 1024 * 1024)
  await store.commit(commit(1, [event('already-expired', before(8))]))
  const age = await store.commit({ ...commit(2, []), now: new Date(Date.parse(now) + 8 * 86400000).toISOString() })
  assert.equal(age.retention.count, 0)
  assert.equal(age.retention.deletedCount, 10101)
  assert.equal(age.retention.reason, 'age')
  assert.equal(age.retention.oldestObservedAt, null)
  assert.equal((await store.load()).retention.deletedCount, 10101)
})

test('payload retention prunes deterministically before the database reaches its physical cap', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  await seed(file, 1800, true)
  let revision = 0
  let retention = (await store.load()).retention
  for (let batch = 0; batch < 6; batch++) {
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...event(`large-${batch}-${i}`),
      target: { kind: 'schedule' as const, id: 'daily', identity: 'x'.repeat(1400) } }))
    const result = await store.commit(commit(revision++, rows))
    retention = result.retention
  }
  assert.equal(retention.reason, 'bytes')
  assert(retention.deletedCount > 0)
  assert(retention.count < 2400)
  assert(retention.diskBytes <= 20 * 1024 * 1024)
  const details = JSON.parse(await sql(file, `process.stdout.write(JSON.stringify({
    pageSize:db.prepare('PRAGMA page_size').get().page_size,
    pages:db.prepare('PRAGMA page_count').get().page_count,
    journal:db.prepare('PRAGMA journal_mode').get().journal_mode,
    bytes:db.prepare('SELECT sum(payload_bytes) AS bytes FROM events').get().bytes}));`))
  assert.equal(details.pageSize, 4096)
  assert(details.pages <= 2048)
  assert.equal(details.journal, 'delete')
  assert(details.bytes <= 3 * 1024 * 1024)
})

test('oversize records, batches, checkpoints and private extra fields reject before any SQL', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  const original = await readFile(file)
  await assert.rejects(store.commit(commit(0, Array.from({ length: 101 }, (_, i) => event(String(i))))), { code: 'EVENT_STORE_INVALID' })
  const tooLarge = { ...event('x'.repeat(512)), target: { kind: 'schedule' as const, id: 'daily', identity: 'x'.repeat(1536) } }
  await assert.rejects(store.commit(commit(0, [tooLarge])), { code: 'EVENT_STORE_LIMIT' })
  const privateEvent = { ...event('private'), output: 'private body' }
  await assert.rejects(store.commit(commit(0, [privateEvent])), { code: 'EVENT_STORE_INVALID' })
  const big = checkpoint()
  big.hermes = { identity: 'x', baseline: 0, high: 0, revisit: 0, floor: 0, since: now, lastObservedAt: now, pendingIndex: 0,
    pending: Array.from({ length: 129 }, (_, i) => ({ rowid: i, id: String(i), status: 'failed', delivery: null })) }
  await assert.rejects(store.commit(commit(0, [], big)), { code: 'EVENT_STORE_INVALID' })
  const oversized = checkpoint()
  // Lone UTF-16 surrogates expand into six-byte JSON escapes, unlike ordinary UTF-8 text.
  const escaped = '\ud800'
  oversized.hermes = { identity: escaped.repeat(512), baseline: 0, high: 0, revisit: 0, floor: 0, since: now, lastObservedAt: now, pendingIndex: 0,
    pending: Array.from({ length: 128 }, (_, i) => ({ rowid: i, id: escaped.repeat(128), status: escaped.repeat(32), delivery: escaped.repeat(32) })) }
  oversized.sources = Array.from({ length: 64 }, () => ({ id: escaped.repeat(128), section: 'schedules', state: 'error', observedAt: now,
    unavailableSince: now, announced: true, generation: 1 }))
  // All individual fields fit their bounds; aggregate UTF-8 bytes must still be checked.
  assert(Buffer.byteLength(JSON.stringify(oversized)) > 128 * 1024)
  await assert.rejects(store.commit(commit(0, [], oversized)), { code: 'EVENT_STORE_LIMIT' })
  assert.deepEqual(await readFile(file), original)
})

test('corrupt, oversize, symlink, unsafe-permission and unknown-sidecar files are preserved', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  const valid = await readFile(file)
  await writeFile(file, 'private corrupt contents', { mode: 0o600 })
  await assert.rejects(store.load(), { code: 'EVENT_STORE_CORRUPT' })
  assert.equal(await readFile(file, 'utf8'), 'private corrupt contents')
  await writeFile(file, valid)
  await chmod(file, 0o644)
  await assert.rejects(store.load(), { code: 'EVENT_STORE_PERMISSION' })
  await chmod(file, 0o600)
  const alias = path.join(path.dirname(file), 'alias.sqlite')
  await symlink(file, alias)
  const linked = new EventStore(alias)
  t.after(() => linked.close())
  await assert.rejects(linked.load(), { code: 'EVENT_STORE_PERMISSION' })
  await writeFile(file + '-wal', 'unknown private sidecar', { mode: 0o600 })
  await assert.rejects(store.load(), { code: 'EVENT_STORE_SIDECAR' })
  assert.equal(await readFile(file + '-wal', 'utf8'), 'unknown private sidecar')
  await rm(file + '-wal')
  await writeFile(file + '-journal', 'unknown journal', { mode: 0o600 })
  await assert.rejects(store.load(), { code: 'EVENT_STORE_SIDECAR' })
  assert.equal(await readFile(file + '-journal', 'utf8'), 'unknown journal')
  await rm(file + '-journal')
  const handle = await open(file, 'r+')
  await handle.truncate(8 * 1024 * 1024 + 1)
  await handle.close()
  await assert.rejects(store.load(), { code: 'EVENT_STORE_LIMIT' })
  assert.equal((await stat(file)).size, 8 * 1024 * 1024 + 1)
})

test('locked database rejects within the finite deadline and succeeds after release', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  const release = await lock(file)
  try {
    const started = performance.now()
    await assert.rejects(store.commit(commit(0, [event('locked')])), { code: 'EVENT_STORE_LOCKED' })
    assert(performance.now() - started < 3000)
  } finally { await release() }
  assert.equal((await store.load()).revision, 0)
  assert.equal((await store.commit(commit(0, [event('released')]))).revision, 1)
})

test('queue is capped at sixteen; cancellation removes waiting requests and close drains real children', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  const release = await lock(file)
  try {
    const requests = Array.from({ length: 16 }, () => assert.rejects(store.load(), { name: 'AbortError' }))
    await assert.rejects(store.query(), { code: 'EVENT_STORE_QUEUE' })
    const closing = store.close()
    assert.equal(store.close(), closing)
    await Promise.all([...requests, closing])
    resourcesIdle()
    await assert.rejects(store.load(), { code: 'EVENT_STORE_CLOSED' })
  } finally { await release() }
  const restarted = new EventStore(file)
  t.after(() => restarted.close())
  assert.equal((await restarted.load()).revision, 0)
  const controller = new AbortController()
  const active = restarted.load()
  const queued = assert.rejects(restarted.query({}, controller.signal), { name: 'AbortError' })
  controller.abort()
  await queued
  await active
  await setImmediate()
  resourcesIdle()
})

test('close also aborts admission waits without waiting for unrelated resource owners', async t => {
  const { store } = await fixture(t)
  const held = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  let count = 0
  const blockers = Array.from({ length: 8 }, () => collectionResources.run({ source: 'event-store-test-blocker', kind: 'command', stdoutBytes: 1, stderrBytes: 1 }, () => {
    if (++count === 8) ready.resolve()
    return held.promise
  }))
  try {
    await ready.promise
    const request = assert.rejects(store.load(), { name: 'AbortError' })
    await Promise.all([request, store.close()])
    resourcesIdle()
    assert.equal(collectionResources.snapshot().global.current.commands, 8)
  } finally {
    held.resolve()
    await Promise.all(blockers)
  }
})

test('count-pruned Hermes IDs survive restart; age expiry advances a durable floor before source rewrites', async t => {
  const { file, store } = await fixture(t)
  await store.commit(commit(0, [], hermesCheckpoint()))
  await seed(file, 10000, false, true)
  const first = await store.commit(commit(1, [hermesEvent(10001)], hermesCheckpoint()))
  await store.close()
  const restarted = new EventStore(file)
  t.after(() => restarted.close())
  const tomorrow = new Date(Date.parse(now) + 86400000).toISOString()
  const replayed = await restarted.commit({ ...commit(2, [hermesEvent(1, tomorrow)], first.checkpoint), now: tomorrow })
  assert.equal(replayed.retention.count, 10000)
  assert.equal(replayed.retention.deletedCount, 1)
  assert.equal(await sql(file, "process.stdout.write(new Date(db.prepare('SELECT observed_at FROM event_tombstones').get().observed_at).toISOString())"), now)
  const later = new Date(Date.parse(now) + 8 * 86400000).toISOString()
  const expired = await restarted.commit({ ...commit(3, [], replayed.checkpoint), now: later })
  assert.equal(expired.retention.count, 0)
  assert.equal(expired.checkpoint.hermes?.floor, 10001)
  assert.equal(expired.checkpoint.coverage[0].code, 'hermes-dedup-capacity-gap')
  assert.equal(await sql(file, "process.stdout.write(String(db.prepare('SELECT count(*) AS n FROM event_tombstones').get().n))"), '0')
  const rewritten = { ...hermesEvent(1, later), occurredAt: later, resultCode: 'rewritten' }
  const result = await restarted.commit({ ...commit(4, [rewritten], expired.checkpoint), now: later })
  assert.equal(result.retention.count, 0)
  assert.equal((await restarted.load()).checkpoint?.hermes?.floor, 10001)
})

test('tombstone capacity advances the floor atomically, filters pending rows, and keeps collecting', async t => {
  const { file, store } = await fixture(t)
  const state = hermesCheckpoint()
  state.hermes!.pending = [{ rowid: 1, id: 'old-running', status: 'running', delivery: null }]
  await store.commit(commit(0, [], state))
  await seed(file, 10000, false, true)
  await sql(file, `const {createHash}=require('node:crypto');
    db.exec('BEGIN');
    const insert=db.prepare('INSERT INTO event_tombstones VALUES(?,?,?,?)');
    for(let i=10001;i<=42768;i++) insert.run(createHash('sha256').update('old-'+i).digest(),Buffer.from(process.argv[3],'hex'),i,Date.parse(process.argv[2]));
    db.exec('COMMIT');`, [now, hermesIdentity])
  const first = await store.commit(commit(1, [hermesEvent(50000)], state))
  assert.equal(first.retention.count, 10000)
  assert.equal(first.checkpoint.hermes?.floor, 1)
  assert.deepEqual(first.checkpoint.hermes?.pending, [])
  assert.equal(first.checkpoint.coverage[0].state, 'gap')
  assert.equal(first.checkpoint.coverage[0].lastGap?.count, 1)
  assert.equal(await sql(file, "process.stdout.write(String(db.prepare('SELECT count(*) AS n FROM event_tombstones').get().n))"), '32768')
  // Source metadata and type can change after pruning; row floor still prevents replay.
  const rewritten = { ...hermesEvent(1), id: `h:${hermesIdentity}:1:${'f'.repeat(32)}`, type: 'delivery-failed' as const }
  const next = await store.commit(commit(2, [rewritten, hermesEvent(50001)], first.checkpoint))
  assert.equal(next.retention.count, 10000)
  assert.equal((await store.query()).entries[0].id, hermesEvent(50001).id)
  assert(next.retention.diskBytes <= 20 * 1024 * 1024)
})

test('a genuinely full SQLite file reports a safe error and leaves checkpoint/events atomic', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  await sql(file, `db.exec('PRAGMA max_page_count=2048; CREATE TABLE padding(data BLOB)');
    const insert=db.prepare('INSERT INTO padding VALUES(zeroblob(4096))');
    db.exec('BEGIN');
    for(let i=0;i<1700;i++) insert.run();
    db.exec('COMMIT');
    try { for(let i=0;i<348;i++) insert.run(); }
    catch(error) { if((error.errcode & 255)!==13) throw error; }`)
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...event('full-'+i),
    target: { kind: 'schedule' as const, id: 'daily', identity: 'x'.repeat(1400) } }))
  await assert.rejects(store.commit(commit(0, rows)), { code: 'EVENT_STORE_FULL' })
  assert.equal(await sql(file, "process.stdout.write(String(db.prepare('SELECT revision FROM event_state').get().revision))"), '0')
  assert.equal(await sql(file, "process.stdout.write(String(db.prepare('SELECT count(*) AS n FROM events').get().n))"), '0')
})

test('query-time age pruning persists its floor and revision before a stale writer can overwrite it', async t => {
  const { file, store } = await fixture(t)
  const state = hermesCheckpoint()
  state.hermes!.pending = [{ rowid: 10, id: 'running', status: 'running', delivery: null }]
  await store.commit(commit(0, [], state))
  await sql(file, `db.prepare('INSERT INTO event_tombstones VALUES(?,?,?,?)').run(
    require('node:crypto').createHash('sha256').update('expired').digest(),Buffer.from(process.argv[2],'hex'),10,Date.parse(process.argv[3]));`,
  [hermesIdentity, before(8)])
  const page = await store.query()
  assert.equal(page.revision, 2)
  assert.equal(page.coverage[0].code, 'hermes-dedup-capacity-gap')
  await assert.rejects(store.commit(commit(1, [hermesEvent(10)], state)), { code: 'EVENT_STORE_STALE' })
  const loaded = await store.load()
  assert.equal(loaded.checkpoint?.hermes?.floor, 10)
  assert.equal(loaded.checkpoint?.hermes?.revisit, 10)
  assert.deepEqual(loaded.checkpoint?.hermes?.pending, [])
  assert(loaded.checkpoint!.hermes!.floor <= loaded.checkpoint!.hermes!.high)
  const resumed = await store.commit(commit(2, [hermesEvent(10), hermesEvent(11)], loaded.checkpoint!))
  assert.equal(resumed.retention.count, 1)
})

test('pending event records share a 100-record budget that is released before completion returns', async t => {
  const { file, store } = await fixture(t)
  await store.load()
  const release = await lock(file)
  const first = store.commit(commit(0, Array.from({ length: 100 }, (_, index) => event(`first-${index}`))))
  try {
    await assert.rejects(store.commit(commit(1, [event('overflow')])), { code: 'EVENT_STORE_QUEUE' })
  } finally { await release() }
  await first
  const next = await store.commit(commit(1, Array.from({ length: 100 }, (_, index) => event(`next-${index}`))))
  assert.equal(next.retention.count, 200)
  assert.equal((await store.query({ sourceId: 'hermes' })).entries.some(row => row.id === 'overflow'), false)
})
