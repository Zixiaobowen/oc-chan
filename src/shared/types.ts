import type { NavigationIntent } from './navigation'
import type { ResourceBudgetSnapshot } from './resources'
import type { DiagnosticActionResult, DiagnosticGenerateResult } from './diagnostic-report'
import type { EventPage, EventQuery, EventSnapshot } from './events'

export type SourceState = 'ok' | 'empty' | 'partial' | 'error' | 'unsupported' | 'disabled'

export interface SourceDiagnostic {
  sourceId: string
  operation: 'services' | 'disabled'
  stage: 'command' | 'timeout' | 'permission' | 'structure' | 'row' | 'limit' | 'queue'
  code: 'command-failed' | 'permission-denied' | 'timed-out' | 'command-missing' | 'output-limit' | 'entry-limit' | 'missing-table' | 'invalid-row' | 'resource-limit' | 'queue-timeout'
  retryable: boolean
  observedAt: string
  exitCode?: number
}

export interface SourceObservation {
  id: string
  lastAttemptAt?: string
  lastSuccessAt?: string
}

export type SourceCapabilityId = 'processes' | 'working' | 'relationships' | 'activity' | 'active-count' | 'history' | 'navigation'
export interface SourceCapability {
  id: SourceCapabilityId
  support: 'supported' | 'partial' | 'unsupported'
  reason: { 'zh-CN': string; en: string }
}

export interface SourceStatus extends SourceObservation {
  label: string
  state: SourceState
  detail: string
  diagnostics?: SourceDiagnostic[]
  resources?: ResourceBudgetSnapshot
  retry?: 'source' | 'section'
}

export interface AgentActivity {
  kind: 'tool' | 'model'
  name?: string
  observedAt: string
}

export interface TernTarget {
  windowKey: string
  paneId: number
  sessionFile: string
}

export interface AgentInfo {
  id: string
  name: string
  summary?: string
  runtime: string
  kind: 'main' | 'subagent'
  state: 'working' | 'idle' | 'running' | 'unknown'
  activity?: AgentActivity
  pid: number
  parentId?: string
  model?: string
  cwd?: string
  sessionId?: string
  tern?: TernTarget
  cpuPercent?: number
  memoryBytes?: number
  startedAt?: string
  source: string
}

export interface AgentSnapshot {
  collectedAt: string
  agents: AgentInfo[]
  activeSubagentCount: number | null
  sources: SourceStatus[]
}

export interface ScheduledJob {
  id: string
  name: string
  source: string
  scope: 'user' | 'system'
  origin: 'personal' | 'system' | 'application' | 'unknown'
  kind: 'calendar' | 'interval' | 'startup' | 'service'
  schedule: string
  state: 'running' | 'waiting' | 'disabled' | 'unloaded' | 'unknown'
  stateReason?: 'hermes-read-failed' | 'hermes-dispatching' | 'hermes-unconfirmed' | 'hermes-state-unsupported'
  lastRun?: { at?: string; result: 'succeeded' | 'failed' | 'delivery-failed' | 'blocked' | 'unknown' }
  pid?: number
  lastExitCode?: number
  file?: string
  executable?: string
  nextRun?: string
}

export interface ScheduleSnapshot {
  collectedAt: string
  jobs: ScheduledJob[]
  sources: SourceStatus[]
}

export interface ScheduleExecution {
  id: string
  claimedAt: string
  startedAt?: string
  finishedAt?: string
  status: 'claimed' | 'running' | 'succeeded' | 'failed' | 'unknown'
  delivery?: 'delivered' | 'failed' | 'skipped' | 'unknown'
}

export interface ScheduleHistory {
  jobId: string
  source: 'hermes' | 'unavailable'
  entries: ScheduleExecution[]
  offset: number
  limit: number
  hasMore: boolean
  collectedAt: string
}

export interface ProcessInfo {
  pid: number
  name: string
  cpuPercent: number
  memoryBytes: number
}

export interface SystemSample {
  at: number
  cpuPercent: number | null
  memoryPercent: number
  rxBytesPerSecond: number | null
  txBytesPerSecond: number | null
}

export interface SystemSnapshot {
  collectedAt: string
  hostname: string
  platform: string
  osVersion: string
  cpuModel: string
  cpuCores: number
  uptimeSeconds: number
  cpuPercent: number | null
  memoryTotal: number
  memoryUsed: number
  memoryAvailable: number
  memoryApp: number
  memoryWired: number
  memoryCompressed: number
  swapUsed: number
  diskTotal: number | null
  diskUsed: number | null
  diskAvailable: number | null
  rxBytesPerSecond: number | null
  txBytesPerSecond: number | null
  networkInterface: string | null
  processes: ProcessInfo[]
  memoryProcesses: ProcessInfo[]
  history: SystemSample[]
  sources: SourceStatus[]
}

export interface CollectorState<T> {
  data: T | null
  error: string | null
  refreshing: boolean
  lastAttemptAt?: string
  lastSuccessAt?: string
}

export interface MonitorSnapshot {
  agents: CollectorState<AgentSnapshot>
  schedules: CollectorState<ScheduleSnapshot>
  system: CollectorState<SystemSnapshot>
  events: CollectorState<EventSnapshot>
}

export type MonitorSection = 'agents' | 'schedules' | 'system' | 'events'
export type MonitorUpdate = { [K in MonitorSection]: { section: K; state: MonitorSnapshot[K] } }[MonitorSection]

export interface SourceHeartbeat {
  section: MonitorSection
  lastAttemptAt?: string
  lastSuccessAt?: string
  sources: SourceObservation[]
}

export const SAMPLING_INTERVALS = { system: 2000, schedules: 30000, events: 30000 } as const
export const AGENT_DISCOVERY_INTERVAL_MS = 2000
export const AGENT_ACTIVITY_WINDOW_MS = 6000

export const HISTORY_PAGE_SIZE = 25
export const MAX_HISTORY_OFFSET = 100_000
export const MAX_SCHEDULE_ID_LENGTH = 256
export const MAX_HERMES_JOB_ID_LENGTH = 128
export const MAX_AGENT_ID_LENGTH = 512
export const MAX_SOURCE_ID_LENGTH = 128

export interface MonitorApi {
  snapshot(): Promise<MonitorSnapshot>
  refresh(section?: MonitorSection): Promise<void>
  retrySource(sourceId: string): Promise<void>
  focusAgentInTern(agentId: string): Promise<{ error: string | null }>
  scheduleHistory(jobId: string, offset?: number): Promise<ScheduleHistory>
  cancelScheduleHistory(): void
  events(query?: EventQuery): Promise<EventPage>
  cancelEvents(): void
  generateDiagnostics(): Promise<DiagnosticGenerateResult>
  copyDiagnostics(id: string): Promise<DiagnosticActionResult>
  saveDiagnostics(id: string): Promise<DiagnosticActionResult>
  cancelDiagnostics(): Promise<void>
  navigation(): Promise<NavigationIntent | null>
  acknowledgeNavigation(sequence: number): Promise<void>
  onNavigation(listener: () => void): () => void
  subscribe(listener: (update: MonitorUpdate) => void): () => void
  subscribeSources(listener: (heartbeat: SourceHeartbeat) => void): () => void
}
