import { Graph, layout } from '@dagrejs/dagre'
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre'
import type { AgentInfo } from '../../shared/types'

export const AGENT_NODE_WIDTH = 260
export const AGENT_NODE_HEIGHT = 182

export type AgentKindFilter = 'all' | 'main' | 'subagent'
export type AgentActivityFilter = 'all' | 'active' | 'inactive'

export interface TopologyNode {
  agent: AgentInfo
  contextOnly: boolean
  childCount: number
  descendantCount: number
  collapsed: boolean
  issue?: string
}

export interface TopologyGraph {
  nodes: TopologyNode[]
  edges: { id: string; source: string; target: string }[]
  matchCount: number
  contextCount: number
  hiddenCount: number
  issueCount: number
  layoutKey: string
}

const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export function projectAgentTopology(
  agents: AgentInfo[],
  kind: AgentKindFilter,
  activity: AgentActivityFilter,
  query: string,
  collapsedIds: ReadonlySet<string>,
): TopologyGraph {
  const ordered = [...agents].sort((left, right) => compareIds(left.id, right.id))
  const byId = new Map(ordered.map(agent => [agent.id, agent]))
  const children = new Map(ordered.map(agent => [agent.id, [] as string[]]))
  for (const agent of ordered) {
    if (agent.parentId !== undefined) children.get(agent.parentId)?.push(agent.id)
  }

  // Removing leaves accumulates subtree sizes. What remains consists only of cycles.
  const remainingChildren = new Map(ordered.map(agent => [agent.id, children.get(agent.id)!.length]))
  const descendants = new Map(ordered.map(agent => [agent.id, 0]))
  const leaves = ordered.filter(agent => remainingChildren.get(agent.id) === 0).map(agent => agent.id)
  for (let index = 0; index < leaves.length; index += 1) {
    const id = leaves[index]
    const parentId = byId.get(id)!.parentId
    if (parentId === undefined || !byId.has(parentId)) continue
    descendants.set(parentId, descendants.get(parentId)! + descendants.get(id)! + 1)
    const remaining = remainingChildren.get(parentId)! - 1
    remainingChildren.set(parentId, remaining)
    if (remaining === 0) leaves.push(parentId)
  }

  const cycleIds = new Set<string>()
  for (const agent of ordered) {
    if (remainingChildren.get(agent.id) === 0 || cycleIds.has(agent.id)) continue
    const cycle: string[] = []
    let id = agent.id
    while (!cycleIds.has(id)) {
      cycleIds.add(id)
      cycle.push(id)
      id = byId.get(id)!.parentId!
    }
    const count = cycle.reduce((total, member) => total + descendants.get(member)! + 1, 0) - 1
    for (const member of cycle) descendants.set(member, count)
  }

  const normalizedQuery = query.trim().toLowerCase()
  const matches = new Set(ordered.filter(agent => {
    if (kind !== 'all' && agent.kind !== kind) return false
    const active = agent.state === 'working' || Boolean(agent.activity)
    if (activity === 'active' && !active) return false
    if (activity === 'inactive' && (active || agent.state !== 'idle')) return false
    return !normalizedQuery || [agent.name, agent.summary, agent.runtime, agent.cwd, agent.model, String(agent.pid)]
      .some(value => value?.toLowerCase().includes(normalizedQuery))
  }).map(agent => agent.id))
  const included = new Set(matches)

  // Walk ancestors separately: context ancestors must not pull in unmatched siblings.
  const expandedAncestors = new Set<string>()
  for (const match of matches) {
    let id: string | undefined = match
    while (id !== undefined && byId.has(id) && !expandedAncestors.has(id)) {
      expandedAncestors.add(id)
      included.add(id)
      id = byId.get(id)!.parentId
    }
  }
  // Activity filters retain ancestors without bringing back unmatched descendants.
  if (activity === 'all') {
    const expandedDescendants = new Set(matches)
    const descendantQueue = [...matches]
    for (let index = 0; index < descendantQueue.length; index += 1) {
      for (const child of children.get(descendantQueue[index])!) {
        if (expandedDescendants.has(child)) continue
        expandedDescendants.add(child)
        included.add(child)
        descendantQueue.push(child)
      }
    }
  }

  const allowCollapse = kind === 'all' && activity === 'all' && normalizedQuery === ''
  const hidden = new Set<string>()
  if (allowCollapse) {
    for (const agent of ordered) {
      if (!collapsedIds.has(agent.id) || hidden.has(agent.id)) continue
      const queue = [...children.get(agent.id)!]
      const visited = new Set([agent.id])
      for (let index = 0; index < queue.length; index += 1) {
        const id = queue[index]
        if (visited.has(id) || hidden.has(id)) continue
        visited.add(id)
        hidden.add(id)
        queue.push(...children.get(id)!)
      }
    }
  }

  const nodes: TopologyNode[] = []
  for (const agent of ordered) {
    if (!included.has(agent.id) || hidden.has(agent.id)) continue
    let issue: string | undefined
    if (cycleIds.has(agent.id)) issue = '父子关系存在循环'
    else if (agent.parentId !== undefined && !byId.has(agent.parentId)) issue = '父 Agent 不在当前快照中'
    else if (agent.kind === 'subagent' && agent.parentId === undefined) issue = '未提供父 Agent 关系'
    nodes.push({
      agent,
      contextOnly: !matches.has(agent.id),
      childCount: children.get(agent.id)!.length,
      descendantCount: descendants.get(agent.id)!,
      collapsed: allowCollapse && collapsedIds.has(agent.id) && descendants.get(agent.id)! > 0,
      issue,
    })
  }
  const visibleIds = new Set(nodes.map(node => node.agent.id))
  const edges: TopologyGraph['edges'] = []
  for (const { agent } of nodes) {
    if (agent.parentId === undefined || !visibleIds.has(agent.parentId)) continue
    edges.push({ id: JSON.stringify([agent.parentId, agent.id]), source: agent.parentId, target: agent.id })
  }
  return {
    nodes,
    edges,
    matchCount: matches.size,
    contextCount: nodes.filter(node => node.contextOnly).length,
    hiddenCount: hidden.size,
    issueCount: nodes.filter(node => node.issue !== undefined).length,
    layoutKey: JSON.stringify([nodes.map(node => node.agent.id), edges.map(edge => [edge.source, edge.target])]),
  }
}

