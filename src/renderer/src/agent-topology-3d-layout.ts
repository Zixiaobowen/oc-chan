import type { AgentInfo } from '../../shared/types'
import type { TopologyGraph } from './agent-topology'

export interface Point3D {
  x: number
  y: number
  z: number
}

export const MAX_3D_NODES = 1200
export const MAX_3D_EDGES = 2400

export interface OfficeFloor {
  id: string
  name: string
  cwd?: string
  level: number
  y: number
  width: number
  depth: number
  nodeIds: string[]
}

export interface OfficeLayout {
  floors: OfficeFloor[]
  positions: Map<string, Point3D>
}

export function getAgentFloorId(agent: AgentInfo): string {
  if (agent.cwd !== undefined && typeof agent.cwd !== 'string') {
    throw new TypeError('3D Agent 办公楼 cwd 必须为字符串')
  }
  return agent.cwd?.trim() ? `cwd:${agent.cwd}` : 'unknown'
}

/** Floors follow exact working directories; relationships never determine placement. */
export function buildOfficeLayout(graph: TopologyGraph): OfficeLayout {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('3D Agent 拓扑必须包含 nodes 和 edges 数组')
  }
  // Check both budgets before allocating any graph-sized layout data.
  if (graph.nodes.length > MAX_3D_NODES) {
    throw new RangeError(`3D Agent 拓扑节点数 ${graph.nodes.length} 超过上限 ${MAX_3D_NODES}`)
  }
  if (graph.edges.length > MAX_3D_EDGES) {
    throw new RangeError(`3D Agent 拓扑关系数 ${graph.edges.length} 超过上限 ${MAX_3D_EDGES}`)
  }

  const floorById = new Map<string, OfficeFloor>()
  const nodeIds = new Set<string>()
  let maximumOccupancy = 0
  for (const node of graph.nodes) {
    const agent = node?.agent
    if (!agent || typeof agent.id !== 'string' || !agent.id.trim()) {
      throw new TypeError('3D Agent 拓扑节点必须包含非空 Agent ID')
    }
    if (nodeIds.has(agent.id)) throw new Error('3D Agent 拓扑存在重复节点 ID')
    nodeIds.add(agent.id)
    const id = getAgentFloorId(agent)
    let floor = floorById.get(id)
    if (!floor) {
      const cwd = id === 'unknown' ? undefined : agent.cwd
      floor = {
        id,
        name: cwd === undefined ? '工程未识别' : cwd.replace(/\/+$/, '').split('/').pop() || cwd,
        ...(cwd === undefined ? {} : { cwd }),
        level: 0,
        y: 0,
        width: 0,
        depth: 0,
        nodeIds: [],
      }
      floorById.set(id, floor)
    }
    floor.nodeIds.push(agent.id)
    maximumOccupancy = Math.max(maximumOccupancy, floor.nodeIds.length)
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new TypeError('3D Agent 拓扑关系必须包含 source 和 target')
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`3D Agent 拓扑关系端点不存在：${edge.source} → ${edge.target}`)
    }
  }

  const floors = [...floorById.values()].sort((left, right) => {
    if (left.cwd === undefined) return right.cwd === undefined ? 0 : 1
    if (right.cwd === undefined) return -1
    return left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0
  })
  const maximumColumns = Math.ceil(Math.sqrt(maximumOccupancy))
  const maximumRows = maximumColumns === 0 ? 0 : Math.ceil(maximumOccupancy / maximumColumns)
  const width = Math.max(520, (maximumColumns - 1) * 140 + 280)
  const depth = Math.max(360, (maximumRows - 1) * 140 + 280)
  const positions = new Map<string, Point3D>()
  for (let index = 0; index < floors.length; index += 1) {
    const floor = floors[index]
    floor.level = index + 1
    floor.y = index * 240
    floor.width = width
    floor.depth = depth
    floor.nodeIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    const columns = Math.ceil(Math.sqrt(floor.nodeIds.length))
    const rows = Math.ceil(floor.nodeIds.length / columns)
    for (let seat = 0; seat < floor.nodeIds.length; seat += 1) {
      positions.set(floor.nodeIds[seat], {
        x: (seat % columns - (columns - 1) / 2) * 140,
        y: floor.y + 40,
        z: (Math.floor(seat / columns) - (rows - 1) / 2) * 140,
      })
    }
  }
  return { floors, positions }
}
