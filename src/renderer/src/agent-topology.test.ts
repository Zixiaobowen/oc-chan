import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInfo } from '../../shared/types'
import {
  AGENT_NODE_HEIGHT,
  AGENT_NODE_WIDTH,
  layoutAgentTopology,
  projectAgentTopology,
} from './agent-topology'

function agent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name: id, runtime: 'OMP', kind: 'main', state: 'unknown', pid: 10, source: 'test', ...overrides }
}

const noCollapse = new Set<string>()

function assertNoOverlap(positions: Map<string, { x: number; y: number }>): void {
  const entries = [...positions]
  for (let left = 0; left < entries.length; left += 1) {
    const [leftId, a] = entries[left]
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `${leftId} has finite coordinates`)
    for (let right = left + 1; right < entries.length; right += 1) {
      const [rightId, b] = entries[right]
      assert.ok(
        a.x + AGENT_NODE_WIDTH <= b.x || b.x + AGENT_NODE_WIDTH <= a.x
          || a.y + AGENT_NODE_HEIGHT <= b.y || b.y + AGENT_NODE_HEIGHT <= a.y,
        `${leftId} overlaps ${rightId}`,
      )
    }
  }
}

test('only real parent IDs create multilevel edges regardless of equal or different PIDs', () => {
  const agents = [
    agent('main'),
    agent('child', { kind: 'subagent', parentId: 'main', pid: 10 }),
    agent('grandchild', { kind: 'subagent', parentId: 'child', pid: 20 }),
    agent('unrelated', { pid: 10 }),
  ]
  const graph = projectAgentTopology(agents, 'all', 'all', '', noCollapse)
  assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [
    ['main', 'child'], ['child', 'grandchild'],
  ])
  const main = graph.nodes.find(node => node.agent.id === 'main')!
  assert.equal(main.childCount, 1)
  assert.equal(main.descendantCount, 2)
  assert.equal(graph.nodes.find(node => node.agent.id === 'grandchild')!.descendantCount, 0)
  const changedPids = projectAgentTopology(agents.map(item => ({ ...item, pid: 999 })), 'all', 'all', '', noCollapse)
  assert.deepEqual(changedPids.edges, graph.edges)
  assert.equal(changedPids.layoutKey, graph.layoutKey)
})

test('leaf searches keep every ancestor without pulling in their unmatched siblings', () => {
  const graph = projectAgentTopology([
    agent('root'),
    agent('branch', { kind: 'subagent', parentId: 'root' }),
    agent('needle', { kind: 'subagent', parentId: 'branch' }),
    agent('sibling', { kind: 'subagent', parentId: 'branch' }),
    agent('other-branch', { kind: 'subagent', parentId: 'root' }),
  ], 'all', 'all', ' NEEDLE ', noCollapse)
  assert.deepEqual(graph.nodes.map(node => node.agent.id), ['branch', 'needle', 'root'])
  assert.deepEqual(graph.nodes.map(node => node.contextOnly), [true, false, true])
  assert.equal(graph.matchCount, 1)
  assert.equal(graph.contextCount, 2)
  assert.equal(graph.hiddenCount, 0)
  assert.equal(graph.nodes.find(node => node.agent.id === 'branch')!.childCount, 2)
  assert.equal(graph.nodes.find(node => node.agent.id === 'root')!.descendantCount, 4)
})

test('matching branches retain their descendants and ancestors with kind applied to original matches', () => {
  const graph = projectAgentTopology([
    agent('root', { name: 'Root' }),
    agent('branch', { kind: 'subagent', parentId: 'root', name: 'Builder' }),
    agent('grandchild', { kind: 'subagent', parentId: 'branch' }),
    agent('sibling', { kind: 'subagent', parentId: 'root' }),
    agent('other-main', { name: 'Builder' }),
  ], 'subagent', 'all', 'builder', noCollapse)
  assert.deepEqual(graph.nodes.map(node => node.agent.id), ['branch', 'grandchild', 'root'])
  assert.equal(graph.matchCount, 1)
  assert.equal(graph.contextCount, 2)
  assert.equal(graph.edges.length, 2)
})

