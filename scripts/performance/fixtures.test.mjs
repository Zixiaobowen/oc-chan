import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, link, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendHermesFailures, FIXTURE_LIMITS, prepareFixtures, rotateSessions, writeEvents } from './fixtures.mjs'

const exec = promisify(execFile)
const now = Date.UTC(2026, 10, 5, 10)
async function fixture(t, seed = 'soak-contract') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'occhan-soak-fixtures-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return prepareFixtures(root, { seed, now })
}
async function totalBytes(root) {
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    bytes += entry.isDirectory() ? await totalBytes(file) : (await lstat(file)).size
  }
  return bytes
}
async function rows(database, sql) {
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', '-batch', '-bail', '-json', database, sql], {
    timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8'
  })
  return JSON.parse(stdout)
}
async function poisoned(manifest) {
  await assert.rejects(rotateSessions(manifest, { generation: 999, now }), /previously failed/)
}

test('rotation replaces all session identities and old tails while retaining paths and exact byte accounting', async t => {
  const manifest = await fixture(t)
  const baseline = await totalBytes(manifest.root)
  const paths = manifest.sessions.map(session => session.file)
  let previous = manifest.sessions
  for (let generation = 1; generation <= 8; generation++) {
    const identities = await Promise.all(previous.map(session => lstat(session.file)))
    await writeEvents(manifest, { sessionCount: 128, sequence: generation, now })
    const result = await rotateSessions(manifest, { generation, now: now + generation * 1000 })
    assert.equal(result.generation, generation)
    assert.equal(result.bytes, baseline)
    assert.equal(result.bytes, await totalBytes(manifest.root))
    assert.equal(result.sessions, manifest.sessions)
    assert.deepEqual(result.sessions.map(session => session.file), paths)
    assert.equal(new Set(result.sessions.map(session => session.sessionId)).size, 128)
    for (const [index, session] of result.sessions.entries()) {
      const identity = await lstat(session.file)
      assert.notEqual(identity.ino, identities[index].ino)
      assert.notEqual(session.sessionId, previous[index].sessionId)
      const lines = (await readFile(session.file, 'utf8')).trimEnd().split('\n').map(JSON.parse)
      assert.deepEqual(lines, [{ type: 'session', version: 3, id: session.sessionId,
        timestamp: new Date(now + generation * 1000).toISOString(), cwd: manifest.root,
        ...(index % 8 ? { parentSession: paths[index - index % 8] } : {}) },
      { type: 'model_change', model: 'perf-fixture' }])
      assert.equal(session.parentSessionId, index % 8 ? result.sessions[index - index % 8].sessionId : undefined)
    }
    const appended = await writeEvents(manifest, { sessionCount: 32, sequence: generation + 100, now })
    assert.deepEqual(appended.map(event => event.sessionId), result.sessions.slice(0, 32).map(session => session.sessionId))
    previous = result.sessions
  }
  const final = await rotateSessions(manifest, { generation: 9, now })
  assert.equal(final.bytes, baseline)
  assert.equal((await readdir(path.dirname(paths[0]))).length, 128)
})

test('a full day of Hermes batches preserves paged history for every task within 10000 retained rows', { timeout: 120_000 }, async t => {
  const manifest = await fixture(t)
  const jobs = new Set(manifest.hermesJobIds.map(id => id.slice('hermes-job:'.length)))
  const checkpoints = new Set([1, 100, 187, 250, 251, 500, 1000, 1440])
  let high = 10000
  let previousId = ''
  let firstIds
  for (let sequence = 0; sequence < 1440; sequence++) {
    const result = await appendHermesFailures(manifest, { sequence, now: now + sequence * 60_000 })
    firstIds ??= result.executionIds
    assert.equal(result.count, 40)
    assert.equal(result.executionIds.length, 40)
    assert.equal(new Set(result.executionIds).size, 40)
    assert.ok(result.executionIds[0] > previousId)
    previousId = result.executionIds.at(-1)
    high += 40
    if (!checkpoints.has(sequence + 1)) continue
    assert.equal(result.bytes, await totalBytes(manifest.root))
    const [summary] = await rows(manifest.database, 'SELECT count(*) AS count, min(rowid) AS low, max(rowid) AS high FROM executions;')
    assert.equal(summary.count, 10000)
    assert.equal(summary.low, (sequence + 1) * 40 + 1)
    assert.equal(summary.high, high)
    const histories = await rows(manifest.database, 'SELECT job_id, count(*) AS count FROM executions GROUP BY job_id ORDER BY job_id;')
    assert.deepEqual(histories.map(row => row.job_id), [...jobs])
    const short = histories.filter(row => row.count <= 25)
    assert.deepEqual(short, [], `Batch ${sequence + 1}: every task must retain a full 25-row page and a next page`)
    const batch = await rows(manifest.database, `SELECT rowid,id,job_id,status,delivery_outcome,error,process_started_at,handoff_started_at,scheduled_instant,progress_at FROM executions WHERE rowid>${high - 40} ORDER BY rowid;`)
    assert.deepEqual(batch.map(row => row.id), result.executionIds)
    for (const [index, row] of batch.entries()) {
      assert.equal(row.rowid, high - 40 + index + 1)
      assert.ok(jobs.has(row.job_id))
      assert.equal(row.status, 'failed')
      assert.equal(row.delivery_outcome, 'failed')
      for (const column of ['error', 'process_started_at', 'handoff_started_at', 'scheduled_instant', 'progress_at']) assert.equal(row[column], null)
    }
    assert.ok((await lstat(manifest.database)).size <= 8192 * 4096)
  }
  const [retained] = await rows(manifest.database, "SELECT count(*) AS initialRows FROM executions WHERE id LIKE 'perf-execution-%';")
  assert.equal(retained.initialRows, 0)
  const second = await fixture(t)
  assert.deepEqual((await appendHermesFailures(second, { sequence: 0, now })).executionIds, firstIds)
})

