import { DiagnosticError } from '../../shared/diagnostics'
import { MAX_SOURCE_ID_LENGTH, type MonitorSection, type ScheduledJob, type ScheduleHistory } from '../../shared/types'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, resourceAbortError, throwIfAborted } from '../resource-budget'
import type { EventPage, EventQuery } from '../../shared/events'
import {
  MAX_COLLECTION_PLUGINS,
  type AnyCollectionPlugin,
  type CollectionPlugin,
  type CollectionPluginDefinition,
  type CollectionSnapshots,
  type PluginObserver,
  type PluginPhase,
  type PluginPublication,
  type PluginStatus
} from './contracts'

interface Failure { error: unknown }
interface Entry {
  definition: CollectionPluginDefinition<MonitorSection>
  enabled: boolean
  phase: PluginPhase
  generation: number
  error: string | null
  controller?: AbortController
  instance?: CollectionPlugin<MonitorSection>
  starting?: Promise<void>
  collecting?: Promise<void>
  sampling?: Promise<void>
  retries: Map<string, Promise<void>>
  collectionError: string | null
  historyRevision: number
  stopping?: Promise<void>
  transition?: { enabled: boolean; work: Promise<void> }
  timer?: NodeJS.Timeout
  deadline?: NodeJS.Timeout
  terminalFailure?: Failure
  stopFailure?: Failure
}

function pluginError(id: string, code: string, message: string): Error {
  return Object.assign(new Error(`Plugin ${id}: ${message}`), { code, pluginId: id })
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9-]*$/.test(value)
}

function names(value: unknown, field: string, id: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_PLUGINS) {
    throw pluginError(id, 'OC_PLUGIN_DEFINITION', `${field} must contain at most ${MAX_COLLECTION_PLUGINS} names`)
  }
  const copy: string[] = []
  for (const name of value) {
    if (!validName(name) || copy.includes(name)) throw pluginError(id, 'OC_PLUGIN_DEFINITION', `invalid or duplicate ${field}`)
    copy.push(name)
  }
  return Object.freeze(copy)
}

function retrySources(value: unknown, id: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_PLUGINS) {
    throw pluginError(id, 'OC_PLUGIN_DEFINITION', `retrySources must contain at most ${MAX_COLLECTION_PLUGINS} source ids`)
  }
  const copy: string[] = []
  for (const source of value) {
    if (typeof source !== 'string' || !source || source.length > MAX_SOURCE_ID_LENGTH ||
      /[\u0000-\u0020\u007f]/.test(source) || copy.includes(source)) {
      throw pluginError(id, 'OC_PLUGIN_DEFINITION', 'invalid or duplicate retrySources')
    }
    copy.push(source)
  }
  return Object.freeze(copy)
}

/** Validate all metadata before allocating lifecycle state or invoking any plugin. */
function definitions(input: readonly AnyCollectionPlugin[]): CollectionPluginDefinition<MonitorSection>[] {
  if (!Array.isArray(input) || input.length > MAX_COLLECTION_PLUGINS) {
    throw new Error(`At most ${MAX_COLLECTION_PLUGINS} collection plugins may be registered`)
  }
  const result: CollectionPluginDefinition<MonitorSection>[] = []
  const ids = new Set<string>()
  for (const value of input) {
    if (!value || !validName(value.id)) throw new Error('Invalid collection plugin id')
    const { id, section, intervalMs, timeoutMs, create } = value
    if (ids.has(id)) throw pluginError(id, 'OC_PLUGIN_DEFINITION', 'duplicate id')
    if (!['agents', 'schedules', 'system', 'events'].includes(section) || typeof create !== 'function') {
      throw pluginError(id, 'OC_PLUGIN_DEFINITION', 'invalid section or factory')
    }
    for (const [field, duration] of [['intervalMs', intervalMs], ['timeoutMs', timeoutMs]] as const) {
      if (!Number.isSafeInteger(duration) || duration < 10 || duration > 60_000) {
        throw pluginError(id, 'OC_PLUGIN_DEFINITION', `${field} must be an integer between 10 and 60000`)
      }
    }
    const capabilities = names(value.capabilities, 'capabilities', id)
    const dependencies = names(value.dependencies === undefined ? [] : value.dependencies, 'dependencies', id)
    const sources = retrySources(value.retrySources === undefined ? [] : value.retrySources, id)
    result.push(Object.freeze({ id, section, intervalMs, timeoutMs, create, capabilities, dependencies, retrySources: sources }) as CollectionPluginDefinition<MonitorSection>)
    ids.add(id)
  }
  return result
}