test('work summaries and agent identifiers are searchable without case sensitivity', () => {
  const item = agent('opaque-id', { name: 'Compiler', summary: '修复 Rspack 构建', runtime: 'OpenCode', cwd: '/Work/Project', model: 'GPT-6', pid: 4321 })
  for (const query of ['修复 rspack', 'cOMpiler', 'OPENCODE', '/work/project', 'gpt-6', '4321']) {
    const graph = projectAgentTopology([item], 'main', 'all', query, noCollapse)
    assert.equal(graph.matchCount, 1, query)
    assert.equal(graph.nodes.length, 1, query)
  }
  const missing = projectAgentTopology([item], 'all', 'all', 'no matching agent', noCollapse)
  assert.deepEqual(missing.nodes, [])
  assert.deepEqual(missing.edges, [])
  assert.equal(missing.matchCount, 0)
  assert.equal(missing.contextCount, 0)
  assert.equal(missing.issueCount, 0)
  assert.equal(layoutAgentTopology(missing).size, 0)
})

test('missing parents and unknown subagent relations stay separate and report issues', () => {
  const graph = projectAgentTopology([
    agent('main'),
    agent('missing', { kind: 'subagent', parentId: 'absent', pid: 10 }),
    agent('unknown', { kind: 'subagent', pid: 10 }),
    agent('nested-main', { parentId: 'also-absent' }),
  ], 'all', 'all', '', noCollapse)
  assert.equal(graph.nodes.length, 4)
  assert.deepEqual(graph.edges, [])
  assert.equal(graph.issueCount, 3)
  assert.equal(graph.nodes.find(node => node.agent.id === 'main')!.issue, undefined)
  assert.ok(!graph.nodes.some(node => node.agent.id === 'absent'))
})

test('collapse hides every descendant while filters temporarily expand the original branch', () => {
  const agents = [
    agent('root'),
    agent('branch', { kind: 'subagent', parentId: 'root' }),
    agent('leaf', { kind: 'subagent', parentId: 'branch' }),
    agent('other'),
  ]
  const collapsedIds = new Set(['root', 'branch', 'gone'])
  const collapsed = projectAgentTopology(agents, 'all', 'all', ' ', collapsedIds)
  assert.deepEqual(collapsed.nodes.map(node => node.agent.id), ['other', 'root'])
  assert.equal(collapsed.hiddenCount, 2)
  assert.equal(collapsed.matchCount, 4)
  assert.equal(collapsed.nodes.find(node => node.agent.id === 'root')!.collapsed, true)
  assert.equal(collapsed.nodes.find(node => node.agent.id === 'root')!.descendantCount, 2)
  assert.deepEqual(collapsed.edges, [])

  const queried = projectAgentTopology(agents, 'all', 'all', 'leaf', collapsedIds)
  assert.deepEqual(queried.nodes.map(node => node.agent.id), ['branch', 'leaf', 'root'])
  assert.equal(queried.hiddenCount, 0)
  assert.ok(queried.nodes.every(node => !node.collapsed))
  const filtered = projectAgentTopology(agents, 'main', 'all', '', collapsedIds)
  assert.equal(filtered.nodes.length, 4)
  assert.equal(filtered.matchCount, 2)
  assert.equal(filtered.contextCount, 2)
  assert.equal(filtered.hiddenCount, 0)
  assert.ok(filtered.nodes.every(node => !node.collapsed))
  assert.equal(projectAgentTopology(agents, 'all', 'all', '', collapsedIds).layoutKey, collapsed.layoutKey)
})

test('state metrics display fields and input ordering do not alter structural keys or coordinates', () => {
  const agents = [
    agent('root'),
    agent('child-b', { kind: 'subagent', parentId: 'root' }),
    agent('child-a', { kind: 'subagent', parentId: 'root' }),
    agent('other'),
  ]
  const before = projectAgentTopology(agents, 'all', 'all', '', noCollapse)
  const changed = agents.slice().reverse().map(item => ({
    ...item, name: `Renamed ${item.name}`, state: 'working' as const, cpuPercent: 23,
    memoryBytes: 2048, model: 'new model', summary: 'Updated work summary', startedAt: '2026-11-02T00:00:00Z',
  }))
  const after = projectAgentTopology(changed, 'all', 'all', '', noCollapse)
  assert.equal(before.layoutKey, after.layoutKey)
  assert.deepEqual(layoutAgentTopology(before), layoutAgentTopology(after))
  const contextOnly = projectAgentTopology(agents, 'main', 'all', '', noCollapse)
  assert.equal(contextOnly.layoutKey, before.layoutKey)
  const reorderedGraph = { ...before, nodes: before.nodes.slice().reverse(), edges: before.edges.slice().reverse() }
  assert.deepEqual(layoutAgentTopology(reorderedGraph), layoutAgentTopology(before))
  const reparented = projectAgentTopology(agents.map(item => item.id === 'child-a' ? { ...item, parentId: 'other' } : item), 'all', 'all', '', noCollapse)
  assert.notEqual(reparented.layoutKey, before.layoutKey)
})

