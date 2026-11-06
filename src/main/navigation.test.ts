import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTarget, parseNavigationTarget, PendingNavigation, scheduleTarget } from '../shared/navigation'
import type { AgentInfo, ScheduledJob } from '../shared/types'

const agent: AgentInfo = { id: 'process:41', pid: 41, runtime: 'OMP', name: 'same title', kind: 'main', state: 'idle', source: 'test', sessionId: 'session-a', startedAt: '2026-11-04T08:00:00Z' }
const job: ScheduledJob = { id: 'task-a', name: 'same title', source: 'launchd', scope: 'user', origin: 'personal', kind: 'interval', schedule: 'every hour', state: 'waiting', file: '/tmp/task-a.plist' }

test('navigation preserves identity while allowing mutable names and activity to change', () => {
  assert.deepEqual(agentTarget({ ...agent, name: 'renamed', state: 'working' }), agentTarget(agent))
  for (const change of [{ sessionId: 'session-b' }, { startedAt: '2026-11-04T09:00:00Z' }, { pid: 42 }])
    assert.notEqual(agentTarget({ ...agent, ...change }).identity, agentTarget(agent).identity)
  assert.deepEqual(scheduleTarget({ ...job, name: 'renamed', state: 'running' }), scheduleTarget(job))
  assert.notEqual(scheduleTarget({ ...job, file: '/tmp/replacement.plist' }).identity, scheduleTarget(job).identity)
})

test('navigation only accepts finite targets with bounded identity metadata', () => {
  for (const target of [agentTarget(agent), scheduleTarget(job), { kind: 'page', page: 'agents' }, { kind: 'page', page: 'events' }, { kind: 'source', section: 'schedules', id: 'hermes-runtime' }])
    assert.deepEqual(parseNavigationTarget(target), target)
  for (const target of [null, 'file:///tmp/config', { kind: 'url', url: 'https://example.test' },
    { kind: 'page', page: 'file:///tmp/config' }, { kind: 'page', page: 'overview', command: 'sh' },
    { ...agentTarget(agent), id: 'a\0b' }, { ...agentTarget(agent), identity: 'a'.repeat(16385) },
    { kind: 'source', section: 'shell', id: 'x' }, { ...scheduleTarget(job), path: '/tmp/data' }])
    assert.throws(() => parseNavigationTarget(target), /Invalid navigation target/)
})

test('navigation survives a cancelled read and stale acknowledgements cannot discard newer targets', () => {
  const pending = new PendingNavigation()
  pending.put(agentTarget(agent))
  const first = pending.read()!
  assert.deepEqual(pending.read(), first)
  pending.put(scheduleTarget(job))
  pending.acknowledge(first.sequence)
  const second = pending.read()!
  assert.deepEqual(second.target, scheduleTarget(job))
  assert(second.sequence > first.sequence)
  pending.acknowledge(second.sequence)
  assert.equal(pending.read(), null)
  pending.acknowledge(second.sequence)
  assert.equal(pending.read(), null)
})
