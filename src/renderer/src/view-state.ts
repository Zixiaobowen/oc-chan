import type { AgentInfo, AgentSnapshot, ScheduledJob, ScheduleSnapshot } from '../../shared/types'
import { agentTarget, scheduleTarget } from '../../shared/navigation'
import type { AgentActivityFilter, AgentKindFilter, TopologyNodeSize } from './agent-topology'
import type { Topology3DSession } from './agent-topology-scene'

export const MAX_SAVED_TOPOLOGY_NODES = 4096
export const MAX_VIEW_QUERY_LENGTH = 1024
export interface ScrollPosition { top: number; left: number }
export interface CanvasPoint { x: number; y: number }
export interface CanvasViewport extends CanvasPoint { zoom: number }
export interface TopologyMemory {
  positions: Map<string, CanvasPoint>
  manualPositions: Map<string, CanvasPoint>
  dimensions: Map<string, TopologyNodeSize>
  viewport: CanvasViewport | null
  filterKey: string | null
  pageIndex: number | null
  office: Topology3DSession
}
export interface ScheduleViewMemory { list: ScrollPosition; detail: ScrollPosition }
export interface AgentViewState {
  query: string
  kind: AgentKindFilter
  activity: AgentActivityFilter
  collapsedIds: Set<string>
  topologyPage: number | null
  topologyView: '2d' | '3d'
  selectedId: string | null
  identity: string | null
  unavailable: boolean
  open: boolean
}
export interface ScheduleViewState {
  query: string
  kind: 'scheduled' | 'services' | 'all'
  scope: 'all' | 'personal' | ScheduledJob['scope']
  status: 'all' | ScheduledJob['state']
  selectedId: string | null
  identity: string | null
  unavailable: boolean
  open: boolean
  historyOffset: number
}

export function initialAgentView(): AgentViewState {
  return { query: '', kind: 'all', activity: 'all', collapsedIds: new Set(), topologyPage: null, topologyView: '3d', selectedId: null,
    identity: null, unavailable: false, open: false }
}
export function initialScheduleView(): ScheduleViewState {
  return { query: '', kind: 'scheduled', scope: 'all', status: 'all', selectedId: null,
    identity: null, unavailable: false, open: false, historyOffset: 0 }
}
export function createTopologyMemory(): TopologyMemory {
  return { positions: new Map(), manualPositions: new Map(), dimensions: new Map(), viewport: null, filterKey: null, pageIndex: null,
    office: { positions: new Map(), floorByAgent: new Map(), floorId: null } }
}
export function createScheduleMemory(): ScheduleViewMemory {
  return { list: { top: 0, left: 0 }, detail: { top: 0, left: 0 } }
}

export function reconcileAgentView(view: AgentViewState, data: AgentSnapshot | null): AgentViewState {
  if (!data) return view
  let collapsedIds = view.collapsedIds
  if (collapsedIds.size) {
    const ids = new Set(data.agents.map(agent => agent.id))
    for (const id of collapsedIds) if (!ids.has(id)) {
      collapsedIds = new Set([...collapsedIds].filter(saved => ids.has(saved)))
      break
    }
  }
  const selected = view.selectedId ? data.agents.find(agent => agent.id === view.selectedId) : undefined
  if (view.selectedId && (!selected || agentTarget(selected).identity !== view.identity))
    return { ...view, collapsedIds, selectedId: null, identity: null, unavailable: view.open }
  return collapsedIds === view.collapsedIds ? view : { ...view, collapsedIds }
}
export function reconcileScheduleView(view: ScheduleViewState, data: ScheduleSnapshot | null): ScheduleViewState {
  if (!data || !view.selectedId) return view
  const selected = data.jobs.find(job => job.id === view.selectedId)
  if (selected && scheduleTarget(selected).identity === view.identity) return view
  return { ...view, selectedId: null, identity: null, unavailable: view.open, historyOffset: 0 }
}

export function pruneTopologyMemory(memory: TopologyMemory, agents: readonly AgentInfo[]): void {
  if (!memory.positions.size && !memory.manualPositions.size && !memory.dimensions.size && !memory.office.positions.size && !memory.office.floorByAgent.size) return
  const alive = new Set(agents.map(agent => agent.id))
  for (const positions of [memory.positions, memory.manualPositions, memory.dimensions, memory.office.positions, memory.office.floorByAgent]) {
    for (const id of positions.keys()) if (!alive.has(id)) positions.delete(id)
  }
}

export function saveTopologyPosition(memory: TopologyMemory, id: string, point: CanvasPoint, manual: boolean): boolean {
  if (id.length > 512 || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      (!memory.positions.has(id) && memory.positions.size >= MAX_SAVED_TOPOLOGY_NODES) ||
      (manual && !memory.manualPositions.has(id) && memory.manualPositions.size >= MAX_SAVED_TOPOLOGY_NODES)) return false
  memory.positions.set(id, point)
  if (manual) memory.manualPositions.set(id, point)
  return true
}
