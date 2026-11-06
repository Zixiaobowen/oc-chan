import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { DiagnosticError, summarizeDiagnostic, type DiagnosticStage } from '../shared/diagnostics'
import { DIAGNOSTIC_REPORT_MAX_BYTES, type DiagnosticActionResult, type DiagnosticFailure, type DiagnosticGenerateResult, type DiagnosticPreview, type DiagnosticReportContent } from '../shared/diagnostic-report'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from './resource-budget'

export const DIAGNOSTIC_PREVIEW_TTL_MS = 10 * 60 * 1000
export const DIAGNOSTIC_IO_TIMEOUT_MS = 5000
const source = 'diagnostic-export'

type Result = DiagnosticGenerateResult | DiagnosticActionResult
interface Dependencies {
  build(): DiagnosticReportContent
  chooseFile(signal: AbortSignal): Promise<string | null>
  copy(text: string, signal: AbortSignal): Promise<void>
  save?(filename: string, text: string, signal: AbortSignal): Promise<void>
}

function checkText(text: string): void {
  if (typeof text !== 'string' || !text.length || text.length > DIAGNOSTIC_REPORT_MAX_BYTES || Buffer.byteLength(text) > DIAGNOSTIC_REPORT_MAX_BYTES)
    throw new DiagnosticError('diagnostic-generate', undefined, 'OC_DIAGNOSTIC_LIMIT')
}

function failure(error: unknown, stage: DiagnosticStage): DiagnosticFailure {
  const summary = summarizeDiagnostic(error, stage)
  const code = summary.primaryCode
  const reason: DiagnosticFailure['reason'] = isResourceCleanupFailure(error) || code === 'OC_DIAGNOSTIC_CLEANUP' ? 'cleanup'
    : code === 'OC_DIAGNOSTIC_BUSY' ? 'busy'
      : code === 'OC_DIAGNOSTIC_EXPIRED' ? 'expired'
        : code === 'OC_DIAGNOSTIC_UNAVAILABLE' ? 'unavailable'
          : code === 'EEXIST' ? 'exists'
            : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'permission'
              : code === 'ENOSPC' || code === 'EDQUOT' ? 'storage'
                : code === 'ETIMEDOUT' ? 'timeout'
                  : code === 'OC_DIAGNOSTIC_CLIPBOARD' ? 'clipboard'
                    : code === 'EIO' || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP' ? 'io' : 'unknown'
  return { status: 'error', reason, details: summary.details }
}

/** A complete file is linked into place without replacing any existing destination. */
export async function saveDiagnosticReport(filename: string, text: string, signal: AbortSignal,
  io: Pick<typeof fs, 'open' | 'link' | 'unlink'> = fs): Promise<void> {
  checkText(text)
  if (!path.isAbsolute(filename) || filename.length > 4096 || /[\u0000-\u001f\u007f]/.test(filename))
    throw new DiagnosticError('diagnostic-save', undefined, 'OC_DIAGNOSTIC_UNAVAILABLE')
  await collectionResources.run({ source, kind: 'file', bytes: Buffer.byteLength(text), signal }, async () => {
    throwIfAborted(signal)
    const temporary = path.join(path.dirname(filename), `.oc-chan-diagnostic-${randomUUID()}.tmp`)
    const handle = await io.open(temporary, 'wx', 0o600)
    let closed = false, failed = false, primary: unknown
    try {
      throwIfAborted(signal)
      await handle.writeFile(text, { encoding: 'utf8', signal })
      await handle.sync()
      await handle.close()
      closed = true
      throwIfAborted(signal)
      // The successful link is the commit point. Cancellation after it cannot undo a saved file.
      await io.link(temporary, filename)
    } catch (error) { failed = true; primary = error }
    const cleanup: unknown[] = []
    if (!closed) {
      try { await handle.close() } catch (error) { cleanup.push(error) }
    }
    try { await io.unlink(temporary) } catch (error) { cleanup.push(error) }
    if (cleanup.length) throw new ResourceCleanupError('file', new AggregateError([...(failed ? [primary] : []), ...cleanup], 'Diagnostic export cleanup failed'))
    if (failed) throw primary
  })
}

