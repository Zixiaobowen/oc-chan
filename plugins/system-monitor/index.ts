import { SystemCollector } from './system'
import type { PluginSdk } from '../../src/main/marketplace/sdk'
import type { CollectionPluginDefinition } from '../../src/main/plugins/contracts'

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
