import { monitorSections } from '../../shared/plugin-catalog'
import { createHash } from 'node:crypto'
import { EVENT_BATCH_LIMIT, EVENT_RETENTION_MS, type EventCoverage, type EventPage, type EventQuery, type EventSnapshot, type LocalEvent } from '../../shared/events'
import { scheduleTarget } from '../../shared/navigation'
import type { MonitorSection, MonitorSnapshot, SourceState, SourceStatus } from '../../shared/types'
import type { EventCheckpoint, HermesEventRead, SourceEventCursor } from './contracts'
import { isResourceAbort, isResourceCleanupFailure, throwIfAborted } from '../resource-budget'
import { EventStore } from './store'
import { HermesEventReader } from './hermes'
import type { NotificationBatch } from './notification-contracts'

const SOURCE_LIMIT = 64
const SOURCE_EVENT_BATCH = 16
export const SOURCE_UNAVAILABLE_MS = 60_000
export const SOURCE_OBSERVATION_GAP_MS = 120_000
const watchedSections = monitorSections.filter(section => section !== 'events')
export interface EventObservation { id: string; section: MonitorSection; state: SourceState; observedAt: string }
export interface EventInputs { snapshot: MonitorSnapshot; enabled: Readonly<Record<MonitorSection, boolean>> }
const eventId = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const initialCheckpoint = (): EventCheckpoint => ({ version: 1, hermes: null, sources: [], coverage: [], observedAt: null })

/** Only fresh, explicit source errors start an outage; absence/partial/disabled never imply task failure. */
export function observeSourceEvents(previous: SourceEventCursor[], observations: EventObservation[], now: string): {
  sources: SourceEventCursor[]; events: LocalEvent[]; gap: boolean; deferred: boolean
} {
  if (previous.length > SOURCE_LIMIT || observations.length > SOURCE_LIMIT) throw new Error('事件来源超过64项上限 / Event source limit exceeded')
  const prior = new Map(previous.map(source => [`${source.section}:${source.id}`, source]))
  const sources: SourceEventCursor[] = [], events: LocalEvent[] = []
  let gap = false, deferred = false
  for (const observation of observations) {
    if (!observation.id || observation.id.length > 128 || /[\u0000-\u001f\u007f]/.test(observation.id)) throw new Error('事件来源标识无效 / Invalid event source identifier')
    const before = prior.get(`${observation.section}:${observation.id}`)
    const at = Date.parse(observation.observedAt)
    if (!Number.isFinite(at) || at > Date.parse(now)) throw new Error('来源观测时间无效 / Invalid source observation time')
    if (before && observation.observedAt === before.observedAt && observation.state === before.state) { sources.push(before); continue }
    const interrupted = !!before && (at < Date.parse(before.observedAt) || at - Date.parse(before.observedAt) > SOURCE_OBSERVATION_GAP_MS)
    if (interrupted) gap = true
    const next: SourceEventCursor = { ...observation, unavailableSince: null, announced: false, generation: before?.generation ?? 0 }
    const unavailable = observation.state === 'error'
    const healthy = observation.state === 'ok' || observation.state === 'empty'
    let type: LocalEvent['type'] | null = null
    if (unavailable) {
      next.unavailableSince = !interrupted && before?.state === 'error' ? before.unavailableSince ?? observation.observedAt : observation.observedAt
      next.announced = before?.announced ?? false
      if (!next.announced && at - Date.parse(next.unavailableSince) >= SOURCE_UNAVAILABLE_MS) {
        next.generation++
        next.announced = true
        type = 'source-unavailable'
      }
    } else if (healthy && before?.announced) type = 'source-recovered'
    else if (observation.state === 'partial' && before?.announced) {
      // Partial coverage cannot establish recovery from a known outage.
      next.announced = true
      next.unavailableSince = before.unavailableSince
    }
    if (type && events.length === SOURCE_EVENT_BATCH) {
      deferred = true
      if (before) sources.push(before)
      continue
    }
    sources.push(next)
    if (type) events.push({ id: eventId('source', observation.section, observation.id, String(next.generation), type === 'source-unavailable' ? next.unavailableSince! : before!.unavailableSince!, type),
      sourceId: observation.id, entityId: observation.id, type,
      occurredAt: type === 'source-unavailable' ? next.unavailableSince : observation.observedAt,
      observedAt: now, resultCode: type === 'source-unavailable' ? 'source-error' : 'source-ok',
      target: observation.id.startsWith('collection:') ? null : { kind: 'source', id: observation.id, section: observation.section } })
  }
  return { sources, events, gap, deferred }
}

