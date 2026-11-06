import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'

export const FIXTURE_LIMITS = Object.freeze({ sessionBytes: 512 * 1024, totalBytes: 128 * 1024 * 1024, concurrency: 8 })
const SESSION_COUNT = 128
const HERMES_COUNT = 100
const BASE_TIME = Date.UTC(2026, 0, 1)
const DATABASE_BYTES = 8192 * 4096
const JOURNAL_BYTES = DATABASE_BYTES + 64 * 1024
const states = new WeakMap()
const libraryDirectories = ['/Library/LaunchAgents', '/Library/LaunchDaemons', '/System/Library/LaunchAgents', '/System/Library/LaunchDaemons']

function integer(value, name, maximum = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid fixture ${name}`)
  return value
}
function instant(now) {
  integer(now, 'now', 253_402_300_799_999)
  return new Date(now).toISOString()
}
function digest(seed, kind, index) {
  return createHash('sha256').update(JSON.stringify([seed, kind, index])).digest('hex')
}
function sessionId(seed, index) {
  const hex = digest(seed, 'session', index)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
function label(seed, index) { return `local.occhan.perf.${digest(seed, 'namespace', 0).slice(0, 12)}.${String(index).padStart(4, '0')}` }
function plist(seed, index, sequence = 0) {
  const interval = 60 + parseInt(digest(seed, 'interval', index).slice(0, 4), 16) % 3540 + sequence
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label(seed, index)}</string><key>StartInterval</key><integer>${interval}</integer><key>RunAtLoad</key><false/><key>Disabled</key><false/></dict></plist>\n`
}
async function pool(items, action) {
  let cursor = 0
  let failure
  const results = new Array(items.length)
  await Promise.all(Array.from({ length: Math.min(FIXTURE_LIMITS.concurrency, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++
      try { results[index] = await action(items[index], index) }
      catch (error) { failure ??= error }
    }
  }))
  if (failure) throw failure
  return results
}
async function requireDirectory(directory, identity) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || identity && (info.ino !== identity.ino || info.dev !== identity.dev))
    throw new Error(`Fixture directory replaced or symbolic: ${directory}`)
  return { ino: info.ino, dev: info.dev }
}
async function checkParents(state, file) {
  if (!file.startsWith(state.root + path.sep)) throw new Error('Fixture path escapes root')
  let directory = path.dirname(file)
  for (;;) {
    const identity = state.directories.get(directory)
    if (!identity) throw new Error(`Unowned fixture directory: ${directory}`)
    await requireDirectory(directory, identity)
    if (directory === state.root) break
    directory = path.dirname(directory)
  }
}
async function makeDirectory(state, directory) {
  await checkParents(state, directory)
  await mkdir(directory, { mode: 0o700 })
  state.directories.set(directory, await requireDirectory(directory))
}
function reserve(state, additional) {
  if (state.bytes + additional > FIXTURE_LIMITS.totalBytes) throw new Error('Fixture input exceeds 128 MiB')
  state.bytes += additional
}
function fileIdentity(info) {
  return { ino: info.ino, dev: info.dev, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}
async function fileStat(state, file, handle) {
  await checkParents(state, file)
  const info = await handle.stat()
  const entry = await lstat(file)
  if (!info.isFile() || info.nlink !== 1 || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      entry.ino !== info.ino || entry.dev !== info.dev || entry.size !== info.size ||
      entry.mtimeMs !== info.mtimeMs || entry.ctimeMs !== info.ctimeMs)
    throw new Error(`Fixture file replaced, linked or concurrently modified: ${file}`)
  return info
}
async function finishWrite(state, file, handle, size) {
  const info = await fileStat(state, file, handle)
  const owned = state.files.get(file)
  if (info.ino !== owned.ino || info.dev !== owned.dev || info.size !== size)
    throw new Error(`Fixture file concurrently modified: ${file}`)
  Object.assign(owned, fileIdentity(info))
}
async function createFile(state, file, content, at = state.now) {
  await checkParents(state, file)
  const size = Buffer.byteLength(content)
  reserve(state, size)
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(content)
    await handle.utimes(at / 1000, at / 1000)
    const info = await fileStat(state, file, handle)
    if (info.size !== size) throw new Error(`Fixture file concurrently modified: ${file}`)
    state.files.set(file, fileIdentity(info))
  } finally { await handle.close() }
}
async function ownedFile(state, file, flags, allowChanged = false) {
  await checkParents(state, file)
  const owned = state.files.get(file)
  if (!owned) throw new Error(`Unowned fixture file: ${file}`)
  const handle = await open(file, flags | constants.O_NOFOLLOW)
  try {
    const info = await fileStat(state, file, handle)
    if (info.ino !== owned.ino || info.dev !== owned.dev)
      throw new Error(`Fixture file replaced or linked: ${file}`)
    if (!allowChanged && (info.size !== owned.size || info.mtimeMs !== owned.mtimeMs || info.ctimeMs !== owned.ctimeMs))
      throw new Error(`Fixture file concurrently modified: ${file}`)
    reserve(state, info.size - owned.size)
    Object.assign(owned, fileIdentity(info))
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function exclusive(manifest, action) {
  const state = states.get(manifest)
  if (!state) throw new Error('Use the original manifest returned by prepareFixtures in this process')
  if (state.busy) {
    state.failed = true
    throw new Error('Concurrent fixture mutations are not allowed')
  }
  if (state.failed) throw new Error('Fixture mutation previously failed; discard this fixture root')
  state.busy = true
  try {
    const result = await action(state)
    if (state.failed) throw new Error('Concurrent fixture mutation invalidated this fixture root')
    return result
  }
  catch (error) { state.failed = true; throw error }
  finally { state.busy = false }
}
function sqlite(database, sql) {
  return new Promise((resolve, reject) => {
    let inputFailure
    const child = execFile('/usr/bin/sqlite3', ['-batch', '-bail', database], {
      timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8'
    }, (error) => {
      const failure = inputFailure ?? error
      if (failure) reject(new Error(`Fixture SQLite failed: ${failure.code ?? 'UNKNOWN'}`, { cause: failure }))
      else resolve()
    })
    child.stdin.on('error', error => { inputFailure = error; child.kill('SIGKILL') })
    child.stdin.end(sql)
  })
}

/** Caller creates an empty root and owns its lifetime; this module never removes roots. */
export async function prepareFixtures(root, { seed, now = BASE_TIME } = {}) {
  if (!(typeof seed === 'string' && seed.length > 0 && seed.length <= 128 || Number.isSafeInteger(seed)))
    throw new Error('Fixture seed must be a safe integer or a 1–128 character string')
  instant(now)
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Fixture root must be an absolute empty directory')
  const input = path.resolve(root)
  await requireDirectory(input)
  const canonical = await realpath(input)
  const directory = await opendir(canonical)
  try { if (await directory.read()) throw new Error('Fixture root must be empty; refusing overwrite') }
  finally { await directory.close() }
  const state = { root: canonical, seed, now, bytes: 0, busy: false, failed: false,
    files: new Map(), directories: new Map(), plistCount: 0, mutationSequence: -1, generation: 0, hermesSequence: -1, hermesNextJob: 0 }
  state.directories.set(canonical, await requireDirectory(canonical))
  const home = path.join(canonical, 'home')
  const sessionRoot = path.join(canonical, 'sessions')
  const emptyRoot = path.join(canonical, 'empty-system')
  for (const name of ['home', 'sessions', 'empty-system', 'home/.hermes', 'home/.hermes/cron', 'home/Library', 'home/Library/LaunchAgents'])
    await makeDirectory(state, path.join(canonical, name))
  const systemDirectories = {}
  for (const [index, name] of libraryDirectories.entries()) {
    systemDirectories[name] = path.join(emptyRoot, String(index))
    await makeDirectory(state, systemDirectories[name])
  }
  const namespace = digest(seed, 'namespace', 0).slice(0, 12)
  const hermesJobs = Array.from({ length: HERMES_COUNT }, (_, index) => ({
    id: `perf-${namespace}-${String(index).padStart(3, '0')}`, name: `Perf schedule ${String(index).padStart(3, '0')}`,
    enabled: true, state: 'scheduled', schedule: { kind: 'interval', minutes: 5 + index % 55 }
  }))
  const jobsFile = path.join(home, '.hermes/cron/jobs.json')
  await createFile(state, jobsFile, JSON.stringify({ jobs: hermesJobs }) + '\n')
  const database = path.join(home, '.hermes/cron/executions.db')
  await createFile(state, database, '')
  // Schema mirrors Hermes execution metadata used by the production runtime/history readers.
  // Private body columns exist for schema fidelity and remain NULL in every row.
  const sql = `PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=8192; PRAGMA hard_heap_limit=16777216;
BEGIN;
CREATE TABLE executions (
 id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER,
 process_started_at INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT,
 error TEXT, handoff_pending INTEGER, handoff_started_at TEXT, delivery_outcome TEXT,
 scheduled_instant TEXT, progress_at TEXT);
CREATE INDEX by_job ON executions(job_id);
WITH RECURSIVE rows(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM rows WHERE n<9999)
INSERT INTO executions (id,job_id,source,process_id,pid,process_started_at,status,claimed_at,started_at,finished_at,handoff_pending,delivery_outcome)
SELECT printf('perf-execution-%05d',n),printf('perf-${namespace}-%03d',n%100),'cron','perf-fixture',1,NULL,
 CASE WHEN n%17=0 THEN 'failed' ELSE 'completed' END,
 strftime('%Y-%m-%dT%H:%M:%fZ',(${now}/1000.0)-600000+n*60,'unixepoch'),
 strftime('%Y-%m-%dT%H:%M:%fZ',(${now}/1000.0)-599999+n*60,'unixepoch'),
 strftime('%Y-%m-%dT%H:%M:%fZ',(${now}/1000.0)-599998+n*60,'unixepoch'),0,
 CASE WHEN n%17=0 THEN 'failed' ELSE 'delivered' END FROM rows;
COMMIT;`
  await sqlite(database, sql)
  const dbHandle = await ownedFile(state, database, constants.O_RDONLY, true)
  await dbHandle.close()
  const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => {
    const id = sessionId(seed, index)
    return { sessionId: id, file: path.join(sessionRoot, `${id}.jsonl`),
      ...(index % 8 ? { parentSessionId: sessionId(seed, index - index % 8) } : {}) }
  })
  await pool(sessions, async (session, index) => {
    const header = { type: 'session', version: 3, id: session.sessionId, timestamp: instant(now),
      cwd: canonical, ...(index % 8 ? { parentSession: sessions[index - index % 8].file } : {}) }
    await createFile(state, session.file, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'model_change', model: 'perf-fixture' }) + '\n')
  })
  state.home = home
  state.database = database
  state.hermesJobIds = hermesJobs.map(job => job.id)
  state.sessions = sessions.map(session => ({ ...session }))
  const manifest = { root: canonical, home, sessions, seed, now, systemDirectories, database, jobsFile,
    hermesJobIds: hermesJobs.map(job => `hermes-job:${job.id}`), historyRows: 10_000, plistCount: 1000 }
  states.set(manifest, state)
  await setPlistCount(manifest, 1000)
  return manifest
}
/** Replace every session at its existing path; readers must receive the returned identities. */
export async function rotateSessions(manifest, { generation, now }) {
  return exclusive(manifest, async state => {
    integer(generation, 'generation')
    const timestamp = instant(now)
    if (generation <= state.generation) throw new Error('Fixture generation must increase')
    const seed = digest(state.seed, 'generation', generation)
    const sessions = state.sessions.map((session, index) => ({
      file: session.file, sessionId: sessionId(seed, index),
      ...(index % 8 ? { parentSessionId: sessionId(seed, index - index % 8) } : {})
    }))
    const contents = sessions.map((session, index) => JSON.stringify({
      type: 'session', version: 3, id: session.sessionId, timestamp, cwd: state.root,
      ...(index % 8 ? { parentSession: sessions[index - index % 8].file } : {})
    }) + '\n' + JSON.stringify({ type: 'model_change', model: 'perf-fixture' }) + '\n')
    await pool(sessions, async (session, index) => {
      const handle = await ownedFile(state, session.file, constants.O_RDONLY)
      try {
        if (state.files.get(session.file).size > FIXTURE_LIMITS.sessionBytes || Buffer.byteLength(contents[index]) > FIXTURE_LIMITS.sessionBytes)
          throw new Error('Fixture session exceeds 512 KiB')
      } finally { await handle.close() }
    })
    await pool(sessions, async (session, index) => {
      // Keep the old descriptor open until replacement so its inode cannot be recycled.
      const previous = await ownedFile(state, session.file, constants.O_RDONLY)
      const staged = `${session.file}.rotate`
      try {
        await createFile(state, staged, contents[index], now)
        const replacement = await ownedFile(state, staged, constants.O_RDONLY)
        try {
          const old = state.files.get(session.file)
          const info = await fileStat(state, session.file, previous)
          if (info.ino !== old.ino || info.dev !== old.dev || info.size !== old.size ||
              info.mtimeMs !== old.mtimeMs || info.ctimeMs !== old.ctimeMs)
            throw new Error(`Fixture file concurrently modified: ${session.file}`)
          await checkParents(state, staged)
          await rename(staged, session.file)
          const next = await fileStat(state, session.file, replacement)
          const expected = state.files.get(staged)
          if (next.ino !== expected.ino || next.dev !== expected.dev || next.size !== expected.size)
            throw new Error(`Fixture replacement concurrently modified: ${session.file}`)
          state.files.set(session.file, fileIdentity(next))
          state.files.delete(staged)
          reserve(state, -old.size)
        } finally { await replacement.close() }
      } finally { await previous.close() }
    })
    state.generation = generation
    state.sessions = sessions.map(session => ({ ...session }))
    manifest.sessions = sessions
    return { generation, sessions, bytes: state.bytes }
  })
}

