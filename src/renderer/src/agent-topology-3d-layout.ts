import type { AgentInfo } from '../../shared/types'
import { agentProjectDirectory, orderedTopologyBranches, projectAgentTopology, type TopologyGraph } from './agent-topology'

export interface Point3D {
  x: number
  y: number
  z: number
}

export const MAX_3D_NODES = 1200
export const MAX_3D_EDGES = 2400

export interface TaskOrbit {
  id: string
  name: string
  cwd?: string
  galaxyId: string
  x: number
  z: number
  mainAgentId: string | null
  unresolved: boolean
  index: number
  radius: number
  nodeIds: string[]
}

export interface Galaxy {
  id: string
  name: string
  cwd?: string
  x: number
  z: number
  radius: number
  tasks: TaskOrbit[]
}

export interface GalaxyLayout {
  galaxies: Galaxy[]
  tasks: TaskOrbit[]
  positions: Map<string, Point3D>
  taskByAgent: Map<string, string>
}

export interface GalaxyPlacement {
  x: number
  z: number
  radius: number
  slot: number
}

export const STAR_RADIUS = 32
export const PLANET_RADIUS = 16

const NODE_SPACING = 112
const MIN_TASK_RADIUS = 180
const TASK_PADDING = 68
const TASK_GAP = 144
const MIN_GALAXY_RADIUS = 350
const GALAXY_PADDING = 128
const GALAXY_GAP = 360
const FULL_TURN = 2 * Math.PI
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const GALAXY_MARGIN = 120
const GALAXY_VISUAL_SCALE = 1.09
const PLACEMENT_RAYS = 12

/** A square spiral gives each slot a fixed offset from the center. */
function spiralCell(index: number): { column: number; row: number } {
  if (index === 0) return { column: 0, row: 0 }
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2)
  const side = ring * 2
  const offset = (side + 1) ** 2 - 1 - index
  if (offset < side) return { column: ring - offset, row: -ring }
  if (offset < side * 2) return { column: -ring, row: -ring + offset - side }
  if (offset < side * 3) return { column: -ring + offset - side * 2, row: ring }
  return { column: ring, row: ring - (offset - side * 3) }
}

/** Retained slots keep their world coordinates while the shared pitch stays the same. */
export function placeGalaxies(galaxies: Galaxy[], slots?: ReadonlyMap<string, number>): void {
  const occupied = new Set<number>()
  let maxRadius = 0
  for (const galaxy of galaxies) {
    maxRadius = Math.max(maxRadius, galaxy.radius)
    const slot = slots?.get(galaxy.id)
    if (slot === undefined) continue
    if (!Number.isSafeInteger(slot) || slot < 0 || occupied.has(slot)) {
      throw new RangeError(`3D Agent 星系位置无效：${galaxy.id} (${slot})`)
    }
    occupied.add(slot)
  }
  const pitch = maxRadius * 2 + GALAXY_GAP
  let nextSlot = 0
  for (const galaxy of galaxies) {
    let slot = slots?.get(galaxy.id)
    if (slot === undefined) {
      while (occupied.has(nextSlot)) nextSlot++
      slot = nextSlot++
    }
    const cell = spiralCell(slot)
    galaxy.x = cell.column * pitch
    galaxy.z = cell.row * pitch
  }
}

function placeTaskAgents(task: TaskOrbit, positions: Map<string, Point3D>, taskByAgent: Map<string, string>): void {
  let ring = 0
  let radius = 0
  let capacity = 0
  let seat = 0
  let remaining = task.nodeIds.length - Number(task.mainAgentId !== null)
  for (const id of task.nodeIds) {
    taskByAgent.set(id, task.id)
    if (id === task.mainAgentId) {
      positions.set(id, { x: 0, y: 0, z: 0 })
      continue
    }
    if (seat === capacity) {
      ring++
      radius = ring * NODE_SPACING
      capacity = Math.min(remaining, Math.floor(FULL_TURN * ring))
      remaining -= capacity
      seat = 0
    }
    const angle = ring * GOLDEN_ANGLE + FULL_TURN * seat / capacity
    positions.set(id, { x: radius * Math.cos(angle), y: 0, z: radius * Math.sin(angle) })
    seat++
  }
  task.radius = Math.max(MIN_TASK_RADIUS, radius + TASK_PADDING)
}

