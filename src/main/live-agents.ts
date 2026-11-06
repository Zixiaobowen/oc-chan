import { watch, type FSWatcher } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_ACTIVITY_WINDOW_MS, AGENT_DISCOVERY_INTERVAL_MS, type AgentActivity, type AgentInfo, type AgentSnapshot, type SourceStatus } from '../shared/types'
import { discoverAgents, type AgentDiscovery } from './collectors/agents'
import { SessionActivityReader, type ActivityRead } from './collectors/agent-activity'
import { isResourceAbort, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from './resource-budget'

const coalesceMs = 90
const publishMs = 16
const maxSessions = 128
interface WatchRegistration { watcher: FSWatcher; closed: Promise<void> }
interface SessionWatch {
  path: string
  sessionId: string
  reader?: Pick<SessionActivityReader, 'read'>
  watcher?: WatchRegistration
  result?: ActivityRead
  error?: string
  timer?: NodeJS.Timeout
  dirty: boolean
  reading: boolean
  active: boolean
  revision: number
  controller: AbortController
  pendingRead?: Promise<void>
  closing?: Promise<void>
}
export interface LiveAgentsOptions {
  discover?: (signal?: AbortSignal) => Promise<AgentDiscovery>
  signal?: AbortSignal
  createReader?: () => Pick<SessionActivityReader, 'read'>
  watchFile?: (path: string, listener: (event: string) => void) => FSWatcher
}

function sameActivity(before: AgentActivity | undefined, after: AgentActivity | undefined): boolean {
  return before === after || !!before && !!after && before.kind === after.kind && before.name === after.name && before.observedAt === after.observedAt
}

// Discovery owns topology/resource facts; file callbacks only replace a session's
// activity in the latest discovery. Each file has its own bounded read lane.
export class LiveAgents {
  private readonly entries = new Map<string, SessionWatch>()
  private readonly bySession = new Map<string, SessionWatch>()
  private readonly projections = new Map<string, { base: AgentInfo; value: AgentInfo }>()
  private publishTimer?: NodeJS.Timeout
  private base?: AgentSnapshot
  private stopped = false
  private pending?: Promise<void>
  private stopping?: Promise<void>
  private readonly reads = new Set<Promise<void>>()
  private readonly closing = new Set<Promise<void>>()
  private readonly watchers = new Set<FSWatcher>()
  private cleanupFailure: unknown
  private cleanupFailures = 0
  private readonly discover: NonNullable<LiveAgentsOptions['discover']>
  private readonly controller = new AbortController()
  private readonly parentSignal?: AbortSignal
  private readonly abort = (): void => { void this.stop() }
  private readonly createReader: () => Pick<SessionActivityReader, 'read'>
  private readonly watchFile: NonNullable<LiveAgentsOptions['watchFile']>

  constructor(private readonly publish: (snapshot: AgentSnapshot) => void, options: LiveAgentsOptions = {}) {
    this.discover = options.discover ?? discoverAgents
    this.createReader = options.createReader ?? (() => new SessionActivityReader())
    this.watchFile = options.watchFile ?? ((path, listener) => watch(path, { persistent: false }, listener))
    this.parentSignal = options.signal
    if (this.parentSignal?.aborted) void this.stop()
    else this.parentSignal?.addEventListener('abort', this.abort, { once: true })
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending) return this.pending
    const operationSignal = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal
    if (operationSignal.aborted) return Promise.reject(operationSignal.reason)
    this.pending = this.discover(operationSignal).then(async ({ snapshot, sessions }) => {
      if (this.stopped) return
      throwIfAborted(operationSignal)
      const owned = new Set(snapshot.agents.filter(agent => agent.runtime === 'OMP').map(agent => agent.sessionId))
      const current = new Map(sessions.filter(session => owned.has(session.sessionId)).slice(0, maxSessions).map(session => [session.file, session]))
      for (const [path, entry] of this.entries) {
        if (current.get(path)?.sessionId === entry.sessionId) continue
        this.close(entry)
        this.entries.delete(path)
      }
      // Removed entries still own readers/watchers until they close. Drain them before
      // admitting replacements, so repeated discovery cannot accumulate retired work.
      await Promise.all(this.closing)
      if (this.stopped) return
      throwIfAborted(operationSignal)
      this.base = snapshot
      this.bySession.clear()
      const ids = new Set(snapshot.agents.map(agent => agent.id))
      for (const id of this.projections.keys()) if (!ids.has(id)) this.projections.delete(id)
      for (const [path, session] of current) {
        let entry = this.entries.get(path)
        if (!entry) {
          entry = { path, sessionId: session.sessionId, reader: this.createReader(), dirty: false, reading: false, active: true, revision: 0, controller: new AbortController() }
          this.entries.set(path, entry)
        }
        this.bySession.set(session.sessionId, entry)
        if (!entry.watcher) {
          if (entry.closing) await entry.closing
          if (this.stopped) return
          throwIfAborted(operationSignal)
          this.attach(entry)
        }
      }
      this.emit()
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    this.stopping = Promise.resolve().then(async () => {
      if (this.pending) {
        try { await this.pending }
        catch (error) { this.recordCleanupFailure(error) }
      }
      await Promise.all([...this.reads, ...this.closing])
      if (this.cleanupFailures) throw new AggregateError([this.cleanupFailure], `Live agent cleanup failed (${this.cleanupFailures} failures)`)
    })
    // Abort listeners cannot await. Retain their rejection while keeping the original
    // stopping promise rejected for every caller of stop().
    void this.stopping.catch(error => { this.cleanupFailure ??= error })
    this.parentSignal?.removeEventListener('abort', this.abort)
    this.controller.abort()
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
    this.bySession.clear()
    this.projections.clear()
    this.base = undefined
    return this.stopping
  }

  diagnostics(): { stopped: boolean; pendingDiscovery: boolean; pendingReads: number; watchers: number; timers: number; closing: number } {
    let timers = Number(this.publishTimer !== undefined)
    for (const entry of this.entries.values()) if (entry.timer) timers++
    return { stopped: this.stopped, pendingDiscovery: this.pending !== undefined, pendingReads: this.reads.size,
      watchers: this.watchers.size, timers, closing: this.closing.size }
  }

  private recordCleanupFailure(error: unknown): void {
    if (isResourceAbort(error)) return
    // Keep bounded evidence even if a source repeatedly fails during a long lifetime.
    if (this.cleanupFailures++ === 0) this.cleanupFailure = error
  }

  private close(entry: SessionWatch): void {
    entry.active = false
    entry.result = undefined
    entry.error = undefined
    this.drainEntry(entry)
  }

  private drainEntry(entry: SessionWatch): void {
    entry.controller.abort()
    entry.dirty = false
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.closing) return
    const registration = entry.watcher
    entry.watcher = undefined
    if (registration) {
      try { registration.watcher.close() }
      catch (error) { this.recordCleanupFailure(new ResourceCleanupError('watcher', error)) }
    }
    const closing = Promise.all([registration?.closed, entry.pendingRead]).then(() => {
      if (!entry.active) entry.reader = undefined
    }).finally(() => {
      this.closing.delete(closing)
      if (entry.closing === closing) entry.closing = undefined
    })
    entry.closing = closing
    this.closing.add(closing)
  }

  private attach(entry: SessionWatch): void {
    try {
      if (entry.controller.signal.aborted) entry.controller = new AbortController()
      const listener = (event: string): void => {
        if (this.stopped || !entry.active) return
        if (event === 'rename') {
          this.fail(entry, '会话文件被移动、替换或删除，等待下一次进程发现重新确认')
          return
        }
        this.enqueue(entry)
      }
      const watcher = this.watchFile(entry.path, listener)
      const onError = (error: Error): void => {
        if (entry.watcher?.watcher === watcher && entry.active && !this.stopped) this.fail(entry, this.failure('会话监听失败', error))
        else this.recordCleanupFailure(new ResourceCleanupError('watcher', error))
      }
      const closed = new Promise<void>(resolve => {
        watcher.once('close', () => {
          watcher.off('change', listener)
          watcher.off('error', onError)
          this.watchers.delete(watcher)
          resolve()
        })
      })
      this.watchers.add(watcher)
      entry.watcher = { watcher, closed }
      watcher.on('error', onError)
      entry.error = undefined
      entry.result = undefined
      this.enqueue(entry)
    } catch (error) { this.fail(entry, this.failure('会话监听失败', error)) }
  }

  private failure(label: string, error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return `${label}（${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'IO_FAILED'}）`
  }

  private fail(entry: SessionWatch, message: string): void {
    if (this.stopped || !entry.active) return
    entry.revision++
    this.drainEntry(entry)
    entry.error = message
    entry.result = undefined
    this.queuePublish()
  }

  private enqueue(entry: SessionWatch): void {
    entry.dirty = true
    // A fixed window from the first event cannot be extended by a continuous burst.
    if (entry.timer || entry.reading || this.stopped || !entry.active) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      const work = this.read(entry).catch(error => { this.recordCleanupFailure(error) }).finally(() => {
        this.reads.delete(work)
        if (entry.pendingRead === work) entry.pendingRead = undefined
      })
      entry.pendingRead = work
      this.reads.add(work)
    }, coalesceMs)
  }

  private async read(entry: SessionWatch): Promise<void> {
    if (this.stopped || !entry.active || !entry.watcher || !entry.reader) return
    entry.reading = true
    entry.dirty = false
    const revision = entry.revision
    try {
      const result = await entry.reader.read(entry.path, undefined, entry.controller.signal)
      if (this.stopped || !entry.active || revision !== entry.revision) return
      const failed = result.issues.find(issue => issue.startsWith('会话读取失败'))
      if (failed) { this.fail(entry, failed); return }
      const previous = entry.result
      entry.result = result
      if (!previous || !sameActivity(previous.activity, result.activity) || previous.issues.length !== result.issues.length ||
        previous.issues.some((issue, index) => issue !== result.issues[index])) this.queuePublish()
    } catch (error) {
      if (isResourceCleanupFailure(error) || this.stopped || !entry.active) this.recordCleanupFailure(error)
      if (!isResourceAbort(error) && revision === entry.revision) this.fail(entry, this.failure('会话读取失败', error))
    } finally {
      entry.reading = false
      if (entry.dirty && entry.watcher) this.enqueue(entry)
    }
  }

  private queuePublish(): void {
    // One fixed deadline for all completed reads; later events never postpone it.
    if (!this.publishTimer && !this.stopped) this.publishTimer = setTimeout(() => this.emit(), publishMs)
  }

  private emit(): void {
    clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    if (this.stopped || !this.base) return
    const now = Date.now()
    let observed = 0
    let incomplete = 0
    let errors = 0
    const issues = new Set<string>()
    const agents = this.base.agents.map(agent => {
      const entry = agent.sessionId ? this.bySession.get(agent.sessionId) : undefined
      const candidate = !entry?.error ? entry?.result?.activity : undefined
      const age = candidate ? now - Date.parse(candidate.observedAt) : -1
      const activity = age >= 0 && age < AGENT_ACTIVITY_WINDOW_MS ? candidate : undefined
      if (activity) observed++
      const previous = this.projections.get(agent.id)
      if (previous && sameActivity(previous.value.activity, activity) && isDeepStrictEqual(previous.base, agent)) {
        previous.base = agent
        return previous.value
      }
      const value = activity ? { ...agent, activity } : agent
      this.projections.set(agent.id, { base: agent, value })
      return value
    })
    let watching = 0
    for (const entry of this.entries.values()) {
      if (entry.watcher) watching++
      if (entry.error) { errors++; issues.add(entry.error) }
      else if (!entry.result) { incomplete++; issues.add('已订阅，等待首次增量读取') }
      else if (entry.result.issues.length) {
        incomplete++
        if (entry.result.issues.some(issue => /失败|截断|替换/.test(issue))) errors++
        for (const issue of entry.result.issues) issues.add(issue)
      }
    }
    const unsupported = agents.length - this.bySession.size
    const source: SourceStatus = {
      id: 'agent-activity', label: '会话事件订阅',
      state: errors ? 'error' : incomplete || unsupported ? 'partial' : watching ? 'ok' : 'empty',
      detail: `监听 ${watching}/${this.entries.size} 个当前持有 session/lease 的 OMP 会话；文件事件按 ${coalesceMs}ms 固定窗口合并，再增量读取（磁盘耗时另计），完成后以 ${publishMs}ms 固定窗口跨会话合并发布，不执行 ps/lsof/Tern。进程、资源和归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒独立发现。每文件最多 128 KiB、最多 128 个会话，不扫描历史目录。${observed} 个会话有最近 6 秒调用证据；完成/取消/错误清除，不改变忙闲或未知状态，不推算子代理数量。${issues.size ? ` ${[...issues].join('；')}。` : ''}${unsupported ? ` ${unsupported} 个进程缺少支持的当前会话调用来源。` : ''} 长推理尚未落盘与超出 6 秒的调用不会持续亮起；监听失败仅在正常发现时重新挂接，无轮询兜底。`,
    }
    this.publish({ ...this.base, agents, sources: [...this.base.sources, source] })
  }
}
