import { AGENT_DISCOVERY_INTERVAL_MS, type AgentSnapshot } from '../../shared/types'
import { LiveAgents, type LiveAgentsOptions } from '../live-agents'
import { resourceAbortError, throwIfAborted } from '../resource-budget'
import type { CollectionPluginDefinition } from './contracts'

export function createAgentsPlugin(options: Omit<LiveAgentsOptions, 'signal'> = {}): CollectionPluginDefinition<'agents'> {
  return {
    id: 'agents',
    section: 'agents',
    capabilities: ['agent-discovery', 'session-activity'],
    intervalMs: AGENT_DISCOVERY_INTERVAL_MS,
    timeoutMs: 30_000,
    create(context) {
      let latest: AgentSnapshot | undefined
      let stopped = false
      const live = new LiveAgents(snapshot => {
        latest = snapshot
        context.publish(snapshot, true)
      }, { ...options, signal: context.signal })
      return {
        async collect(signal) {
          throwIfAborted(context.signal)
          throwIfAborted(signal)
          if (stopped) throw resourceAbortError()
          await live.reconcile(signal)
          throwIfAborted(context.signal)
          throwIfAborted(signal)
          if (stopped || !latest) throw resourceAbortError()
          return latest
        },
        async stop() {
          stopped = true
          try { await live.stop() }
          finally { latest = undefined }
        }
      }
    }
  }
}