/** Each real relationship branch forms a task in the confirmed root's project. */
export function buildGalaxyLayout(graph: TopologyGraph): GalaxyLayout {
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
      throw new TypeError('3D Agent 拓扑 cwd 必须为字符串')
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
  const rootIds = new Set(roots)
  for (let index = 0; index < roots.length; index += 1) {
    for (const child of children.get(roots[index])!) {
      const remaining = incoming.get(child)! - 1
      incoming.set(child, remaining)
      if (remaining === 0) roots.push(child)
    }
  }

  const galaxyById = new Map<string, Galaxy>()
  for (const branch of orderedTopologyBranches(graph)) {
    const root = agents.get(branch.rootId)!
    const unresolved = root.kind !== 'main' || root.parentId !== undefined || branch.ids.some(id => {
      const agent = agents.get(id)!
      return incoming.get(id)! > 0 || (id !== root.id && rootIds.has(id))
        || (agent.parentId !== undefined && !agents.has(agent.parentId))
    })
    const cwd = !unresolved && root.cwd?.trim() ? agentProjectDirectory(root.cwd) : undefined
    const galaxyId = unresolved ? 'unresolved' : cwd === undefined ? 'unknown' : `cwd:${cwd}`
    let galaxy = galaxyById.get(galaxyId)
    if (!galaxy) {
      const name = unresolved ? '待归属' : cwd === undefined ? '工程未识别' : cwd.split('/').pop() || cwd
      galaxy = {
        id: galaxyId, name,
        ...(cwd === undefined ? {} : { cwd }),
        x: 0, z: 0, radius: MIN_GALAXY_RADIUS, tasks: [],
      }
      galaxyById.set(galaxyId, galaxy)
    }
    galaxy.tasks.push({
      id: `task:${branch.rootId}`,
      name: root.summary || root.name,
      ...(cwd === undefined ? {} : { cwd }),
      galaxyId, mainAgentId: unresolved ? null : root.id, unresolved,
      x: 0, z: 0, index: 0, radius: MIN_TASK_RADIUS,
      nodeIds: branch.ids,
    })
  }

  const galaxies = [...galaxyById.values()].sort((left, right) => {
    if (left.cwd === undefined) return right.cwd === undefined ? Number(left.id === 'unresolved') - Number(right.id === 'unresolved') : 1
    if (right.cwd === undefined) return -1
    return left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0
  })
  const tasks: TaskOrbit[] = []
  const positions = new Map<string, Point3D>()
  const taskByAgent = new Map<string, string>()
  for (const galaxy of galaxies) {
    galaxy.tasks.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    let maxRadius = 0
    for (const task of galaxy.tasks) {
      placeTaskAgents(task, positions, taskByAgent)
      maxRadius = Math.max(maxRadius, task.radius)
    }
    const pitch = maxRadius * 2 + TASK_GAP
    for (const [index, task] of galaxy.tasks.entries()) {
      const cell = spiralCell(index)
      task.index = index
      task.x = cell.column * pitch
      task.z = cell.row * pitch
      galaxy.radius = Math.max(galaxy.radius, Math.hypot(task.x, task.z) + task.radius + GALAXY_PADDING)
      tasks.push(task)
    }
  }
  placeGalaxies(galaxies)
  return { galaxies, tasks, positions, taskByAgent }
}

/** Each snapshot agent supplies at most one parent edge. Guard before constructing a second projection. */
export function buildSnapshotGalaxyLayout(agents: AgentInfo[]): GalaxyLayout | null {
  if (agents.length > MAX_3D_NODES) return null
  return buildGalaxyLayout(projectAgentTopology(agents, 'all', 'all', '', new Set()))
}

/** Use the full snapshot's layout while exposing only tasks and agents in the projection. */
export function projectGalaxyLayout(full: GalaxyLayout, graph: TopologyGraph): GalaxyLayout {
  if (graph.nodes.length > MAX_3D_NODES || graph.edges.length > MAX_3D_EDGES) {
    throw new RangeError('超出星系布局显示上限')
  }
  const visible = new Set(graph.nodes.map(node => node.agent.id))
  const galaxies: Galaxy[] = []
  const tasks: TaskOrbit[] = []
  const positions = new Map<string, Point3D>()
  const taskByAgent = new Map<string, string>()
  for (const galaxy of full.galaxies) {
    const visibleTasks: TaskOrbit[] = []
    for (const task of galaxy.tasks) {
      const nodeIds = task.nodeIds.filter(id => visible.has(id))
      if (!nodeIds.length) continue
      const projection = { ...task, nodeIds }
      visibleTasks.push(projection)
      tasks.push(projection)
      for (const id of nodeIds) {
        positions.set(id, full.positions.get(id)!)
        taskByAgent.set(id, task.id)
        visible.delete(id)
      }
    }
    if (visibleTasks.length) galaxies.push({ ...galaxy, tasks: visibleTasks })
  }
  if (visible.size) throw new Error(`完整 3D 布局缺少 Agent ${visible.values().next().value}`)
  return { galaxies, tasks, positions, taskByAgent }
}

