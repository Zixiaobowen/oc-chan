export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface UpdateSnapshot {
  revision: number
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  checkedAt: string | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  disabledReason: 'development' | 'platform' | 'unsigned' | null
  error: string | null
}

export interface UpdatesApi {
  snapshot(): Promise<UpdateSnapshot>
  check(): Promise<UpdateSnapshot>
  download(): Promise<UpdateSnapshot>
  cancel(): Promise<UpdateSnapshot>
  install(): Promise<UpdateSnapshot>
  openReleaseNotes(): Promise<void>
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
}