function topologicalOrder(registered: readonly CollectionPluginDefinition<MonitorSection>[]): CollectionPluginDefinition<MonitorSection>[] {
  const byId = new Map(registered.map(definition => [definition.id, definition]))
  const visiting = new Set<string>(), visited = new Set<string>()
  const order: CollectionPluginDefinition<MonitorSection>[] = []
  const visit = (definition: CollectionPluginDefinition<MonitorSection>): void => {
    if (visiting.has(definition.id)) throw pluginError(definition.id, 'OC_PLUGIN_DEPENDENCY', 'cyclic dependency')
    if (visited.has(definition.id)) return
    visiting.add(definition.id)
    for (const id of definition.dependencies!) {
      if (id === definition.id) throw pluginError(id, 'OC_PLUGIN_DEPENDENCY', 'self dependency')
      const dependency = byId.get(id)
      if (!dependency) throw pluginError(definition.id, 'OC_PLUGIN_DEPENDENCY', `missing dependency ${id}`)
      visit(dependency)
    }
    visiting.delete(definition.id)
    visited.add(definition.id)
    order.push(definition)
  }
  for (const definition of registered) visit(definition)
  return order
}

/** One serial collection chain per plugin, bounded by its declared retry sources. */
export class CollectionPluginRegistry {
  private readonly entries: Map<string, Entry>
  private readonly order: Entry[]
  private started = false
  private closed = false
  private closing?: Promise<void>
  private readonly parentSignal?: AbortSignal
  private readonly onAbort = (): void => {
    // Every cleanup failure has already reached onError before close rejects.
    void this.close().catch(() => {})
  }

  constructor(input: readonly AnyCollectionPlugin[], private readonly observer: PluginObserver, options: { signal?: AbortSignal } = {}) {
    const registered = definitions(input)
    const order = topologicalOrder(registered)
    this.entries = new Map(registered.map(definition => [definition.id, {
      definition, enabled: true, phase: 'idle', generation: 0, error: null,
      retries: new Map(), collectionError: null, historyRevision: 0
    }]))
    this.order = order.map(definition => this.entries.get(definition.id)!)
    this.parentSignal = options.signal
    if (this.parentSignal?.aborted) {
      this.closed = true
      this.closing = Promise.resolve()
      for (const entry of this.order) { entry.enabled = false; entry.phase = 'disabled' }
    } else this.parentSignal?.addEventListener('abort', this.onAbort, { once: true })
  }

  start(): void {
    if (this.closed) throw pluginError('registry', 'OC_PLUGIN_CLOSED', 'registry is closed')
    if (this.started) return
    this.started = true
    for (const entry of this.order) if (entry.enabled) {
      this.schedule(entry)
      this.collectAutomatically(entry)
    }
  }

