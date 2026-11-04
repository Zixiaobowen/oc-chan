import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { collectHermesRuntime, hermesJobStatus, MAX_METADATA_BYTES, readScheduleMetadata, type HermesJobMetadata } from './hermes-runtime'

const exec = promisify(execFile)
const now = Date.parse('2026-11-04T08:00:00Z')
const scheduled: HermesJobMetadata = { id: 'daily', enabled: true, state: 'scheduled' }
const emptyRuntime = { latest: new Map(), processes: new Map() }
const active = { id: 'run', jobId: 'daily', status: 'running' as const, pid: 42,
  processStartedAt: (now / 1000 - 3600) * 100, claimedAt: '2026-11-04T07:50:00Z' }
const activeRuntime = { latest: new Map([['daily', active]]), processes: new Map([[42, now / 1000 - 3600]]) }

test('enabled scheduled jobs wait; pause and completion disable without inventing execution results', () => {
  assert.equal(hermesJobStatus(scheduled, emptyRuntime, now).state, 'waiting')
  assert.equal(hermesJobStatus(scheduled, emptyRuntime, now).lastRun, undefined)
  for (const patch of [{ enabled: false }, { state: 'paused' }, { state: 'completed' }])
    assert.equal(hermesJobStatus({ ...scheduled, ...patch }, emptyRuntime, now).state, 'disabled')
  assert.equal(hermesJobStatus({ ...scheduled, state: 'unrecognized' }, emptyRuntime, now).state, 'unknown')
})

test('running requires fresh heartbeat and the same live process, including when future triggers are paused', () => {
  const job = { ...scheduled, fireClaimAt: '2026-11-04T07:59:00Z' }
  assert.equal(hermesJobStatus(job, activeRuntime, now).state, 'running')
  assert.equal(hermesJobStatus({ ...job, enabled: false, state: 'paused' }, activeRuntime, now).pid, 42)
  for (const runtime of [
    { ...activeRuntime, processes: new Map() },
    { ...activeRuntime, processes: new Map([[42, now / 1000]]) },
    { ...activeRuntime, latest: new Map([['daily', { ...active, processStartedAt: null }]]) }
  ]) {
    const result = hermesJobStatus(job, runtime, now)
    assert.equal(result.state, 'unknown')
    assert.equal(result.pid, undefined)
  }
})

test('expired, future and malformed heartbeats never become running or waiting', () => {
  for (const fireClaimAt of [undefined, null, 'invalid', '2026-11-04T08:00:01Z', '2026-11-04T07:55:00Z', '2026-11-04T07:59:00']) {
    const result = hermesJobStatus({ ...scheduled, fireClaimAt }, activeRuntime, now)
    assert.equal(result.state, 'unknown')
    assert.equal(result.stateReason, 'hermes-unconfirmed')
  }
  assert.equal(hermesJobStatus({ ...scheduled, fireClaimAt: '2026-11-04T07:55:00.001Z' }, activeRuntime, now).state, 'running')
})

test('dispatch ownership and unmatched heartbeats do not prove running', () => {
  const job = { ...scheduled, fireClaimAt: '2026-11-04T07:59:00Z' }
  const pending = { ...activeRuntime, latest: new Map([['daily', { ...active, status: 'claimed' as const }]]) }
  assert.equal(hermesJobStatus(job, pending, now).stateReason, 'hermes-dispatching')
  assert.equal(hermesJobStatus(job, emptyRuntime, now).state, 'unknown')
  assert.equal(hermesJobStatus(job, null, now).stateReason, 'hermes-read-failed')
  assert.equal(hermesJobStatus(scheduled, null, now).state, 'unknown')
})

test('last run is separate from current state; delivery failure is not reported as success', () => {
  for (const [lastStatus, expected] of [['ok', 'succeeded'], ['error', 'failed'], ['delivery_failed', 'delivery-failed'],
    ['blocked_config', 'blocked'], ['unexpected', 'unknown']]) {
    const result = hermesJobStatus({ ...scheduled, lastRunAt: '2026-11-04T15:00:00+08:00', lastStatus }, emptyRuntime, now)
    assert.equal(result.state, 'waiting')
    assert.deepEqual(result.lastRun, { result: expected, at: '2026-11-04T07:00:00.000Z' })
  }
  assert.equal(hermesJobStatus({ ...scheduled, lastRunAt: '2026-11-05T08:00:00Z', lastStatus: 'ok' }, emptyRuntime, now).lastRun?.at, undefined)
})

async function database(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-hermes-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'executions.db')
  await exec('/usr/bin/sqlite3', [file, `PRAGMA journal_mode=WAL; CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT, status TEXT, pid INTEGER, process_started_at INTEGER, claimed_at TEXT, error TEXT, finished_at TEXT);
    CREATE INDEX by_job ON executions(job_id);`])
  return file
}

test('real SQLite and ps confirm live execution without reading private error output or modifying the database', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  const { stdout } = await exec('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
  const birth = Date.parse(`${stdout.trim()} UTC`) / 10
  await exec('/usr/bin/sqlite3', [file, `INSERT INTO executions VALUES ('run','daily','running',${process.pid},${birth},'2026-11-04T08:00:00Z','private-error-body',NULL);`])
  const before = await readFile(file)
  const result = await collectHermesRuntime([{ ...scheduled, fireClaimAt: new Date().toISOString() }], file)
  assert.equal(result.statuses.get('daily')?.state, 'running')
  assert.equal(result.statuses.get('daily')?.pid, process.pid)
  assert.equal(result.source.state, 'ok')
  assert.doesNotMatch(JSON.stringify([...result.statuses.values()]), /private-error-body/)
  assert.deepEqual(await readFile(file), before)
})

