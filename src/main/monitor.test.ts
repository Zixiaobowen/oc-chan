import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSnapshot, MonitorUpdate, ScheduleSnapshot } from '../shared/types'
import { Monitor } from './monitor'

const empty: AgentSnapshot = { collectedAt: '2026-11-02T00:00:00.000Z', agents: [], sources: [], activeSubagentCount: 0 }

test('automatic discovery emits only changed sections, retains other references, and never toggles loading', async () => {
  let snapshot = empty
  const schedules: ScheduleSnapshot = { collectedAt: empty.collectedAt, jobs: [], sources: [] }
  const monitor = new Monitor({ discover: async () => ({ snapshot, sessions: [] }), schedules: async () => schedules })
  const updates: MonitorUpdate[] = []
  monitor.on('change', (update: MonitorUpdate) => updates.push(update))
  await monitor.refresh('schedules', false)
  const scheduleState = monitor.state.schedules
  const systemState = monitor.state.system
  await monitor.refresh('agents', false)
  assert.deepEqual(updates.map(update => update.section), ['schedules', 'agents'])
  assert.equal(updates.every(update => !update.state.refreshing), true)
  snapshot = { ...empty, collectedAt: '2026-11-02T00:00:02.000Z' }
  await monitor.refresh('agents', false)
  assert.equal(updates.length, 2, 'timestamp alone must not trigger an IPC redraw')
  assert.equal(monitor.state.agents.data?.collectedAt, snapshot.collectedAt)
  assert.equal(monitor.state.schedules, scheduleState)
  assert.equal(monitor.state.system, systemState)
  snapshot = { ...snapshot, sources: [{ id: 'ownership', label: 'Ownership', state: 'error', detail: 'lsof unavailable' }] }
  await monitor.refresh('agents', false)
  assert.deepEqual(updates.map(update => update.section), ['schedules', 'agents', 'agents'])
  assert.deepEqual(Object.keys(updates.at(-1)!).sort(), ['section', 'state'])
  monitor.stop()
})

test('discovery failures remain visible and a later successful reconciliation clears the error', async () => {
  let fail = true
  const monitor = new Monitor({ discover: async () => {
    if (fail) throw new Error('process source unavailable')
    return { snapshot: empty, sessions: [] }
  } })
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.error, 'process source unavailable')
  fail = false
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.error, null)
  assert.ok(monitor.state.agents.data)
  monitor.stop()
})

test('stop prevents late section publication from a collector already in flight', async () => {
  let finish!: (value: ScheduleSnapshot) => void
  const collecting = new Promise<ScheduleSnapshot>(resolve => { finish = resolve })
  const monitor = new Monitor({ schedules: () => collecting })
  const updates: MonitorUpdate[] = []
  monitor.on('change', (update: MonitorUpdate) => updates.push(update))
  const work = monitor.refresh('schedules')
  const beforeStop = updates.length
  monitor.stop()
  finish({ collectedAt: empty.collectedAt, jobs: [], sources: [] })
  await work
  await monitor.refresh('agents')
  assert.equal(updates.length, beforeStop)
  assert.equal(monitor.state.schedules.data, null)
})
