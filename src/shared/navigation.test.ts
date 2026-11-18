import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTarget, navigationPage, parseNavigationTarget, scheduleTarget } from './navigation'
import { MAX_AGENT_ID_LENGTH, MAX_SCHEDULE_ID_LENGTH, MAX_SOURCE_ID_LENGTH, type AgentInfo, type ScheduledJob } from './types'

const agent: AgentInfo = { id: 'process:41', pid: 41, runtime: 'OMP', name: 'same title', kind: 'main', state: 'idle', source: 'test', sessionId: 'session-a', startedAt: '2026-11-04T08:00:00Z' }
const job: ScheduledJob = { id: 'task-a', name: 'same title', source: 'launchd', scope: 'user', origin: 'personal', kind: 'interval', schedule: 'every hour', state: 'waiting', file: '/tmp/task-a.plist' }

test('navigation preserves identity while allowing mutable names and activity to change', () => {
  assert.deepEqual(agentTarget({ ...agent, name: 'renamed', state: 'working' }), agentTarget(agent))
  for (const change of [{ sessionId: 'session-b' }, { startedAt: '2026-11-04T09:00:00Z' }, { pid: 42 }])
    assert.notEqual(agentTarget({ ...agent, ...change }).identity, agentTarget(agent).identity)
  assert.deepEqual(scheduleTarget({ ...job, name: 'renamed', state: 'running' }), scheduleTarget(job))
  assert.notEqual(scheduleTarget({ ...job, file: '/tmp/replacement.plist' }).identity, scheduleTarget(job).identity)
})

test('navigation accepts supported targets and routes them to their visible pages', () => {
  for (const [target, page] of [
    [agentTarget(agent), 'agents'], [scheduleTarget(job), 'schedules'],
    [{ kind: 'source', section: 'schedules', id: 'hermes-runtime' }, 'sources'],
    ...['overview', 'agents', 'schedules', 'events', 'system', 'sources', 'plugins', 'settings'].map(page => [{ kind: 'page', page }, page])
  ] as const) {
    const parsed = parseNavigationTarget(target)
    assert.deepEqual(parsed, target)
    assert.equal(navigationPage(parsed), page)
  }
  assert.deepEqual(parseNavigationTarget(Object.assign(Object.create(null), { kind: 'page', page: 'events' })), { kind: 'page', page: 'events' })
})

test('navigation rejects unsupported shapes, extra fields and invalid metadata', () => {
  for (const target of [undefined, null, [], new Date(), 'file:///tmp/config',
    Object.create({ kind: 'page', page: 'agents' }), { kind: 'url', url: 'https://example.test' },
    { kind: 'page', page: 'file:///tmp/config' }, { kind: 'page', page: 'overview', command: 'sh' },
    { ...agentTarget(agent), id: 'a\0b' }, { ...agentTarget(agent), identity: '' },
    { ...agentTarget(agent), identity: 'a'.repeat(16385) }, { ...agentTarget(agent), identity: 'a\u007fb' },
    { kind: 'source', section: 'shell', id: 'x' }, { ...scheduleTarget(job), path: '/tmp/data' }])
    assert.throws(() => parseNavigationTarget(target), /Invalid navigation target/)
})

test('navigation accepts exact ID and identity limits and rejects oversized or empty IDs', () => {
  for (const [target, maximum] of [
    [agentTarget(agent), MAX_AGENT_ID_LENGTH], [scheduleTarget(job), MAX_SCHEDULE_ID_LENGTH],
    [{ kind: 'source', section: 'events', id: 'source' }, MAX_SOURCE_ID_LENGTH]
  ] as const) {
    const bounded = { ...target, id: 'a'.repeat(maximum) }
    assert.deepEqual(parseNavigationTarget(bounded), bounded)
    for (const id of ['', 'a'.repeat(maximum + 1), 'a\nb'])
      assert.throws(() => parseNavigationTarget({ ...target, id }), /Invalid navigation target/)
  }
  for (const target of [agentTarget(agent), scheduleTarget(job)]) {
    const bounded = { ...target, identity: 'a'.repeat(16384) }
    assert.deepEqual(parseNavigationTarget(bounded), bounded)
  }
})
