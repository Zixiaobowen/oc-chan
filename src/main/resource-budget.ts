import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResourceBudgetSnapshot, ResourceLimits, ResourceStatistics, ResourceUsage } from '../shared/resources'
import type { SourceStatus } from '../shared/types'

export const RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  commands: 8, files: 8, sockets: 8,
  commandBytes: 32 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, socketBytes: 512 * 1024,
  queued: 256, queuedPerSource: 128, sources: 32, queueTimeoutMs: 10_000
})

type Kind = 'command' | 'file' | 'socket'
type Outcome = 'completed' | 'failed' | 'cancelled'
type LimitReason = 'invalid-request' | 'request-too-large' | 'source-limit' | 'queue-full' | 'source-queue-full' | 'nested-request' | 'queue-timeout'
export class ResourceBudgetError extends Error {
  readonly code: 'OC_RESOURCE_LIMIT' | 'OC_RESOURCE_QUEUE_TIMEOUT'
  constructor(readonly reason: LimitReason) {
    super(reason === 'queue-timeout'
      ? '采集资源排队超时 / Collection resource queue timed out'
      : `采集资源受限 / Collection resource limited (${reason})`)
    this.name = 'ResourceBudgetError'
    this.code = reason === 'queue-timeout' ? 'OC_RESOURCE_QUEUE_TIMEOUT' : 'OC_RESOURCE_LIMIT'
  }
}

export function resourceAbortError(): Error & { code: 'ABORT_ERR' } {
  return Object.assign(new Error('采集已取消 / Collection cancelled'), { name: 'AbortError', code: 'ABORT_ERR' as const })
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw resourceAbortError()
}

export class ResourceCleanupError extends Error {
  readonly code = 'OC_RESOURCE_CLOSE'
  constructor(readonly resource: 'file' | 'command' | 'socket' | 'watcher', cause: unknown) {
    super('资源关闭失败 / Resource cleanup failed', { cause })
    this.name = 'ResourceCleanupError'
  }
}

function matchesResourceError(error: unknown, cleanup: boolean, budget: { remaining: number }, depth = 0): boolean {
  if (--budget.remaining < 0 || depth >= 8) return false
  try {
    if (error instanceof ResourceCleanupError) return cleanup
    if (!(error instanceof Error)) return false
    if (!(error instanceof AggregateError)) return !cleanup && Object.getOwnPropertyDescriptor(error, 'name')?.value === 'AbortError'
    const errors = Object.getOwnPropertyDescriptor(error, 'errors')?.value
    if (!Array.isArray(errors) || !errors.length || errors.length > 64) return false
    for (let index = 0; index < errors.length; index++) {
      const matches = matchesResourceError(Object.getOwnPropertyDescriptor(errors, String(index))?.value, cleanup, budget, depth + 1)
      if (matches === cleanup) return cleanup
    }
    return !cleanup
  } catch { return false }
}

export function isResourceCleanupFailure(error: unknown): boolean {
  return matchesResourceError(error, true, { remaining: 64 })
}
export function isResourceAbort(error: unknown): boolean {
  return matchesResourceError(error, false, { remaining: 64 })
}

/** A rejected sibling never releases ownership of work that is still running. */
export async function settleResourceWork<T extends readonly unknown[]>(work: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  try { return await Promise.all(work) }
  catch {
    const results = await Promise.allSettled(work)
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, '采集工作失败 / Collection work failed')
  }
}

export interface ResourceRequest {
  source: string
  kind: Kind
  stdoutBytes?: number
  stderrBytes?: number
  /** A command may own one bounded input file as part of the same atomic lease. */
  inputBytes?: number
  bytes?: number
  signal?: AbortSignal
}
export interface ResourceLease {
  readonly active: boolean
  readonly queueWaitMs: number
  release(outcome?: Outcome): void
}