test('invalid generation, counts and sequence poison the original fixture', async t => {
  for (const mutate of [
    manifest => rotateSessions(manifest, { generation: 0, now }),
    manifest => rotateSessions(manifest, { generation: 1_000_001, now }),
    manifest => appendHermesFailures(manifest, { sequence: 0, count: 0, now }),
    manifest => appendHermesFailures(manifest, { sequence: 0, count: 101, now }),
    manifest => appendHermesFailures(manifest, { sequence: -1, now }),
    manifest => rotateSessions(manifest, { generation: 1, now: NaN })
  ]) {
    const manifest = await fixture(t)
    await assert.rejects(mutate(manifest), /Invalid fixture|must increase|must be positive/)
    await poisoned(manifest)
  }
  const manifest = await fixture(t)
  await appendHermesFailures(manifest, { sequence: 0, now })
  await assert.rejects(appendHermesFailures(manifest, { sequence: 0, now }), /must increase/)
  await poisoned(manifest)
})

test('concurrent mutations reject both operations and prevent fixture reuse', async t => {
  const manifest = await fixture(t)
  const results = await Promise.allSettled([
    rotateSessions(manifest, { generation: 1, now }),
    appendHermesFailures(manifest, { sequence: 0, now })
  ])
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.ok(results.every(result => /Concurrent fixture mutation/.test(result.reason.message)))
  await poisoned(manifest)
})

test('session links, replaced parents, oversized files and external edits fail before rotation and poison the fixture', async t => {
  for (const tamper of [
    async (manifest, file) => { await rename(file, `${file}.saved`); await symlink(`${file}.saved`, file) },
    async (manifest, file) => { await link(file, `${file}.linked`) },
    async (manifest, file) => { await appendFile(file, 'external change\n') },
    async (manifest, file) => { const text = await readFile(file, 'utf8'); await writeFile(file, text.replace('session', 'sessioX')) },
    async (manifest, file) => { await writeFile(file, Buffer.alloc(FIXTURE_LIMITS.sessionBytes + 1, 120)) },
    async (manifest, file) => { const directory = path.dirname(file); await rename(directory, `${directory}.saved`); await symlink(`${directory}.saved`, directory) },
    async (manifest, file) => { await symlink(file, `${file}.rotate`) }
  ]) {
    const manifest = await fixture(t)
    await tamper(manifest, manifest.sessions[0].file)
    await assert.rejects(rotateSessions(manifest, { generation: 1, now }), /linked|symbolic|modified|ELOOP|EEXIST|512 KiB/)
    await poisoned(manifest)
  }
})

test('Hermes database and SQLite sidecar links are refused without following their targets', async t => {
  for (const tamper of [
    async manifest => { await rename(manifest.database, `${manifest.database}.saved`); await symlink(`${manifest.database}.saved`, manifest.database) },
    async manifest => { await link(manifest.database, `${manifest.database}.linked`) },
    async manifest => { await symlink(manifest.jobsFile, `${manifest.database}-journal`) },
    async manifest => { await link(manifest.jobsFile, `${manifest.database}-wal`) }
  ]) {
    const manifest = await fixture(t)
    const jobs = await readFile(manifest.jobsFile, 'utf8')
    await tamper(manifest)
    await assert.rejects(appendHermesFailures(manifest, { sequence: 0, now }), /linked|sidecar|ELOOP/)
    assert.equal(await readFile(manifest.jobsFile, 'utf8'), jobs)
    await poisoned(manifest)
  }
})

test('mutating public manifest paths cannot redirect fixture writes or session replacement', async t => {
  const manifest = await fixture(t)
  const originalDatabase = manifest.database
  const originalPaths = manifest.sessions.map(session => session.file)
  const outside = path.join(manifest.root, 'unowned')
  await writeFile(outside, 'untouched')
  manifest.database = outside
  manifest.sessions[0].file = outside
  manifest.hermesJobIds[0] = 'unowned-job'
  const rotated = await rotateSessions(manifest, { generation: 1, now })
  assert.deepEqual(rotated.sessions.map(session => session.file), originalPaths)
  await appendHermesFailures(manifest, { sequence: 0, now })
  assert.equal(await readFile(outside, 'utf8'), 'untouched')
  const [result] = await rows(originalDatabase, 'SELECT max(rowid) AS high FROM executions;')
  assert.equal(result.high, 10040)
  await unlink(outside)
})
