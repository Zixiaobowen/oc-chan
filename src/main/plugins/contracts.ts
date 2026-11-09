import type { CollectionSnapshots, MonitorSection, ScheduledJob, ScheduleHistory } from '../../shared/types'
import type { collectionResources } from '../resource-budget'
import type { runBudgetedCommand } from '../resource-io'
import type { EventPage, EventQuery } from '../../shared/events'
export type { CollectionSnapshots } from '../../shared/types'

export const MAX_COLLECTION_PLUGINS = 16
export interface CollectionServices {
  readonly resources: Pick<typeof collectionResources, 'run' | 'snapshot'>
  readonly command: typeof runBudgetedCommand
}
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
export interface CollectionPluginContext<K extends MonitorSection> extends CollectionServices {
  readonly signal: AbortSignal
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
  create(context: CollectionPluginContext<K>): CollectionPlugin<K> | Promise<CollectionPlugin<K>>
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