async function requireNoSqliteSidecars(state) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const file = state.database + suffix
    await checkParents(state, file)
    try { await lstat(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error(`Unowned fixture SQLite sidecar: ${file}`)
  }
}

/** Cycle terminal failures across all tasks so the newest 10000 rows retain pageable history for each. */
export async function appendHermesFailures(manifest, { sequence, now, count = 40 }) {
  return exclusive(manifest, async state => {
    integer(sequence, 'sequence')
    integer(count, 'count', HERMES_COUNT)
    if (!count) throw new Error('Fixture failure count must be positive')
    if (sequence <= state.hermesSequence) throw new Error('Fixture Hermes sequence must increase')
    const timestamp = instant(now)
    const namespace = digest(state.seed, 'namespace', 0).slice(0, 12)
    const executionIds = Array.from({ length: count }, (_, index) =>
      `perf-soak-${namespace}-${String(sequence).padStart(7, '0')}-${String(index).padStart(3, '0')}`)
    const database = state.database
    const handle = await ownedFile(state, database, constants.O_RDONLY)
    try {
      await requireNoSqliteSidecars(state)
      const originalSize = state.files.get(database).size
      if (originalSize > DATABASE_BYTES) throw new Error('Fixture SQLite exceeds its page budget')
      // Cover both database growth and SQLite's transient rollback journal before spawning.
      const reservation = DATABASE_BYTES - originalSize + JOURNAL_BYTES
      reserve(state, reservation)
      const values = executionIds.map((id, index) =>
        `('${id}','${state.hermesJobIds[(state.hermesNextJob + index) % HERMES_COUNT]}','cron','perf-fixture',1,NULL,'failed','${timestamp}','${timestamp}','${timestamp}',NULL,0,NULL,'failed',NULL,NULL)`)
      await sqlite(database, `PRAGMA journal_mode=DELETE; PRAGMA max_page_count=8192; PRAGMA hard_heap_limit=16777216;
PRAGMA busy_timeout=3000;
BEGIN IMMEDIATE;
INSERT INTO executions (id,job_id,source,process_id,pid,process_started_at,status,claimed_at,started_at,finished_at,error,handoff_pending,handoff_started_at,delivery_outcome,scheduled_instant,progress_at)
VALUES ${values.join(',')};
DELETE FROM executions WHERE rowid NOT IN (SELECT rowid FROM executions ORDER BY rowid DESC LIMIT 10000);
COMMIT;`)
      await requireNoSqliteSidecars(state)
      const info = await fileStat(state, database, handle)
      if (info.size > DATABASE_BYTES) throw new Error('Fixture SQLite exceeds its page budget')
      await finishWrite(state, database, handle, info.size)
      reserve(state, info.size - originalSize - reservation)
      state.hermesSequence = sequence
      state.hermesNextJob = (state.hermesNextJob + count) % HERMES_COUNT
      return { executionIds, count, bytes: state.bytes }
    } finally { await handle.close() }
  })
}


