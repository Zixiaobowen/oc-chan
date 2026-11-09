import { builtinPlugins, isMonitorSection } from './plugin-catalog'
import { MAX_AGENT_ID_LENGTH, MAX_SCHEDULE_ID_LENGTH, MAX_SOURCE_ID_LENGTH, type AgentInfo, type MonitorSection, type ScheduledJob } from './types'

export type AppPage = 'overview' | MonitorSection | 'sources' | 'settings'
export type NavigationTarget =
  | { kind: 'page'; page: AppPage }
  | { kind: 'agent'; id: string; identity: string }
  | { kind: 'schedule'; id: string; identity: string }
  | { kind: 'source'; id: string; section: MonitorSection }

export interface NavigationIntent { sequence: number; target: NavigationTarget }

export function agentTarget(agent: AgentInfo): Extract<NavigationTarget, { kind: 'agent' }> {
  return { kind: 'agent', id: agent.id, identity: JSON.stringify([agent.runtime, agent.pid, agent.sessionId ?? null, agent.startedAt ?? null]) }
}

export function scheduleTarget(job: ScheduledJob): Extract<NavigationTarget, { kind: 'schedule' }> {
  return { kind: 'schedule', id: job.id, identity: JSON.stringify([job.source, job.scope, job.file ?? null, job.executable ?? null]) }
}

export function navigationPage(target: NavigationTarget): AppPage {
  return target.kind === 'page' ? target.page : target.kind === 'agent' ? 'agents' : target.kind === 'schedule' ? 'schedules' : 'sources'
}

export function parseNavigationTarget(value: unknown): NavigationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('导航目标无效 / Invalid navigation target')
  const target = value as Record<string, unknown>
  const keys = Object.keys(target)
  const only = (...allowed: string[]) => keys.length === allowed.length && keys.every(key => allowed.includes(key))
  const text = (field: unknown, max: number): field is string => typeof field === 'string' && field.length > 0 && field.length <= max && !/[\u0000-\u001f\u007f]/.test(field)
  if (target.kind === 'page' && only('kind', 'page') && (['overview', 'sources', 'settings'].includes(target.page as string) || builtinPlugins.some(plugin => plugin.page.id === target.page)))
    return { kind: 'page', page: target.page as AppPage }
  if ((target.kind === 'agent' || target.kind === 'schedule') && only('kind', 'id', 'identity') && text(target.id, target.kind === 'agent' ? MAX_AGENT_ID_LENGTH : MAX_SCHEDULE_ID_LENGTH) && text(target.identity, 16384))
    return { kind: target.kind, id: target.id, identity: target.identity }
  if (target.kind === 'source' && only('kind', 'id', 'section') && text(target.id, MAX_SOURCE_ID_LENGTH) && isMonitorSection(target.section))
    return { kind: 'source', id: target.id, section: target.section as MonitorSection }
  throw new Error('导航目标无效 / Invalid navigation target')
}

// One replaceable slot, retained until the renderer acknowledges handling it.
export class PendingNavigation {
  private intent: NavigationIntent | null = null
  private sequence = 0
  put(target: NavigationTarget): void { this.intent = { sequence: ++this.sequence, target } }
  read(): NavigationIntent | null { return this.intent }
  acknowledge(sequence: number): void {
    if (this.intent?.sequence === sequence) this.intent = null
  }
}
