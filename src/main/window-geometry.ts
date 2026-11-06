import type { BrowserWindow, Display, Screen } from 'electron'
import type { SettingsUpdateFailure, WindowBounds } from '../shared/settings'
import { SettingsStore, settingsUpdateFailure, equalWindowBounds } from './settings'

type DisplayArea = Pick<Display, 'id' | 'workArea'>
type WindowTarget = Pick<BrowserWindow, 'on' | 'removeListener' | 'isDestroyed' | 'isMinimized' | 'isMaximized' | 'isFullScreen' | 'getNormalBounds' | 'setBounds' | 'setMinimumSize'>
type Screens = Pick<Screen, 'on' | 'removeListener' | 'getAllDisplays' | 'getPrimaryDisplay'>
const SAVE_DELAY_MS = 250


/** Window outer bounds in Electron device-independent pixels, never renderer CSS pixels. */
export function restoreWindowBounds(saved: WindowBounds | null, displays: readonly DisplayArea[], primaryId: number) {
  if (!displays.length || displays.length > 32) throw new Error('Invalid display count')
  let chosen = displays.find(display => display.id === primaryId)
  if (!chosen) throw new Error('Primary display is unavailable')
  let overlap = 0
  for (const display of displays) {
    const area = display.workArea
    if (![area.x, area.y, area.width, area.height].every(Number.isSafeInteger) || area.width < 320 || area.height < 240)
      throw new Error('Display work area is invalid or too small')
    if (!saved) continue
    const intersection = Math.max(0, Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)) *
      Math.max(0, Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y))
    if (intersection > overlap) { overlap = intersection; chosen = display }
  }
  const area = chosen.workArea
  const minWidth = Math.min(880, area.width), minHeight = Math.min(640, area.height)
  const width = Math.min(area.width, 16384, Math.max(minWidth, saved?.width ?? 1280))
  const height = Math.min(area.height, 16384, Math.max(minHeight, saved?.height ?? 860))
  const x = saved && overlap ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : area.x + Math.round((area.width - width) / 2)
  const y = saved && overlap ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : area.y + Math.round((area.height - height) / 2)
  const bounds = { x, y, width, height }
  return { bounds, minWidth, minHeight, adjusted: saved !== null && !equalWindowBounds(saved, bounds) }
}

export class WindowGeometry {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: WindowBounds | null = null
  private active: Promise<void> | null = null
  private lastNormal: WindowBounds
  private saved: WindowBounds | null
  private failure: unknown
  private stopping = false
  private detached = false
  private disposal: Promise<void> | undefined
  error: SettingsUpdateFailure | null = null

  constructor(
    private readonly target: WindowTarget,
    private readonly screens: Screens,
    private readonly settings: Pick<SettingsStore, 'value' | 'update'>,
    private readonly filename: string,
    private readonly changed: () => void,
    private readonly report: (error: unknown) => void
  ) {
    this.lastNormal = target.getNormalBounds()
    this.saved = settings.value.windowBounds
    target.on('move', this.capture)
    target.on('resize', this.capture)
    target.on('close', this.capture)
    target.on('closed', this.onClosed)
    target.on('leave-full-screen', this.finishFullScreen)
    target.on('enter-full-screen', this.finishFullScreen)
    target.on('unmaximize', this.capture)
    target.on('restore', this.capture)
    screens.on('display-removed', this.reposition)
    screens.on('display-metrics-changed', this.reposition)
    if (this.saved && !equalWindowBounds(this.saved, this.lastNormal)) this.capture()
  }

  private normal() {
    return !this.target.isDestroyed() && !this.target.isMinimized() && !this.target.isMaximized() && !this.target.isFullScreen()
  }

  private finishFullScreen = () => { this.reposition(); this.capture() }

  capture = () => {
    if (this.stopping || !this.normal()) return
    const next = this.target.getNormalBounds()
    this.lastNormal = next
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.active && !this.error && equalWindowBounds(this.saved, next)) {
      this.pending = null
      return
    }
    this.pending = next
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, SAVE_DELAY_MS)
  }

  private reposition = () => {
    if (this.stopping || !this.normal()) return
    const placement = restoreWindowBounds(this.target.getNormalBounds(), this.screens.getAllDisplays(), this.screens.getPrimaryDisplay().id)
    this.target.setMinimumSize(placement.minWidth, placement.minHeight)
    if (placement.adjusted) {
      console.info('[oc-chan] Window geometry adjusted to an available display work area')
      this.target.setBounds(placement.bounds)
      this.capture()
    }
  }

  private async save(bounds: WindowBounds): Promise<void> {
    try {
      await this.settings.update({ windowBounds: bounds })
      this.saved = bounds
      this.failure = undefined
      this.error = null
    } catch (error) {
      this.failure = error
      this.error = settingsUpdateFailure(error, this.filename)
      this.report(error)
    }
    this.changed()
  }

  async flush(): Promise<SettingsUpdateFailure | null> {
    clearTimeout(this.timer)
    this.timer = undefined
    while (this.active || this.pending) {
      if (this.active) { await this.active; continue }
      const next = this.pending!
      this.pending = null
      const operation = this.save(next)
      this.active = operation
      try { await operation } finally { if (this.active === operation) this.active = null }
    }
    return this.error
  }

  async retry(): Promise<SettingsUpdateFailure | null> {
    if (this.stopping) throw new Error('Window geometry is stopping')
    if (this.normal()) this.lastNormal = this.target.getNormalBounds()
    this.pending = this.lastNormal
    return this.flush()
  }

  private onClosed = () => {
    void this.dispose().catch(error => this.report(error))
  }

  private detach() {
    if (this.detached) return
    this.detached = true
    this.target.removeListener('move', this.capture)
    this.target.removeListener('resize', this.capture)
    this.target.removeListener('close', this.capture)
    this.target.removeListener('closed', this.onClosed)
    this.target.removeListener('leave-full-screen', this.finishFullScreen)
    this.target.removeListener('enter-full-screen', this.finishFullScreen)
    this.target.removeListener('unmaximize', this.capture)
    this.target.removeListener('restore', this.capture)
    this.screens.removeListener('display-removed', this.reposition)
    this.screens.removeListener('display-metrics-changed', this.reposition)
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.capture()
    this.stopping = true
    this.detach()
    this.disposal = this.flush().then(error => { if (error) throw this.failure })
    return this.disposal
  }
}
