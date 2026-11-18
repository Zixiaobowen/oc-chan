import type { MonitorSection } from '../../../shared/types'
import type { RendererContribution, RendererPluginModule } from './types'

export const MAX_RENDERER_PLUGINS = 16
export const MAX_TRAY_PANELS = 64
export interface RendererEntry {
  id: string
  section: MonitorSection
  retainWhenDisabled?: boolean
  load: () => Promise<RendererPluginModule>
}
export interface RendererRegistryState {
  contributions: readonly RendererContribution[]
  errors: Readonly<Record<string, string>>
}

/** One instance per renderer. Generation tokens prevent late imports from reviving disabled plugins. */
export class RendererRegistry {
  private installed = new Map<string, RendererContribution>()
  private registrations = new Map<string, object>()
  private pending = new Map<string, object>()
  private errors: Record<string, string> = {}
  private listeners = new Set<() => void>()
  private state: RendererRegistryState = { contributions: [], errors: {} }
  constructor(private readonly entries: readonly RendererEntry[]) {
    if (entries.length > MAX_RENDERER_PLUGINS) throw new Error('Renderer plugin limit exceeded')
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate renderer plugin entry')
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): RendererRegistryState => this.state
  private publish(): void {
    this.state = { contributions: this.entries.flatMap(entry => {
      const contribution = this.installed.get(entry.id)
      return contribution ? [contribution] : []
    }), errors: { ...this.errors } }
    for (const listener of this.listeners) listener()
  }
  register(contribution: RendererContribution): () => void {
    const entry = this.entries.find(candidate => candidate.id === contribution.id)
    if (!entry || entry.section !== contribution.section || Boolean(entry.retainWhenDisabled) !== Boolean(contribution.retainWhenDisabled)) throw new Error(`Invalid renderer contribution: ${contribution.id}`)
    if (this.installed.has(contribution.id)) throw new Error(`Duplicate renderer contribution: ${contribution.id}`)
    const trayIds = contribution.tray?.map(panel => panel.id) ?? []
    const existingTrayIds = new Set([...this.installed.values()].flatMap(plugin => plugin.tray?.map(panel => panel.id) ?? []))
    if (existingTrayIds.size + trayIds.length > MAX_TRAY_PANELS || new Set(trayIds).size !== trayIds.length || trayIds.some(id => !/^[a-z][a-z0-9.-]{0,127}$/.test(id) || existingTrayIds.has(id))) throw new Error(`Invalid tray contributions: ${contribution.id}`)
    const registration = {}
    this.registrations.set(contribution.id, registration)
    this.installed.set(contribution.id, contribution)
    this.publish()
    return () => {
      if (this.registrations.get(contribution.id) !== registration) return
      this.registrations.delete(contribution.id)
      this.installed.delete(contribution.id)
      this.publish()
    }
  }
  reconcile(enabled: Readonly<Record<MonitorSection, boolean>>): void {
    let changed = false
    for (const entry of this.entries) {
      if (!enabled[entry.section] && !entry.retainWhenDisabled) {
        this.pending.delete(entry.id)
        this.registrations.delete(entry.id)
        changed = this.installed.delete(entry.id) || changed
        if (this.errors[entry.id]) { delete this.errors[entry.id]; changed = true }
        continue
      }
      if (this.installed.has(entry.id) || this.pending.has(entry.id) || this.errors[entry.id]) continue
      const token = {}
      this.pending.set(entry.id, token)
      void Promise.resolve().then(() => this.pending.get(entry.id) === token ? entry.load() : null).then(module => {
        if (!module || this.pending.get(entry.id) !== token) return
        if (module.default.id !== entry.id) throw new Error(`Renderer plugin identity mismatch: ${entry.id}`)
        this.register(module.default)
        this.pending.delete(entry.id)
      }).catch(error => {
        if (this.pending.get(entry.id) !== token) return
        this.pending.delete(entry.id)
        this.errors[entry.id] = error instanceof Error ? error.message : String(error)
        this.publish()
      })
    }
    if (changed) this.publish()
  }
  retry(): void {
    this.errors = {}
    this.publish()
  }
  /** Releases all subscriptions and registrations; a new subscription/reconcile may restart it. */
  dispose(): void {
    this.pending.clear()
    this.installed.clear()
    this.registrations.clear()
    this.errors = {}
    this.listeners.clear()
    this.publish()
  }
}
