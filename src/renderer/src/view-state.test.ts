import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInfo, AgentSnapshot, ScheduledJob, ScheduleSnapshot } from '../../shared/types'
import { agentTarget, scheduleTarget } from '../../shared/navigation'
import {
  MAX_SAVED_TOPOLOGY_NODES, createTopologyMemory, initialAgentView, initialScheduleView,
  pruneTopologyMemory, reconcileAgentView, reconcileScheduleView, saveTopologyPosition
} from './view-state'

const agent = (id: string, sessionId = id): AgentInfo => ({ id, sessionId, name: id, runtime: 'OMP', kind: 'main', state: 'idle', pid: 10, source: 'test' })
const agents = (items: AgentInfo[]): AgentSnapshot => ({ collectedAt: '2026-11-04T00:00:00Z', agents: items, activeSubagentCount: 0, sources: [] })
const job = (id: string, file = '/fixtures/job.plist'): ScheduledJob => ({ id, file, name: id, source: 'launchd', scope: 'user', origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' })
const schedules = (jobs: ScheduledJob[]): ScheduleSnapshot => ({ collectedAt: '2026-11-04T00:00:00Z', jobs, sources: [] })

test('restored selection follows identity, retains filters, and never selects a replacement object', () => {
  const original = agent('one')
  const view = { ...initialAgentView(), query: 'project', activity: 'inactive' as const, selectedId: original.id,
    identity: agentTarget(original).identity, open: true, collapsedIds: new Set(['one', 'departed']) }
  const retained = reconcileAgentView(view, agents([{ ...original, name: 'updated', state: 'working' }]))
  assert.equal(retained.selectedId, 'one')
  assert.equal(retained.open, true)
  assert.deepEqual([...retained.collapsedIds], ['one'])
  const replaced = reconcileAgentView(retained, agents([agent('one', 'new-session')]))
  assert.equal(replaced.selectedId, null)
  assert.equal(replaced.identity, null)
  assert.equal(replaced.open, true)
  assert.equal(replaced.unavailable, true)
  assert.equal(replaced.query, 'project')
  assert.equal(replaced.activity, 'inactive')
  const departed = reconcileAgentView(retained, agents([]))
  assert.equal(departed.selectedId, null)
  assert.equal(departed.collapsedIds.size, 0)
  assert.equal(reconcileAgentView(view, null).selectedId, 'one')
})

test('task replacement clears its history page without changing the saved task filters', () => {
  const original = job('task')
  const view = { ...initialScheduleView(), query: 'report', scope: 'personal' as const, selectedId: original.id,
    identity: scheduleTarget(original).identity, open: true, historyOffset: 50 }
  const retained = reconcileScheduleView(view, schedules([{ ...original, name: 'updated', state: 'running' }]))
  assert.equal(retained.historyOffset, 50)
  assert.equal(retained.selectedId, 'task')
  for (const snapshot of [schedules([]), schedules([job('task', '/fixtures/replacement.plist')])]) {
    const invalid = reconcileScheduleView(view, snapshot)
    assert.equal(invalid.selectedId, null)
    assert.equal(invalid.identity, null)
    assert.equal(invalid.historyOffset, 0)
    assert.equal(invalid.unavailable, true)
    assert.equal(invalid.open, true)
    assert.equal(invalid.query, 'report')
    assert.equal(invalid.scope, 'personal')
  }
  assert.equal(reconcileScheduleView(view, null).historyOffset, 50)
})

test('saved positions reject excess and invalid inputs while existing nodes remain editable at capacity', () => {
  const memory = createTopologyMemory()
  for (let index = 0; index < MAX_SAVED_TOPOLOGY_NODES; index++)
    assert.equal(saveTopologyPosition(memory, `node-${index}`, { x: index, y: 2 }, true), true)
  assert.equal(saveTopologyPosition(memory, 'overflow', { x: 1, y: 2 }, true), false)
  assert.equal(saveTopologyPosition(memory, 'node-0', { x: 12, y: -30 }, true), true)
  assert.deepEqual(memory.manualPositions.get('node-0'), { x: 12, y: -30 })
  assert.equal(saveTopologyPosition(memory, 'node-0', { x: Infinity, y: 0 }, true), false)
  assert.deepEqual(memory.positions.get('node-0'), { x: 12, y: -30 })
  assert.equal(saveTopologyPosition(createTopologyMemory(), 'x'.repeat(513), { x: 0, y: 0 }, false), false)
  pruneTopologyMemory(memory, [agent('node-0')])
  assert.deepEqual([...memory.positions.keys()], ['node-0'])
  assert.deepEqual([...memory.manualPositions.keys()], ['node-0'])
  assert.equal(saveTopologyPosition(memory, 'new-node', { x: 0, y: 0 }, true), true)
})

test('1000 object generations retain only live coordinates and collapse state, including temporarily hidden nodes', () => {
  const memory = createTopologyMemory()
  let view = initialAgentView()
  const persistent = agent('persistent')
  saveTopologyPosition(memory, persistent.id, { x: 90, y: 80 }, true)
  memory.dimensions.set(persistent.id, { width: 520, height: 380 })
  for (let generation = 0; generation < 1000; generation++) {
    const current = Array.from({ length: 16 }, (_, index) => agent(`${generation}:${index}`))
    for (const item of current) {
      saveTopologyPosition(memory, item.id, { x: generation, y: 20 }, true)
      memory.dimensions.set(item.id, { width: 520, height: 300 + generation % 16 })
      view.collapsedIds.add(item.id)
    }
    const snapshot = agents([persistent, ...current])
    pruneTopologyMemory(memory, snapshot.agents)
    view = reconcileAgentView(view, snapshot)
    assert.deepEqual([...memory.positions.keys()], snapshot.agents.map(item => item.id))
    assert.deepEqual([...memory.manualPositions.keys()], snapshot.agents.map(item => item.id))
    assert.deepEqual([...memory.dimensions.keys()], snapshot.agents.map(item => item.id))
    assert.deepEqual([...view.collapsedIds], current.map(item => item.id))
  }
  assert.deepEqual(memory.positions.get('persistent'), { x: 90, y: 80 })
  pruneTopologyMemory(memory, [])
  view = reconcileAgentView(view, agents([]))
  assert.equal(memory.positions.size, 0)
  assert.equal(memory.manualPositions.size, 0)
  assert.equal(memory.dimensions.size, 0)
  assert.equal(view.collapsedIds.size, 0)
})
