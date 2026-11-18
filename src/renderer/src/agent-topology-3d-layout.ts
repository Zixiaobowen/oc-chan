import type { AgentInfo } from '../../shared/types'
import { agentProjectDirectory, orderedTopologyBranches, type TopologyGraph } from './agent-topology'

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
  buildingId: string
  x: number
  z: number
  mainAgentId: string | null
  unresolved: boolean
  level: number
  y: number
  width: number
  depth: number
  nodeIds: string[]
}

export interface OfficeBuilding {
  id: string
  name: string
  cwd?: string
  x: number
  z: number
  width: number
  depth: number
  floors: OfficeFloor[]
}

export interface OfficeLayout {
  buildings: OfficeBuilding[]
  floors: OfficeFloor[]
  positions: Map<string, Point3D>
  floorByAgent: Map<string, string>
}

// A street is separated from every facade by a walkable setback; entrances
// project 86 units, so the 120-unit pavement keeps steps off the carriageway.
export const STREET_WIDTH = 160
export const STREET_SETBACK = 120

export function officeStreetGrid(width: number, depth: number) {
  return {
    pitchX: width + STREET_SETBACK * 2 + STREET_WIDTH,
    pitchZ: depth + STREET_SETBACK * 2 + STREET_WIDTH,
  }
}

/** An outward square spiral keeps existing parcels fixed as projects arrive. */
export function officeStreetCell(index: number): { column: number; row: number } {
  if (index === 0) return { column: 0, row: 0 }
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2)
  const side = ring * 2
  const offset = (side + 1) ** 2 - 1 - index
  if (offset < side) return { column: ring - offset, row: -ring }
  if (offset < side * 2) return { column: -ring, row: -ring + offset - side }
  if (offset < side * 3) return { column: -ring + offset - side * 2, row: ring }
  return { column: ring, row: ring - (offset - side * 3) }
}

/** Also used after manual seats enlarge the shared building envelope. */
export function placeOfficeBuildings(buildings: OfficeBuilding[], width: number, depth: number, slots?: ReadonlyMap<string, number>): void {
  const grid = officeStreetGrid(width, depth)
  for (let index = 0; index < buildings.length; index++) {
    const building = buildings[index]
    const cell = officeStreetCell(slots?.get(building.id) ?? index)
    building.x = cell.column * grid.pitchX
    building.z = cell.row * grid.pitchZ
    building.width = width
    building.depth = depth
    for (const floor of building.floors) {
      floor.x = building.x
      floor.z = building.z
      floor.width = width
      floor.depth = depth
    }
  }
}

