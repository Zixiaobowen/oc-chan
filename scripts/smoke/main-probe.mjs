import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { constants } from 'node:fs'
import { open, lstat, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { until } from '../performance/core.mjs'
import { prepareFixtures } from '../performance/fixtures.mjs'

export async function boundedFile(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && stat.size <= maximum, `Unsafe bounded file: ${filename}`)
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    assert.equal(offset, stat.size, 'File changed while reading')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}
export async function absent(filename) {
  try { await lstat(filename); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
export class Driver {
  static async open(receipt, record) {
    assert.equal(receipt.protocol, 'OC_CHAN_ACCEPTANCE_DRIVER_V1')
    assert(Number.isSafeInteger(receipt.pid) && receipt.pid > 0)
    assert.match(receipt.driverDirectory, new RegExp(`^/tmp/ocwk-${receipt.pid}-[0-9a-f]{12}$`))
    const directory = receipt.driverDirectory
    const identity = await lstat(directory)
    assert(identity.isDirectory() && !identity.isSymbolicLink() && identity.uid === process.getuid() && (identity.mode & 0o777) === 0o700)
    const tokenPath = path.join(directory, 'token')
    const stat = await lstat(tokenPath)
    assert.equal(stat.mode & 0o777, 0o600)
    const token = (await boundedFile(tokenPath, 64)).toString('utf8')
    assert.match(token, /^[a-f0-9]{64}$/)
    const socket = await lstat(path.join(directory, 'driver.sock'))
    assert(socket.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o777) === 0o600)
    return new Driver(receipt, identity, token, record)
  }
  constructor(receipt, identity, token, record) {
    this.receipt = receipt; this.identity = identity; this.token = token; this.record = record
    this.sequence = 0; this.pending = 0; this.queue = Promise.resolve(); this.closed = false
    this.socket = connect(path.join(receipt.driverDirectory, 'driver.sock'))
    this.socket.on('error', error => { this.failure = error })
    this.connected = new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject) })
    this.connected.catch(error => { this.failure = error })
  }
  async request(command, fields = {}, timeout = 16000) {
    assert(!this.closed, 'Driver is closed')
    assert(this.pending < 16, 'Client request admission exceeded')
    this.pending++
    const queuedAt = performance.now()
    let startedAt, status = 'failed'
    const operation = this.queue.then(() => {
      startedAt = performance.now()
      return this.exchange(command, fields, timeout)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    try { const value = await operation; status = 'passed'; return value }
    finally {
      this.pending--
      const finishedAt = performance.now()
      // Emit only slow/failed operations; never retain scripts, tokens or replies.
      // This distinguishes socket/native/WK latency from collector resource time.
      if (status === 'failed' || finishedAt - queuedAt >= 250) this.record?.('driver-operation', {
        command, view: fields.view ?? null, action: fields.action ?? null, status,
        queueMs: (startedAt ?? finishedAt) - queuedAt,
        executionMs: startedAt === undefined ? 0 : finishedAt - startedAt
      })
    }
  }
  async exchange(command, fields, timeout) {
    assert(!this.closed, 'Driver is closed')
    if (this.failure) throw this.failure
    const id = ++this.sequence
    const frame = Buffer.from(JSON.stringify({ ...fields, command, token: this.token, id }) + '\n')
    assert(frame.length <= 256 * 1024, 'Driver request exceeds 256KiB')
    const socket = this.socket
    let timer, onData, onClose, onError, bytes = Buffer.alloc(0), reply
    try {
      reply = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`WK ${command} deadline exceeded`)), Math.min(timeout, 16000))
        onClose = () => reject(new Error(`WK ${command} disconnected before completion`))
        onError = reject
        onData = chunk => {
          try {
            assert(bytes.length + chunk.length <= 1024 * 1024 + 1, 'Driver response exceeds 1MiB')
            bytes = Buffer.concat([bytes, chunk])
            const end = bytes.indexOf(10)
            if (end < 0) return
            assert.equal(end + 1, bytes.length, 'Unexpected additional driver response')
            const response = JSON.parse(bytes.subarray(0, end).toString('utf8'))
            assert.equal(response.id, id, 'Driver response identity mismatch')
            resolve(response.result)
          } catch (error) { reject(error) }
        }
        socket.once('error', onError); socket.once('close', onClose); socket.on('data', onData)
        this.connected.then(() => socket.write(frame), reject)
      })
    } catch (error) { this.failure = error; socket.destroy(); throw error }
    finally { clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose); socket.off('error', onError) }
    if (reply?.ok !== true) throw new Error(`WK ${command}: ${reply?.error ?? 'invalid response'}`)
    return reply.value
  }
  async waitForView(view, options = {}) {
    assert(this.receipt.views.includes(view), `Window ${view} was not admitted`)
    await until(async () => {
      const info = await this.host('info')
      assert(Array.isArray(info.windows), 'Host omitted its window registration state')
      return info.windows.some(window => window.view === view)
    }, { timeout: 60000, ...options })
  }
  view(view = 'main') {
    assert(this.receipt.views.includes(view), `Window ${view} was not admitted`)
    const request = (command, fields = {}, timeout) => this.request(command, { ...fields, view }, timeout)
    const evaluate = async (expression, timeout = 15000) => {
      const deadline = Date.now() + timeout; let state
      while (Date.now() < deadline) {
        state = await request('inspect', {}, Math.max(1, deadline - Date.now()))
        if (state.loading === false && typeof state.url === 'string' && state.url && state.url !== 'about:blank') {
          return request('eval', { script: `return JSON.stringify((await (${expression})) ?? null);` }, Math.max(1, deadline - Date.now()))
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      }
      throw new Error(`WK document loading deadline exceeded: ${JSON.stringify(state)}`)
    }
    return {
      evaluate,
      inspect: () => request('inspect'), capture: () => request('capture'), reload: () => request('reload'),
      resize: (width, height) => request('resize', { width, height }),
      mouse: (kind, x, y, button = 'left') => {
        assert(button === 'left' || button === 'right', 'Unsupported mouse button: expected left or right')
        return request('mouse', { input: { kind, x, y, button } })
      },
      clickAt: async (x, y) => {
        await request('mouse', { input: { kind: 'move', x, y, button: 'left' } })
        await request('mouse', { input: { kind: 'down', x, y, button: 'left' } })
        await request('mouse', { input: { kind: 'up', x, y, button: 'left' } })
      },
      key: (key, code = key, modifiers = 0) => request('key', { input: { key, code, modifiers } }),
      selectAll: () => request('select-all', { input: {} }),
      text: text => request('text', { input: { text } })
    }
  }
  host(action, fields = {}) { return this.request('host', { ...fields, action }) }
  close() { this.closed = true; this.socket?.destroy(); this.token = '' }
}

