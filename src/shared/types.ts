export type SourceState = 'ok' | 'partial' | 'error' | 'unsupported'

export interface SourceStatus {
  id: string
  label: string
  state: SourceState
  detail: string
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

export interface ProcessInfo {
  pid: number
  name: string
  cpuPercent: number
  memoryBytes: number
}

export interface SystemSample {
  at: number
  cpuPercent: number
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
  cpuPercent: number
  memoryTotal: number
  memoryUsed: number
  memoryAvailable: number
  swapUsed: number
  diskTotal: number | null
  diskUsed: number | null
  diskAvailable: number | null
  rxBytesPerSecond: number | null
  txBytesPerSecond: number | null
  processes: ProcessInfo[]
  history: SystemSample[]
  sources: SourceStatus[]
}

export interface CollectorState<T> {
  data: T | null
  error: string | null
  refreshing: boolean
}

export interface MonitorSnapshot {
  agents: CollectorState<AgentSnapshot>
  schedules: CollectorState<ScheduleSnapshot>
  system: CollectorState<SystemSnapshot>
}

export type MonitorSection = 'agents' | 'schedules' | 'system'
export type MonitorUpdate = { [K in MonitorSection]: { section: K; state: MonitorSnapshot[K] } }[MonitorSection]

export const SAMPLING_INTERVALS = { system: 2000, schedules: 30000 } as const
export const AGENT_DISCOVERY_INTERVAL_MS = 2000
export const AGENT_ACTIVITY_WINDOW_MS = 6000

export interface MonitorApi {
  snapshot(): Promise<MonitorSnapshot>
  refresh(section?: MonitorSection): Promise<void>
  focusAgentInTern(agentId: string): Promise<{ error: string | null }>
  subscribe(listener: (update: MonitorUpdate) => void): () => void
}
