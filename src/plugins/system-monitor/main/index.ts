import type { PluginSdk } from '../../../main/marketplace/sdk'
import { SystemCollector } from './system'
import type { CollectionPluginDefinition } from '../../../main/plugins/contracts'

export function createPlugin(sdk: PluginSdk): CollectionPluginDefinition<'system'> {
  return {
    id: 'system',
    section: 'system',
    capabilities: ['system-metrics', 'process-ranking'],
    intervalMs: sdk.samplingIntervals.system,
    timeoutMs: 30_000,
    create() {
      const collector = new SystemCollector(sdk)
      return {
        collect: signal => collector.collect(signal),
        stop: () => collector.dispose()
      }
    }
  }
}
