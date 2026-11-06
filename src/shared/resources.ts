export interface ResourceLimits {
  readonly commands: number
  readonly files: number
  readonly sockets: number
  readonly commandBytes: number
  readonly fileBytes: number
  readonly socketBytes: number
  readonly queued: number
  readonly queuedPerSource: number
  readonly sources: number
  readonly queueTimeoutMs: number
}

/** Slot usage and reserved raw IO capacity; these are not heap or RSS measurements. */
export interface ResourceUsage {
  commands: number
  files: number
  sockets: number
  stdoutBytes: number
  stderrBytes: number
  commandBytes: number
  fileBytes: number
  socketBytes: number
  queued: number
}

export interface ResourceStatistics {
  readonly current: Readonly<ResourceUsage>
  readonly peak: Readonly<ResourceUsage>
  readonly admitted: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  readonly rejected: number
  readonly queueTimeouts: number
  readonly totalWaitMs: number
  readonly maxWaitMs: number
  readonly totalExecutionMs: number
  readonly maxExecutionMs: number
}

export interface ResourceBudgetSnapshot {
  readonly limits: ResourceLimits
  readonly global: ResourceStatistics
  readonly sources: readonly (ResourceStatistics & { readonly source: string })[]
}
