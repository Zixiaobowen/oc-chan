import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { setImmediate } from 'node:timers/promises'
import { HISTORY_PAGE_SIZE, type ScheduledJob } from '../../shared/types'
import { ScheduleHistoryReader } from '../schedule-history'
import { HermesHistoryProvider } from './hermes-history'
import { collectionResources } from '../resource-budget'
import { createSchedulesPlugin } from '../plugins/schedules'

const exec = promisify(execFile)
const job: ScheduledJob = { id: 'hermes-job:daily', name: 'Daily', source: 'Hermes', scope: 'user',
  origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }

async function sql(file: string, statement: string): Promise<void> {
  await exec(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]); try { db.exec(process.argv[2]); } finally { db.close(); }`, file, statement],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000, maxBuffer: 64 * 1024 })
}

async function database(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-history-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'executions.db')
  await sql(file, `CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER,
    process_started_at INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT,
    error TEXT, handoff_pending INTEGER, handoff_started_at TEXT, delivery_outcome TEXT,
    scheduled_instant TEXT, progress_at TEXT);
    CREATE INDEX by_job ON executions(job_id);`)
  return file
}

test('SQLite pages use real instants across offsets, sub-milliseconds and stable ID ties', async t => {
  const file = await database(t)
  await sql(file, `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<24)
    INSERT INTO executions(id,job_id,status,claimed_at)
    SELECT printf('older-%02d',x),'daily','completed','2026-11-01T00:00:00Z' FROM n;
    INSERT INTO executions(id,job_id,status,claimed_at) VALUES
    ('newest','daily','completed','2026-11-04T09:00:00Z'),
    ('timezone','daily','completed','2026-11-04T16:00:00+08:00'),
    ('z','daily','completed','2026-11-04T08:00:00Z'),
    ('a','daily','completed','2026-11-04T01:00:00-07:00'),
    ('micro-a','daily','completed','2026-11-04T09:00:00.000002Z'),
    ('micro-z','daily','completed','2026-11-04T09:00:00.000001Z');`)
  const before = await readFile(file)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  const first = await reader.read(job)
  const second = await reader.read(job, first.limit)
  assert.equal(first.limit, HISTORY_PAGE_SIZE)
  assert.equal(first.entries.length, 25)
  assert.equal(first.hasMore, true)
  assert.equal(second.offset, 25)
  assert.equal(second.entries.length, 6)
  assert.equal(second.hasMore, false)
  assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.id),
    ['micro-a', 'micro-z', 'newest', 'z', 'timezone', 'a',
      ...Array.from({ length: 25 }, (_, index) => `older-${String(24 - index).padStart(2, '0')}`)])
  assert.deepEqual(await readFile(file), before)
})

test('execution and delivery outcomes remain separate, with absent starts never inferred from process birth', async t => {
  const file = await database(t)
  await sql(file, `INSERT INTO executions(id,job_id,status,claimed_at,started_at,finished_at,delivery_outcome,process_started_at) VALUES
    ('1','daily','completed','2026-11-04T08:00:00Z','2026-11-04T08:00:01Z','2026-11-04T08:01:00Z','delivered',123),
    ('2','daily','completed','2026-11-04T08:00:00Z',NULL,NULL,'failed',123),
    ('3','daily','failed','2026-11-04T08:00:00Z',NULL,NULL,'suppressed',123),
    ('4','daily','completed','2026-11-04T08:00:00Z',NULL,NULL,'suppressed_acked',123),
    ('5','daily','future_status','2026-11-04T08:00:00Z',NULL,NULL,'future_delivery',123),
    ('6','daily','claimed','2026-11-04T08:00:00Z',NULL,NULL,NULL,123),
    ('7','daily','running','2026-11-04T08:00:00Z','2026-11-04T08:00:01Z',NULL,NULL,123);`)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  const entries = new Map((await reader.read(job)).entries.map(entry => [entry.id, entry]))
  assert.deepEqual(entries.get('1'), { id: '1', status: 'succeeded', delivery: 'delivered',
    claimedAt: '2026-11-04T08:00:00Z', startedAt: '2026-11-04T08:00:01Z', finishedAt: '2026-11-04T08:01:00Z' })
  assert.equal(entries.get('2')?.status, 'succeeded')
  assert.equal(entries.get('2')?.delivery, 'failed')
  assert.equal(entries.get('2')?.startedAt, undefined)
  assert.equal(entries.get('3')?.status, 'failed')
  assert.equal(entries.get('3')?.delivery, 'skipped')
  assert.equal(entries.get('4')?.delivery, 'skipped')
  assert.equal(entries.get('5')?.status, 'unknown')
  assert.equal(entries.get('5')?.delivery, 'unknown')
  assert.equal(entries.get('6')?.status, 'claimed')
  assert.equal(entries.get('6')?.delivery, undefined)
  assert.equal(entries.get('7')?.status, 'running')
})

test('only the bound task is read; long private bodies never appear in output', async t => {
  const file = await database(t)
  await sql(file, `INSERT INTO executions(id,job_id,status,claimed_at,error) VALUES
    ('own','daily','completed','2026-11-04T08:00:00Z','private-body-' || hex(zeroblob(1048576))),
    ('foreign','other','broken','invalid','private-other-body');`)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  const result = await reader.read(job)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].id, 'own')
  assert.doesNotMatch(JSON.stringify(result), /private|foreign|error/)
  const injected = await reader.read({ ...job, id: "hermes-job:daily'); DROP TABLE executions; --" })
  assert.deepEqual(injected.entries, [])
  assert.equal((await reader.read(job)).entries.length, 1)
})

test('missing, damaged and incompatible databases reject; an empty real history succeeds', async t => {
  const file = await database(t)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  assert.deepEqual((await reader.read(job)).entries, [])
  const missing = path.join(path.dirname(file), 'missing.db')
  await assert.rejects(new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(missing)] }).read(job), /Cannot open history database/)
  await assert.rejects(stat(missing), { code: 'ENOENT' })
  await sql(file, 'DROP TABLE executions; CREATE TABLE executions (id TEXT);')
  await assert.rejects(reader.read(job), /Invalid history database or metadata/)
  await writeFile(file, 'private damaged database')
  await assert.rejects(reader.read(job), error => {
    assert(error instanceof Error)
    assert.match(error.message, /Invalid history database or metadata/)
    assert.doesNotMatch(error.message, /private damaged/)
    return true
  })
})

test('overlong metadata is rejected instead of silently truncating fields', async t => {
  const file = await database(t)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  for (const column of ['id', 'status', 'claimed_at', 'started_at', 'finished_at', 'delivery_outcome']) {
    await sql(file, `DELETE FROM executions;
      INSERT INTO executions(id,job_id,status,claimed_at) VALUES ('own','daily','completed','2026-11-04T08:00:00Z');
      UPDATE executions SET ${column}=hex(zeroblob(524288));`)
    await assert.rejects(reader.read(job), /Invalid history database or metadata|History memory budget exceeded/)
  }
  await sql(file, `DELETE FROM executions;
    INSERT INTO executions(id,job_id,status,claimed_at) VALUES ('own' || char(0) || 'hidden','daily','completed','2026-11-04T08:00:00Z');`)
  await assert.rejects(reader.read(job), /Invalid history database or metadata/)
  await assert.rejects(reader.read({ ...job, id: `hermes-job:${'a'.repeat(129)}` }), /Invalid Hermes job identifier/)
})

test('invalid calendar values, timezone-free timestamps and reversed time sequences are rejected', async t => {
  const file = await database(t)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  for (const [claimed, started, finished] of [
    ['2026-02-30T08:00:00Z', null, null],
    ['2026-11-04T08:00:00', null, null],
    ['2026-11-04T08:00:00+25:00', null, null],
    ['2026-11-04T08:00:00Z', '2026-11-04T07:59:59Z', null],
    ['2026-11-04T08:00:00Z', null, '2026-11-04T07:59:59Z'],
    ['2026-11-04T08:00:00Z', '2026-11-04T08:01:00Z', '2026-11-04T08:00:59Z'],
    ['2026-11-04T08:00:00Z', null, 'invalid']
  ]) {
    await sql(file, `DELETE FROM executions; INSERT INTO executions(id,job_id,status,claimed_at,started_at,finished_at)
      VALUES ('own','daily','completed','${claimed}',${started === null ? 'NULL' : `'${started}'`},${finished === null ? 'NULL' : `'${finished}'`});`)
    await assert.rejects(reader.read(job), /Invalid history database or metadata/)
  }
})

test('provider cancellation kills its child, settles after close, and permits immediate reuse', async t => {
  const file = await database(t)
  await sql(file, `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1999)
    INSERT INTO executions(id,job_id,status,claimed_at)
    SELECT printf('cancel-%04d',x),'daily','completed','2026-11-01T00:00:00Z' FROM n;`)
  const provider = new HermesHistoryProvider(file)
  const controller = new AbortController()
  const pending = assert.rejects(provider.read(job, 0, controller.signal), { name: 'AbortError' })
  await setImmediate()
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'hermes-history')?.current.commands, 1,
    '取消前真实 SQLite 读取命令已取得资源槽并启动')
  controller.abort()
  await pending
  await assert.rejects(provider.read(job, 0, controller.signal), { name: 'AbortError' })
  assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  assert.equal((await provider.read(job, 0, new AbortController().signal)).entries.length, HISTORY_PAGE_SIZE)
})

test('history cancelled while waiting for shared commands settles before admission and permits reuse', async t => {
  const file = await database(t)
  const provider = new HermesHistoryProvider(file)
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const { promise: ready, resolve: admitted } = Promise.withResolvers<void>()
  let active = 0
  const blockers = Array.from({ length: 8 }, () => collectionResources.run({
    source: 'history-test-blockers', kind: 'command', stdoutBytes: 1, stderrBytes: 1
  }, () => {
    if (++active === 8) admitted()
    return held
  }))
  try {
    await ready
    const controller = new AbortController()
    const cancelled = assert.rejects(provider.read(job, 0, controller.signal), { name: 'AbortError', code: 'ABORT_ERR' })
    controller.abort()
    await cancelled
  } finally {
    release()
    await Promise.all(blockers)
  }
  assert.deepEqual((await provider.read(job, 0, new AbortController().signal)).entries, [])
})

test('reader close drains a queued SQLite request without waiting for unrelated command owners', async t => {
  const file = await database(t)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  const held = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  let active = 0
  const blockers = Array.from({ length: 8 }, () => collectionResources.run({
    source: 'history-test-blockers', kind: 'command', stdoutBytes: 1, stderrBytes: 1,
  }, () => {
    if (++active === 8) ready.resolve()
    return held.promise
  }))
  try {
    await ready.promise
    const request = assert.rejects(reader.read(job), { name: 'AbortError' })
    assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'hermes-history')?.current.queued, 1)
    const closing = reader.close()
    assert.equal(reader.close(), closing)
    await Promise.all([request, closing])
    assert.deepEqual(reader.diagnostics(), { closed: true, active: false, pending: false, phase: 'closed' })
    const resources = collectionResources.snapshot()
    assert.equal(resources.global.current.commands, 8, '关闭只等自身请求，不能阻塞在其它来源')
    assert.equal(resources.global.current.queued, 0)
    const history = resources.sources.find(source => source.source === 'hermes-history')!
    assert.equal(Object.values(history.current).every(value => value === 0), true)
    await reader.idle()
    await assert.rejects(reader.read(job), /History reader closed/)
  } finally {
    held.resolve()
    await Promise.all(blockers)
    await reader.close()
  }
  assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
})

test('reader close waits for a real SQLite helper to close and release its command budget', async t => {
  const file = await database(t)
  await sql(file, `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1999)
    INSERT INTO executions(id,job_id,status,claimed_at)
    SELECT printf('drain-%04d',x),'daily','completed','2026-11-01T00:00:00Z' FROM n;`)
  const reader = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  const request = assert.rejects(reader.read(job), { name: 'AbortError' })
  await setImmediate()
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'hermes-history')?.current.commands, 1)
  const closing = reader.close()
  assert.equal(reader.close(), closing)
  assert.equal(reader.diagnostics().active, true, '请求取消后仍保留真实在途 provider')
  await Promise.all([request, closing, reader.idle()])
  assert.deepEqual(reader.diagnostics(), { closed: true, active: false, pending: false, phase: 'closed' })
  assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  await assert.rejects(reader.read(job), /History reader closed/)
  const replacement = new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] })
  try { assert.equal((await replacement.read(job)).entries.length, HISTORY_PAGE_SIZE) }
  finally { await replacement.close() }
})

test('schedule plugin cancellation drains an actual SQLite helper before a replacement reads', async t => {
  const file = await database(t)
  await sql(file, `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1999)
    INSERT INTO executions(id,job_id,status,claimed_at)
    SELECT printf('plugin-%04d',x),'daily','completed','2026-11-01T00:00:00Z' FROM n;`)
  const definition = createSchedulesPlugin({ createHistory: () => new ScheduleHistoryReader({ providers: [new HermesHistoryProvider(file)] }) })
  const lifetime = new AbortController()
  const plugin = definition.create({ signal: lifetime.signal, resources: collectionResources, publish() {} })
  t.after(() => plugin.stop())
  const request = assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
  await setImmediate()
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'hermes-history')?.current.commands, 1)
  lifetime.abort()
  await Promise.all([request, plugin.stop()])
  assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  await assert.rejects(plugin.history!.read(job), { name: 'AbortError' })
  const replacement = definition.create({ signal: new AbortController().signal, resources: collectionResources, publish() {} })
  try { assert.equal((await replacement.history!.read(job)).entries.length, HISTORY_PAGE_SIZE) }
  finally { await replacement.stop() }
})
