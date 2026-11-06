import { mkdir, open, lstat } from 'node:fs/promises'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MAX_LOG_BYTES = 64 * 1024 * 1024
export const now = () => performance.timeOrigin + performance.now()

// One serial writer: no unbounded stream queue and no overwriting older evidence.
export class EvidenceLog {
  constructor(directory, { maxBytes = MAX_LOG_BYTES, chunkBytes = 4 * 1024 * 1024, gzip = false } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_BYTES ||
        !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > maxBytes) throw new Error('Invalid evidence budget')
    this.directory = directory
    this.maxBytes = maxBytes
    this.chunkBytes = chunkBytes
    this.bytes = 0
    this.rawBytes = 0
    this.gzip = gzip
    this.chunkSize = 0
    this.chunk = 0
    this.queued = 0
    this.chain = Promise.resolve()
    this.failure = null
    this.closed = false
  }
  async initialize() {
    await mkdir(this.directory)
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('Evidence directory must not be a symlink')
  }
  append(value) {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error('Evidence log is closed'))
    const line = JSON.stringify(value) + '\n'
    const size = Buffer.byteLength(line)
    if (size > this.chunkBytes || (!this.gzip && this.bytes + size > this.maxBytes) || this.queued + size > 1024 * 1024) {
      this.failure = new Error('Evidence byte/record/queue budget exceeded; run is incomplete')
      return Promise.reject(this.failure)
    }
    this.rawBytes += size
    if (!this.gzip) this.bytes += size
    this.queued += size
    const writing = this.chain.then(async () => {
      if (this.failure) throw this.failure
      if (!this.file || this.chunkSize + size > this.chunkBytes) {
        await this.closeChunk()
        this.file = await open(path.join(this.directory, `samples-${String(this.chunk++).padStart(3, '0')}.jsonl${this.gzip ? '.gz' : ''}`), 'wx', 0o600)
        this.chunkSize = 0
        if (this.gzip) {
          this.compressor = createGzip()
          const sink = new Writable({ write: (buffer, _encoding, callback) => {
            if (this.bytes + buffer.length > this.maxBytes) { callback(new Error('Compressed evidence disk budget exceeded; run is incomplete')); return }
            this.file.writeFile(buffer).then(() => { this.bytes += buffer.length; callback() }, callback)
          } })
          this.compression = pipeline(this.compressor, sink)
          // Observe asynchronous compression/disk failures even between append calls.
          this.compression.catch(error => { this.failure = error })
        }
      }
      if (this.gzip) await new Promise((resolve, reject) => this.compressor.write(line, error => error ? reject(error) : resolve()))
      else await this.file.writeFile(line)
      this.chunkSize += size
    }).finally(() => { this.queued -= size })
    this.chain = writing.catch(error => { this.failure = error })
    return writing
  }
  async closeChunk() {
    try {
      if (this.compressor) { this.compressor.end(); await this.compression }
    } finally {
      this.compressor = undefined
      this.compression = undefined
      await this.file?.close()
      this.file = undefined
    }
  }
  async close() {
    this.closed = true
    await this.chain
    await this.closeChunk()
    if (this.failure) throw this.failure
  }
}

// Fixed 0.25 ms bins through 60 s. Out-of-range samples are reported, never clipped.
export class Distribution {
  constructor() { this.bins = new Uint32Array(240001); this.count = 0; this.overflow = 0; this.sum = 0; this.max = 0 }
  add(value) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${value}`)
    this.count++
    this.sum += value
    this.max = Math.max(this.max, value)
    const bin = Math.ceil(value * 4)
    if (bin >= this.bins.length) this.overflow++
    else this.bins[bin]++
  }
  percentile(fraction) {
    if (!this.count) return null
    const target = Math.ceil(this.count * fraction)
    let count = 0
    for (let index = 0; index < this.bins.length; index++) {
      count += this.bins[index]
      if (count >= target) return index / 4
    }
    return null
  }
  result() {
    return { count: this.count, p50: this.percentile(.5), p95: this.percentile(.95), p99: this.percentile(.99),
      max: this.count ? this.max : null, mean: this.count ? this.sum / this.count : null, overflow: this.overflow, resolutionMs: .25 }
  }
}

export class Protocol {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    this.events = new Map()
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error('Protocol frame budget exceeded')
        const message = JSON.parse(event.data)
        const request = this.pending.get(message.id)
        if (request) {
          this.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new Error(JSON.stringify(message.error)))
          else request.resolve(message.result)
        } else if (message.method) this.events.get(message.method)?.(message.params)
      } catch (error) { this.close(error) }
    })
    socket.addEventListener('close', () => this.close(new Error('Protocol connection closed')))
    socket.addEventListener('error', () => this.close(new Error('Protocol connection failed')))
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    const protocol = new Protocol(socket)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Protocol connection timed out')) }, 10000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Protocol connection failed')) }, { once: true })
    })
    return protocol
  }
  call(method, params = {}, timeout = 15000) {
    if (this.socket.readyState !== WebSocket.OPEN || this.pending.size >= 32) return Promise.reject(new Error('Protocol unavailable or pending limit reached'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Protocol timeout: ${method}`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeout = 15000) {
    const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result?.value
  }
  close(error = new Error('Protocol disconnected')) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
    this.events.clear()
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close()
  }
}

export function readLines(stream, consume, fail, maxLineBytes = 256 * 1024) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    try {
      pending += chunk
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('Output queue budget exceeded')
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (Buffer.byteLength(line) > maxLineBytes) throw new Error('Output line budget exceeded')
        consume(line)
      }
      if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Output line budget exceeded')
    } catch (error) { fail(error) }
  })
  stream.on('end', () => { if (pending) { try { consume(pending) } catch (error) { fail(error) } } })
  stream.on('error', fail)
}

export async function until(predicate, { timeout = 30000, signal, interval = 50 } = {}) {
  const deadline = now() + timeout
  while (true) {
    signal?.throwIfAborted()
    const result = await predicate()
    if (result) return result
    if (now() >= deadline) throw new Error('Condition deadline exceeded')
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, interval)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