export async function writeEvents(manifest, { sessionCount, sequence, now }) {
  if (sessionCount !== 32 && sessionCount !== 128) throw new Error('Fixture sessionCount must be 32 or 128')
  integer(sequence, 'sequence')
  const timestamp = instant(now)
  return exclusive(manifest, async state => {
    const sessions = state.sessions.slice(0, sessionCount)
    const contents = sessions.map(session => JSON.stringify({ type: 'custom', customType: 'tool_execution_start', timestamp,
      data: { toolCallId: `perf:${session.sessionId}`, toolName: `perf_${sequence}` } }) + '\n')
    // Preflight the complete burst before appending anything; do not silently truncate.
    await pool(sessions, async (session, index) => {
      const handle = await ownedFile(state, session.file, constants.O_RDONLY)
      try {
        if (state.files.get(session.file).size + Buffer.byteLength(contents[index]) > FIXTURE_LIMITS.sessionBytes)
          throw new Error('Fixture session exceeds 512 KiB')
      } finally { await handle.close() }
    })
    reserve(state, contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0))
    return pool(sessions, async (session, index) => {
      const handle = await ownedFile(state, session.file, constants.O_WRONLY | constants.O_APPEND)
      try {
        await handle.writeFile(contents[index])
        await finishWrite(state, session.file, handle, state.files.get(session.file).size + Buffer.byteLength(contents[index]))
      } finally { await handle.close() }
      return { sessionId: session.sessionId, file: session.file, eventKey: `perf_${sequence}`, atMs: now }
    })
  })
}

