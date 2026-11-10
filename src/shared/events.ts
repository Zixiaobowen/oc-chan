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