interface LayoutComponent {
  ids: string[]
  edges: TopologyGraph['edges']
  positions: Map<string, { x: number; y: number }>
  width: number
}

export function layoutAgentTopology(graph: TopologyGraph): Map<string, { x: number; y: number }> {
  const ids = graph.nodes.map(node => node.agent.id).sort(compareIds)
  const neighbors = new Map(ids.map(id => [id, [] as string[]]))
  for (const edge of graph.edges) {
    neighbors.get(edge.source)!.push(edge.target)
    neighbors.get(edge.target)!.push(edge.source)
  }
  const components: LayoutComponent[] = []
  const componentById = new Map<string, LayoutComponent>()
  for (const id of ids) {
    if (componentById.has(id)) continue
    const component: LayoutComponent = { ids: [id], edges: [], positions: new Map(), width: 0 }
    componentById.set(id, component)
    for (let index = 0; index < component.ids.length; index += 1) {
      for (const neighbor of neighbors.get(component.ids[index])!) {
        if (componentById.has(neighbor)) continue
        componentById.set(neighbor, component)
        component.ids.push(neighbor)
      }
    }
    component.ids.sort(compareIds)
    components.push(component)
  }
  for (const edge of graph.edges) componentById.get(edge.source)!.edges.push(edge)
  for (const component of components) {
    component.edges.sort((left, right) => compareIds(left.source, right.source) || compareIds(left.target, right.target))
    if (component.ids.length === 1 && component.edges.length === 0) {
      component.positions.set(component.ids[0], { x: 0, y: 0 })
      component.width = AGENT_NODE_WIDTH
      continue
    }
    const dagre = new Graph<GraphLabel, NodeLabel, EdgeLabel>()
    dagre.setGraph({ rankdir: 'TB', ranksep: 64, nodesep: 40, edgesep: 24, marginx: 0, marginy: 0 })
    dagre.setDefaultEdgeLabel(() => ({}))
    for (const id of component.ids) dagre.setNode(id, { width: AGENT_NODE_WIDTH, height: AGENT_NODE_HEIGHT })
    for (const edge of component.edges) dagre.setEdge(edge.source, edge.target)
    layout(dagre)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    for (const id of component.ids) {
      const node = dagre.node(id)
      if (typeof node.x !== 'number' || typeof node.y !== 'number' || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        throw new Error(`Agent 拓扑布局未返回有效坐标：${id}`)
      }
      const x = node.x - AGENT_NODE_WIDTH / 2
      const y = node.y - AGENT_NODE_HEIGHT / 2
      component.positions.set(id, { x, y })
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + AGENT_NODE_WIDTH)
    }
    for (const position of component.positions.values()) {
      position.x -= minX
      position.y -= minY
    }
    component.width = maxX - minX
  }

  // Place relationship components first, keeping every root on the same row.
  components.sort((left, right) => Number(right.edges.length > 0) - Number(left.edges.length > 0)
    || right.ids.length - left.ids.length || compareIds(left.ids[0], right.ids[0]))
  const gap = 48
  const positions = new Map<string, { x: number; y: number }>()
  let x = 0
  for (const component of components) {
    for (const [id, position] of component.positions) positions.set(id, { x: x + position.x, y: position.y })
    x += component.width + gap
  }
  return positions
}
