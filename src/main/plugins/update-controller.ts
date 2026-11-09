import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateSnapshot } from '../../shared/updates'
import { downloadAsset, fetchUpdate, METADATA_URL, parseUpdate, readMetadata, type FetchUpdate, type UpdateAsset } from './update-source'

export interface UpdateControllerOptions {
  version: string
  arch: string
  directory: string
  fetch: FetchUpdate
  changed(snapshot: UpdateSnapshot): void
  install(file: string, asset: UpdateAsset, signal: AbortSignal): Promise<void>
}
interface Operation { kind: 'check' | 'download' | 'install'; abort: AbortController; promise: Promise<UpdateSnapshot>; cancelled: boolean }
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

export class UpdateController {
  private value: UpdateSnapshot
  private candidate: UpdateAsset | null = null
  private downloaded: string | null = null
  private operation: Operation | null = null
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(private readonly options: UpdateControllerOptions) {
    this.value = { revision: 0, phase: 'disabled', currentVersion: options.version, availableVersion: null, checkedAt: null, progress: null, disabledReason: 'development', error: null }
  }
  get snapshot() { return this.value }

  start(disabledReason: UpdateSnapshot['disabledReason']) {
    if (this.running) return
    this.running = true
    this.publish({ phase: disabledReason === 'platform' ? 'disabled' : 'idle', disabledReason, error: null, availableVersion: null, checkedAt: null, progress: null })
    if (!disabledReason) this.schedule(30_000)
  }

  private schedule(delay = CHECK_INTERVAL) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.value.phase === 'idle' || this.value.phase === 'error') void this.check()
      else this.schedule()
    }, delay)
    this.timer.unref()
  }

  private publish(patch: Partial<UpdateSnapshot>) {
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 }
    this.options.changed(this.value)
  }

  fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[app-updates]', message.slice(0, 2048))
    this.publish({ phase: 'error', error: message.length > 2048 ? `${message.slice(0, 2048)}… [错误已截断 / Error truncated]` : message, progress: null })
  }

  private run(kind: Operation['kind'], timeout: number, action: (signal: AbortSignal) => Promise<void>): Promise<UpdateSnapshot> {
    if (this.operation) return this.operation.promise
    const abort = new AbortController()
    const operation: Operation = { kind, abort, cancelled: false, promise: Promise.resolve(this.value) }
    this.operation = operation
    const timer = setTimeout(() => abort.abort(new Error('更新操作超时 / Update operation timed out')), timeout)
    operation.promise = Promise.resolve().then(() => action(abort.signal)).catch(error => {
      if (!this.running) return
      if (operation.cancelled) this.publish({ phase: this.candidate ? 'available' : 'idle', progress: null, error: null })
      else this.fail(abort.signal.aborted ? abort.signal.reason : error)
    }).finally(() => { clearTimeout(timer); if (this.operation === operation) this.operation = null }).then(() => this.value)
    return operation.promise
  }

  check(): Promise<UpdateSnapshot> {
    if (!this.running || this.value.disabledReason === 'platform' || this.value.phase === 'downloaded' || this.value.phase === 'installing') return Promise.resolve(this.value)
    if (this.operation) return this.operation.promise
    if (!this.value.disabledReason) this.schedule()
    this.candidate = null
    this.publish({ phase: 'checking', error: null, availableVersion: null, progress: null })
    return this.run('check', 30_000, async signal => {
      const response = await fetchUpdate(METADATA_URL, signal, this.options.fetch)
      const text = await readMetadata(response, signal)
      const candidate = parseUpdate(text, this.options.version, this.options.arch)
      signal.throwIfAborted()
      this.candidate = candidate
      this.publish({ phase: candidate ? 'available' : 'idle', availableVersion: candidate?.version ?? null, checkedAt: new Date().toISOString() })
    })
  }

  download(): Promise<UpdateSnapshot> {
    if (this.value.disabledReason) return Promise.resolve(this.value)
    if (this.operation) return this.operation.promise
    if (!this.running || !this.candidate || !['available', 'error'].includes(this.value.phase)) return Promise.resolve(this.value)
    const asset = this.candidate
    this.publish({ phase: 'downloading', error: null, progress: { percent: 0, total: asset.size, transferred: 0, bytesPerSecond: 0 } })
    return this.run('download', 15 * 60_000, async signal => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      this.downloaded = await downloadAsset(asset, this.options.directory, signal, this.options.fetch, (transferred, total, bytesPerSecond) => {
        if (!signal.aborted && this.running) this.publish({ progress: { percent: transferred / total * 100, transferred, total, bytesPerSecond } })
      })
      signal.throwIfAborted()
      this.publish({ phase: 'downloaded', progress: null })
    })
  }

  async cancel(): Promise<UpdateSnapshot> {
    const operation = this.operation
    if (operation?.kind !== 'download') return this.value
    operation.cancelled = true
    operation.abort.abort(new Error('下载已取消 / Download cancelled'))
    return operation.promise
  }

  install(): Promise<UpdateSnapshot> {
    if (this.value.disabledReason) return Promise.resolve(this.value)
    if (this.operation) return this.operation.promise
    if (!this.running || this.value.phase !== 'downloaded' || !this.downloaded || !this.candidate) return Promise.resolve(this.value)
    const file = this.downloaded
    const asset = this.candidate
    this.publish({ phase: 'installing', error: null })
    return this.run('install', 120_000, signal => this.options.install(file, asset, signal))
  }

  async stop(): Promise<void> {
    this.running = false
    clearTimeout(this.timer)
    this.timer = undefined
    const operation = this.operation
    operation?.abort.abort(new Error('应用正在退出 / Application is quitting'))
    // Installation invokes the host shutdown callback itself; waiting on it would deadlock.
    if (operation?.kind !== 'install') await operation?.promise
    this.candidate = null
    this.downloaded = null
    await Promise.all(['download.part', 'update.zip'].map(name => rm(join(this.options.directory, name), { force: true })))
  }
}
