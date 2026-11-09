import { systemMonitorManifest } from '../manifest'
import { SystemCollector } from './system'
import type { CollectionPluginDefinition, CollectionServices } from '../../../main/plugins/contracts'

export function createSystemPlugin(
  createCollector: (services: CollectionServices) => Pick<SystemCollector, 'collect' | 'dispose'> = services => new SystemCollector(services)
): CollectionPluginDefinition<'system'> {
  return {
    id: 'system',
    section: 'system',
    capabilities: ['system-metrics', 'process-ranking'],
    intervalMs: systemMonitorManifest.intervalMs,
    timeoutMs: 30_000,
    create(context) {
      const collector = createCollector(context)
      return {
        collect: signal => collector.collect(signal),
        stop: () => collector.dispose()
      }
    }
  }
}
