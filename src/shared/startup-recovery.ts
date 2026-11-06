export type StartupFailureReason = 'invalid-json' | 'invalid-values' | 'invalid-encoding' | 'too-large' | 'permission-denied' | 'unsafe-path' | 'changed' | 'unknown'

export interface StartupSettingsFailure {
  reason: StartupFailureReason
  filePath: string
  details: string
}
export interface StartupRecoverySnapshot {
  failure: StartupSettingsFailure
  language: 'zh-CN' | 'en'
}
export interface StartupRecoveryApi {
  snapshot(): Promise<StartupRecoverySnapshot>
  retry(): Promise<{ ready: true } | { ready: false; snapshot: StartupRecoverySnapshot }>
  quit(): Promise<void>
}
