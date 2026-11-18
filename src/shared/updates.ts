export type UpdatePhase = 'idle' | 'checking' | 'no-update' | 'available' | 'downloading' | 'downloaded' | 'extracting' | 'ready-to-install' | 'installing' | 'awaiting-quit' | 'cancelled' | 'error'
export type UpdatePolicy = 'all' | 'lts'

export interface UpdateSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  checkedAt: string | null
  error: string | null
  canCheck: boolean
  automaticChecks: boolean
  policy: UpdatePolicy
  probeOnly: boolean
  sessionInProgress: boolean
}

export interface UpdatesApi {
  snapshot(): Promise<UpdateSnapshot>
  check(): Promise<UpdateSnapshot>
  setAutomaticChecks(enabled: boolean): Promise<UpdateSnapshot>
  setPolicy(policy: UpdatePolicy): Promise<UpdateSnapshot>
  openReleaseNotes(): Promise<void>
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
}