test('latest execution compares instants across timezone offsets, not lexical timestamp order', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  await exec('/usr/bin/sqlite3', [file, `INSERT INTO executions VALUES
    ('older','daily','completed',1,NULL,'2026-11-04T16:00:00+08:00',NULL,'2026-11-04T16:01:00+08:00'),
    ('newer','daily','claimed',1,NULL,'2026-11-04T09:00:00Z',NULL,NULL);`])
  const result = await collectHermesRuntime([{ ...scheduled, fireClaimAt: new Date().toISOString() }], file)
  assert.equal(result.statuses.get('daily')?.stateReason, 'hermes-dispatching')
})

test('empty execution history permits waiting; missing and invalid databases keep tasks visible and unknown', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  assert.equal((await collectHermesRuntime([scheduled], file)).statuses.get('daily')?.state, 'waiting')
  const missing = path.join(path.dirname(file), 'missing.db')
  const absent = await collectHermesRuntime([scheduled], missing)
  assert.equal(absent.statuses.get('daily')?.state, 'unknown')
  assert.equal(absent.source.state, 'partial')
  await assert.rejects(stat(missing), { code: 'ENOENT' })
  await writeFile(file, 'private broken database')
  const invalid = await collectHermesRuntime([scheduled], file)
  assert.equal(invalid.statuses.get('daily')?.stateReason, 'hermes-read-failed')
  assert.doesNotMatch(invalid.source.detail, /private broken database/)
})

test('query escapes job identifiers and never includes other jobs', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  await exec('/usr/bin/sqlite3', [file, `INSERT INTO executions VALUES ('bad','other','broken',1,NULL,'invalid','private',NULL);`])
  const id = "daily'); DROP TABLE executions; --"
  const result = await collectHermesRuntime([{ ...scheduled, id }], file)
  assert.equal(result.statuses.get(id)?.state, 'waiting')
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', file, 'SELECT COUNT(*) FROM executions'])
  assert.equal(stdout.trim(), '1')
})

test('execution and task budgets report incomplete status instead of silently dropping records', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  await exec('/usr/bin/sqlite3', [file, `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4097)
    INSERT INTO executions SELECT CAST(x AS TEXT),'daily','completed',1,NULL,'2026-11-04T08:00:00Z',NULL,NULL FROM n;`])
  const over = await collectHermesRuntime([scheduled], file)
  assert.equal(over.statuses.get('daily')?.state, 'unknown')
  assert.match(over.source.detail, /4096/)
  const jobs = Array.from({ length: 257 }, (_, index) => ({ ...scheduled, id: String(index) }))
  const crowded = await collectHermesRuntime(jobs, file)
  assert.equal(crowded.statuses.size, 257)
  assert([...crowded.statuses.values()].every(job => job.state === 'unknown'))
  assert.match(crowded.source.detail, /256/)
})

test('new terminal executions replace older metadata results without losing same-run delivery failures', () => {
  const execution = { ...active, status: 'failed' as const, finishedAt: '2026-11-04T07:51:00Z' }
  const runtime = { ...emptyRuntime, latest: new Map([['daily', execution]]) }
  const result = hermesJobStatus({ ...scheduled, lastStatus: 'ok', lastRunAt: '2026-11-03T08:00:00Z' }, runtime, now)
  assert.equal(result.state, 'waiting')
  assert.deepEqual(result.lastRun, { result: 'failed', at: '2026-11-04T07:51:00.000Z' })
  const completed = { ...emptyRuntime, latest: new Map([['daily', { ...execution, status: 'completed' as const }]]) }
  const delivered = hermesJobStatus({ ...scheduled, lastStatus: 'delivery_failed', lastRunAt: '2026-11-04T07:50:59Z' }, completed, now)
  assert.equal(delivered.lastRun?.result, 'delivery-failed')
})

test('oversized database values fail within the read budget', { skip: process.platform !== 'darwin' }, async t => {
  const file = await database(t)
  await exec('/usr/bin/sqlite3', [file, `INSERT INTO executions VALUES (CAST(zeroblob(2097152) AS TEXT),'daily','completed',1,NULL,'2026-11-04T08:00:00Z',NULL,NULL);`])
  const result = await collectHermesRuntime([scheduled], file)
  assert.equal(result.source.state, 'partial')
  assert.equal(result.statuses.get('daily')?.state, 'unknown')
})

test('metadata rejects oversized input before reading and preserves parse errors', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-hermes-metadata-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'jobs.json')
  await writeFile(file, '{"jobs":[]}')
  assert.deepEqual(await readScheduleMetadata(file), { jobs: [] })
  await truncate(file, MAX_METADATA_BYTES + 1)
  await assert.rejects(readScheduleMetadata(file), /1 MiB/)
  await writeFile(file, '{"jobs":')
  await assert.rejects(readScheduleMetadata(file), SyntaxError)
})
