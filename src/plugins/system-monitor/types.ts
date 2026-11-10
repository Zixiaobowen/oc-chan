import type { SourceStatus } from '../../shared/types'

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

declare module '../../shared/types' {
  interface CollectionSnapshots { system: SystemSnapshot }
}