function sourceObservations(input: EventInputs): EventObservation[] {
  const observations: EventObservation[] = []
  const add = (value: EventObservation) => {
    if (observations.length >= SOURCE_LIMIT) throw new Error('事件来源超过64项上限 / Event source limit exceeded')
    observations.push(value)
  }
  for (const section of watchedSections) {
    const state = input.snapshot[section]
    const enabled = input.enabled[section]
    if (state.lastAttemptAt) add({ id: `collection:${section}`, section,
      state: !enabled ? 'disabled' : state.error ? 'error' : state.lastSuccessAt ? 'ok' : 'unsupported', observedAt: state.lastAttemptAt })
    for (const source of state.data?.sources ?? []) {
      if (!source.lastAttemptAt) continue
      add({ id: source.id, section, state: !enabled ? 'disabled' : source.state, observedAt: source.lastAttemptAt })
    }
  }
  return observations
}

function preserveGap(value: EventCoverage, previous: EventCoverage | undefined, now: string): EventCoverage {
  if (value.state !== 'gap' && value.state !== 'unavailable') return { ...value, ...(previous?.lastGap ? { lastGap: previous.lastGap } : {}) }
  const same = previous?.state === value.state && previous.code === value.code
  return { ...value, lastGap: { from: same && previous.lastGap ? previous.lastGap.from : previous?.observedAt ?? now,
    to: now, code: value.code ?? 'unavailable', count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.lastGap?.count ?? 0) + (same ? 0 : 1)) || 1 } }
}

function executionEvents(read: HermesEventRead, input: EventInputs, now: string): LocalEvent[] {
  if (read.rows.length > 40) throw new Error('事件读取超过40条上限 / Event read limit exceeded')
  const events: LocalEvent[] = []
  const jobs = input.snapshot.schedules.data?.jobs ?? []
  for (const row of read.rows) {
    const entityId = `hermes-job:${row.jobId}`
    const job = jobs.find(item => item.id === entityId)
    const at = row.finishedAt ? new Date(row.finishedAt).toISOString() : null
    if (at !== null && Date.parse(at) < Date.parse(now) - EVENT_RETENTION_MS) continue
    const types: LocalEvent['type'][] = []
    if (row.status === 'failed' && row.baselineStatus !== 'failed') types.push('execution-failed')
    if (row.delivery === 'failed' && row.baselineDelivery !== 'failed') types.push('delivery-failed')
    for (const type of types) events.push({
      id: `h:${createHash('sha256').update(read.cursor.identity).digest('hex').slice(0, 16)}:${row.rowid}:${eventId(row.id, type).slice(0, 32)}`, sourceId: 'hermes-events', entityId, type,
      occurredAt: type === 'execution-failed' ? at : null, observedAt: now,
      resultCode: type === 'execution-failed' ? 'failed' : 'delivery-failed', target: job ? scheduleTarget(job) : null
    })
  }
  return events
}

export class EventCollector {
  private readonly controller = new AbortController()
  private pending?: Promise<EventSnapshot>
  private closing?: Promise<void>
  private readonly cancel = (): void => this.controller.abort()
  constructor(private readonly store: EventStore, private readonly reader: HermesEventReader,
    private readonly inputs: () => EventInputs, private readonly parentSignal: AbortSignal,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly onCommitted?: (batch: NotificationBatch) => Promise<void>) {
    if (parentSignal.aborted) this.cancel()
    else parentSignal.addEventListener('abort', this.cancel, { once: true })
  }

  collect(signal: AbortSignal): Promise<EventSnapshot> {
    if (this.pending) return this.pending
    const combined = AbortSignal.any([signal, this.controller.signal])
    const work = this.collectOnce(combined).finally(() => { if (this.pending === work) this.pending = undefined })
    this.pending = work
    return work
  }

