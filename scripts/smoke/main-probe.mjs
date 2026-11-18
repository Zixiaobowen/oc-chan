import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import path from 'node:path'
import { until } from '../performance/core.mjs'
export { prepareSmokeFixtures } from '../performance/agent-fixtures.mjs'

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
