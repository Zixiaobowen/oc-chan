import assert from 'node:assert/strict'
import test from 'node:test'
import { Color, Matrix4, Vector3 } from 'three'
import { OfficeDistrict } from './agent-office-district'
import type { AgentInfo } from '../../shared/types'
import { projectAgentTopology, type TopologyGraph } from './agent-topology'
import {
  buildOfficeLayout,
  officeStreetCell,
  placeOfficeBuildings,
  MAX_3D_EDGES,
  MAX_3D_NODES,
  type OfficeLayout,
} from './agent-topology-3d-layout'

function agent(id: string, cwd?: string, parentId?: string): AgentInfo {
  return { id, cwd, parentId, name: id, runtime: 'OMP', kind: parentId ? 'subagent' : 'main', state: 'unknown', pid: 10, source: 'test' }
}

function assertCompleteLayout(graph: TopologyGraph, layout: OfficeLayout): void {
  const ids = graph.nodes.map(node => node.agent.id).sort()
  assert.deepEqual([...layout.positions.keys()].sort(), ids)
  assert.deepEqual([...layout.floorByAgent.keys()].sort(), ids)
  assert.deepEqual(layout.floors.flatMap(floor => floor.nodeIds).sort(), ids)
  assert.deepEqual(layout.buildings.flatMap(building => building.floors), layout.floors)
  const occupied = new Set<string>()
  for (const building of layout.buildings) {
    assert.ok(Object.values({ x: building.x, z: building.z, width: building.width, depth: building.depth }).every(Number.isFinite))
    for (const [index, floor] of building.floors.entries()) {
      assert.equal(floor.buildingId, building.id)
      assert.equal(floor.cwd, building.cwd)
      assert.equal(floor.x, building.x)
      assert.equal(floor.z, building.z)
      assert.equal(floor.level, index + 1)
      assert.equal(floor.y, index * 240)
      assert.equal(floor.width, building.width)
      assert.equal(floor.depth, building.depth)
      assert.ok(floor.width >= 760)
      assert.ok(floor.depth >= 420)
      assert.equal(floor.unresolved, floor.mainAgentId === null)
      if (floor.mainAgentId !== null) assert.ok(floor.nodeIds.includes(floor.mainAgentId))
      for (const id of floor.nodeIds) {
        assert.equal(layout.floorByAgent.get(id), floor.id)
        const position = layout.positions.get(id)!
        assert.ok(Object.values(position).every(Number.isFinite), `${id} has finite coordinates`)
        assert.equal(position.y, floor.y + 40)
        assert.ok(Math.abs(position.x) < floor.width / 2)
        assert.ok(Math.abs(position.z) < floor.depth / 2)
        if (id === floor.mainAgentId) {
          assert.equal(position.x, -floor.width / 2 + 160)
          assert.equal(position.z, 0)
        } else {
          assert.ok(position.x >= -floor.width / 2 + 390, `${id} stays outside the private office`)
        }
        const key = JSON.stringify([position.x + floor.x, position.y, position.z + floor.z])
        assert.ok(!occupied.has(key), `${id} has a distinct world position`)
        occupied.add(key)
      }
    }
  }
  assert.ok(new Set(layout.floors.map(floor => floor.width)).size <= 1)
  assert.ok(new Set(layout.floors.map(floor => floor.depth)).size <= 1)
  for (let index = 0; index < layout.buildings.length; index += 1) {
    const building = layout.buildings[index]
    for (let otherIndex = index + 1; otherIndex < layout.buildings.length; otherIndex += 1) {
      const other = layout.buildings[otherIndex]
      assert.ok(Math.abs(building.x - other.x) >= (building.width + other.width) / 2 + 320
        || Math.abs(building.z - other.z) >= (building.depth + other.depth) / 2 + 360,
      `${building.id} and ${other.id} have separated building footprints`)
    }
  }
}

const noCollapse = new Set<string>()

