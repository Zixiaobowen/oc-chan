import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import type { MonitorSection, MonitorSnapshot, MonitorUpdate, ScheduleHistory, SourceHeartbeat, SourceStatus } from '../shared/types'
import { isResourceAbort, resourceAbortError } from './resource-budget'
import { summarizeDiagnostic } from '../shared/diagnostics'
import { CollectionPluginRegistry } from './plugins/registry'
import type { AnyCollectionPlugin, PluginStatus } from './plugins/contracts'
import type { EventPage, EventQuery } from '../shared/events'

interface MonitorOptions {
  plugins?: readonly AnyCollectionPlugin[]
  signal?: AbortSignal
}

function sameSourceContent(before: SourceStatus[], after: SourceStatus[]): boolean {
  return before.length === after.length && before.every((source, index) => {
    const other = after[index]
    return source.id === other.id && source.label === other.label && source.state === other.state &&
      source.detail === other.detail && source.retry === other.retry &&
      source.diagnostics?.length === other.diagnostics?.length &&
      (source.diagnostics?.every((diagnostic, index) => {
        const next = other.diagnostics![index]
        return diagnostic.sourceId === next.sourceId && diagnostic.operation === next.operation &&
          diagnostic.stage === next.stage && diagnostic.code === next.code && diagnostic.retryable === next.retryable && diagnostic.exitCode === next.exitCode
      }) ?? true) && isDeepStrictEqual(source.resources, other.resources)
  })
}

export class Monitor extends EventEmitter {
  state: MonitorSnapshot = {
    agents: { data: null, error: null, refreshing: false },
    schedules: { data: null, error: null, refreshing: false },
    system: { data: null, error: null, refreshing: false },
    events: { data: null, error: null, refreshing: false }
  }
  private readonly pending = new Map<MonitorSection, Promise<void>>()
  private stopped = false
  private stopping?: Promise<void>
  private readonly parentSignal?: AbortSignal
  private readonly abort = (): void => { void this.stop().catch(error => console.error(summarizeDiagnostic(error, 'shutdown').details)) }
  private readonly sourceRetries = new Map<string, { section: MonitorSection; work: Promise<void> }>()
  private readonly collectionErrors = new Map<MonitorSection, string>()
  private readonly plugins: CollectionPluginRegistry
  private readonly pluginSections = new Map<MonitorSection, string>()
  private readonly controller = new AbortController()

  constructor(options: MonitorOptions = {}) {
    super()
    for (const plugin of options.plugins ?? []) {
      if (this.pluginSections.has(plugin.section)) {
        throw new Error(`采集分区重复 / Duplicate collection section: ${plugin.section}`)
      }
      this.pluginSections.set(plugin.section, plugin.id)
    }
    const signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal
    this.plugins = new CollectionPluginRegistry(options.plugins ?? [], {
      onSnapshot: ({ section, snapshot, sourceId, incremental }) => {
        const current = this.state[section]
        if (!sourceId && !incremental) this.collectionErrors.delete(section)
        this.update(section, {
          ...current, data: snapshot,
          error: incremental ? current.error : this.collectionErrors.get(section) ?? null,
          refreshing: incremental ? current.refreshing : this.hasRetry(section, sourceId),
          lastAttemptAt: incremental || sourceId ? current.lastAttemptAt : snapshot.collectedAt
        } as MonitorSnapshot[typeof section], sourceId, incremental)
      },
      onError: (id, section, error, sourceId) => {
        const message = error instanceof Error ? error.message : String(error)
        if (sourceId === undefined) this.collectionErrors.set(section, message)
        this.update(section, { ...this.state[section], error: message,
          refreshing: false, lastAttemptAt: sourceId === undefined && this.plugins.statuses().find(plugin => plugin.id === id)?.enabled
            ? new Date().toISOString() : this.state[section].lastAttemptAt })
      },
      onState: status => {
        if (status.enabled) return
        const state = this.state[status.section]
        if (status.phase === 'disabled') this.collectionErrors.delete(status.section)
        this.update(status.section, { ...state, error: status.phase === 'disabled' ? null : state.error, refreshing: false, data: state.data ? {
          ...state.data, sources: state.data.sources.map(source => ({ ...source, state: 'disabled' as const }))
        } : null } as MonitorSnapshot[typeof status.section], undefined, true)
      }
    }, { signal })
    this.parentSignal = options.signal
    if (this.parentSignal?.aborted) this.abort()
    else this.parentSignal?.addEventListener('abort', this.abort, { once: true })
  }

