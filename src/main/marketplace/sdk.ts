import { SAMPLING_INTERVALS } from '../../shared/types'
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
  readonly samplingIntervals: typeof SAMPLING_INTERVALS
}

export const pluginSdk: PluginSdk = Object.freeze({
  apiVersion: 1,
  collectionResources: Object.freeze({ run: collectionResources.run.bind(collectionResources), snapshot: collectionResources.snapshot.bind(collectionResources) }),
  runBudgetedCommand, isResourceAbort, isResourceCleanupFailure, resourceSourceStatus, settleResourceWork, throwIfAborted,
  samplingIntervals: SAMPLING_INTERVALS
})
