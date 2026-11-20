import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInfo } from '../../shared/types'
import { projectAgentTopology, type TopologyGraph } from './agent-topology'
import {
  buildGalaxyLayout,
  buildSnapshotGalaxyLayout,
  pickAgentOnRay,
  planGalaxyPlacement,
  projectGalaxyLayout,
  restoreTaskPositions,
  saveManualGalaxyPosition,
  placeGalaxies,
  MAX_3D_EDGES,
  MAX_3D_NODES,
  type GalaxyLayout,
} from './agent-topology-3d-layout'

function agent(id: string, cwd?: string, parentId?: string): AgentInfo {
  return { id, cwd, parentId, name: id, runtime: 'OMP', kind: parentId ? 'subagent' : 'main', state: 'unknown', pid: 10, source: 'test' }
}

function assertSeparated(items: { x: number; z: number; radius: number }[]): void {
  for (const [index, item] of items.entries()) {
    for (let next = index + 1; next < items.length; next++) {
      const other = items[next]
      assert.ok(Math.hypot(item.x - other.x, item.z - other.z) > item.radius + other.radius)
    }
  }
}

function assertCompleteLayout(graph: TopologyGraph, layout: GalaxyLayout): void {
  const ids = graph.nodes.map(node => node.agent.id).sort()
  assert.deepEqual([...layout.positions.keys()].sort(), ids)
  assert.deepEqual([...layout.taskByAgent.keys()].sort(), ids)
  assert.deepEqual(layout.tasks.flatMap(task => task.nodeIds).sort(), ids)
  assert.deepEqual(layout.galaxies.flatMap(galaxy => galaxy.tasks), layout.tasks)
  const occupied = new Set<string>()
  for (const galaxy of layout.galaxies) {
    assert.ok([galaxy.x, galaxy.z, galaxy.radius].every(Number.isFinite))
    assert.ok(galaxy.radius > 0)
    for (const [index, task] of galaxy.tasks.entries()) {
      assert.equal(task.galaxyId, galaxy.id)
      assert.equal(task.cwd, galaxy.cwd)
      assert.equal(task.index, index)
      assert.ok([task.x, task.z, task.radius].every(Number.isFinite))
      assert.ok(task.radius > 0)
      assert.ok(Math.hypot(task.x, task.z) + task.radius <= galaxy.radius)
      assert.equal(task.unresolved, task.mainAgentId === null)
      if (task.mainAgentId !== null) assert.ok(task.nodeIds.includes(task.mainAgentId))
      for (const id of task.nodeIds) {
        assert.equal(layout.taskByAgent.get(id), task.id)
        const position = layout.positions.get(id)!
        assert.ok(Object.values(position).every(Number.isFinite), `${id} has finite coordinates`)
        assert.equal(position.y, 0)
        assert.ok(Math.hypot(position.x, position.z) < task.radius)
        if (id === task.mainAgentId) {
          assert.deepEqual(position, { x: 0, y: 0, z: 0 })
        } else {
          assert.ok(Math.hypot(position.x, position.z) > 100, `${id} sits clear of the star center`)
        }
        const key = JSON.stringify([galaxy.x + task.x + position.x, position.y, galaxy.z + task.z + position.z])
        assert.ok(!occupied.has(key), `${id} has a distinct world position`)
        occupied.add(key)
      }
    }
    assertSeparated(galaxy.tasks)
  }
  assertSeparated(layout.galaxies)
}

const noCollapse = new Set<string>()