  collect(id: string, sourceId?: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.reject(pluginError(id, 'OC_PLUGIN_UNKNOWN', 'unknown plugin'))
    const unavailable = this.unavailable(entry)
    if (unavailable) return this.reject(entry, unavailable, sourceId)
    if (sourceId !== undefined && !this.supportsSource(id, sourceId)) {
      return Promise.reject(pluginError(id, 'OC_PLUGIN_CAPABILITY', 'source does not support retry'))
    }
    const existing = sourceId === undefined ? entry.collecting : entry.retries.get(sourceId)
    if (existing) return existing
    if (entry.stopFailure) return Promise.reject(entry.stopFailure.error)
    if (entry.terminalFailure) return Promise.reject(entry.terminalFailure.error)
    const before = entry.collecting
    const work = Promise.resolve().then(async () => {
      // The predecessor owns its failure. A failed source must not cancel another source's retry.
      if (before) await Promise.allSettled([before])
      this.assertAvailable(entry)
      await this.initialize(entry)
      this.assertAvailable(entry)
      await this.timed(entry, 'collect', async () => {
        const snapshot = await entry.instance!.collect(entry.controller!.signal, sourceId)
        this.assertAvailable(entry)
        if (snapshot !== undefined) this.publish(entry, entry.controller!, snapshot, sourceId)
      }, sourceId)
      this.assertAvailable(entry)
      if (sourceId === undefined) entry.collectionError = null
      this.state(entry, entry.collectionError ? 'failed' : 'running', entry.collectionError)
    }).finally(() => {
      if (entry.sampling === work) entry.sampling = undefined
      if (entry.collecting === work) entry.collecting = undefined
      if (sourceId !== undefined && entry.retries.get(sourceId) === work) entry.retries.delete(sourceId)
      this.schedule(entry)
    })
    entry.collecting = work
    if (sourceId !== undefined) entry.retries.set(sourceId, work)
    else entry.sampling = work
    return work
  }

  supportsSource(id: string, sourceId: string): boolean {
    return this.entries.get(id)?.definition.retrySources!.includes(sourceId) ?? false
  }

  async readHistory(id: string, job: ScheduledJob, offset?: number): Promise<ScheduleHistory> {
    const entry = this.entries.get(id)
    if (!entry) throw pluginError(id, 'OC_PLUGIN_UNKNOWN', 'unknown plugin')
    const unavailable = this.unavailable(entry)
    if (unavailable) throw unavailable
    if (entry.stopFailure) throw entry.stopFailure.error
    if (entry.terminalFailure) throw entry.terminalFailure.error
    const revision = entry.historyRevision
    await this.initialize(entry)
    this.assertAvailable(entry)
    if (revision !== entry.historyRevision) throw resourceAbortError()
    const instance = entry.instance!
    const controller = entry.controller!
    if (!instance.history) throw pluginError(id, 'OC_PLUGIN_CAPABILITY', 'execution history is unavailable')
    const history = await instance.history.read(job, offset)
    this.assertAvailable(entry)
    if (entry.instance !== instance || entry.controller !== controller || revision !== entry.historyRevision) throw resourceAbortError()
    return history
  }

  async readEvents(id: string, query: EventQuery, signal?: AbortSignal): Promise<EventPage> {
    const entry = this.entries.get(id)
    throwIfAborted(signal)
    if (!entry) throw pluginError(id, 'OC_PLUGIN_UNKNOWN', 'unknown plugin')
    this.assertAvailable(entry)
    if (entry.stopFailure) throw entry.stopFailure.error
    await this.initialize(entry)
    throwIfAborted(signal)
    this.assertAvailable(entry)
    const instance = entry.instance!
    if (!instance.events) throw pluginError(id, 'OC_PLUGIN_CAPABILITY', 'event query is unavailable')
    const page = await instance.events.query(query, signal)
    throwIfAborted(signal)
    this.assertAvailable(entry)
    if (entry.instance !== instance) throw resourceAbortError()
    return page
  }

