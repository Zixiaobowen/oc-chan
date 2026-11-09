import { monitorPlugins } from '../../shared/plugin-catalog'
import type { AnyCollectionPlugin, CollectionPluginDefinition } from './contracts'
import type { EventsPluginOptions } from './events'
import { lazyCollectionPlugin } from './lazy'

/** Trusted entry points are explicit, keeping imports statically auditable and bundleable. */
export function createBuiltinCollectionPlugins(events: EventsPluginOptions): AnyCollectionPlugin[] {
  const uid = process.getuid?.() ?? 0
  // Runtime registry loading keeps disabled plugins and their dependencies unloaded; static imports would eagerly load them.
  const entries: { [K in 'agents' | 'schedules' | 'events']: { capabilities: readonly string[]; timeoutMs: number; retrySources?: readonly string[]; load: () => Promise<CollectionPluginDefinition<K>> } } = {
    agents: { capabilities: ['agent-discovery', 'session-activity'], timeoutMs: 30_000, load: async () => (await import('./agents')).createAgentsPlugin() },
    schedules: { capabilities: ['scheduled-jobs', 'schedule-history'], timeoutMs: 30_000, retrySources: [`launchctl:gui/${uid}`, `launchctl:user/${uid}`, 'launchctl:system'], load: async () => (await import('./schedules')).createSchedulesPlugin({ uid }) },
    events: { capabilities: ['local-events'], timeoutMs: 15_000, load: async () => (await import('./events')).createEventsPlugin(events) }
  }
  return monitorPlugins.filter(metadata => metadata.section === 'agents' || metadata.section === 'schedules' || metadata.section === 'events').map(metadata => {
    const entry = entries[metadata.section as keyof typeof entries]
    return lazyCollectionPlugin({ id: metadata.id, section: metadata.section, intervalMs: metadata.intervalMs,
      capabilities: entry.capabilities, timeoutMs: entry.timeoutMs, retrySources: entry.retrySources }, entry.load) as AnyCollectionPlugin
  })
}
