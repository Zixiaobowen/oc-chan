import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'
import { collectionResources } from '../resource-budget'
import type { HermesEventCursor } from './contracts'
import { HermesEventReader } from './hermes'

const exec = promisify(execFile)
const now = '2026-11-05T10:00:00.000Z'
const signal = (): AbortSignal => new AbortController().signal

async function sql(file: string, statement: string): Promise<void> {
  await exec(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]); try { db.exec(process.argv[2]); } finally { db.close(); }`, file, statement],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000, maxBuffer: 64 * 1024 })
}

async function database(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-events-hermes-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'executions.db')
  // Same real Hermes schema as collectors/hermes-history.test.ts.
  await sql(file, `CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER,
    process_started_at INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT,
    error TEXT, handoff_pending INTEGER, handoff_started_at TEXT, delivery_outcome TEXT,
    scheduled_instant TEXT, progress_at TEXT);
    CREATE INDEX by_job ON executions(job_id);`)
  return file
}

function insert(id: string, status = 'completed', delivery: string | null = 'delivered', claimed = '2026-11-05T09:00:00Z'): string {
  return `INSERT INTO executions(id,job_id,status,claimed_at,delivery_outcome)
    VALUES ('${id}','daily','${status}','${claimed}',${delivery === null ? 'NULL' : `'${delivery}'`});`
}

test('first read baselines failures without historical alerts and preserves database bytes', async t => {
  const file = await database(t)
  await sql(file, insert('old-failure', 'failed', 'failed') + insert('old-success'))
  const before = await readFile(file)
  const result = await new HermesEventReader(file).read(null, now, signal())
  assert.deepEqual(result.rows, [])
  assert.equal(result.cursor.baseline, 2)
  assert.equal(result.cursor.high, 2)
  assert.equal(result.cursor.since, now)
  assert.deepEqual(result.cursor.pending, [])
  assert.equal(result.coverage.state, 'baseline')
  assert.deepEqual(await readFile(file), before)
})

test('rowid catches new older and tied timestamps, without reading private execution bodies', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('baseline'))
  const baseline = await reader.read(null, now, signal())
  await sql(file, insert('tie', 'failed') + insert('older', 'failed', 'failed', '2026-11-04T09:00:00Z') +
    "UPDATE executions SET error='private-body-' || hex(zeroblob(1048576));")
  const result = await reader.read(baseline.cursor, now, signal())
  assert.deepEqual(result.rows.map(row => row.id), ['tie', 'older'])
  assert.equal(result.cursor.high, 3)
  assert.equal(baseline.cursor.high, 1, 'read never commits or mutates the caller cursor')
  assert.doesNotMatch(JSON.stringify(result), /private-body|error|prompt|output/)
})

test('baseline pending keeps original failure state through completion and late delivery', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('running', 'running', null) + insert('already-failed', 'failed', null))
  const baseline = await reader.read(null, now, signal())
  assert.equal(baseline.cursor.pending.length, 2)
  await sql(file, "UPDATE executions SET status='failed', finished_at='2026-11-05T09:30:00Z' WHERE id='running';")
  const completion = await reader.read(baseline.cursor, now, signal())
  assert.deepEqual(completion.rows.map(row => [row.id, row.status, row.baselineStatus, row.baselineDelivery]),
    [['running', 'failed', 'running', null], ['already-failed', 'failed', 'failed', null]])
  assert.equal(completion.cursor.pending.length, 2, 'terminal rows remain pending until delivery resolves')
  await sql(file, "UPDATE executions SET delivery_outcome='failed';")
  const delivery = await reader.read(completion.cursor, now, signal())
  assert.equal(delivery.rows.length, 2)
  assert(delivery.rows.every(row => row.delivery === 'failed' && row.baselineDelivery === null))
  assert.equal(delivery.rows[0].baselineStatus, 'running')
  assert.deepEqual(delivery.cursor.pending, [])
  assert.deepEqual((await reader.read(delivery.cursor, now, signal())).rows, [])
})

test('pending polling rotates beyond eight and handles removals without starvation', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, Array.from({ length: 20 }, (_, index) => insert(`pending-${index}`, 'claimed', null)).join(''))
  let { cursor } = await reader.read(null, now, signal())
  const seen = new Set<string>()
  for (let round = 0; round < 3; round++) {
    const result = await reader.read(cursor, now, signal())
    assert(result.rows.length <= 8)
    result.rows.forEach(row => seen.add(row.id))
    cursor = result.cursor
  }
  assert.equal(seen.size, 20)
  await sql(file, "UPDATE executions SET status='completed',delivery_outcome='delivered';")
  for (let round = 0; round < 3; round++) cursor = (await reader.read(cursor, now, signal())).cursor
  assert.equal(cursor.pending.length, 0)
  assert.equal(cursor.pendingIndex, 0)
})

test('late status and delivery changes are revisited after a serialized cursor resumes', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  const baseline = await reader.read(null, now, signal())
  await sql(file, Array.from({ length: 35 }, (_, index) => insert(`new-${index}`, 'running', null)).join(''))
  const first = await reader.read(baseline.cursor, now, signal())
  assert.equal(first.rows.length, 16)
  assert.equal(first.coverage.state, 'catching-up')
  let cursor: HermesEventCursor = JSON.parse(JSON.stringify(first.cursor))
  const replacement = new HermesEventReader(file)
  for (let round = 0; round < 2; round++) cursor = (await replacement.read(cursor, now, signal())).cursor
  assert.equal(cursor.high, 35)
  await sql(file, "UPDATE executions SET status='failed',delivery_outcome='failed',finished_at='2026-11-05T09:30:00Z' WHERE id IN ('new-0','new-34');")
  const seen = new Set<string>()
  for (let round = 0; round < 4; round++) {
    const result = await replacement.read(cursor, now, signal())
    assert(result.rows.length <= 40)
    result.rows.filter(row => row.status === 'failed' && row.delivery === 'failed').forEach(row => seen.add(row.id))
    cursor = result.cursor
  }
  assert.deepEqual([...seen].sort(), ['new-0', 'new-34'])
})

test('file replacement and a decreased max rowid rebaseline with an explicit gap', async t => {
  const file = await database(t), other = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('original') + insert('second'))
  const initial = await reader.read(null, now, signal())
  await sql(other, insert('replacement', 'failed', 'failed'))
  await rename(other, file)
  const replaced = await reader.read(initial.cursor, now, signal())
  assert.notEqual(replaced.cursor.identity, initial.cursor.identity)
  assert.equal(replaced.coverage.code, 'hermes-history-reset')
  assert.equal(replaced.coverage.state, 'gap')
  assert.deepEqual(replaced.rows, [])
  await sql(file, 'DELETE FROM executions;')
  const reset = await reader.read(replaced.cursor, now, signal())
  assert.equal(reset.cursor.identity, replaced.cursor.identity)
  assert.equal(reset.cursor.high, 0)
  assert.equal(reset.coverage.code, 'hermes-history-reset')
  assert.deepEqual(reset.rows, [])
})

test('seven day exclusions and disappeared pending rows report coverage gaps', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('old', 'running', null, '2026-10-01T09:00:00Z') + insert('pending', 'running', null))
  const baseline = await reader.read(null, now, signal())
  assert.equal(baseline.coverage.code, 'hermes-retention-gap')
  assert.deepEqual(baseline.cursor.pending.map(row => row.id), ['pending'])
  await sql(file, "DELETE FROM executions WHERE id='pending';" + insert('new', 'failed', 'failed', '2026-10-02T09:00:00Z') + insert('keep-max'))
  // Rowid reuse cannot silently attach the baseline state to a different execution.
  await assert.rejects(reader.read(baseline.cursor, now, signal()), /database identity/)
})

test('missing pending rows release their slot only with an explicit gap', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('pending', 'running', null) + insert('anchor'))
  const baseline = await reader.read(null, now, signal())
  await sql(file, "DELETE FROM executions WHERE id='pending';")
  const result = await reader.read(baseline.cursor, now, signal())
  assert.equal(result.coverage.code, 'hermes-pending-gap')
  assert.equal(result.coverage.state, 'gap')
  assert.equal(result.cursor.pending.length, 0)
})

test('retention excludes newly appended old executions and marks long observation interruptions', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  const baseline = await reader.read(null, now, signal())
  await sql(file, insert('outside', 'failed', 'failed', '2026-10-01T09:00:00Z'))
  const result = await reader.read(baseline.cursor, now, signal())
  assert.deepEqual(result.rows, [])
  assert.equal(result.cursor.high, 1)
  assert.equal(result.coverage.code, 'hermes-retention-gap')
  const resumed = await reader.read(result.cursor, '2026-11-13T10:00:00.000Z', signal())
  assert.equal(resumed.coverage.code, 'hermes-retention-gap')
})

test('baseline accepts exactly 128 unfinished rows and rejects 129 without a partial cursor', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, Array.from({ length: 128 }, (_, index) => insert(`pending-${index}`, 'running', null)).join(''))
  const result = await reader.read(null, now, signal())
  assert.equal(result.cursor.pending.length, 128)
  await sql(file, insert('overflow', 'failed', null))
  await assert.rejects(reader.read(null, now, signal()), /baseline pending limit exceeded/)
})

test('bounded metadata rejects controls, NUL suffixes, overlong fields, timestamps and unknown states', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  const baseline = await reader.read(null, now, signal())
  const invalid = [
    "id='private' || char(0) || 'hidden'", "job_id='daily' || char(10)", "status=hex(zeroblob(10000))",
    "job_id=hex(zeroblob(10000))", "claimed_at='2026-02-30T09:00:00Z'", "claimed_at='2026-11-05T09:00:00'",
    "claimed_at='2026-11-05T09:00:00+25:00'", "finished_at='2026-11-05T08:00:00Z'",
    "claimed_at='2026-11-05T10:00:00.000000001Z'", "finished_at='2026-11-05T10:00:01Z'",
    "claimed_at='2026-11-05T09:00:00Z' || char(0) || 'hidden'", "status='private-unknown'", "delivery_outcome='private-delivery'"
  ]
  for (const assignment of invalid) {
    await sql(file, 'DELETE FROM executions;' + insert('valid') + `UPDATE executions SET ${assignment};`)
    await assert.rejects(reader.read(baseline.cursor, now, signal()), error => {
      assert(error instanceof Error)
      assert.match(error.message, /Invalid Hermes event metadata|Unsupported Hermes/)
      assert.doesNotMatch(error.message, /private|hidden/)
      return true
    })
  }
})

test('missing, nonregular, symlinked, malformed and incompatible databases fail with safe errors', async t => {
  const file = await database(t), directory = path.dirname(file), missing = path.join(directory, 'missing.db')
  await assert.rejects(new HermesEventReader(missing).read(null, now, signal()), /Cannot open Hermes event database/)
  await assert.rejects(stat(missing), { code: 'ENOENT' })
  await assert.rejects(new HermesEventReader(directory).read(null, now, signal()), /database identity/)
  const link = path.join(directory, 'link.db')
  await symlink(file, link)
  await assert.rejects(new HermesEventReader(link).read(null, now, signal()), /database identity/)
  await sql(file, 'DROP TABLE executions; CREATE TABLE executions(id TEXT);')
  await assert.rejects(new HermesEventReader(file).read(null, now, signal()), /database schema/)
  await writeFile(file, 'private malformed database')
  await assert.rejects(new HermesEventReader(file).read(null, now, signal()), error => {
    assert(error instanceof Error)
    assert.match(error.message, /database schema/)
    assert.doesNotMatch(error.message, /private malformed/)
    return true
  })
})

test('invalid cursor and time reject before resource admission', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  const { cursor } = await reader.read(null, now, signal())
  await assert.rejects(reader.read({ ...cursor, revisit: -1 }, now, signal()), /Invalid Hermes event cursor/)
  await assert.rejects(reader.read({ ...cursor, pendingIndex: 1 }, now, signal()), /Invalid Hermes event cursor/)
  await assert.rejects(reader.read(cursor, 'not-a-date', signal()), /Invalid Hermes event time/)
})

test('abort drains the finite SQLite child and permits immediate reuse', async t => {
  const file = await database(t), reader = new HermesEventReader(file), controller = new AbortController()
  const pending = assert.rejects(reader.read(null, now, controller.signal), { name: 'AbortError' })
  await setImmediate()
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'hermes-events')?.current.commands, 1)
  controller.abort()
  await pending
  await assert.rejects(reader.read(null, now, controller.signal), { name: 'AbortError' })
  assert.equal(Object.values(collectionResources.snapshot().sources.find(source => source.source === 'hermes-events')!.current).every(value => value === 0), true)
  assert.deepEqual((await reader.read(null, now, signal())).rows, [])
})

test('append, rotating revisit and baseline pending share a strict forty row response', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, Array.from({ length: 20 }, (_, index) => insert(`baseline-${index}`, 'running', null)).join(''))
  const baseline = await reader.read(null, now, signal())
  await sql(file, Array.from({ length: 40 }, (_, index) => insert(`append-${index}`, 'failed', 'failed')).join(''))
  const first = await reader.read(baseline.cursor, now, signal())
  assert.equal(first.rows.length, 24)
  const second = await reader.read(first.cursor, now, signal())
  assert.equal(second.rows.length, 40)
  assert.equal(second.rows.filter(row => row.baselineStatus !== undefined).length, 8)
  assert.equal(second.coverage.state, 'catching-up')
  assert.equal(new Set(second.rows.map(row => row.rowid)).size, 40)
})

test('late finished_at never extends retention and expired baseline pending is removed with a gap', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('pending', 'running', null))
  const baseline = await reader.read(null, now, signal())
  await sql(file, "UPDATE executions SET status='failed',finished_at='2026-11-13T09:00:00Z';")
  const expired = await reader.read(baseline.cursor, '2026-11-13T10:00:00.000Z', signal())
  assert.deepEqual(expired.rows, [])
  assert.deepEqual(expired.cursor.pending, [])
  assert.equal(expired.coverage.code, 'hermes-retention-gap')
  const restarted = await reader.read(null, '2026-11-13T10:00:00.000Z', signal())
  assert.deepEqual(restarted.cursor.pending, [])
  assert.equal(restarted.coverage.code, 'hermes-retention-gap')
})

test('persisted floor excludes rewritten old executions on every revisit without blocking new rows', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  const baseline = await reader.read(null, now, signal())
  assert.equal(baseline.cursor.floor, 0)
  await sql(file, insert('evicted', 'failed', 'failed') + insert('retained', 'failed', 'failed'))
  const first = await reader.read(baseline.cursor, now, signal())
  let cursor: HermesEventCursor = { ...first.cursor, floor: 1 }
  await sql(file, "UPDATE executions SET claimed_at='2026-11-05T09:59:00Z' WHERE id='evicted';" + insert('new', 'failed', 'failed'))
  for (let round = 0; round < 3; round++) {
    const result = await reader.read(JSON.parse(JSON.stringify(cursor)), now, signal())
    assert(result.rows.every(row => row.rowid > 1))
    assert.equal(result.cursor.floor, 1)
    assert(result.cursor.revisit >= 1)
    assert.equal(result.cursor.high, 3)
    if (round === 0) assert(result.rows.some(row => row.id === 'new'))
    cursor = result.cursor
  }
})

test('floor removes all excluded baseline pending entries and keeps the surviving ring usable', async t => {
  const file = await database(t), reader = new HermesEventReader(file)
  await sql(file, Array.from({ length: 20 }, (_, index) => insert(`pending-${index}`, 'running', null)).join(''))
  const baseline = await reader.read(null, now, signal())
  const first = await reader.read({ ...baseline.cursor, floor: 12 }, now, signal())
  assert.equal(first.coverage.code, 'hermes-dedup-capacity-gap')
  assert.equal(first.coverage.state, 'gap')
  assert.equal(first.cursor.pending.length, 8)
  assert(first.cursor.pending.every(entry => entry.rowid > 12))
  assert(first.rows.every(entry => entry.rowid > 12))
  const second = await reader.read(first.cursor, now, signal())
  assert.equal(second.rows.length, 8)
  assert(second.rows.every(entry => entry.rowid > 12))
  assert.equal(second.cursor.revisit, baseline.cursor.baseline)
})

test('a source reset clears the previous identity floor and invalid floors reject', async t => {
  const file = await database(t), other = await database(t), reader = new HermesEventReader(file)
  await sql(file, insert('original') + insert('second'))
  const initial = await reader.read(null, now, signal())
  await assert.rejects(reader.read({ ...initial.cursor, floor: -1 }, now, signal()), /Invalid Hermes event cursor/)
  await assert.rejects(reader.read({ ...initial.cursor, floor: 3 }, now, signal()), /Invalid Hermes event cursor/)
  await sql(other, insert('replacement', 'running', null))
  await rename(other, file)
  const replaced = await reader.read({ ...initial.cursor, floor: 2 }, now, signal())
  assert.equal(replaced.cursor.floor, 0)
  assert.equal(replaced.cursor.pending.length, 1)
  assert.equal(replaced.coverage.code, 'hermes-history-reset')
  await sql(file, 'DELETE FROM executions;')
  const reset = await reader.read({ ...replaced.cursor, floor: 1 }, now, signal())
  assert.equal(reset.cursor.floor, 0)
  assert.equal(reset.cursor.high, 0)
  assert.equal(reset.coverage.code, 'hermes-history-reset')
})