/** Each relationship branch occupies a floor in its root's project building. */
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

  const agents = new Map<string, AgentInfo>()
  for (const node of graph.nodes) {
    const agent = node?.agent
    if (!agent || typeof agent.id !== 'string' || !agent.id.trim()) {
      throw new TypeError('3D Agent 拓扑节点必须包含非空 Agent ID')
    }
    if (agents.has(agent.id)) throw new Error('3D Agent 拓扑存在重复节点 ID')
    if (agent.cwd !== undefined && typeof agent.cwd !== 'string') {
      throw new TypeError('3D Agent 办公楼 cwd 必须为字符串')
    }
    if (agent.parentId !== undefined && typeof agent.parentId !== 'string') {
      throw new TypeError('3D Agent 拓扑 parentId 必须为字符串')
    }
    agents.set(agent.id, agent)
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new TypeError('3D Agent 拓扑关系必须包含 source 和 target')
    }
    if (!agents.has(edge.source) || !agents.has(edge.target)) {
      throw new Error(`3D Agent 拓扑关系端点不存在：${edge.source} → ${edge.target}`)
    }
  }

  // Iterative removal detects cycles without recursing through deep task chains.
  const incoming = new Map(graph.nodes.map(node => [node.agent.id, 0]))
  const children = new Map(graph.nodes.map(node => [node.agent.id, [] as string[]]))
  for (const edge of graph.edges) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1)
    children.get(edge.source)!.push(edge.target)
  }
  const roots = [...agents.keys()].filter(id => incoming.get(id) === 0)
  for (let index = 0; index < roots.length; index += 1) {
    for (const child of children.get(roots[index])!) {
      const remaining = incoming.get(child)! - 1
      incoming.set(child, remaining)
      if (remaining === 0) roots.push(child)
    }
  }

  const buildingById = new Map<string, OfficeBuilding>()
  let maximumSharedOccupancy = 0
  for (const branch of orderedTopologyBranches(graph)) {
    const root = agents.get(branch.rootId)!
    const cwd = root.cwd?.trim() ? agentProjectDirectory(root.cwd) : undefined
    const buildingId = cwd === undefined ? 'unknown' : `cwd:${cwd}`
    let building = buildingById.get(buildingId)
    if (!building) {
      building = {
        id: buildingId,
        name: cwd === undefined ? '工程未识别' : cwd.split('/').pop() || cwd,
        ...(cwd === undefined ? {} : { cwd }),
        x: 0, z: 0, width: 0, depth: 0, floors: [],
      }
      buildingById.set(buildingId, building)
    }
    const unresolved = root.kind !== 'main' || branch.ids.some(id => {
      const agent = agents.get(id)!
      return incoming.get(id)! > 0 || (agent.parentId !== undefined && !agents.has(agent.parentId))
    })
    const mainAgentId = unresolved ? null : root.id
    const floor: OfficeFloor = {
      id: `task:${branch.rootId}`,
      name: root.summary || root.name,
      ...(cwd === undefined ? {} : { cwd }),
      buildingId, mainAgentId, unresolved,
      x: 0, z: 0, level: 0, y: 0, width: 0, depth: 0,
      nodeIds: branch.ids,
    }
    building.floors.push(floor)
    maximumSharedOccupancy = Math.max(maximumSharedOccupancy, branch.ids.length - Number(mainAgentId !== null))
  }

  const buildings = [...buildingById.values()].sort((left, right) => {
    if (left.cwd === undefined) return right.cwd === undefined ? 0 : 1
    if (right.cwd === undefined) return -1
    return left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0
  })
  const maximumColumns = Math.ceil(Math.sqrt(maximumSharedOccupancy))
  const maximumRows = maximumColumns === 0 ? 0 : Math.ceil(maximumSharedOccupancy / maximumColumns)
  const width = Math.max(760, 530 + (maximumColumns - 1) * 140)
  const depth = Math.max(420, 280 + (maximumRows - 1) * 140)
  placeOfficeBuildings(buildings, width, depth)
  const floors: OfficeFloor[] = []
  const positions = new Map<string, Point3D>()
  const floorByAgent = new Map<string, string>()
  for (let index = 0; index < buildings.length; index += 1) {
    const building = buildings[index]
    building.floors.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    for (let level = 0; level < building.floors.length; level += 1) {
      const floor = building.floors[level]
      floor.level = level + 1
      floor.y = level * 240
      floor.x = building.x
      floor.z = building.z
      floor.width = width
      floor.depth = depth
      floors.push(floor)
      const sharedOccupancy = floor.nodeIds.length - Number(floor.mainAgentId !== null)
      const columns = Math.ceil(Math.sqrt(sharedOccupancy))
      const rows = columns === 0 ? 0 : Math.ceil(sharedOccupancy / columns)
      let seat = 0
      for (const id of floor.nodeIds) {
        floorByAgent.set(id, floor.id)
        if (id === floor.mainAgentId) {
          positions.set(id, { x: -width / 2 + 160, y: floor.y + 40, z: 0 })
        } else {
          positions.set(id, {
            x: -width / 2 + 390 + seat % columns * 140,
            y: floor.y + 40,
            z: (Math.floor(seat / columns) - (rows - 1) / 2) * 140,
          })
          seat += 1
        }
      }
    }
  }
  return { buildings, floors, positions, floorByAgent }
}