export async function mutateSchedules(manifest, { sequence, count = 100 }) {
  integer(sequence, 'sequence')
  integer(count, 'count', 1000)
  if (!count) throw new Error('Fixture mutation count must be positive')
  return exclusive(manifest, async state => {
    if (sequence <= state.mutationSequence) throw new Error('Fixture mutation sequence must increase')
    const selected = Array.from({ length: 1000 }, (_, index) => ({ index, rank: digest(state.seed, 'mutation', index) }))
      .sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, count)
    const changes = selected.map(({ index }) => ({ index, file: path.join(state.home, 'Library/LaunchAgents', `${label(state.seed, index)}.plist`) }))
    await pool(changes, async ({ index, file }) => {
      const handle = await ownedFile(state, file, constants.O_WRONLY)
      try {
        const content = plist(state.seed, index, sequence + 1)
        const owned = state.files.get(file)
        reserve(state, Buffer.byteLength(content) - owned.size)
        await handle.truncate(0)
        await handle.writeFile(content)
        await handle.utimes((state.now + (sequence + 1) * 1000) / 1000, (state.now + (sequence + 1) * 1000) / 1000)
        await finishWrite(state, file, handle, Buffer.byteLength(content))
      } finally { await handle.close() }
    })
    state.mutationSequence = sequence
    return changes.map(({ index, file }) => ({ id: `launchd:user:${label(state.seed, index)}`, file }))
  })
}

