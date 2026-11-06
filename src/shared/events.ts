import type { NavigationTarget } from './navigation'
import type { SourceStatus } from './types'

export const EVENT_PAGE_SIZE = 50
export const EVENT_BATCH_LIMIT = 100
export const EVENT_RECORD_BYTES = 2048
export const EVENT_MAX_RECORDS = 10_000
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const EVENT_DISK_BYTES = 20 * 1024 * 1024
export const EVENT_TYPES = ['execution-failed', 'delivery-failed', 'source-unavailable', 'source-recovered'] as const
export type LocalEventType = typeof EVENT_TYPES[number]

export interface LocalEvent {
  id: string
  sourceId: string
  entityId: string
  type: LocalEventType
  occurredAt: string | null
  observedAt: string
  resultCode: string
  target: Exclude<NavigationTarget, { kind: 'page' }> | null
}

export interface EventQuery {
  sourceId?: string
  type?: LocalEventType
  from?: string
  to?: string
  before?: number
  upper?: number
}

export interface EventRetention {
  count: number
  newestSequence: number
  oldestObservedAt: string | null
  deletedCount: number
  deletedThrough: string | null
  reason: 'age' | 'count' | 'bytes' | null
  diskBytes: number
}

export interface EventCoverage {
  sourceId: string
  state: 'baseline' | 'observing' | 'catching-up' | 'gap' | 'disabled' | 'unavailable'
  since: string | null
  observedAt: string | null
  code: string | null
  lastGap?: { from: string; to: string; code: string; count: number }
}

export interface EventSnapshot {
  collectedAt: string
  sources: SourceStatus[]
  revision: number
  retention: EventRetention
  coverage: EventCoverage[]
}

export interface EventPage {
  entries: LocalEvent[]
  next: number | null
  upper: number
  revision: number
  retention: EventRetention
  coverage: EventCoverage[]
}

export function parseEventQuery(value: unknown): EventQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('事件查询无效 / Invalid event query')
  const result: EventQuery = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sourceId') {
      if (typeof entry !== 'string' || !entry || entry.length > 128 || /[\u0000-\u001f\u007f]/.test(entry)) throw new Error('事件来源无效 / Invalid event source')
      result.sourceId = entry
    } else if (key === 'type') {
      if (!EVENT_TYPES.includes(entry as LocalEventType)) throw new Error('事件类型无效 / Invalid event type')
      result.type = entry as LocalEventType
    } else if (key === 'from' || key === 'to') {
      if (typeof entry !== 'string' || entry.length !== 24 || !Number.isFinite(Date.parse(entry)) || new Date(entry).toISOString() !== entry) throw new Error('事件时间无效 / Invalid event time')
      result[key] = entry
    } else if (key === 'before' || key === 'upper') {
      if (!Number.isSafeInteger(entry) || (entry as number) < 0) throw new Error('事件游标无效 / Invalid event cursor')
      result[key] = entry as number
    } else throw new Error('未知事件查询字段 / Unknown event query field')
  }
  if (result.from && result.to && result.from > result.to) throw new Error('事件时间范围无效 / Invalid event time range')
  return result
}