type Statistics = { -readonly [K in keyof ResourceStatistics]: K extends 'current' | 'peak' ? ResourceUsage : ResourceStatistics[K] }
interface Waiting {
  request: ResourceRequest
  source: Statistics
  enqueuedAt: number
  order: number
  resolve: (lease: ResourceLease) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
interface Queue { order: string[]; sources: Map<string, Waiting[]> }
const kinds: readonly Kind[] = ['command', 'file', 'socket']
const usageKeys: readonly (keyof ResourceUsage)[] = ['commands', 'files', 'sockets', 'stdoutBytes', 'stderrBytes', 'commandBytes', 'fileBytes', 'socketBytes', 'queued']
const slots = { command: 'commands', file: 'files', socket: 'sockets' } as const
function usage(): ResourceUsage {
  return { commands: 0, files: 0, sockets: 0, stdoutBytes: 0, stderrBytes: 0, commandBytes: 0, fileBytes: 0, socketBytes: 0, queued: 0 }
}
function statistics(): Statistics {
  return { current: usage(), peak: usage(), admitted: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0,
    queueTimeouts: 0, totalWaitMs: 0, maxWaitMs: 0, totalExecutionMs: 0, maxExecutionMs: 0 }
}
function copy(stats: Statistics): ResourceStatistics {
  return { ...stats, current: { ...stats.current }, peak: { ...stats.peak } }
}
function updatePeak(stats: Statistics): void {
  for (const key of usageKeys) stats.peak[key] = Math.max(stats.peak[key], stats.current[key])
}
function charge(stats: Statistics, request: ResourceRequest, direction: 1 | -1): void {
  stats.current[slots[request.kind]] += direction
  if (request.kind === 'command') {
    stats.current.stdoutBytes += direction * request.stdoutBytes!
    stats.current.stderrBytes += direction * request.stderrBytes!
    stats.current.commandBytes += direction * (request.stdoutBytes! + request.stderrBytes!)
    if (request.inputBytes !== undefined) {
      stats.current.files += direction
      stats.current.fileBytes += direction * request.inputBytes
    }
  } else stats.current[request.kind === 'file' ? 'fileBytes' : 'socketBytes'] += direction * request.bytes!
  if (direction === 1) updatePeak(stats)
}
function waitTime(stats: Statistics, milliseconds: number): void {
  stats.totalWaitMs += milliseconds
  stats.maxWaitMs = Math.max(stats.maxWaitMs, milliseconds)
}

/** One app-wide pool. Round robin sources; a blocked head retains its turn until capacity drains. */
export class ResourceBudget {
  readonly limits: ResourceLimits
  private readonly global = statistics()
  private readonly sources = new Map<string, Statistics>()
  private readonly queues: Record<Kind, Queue> = {
    command: { order: [], sources: new Map() }, file: { order: [], sources: new Map() }, socket: { order: [], sources: new Map() }
  }
  private readonly context = new AsyncLocalStorage<ResourceLease>()
  private readonly waitingSignals = new Map<AbortSignal, { entries: Set<Waiting>; abort: () => void }>()
  private draining = false
  private nextQueueOrder = 0

  constructor(limits: Partial<ResourceLimits> = {}) {
    const configured = { ...RESOURCE_LIMITS, ...limits }
    for (const key of Object.keys(configured) as (keyof ResourceLimits)[]) {
      if (!Object.hasOwn(RESOURCE_LIMITS, key) || !Number.isSafeInteger(configured[key]) || configured[key] <= 0 || configured[key] > RESOURCE_LIMITS[key]) {
        throw new ResourceBudgetError('invalid-request')
      }
    }
    this.limits = Object.freeze(configured)
  }

  snapshot(): ResourceBudgetSnapshot {
    return { limits: this.limits, global: copy(this.global), sources: Array.from(this.sources, ([source, stats]) => ({ source, ...copy(stats) })) }
  }

  async run<T>(request: ResourceRequest, work: () => Promise<T>): Promise<T> {
    const signal = request.signal
    const lease = await this.acquire(request)
    let outcome: Outcome = 'completed'
    try {
      throwIfAborted(signal)
      return await this.context.run(lease, work)
    } catch (error) {
      outcome = isResourceAbort(error) ? 'cancelled' : 'failed'
      throw error
    } finally {
      lease.release(outcome)
    }
  }