export async function setPlistCount(manifest, count) {
  // The two lower boundaries include the fixture's 100 Hermes jobs in the shared 4096-job budget.
  if (![1000, 3996, 3997, 4096, 4097].includes(count)) throw new Error('Fixture plist count must be 1000, 3996, 3997, 4096 or 4097')
  return exclusive(manifest, async state => {
    const directory = path.join(state.home, 'Library/LaunchAgents')
    if (count > state.plistCount) {
      const indices = Array.from({ length: count - state.plistCount }, (_, index) => index + state.plistCount)
      await pool(indices, index => createFile(state, path.join(directory, `${label(state.seed, index)}.plist`), plist(state.seed, index)))
    } else {
      const indices = Array.from({ length: state.plistCount - count }, (_, index) => index + count)
      await pool(indices, async index => {
        const file = path.join(directory, `${label(state.seed, index)}.plist`)
        const handle = await ownedFile(state, file, constants.O_RDONLY)
        await handle.close()
        await unlink(file)
        state.bytes -= state.files.get(file).size
        state.files.delete(file)
      })
    }
    state.plistCount = count
    manifest.plistCount = count
    return count
  })
}

/** Keep a deliberately oversized record only for the caller's fault observation. */
export async function withOversizedSession(manifest, inspect) {
  if (typeof inspect !== 'function') throw new Error('A fault observer is required')
  return exclusive(manifest, async state => {
    const file = state.sessions[0].file
    const handle = await ownedFile(state, file, constants.O_WRONLY | constants.O_APPEND)
    const owned = state.files.get(file)
    const originalSize = owned.size
    const added = 256 * 1024
    let appended = false
    try {
      if (originalSize + added > FIXTURE_LIMITS.sessionBytes) throw new Error('Oversized fixture would exceed the session budget')
      reserve(state, added)
      const record = Buffer.alloc(added, 120)
      record[added - 1] = 10
      await handle.writeFile(record)
      await finishWrite(state, file, handle, originalSize + added)
      appended = true
      return await inspect()
    } finally {
      try {
        if (appended) {
          await handle.truncate(originalSize)
          await handle.utimes(Date.now() / 1000, Date.now() / 1000)
          await finishWrite(state, file, handle, originalSize)
          state.bytes -= added
        }
      } finally { await handle.close() }
    }
  })
}