test('real task branches share their root project with cross-cwd descendants', () => {
  const graph = projectAgentTopology([
    { ...agent('task-a', '/work/project/'), summary: 'Implement search' },
    agent('task-b', '/work/project'), agent('task-c', '/work/project'),
    agent('child', '/another/project', 'task-a'), agent('grandchild', undefined, 'child'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildGalaxyLayout(graph)
  assert.deepEqual(layout.galaxies.map(galaxy => galaxy.id), ['cwd:/work/project'])
  assert.equal(layout.galaxies[0].cwd, '/work/project')
  assert.deepEqual(layout.tasks.map(task => task.id), ['task:task-a', 'task:task-b', 'task:task-c'])
  assert.deepEqual(layout.tasks.map(task => task.mainAgentId), ['task-a', 'task-b', 'task-c'])
  assert.equal(layout.tasks[0].name, 'Implement search')
  assert.equal(layout.tasks[1].name, 'task-b')
  assert.deepEqual(layout.tasks[0].nodeIds, ['child', 'grandchild', 'task-a'])
  assertCompleteLayout(graph, layout)
})

test('full cwd values identify galaxies even when basenames match', () => {
  const graph = projectAgentTopology([
    agent('b', '/work/b/project'), agent('nested', '/work/a/project/src'),
    agent('a', '/work/a/project'), agent('slash', '/work/a/project///'), agent('root', '/'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildGalaxyLayout(graph)
  assert.deepEqual(layout.galaxies.map(galaxy => galaxy.cwd), [
    '/', '/work/a/project', '/work/a/project/src', '/work/b/project',
  ])
  assert.deepEqual(layout.galaxies.map(galaxy => galaxy.name), ['/', 'project', 'src', 'project'])
  assert.equal(new Set(layout.galaxies.map(galaxy => galaxy.id)).size, 4)
  assert.deepEqual(layout.galaxies[1].tasks.map(task => task.id), ['task:a', 'task:slash'])
  assertCompleteLayout(graph, layout)
})

test('confirmed roots without cwd share an unknown project and retain their stars', () => {
  const graph = projectAgentTopology([
    agent('missing'), agent('empty', ''), agent('blank', '  '),
    agent('known', '/z/project'), agent('child', undefined, 'known'), agent('named-unknown', 'unknown'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildGalaxyLayout(graph)
  const unknown = layout.galaxies.at(-1)!
  assert.equal(unknown.id, 'unknown')
  assert.equal(unknown.cwd, undefined)
  assert.deepEqual(unknown.tasks.map(task => task.mainAgentId), ['blank', 'empty', 'missing'])
  assert.equal(layout.taskByAgent.get('child'), 'task:known')
  assert.equal(layout.tasks.find(task => task.id === 'task:named-unknown')!.galaxyId, 'cwd:unknown')
  assertCompleteLayout(graph, layout)
})

test('planet orbits keep adjacent agents apart across multiple rings', () => {
  const graph = projectAgentTopology([
    agent('main', '/work'), agent('independent', '/work'),
    ...Array.from({ length: 80 }, (_, index) => agent(`worker-${index}`, '/elsewhere', 'main')),
  ], 'all', 'all', '', noCollapse)
  const layout = buildGalaxyLayout(graph)
  const main = layout.tasks.find(task => task.id === 'task:main')!
  const independent = layout.tasks.find(task => task.id === 'task:independent')!
  assert.ok(main.radius > independent.radius)
  const points = main.nodeIds.map(id => layout.positions.get(id)!)
  assert.ok(points.some(point => point.x > 0) && points.some(point => point.x < 0))
  assert.ok(points.some(point => point.z > 0) && points.some(point => point.z < 0))
  for (const [index, point] of points.entries()) {
    for (let next = index + 1; next < points.length; next++) {
      const other = points[next]
      assert.ok(Math.hypot(point.x - other.x, point.z - other.z) > 100)
    }
  }
  assertCompleteLayout(graph, layout)
})

test('ordering and placement survive shuffled graph entries without mutating inputs', () => {
  const graph = projectAgentTopology([
    agent('z', '/b'), agent('a', '/b', 'z'), agent('b', '/a', 'a'),
    agent('c', '/a'), agent('unknown'), agent('other', '/b/'),
  ], 'all', 'all', '', noCollapse)
  const original = structuredClone(graph)
  const layout = buildGalaxyLayout(graph)
  const shuffled = { ...graph, nodes: graph.nodes.slice().reverse(), edges: graph.edges.slice().reverse() }
  const reordered = buildGalaxyLayout(shuffled)
  assert.deepEqual(reordered, layout)
  assert.deepEqual([...reordered.positions], [...layout.positions])
  assert.deepEqual([...reordered.taskByAgent], [...layout.taskByAgent])
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('existing project slots stay fixed across additions and reordering at the same pitch', () => {
  const agents = [agent('b', '/b'), agent('c', '/c'), agent('second', '/b')]
  const before = buildGalaxyLayout(projectAgentTopology(agents, 'all', 'all', '', noCollapse))
  const slots = new Map(before.galaxies.map((galaxy, index) => [galaxy.id, index]))
  const graph = projectAgentTopology([agent('a', '/a'), ...agents], 'all', 'all', '', noCollapse)
  const after = buildGalaxyLayout(graph)
  const taskPositions = after.tasks.map(task => [task.x, task.z])
  for (const galaxies of [after.galaxies, after.galaxies.slice().reverse()]) {
    placeGalaxies(galaxies, slots)
    for (const galaxy of before.galaxies) {
      const retained = galaxies.find(item => item.id === galaxy.id)!
      assert.deepEqual([retained.x, retained.z], [galaxy.x, galaxy.z])
    }
    assert.deepEqual(after.tasks.map(task => [task.x, task.z]), taskPositions)
    assertSeparated(galaxies)
  }
  assertCompleteLayout(graph, after)
})

test('project and task centers follow the same square spiral', () => {
  const roots = Array.from({ length: 10 }, (_, index) => `root-${index}`)
  const projectGraph = projectAgentTopology(roots.map(id => agent(id, `/${id}`)), 'all', 'all', '', noCollapse)
  const taskGraph = projectAgentTopology(roots.map(id => agent(id, '/one-project')), 'all', 'all', '', noCollapse)
  const firstRing = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [2, -1]]
  for (const items of [buildGalaxyLayout(projectGraph).galaxies, buildGalaxyLayout(taskGraph).tasks]) {
    const pitch = items[1].x
    assert.ok(pitch > 0)
    assert.deepEqual(items.map(item => [item.x / pitch, item.z / pitch]), firstRing)
  }
})

test('cycles, missing parents and unparented subagents stay in the unresolved galaxy', () => {
  const graph = projectAgentTopology([
    { ...agent('a', '/a', 'c'), kind: 'main' }, agent('b', '/b', 'a'), agent('c', '/c', 'b'),
    agent('leaf', '/leaf', 'b'), { ...agent('self', '/self', 'self'), kind: 'main' },
    { ...agent('orphan', '/orphan', 'absent'), kind: 'main' }, agent('orphan-child', '/child', 'orphan'),
    { ...agent('unparented', '/work'), kind: 'subagent' }, agent('confirmed'),
  ], 'all', 'all', '', noCollapse)
  const original = structuredClone(graph)
  const layout = buildGalaxyLayout(graph)
  assert.deepEqual(layout.galaxies.map(galaxy => galaxy.id), ['unknown', 'unresolved'])
  assert.equal(layout.galaxies[0].tasks[0].mainAgentId, 'confirmed')
  const unresolved = layout.galaxies[1]
  assert.equal(unresolved.cwd, undefined)
  assert.deepEqual(unresolved.tasks.map(task => task.id), ['task:a', 'task:orphan', 'task:self', 'task:unparented'])
  assert.deepEqual(unresolved.tasks[0].nodeIds, ['a', 'b', 'c', 'leaf'])
  assert.deepEqual(unresolved.tasks[1].nodeIds, ['orphan', 'orphan-child'])
  assert.ok(unresolved.tasks.every(task => task.mainAgentId === null && task.unresolved))
  assert.equal(layout.positions.has('absent'), false)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('a cycle downstream of a main root leaves the whole branch unresolved', () => {
  const graph = projectAgentTopology([
    agent('main', '/work'), agent('a', '/work', 'main'), agent('b', '/work', 'a'),
  ], 'all', 'all', '', noCollapse)
  graph.edges.push({ id: 'back', source: 'b', target: 'a' })
  const original = structuredClone(graph)
  const layout = buildGalaxyLayout(graph)
  assert.equal(layout.tasks[0].id, 'task:main')
  assert.equal(layout.tasks[0].galaxyId, 'unresolved')
  assert.equal(layout.tasks[0].mainAgentId, null)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('an unrepresented parent edge never creates a branch association', () => {
  const graph = projectAgentTopology([
    agent('root', '/real'), { ...agent('child', '/different', 'root'), kind: 'main' },
  ], 'all', 'all', '', noCollapse)
  graph.edges = []
  const layout = buildGalaxyLayout(graph)
  assert.deepEqual(layout.galaxies.map(galaxy => galaxy.id), ['cwd:/real', 'unresolved'])
  assert.deepEqual(layout.tasks.map(task => task.nodeIds), [['root'], ['child']])
  assert.deepEqual(layout.tasks.map(task => task.mainAgentId), ['root', null])
  assertCompleteLayout(graph, layout)
})

test('conflicting roots in one real branch do not designate a star', () => {
  const graph = projectAgentTopology([
    agent('main-a', '/a'), agent('main-b', '/b'), agent('child', '/a', 'main-a'),
  ], 'all', 'all', '', noCollapse)
  graph.edges.push({ id: 'second-parent', source: 'main-b', target: 'child' })
  const layout = buildGalaxyLayout(graph)
  assert.equal(layout.galaxies[0].id, 'unresolved')
  assert.equal(layout.tasks.length, 1)
  assert.equal(layout.tasks[0].mainAgentId, null)
  assert.deepEqual(layout.tasks[0].nodeIds, ['child', 'main-a', 'main-b'])
  assertCompleteLayout(graph, layout)
})

test('1200-agent wide and deep branches fit one task without recursive traversal', () => {
  for (const shape of ['wide', 'deep']) {
    const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
      agent(`node-${index}`, index === 0 ? '/root' : `/child/${index}`,
        index === 0 ? undefined : shape === 'deep' ? `node-${index - 1}` : 'node-0')
    )), 'all', 'all', '', noCollapse)
    const layout = buildGalaxyLayout(graph)
    assert.equal(layout.positions.size, 1200)
    assert.equal(layout.galaxies.length, 1)
    assert.equal(layout.tasks.length, 1)
    assert.equal(layout.tasks[0].mainAgentId, 'node-0')
    assert.equal(layout.tasks[0].cwd, '/root')
    assertCompleteLayout(graph, layout)
  }
})

test('1200 tasks remain separated across the project and task spirals', () => {
  const ids = Array.from({ length: MAX_3D_NODES }, (_, index) => `main-${index}`)
  for (const projectPerTask of [true, false]) {
    const graph = projectAgentTopology(ids.map(id => agent(id, projectPerTask ? `/project/${id}` : '/project')), 'all', 'all', '', noCollapse)
    const layout = buildGalaxyLayout(graph)
    assert.equal(layout.galaxies.length, projectPerTask ? 1200 : 1)
    assert.equal(layout.tasks.length, 1200)
    assertCompleteLayout(graph, layout)
  }
})

test('2400 relationships are accepted and duplicate edge evidence keeps the same geometry', () => {
  const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
    agent(`node-${index}`, '/work', index === 0 ? undefined : 'node-0')
  )), 'all', 'all', '', noCollapse)
  const beforeEdges = buildGalaxyLayout(graph)
  graph.edges = Array.from({ length: MAX_3D_EDGES }, (_, index) => ({
    id: `edge-${index}`, source: 'node-0', target: `node-${1 + index % (MAX_3D_NODES - 1)}`,
  }))
  const original = structuredClone(graph)
  const layout = buildGalaxyLayout(graph)
  assert.equal(graph.edges.length, 2400)
  assert.deepEqual(layout, beforeEdges)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('filtering and collapsing preserve task and galaxy identity for visible agents', () => {
  const agents = [
    agent('main', '/project'), agent('child', '/different', 'main'), agent('grandchild', undefined, 'child'),
    agent('second', '/project'), agent('other-project', '/other'),
  ]
  const full = buildGalaxyLayout(projectAgentTopology(agents, 'all', 'all', '', noCollapse))
  const projections = [
    projectAgentTopology(agents, 'subagent', 'all', '', noCollapse),
    projectAgentTopology(agents, 'all', 'all', 'grandchild', noCollapse),
    projectAgentTopology(agents, 'all', 'all', '', new Set(['child'])),
    projectAgentTopology(agents, 'all', 'all', '', new Set(['main'])),
  ]
  assert.deepEqual(projections[1].nodes.map(node => node.agent.id), ['child', 'grandchild', 'main'])
  assert.equal(projections[2].nodes.some(node => node.agent.id === 'grandchild'), false)
  assert.equal(projections[3].nodes.some(node => node.agent.id === 'child'), false)
  for (const graph of projections) {
    const layout = buildGalaxyLayout(graph)
    for (const node of graph.nodes) {
      const id = layout.taskByAgent.get(node.agent.id)!
      assert.equal(id, full.taskByAgent.get(node.agent.id))
      const task = layout.tasks.find(candidate => candidate.id === id)!
      const original = full.tasks.find(candidate => candidate.id === id)!
      assert.equal(task.galaxyId, original.galaxyId)
      assert.equal(task.mainAgentId, original.mainAgentId)
    }
    assertCompleteLayout(graph, layout)
  }
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
    assert.throws(() => buildGalaxyLayout({ ...empty, nodes: unreadable, edges: unreadable, [field]: oversized }), RangeError)
  }
  assert.deepEqual(buildGalaxyLayout(empty), { galaxies: [], tasks: [], positions: new Map(), taskByAgent: new Map() })
})

test('malformed graph shapes and entries fail explicitly', () => {
  const graph = projectAgentTopology([agent('root', '/work')], 'all', 'all', '', noCollapse)
  assert.throws(() => buildGalaxyLayout({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }), /重复节点/)
  assert.throws(() => buildGalaxyLayout({
    ...graph, edges: [{ id: 'dangling', source: 'absent', target: 'root' }],
  }), /关系端点不存在/)
  for (const invalid of [null, {}, { ...graph, nodes: null }, { ...graph, edges: null }, { ...graph, nodes: [null] }, { ...graph, edges: [null] }]) {
    assert.throws(() => buildGalaxyLayout(invalid as unknown as TopologyGraph), TypeError)
  }
  for (const fields of [{ id: '' }, { id: '  ' }, { cwd: 42 }, { parentId: 42 }]) {
    assert.throws(() => buildGalaxyLayout({
      ...graph, nodes: [{ ...graph.nodes[0], agent: { ...graph.nodes[0].agent, ...fields } as AgentInfo }],
    }), TypeError)
  }
  assert.throws(() => buildGalaxyLayout({
    ...graph, edges: [{ id: 'invalid', source: 42, target: 'root' } as unknown as TopologyGraph['edges'][number]],
  }), TypeError)
})

test('shrinking a filtered orbit keeps a live manual position and restores it on clearing the filter', () => {
  const agents = [agent('root', '/project'), ...Array.from({ length: 7 }, (_, i) => agent(`worker-${i}`, undefined, 'root'))]
  const full = buildSnapshotGalaxyLayout(agents)!
  const graph = projectAgentTopology(agents, 'all', 'all', 'worker-0', noCollapse)
  const filtered = buildGalaxyLayout(graph)
  const point = { x: 250, y: 0, z: 0 }
  const manual = new Map([['worker-0', point]])
  const membership = new Map([['worker-0', 'task:root']])
  assert.ok(filtered.tasks[0].radius < point.x)
  restoreTaskPositions(filtered.tasks[0], filtered.positions, manual, membership)
  assert.notDeepEqual(filtered.positions.get('worker-0'), point)
  assert.equal(manual.get('worker-0'), point)
  const projection = projectGalaxyLayout(full, graph)
  assert.equal(projection.tasks[0].radius, full.tasks[0].radius)
  for (const layout of [projection, full]) {
    restoreTaskPositions(layout.tasks[0], layout.positions, manual, membership)
    assert.equal(layout.positions.get('worker-0'), point)
  }
})

test('restoration reserves all dragged positions before assigning defaults to other planets', () => {
  const layout = buildSnapshotGalaxyLayout([agent('root', '/p'), ...['a', 'b', 'c'].map(id => agent(id, '/p', 'root'))])!
  const defaults = layout.positions
  const task = layout.tasks[0]
  // B vacates its original seat, then A occupies that seat. An automatic C can also be displaced.
  const manual = new Map([['b', defaults.get('c')!], ['a', defaults.get('b')!]])
  for (const nodeIds of [task.nodeIds, task.nodeIds.slice().reverse()]) {
    const positions = new Map(defaults)
    restoreTaskPositions({ ...task, nodeIds }, positions, manual, layout.taskByAgent)
    assert.deepEqual(positions.get('a'), defaults.get('b'))
    assert.deepEqual(positions.get('b'), defaults.get('c'))
    assert.deepEqual(positions.get('c'), defaults.get('a'))
    assert.equal(manual.size, 2)
  }
})

test('opening with a filter reserves the complete project disks and local orbit positions before clearing it', () => {
  const agents = [agent('shown-a', '/a'), agent('hidden-a', '/a'), agent('shown-b', '/b'), agent('hidden-c', '/c')]
  const full = buildSnapshotGalaxyLayout(agents)!
  const filter = projectAgentTopology(agents, 'all', 'all', 'shown', noCollapse)
  const first = projectGalaxyLayout(full, filter)
  assert.equal(first.galaxies.length, 2)
  assert.ok(first.galaxies[0].radius > buildGalaxyLayout(filter).galaxies[0].radius)
  assert.deepEqual([first.tasks[0].x, first.tasks[0].z], [full.tasks[1].x, full.tasks[1].z])
  const before = planGalaxyPlacement(first.galaxies, full.galaxies, new Map())
  assert.ok('placements' in before)
  const after = planGalaxyPlacement(full.galaxies, full.galaxies, before.placements)
  assert.ok('placements' in after)
  for (const galaxy of full.galaxies) assert.deepEqual(after.placements.get(galaxy.id), before.placements.get(galaxy.id))
  assertSeparated([...after.placements.values()])
})

test('oversized snapshots use only the visible projection and preserve existing manual positions at capacity', () => {
  const oversized = new Proxy([] as AgentInfo[], { get(_target, key) {
    if (key === 'length') return MAX_3D_NODES + 1
    throw new Error('oversized snapshot inspected before checking budget')
  } })
  assert.equal(buildSnapshotGalaxyLayout(oversized), null)
  const source = Array.from({ length: MAX_3D_NODES + 1 }, (_, i) => agent(`main-${i}`, `/p/${i}`))
  const manual = new Map<string, { x: number; y: number; z: number }>()
  const membership = new Map<string, string>()
  const point = { x: 10, y: 0, z: 0 }
  for (const item of source.slice(0, MAX_3D_NODES)) assert.ok(saveManualGalaxyPosition(manual, membership, item.id, `task:${item.id}`, point))
  const last = source[MAX_3D_NODES]
  assert.equal(saveManualGalaxyPosition(manual, membership, last.id, `task:${last.id}`, point), false)
  assert.ok(saveManualGalaxyPosition(manual, membership, source[0].id, `task:${source[0].id}`, point))
  assert.equal(manual.size, MAX_3D_NODES)
  assert.equal(membership.size, MAX_3D_NODES)
  const first = buildSnapshotGalaxyLayout(source.slice(0, MAX_3D_NODES))!
  const before = planGalaxyPlacement(first.galaxies, null, new Map())
  assert.ok('placements' in before)
  const filter = projectAgentTopology(source, 'all', 'all', last.name, noCollapse)
  const next = planGalaxyPlacement(buildGalaxyLayout(filter).galaxies, null, before.placements)
  assert.ok('placements' in next && next.evicted)
  assert.equal(next.placements.size, MAX_3D_NODES)
  assert.ok(next.placements.has(`cwd:${last.cwd}`))
  assert.equal(next.placements.has(first.galaxies[0].id), false)
  assert.ok(manual.has(source[0].id))
})

test('actual project growth moves only the expanding galaxy, including while its tasks are filtered out', () => {
  const initial = [agent('a', '/a'), agent('b', '/b'), agent('c', '/c')]
  const small = buildSnapshotGalaxyLayout(initial)!
  const before = planGalaxyPlacement(small.galaxies, small.galaxies, new Map())
  assert.ok('placements' in before)
  const agents = [...initial, ...Array.from({ length: 20 }, (_, i) => agent(`new-${i}`, '/a'))]
  const full = buildSnapshotGalaxyLayout(agents)!
  const filtered = projectGalaxyLayout(full, projectAgentTopology(agents, 'all', 'all', '/b', noCollapse))
  assert.deepEqual(filtered.galaxies.map(galaxy => galaxy.cwd), ['/b'])
  const expanded = planGalaxyPlacement(filtered.galaxies, full.galaxies, before.placements)
  assert.ok('placements' in expanded)
  assert.equal(expanded.relocated, 1)
  const original = before.placements.get('cwd:/a')!
  const moved = expanded.placements.get('cwd:/a')!
  assert.notDeepEqual([moved.x, moved.z], [original.x, original.z])
  assert.equal(moved.slot, original.slot)
  for (const id of ['cwd:/b', 'cwd:/c']) assert.deepEqual(expanded.placements.get(id), before.placements.get(id))
  assertSeparated([...expanded.placements.values()])
  const revealed = planGalaxyPlacement(full.galaxies, full.galaxies, expanded.placements)
  assert.ok('placements' in revealed)
  assert.equal(revealed.relocated, 0)
  assert.deepEqual(revealed.placements, expanded.placements)
})

test('projected growth without the full snapshot leaves every saved project center intact on conflict', () => {
  const small = buildSnapshotGalaxyLayout([agent('a', '/a'), agent('b', '/b')])!
  const before = planGalaxyPlacement(small.galaxies, null, new Map())
  assert.ok('placements' in before)
  const original = structuredClone(before.placements)
  const large = buildSnapshotGalaxyLayout([...Array.from({ length: 20 }, (_, i) => agent(`a-${i}`, '/a')), agent('b', '/b')])!
  const next = planGalaxyPlacement(large.galaxies, null, before.placements)
  assert.ok('conflict' in next)
  assert.equal(next.conflict.cwd, '/a')
  assert.deepEqual(before.placements, original)
  const again = planGalaxyPlacement(small.galaxies, null, before.placements)
  assert.ok('placements' in again)
  assert.deepEqual(again.placements, original)
})

test('picking prefers the nearest real sphere surface before screen-space tolerance', () => {
  const ray = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }
  const centers = { miss: { x: 19, y: 0, z: 100 }, star: { x: 0, y: 0, z: 128 }, planet: { x: 0, y: 0, z: 118 } }
  const pick = (ids: (keyof typeof centers)[]) => pickAgentOnRay(ray, ids, id => centers[id as keyof typeof centers], id => id === 'star' ? 32 : 16, 0.04)
  assert.equal(pick(['miss', 'star']), 'star')
  assert.equal(pick(['star', 'miss']), 'star')
  assert.equal(pick(['planet', 'star', 'miss']), 'star')
  assert.equal(pick(['miss']), 'miss')
  centers.miss.x = 21
  assert.equal(pick(['miss']), null)
})
