import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInfo } from '../../shared/types'
import { projectAgentTopology, type TopologyGraph } from './agent-topology'
import {
  buildOfficeLayout,
  getAgentFloorId,
  MAX_3D_EDGES,
  MAX_3D_NODES,
  type OfficeLayout,
} from './agent-topology-3d-layout'

function agent(id: string, cwd?: string, parentId?: string): AgentInfo {
  return { id, cwd, parentId, name: id, runtime: 'OMP', kind: parentId ? 'subagent' : 'main', state: 'unknown', pid: 10, source: 'test' }
}

function assertCompleteLayout(graph: TopologyGraph, layout: OfficeLayout): void {
  assert.deepEqual([...layout.positions.keys()].sort(), graph.nodes.map(node => node.agent.id).sort())
  assert.deepEqual(layout.floors.flatMap(floor => floor.nodeIds).sort(), [...layout.positions.keys()].sort())
  const occupied = new Set<string>()
  for (const floor of layout.floors) {
    assert.equal(floor.y, (floor.level - 1) * 240)
    assert.ok(floor.width >= 520)
    assert.ok(floor.depth >= 360)
    for (const id of floor.nodeIds) {
      const position = layout.positions.get(id)!
      assert.ok(Object.values(position).every(Number.isFinite), `${id} has finite coordinates`)
      assert.equal(position.y, floor.y + 40)
      assert.ok(Math.abs(position.x) < floor.width / 2)
      assert.ok(Math.abs(position.z) < floor.depth / 2)
      const key = JSON.stringify(position)
      assert.ok(!occupied.has(key), `${id} has a distinct position`)
      occupied.add(key)
    }
  }
  assert.ok(new Set(layout.floors.map(floor => floor.width)).size <= 1)
  assert.ok(new Set(layout.floors.map(floor => floor.depth)).size <= 1)
}

const noCollapse = new Set<string>()

