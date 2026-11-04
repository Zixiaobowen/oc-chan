import { watch, type FSWatcher } from 'node:fs'
import { AGENT_ACTIVITY_WINDOW_MS, AGENT_DISCOVERY_INTERVAL_MS, type AgentSnapshot, type SourceStatus } from '../shared/types'
import { discoverAgents, type AgentDiscovery } from './collectors/agents'
import { SessionActivityReader, type ActivityRead } from './collectors/agent-activity'

const coalesceMs = 90
interface SessionWatch {
  path: string
  sessionId: string
  reader: Pick<SessionActivityReader, 'read'>
  watcher?: FSWatcher
  result?: ActivityRead
  error?: string
  timer?: NodeJS.Timeout
  dirty: boolean
  reading: boolean
  active: boolean
  revision: number
}
export interface LiveAgentsOptions {
  discover?: () => Promise<AgentDiscovery>
  createReader?: () => Pick<SessionActivityReader, 'read'>
  watchFile?: (path: string, listener: (event: string) => void) => FSWatcher
}

// Discovery owns topology/resource facts; file callbacks only replace a session's
// activity in the latest discovery. Each file has its own bounded read lane.
export class LiveAgents {
  private readonly entries = new Map<string, SessionWatch>()
  private base?: AgentSnapshot
  private stopped = false
  private pending?: Promise<void>
  private readonly discover: () => Promise<AgentDiscovery>
  private readonly createReader: () => Pick<SessionActivityReader, 'read'>
  private readonly watchFile: NonNullable<LiveAgentsOptions['watchFile']>

  constructor(private readonly publish: (snapshot: AgentSnapshot) => void, options: LiveAgentsOptions = {}) {
    this.discover = options.discover ?? discoverAgents
    this.createReader = options.createReader ?? (() => new SessionActivityReader())
    this.watchFile = options.watchFile ?? ((path, listener) => watch(path, { persistent: false }, listener))
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = this.discover().then(({ snapshot, sessions }) => {
      if (this.stopped) return
      const owned = new Set(snapshot.agents.filter(agent => agent.runtime === 'OMP').map(agent => agent.sessionId))
      const current = new Map(sessions.filter(session => owned.has(session.sessionId)).slice(0, 128).map(session => [session.file, session]))
      for (const [path, entry] of this.entries) {
        if (current.get(path)?.sessionId === entry.sessionId) continue
        this.close(entry)
        this.entries.delete(path)
      }
      this.base = snapshot
      for (const [path, session] of current) {
        let entry = this.entries.get(path)
        if (!entry) {
          entry = { path, sessionId: session.sessionId, reader: this.createReader(), dirty: false, reading: false, active: true, revision: 0 }
          this.entries.set(path, entry)
        }
        if (!entry.watcher) this.attach(entry)
      }
      this.emit()
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
  }

  private close(entry: SessionWatch): void {
    entry.active = false
    entry.watcher?.close()
    entry.watcher = undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  private attach(entry: SessionWatch): void {
    try {
      entry.watcher = this.watchFile(entry.path, event => {
        if (this.stopped || !entry.active) return
        if (event === 'rename') {
          this.fail(entry, '会话文件被移动、替换或删除，等待下一次进程发现重新确认')
          return
        }
        this.enqueue(entry)
      })
      entry.watcher.on('error', error => this.fail(entry, this.failure('会话监听失败', error)))
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
    entry.error = message
    entry.result = undefined
    entry.dirty = false
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.watcher?.close()
    entry.watcher = undefined
    this.emit()
  }

  private enqueue(entry: SessionWatch): void {
    entry.dirty = true
    // A fixed window from the first event cannot be extended by a continuous burst.
    if (entry.timer || entry.reading || this.stopped || !entry.active) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.read(entry)
    }, coalesceMs)
  }

  private async read(entry: SessionWatch): Promise<void> {
    if (this.stopped || !entry.active || !entry.watcher) return
    entry.reading = true
    entry.dirty = false
    const revision = entry.revision
    try {
      const result = await entry.reader.read(entry.path)
      if (this.stopped || !entry.active || revision !== entry.revision) return
      const failed = result.issues.find(issue => issue.startsWith('会话读取失败'))
      if (failed) { this.fail(entry, failed); return }
      entry.result = result
      this.emit()
    } catch (error) {
      if (revision === entry.revision) this.fail(entry, this.failure('会话读取失败', error))
    } finally {
      entry.reading = false
      if (entry.dirty && entry.watcher) this.enqueue(entry)
    }
  }

  private emit(): void {
    if (this.stopped || !this.base) return
    const bySession = new Map([...this.entries.values()].map(entry => [entry.sessionId, entry]))
    let observed = 0
    let incomplete = 0
    let errors = 0
    const issues = new Set<string>()
    const agents = this.base.agents.map(agent => {
      const entry = agent.sessionId ? bySession.get(agent.sessionId) : undefined
      const candidate = !entry?.error ? entry?.result?.activity : undefined
      const age = candidate ? Date.now() - Date.parse(candidate.observedAt) : -1
      const activity = age >= 0 && age < AGENT_ACTIVITY_WINDOW_MS ? candidate : undefined
      if (activity) observed++
      return activity ? { ...agent, activity } : agent
    })
    for (const entry of this.entries.values()) {
      if (entry.error) { errors++; issues.add(entry.error) }
      else if (!entry.result) { incomplete++; issues.add('已订阅，等待首次增量读取') }
      else if (entry.result.issues.length) {
        incomplete++
        if (entry.result.issues.some(issue => /失败|截断|替换/.test(issue))) errors++
        for (const issue of entry.result.issues) issues.add(issue)
      }
    }
    const unsupported = agents.length - bySession.size
    const watching = [...this.entries.values()].filter(entry => entry.watcher).length
    const source: SourceStatus = {
      id: 'agent-activity', label: '会话事件订阅',
      state: errors ? 'error' : incomplete || unsupported ? 'partial' : watching ? 'ok' : 'unsupported',
      detail: `监听 ${watching}/${this.entries.size} 个当前持有 session/lease 的 OMP 会话；文件事件按 ${coalesceMs}ms 固定窗口合并，再增量读取（磁盘耗时另计），不执行 ps/lsof/Tern。进程、资源和归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒独立发现。每文件最多 128 KiB、最多 128 个会话，不扫描历史目录。${observed} 个会话有最近 6 秒调用证据；完成/取消/错误清除，不改变忙闲或未知状态，不推算子代理数量。${issues.size ? ` ${[...issues].join('；')}。` : ''}${unsupported ? ` ${unsupported} 个进程缺少支持的当前会话调用来源。` : ''} 长推理尚未落盘与超出 6 秒的调用不会持续亮起；监听失败仅在正常发现时重新挂接，无轮询兜底。`,
    }
    this.publish({ ...this.base, agents, sources: [...this.base.sources, source] })
  }
}