  start(): void {
    if (!this.stopped) this.plugins.start()
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const completion = Promise.withResolvers<void>()
    this.stopping = completion.promise
    this.stopped = true
    this.parentSignal?.removeEventListener('abort', this.abort)
    this.controller.abort()
    const pending = [...this.pending.values(), ...Array.from(this.sourceRetries.values(), retry => retry.work)]
    void Promise.allSettled([this.plugins.close(), ...pending]).then(results => {
      // Registry owns collection failures, cancellation and every plugin's actual cleanup.
      const shutdown = results[0]
      this.pending.clear()
      this.sourceRetries.clear()
      this.collectionErrors.clear()
      this.removeAllListeners()
      this.state = { agents: { data: null, error: null, refreshing: false }, schedules: { data: null, error: null, refreshing: false }, system: { data: null, error: null, refreshing: false }, events: { data: null, error: null, refreshing: false } }
      if (shutdown.status === 'rejected') completion.reject(shutdown.reason)
      else completion.resolve()
    })
    return this.stopping
  }

  diagnostics() {
    const plugins = this.plugins.diagnostics()
    const pendingSections = new Set(this.pending.keys())
    for (const plugin of plugins.plugins) {
      if (!plugin.collecting && !plugin.starting && !plugin.stopping) continue
      for (const [section, id] of this.pluginSections) if (id === plugin.id) pendingSections.add(section)
    }
    return { stopped: this.stopped, timers: plugins.timers, pendingSections: [...pendingSections],
      queuedRetries: this.sourceRetries.size, plugins }
  }

  pluginStatuses(): PluginStatus[] {
    return this.plugins.statuses()
  }

  setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    return this.plugins.setEnabled(id, enabled)
  }

  refresh(section?: MonitorSection, manual = true): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!section) return Promise.all(this.plugins.statuses().filter(plugin => plugin.enabled)
      .map(plugin => this.refresh(plugin.section, manual))).then(() => {})
    const pluginId = this.pluginSections.get(section)
    if (!pluginId || !this.plugins.statuses().find(plugin => plugin.id === pluginId)!.enabled) return Promise.resolve()
    const existing = this.pending.get(section)
    if (existing) return existing
    this.update(section, { ...this.state[section], refreshing: manual || this.state[section].refreshing,
      lastAttemptAt: this.hasRetry(section) ? this.state[section].lastAttemptAt : new Date().toISOString() })
    const work = this.plugins.collect(pluginId).catch(error => {
      // Registry reports collection errors. Deliberate cancellation only changes lifecycle state.
      const current = this.plugins.statuses().find(plugin => plugin.id === pluginId)
      if (current?.enabled && !current.error && !this.stopped && !isResourceAbort(error)) {
        this.update(section, { ...this.state[section], error: error instanceof Error ? error.message : String(error), refreshing: false })
      }
    }).finally(() => {
      if (this.pending.get(section) === work) this.pending.delete(section)
      if (!this.hasRetry(section) && this.state[section].refreshing) this.update(section, { ...this.state[section], refreshing: false })
    })
    this.pending.set(section, work)
    return work
  }

  retrySource(sourceId: string): Promise<void> {
    if (this.stopped) return Promise.reject(resourceAbortError())
    const existing = this.sourceRetries.get(sourceId)
    if (existing) return existing.work
    const owner = this.plugins.statuses().find(plugin => this.plugins.supportsSource(plugin.id, sourceId))
    if (!owner) {
      const section = (['agents', 'schedules', 'system', 'events'] as const).find(key =>
        this.state[key].data?.sources.some(source => source.id === sourceId && source.retry === 'section'))
      if (!section) return Promise.reject(Object.assign(new Error('此来源不支持重试 / Source does not support retry'), { code: 'OC_PLUGIN_CAPABILITY' }))
      return this.refresh(section)
    }
    if (!owner.enabled) return Promise.reject(Object.assign(new Error('采集插件已停用 / Collection plugin is disabled'), { code: 'OC_PLUGIN_DISABLED' }))
    const section = owner.section
    this.update(section, { ...this.state[section], refreshing: true, lastAttemptAt: new Date().toISOString() })
    const work = this.plugins.collect(owner.id, sourceId).finally(() => {
      if (this.sourceRetries.get(sourceId)?.work === work) this.sourceRetries.delete(sourceId)
      if (!this.hasRetry(section) && this.state[section].refreshing) this.update(section, { ...this.state[section], refreshing: false })
    })
    this.sourceRetries.set(sourceId, { section, work })
    return work
  }

  readScheduleHistory(jobId: string, offset?: number): Promise<ScheduleHistory> {
    if (this.stopped) return Promise.reject(resourceAbortError())
    const pluginId = this.pluginSections.get('schedules')
    if (!pluginId) return Promise.reject(Object.assign(new Error('任务采集插件未注册 / Schedule collection plugin is not registered'), { code: 'OC_PLUGIN_UNKNOWN' }))
    const job = this.state.schedules.data?.jobs.find(candidate => candidate.id === jobId)
    if (!job) return Promise.reject(Object.assign(new Error('任务不存在 / Unknown scheduled job'), { code: 'ENOENT' }))
    return this.plugins.readHistory(pluginId, job, offset)
  }

  cancelScheduleHistory(): void {
    const pluginId = this.pluginSections.get('schedules')
    if (pluginId) this.plugins.cancelHistory(pluginId)
  }

  readEvents(query: EventQuery = {}, signal?: AbortSignal): Promise<EventPage> {
    if (this.stopped) return Promise.reject(resourceAbortError())
    const pluginId = this.pluginSections.get('events')
    if (!pluginId) return Promise.reject(Object.assign(new Error('事件插件未注册 / Event plugin is not registered'), { code: 'OC_PLUGIN_UNKNOWN' }))
    return this.plugins.readEvents(pluginId, query, signal)
  }

  private hasRetry(section: MonitorSection, exceptSource?: string): boolean {
    for (const [sourceId, retry] of this.sourceRetries) if (retry.section === section && sourceId !== exceptSource) return true
    return false
  }

  private update<K extends MonitorSection>(section: K, state: MonitorSnapshot[K], observedSource?: string, incremental = false): void {
    if (this.stopped) return
    const previous = this.state[section]
    if (state.data && state.data !== previous.data) {
      const sampled = !incremental
      const prior = new Map(previous.data?.sources.map(source => [source.id, source]))
      const pluginId = this.pluginSections.get(section)
      const sources = state.data.sources.map(source => {
        const before = prior.get(source.id)
        const attempted = sampled && source.state !== 'disabled' && source.state !== 'unsupported' && (!observedSource || source.id === observedSource)
        const lastAttemptAt = source.lastAttemptAt ?? (attempted ? state.data!.collectedAt : before?.lastAttemptAt)
        const succeeded = source.state === 'ok' || source.state === 'empty'
        const lastSuccessAt = source.lastSuccessAt ?? (attempted && succeeded ? state.data!.collectedAt : before?.lastSuccessAt)
        const retry = source.state === 'disabled' || source.state === 'unsupported' ? undefined
          : pluginId && this.plugins.supportsSource(pluginId, source.id) ? 'source' as const
            : source.state === 'error' ? 'section' as const : undefined
        return { ...source, lastAttemptAt, lastSuccessAt, retry }
      })
      state = { ...state, data: { ...state.data, sources },
        lastSuccessAt: sampled && !observedSource && !state.error ? state.data.collectedAt : state.lastSuccessAt }
    }
    const before = previous.data ? { ...previous.data, collectedAt: undefined, sources: undefined } : null
    const after = state.data ? { ...state.data, collectedAt: undefined, sources: undefined } : null
    const unchanged = previous.error === state.error && previous.refreshing === state.refreshing &&
      isDeepStrictEqual(before, after) && sameSourceContent(previous.data?.sources ?? [], state.data?.sources ?? [])
    this.state = { ...this.state, [section]: state }
    if (!unchanged) {
      this.emit('change', { section, state } as MonitorUpdate)
      return
    }
    if (previous.lastAttemptAt === state.lastAttemptAt && previous.lastSuccessAt === state.lastSuccessAt &&
      previous.data?.sources.every((source, index) => source.lastAttemptAt === state.data?.sources[index]?.lastAttemptAt &&
        source.lastSuccessAt === state.data?.sources[index]?.lastSuccessAt)) return
    const heartbeat: SourceHeartbeat = { section, lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt,
      sources: state.data?.sources.map(({ id, lastAttemptAt, lastSuccessAt }) => ({ id, lastAttemptAt, lastSuccessAt })) ?? [] }
    this.emit('sources', heartbeat)
  }
}