test('cycles retain real edges and visible warnings without counting the node itself as a descendant', () => {
  const agents = [
    agent('a', { kind: 'subagent', parentId: 'c' }),
    agent('b', { kind: 'subagent', parentId: 'a' }),
    agent('c', { kind: 'subagent', parentId: 'b' }),
    agent('leaf', { kind: 'subagent', parentId: 'b' }),
    agent('self', { kind: 'subagent', parentId: 'self' }),
  ]
  const graph = projectAgentTopology(agents, 'all', 'all', '', noCollapse)
  assert.equal(graph.edges.length, 5)
  assert.equal(graph.issueCount, 4)
  for (const id of ['a', 'b', 'c']) {
    const node = graph.nodes.find(item => item.agent.id === id)!
    assert.equal(node.descendantCount, 3)
  }
  assert.equal(graph.nodes.find(node => node.agent.id === 'self')!.descendantCount, 0)
  assert.equal(graph.nodes.find(node => node.agent.id === 'leaf')!.issue, undefined)
  const searched = projectAgentTopology(agents, 'all', 'all', 'leaf', noCollapse)
  assert.deepEqual(searched.nodes.map(node => node.agent.id), ['a', 'b', 'c', 'leaf'])
  assert.equal(searched.issueCount, 3)
  const collapsed = projectAgentTopology(agents, 'all', 'all', '', new Set(['a', 'b', 'c', 'self']))
  assert.deepEqual(collapsed.nodes.map(node => node.agent.id), ['a', 'self'])
  assert.equal(collapsed.hiddenCount, 3)
  assert.equal(collapsed.issueCount, 2)
  assertNoOverlap(layoutAgentTopology(graph))
})

test('independent roots share one horizontal row without overlaps', () => {
  const agents = Array.from({ length: 18 }, (_, index) => agent(`main-${String(index).padStart(2, '0')}`))
  const positions = layoutAgentTopology(projectAgentTopology(agents, 'all', 'all', '', noCollapse))
  assert.equal(positions.size, 18)
  for (const position of positions.values()) assert.equal(position.y, 0)
  assertNoOverlap(positions)
})

test('roots align across differently sized branches while every child stays below its parent', () => {
  const agents = [agent('root'), agent('independent-a'), agent('independent-b'), agent('small-root')]
  agents.push(agent('small-child', { kind: 'subagent', parentId: 'small-root' }))
  agents.push(agent('orphan', { kind: 'subagent', parentId: 'missing' }))
  for (let index = 0; index < 5; index += 1) {
    agents.push(agent(`child-${index}`, { kind: 'subagent', parentId: 'root' }))
  }
  agents.push(agent('grandchild', { kind: 'subagent', parentId: 'child-0' }))
  const graph = projectAgentTopology(agents, 'all', 'all', '', noCollapse)
  const positions = layoutAgentTopology(graph)
  for (const id of ['root', 'small-root', 'independent-a', 'independent-b', 'orphan']) {
    assert.equal(positions.get(id)!.y, 0)
  }
  for (const edge of graph.edges) {
    assert.ok(positions.get(edge.target)!.y > positions.get(edge.source)!.y + AGENT_NODE_HEIGHT)
  }
  assertNoOverlap(positions)
})

