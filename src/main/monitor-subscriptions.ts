import type { BrowserWindow, WebContents, WebContentsDidStartNavigationEventParams } from 'electron'
import type { MonitorUpdate, SourceHeartbeat } from '../shared/types'

type Messages = { 'monitor:changed': MonitorUpdate; 'monitor:sources': SourceHeartbeat }
interface Subscription {
  contents: WebContents
  visible: boolean
  updates: boolean
  sources: boolean
  release(): void
}

export class MonitorSubscriptions {
  private readonly entries = new Map<WebContents, Subscription>()
  constructor(private readonly headless: boolean) {}

  register(window: BrowserWindow): void {
    const contents = window.webContents
    if (this.entries.has(contents)) throw new Error('Window already registered')
    if (this.entries.size >= 2) throw new RangeError('Monitor subscriptions are limited to the two application windows')
    const reset = () => { entry.updates = false; entry.sources = false }
    const visibility = () => { entry.visible = this.headless || (window.isVisible() && !window.isMinimized()) }
    const navigation = (details: WebContentsDidStartNavigationEventParams) => {
      if (details.isMainFrame && !details.isSameDocument) reset()
    }
    const entry: Subscription = {
      contents, visible: false, updates: false, sources: false,
      release: () => {
        this.entries.delete(contents)
        window.removeListener('show', visibility)
        window.removeListener('hide', visibility)
        window.removeListener('minimize', visibility)
        window.removeListener('restore', visibility)
        window.removeListener('closed', entry.release)
        contents.removeListener('did-start-navigation', navigation)
        contents.removeListener('render-process-gone', reset)
        contents.removeListener('destroyed', entry.release)
      }
    }
    this.entries.set(contents, entry)
    visibility()
    window.on('show', visibility)
    window.on('hide', visibility)
    window.on('minimize', visibility)
    window.on('restore', visibility)
    window.on('closed', entry.release)
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', reset)
    contents.on('destroyed', entry.release)
  }

  set(contents: WebContents, updates: boolean, sources: boolean): void {
    const entry = this.entries.get(contents)
    if (!entry) throw new Error('Monitor subscription window is not registered')
    entry.updates = updates
    entry.sources = sources
  }

  publish<K extends keyof Messages>(channel: K, payload: Messages[K]): void {
    const interest = channel === 'monitor:changed' ? 'updates' : 'sources'
    for (const entry of this.entries.values()) {
      if (entry.visible && entry[interest] && !entry.contents.isDestroyed()) entry.contents.send(channel, payload)
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.release()
  }
}
