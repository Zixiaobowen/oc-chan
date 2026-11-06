import type { BrowserWindow, Event, Input } from 'electron'
import { DiagnosticError } from '../shared/diagnostics'

interface TrayWindowOptions {
  create(): BrowserWindow
  load(window: BrowserWindow): Promise<void>
  present(window: BrowserWindow): void
  report(error: unknown): void
}

/** One retained panel, one bounded load, and the latest show/hide intent. */
export class TrayWindowController {
  private current: BrowserWindow | null = null
  private pending: Promise<BrowserWindow> | null = null
  private cancelLoad: ((error: Error) => void) | undefined
  private requested = false
  private stopped = false

  constructor(private readonly options: TrayWindowOptions) {}
  get window(): BrowserWindow | null { return this.current }

  ensure(): Promise<BrowserWindow> {
    if (this.stopped) return Promise.reject(this.cancelled())
    if (this.pending) return this.pending
    if (this.current) return Promise.resolve(this.current)
    const pending = Promise.resolve().then(() => this.createAndLoad())
    this.pending = pending
    const settled = () => { if (this.pending === pending) this.pending = null }
    void pending.then(settled, settled)
    return pending
  }

  toggle(): void {
    if (this.stopped) return
    if (this.requested) { this.hide(); return }
    this.requested = true
    if (this.pending) return
    if (this.current) { this.options.present(this.current); return }
    void this.ensure().catch(error => { if (!this.stopped) this.options.report(error) })
  }

  hide(): void {
    this.requested = false
    this.current?.hide()
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.requested = false
    const pending = this.pending
    this.cancelLoad?.(this.cancelled())
    this.current?.destroy()
    try { await pending } catch (error) {
      if (!(error instanceof DiagnosticError && error.code === 'ABORT_ERR')) throw error
    }
  }

  private cancelled(): DiagnosticError { return new DiagnosticError('tray-load', undefined, 'ABORT_ERR', 'tray') }

  private async createAndLoad(): Promise<BrowserWindow> {
    if (this.stopped) throw this.cancelled()
    let target: BrowserWindow | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ready: (() => void) | undefined
    try {
      target = this.options.create()
      this.current = target
      const panel = target
      const contents = panel.webContents
      const loaded = new Promise<void>((resolve, reject) => {
        ready = resolve
        this.cancelLoad = reject
        panel.once('ready-to-show', ready)
        timer = setTimeout(() => reject(new DiagnosticError('tray-load', undefined, 'ETIMEDOUT', 'tray')), 10_000)
      })
      const blur = () => this.hide()
      const close = (event: Event) => { if (!this.stopped) { event.preventDefault(); this.hide() } }
      const input = (event: Event, value: Input) => { if (value.key === 'Escape') { event.preventDefault(); this.hide() } }
      const gone = () => {
        const error = new DiagnosticError('tray-load', undefined, 'OC_TRAY_RENDERER_GONE', 'tray')
        const loading = Boolean(this.pending)
        this.cancelLoad?.(error)
        panel.destroy()
        if (!loading && !this.stopped) this.options.report(error)
      }
      const closed = () => {
        this.cancelLoad?.(this.stopped ? this.cancelled() : new DiagnosticError('tray-load', undefined, 'OC_TRAY_CLOSED', 'tray'))
        panel.removeListener('blur', blur)
        panel.removeListener('close', close)
        contents.removeListener('before-input-event', input)
        contents.removeListener('render-process-gone', gone)
        if (this.current === panel) { this.current = null; this.requested = false }
      }
      panel.on('blur', blur)
      panel.on('close', close)
      panel.once('closed', closed)
      contents.on('before-input-event', input)
      contents.on('render-process-gone', gone)
      await Promise.all([loaded, Promise.resolve().then(() => {
        if (this.stopped || panel.isDestroyed()) throw this.cancelled()
        return this.options.load(panel)
      })])
      if (this.stopped || panel.isDestroyed()) throw this.cancelled()
      if (this.requested) this.options.present(panel)
      return panel
    } catch (error) {
      this.requested = false
      if (target && !target.isDestroyed()) target.destroy()
      throw error
    } finally {
      clearTimeout(timer)
      if (target && ready) target.removeListener('ready-to-show', ready)
      this.cancelLoad = undefined
    }
  }
}