test('activity filters use work or recent calls and never classify unknown liveness as inactive', () => {
  const activity = { kind: 'tool' as const, name: 'read', observedAt: '2026-11-03T00:00:00Z' }
  const agents = [
    agent('working', { state: 'working' }),
    agent('idle', { state: 'idle' }),
    agent('idle-with-call', { state: 'idle', activity }),
    agent('running', { state: 'running', cpuPercent: 90 }),
    agent('running-with-call', { state: 'running', activity }),
    agent('unknown'),
    agent('unknown-with-call', { activity }),
  ]
  const active = projectAgentTopology(agents, 'all', 'active', '', noCollapse)
  assert.deepEqual(active.nodes.map(node => node.agent.id), ['idle-with-call', 'running-with-call', 'unknown-with-call', 'working'])
  const inactive = projectAgentTopology(agents, 'all', 'inactive', '', noCollapse)
  assert.deepEqual(inactive.nodes.map(node => node.agent.id), ['idle'])
  assert.equal(projectAgentTopology(agents, 'all', 'all', '', noCollapse).matchCount, 7)
})

test('active main agents retain idle and unknown descendants as inspectable context', () => {
  const agents = [
    agent('active-main', { state: 'working' }),
    agent('idle-child', { kind: 'subagent', parentId: 'active-main', state: 'idle' }),
    agent('unknown-child', { kind: 'subagent', parentId: 'active-main' }),
    agent('unknown-grandchild', { kind: 'subagent', parentId: 'unknown-child' }),
    agent('unrelated-main', { state: 'idle' }),
    agent('unrelated-child', { kind: 'subagent', parentId: 'unrelated-main' }),
  ]
  for (const kind of ['all', 'main'] as const) {
    const graph = projectAgentTopology(agents, kind, 'active', '', new Set(['active-main']))
    assert.deepEqual(graph.nodes.map(node => [node.agent.id, node.contextOnly, node.agent.state]), [
      ['active-main', false, 'working'],
      ['idle-child', true, 'idle'],
      ['unknown-child', true, 'unknown'],
      ['unknown-grandchild', true, 'unknown'],
    ])
    assert.equal(graph.matchCount, 1)
    assert.equal(graph.contextCount, 3)
    assert.equal(graph.hiddenCount, 0)
    assert.ok(graph.nodes.every(node => !node.collapsed))
    assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [
      ['active-main', 'idle-child'], ['active-main', 'unknown-child'], ['unknown-child', 'unknown-grandchild'],
    ])
    assertNoOverlap(layoutAgentTopology(graph))
  }
})

test('activity combines with role and search while retaining matched subtrees without unrelated siblings', () => {
  const agents = [
    agent('root', { state: 'idle' }),
    agent('branch', { kind: 'subagent', parentId: 'root' }),
    agent('builder', { kind: 'subagent', parentId: 'branch', state: 'working', summary: 'Build assets' }),
    agent('idle-child', { kind: 'subagent', parentId: 'builder', state: 'idle' }),
    agent('busy-sibling', { kind: 'subagent', parentId: 'root', state: 'working' }),
    agent('other-main', { state: 'working', summary: 'Build assets' }),
  ]
  const active = projectAgentTopology(agents, 'subagent', 'active', ' BUILD ', new Set(['root', 'branch']))
  assert.deepEqual(active.nodes.map(node => [node.agent.id, node.contextOnly]), [['branch', true], ['builder', false], ['idle-child', true], ['root', true]])
  assert.equal(active.matchCount, 1)
  assert.equal(active.contextCount, 3)
  assert.equal(active.hiddenCount, 0)
  assert.ok(active.nodes.every(node => !node.collapsed))
  assert.deepEqual(active.edges.map(edge => [edge.source, edge.target]), [['root', 'branch'], ['branch', 'builder'], ['builder', 'idle-child']])
  const inactive = projectAgentTopology(agents, 'all', 'inactive', '', noCollapse)
  assert.deepEqual(inactive.nodes.filter(node => !node.contextOnly).map(node => node.agent.id), ['idle-child', 'root'])
  assert.ok(!inactive.nodes.some(node => ['busy-sibling', 'other-main'].includes(node.agent.id)))
  const mainOnly = projectAgentTopology(agents, 'main', 'active', 'build', noCollapse)
  assert.deepEqual(mainOnly.nodes.map(node => node.agent.id), ['other-main'])
})

