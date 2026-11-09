import type { MonitorSection } from '../../shared/types'
import { monitorPlugins } from '../../shared/plugin-catalog'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, resourceSourceStatus, settleResourceWork, throwIfAborted } from '../resource-budget'
import { runBudgetedCommand } from '../resource-io'

/** Public host services. These references use the host's one process-wide resource pool. */
export interface PluginSdk {
  readonly apiVersion: 1
  readonly collectionResources: Pick<typeof collectionResources, 'run' | 'snapshot'>
  readonly runBudgetedCommand: typeof runBudgetedCommand
  readonly isResourceAbort: typeof isResourceAbort
  readonly isResourceCleanupFailure: typeof isResourceCleanupFailure
  readonly resourceSourceStatus: typeof resourceSourceStatus
  readonly settleResourceWork: typeof settleResourceWork
  readonly throwIfAborted: typeof throwIfAborted
  readonly samplingIntervals: Readonly<Record<MonitorSection, number>>
}

export const pluginSdk: PluginSdk = Object.freeze({
  apiVersion: 1,
  collectionResources: Object.freeze({ run: collectionResources.run.bind(collectionResources), snapshot: collectionResources.snapshot.bind(collectionResources) }),
  runBudgetedCommand, isResourceAbort, isResourceCleanupFailure, resourceSourceStatus, settleResourceWork, throwIfAborted,
  samplingIntervals: Object.freeze(Object.fromEntries(monitorPlugins.map(plugin => [plugin.section, plugin.intervalMs])) as Record<MonitorSection, number>)
})
