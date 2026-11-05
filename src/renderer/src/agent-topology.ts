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

export function agentProjectDirectory(cwd: string | undefined): string {
  return cwd ? cwd.replace(/\/+$/, '') || '/' : ''
}

interface TopologyBranch {
  ids: string[]
  edges: TopologyGraph['edges']
  rootId: string
  project: string
}

/** Keep real relationship branches intact; group their roots by project. */
export function orderedTopologyBranches(graph: TopologyGraph): TopologyBranch[] {
  const agents = new Map(graph.nodes.map(node => [node.agent.id, node.agent]))
  const ids = [...agents.keys()].sort(compareIds)
  const neighbors = new Map(ids.map(id => [id, [] as string[]]))
  const parented = new Set<string>()
  for (const edge of graph.edges) {
    neighbors.get(edge.source)!.push(edge.target)
    neighbors.get(edge.target)!.push(edge.source)
    parented.add(edge.target)
  }
  const branches: TopologyBranch[] = []
  const branchById = new Map<string, TopologyBranch>()
  for (const id of ids) {
    if (branchById.has(id)) continue
    const branch: TopologyBranch = { ids: [id], edges: [], rootId: id, project: '' }
    branchById.set(id, branch)
    for (let index = 0; index < branch.ids.length; index++) {
      for (const neighbor of neighbors.get(branch.ids[index])!) {
        if (branchById.has(neighbor)) continue
        branchById.set(neighbor, branch)
        branch.ids.push(neighbor)
      }
    }
    branch.ids.sort(compareIds)
    branch.rootId = branch.ids.find(member => !parented.has(member)) ?? branch.ids[0]
    branch.project = agentProjectDirectory(agents.get(branch.rootId)!.cwd)
    branches.push(branch)
  }
  for (const edge of graph.edges) branchById.get(edge.source)!.edges.push(edge)
  for (const branch of branches) branch.edges.sort((left, right) => compareIds(left.source, right.source) || compareIds(left.target, right.target))
  return branches.sort((left, right) => Number(!left.project) - Number(!right.project)
    || compareIds(left.project, right.project) || compareIds(left.rootId, right.rootId))
}

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
  // Active matches keep their descendants as context without changing match counts.
  if (activity !== 'inactive') {
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
    layoutKey: JSON.stringify([nodes.map(node => [node.agent.id, agentProjectDirectory(node.agent.cwd)]), edges.map(edge => [edge.source, edge.target])]),
  }
}

export function layoutAgentTopology(graph: TopologyGraph): Map<string, { x: number; y: number }> {
  const branches = orderedTopologyBranches(graph)
  const positions = new Map<string, { x: number; y: number }>()
  let xOffset = 0
  for (let index = 0; index < branches.length; index++) {
    const component = branches[index]
    if (index > 0) xOffset += component.project === branches[index - 1].project ? 48 : 112
    if (component.ids.length === 1 && component.edges.length === 0) {
      positions.set(component.ids[0], { x: xOffset, y: 0 })
      xOffset += AGENT_NODE_WIDTH
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
      positions.set(id, { x, y })
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + AGENT_NODE_WIDTH)
    }
    for (const id of component.ids) {
      const position = positions.get(id)!
      position.x += xOffset - minX
      position.y -= minY
    }
    xOffset += maxX - minX
  }

  return positions
}
