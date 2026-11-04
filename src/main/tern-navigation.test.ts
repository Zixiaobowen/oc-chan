import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInfo, TernTarget } from '../shared/types'
import { focusAgentInTern, resolveTernTarget } from './tern-navigation'

const target: TernTarget = { windowKey: '3', paneId: 101, sessionFile: '/sessions/main.jsonl' }
function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name: 'OMP', runtime: 'OMP', kind: 'main', state: 'idle', pid: 40, source: 'test', ...extra }
}

test('nested children navigate through confirmed parents, while a direct Tern pane takes precedence', () => {
  const agents = [
    agent('unrelated', { tern: { ...target, paneId: 202 } }),
    agent('main', { tern: target }),
    agent('child', { kind: 'subagent', parentId: 'main' }),
    agent('nested', { kind: 'subagent', parentId: 'child' }),
    agent('separate', { parentId: 'main', tern: { ...target, windowKey: '', paneId: 303 } }),
  ]
  assert.deepEqual(resolveTernTarget(agents, 'nested'), target)
  assert.deepEqual(resolveTernTarget(agents, 'separate'), { ...target, windowKey: '', paneId: 303 })
})

test('missing ownership, cycles and other runtimes never navigate to an unrelated same-PID session', () => {
  const agents = [
    agent('unrelated', { tern: target }),
    agent('orphan', { kind: 'subagent', parentId: 'missing' }),
    agent('a', { kind: 'subagent', parentId: 'b' }),
    agent('b', { kind: 'subagent', parentId: 'a' }),
    agent('codex', { runtime: 'Codex', parentId: 'unrelated' }),
  ]
  for (const id of ['orphan', 'a', 'b', 'codex', 'exited']) {
    assert.throws(() => resolveTernTarget(agents, id))
  }
})

test('a closed, moved or reused pane is rejected before changing focus or activating Tern', async () => {
  for (const panes of [
    [],
    [{ pane: target.paneId, exited: 0, omp_session_file: target.sessionFile }],
    [{ pane: target.paneId, exited: null, omp_session_file: '/sessions/replacement.jsonl' }],
    [{ pane: 202, exited: null, omp_session_file: target.sessionFile }],
  ]) {
    const actions: string[] = []
    const run = async (file: string, args: string[]) => {
      if (file === '/bin/ps') return '99 /Applications/Tern.app/Contents/MacOS/tern\n'
      if (args[0] === 'inspect') return JSON.stringify({ panes })
      actions.push(file)
      throw new Error('unexpected side effect')
    }
    await assert.rejects(focusAgentInTern([agent('main', { tern: target })], 'main', run), /已关闭、移动或更换会话/)
    assert.deepEqual(actions, [])
  }
})

test('a failed Tern focus command remains an error and never activates an unrelated window', async () => {
  let activated = false
  const run = async (file: string, args: string[]) => {
    if (file === '/bin/ps') return '99 /Applications/Tern.app/Contents/MacOS/tern\n'
    if (args[0] === 'inspect') return JSON.stringify({ panes: [{ pane: target.paneId, exited: null, omp_session_file: target.sessionFile }] })
    if (args[0] === 'focus') throw new Error('Tern connection closed')
    activated = true
    return ''
  }
  await assert.rejects(focusAgentInTern([agent('main', { tern: target })], 'main', run), /Tern connection closed/)
  assert.equal(activated, false)
})

test('pane selection alone is not success when native presentation fails or identifies another window', async () => {
  for (const presentation of [
    new Error('目标窗口未显示在前台'),
    { pid: 0, windowTitle: '[Tern "3"] Default', main: true },
    { pid: 99, windowTitle: '[Tern ""] Default', main: true },
    { pid: 99, windowTitle: '[Tern "3"] Default', main: false },
  ]) {
    const run = async (file: string, args: string[]) => {
      if (file === '/bin/ps') return '99 /Applications/Tern.app/Contents/MacOS/tern\n'
      if (args[0] === 'inspect') return JSON.stringify({ panes: [{ pane: target.paneId, exited: null, omp_session_file: target.sessionFile }] })
      if (args[0] === 'focus') return JSON.stringify({ block: target.paneId })
      if (args[0] === 'plugin') return JSON.stringify({ plugins: [{ id: 'oc-chan-navigation', status: 'ready', window: true }] })
      if (file === '/usr/bin/osascript') return ''
      if (presentation instanceof Error) throw presentation
      return JSON.stringify(presentation)
    }
    await assert.rejects(focusAgentInTern([agent('main', { tern: target })], 'main', run), /窗口/)
  }
})
