import type { AgentSnapshot, MonitorSection, ScheduleSnapshot, SystemSnapshot, ScheduledJob, ScheduleHistory } from '../../shared/types'
import type { collectionResources } from '../resource-budget'
import type { EventPage, EventQuery, EventSnapshot } from '../../shared/events'

export const MAX_COLLECTION_PLUGINS = 16
export type CollectionSnapshots = { agents: AgentSnapshot; schedules: ScheduleSnapshot; system: SystemSnapshot; events: EventSnapshot }
export type PluginPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'disabled' | 'failed'

export interface PluginStatus {
  id: string
  section: MonitorSection
  enabled: boolean
  phase: PluginPhase
  generation: number
  error: string | null
}

/** Factories are side-effect free; every owned operation must settle after cancellation. */
export interface CollectionPluginContext<K extends MonitorSection> {
  readonly signal: AbortSignal
  readonly resources: Pick<typeof collectionResources, 'run' | 'snapshot'>
  publish(snapshot: CollectionSnapshots[K], incremental?: boolean): void
}

export interface CollectionPlugin<K extends MonitorSection> {
  start?(signal: AbortSignal): void | Promise<void>
  collect(signal: AbortSignal, sourceId?: string): Promise<CollectionSnapshots[K] | void>
  stop(): void | Promise<void>
  history?: {
    read(job: ScheduledJob, offset?: number): Promise<ScheduleHistory>
    cancel(): void
  }
  events?: { query(query: EventQuery, signal?: AbortSignal): Promise<EventPage> }
}

export interface CollectionPluginDefinition<K extends MonitorSection> {
  readonly id: string
  readonly section: K
  readonly capabilities: readonly string[]
  readonly dependencies?: readonly string[]
  readonly retrySources?: readonly string[]
  readonly intervalMs: number
  readonly timeoutMs: number
  create(context: CollectionPluginContext<K>): CollectionPlugin<K>
}

export type AnyCollectionPlugin = { [K in MonitorSection]: CollectionPluginDefinition<K> }[MonitorSection]
export type PluginPublication = { [K in MonitorSection]: {
  id: string; section: K; snapshot: CollectionSnapshots[K]; sourceId?: string; incremental?: boolean
} }[MonitorSection]

export interface PluginObserver {
  onSnapshot(publication: PluginPublication): void
  onError(id: string, section: MonitorSection, error: unknown, sourceId?: string): void
  onState?(status: PluginStatus): void
}
