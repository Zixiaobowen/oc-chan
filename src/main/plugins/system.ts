import { SAMPLING_INTERVALS } from '../../shared/types'
import { SystemCollector } from '../collectors/system'
import type { CollectionPluginDefinition } from './contracts'

export function createSystemPlugin(
  createCollector: () => Pick<SystemCollector, 'collect' | 'dispose'> = () => new SystemCollector()
): CollectionPluginDefinition<'system'> {
  return {
    id: 'system',
    section: 'system',
    capabilities: ['system-metrics', 'process-ranking'],
    intervalMs: SAMPLING_INTERVALS.system,
    timeoutMs: 30_000,
    create() {
      const collector = createCollector()
      return {
        collect: signal => collector.collect(signal),
        stop: () => collector.dispose()
      }
    }
  }
}