// These are real local processes with real session/lease descriptors. The Rust collector
// discovers them through ps/lsof and parses their on-disk metadata; no provider is replaced.
export async function prepareSmokeFixtures(directory, seed = 20261104, sessionCount = 32) {
  assert([32, 128].includes(sessionCount), 'Fixture sessions must be 32 or 128')
  const manifest = await prepareFixtures(directory, { seed, now: Date.now() })
  const sessions = path.join(manifest.home, '.omp/agent/sessions')
  const owners = path.join(manifest.home, '.omp/run/session-owners')
  const hosts = path.join(manifest.home, '.omp/run/collab-hosts')
  const entry = path.join(manifest.root, '@oh-my-pi/pi-coding-agent/dist/cli.js')
  for (const item of [sessions, owners, hosts, path.dirname(entry)]) await mkdir(item, { recursive: true, mode: 0o700 })
  await writeFile(path.join(path.dirname(path.dirname(entry)), 'package.json'), JSON.stringify({ type:'module', private:true }), { flag:'wx', mode:0o600 })
  await writeFile(entry, `import fs from 'node:fs'
const fds = []
let closing = false, adoptionTimer
function close(error) {
  if (closing) return
  closing = true
  clearTimeout(adoptionTimer)
  const failures = error ? [error] : []
  for (const fd of fds) {
    try { fs.closeSync(fd) } catch (failure) { failures.push(failure) }
  }
  if (failures.length) {
    const message = failures.map(failure => String(failure.message).slice(0, 128)).join('; ').slice(0, 2048)
    process.stderr.write('Fixture failure: ' + message + '\\n', () => process.exit(1))
  } else process.exit(0)
}
process.stdin.on('end', () => close())
process.stdin.on('error', close)
process.on('SIGTERM', () => close())
process.on('SIGINT', () => close())
process.stdin.resume()
try {
  for (const file of JSON.parse(process.env.OC_ACCEPTANCE_FILES)) fds.push(fs.openSync(file, 'r+'))
  const deadline = Date.now() + 3000
  function awaitAdoption() {
    if (closing) return
    if (process.ppid === 1) {
      process.stdout.write(JSON.stringify({ protocol: 'OC_CHAN_FIXTURE_READY_V1', pid: process.pid, ppid: process.ppid }) + '\\n')
    } else if (Date.now() >= deadline) close(new Error('Fixture adoption deadline exceeded; ppid=' + process.ppid))
    else adoptionTimer = setTimeout(awaitAdoption, 20)
  }
  awaitAdoption()
} catch (error) { close(error) }
`, { flag: 'wx', mode: 0o600 })
  // Only the launcher is our ChildProcess. Its inherited pipes keep the real fixture
  // reachable after adoption by PID 1, and smoke exit naturally delivers stdin EOF.
  const launcherSource = `import { spawn } from 'node:child_process'
try {
  const child = spawn(process.execPath, [process.argv[1]], { stdio: [0, 1, 2] })
  child.once('error', error => {
    process.exitCode = 1
    process.stderr.write('Fixture launcher failure: ' + String(error.message).slice(0, 1024) + '\\n')
  })
  child.once('spawn', () => child.unref())
} catch (error) {
  process.exitCode = 1
  process.stderr.write('Fixture launcher failure: ' + String(error.message).slice(0, 1024) + '\\n')
}`
  const children = []; const ids = []; const files = []
  const pidExists = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  let stopPromise
  const stop = () => stopPromise ??= (async () => {
    // End every pipe before waiting, including launchers whose fixture is not ready.
    for (const state of children) {
      state.stopping = true
      try { state.stdin.end() } catch (error) { state.fail('stdin-end', error) }
    }
    const results = await Promise.all(children.map(async state => {
      const failures = []
      try {
        await until(() => state.launcherDone && state.child.stdout.closed && state.child.stderr.closed, { timeout: 5000 })
      } catch (error) {
        failures.push(new Error(`Fixture ${state.pid ?? 'not ready'} inherited output pipes or launcher did not close; preserving process`, { cause: error }))
      }
      if (state.pid !== undefined) {
        try { await until(() => !pidExists(state.pid), { timeout: 5000 }) }
        catch (error) {
          failures.push(new Error(`Fixture PID ${state.pid} still exists, was reused, or could not be inspected; preserving process without signalling`, { cause: error }))
        }
      }
      return [...state.failures.values(), ...failures]
    }))
    const failures = results.flat()
    if (failures.length) throw new AggregateError(failures, 'Fixture process cleanup failed')
  })()
  try {
    for (let branch = 0; branch < sessionCount / 8; branch++) {
      const mainId = randomUUID(), rootFile = path.join(sessions, mainId + '.jsonl'), branchDirectory = path.join(sessions, mainId)
      await mkdir(branchDirectory, { mode: 0o700 })
      const descriptors = []
      for (let index = 0; index < 8; index++) {
        const id = index ? randomUUID() : mainId
        const file = index ? path.join(branchDirectory, `worker-${index}.jsonl`) : rootFile
        const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: manifest.root, ...(index ? { parentSession: rootFile } : {}) }
        await writeFile(file, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'model_change', model: 'acceptance-fixture' }) + '\n', { flag: 'wx', mode: 0o600 })
        const lease = path.join(owners, id + '.lock')
        await writeFile(lease, '', { flag: 'wx', mode: 0o600 })
        descriptors.push(file, lease); ids.push(`omp:${id}`); files.push(file)
      }
      const child = spawn(process.execPath, ['--input-type=module', '-e', launcherSource, entry], { cwd: manifest.root, env: { PATH: process.env.PATH, HOME: manifest.home, OC_ACCEPTANCE_FILES: JSON.stringify(descriptors) }, stdio: ['pipe', 'pipe', 'pipe'] })
      // Node automatically destroys child.stdin when the launcher exits. Transfer
      // ownership so only smoke closes the inherited input pipe and delivers EOF.
      const state = { child, stdin: child.stdin, pid: undefined, launcherDone: false, stopping: false, failures: new Map(), rejectStartup: undefined }
      child.stdin = null
      state.fail = (kind, error) => {
        if (!state.failures.has(kind)) state.failures.set(kind, error)
        state.rejectStartup?.(error)
      }
      children.push(state)
      await new Promise((resolve, reject) => {
        let output = Buffer.alloc(0), totalBytes = 0, ready = false, settled = false
        const timer = setTimeout(() => done(new Error('Fixture process readiness deadline')), 5000)
        const done = error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.rejectStartup = undefined
          error ? reject(error) : resolve()
        }
        state.rejectStartup = done
        const maybeReady = () => {
          if (ready && state.launcherDone && state.failures.size === 0) done()
        }
        child.once('error', error => { state.launcherDone = true; state.fail('launcher-error', error) })
        child.once('exit', (code, signal) => {
          state.launcherDone = true
          if (code !== 0 || signal !== null) state.fail('launcher-exit', new Error(`Fixture launcher exited unsuccessfully: code=${code}, signal=${signal}`))
          else maybeReady()
        })
        state.stdin.on('error', error => state.fail('stdin-error', error))
        for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          stream.on('error', error => state.fail(`${name}-error`, error))
          stream.once('close', () => {
            if (!state.stopping) state.fail(`${name}-close`, new Error(`Fixture ${state.pid ?? 'not ready'} ${name} closed unexpectedly`))
          })
        }
        const admitOutput = chunk => {
          totalBytes = Math.min(4097, totalBytes + chunk.length)
          if (totalBytes <= 4096) return true
          state.fail('output-limit', new Error('Fixture stdout/stderr exceeds 4096 bytes'))
          return false
        }
        child.stderr.on('data', chunk => {
          if (admitOutput(chunk)) state.fail('stderr', new Error(`Fixture stderr: ${chunk.toString('utf8').slice(0, 2048)}`))
        })
        child.stdout.on('data', chunk => {
          if (!admitOutput(chunk)) return
          try {
            assert(!ready, 'Fixture emitted output after READY')
            output = Buffer.concat([output, chunk])
            const end = output.indexOf(10)
            if (end < 0) return
            assert.equal(end + 1, output.length, 'Unexpected additional fixture response')
            const message = JSON.parse(output.subarray(0, end).toString('utf8'))
            assert(message !== null && typeof message === 'object' && !Array.isArray(message), 'Invalid fixture READY object')
            assert.equal(Object.keys(message).sort().join(','), 'pid,ppid,protocol', 'Invalid fixture READY fields')
            assert.equal(message.protocol, 'OC_CHAN_FIXTURE_READY_V1')
            assert(Number.isSafeInteger(message.pid) && message.pid > 1 && message.pid <= 2147483647 && message.pid !== child.pid && message.pid !== process.pid, 'Invalid real fixture PID')
            assert.equal(message.ppid, 1, 'Fixture still has a CLI ancestor')
            state.pid = message.pid
            ready = true
            maybeReady()
          } catch (error) { state.fail('ready-protocol', error) }
        })
      })
    }
    const failures = children.flatMap(state => [...state.failures.values()])
    if (failures.length) throw new AggregateError(failures, 'Fixture failed during startup')
    return Object.assign(manifest, { agentIds: ids, agentFiles: files, agentPids: children.map(state => state.pid), stopAgents: stop })
  } catch (error) { try { await stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture startup and cleanup failed') } throw error }
}