  cancelHistory(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) throw pluginError(id, 'OC_PLUGIN_UNKNOWN', 'unknown plugin')
    entry.historyRevision++
    try { entry.instance?.history?.cancel() }
    catch (error) {
      entry.stopFailure = { error }
      this.report(entry, error)
      throw error
    }
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.reject(pluginError(id, 'OC_PLUGIN_UNKNOWN', 'unknown plugin'))
    if (this.closed) return this.reject(entry, pluginError(id, 'OC_PLUGIN_CLOSED', 'registry is closed'))
    if (typeof enabled !== 'boolean') return this.reject(entry, pluginError(id, 'OC_PLUGIN_DEFINITION', 'enabled must be boolean'))
    if (entry.transition) {
      return entry.transition.enabled === enabled ? entry.transition.work
        : this.reject(entry, pluginError(id, 'OC_PLUGIN_BUSY', 'opposing lifecycle transition is in progress'))
    }
    if (enabled && entry.stopFailure) return Promise.reject(entry.stopFailure.error)
    if (entry.enabled === enabled) {
      const failure = enabled ? entry.terminalFailure : entry.stopFailure
      return failure ? Promise.reject(failure.error) : Promise.resolve()
    }
    if (enabled) {
      const unavailable = this.dependencyFailure(entry)
      if (unavailable) return this.reject(entry, unavailable)
    } else {
      const consumer = this.order.find(candidate => candidate.definition.dependencies!.includes(id) &&
        (candidate.enabled || candidate.starting || candidate.collecting || candidate.stopping))
      if (consumer) return this.reject(entry, pluginError(id, 'OC_PLUGIN_DEPENDENCY', `required by ${consumer.definition.id}`))
    }
    entry.enabled = enabled
    const work = Promise.resolve().then(() => {
      if (!enabled) return this.stopEntry(entry)
      this.assertAvailable(entry)
      this.schedule(entry)
      return this.collect(id)
    }).finally(() => { entry.transition = undefined })
    entry.transition = { enabled, work }
    if (enabled) this.state(entry, 'idle', null)
    else this.cancel(entry)
    return work
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.started = false
    this.parentSignal?.removeEventListener('abort', this.onAbort)
    this.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      for (let index = this.order.length - 1; index >= 0; index--) {
        try { await this.stopEntry(this.order[index]) }
        catch (error) { failures.push(new DiagnosticError('shutdown', error, undefined, this.order[index].definition.section)) }
      }
      if (failures.length) throw new AggregateError(failures, 'Collection plugin shutdown failed')
    })
    // Abort every owner immediately; release dependencies only after consumers drain.
    for (const entry of this.order) { entry.enabled = false; this.cancel(entry) }
    return this.closing
  }

  statuses(): PluginStatus[] {
    return Array.from(this.entries.values(), entry => this.status(entry))
  }

  diagnostics(): {
    closed: boolean
    timers: number
    pending: number
    plugins: Array<{ id: string; enabled: boolean; phase: PluginPhase; generation: number; collecting: boolean; retrying: number; starting: boolean; stopping: boolean }>
  } {
    let timers = 0, pending = 0
    const plugins = Array.from(this.entries.values(), entry => {
      timers += Number(entry.timer !== undefined) + Number(entry.deadline !== undefined)
      pending += Number(!!entry.sampling) + entry.retries.size + Number(!!(entry.transition || entry.starting || entry.stopping))
      return { id: entry.definition.id, enabled: entry.enabled, phase: entry.phase, generation: entry.generation,
        collecting: !!entry.collecting, retrying: entry.retries.size, starting: !!entry.starting, stopping: !!entry.stopping || entry.transition?.enabled === false }
    })
    return { closed: this.closed, timers, pending, plugins }
  }

  private status(entry: Entry): PluginStatus {
    return { id: entry.definition.id, section: entry.definition.section, enabled: entry.enabled,
      phase: entry.phase, generation: entry.generation, error: entry.error }
  }

  private state(entry: Entry, phase: PluginPhase, error = entry.error): void {
    if (entry.phase === phase && entry.error === error) return
    entry.phase = phase
    entry.error = error
    this.observer.onState?.(this.status(entry))
  }

  private report(entry: Entry, error: unknown, sourceId?: string): void {
    const message = error instanceof Error ? error.message.slice(0, 512) : 'Collection plugin failed'
    if (sourceId === undefined) entry.collectionError = message
    this.state(entry, 'failed', message)
    this.observer.onError(entry.definition.id, entry.definition.section, error, sourceId)
    if (isResourceCleanupFailure(error)) entry.stopFailure = { error }
  }

  private reject(entry: Entry, error: Error, sourceId?: string): Promise<never> {
    this.observer.onError(entry.definition.id, entry.definition.section, error, sourceId)
    return Promise.reject(error)
  }

  private unavailable(entry: Entry): Error | undefined {
    if (this.closed) return pluginError(entry.definition.id, 'OC_PLUGIN_CLOSED', 'registry is closed')
    if (!entry.enabled) return pluginError(entry.definition.id, 'OC_PLUGIN_DISABLED', 'plugin is disabled')
    if (entry.stopping) return pluginError(entry.definition.id, 'OC_PLUGIN_BUSY', 'plugin is stopping')
    return undefined
  }

  private assertAvailable(entry: Entry): void {
    if (this.unavailable(entry) || entry.controller?.signal.aborted) {
      throw entry.terminalFailure ? entry.terminalFailure.error : resourceAbortError()
    }
  }

  private dependencyFailure(entry: Entry): Error | undefined {
    for (const id of entry.definition.dependencies!) {
      const dependency = this.entries.get(id)!
      if (!dependency.enabled || dependency.stopping || dependency.terminalFailure || dependency.stopFailure) {
        return pluginError(entry.definition.id, 'OC_PLUGIN_DEPENDENCY', `dependency ${id} is unavailable`)
      }
    }
    return undefined
  }

  private initialize(entry: Entry): Promise<void> {
    if (entry.starting) return entry.starting
    this.assertAvailable(entry)
    if (entry.terminalFailure) return Promise.reject(entry.terminalFailure.error)
    if (entry.instance) return Promise.resolve()
    const controller = new AbortController()
    entry.controller = controller
    entry.generation++
    entry.terminalFailure = undefined
    const work = this.timed(entry, 'start', async () => {
      const dependencyError = this.dependencyFailure(entry)
      if (dependencyError) throw dependencyError
      for (const id of entry.definition.dependencies!) {
        await this.initialize(this.entries.get(id)!)
        this.assertAvailable(entry)
      }
      this.assertAvailable(entry)
      const instance = entry.definition.create({ signal: controller.signal, resources: collectionResources,
        publish: (snapshot, incremental) => this.publish(entry, controller, snapshot, undefined, incremental) })
      entry.instance = instance
      if (!instance || typeof instance.collect !== 'function' || typeof instance.stop !== 'function' ||
        (instance.start !== undefined && typeof instance.start !== 'function') ||
        (instance.history !== undefined && (!instance.history || typeof instance.history.read !== 'function' || typeof instance.history.cancel !== 'function'))) {
        throw pluginError(entry.definition.id, 'OC_PLUGIN_DEFINITION', 'factory returned an invalid plugin')
      }
      this.assertAvailable(entry)
      await instance.start?.(controller.signal)
      this.assertAvailable(entry)
      this.state(entry, 'running', null)
    }).catch(error => {
      if (!isResourceAbort(error) || !controller.signal.aborted) entry.terminalFailure = { error }
      controller.abort(error)
      throw error
    }).finally(() => { entry.starting = undefined })
    entry.starting = work
    this.state(entry, 'starting', null)
    return work
  }

  private publish(entry: Entry, controller: AbortController, snapshot: CollectionSnapshots[MonitorSection], sourceId?: string, incremental?: boolean): void {
    if (this.closed || !entry.enabled || entry.controller !== controller || controller.signal.aborted) return
    this.observer.onSnapshot({ id: entry.definition.id, section: entry.definition.section, snapshot, sourceId, incremental } as PluginPublication)
  }

  private async timed<T>(entry: Entry, operation: 'start' | 'collect' | 'stop', run: () => T | Promise<T>, sourceId?: string): Promise<T> {
    let timeout: Error | undefined
    entry.deadline = setTimeout(() => {
      entry.deadline = undefined
      timeout = pluginError(entry.definition.id, 'ETIMEDOUT', `${operation} timed out after ${entry.definition.timeoutMs}ms; ${operation === 'stop' ? 'restart the application after inspecting cleanup failure' : 'disable and re-enable after cleanup'}`)
      if (operation === 'stop') entry.stopFailure = { error: timeout }
      else entry.terminalFailure = { error: timeout }
      this.clearTimer(entry)
      entry.controller!.abort(timeout)
      this.report(entry, timeout, sourceId)
    }, entry.definition.timeoutMs)
    try {
      // Defer plugin callbacks until the owning slot is published, including reentrant calls.
      const result = await Promise.resolve().then(run)
      if (timeout) throw timeout
      if (operation !== 'stop') this.assertAvailable(entry)
      return result
    } catch (error) {
      if (timeout) {
        if (error === timeout || isResourceAbort(error)) throw timeout
        this.report(entry, error, sourceId)
        throw new AggregateError([timeout, error], `Plugin ${entry.definition.id}: ${operation} failed after timeout`)
      }
      if (operation === 'stop' || !isResourceAbort(error) || !entry.controller?.signal.aborted) this.report(entry, error, sourceId)
      throw error
    } finally {
      clearTimeout(entry.deadline)
      entry.deadline = undefined
    }
  }

  private cancel(entry: Entry): void {
    this.clearTimer(entry)
    this.state(entry, 'stopping')
    // Cancel public capabilities even for plugins whose signal listener only stops collection.
    try { this.cancelHistory(entry.definition.id) }
    catch { /* cancelHistory retains and reports the failure; stop still attempts every release. */ }
    entry.controller?.abort(resourceAbortError())
  }

  private stopEntry(entry: Entry): Promise<void> {
    if (entry.stopping) return entry.stopping
    const work = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      const remember = (error: unknown): void => {
        if (!failures.includes(error)) failures.push(error)
      }
      if (entry.stopFailure) remember(entry.stopFailure.error)
      const pending = [entry.starting, entry.sampling, entry.collecting, ...entry.retries.values(), entry.transition?.enabled ? entry.transition.work : undefined]
        .filter((value): value is Promise<void> => !!value)
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === 'rejected' && !isResourceAbort(result.reason) &&
          (!entry.terminalFailure || result.reason !== entry.terminalFailure.error)) remember(result.reason)
      }
      if (entry.instance && typeof entry.instance.stop === 'function') {
        try { await this.timed(entry, 'stop', () => entry.instance!.stop()) }
        catch (error) { remember(error) }
      }
      entry.instance = undefined
      entry.controller = undefined
      entry.terminalFailure = undefined
      if (failures.length) {
        const error = failures.length === 1 ? failures[0] : new AggregateError(failures, `Plugin ${entry.definition.id}: stop failed`)
        entry.stopFailure = { error }
        this.state(entry, 'failed', error instanceof Error ? error.message.slice(0, 512) : 'Collection plugin stop failed')
        throw error
      }
      entry.collectionError = null
      this.state(entry, 'disabled', null)
    }).finally(() => { entry.stopping = undefined })
    entry.stopping = work
    return work
  }

  private clearTimer(entry: Entry): void {
    clearInterval(entry.timer)
    entry.timer = undefined
  }

  private schedule(entry: Entry): void {
    if (!this.started || this.closed || !entry.enabled || entry.stopping || entry.terminalFailure || entry.stopFailure || entry.controller?.signal.aborted) {
      this.clearTimer(entry)
      return
    }
    if (entry.timer) return
    entry.timer = setInterval(() => {
      if (!entry.collecting && !entry.starting && !entry.transition) this.collectAutomatically(entry)
    }, entry.definition.intervalMs)
  }

  private collectAutomatically(entry: Entry): void {
    // Collection reports genuine failures before rejection; deliberate cancellation is reflected in state.
    void this.collect(entry.definition.id).catch(() => {})
  }
}