/** Intersect candidate rays with the reserved disks and use the nearest free point. */
function findGalaxyPosition(radius: number, slot: number, obstacles: ReadonlyMap<string, GalaxyPlacement>, originX = 0, originZ = 0): GalaxyPlacement {
  const intervals: { start: number; end: number }[] = []
  let distance = Infinity
  let x = 0, z = 0
  for (let index = 0; index < PLACEMENT_RAYS; index++) {
    const angle = slot * GOLDEN_ANGLE + index * FULL_TURN / PLACEMENT_RAYS
    const dx = Math.cos(angle), dz = Math.sin(angle)
    intervals.length = 0
    for (const obstacle of obstacles.values()) {
      const x = obstacle.x - originX, z = obstacle.z - originZ
      const along = x * dx + z * dz
      const across = x * dz - z * dx
      const clearance = radius + obstacle.radius + GALAXY_MARGIN * 2
      const square = clearance * clearance - across * across
      if (square <= 0) continue
      const reach = Math.sqrt(square)
      if (along + reach >= 0) intervals.push({ start: along - reach, end: along + reach })
    }
    intervals.sort((left, right) => left.start - right.start)
    let next = 0
    for (const interval of intervals) {
      if (interval.start > next) break
      if (interval.end >= next) next = interval.end + 1
    }
    if (next < distance) {
      distance = next
      x = originX + dx * next
      z = originZ + dz * next
    }
    if (distance === 0) break
  }
  return { x, z, radius, slot }
}

/** Full snapshots distinguish actual project growth from a change of filters. */
export function planGalaxyPlacement(
  visible: readonly Galaxy[],
  full: readonly Galaxy[] | null,
  saved: ReadonlyMap<string, GalaxyPlacement>,
): { placements: Map<string, GalaxyPlacement>; evicted: boolean; relocated: number } | { conflict: Galaxy } {
  const needed = full ?? visible
  if (visible.length > MAX_3D_NODES || needed.length > MAX_3D_NODES || saved.size > MAX_3D_NODES) {
    throw new RangeError('超出星系布局位置缓存上限')
  }
  const required = new Set(needed.map(galaxy => galaxy.id))
  const placements = new Map<string, GalaxyPlacement>()
  let excess = required.size - MAX_3D_NODES
  for (const id of saved.keys()) if (!required.has(id)) excess++
  const evicted = full === null && excess > 0
  // Drop the least recently displayed hidden placements first in an oversized source.
  for (const [id, position] of saved) {
    if (required.has(id)) placements.set(id, position)
    else if (!full && excess <= 0) placements.set(id, position)
    else if (!full) excess--
  }
  if (!placements.size) {
    // The snapshot layout already has non-overlapping centers on a fixed-pitch spiral.
    for (const [slot, galaxy] of needed.entries()) {
      placements.set(galaxy.id, {
        x: galaxy.x * GALAXY_VISUAL_SCALE, z: galaxy.z * GALAXY_VISUAL_SCALE, radius: galaxy.radius * GALAXY_VISUAL_SCALE, slot,
      })
    }
  }
  const occupiedSlots = new Set([...placements.values()].map(position => position.slot))
  let slot = 0
  const moved: { id: string; radius: number; from: GalaxyPlacement }[] = []
  for (const galaxy of needed) {
    const current = placements.get(galaxy.id)
    const radius = galaxy.radius * GALAXY_VISUAL_SCALE
    if (!current || current.radius >= radius) continue
    let overlaps = false
    for (const [id, other] of placements) {
      if (id !== galaxy.id && (current.x - other.x) ** 2 + (current.z - other.z) ** 2 < (radius + other.radius) ** 2) {
        overlaps = true
        break
      }
    }
    if (!overlaps) placements.set(galaxy.id, { ...current, radius })
    else {
      if (!full) return { conflict: galaxy }
      placements.delete(galaxy.id)
      moved.push({ id: galaxy.id, radius, from: current })
    }
  }
  for (const { id, radius, from } of moved) {
    placements.set(id, findGalaxyPosition(radius, from.slot, placements, from.x, from.z))
  }
  for (const galaxy of needed) {
    if (placements.has(galaxy.id)) continue
    while (occupiedSlots.has(slot)) slot++
    placements.set(galaxy.id, findGalaxyPosition(galaxy.radius * GALAXY_VISUAL_SCALE, slot, placements))
    occupiedSlots.add(slot)
  }
  for (const galaxy of visible) {
    const placement = placements.get(galaxy.id)!
    placements.delete(galaxy.id)
    placements.set(galaxy.id, placement)
  }
  return { placements, evicted, relocated: moved.length }
}