test('one project contains one floor per main task and cross-cwd descendants follow their task', () => {
  const graph = projectAgentTopology([
    agent('task-b', '/work/project'), agent('task-a', '/work/project/'),
    agent('child', '/another/project', 'task-a'), agent('grandchild', undefined, 'child'),
    agent('task-c', '/work/project'),
  ], 'all', 'all', '', noCollapse)
  graph.nodes.find(node => node.agent.id === 'task-a')!.agent.summary = 'Implement search'
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.buildings.length, 1)
  assert.equal(layout.buildings[0].cwd, '/work/project')
  assert.deepEqual(layout.floors.map(floor => floor.id), ['task:task-a', 'task:task-b', 'task:task-c'])
  assert.deepEqual(layout.floors.map(floor => floor.mainAgentId), ['task-a', 'task-b', 'task-c'])
  assert.equal(layout.floors[0].name, 'Implement search')
  assert.equal(layout.floors[1].name, 'task-b')
  assert.deepEqual(layout.floors[0].nodeIds, ['child', 'grandchild', 'task-a'])
  assert.deepEqual(layout.floors.map(floor => floor.y), [0, 240, 480])
  assertCompleteLayout(graph, layout)
})

test('full normalized project paths separate buildings even when basenames match', () => {
  const graph = projectAgentTopology([
    agent('b', '/work/b/project'), agent('nested', '/work/a/project/src'),
    agent('a', '/work/a/project'), agent('slash', '/work/a/project///'), agent('root', '/'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.deepEqual(layout.buildings.map(building => building.cwd), [
    '/', '/work/a/project', '/work/a/project/src', '/work/b/project',
  ])
  assert.equal(new Set(layout.buildings.map(building => building.id)).size, 4)
  assert.deepEqual(layout.buildings[1].floors.map(floor => floor.id), ['task:a', 'task:slash'])
  assertCompleteLayout(graph, layout)
})

test('unknown projects share the last building while known-root children retain their task', () => {
  const graph = projectAgentTopology([
    agent('missing'), agent('empty', ''), agent('blank', '  '),
    agent('known', '/z/project'), agent('child', undefined, 'known'), agent('named-unknown', 'unknown'),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  const unknown = layout.buildings.at(-1)!
  assert.equal(unknown.id, 'unknown')
  assert.equal(unknown.cwd, undefined)
  assert.deepEqual(unknown.floors.map(floor => floor.id), ['task:blank', 'task:empty', 'task:missing'])
  assert.equal(layout.floorByAgent.get('child'), 'task:known')
  assert.notEqual(layout.floors.find(floor => floor.id === 'task:named-unknown')!.buildingId, unknown.id)
  assertCompleteLayout(graph, layout)
})

test('main occupies the private office and all collaborators occupy spaced open workstations', () => {
  const graph = projectAgentTopology([
    agent('main', '/work'),
    ...Array.from({ length: 12 }, (_, index) => agent(`worker-${index}`, '/elsewhere', 'main')),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  const floor = layout.floors[0]
  const main = layout.positions.get('main')!
  assert.equal(main.x, -floor.width / 2 + 160)
  assert.equal(main.z, 0)
  const workers = floor.nodeIds.filter(id => id !== 'main').map(id => layout.positions.get(id)!)
  assert.ok(workers.every(position => position.x > main.x + 260 / 2))
  assert.equal(Math.min(...workers.map(position => position.z)) + Math.max(...workers.map(position => position.z)), 0)
  for (let index = 0; index < workers.length; index += 1) {
    for (let other = index + 1; other < workers.length; other += 1) {
      assert.ok(Math.hypot(workers[index].x - workers[other].x, workers[index].z - workers[other].z) >= 140)
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
  const layout = buildOfficeLayout(graph)
  const shuffled = { ...graph, nodes: graph.nodes.slice().reverse(), edges: graph.edges.slice().reverse() }
  const reordered = buildOfficeLayout(shuffled)
  assert.deepEqual(reordered, layout)
  assert.deepEqual([...reordered.positions], [...layout.positions])
  assert.deepEqual([...reordered.floorByAgent], [...layout.floorByAgent])
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('retained project parcels survive additions, reordering and expanded buildings', () => {
  const graph = projectAgentTopology([agent('b', '/b'), agent('c', '/c')], 'all', 'all', '', noCollapse)
  const before = buildOfficeLayout(graph)
  const slots = new Map(before.buildings.map((building, index) => [building.id, index]))
  const after = buildOfficeLayout(projectAgentTopology([agent('a', '/a'), ...graph.nodes.map(node => node.agent)], 'all', 'all', '', noCollapse))
  slots.set('cwd:/a', 2)
  placeOfficeBuildings(after.buildings, before.buildings[0].width, before.buildings[0].depth, slots)
  for (const building of before.buildings) {
    const retained = after.buildings.find(item => item.id === building.id)!
    assert.deepEqual([retained.x, retained.z], [building.x, building.z])
  }
  placeOfficeBuildings(after.buildings, 2800, 1800, slots)
  for (const building of after.buildings) for (const floor of building.floors) {
    assert.deepEqual([floor.x, floor.z, floor.width, floor.depth], [building.x, building.z, 2800, 1800])
  }
  const cells = Array.from({ length: MAX_3D_NODES }, (_, index) => officeStreetCell(index))
  assert.equal(new Set(cells.map(cell => `${cell.column}:${cell.row}`)).size, MAX_3D_NODES)
  assert.ok(cells.every(cell => Number.isInteger(cell.column) && Number.isInteger(cell.row)))
})

test('district roads avoid every footprint after expansion and scenery storage stays bounded', () => {
  const layout = buildOfficeLayout(projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => agent(`main-${index}`, `/project/${index}`)), 'all', 'all', '', noCollapse))
  const district = new OfficeDistrict()
  const geometries = district.meshes.map(mesh => mesh.geometry)
  const capacities = district.meshes.map(mesh => mesh.instanceMatrix.count)
  const matrix = new Matrix4()
  const position = new Vector3()
  const scale = new Vector3()
  try {
    for (const [width, depth] of [[760, 420], [2800, 1800]]) {
      placeOfficeBuildings(layout.buildings, width, depth)
      district.update(layout.buildings, new Color('#eeeeee'))
      for (let index = 0; index < district.paving.count; index++) {
        district.paving.getMatrixAt(index, matrix)
        position.setFromMatrixPosition(matrix)
        scale.setFromMatrixScale(matrix)
        if (position.y !== -14) continue
        for (const building of layout.buildings) {
          assert.ok(Math.abs(position.x - building.x) >= (scale.x + building.width) / 2
            || Math.abs(position.z - building.z) >= (scale.z + building.depth) / 2,
          `road stays outside ${building.id}`)
        }
      }
      assert.ok(district.meshes.every((mesh, index) => mesh.count <= capacities[index] && mesh.geometry === geometries[index]))
    }
    district.update([], new Color('#111111'))
    assert.ok(district.meshes.every(mesh => mesh.count === 0))
    assert.deepEqual(district.meshes.map(mesh => mesh.instanceMatrix.count), capacities)
  } finally {
    for (const mesh of district.meshes) {
      mesh.dispose()
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
})

test('cycles, self loops, missing parents and subagent roots never receive a fabricated main office', () => {
  const graph = projectAgentTopology([
    { ...agent('a', '/a', 'c'), kind: 'main' }, agent('b', '/b', 'a'), agent('c', '/c', 'b'),
    agent('leaf', '/leaf', 'b'), { ...agent('self', '/self', 'self'), kind: 'main' },
    { ...agent('orphan', undefined, 'absent'), kind: 'main' },
    { ...agent('unparented', '/work'), kind: 'subagent' },
  ], 'all', 'all', '', noCollapse)
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.floors.length, 4)
  assert.deepEqual(layout.floors.find(floor => floor.id === 'task:a')!.nodeIds, ['a', 'b', 'c', 'leaf'])
  assert.ok(layout.floors.every(floor => floor.mainAgentId === null && floor.unresolved))
  assert.equal(layout.positions.has('absent'), false)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('a cycle below a main root marks the whole task unresolved without changing its edges', () => {
  const graph = projectAgentTopology([
    agent('main', '/work'), agent('a', '/work', 'main'), agent('b', '/work', 'a'),
  ], 'all', 'all', '', noCollapse)
  graph.edges.push({ id: 'back', source: 'b', target: 'a' })
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.floors[0].id, 'task:main')
  assert.equal(layout.floors[0].mainAgentId, null)
  assert.equal(layout.floors[0].unresolved, true)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('1200-agent wide and deep tasks fit one floor without recursive traversal', () => {
  for (const shape of ['wide', 'deep']) {
    const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
      agent(`node-${index}`, index === 0 ? '/root' : `/child/${index}`,
        index === 0 ? undefined : shape === 'deep' ? `node-${index - 1}` : 'node-0')
    )), 'all', 'all', '', noCollapse)
    const layout = buildOfficeLayout(graph)
    assert.equal(layout.positions.size, 1200)
    assert.equal(layout.buildings.length, 1)
    assert.equal(layout.floors.length, 1)
    assert.equal(layout.floors[0].mainAgentId, 'node-0')
    assert.equal(layout.floors[0].cwd, '/root')
    assert.ok(new Set([...layout.positions.values()].map(point => point.x)).size > 1)
    assert.ok(new Set([...layout.positions.values()].map(point => point.z)).size > 1)
    assertCompleteLayout(graph, layout)
  }
})

test('1200 projects occupy distinct buildings with finite coordinates and shared dimensions', () => {
  const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
    agent(`main-${index}`, `/project/${index}`)
  )), 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.buildings.length, 1200)
  assert.equal(layout.floors.length, 1200)
  assert.ok(layout.floors.every(floor => floor.level === 1 && floor.y === 0))
  assertCompleteLayout(graph, layout)
})

test('all buildings and floors share dimensions even with different task occupancies', () => {
  const graph = projectAgentTopology([
    agent('small', '/small'), agent('large', '/large'), agent('other-task', '/large'),
    ...Array.from({ length: 80 }, (_, index) => agent(`child-${index}`, '/child', 'large')),
  ], 'all', 'all', '', noCollapse)
  const layout = buildOfficeLayout(graph)
  assert.equal(layout.buildings.length, 2)
  assert.equal(layout.floors.length, 3)
  assert.ok(layout.floors.every(floor => floor.width > 760 && floor.depth > 420))
  assertCompleteLayout(graph, layout)
})

test('2400 relationships are accepted and preserved with duplicate relationship evidence', () => {
  const graph = projectAgentTopology(Array.from({ length: MAX_3D_NODES }, (_, index) => (
    agent(`node-${index}`, '/work', index === 0 ? undefined : 'node-0')
  )), 'all', 'all', '', noCollapse)
  const beforeEdges = buildOfficeLayout(graph)
  graph.edges = Array.from({ length: MAX_3D_EDGES }, (_, index) => ({
    id: `edge-${index}`, source: 'node-0', target: `node-${1 + index % (MAX_3D_NODES - 1)}`,
  }))
  const original = structuredClone(graph)
  const layout = buildOfficeLayout(graph)
  assert.equal(graph.edges.length, 2400)
  assert.deepEqual(layout, beforeEdges)
  assert.deepEqual(graph, original)
  assertCompleteLayout(graph, layout)
})

test('filtering and collapsing preserve task and building identity for every visible agent', () => {
  const agents = [
    agent('main', '/project'), agent('child', '/different', 'main'), agent('grandchild', undefined, 'child'),
    agent('second', '/project'), agent('other-project', '/other'),
  ]
  const full = buildOfficeLayout(projectAgentTopology(agents, 'all', 'all', '', noCollapse))
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
    const layout = buildOfficeLayout(graph)
    for (const node of graph.nodes) {
      const id = layout.floorByAgent.get(node.agent.id)!
      assert.equal(id, full.floorByAgent.get(node.agent.id))
      const floor = layout.floors.find(candidate => candidate.id === id)!
      const original = full.floors.find(candidate => candidate.id === id)!
      assert.equal(floor.buildingId, original.buildingId)
      assert.equal(floor.mainAgentId, original.mainAgentId)
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
    assert.throws(() => buildOfficeLayout({ ...empty, nodes: unreadable, edges: unreadable, [field]: oversized }), error => {
      assert.ok(error instanceof RangeError)
      return true
    })
  }
  assert.deepEqual(buildOfficeLayout(empty), { buildings: [], floors: [], positions: new Map(), floorByAgent: new Map() })
})

test('malformed graph shapes and entries fail explicitly', () => {
  const graph = projectAgentTopology([agent('root', '/work')], 'all', 'all', '', noCollapse)
  assert.throws(() => buildOfficeLayout({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }), Error)
  assert.throws(() => buildOfficeLayout({
    ...graph, edges: [{ id: 'dangling', source: 'absent', target: 'root' }],
  }), Error)
  for (const invalid of [null, {}, { ...graph, nodes: null }, { ...graph, edges: null }, { ...graph, nodes: [null] }, { ...graph, edges: [null] }]) {
    assert.throws(() => buildOfficeLayout(invalid as unknown as TopologyGraph), TypeError)
  }
  for (const fields of [{ id: '' }, { id: '  ' }, { cwd: 42 }, { parentId: 42 }]) {
    assert.throws(() => buildOfficeLayout({
      ...graph, nodes: [{ ...graph.nodes[0], agent: { ...graph.nodes[0].agent, ...fields } as AgentInfo }],
    }), TypeError)
  }
  assert.throws(() => buildOfficeLayout({
    ...graph, edges: [{ id: 'invalid', source: 42, target: 'root' } as unknown as TopologyGraph['edges'][number]],
  }), TypeError)
})