  async acquire(input: ResourceRequest): Promise<ResourceLease> {
    const request = { ...input }
    let source: Statistics | undefined
    const reject = (reason: LimitReason): never => {
      this.global.rejected++
      if (source) source.rejected++
      throw new ResourceBudgetError(reason)
    }
    if (this.context.getStore()?.active) reject('nested-request')
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.source) || !kinds.includes(request.kind)) reject('invalid-request')
    source = this.sources.get(request.source)
    const validBytes = (bytes: number | undefined) => Number.isSafeInteger(bytes) && bytes! >= 0
    if (request.kind === 'command') {
      if (!validBytes(request.stdoutBytes) || !validBytes(request.stderrBytes) || request.bytes !== undefined) reject('invalid-request')
      if (request.stdoutBytes! > this.limits.commandBytes - request.stderrBytes!) reject('request-too-large')
      if (request.inputBytes !== undefined) {
        if (!validBytes(request.inputBytes)) reject('invalid-request')
        if (request.inputBytes > this.limits.fileBytes) reject('request-too-large')
      }
    } else {
      if (!validBytes(request.bytes) || request.stdoutBytes !== undefined || request.stderrBytes !== undefined || request.inputBytes !== undefined) reject('invalid-request')
      if (request.bytes! > (request.kind === 'file' ? this.limits.fileBytes : this.limits.socketBytes)) reject('request-too-large')
    }
    if (request.signal?.aborted) {
      this.global.cancelled++
      if (source) source.cancelled++
      throw resourceAbortError()
    }
    if (!source) {
      if (this.sources.size >= this.limits.sources) reject('source-limit')
      source = statistics()
      this.sources.set(request.source, source)
    }
    const queue = this.queues[request.kind]
    if (!queue.order.length && this.fits(request)) return this.admit(request, source, 0)
    if (this.global.current.queued >= this.limits.queued) reject('queue-full')
    if (source.current.queued >= this.limits.queuedPerSource) reject('source-queue-full')
    const owner = source
    return new Promise<ResourceLease>((resolve, rejectPromise) => {
      const entry: Waiting = { request, source: owner, enqueuedAt: performance.now(), order: this.nextQueueOrder++, resolve, reject: rejectPromise,
        timer: undefined! }
      entry.timer = setTimeout(() => this.remove(entry, true), this.limits.queueTimeoutMs)
      const pending = queue.sources.get(request.source)
      if (pending) pending.push(entry)
      else { queue.sources.set(request.source, [entry]); queue.order.push(request.source) }
      this.global.current.queued++
      owner.current.queued++
      updatePeak(this.global)
      updatePeak(owner)
      if (request.signal) {
        let group = this.waitingSignals.get(request.signal)
        if (!group) {
          const entries = new Set<Waiting>()
          group = { entries, abort: () => { for (const pending of entries) this.remove(pending, false) } }
          this.waitingSignals.set(request.signal, group)
          request.signal.addEventListener('abort', group.abort, { once: true })
        }
        group.entries.add(entry)
      }
      this.drain()
    })
  }

  private fits(request: ResourceRequest, order = Infinity): boolean {
    const current = this.global.current
    if (current[slots[request.kind]] >= this.limits[slots[request.kind]]) return false
    if (request.kind === 'command') {
      if (request.inputBytes !== undefined) {
        const files = this.queues.file
        const first = files.sources.get(files.order[0])?.[0]
        if (first && first.order < order) return false
        if (current.files >= this.limits.files || request.inputBytes > this.limits.fileBytes - current.fileBytes) return false
      }
      return request.stdoutBytes! + request.stderrBytes! <= this.limits.commandBytes - current.stdoutBytes - current.stderrBytes
    }
    if (request.kind === 'file') {
      const commands = this.queues.command
      const first = commands.sources.get(commands.order[0])?.[0]
      // An older composite request reserves its turn for file capacity as well as command capacity.
      if (first && first.request.inputBytes !== undefined && first.order < order) return false
    }
    return request.bytes! <= (request.kind === 'file' ? this.limits.fileBytes - current.fileBytes : this.limits.socketBytes - current.socketBytes)
  }

  private admit(request: ResourceRequest, source: Statistics, queuedMs: number): ResourceLease {
    charge(this.global, request, 1)
    charge(source, request, 1)
    this.global.admitted++
    source.admitted++
    waitTime(this.global, queuedMs)
    waitTime(source, queuedMs)
    const startedAt = performance.now()
    let active = true
    return { get active() { return active }, queueWaitMs: queuedMs, release: (outcome = 'completed') => {
      if (!active) return
      active = false
      const elapsed = performance.now() - startedAt
      charge(this.global, request, -1)
      charge(source, request, -1)
      this.global[outcome]++
      source[outcome]++
      this.global.totalExecutionMs += elapsed
      source.totalExecutionMs += elapsed
      this.global.maxExecutionMs = Math.max(this.global.maxExecutionMs, elapsed)
      source.maxExecutionMs = Math.max(source.maxExecutionMs, elapsed)
      this.drain()
    } }
  }

  private unqueue(entry: Waiting): number {
    clearTimeout(entry.timer)
    const signal = entry.request.signal
    const group = signal && this.waitingSignals.get(signal)
    if (group) {
      group.entries.delete(entry)
      if (!group.entries.size) {
        signal.removeEventListener('abort', group.abort)
        this.waitingSignals.delete(signal)
      }
    }
    this.global.current.queued--
    entry.source.current.queued--
    return performance.now() - entry.enqueuedAt
  }

  private remove(entry: Waiting, timedOut: boolean): void {
    const queue = this.queues[entry.request.kind]
    const pending = queue.sources.get(entry.request.source)
    const index = pending?.indexOf(entry) ?? -1
    if (index < 0) return
    pending!.splice(index, 1)
    if (!pending!.length) {
      queue.sources.delete(entry.request.source)
      queue.order.splice(queue.order.indexOf(entry.request.source), 1)
    }
    const elapsed = this.unqueue(entry)
    waitTime(this.global, elapsed)
    waitTime(entry.source, elapsed)
    if (timedOut) {
      this.global.queueTimeouts++
      entry.source.queueTimeouts++
      this.global.rejected++
      entry.source.rejected++
    } else { this.global.cancelled++; entry.source.cancelled++ }
    entry.reject(timedOut ? new ResourceBudgetError('queue-timeout') : resourceAbortError())
    this.drain()
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      for (const kind of kinds) {
        const queue = this.queues[kind]
        while (queue.order.length) {
          const sourceId = queue.order[0]
          const pending = queue.sources.get(sourceId)!
          const entry = pending[0]
          if (entry.request.signal?.aborted) { this.remove(entry, false); continue }
          // A large waiting request keeps its turn until its capacity becomes available.
          if (!this.fits(entry.request, entry.order)) break
          pending.shift()
          queue.order.shift()
          if (pending.length) queue.order.push(sourceId)
          else queue.sources.delete(sourceId)
          entry.resolve(this.admit(entry.request, entry.source, this.unqueue(entry)))
        }
      }
    } finally { this.draining = false }
  }
}