export function agentOrbitLimits(id: string, task: TaskOrbit): { inner: number; outer: number } {
  if (id === task.mainAgentId) return { inner: 0, outer: 18 }
  return { inner: task.unresolved ? 0 : STAR_RADIUS + PLANET_RADIUS + 16, outer: task.radius - PLANET_RADIUS - 8 }
}

export function agentPositionsOverlap(task: TaskOrbit, id: string, point: Point3D, otherId: string, other: Point3D): boolean {
  const clearance = (id === task.mainAgentId ? STAR_RADIUS : PLANET_RADIUS)
    + (otherId === task.mainAgentId ? STAR_RADIUS : PLANET_RADIUS) + 8
  return (point.x - other.x) ** 2 + (point.z - other.z) ** 2 < clearance ** 2
}

export function saveManualGalaxyPosition(
  positions: Map<string, Point3D>, taskByAgent: Map<string, string>, id: string, taskId: string, point: Point3D,
): boolean {
  if (!positions.has(id) && positions.size >= MAX_3D_NODES) return false
  positions.set(id, point)
  taskByAgent.set(id, taskId)
  return true
}

/** Reserve saved positions before assigning defaults. Temporary exclusions leave the saved values intact. */
export function restoreTaskPositions(
  task: TaskOrbit,
  positions: Map<string, Point3D>,
  manual: ReadonlyMap<string, Point3D>,
  taskByAgent: ReadonlyMap<string, string>,
): void {
  const placed = new Map<string, Point3D>()
  const overlaps = (id: string, point: Point3D) => {
    for (const [otherId, other] of placed) if (agentPositionsOverlap(task, id, point, otherId, other)) return true
    return false
  }
  for (const id of task.nodeIds) {
    if (taskByAgent.get(id) !== task.id) continue
    const point = manual.get(id)
    if (!point) continue
    const { inner, outer } = agentOrbitLimits(id, task)
    const distance = Math.hypot(point.x, point.z)
    if (distance >= inner && distance <= outer && !overlaps(id, point)) placed.set(id, point)
  }
  if (!placed.size) return
  const displaced: string[] = []
  for (const id of task.nodeIds) {
    if (placed.has(id)) continue
    const point = positions.get(id)!
    if (overlaps(id, point)) displaced.push(id)
    else placed.set(id, point)
  }
  const seats = task.nodeIds.values()
  for (const id of displaced) {
    // One saved planet can block at most one default seat. All displaced planets have the same radius.
    let seat = seats.next()
    while (!seat.done && (seat.value === task.mainAgentId || overlaps(id, positions.get(seat.value)!))) seat = seats.next()
    if (seat.done) throw new Error(`任务 ${task.id} 没有剩余的 Agent 轨道位置`)
    placed.set(id, positions.get(seat.value)!)
  }
  for (const [id, point] of placed) positions.set(id, point)
}

/** A real sphere intersection wins over every tolerance hit, even one closer to the camera. */
export function pickAgentOnRay(
  ray: { origin: Point3D; direction: Point3D },
  ids: Iterable<string>,
  centerFor: (id: string) => Point3D,
  radiusFor: (id: string) => number,
  slopPerUnit: number,
): string | null {
  const { origin, direction } = ray
  let exact: string | null = null, tolerant: string | null = null
  let exactDepth = Infinity, tolerantDepth = Infinity
  for (const id of ids) {
    const center = centerFor(id)
    const x = center.x - origin.x, y = center.y - origin.y, z = center.z - origin.z
    const depth = x * direction.x + y * direction.y + z * direction.z
    const distanceSquared = (x - direction.x * depth) ** 2 + (y - direction.y * depth) ** 2 + (z - direction.z * depth) ** 2
    const radius = radiusFor(id)
    const reachSquared = radius ** 2 - distanceSquared
    if (reachSquared >= 0) {
      const reach = Math.sqrt(reachSquared)
      const near = depth - reach
      const surface = near >= 0 ? near : depth + reach
      if (surface >= 0 && surface < exactDepth) {
        exactDepth = surface
        exact = id
      }
    } else if (exact === null && depth > 0 && depth < tolerantDepth
      && distanceSquared <= (radius + Math.min(16, depth * slopPerUnit)) ** 2) {
      tolerantDepth = depth
      tolerant = id
    }
  }
  return exact ?? tolerant
}
