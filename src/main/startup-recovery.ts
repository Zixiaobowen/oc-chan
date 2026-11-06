import path from 'node:path'
import type { AppSettings } from '../shared/settings'
import type { StartupSettingsFailure } from '../shared/startup-recovery'
import { DiagnosticError, summarizeDiagnostic } from '../shared/diagnostics'
import { readSettings } from './settings'

type ReadResult = { kind: 'ready'; settings: AppSettings } | { kind: 'failed'; failure: StartupSettingsFailure } | { kind: 'closed' }

export function startupSettingsFailure(error: unknown, filename: string): StartupSettingsFailure {
  const diagnostic = summarizeDiagnostic(error, 'settings-read', 'settings')
  let reason: StartupSettingsFailure['reason'] = 'unknown'
  switch (diagnostic.primaryCode) {
    case 'OC_SETTINGS_INVALID': reason = error instanceof DiagnosticError && error.stage === 'settings-decode' ? 'invalid-json' : 'invalid-values'; break
    case 'OC_SETTINGS_ENCODING_INVALID': reason = 'invalid-encoding'; break
    case 'OC_SETTINGS_TOO_LARGE': reason = 'too-large'; break
    case 'EACCES':
    case 'EPERM': reason = 'permission-denied'; break
    case 'OC_SETTINGS_NOT_REGULAR':
    case 'ELOOP':
    case 'EISDIR':
    case 'ENOTDIR': reason = 'unsafe-path'; break
    case 'OC_SETTINGS_CHANGED': reason = 'changed'; break
  }
  return { reason, filePath: path.resolve(filename), details: diagnostic.details }
}

/** One read in flight; closing makes late completions unable to resume startup. */
export class StartupSettingsRecovery {
  failure: StartupSettingsFailure
  private pending: Promise<ReadResult> | undefined
  private ready: ReadResult | undefined
  private closed = false
  constructor(private readonly filename: string, error: unknown, private readonly read = readSettings) {
    this.failure = startupSettingsFailure(error, filename)
  }
  retry(): Promise<ReadResult> {
    if (this.closed) return Promise.resolve({ kind: 'closed' })
    if (this.ready) return Promise.resolve(this.ready)
    if (this.pending) return this.pending
    this.pending = this.read(this.filename).then((settings): ReadResult => {
      if (this.closed) return { kind: 'closed' }
      this.ready = { kind: 'ready', settings }
      return this.ready
    }, (error): ReadResult => {
      if (this.closed) return { kind: 'closed' }
      this.failure = startupSettingsFailure(error, this.filename)
      return { kind: 'failed', failure: this.failure }
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  async close(): Promise<void> {
    this.closed = true
    await this.pending
    this.ready = undefined
  }
}