export const collectionResources = new ResourceBudget()

export function resourceSourceStatus(resources = collectionResources.snapshot()): SourceStatus {
  const { current, peak, rejected, queueTimeouts, maxWaitMs, maxExecutionMs } = resources.global
  const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(2)
  return {
    id: 'collection-resources', label: '采集资源额度', state: current.queued ? 'partial' : 'ok', resources,
    detail: `命令 ${current.commands}/${resources.limits.commands}（峰值 ${peak.commands}），文件读 ${current.files}/${resources.limits.files}（峰值 ${peak.files}），socket ${current.sockets}/${resources.limits.sockets}（峰值 ${peak.sockets}）；` +
      `输出预留 ${mib(current.commandBytes)}/${mib(resources.limits.commandBytes)} MiB（峰值 ${mib(peak.commandBytes)}，stdout / stderr 分别计费）；` +
      `文件预留 ${mib(current.fileBytes)}/${mib(resources.limits.fileBytes)} MiB（峰值 ${mib(peak.fileBytes)}），socket 预留 ${mib(current.socketBytes)}/${mib(resources.limits.socketBytes)} MiB（峰值 ${mib(peak.socketBytes)}）；` +
      `排队 ${current.queued}/${resources.limits.queued}（峰值 ${peak.queued}），累计拒绝 ${rejected}（排队超时 ${queueTimeouts}）；最长排队 ${Math.round(maxWaitMs)} ms / 执行 ${Math.round(maxExecutionMs)} ms。原始 IO 预留，不代表解析对象或全进程内存。`
  }
}