test('activity changes update matches and clearing the filter restores collapsed branches', () => {
  const collapsed = new Set(['root'])
  const root = agent('root', { state: 'idle' })
  const child = agent('child', { kind: 'subagent', parentId: 'root', state: 'idle' })
  const withCall = { ...child, activity: { kind: 'model' as const, observedAt: '2026-11-03T00:00:00Z' } }
  const recent = projectAgentTopology([root, withCall], 'all', 'active', '', collapsed)
  assert.deepEqual(recent.nodes.map(node => node.agent.id), ['child', 'root'])
  assert.equal(recent.matchCount, 1)
  const expired = projectAgentTopology([root, child], 'all', 'active', '', collapsed)
  assert.equal(expired.matchCount, 0)
  assert.deepEqual(expired.nodes, [])
  assert.notEqual(expired.layoutKey, recent.layoutKey)
  assert.equal(projectAgentTopology([root, { ...child, state: 'working' }], 'all', 'active', '', collapsed).matchCount, 1)
  const restored = projectAgentTopology([root, child], 'all', 'all', '', collapsed)
  assert.deepEqual(restored.nodes.map(node => node.agent.id), ['root'])
  assert.equal(restored.nodes[0].collapsed, true)
  assert.equal(restored.hiddenCount, 1)
})

test('project branches stay adjacent despite interleaved IDs and different branch sizes', () => {
  const graph = projectAgentTopology([
    agent('a-unknown'),
    agent('b-nebula', { cwd: '/Projects/Nebula' }),
    agent('c-atlas', { cwd: '/Projects/Atlas/' }),
    agent('d-nebula-child', { cwd: '/Projects/Nebula', parentId: 'b-nebula', kind: 'subagent' }),
    agent('e-nebula-child', { cwd: '/Projects/Nebula', parentId: 'b-nebula', kind: 'subagent' }),
    agent('z-atlas', { cwd: '/Projects/Atlas' }),
    agent('a-atlas-child', { cwd: '/Projects/Elsewhere', parentId: 'z-atlas', kind: 'subagent' }),
  ], 'all', 'all', '', noCollapse)
  const positions = layoutAgentTopology(graph)
  const roots = ['c-atlas', 'z-atlas', 'b-nebula', 'a-unknown']
  assert.deepEqual([...roots].sort((a, b) => positions.get(a)!.x - positions.get(b)!.x), roots)
  const atlasRight = Math.max(...['c-atlas', 'z-atlas', 'a-atlas-child'].map(id => positions.get(id)!.x + AGENT_NODE_WIDTH))
  const nebulaLeft = Math.min(...['b-nebula', 'd-nebula-child', 'e-nebula-child'].map(id => positions.get(id)!.x))
  const withinProjectGap = positions.get('z-atlas')!.x - positions.get('c-atlas')!.x - AGENT_NODE_WIDTH
  assert.ok(nebulaLeft - atlasRight > withinProjectGap, 'Project groups have more separation than sibling branches')
  for (const edge of graph.edges) assert.ok(positions.get(edge.target)!.y > positions.get(edge.source)!.y + AGENT_NODE_HEIGHT)
  assertNoOverlap(positions)
  const reordered = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }
  assert.deepEqual(layoutAgentTopology(reordered), positions)
})

test('project changes invalidate layout while normalized directory aliases keep the same order', () => {
  const agents = [agent('first', { cwd: '/Projects/Beta' }), agent('second', { cwd: '/Projects/Alpha' }), agent('root-directory', { cwd: '/' })]
  const before = projectAgentTopology(agents, 'all', 'all', '', noCollapse)
  const normalized = projectAgentTopology(agents.map(item => item.id === 'first' ? { ...item, cwd: '/Projects/Beta///' } : item), 'all', 'all', '', noCollapse)
  assert.equal(normalized.layoutKey, before.layoutKey)
  assert.deepEqual(layoutAgentTopology(normalized), layoutAgentTopology(before))
  const moved = projectAgentTopology(agents.map(item => item.id === 'first' ? { ...item, cwd: '/Projects/Aardvark' } : item), 'all', 'all', '', noCollapse)
  assert.notEqual(moved.layoutKey, before.layoutKey)
  const beforePositions = layoutAgentTopology(before)
  assert.ok(beforePositions.get('root-directory')!.x < beforePositions.get('second')!.x)
  assert.ok(beforePositions.get('second')!.x < beforePositions.get('first')!.x)
  const positions = layoutAgentTopology(moved)
  assert.ok(positions.get('root-directory')!.x < positions.get('first')!.x)
  assert.ok(positions.get('first')!.x < positions.get('second')!.x)
})