test('same cwd keeps every employee on one floor with non-overlapping centered workstations', () => {
  const graph = projectAgentTopology([
    agent('d', '/work/project'), agent('b', '/work/project'),
    agent('a', '/work/project'), agent('c', '/work/project', 'a'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.floors.length, 1)
  assert.deepEqual(layout.floors[0].nodeIds, ['a', 'b', 'c', 'd'])
  const positions = [...layout.positions.values()]
  assert.equal(positions.reduce((sum, p) => sum + p.x, 0), 0)
  assert.equal(positions.reduce((sum, p) => sum + p.z, 0), 0)
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    assert.ok(Math.hypot(positions[i].x - positions[j].x, positions[i].z - positions[j].z) >= 100)
  }
  assertCompleteLayout(graph, layout)
})

test('full cwd separates equal basenames and nested paths without guessing project roots', () => {
  const graph = projectAgentTopology([
    agent('b', '/work/b/project'), agent('child', '/work/a/project/src', 'a'),
    agent('a', '/work/a/project'), agent('slash', '/work/a/project/'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.deepEqual(layout.floors.map(floor => floor.cwd), [
    '/work/a/project', '/work/a/project/', '/work/a/project/src', '/work/b/project',
  ])
  assert.equal(new Set(layout.floors.map(floor => floor.id)).size, 4)
  assert.deepEqual(layout.floors.map(floor => floor.level), [1, 2, 3, 4])
  assert.deepEqual(layout.floors.map(floor => floor.y), [0, 240, 480, 720])
  assertCompleteLayout(graph, layout)
})

test('missing and empty cwd share an explicit unknown floor after known projects', () => {
  const graph = projectAgentTopology([
    agent('missing', undefined, 'known'), agent('empty', ''), agent('blank', '  '),
    agent('known', '/z/project'), agent('named-unknown', 'unknown'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  const unknown = layout.floors.at(-1)!
  assert.equal(unknown.id, 'unknown')
  assert.equal(unknown.cwd, undefined)
  assert.deepEqual(unknown.nodeIds, ['blank', 'empty', 'missing'])
  assert.notEqual(getAgentFloorId(agent('known', 'unknown')), unknown.id)
  assert.equal(getAgentFloorId(agent('missing')), unknown.id)
  assertCompleteLayout(graph, layout)
})

test('floor ordering and positions survive shuffled nodes and edges without mutating inputs', () => {
  const graph = projectAgentTopology([
    agent('z', '/b'), agent('a', '/b', 'z'), agent('b', '/a', 'a'),
    agent('c', '/a'), agent('unknown'),
  ], 'all', 'all', '', noCollapse)
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  const shuffled = { ...graph, nodes: graph.nodes.slice().reverse(), edges: graph.edges.slice().reverse() }
  const reordered = buildOfficeLayout(shuffled)
  assert.deepEqual(reordered.floors, layout.floors)
  assert.deepEqual([...reordered.positions], [...layout.positions])
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('cross-floor parent edges, cycles and self loops remain unchanged and do not move floors', () => {
  const graph = projectAgentTopology([
    agent('a', '/a', 'c'), agent('b', '/b', 'a'), agent('c', '/c', 'b'),
    agent('leaf', '/a', 'b'), agent('self', '/b', 'self'), agent('orphan', undefined, 'absent'),
  ], 'all', 'all', '', noCollapse)
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  assert.equal(graph.edges.length, 5)
  assert.deepEqual(graph, original)
  assert.deepEqual(layout.floors.map(floor => floor.nodeIds), [['a', 'leaf'], ['b', 'self'], ['c'], ['orphan']])
  assert.deepEqual(buildOfficeLayout({ ...graph, edges: [] }), layout)
  assert.equal(layout.positions.has('absent'), false)
  assertCompleteLayout(graph, layout)
})

test('1200 agents fit one floor and all floors share dimensions from maximum occupancy', () => {
  const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
    agent(`node-${index}`, '/large', index === 0 ? undefined : `node-${index - 1}`)
  )), 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.positions.size, 1200)
  assert.equal(layout.floors.length, 1)
  assert.ok(new Set([...layout.positions.values()].map(point => point.x)).size > 1)
  assert.ok(new Set([...layout.positions.values()].map(point => point.z)).size > 1)
  assertCompleteLayout(graph, layout)

  const split = structuredClone(graph)
  split.nodes[0].agent.cwd = '/small'
  const splitLayout = buildOfficeLayout(split)
  assert.equal(splitLayout.floors.length, 2)
  assert.ok(splitLayout.floors[1].width > 520)
  assert.ok(splitLayout.floors[1].depth > 360)
  assertCompleteLayout(split, splitLayout)
})

test('2400 relationships are accepted without being rewritten or affecting office placement', () => {
  const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, i) => agent(`node-${i}`, `/work/${i % 2}`)), 'all', 'all', '', noCollapse)
  const beforeEdges = buildOfficeLayout(graph)
  graph.edges = Array.from({ length: MAX_3D_EDGES }, (_, i) => ({
    id: `edge-${i}`, source: `node-${Math.floor(i / 2)}`, target: `node-${(Math.floor(i / 2) + 1 + i % 2) % MAX_3D_NODES}`,
  }))
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  assert.equal(graph.edges.length, 2400)
  assert.deepEqual(layout, beforeEdges)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('both budgets are checked before reading node or edge entries', () => {
  const empty = projectAgentTopology([], 'all', 'all', '', noCollapse)
  for (const [field, limit] of [
    ['nodes', MAX_3D_NODES], ['edges', MAX_3D_EDGES],
  ] as const) {
    const unreadable = new Proxy([], {
      get(_target, property) {
        if (property === 'length') return 1
        throw new Error('entries were accessed before both budget checks')
      },
    })
    const oversized = new Proxy([], {
      get(_target, property) {
        if (property === 'length') return limit + 1
        throw new Error(`entries were accessed before ${field} budget check`)
      },
    })
    assert.throws(() => buildOfficeLayout({ ...empty, nodes: unreadable, edges: unreadable, [field]: oversized }), error => {
      assert.ok(error instanceof RangeError)
      return true
    })
  }
  assert.deepEqual(buildOfficeLayout(empty), { floors: [], positions: new Map() })
})

test('malformed graph shapes fail explicitly without inventing or dropping agents', () => {
  const graph = projectAgentTopology([agent('root', '/work')], 'all', 'all', '', noCollapse)
  assert.throws(() => buildOfficeLayout({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }), Error)
  assert.throws(() => buildOfficeLayout({
    ...graph, edges: [{ id: 'dangling', source: 'absent', target: 'root' }],
  }), Error)
  assert.throws(() => buildOfficeLayout({ ...graph, nodes: null } as unknown as TopologyGraph), TypeError)
  assert.throws(() => buildOfficeLayout({
    ...graph, nodes: [{ ...graph.nodes[0], agent: { ...graph.nodes[0].agent, id: '' } }],
  }), TypeError)
  assert.throws(() => getAgentFloorId({ ...agent('bad'), cwd: 42 } as unknown as AgentInfo), TypeError)
})