  private async collectOnce(signal: AbortSignal): Promise<EventSnapshot> {
    throwIfAborted(signal)
    const loaded = await this.store.load(signal)
    const checkpoint = loaded.checkpoint ?? initialCheckpoint()
    const input = this.inputs()
    const now = this.clock()
    const transition = observeSourceEvents(checkpoint.sources, sourceObservations(input), now)
    const events = transition.events
    const sources: SourceStatus[] = []
    let hermes = checkpoint.hermes
    let hermesCoverage: EventCoverage
    if (!input.enabled.schedules) {
      hermesCoverage = { sourceId: 'hermes-events', state: 'disabled', since: hermes?.since ?? null, observedAt: now, code: 'schedule-collection-disabled' }
    } else {
      try {
        const read = await this.reader.read(hermes, now, signal)
        hermes = read.cursor
        hermesCoverage = read.coverage
        events.push(...executionEvents(read, input, now))
      } catch (error) {
        if (isResourceAbort(error) || isResourceCleanupFailure(error)) throw error
        // The bounded upstream reader owns safe diagnostic text; retain its cursor on every failure.
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'HERMES_EVENT_READ_FAILED'
        hermesCoverage = { sourceId: 'hermes-events', state: 'unavailable', since: hermes?.since ?? null, observedAt: now, code }
        sources.push({ id: 'hermes-events', label: 'Hermes 异常记录 / Hermes events', state: 'error', detail: error instanceof Error ? error.message.slice(0, 512) : '事件元数据读取失败 / Event metadata read failed' })
      }
    }
    if (events.length > EVENT_BATCH_LIMIT) throw new Error('事件批次超过100条上限 / Event batch limit exceeded')
    const priorSource = checkpoint.coverage.find(item => item.sourceId === 'source-events')
    const sourceCoverage: EventCoverage = { sourceId: 'source-events', state: transition.gap ? 'gap' : transition.deferred ? 'catching-up' : 'observing',
      since: priorSource?.since ?? now, observedAt: now, code: transition.gap ? 'source-observation-gap' : transition.deferred ? 'source-event-backlog' : null }
    const coverage = [preserveGap(hermesCoverage, checkpoint.coverage.find(item => item.sourceId === 'hermes-events'), now),
      preserveGap(sourceCoverage, priorSource, now)]
    const next: EventCheckpoint = { version: 1, hermes, sources: transition.sources, coverage, observedAt: now }
    const saved = await this.store.commit({ revision: loaded.revision, checkpoint: next, events, now }, signal)
    throwIfAborted(signal)
    if (this.onCommitted) await this.onCommitted({ identity: saved.identity,
      events: saved.added.map(row => ({ sequence: row.sequence, event: events[row.index] })) })
    throwIfAborted(signal)
    for (const item of saved.checkpoint.coverage) {
      if (sources.some(source => source.id === item.sourceId)) continue
      sources.push({ id: item.sourceId, label: item.sourceId === 'hermes-events' ? 'Hermes 异常记录 / Hermes events' : '来源可用性事件 / Source availability events',
        state: item.state === 'disabled' ? 'disabled' : item.state === 'gap' || item.state === 'catching-up' ? 'partial' : 'ok',
        detail: item.sourceId === 'hermes-events'
          ? `仅执行元数据；增量游标 ${hermes?.baseline ?? 0}–${hermes?.high ?? 0}，排除水位 ${saved.checkpoint.hermes?.floor ?? 0}；轮询补查迟写结果。覆盖状态 / Coverage: ${item.state}${item.code ? ` (${item.code})` : ''}`
          : `明确错误持续60秒才记录；停用、未知及睡眠间隔不推断失败。覆盖状态 / Coverage: ${item.state}${item.code ? ` (${item.code})` : ''}` })
    }
    sources.unshift({ id: 'event-store', label: '本地事件存储 / Local event store', state: saved.retention.count ? 'ok' : 'empty',
      detail: `保留上限7天、10000条、20MiB（含日志）；当前 ${saved.retention.count} 条，已按保留策略移除 ${saved.retention.deletedCount} 条 / Bounded local retention.` })
    return { collectedAt: now, sources, revision: saved.revision, retention: saved.retention, coverage: saved.checkpoint.coverage }
  }

  query(query: EventQuery, signal?: AbortSignal): Promise<EventPage> {
    return this.store.query(query, signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.parentSignal.removeEventListener('abort', this.cancel)
    this.controller.abort()
    this.closing = (async () => {
      let failure: unknown
      if (this.pending) try { await this.pending } catch (error) { if (!isResourceAbort(error)) failure = error }
      try { await this.store.close() } catch (error) { if (failure) throw new AggregateError([failure, error], '事件采集清理失败 / Event collection cleanup failed'); throw error }
      if (failure) throw failure
    })()
    return this.closing
  }
}
