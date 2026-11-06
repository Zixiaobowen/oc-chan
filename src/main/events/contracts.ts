import type { EventCoverage, LocalEvent } from '../../shared/events'
import type { MonitorSection, SourceState } from '../../shared/types'

export interface HermesEventCursor {
  identity: string
  baseline: number
  high: number
  revisit: number
  floor: number
  since: string
  lastObservedAt: string
  pending: { rowid: number; id: string; status: string; delivery: string | null }[]
  pendingIndex: number
}

export interface HermesEventRow {
  rowid: number
  id: string
  jobId: string
  status: string
  claimedAt: string
  finishedAt: string | null
  delivery: string | null
  baselineStatus?: string
  baselineDelivery?: string | null
}

export interface HermesEventRead {
  cursor: HermesEventCursor
  rows: HermesEventRow[]
  coverage: EventCoverage
}

export interface SourceEventCursor {
  id: string
  section: MonitorSection
  state: SourceState
  observedAt: string
  unavailableSince: string | null
  announced: boolean
  generation: number
}

export interface EventCheckpoint {
  version: 1
  hermes: HermesEventCursor | null
  sources: SourceEventCursor[]
  coverage: EventCoverage[]
  observedAt: string | null
}

export interface EventCommit {
  revision: number
  checkpoint: EventCheckpoint
  events: LocalEvent[]
  now: string
}