/** One bounded preview, one operation and one expiry timer for the entire application. */
export class Diagnostics {
  private preview: DiagnosticPreview | null = null
  private expires?: NodeJS.Timeout
  private active?: { controller: AbortController; promise: Promise<Result> }
  private closed = false
  private cleanupFailure: DiagnosticFailure | null = null

  constructor(private readonly dependencies: Dependencies) {}

  generate(): Promise<DiagnosticGenerateResult> {
    return this.run('diagnostic-generate', async signal => {
      this.clear()
      await yieldTurn(undefined, { signal })
      const content = this.dependencies.build()
      checkText(content.json)
      if (content.bytes !== Buffer.byteLength(content.json)) throw new TypeError('Invalid diagnostic byte count')
      throwIfAborted(signal)
      const preview = { ...content, id: randomUUID() }
      this.preview = preview
      this.expires = setTimeout(() => this.clear(), DIAGNOSTIC_PREVIEW_TTL_MS)
      this.expires.unref()
      return { status: 'ready', preview }
    })
  }

  copy(id: string): Promise<DiagnosticActionResult> {
    return this.run('diagnostic-copy', async signal => {
      const preview = this.current(id)
      await this.withDeadline(signal, async active => { throwIfAborted(active); await this.dependencies.copy(preview.json, active) })
      return { status: 'copied' }
    })
  }

  save(id: string): Promise<DiagnosticActionResult> {
    return this.run('diagnostic-save', async signal => {
      const preview = this.current(id)
      const filename = await this.dependencies.chooseFile(signal)
      throwIfAborted(signal)
      if (filename === null) return { status: 'cancelled' }
      await this.withDeadline(signal, active => (this.dependencies.save ?? saveDiagnosticReport)(filename, preview.json, active))
      return { status: 'saved' }
    })
  }

  async cancel(): Promise<void> {
    this.clear()
    const active = this.active
    if (active) { active.controller.abort(); await active.promise }
    if (this.cleanupFailure) throw new DiagnosticError('diagnostic-cleanup', undefined, 'OC_DIAGNOSTIC_CLEANUP')
  }

  async close(): Promise<void> { this.closed = true; await this.cancel() }

  diagnostics(): { closed: boolean; active: boolean; previewBytes: number; timers: number; cleanupFailed: boolean } {
    return { closed: this.closed, active: !!this.active, previewBytes: this.preview?.bytes ?? 0, timers: this.expires ? 1 : 0, cleanupFailed: !!this.cleanupFailure }
  }

  private clear(): void {
    clearTimeout(this.expires)
    this.expires = undefined
    this.preview = null
  }

  private current(id: string): DiagnosticPreview {
    if (!this.preview || this.preview.id !== id) throw new DiagnosticError('diagnostic-generate', undefined, 'OC_DIAGNOSTIC_EXPIRED')
    return this.preview
  }

  private run<T extends Result>(stage: DiagnosticStage, work: (signal: AbortSignal) => Promise<T>): Promise<T | DiagnosticFailure | { status: 'cancelled' }> {
    if (this.cleanupFailure) return Promise.resolve(this.cleanupFailure)
    if (this.closed) return Promise.resolve(failure(new DiagnosticError(stage, undefined, 'OC_DIAGNOSTIC_UNAVAILABLE'), stage))
    if (this.active) return Promise.resolve(failure(new DiagnosticError(stage, undefined, 'OC_DIAGNOSTIC_BUSY'), stage))
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => { throwIfAborted(controller.signal); return work(controller.signal) }).catch(error => {
      if (isResourceAbort(error) && !isResourceCleanupFailure(error)) return { status: 'cancelled' } as const
      const result = failure(error, stage)
      if (result.reason === 'cleanup') this.cleanupFailure = result
      return result
    }).finally(() => { if (this.active?.controller === controller) this.active = undefined })
    this.active = { controller, promise }
    return promise
  }

  private async withDeadline(signal: AbortSignal, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), DIAGNOSTIC_IO_TIMEOUT_MS)
    try { await work(AbortSignal.any([signal, timeout.signal])) }
    catch (error) {
      if (timeout.signal.aborted && isResourceAbort(error)) throw Object.assign(new Error('Diagnostic I/O timed out'), { code: 'ETIMEDOUT' })
      throw error
    } finally { clearTimeout(timer) }
  }
}
