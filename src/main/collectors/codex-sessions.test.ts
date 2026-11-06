import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectCodexSessions, codexRolloutThreadId, parseCodexSessionHeader, readCodexSessionHeader } from './codex-sessions'
import { identifyRuntime, ownedSessionAgents, parseOpenFiles, processAgents, type ProcessRow } from './agents'
import { collectionResources } from '../resource-budget'
import { projectAgentTopology } from '../../renderer/src/agent-topology'

const mainId = '01a10000-0000-7000-8000-000000000001'
const childId = '01a10000-0000-7000-8000-000000000002'
const forkId = '01a10000-0000-7000-8000-000000000003'
const filename = (id: string) => `rollout-2026-11-06T00-00-00-${id}.jsonl`
const path = (id: string) => `/custom-codex/sessions/2026/11/06/${filename(id)}`
const record = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'session_meta', payload: {
  id, timestamp: '2026-11-06T00:00:00.000Z', cwd: '/project', source: 'cli', ...extra,
} })
const spawnSource = { subagent: { thread_spawn: { parent_thread_id: mainId, depth: 1, agent_nickname: 'Explorer', agent_role: 'explorer' } } }
const row = (pid = 40, args = '/opt/bin/codex'): ProcessRow => ({ pid, ppid: 1, executable: '/opt/bin/codex', args, cpuPercent: 2, memoryBytes: 4096 })

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'oc-codex-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'sessions/2026/11/06')
  await mkdir(dir, { recursive: true })
  const main = join(dir, filename(mainId))
  const child = join(dir, filename(childId))
  const fork = join(dir, filename(forkId))
  await writeFile(main, `${record(mainId)}\n`)
  await writeFile(child, `${record(childId, { source: spawnSource, session_id: mainId })}\n`)
  await writeFile(fork, `${record(forkId, { forked_from_id: mainId })}\n`)
  return { main, child, fork }
}

test('Codex writable descriptors accept custom homes and reverted rollouts, but exclude read-only history', () => {
  const reverted = path(`${mainId}_${forkId}`)
  assert.equal(codexRolloutThreadId(reverted), mainId)
  const result = parseOpenFiles(`p40\nfcwd\nn/project\nf3\nau\nn${path(mainId)}\nf4\naw\nn${reverted}\nf5\nar\nn${path(childId)}\nf6\nn${path(forkId)}\nf7\naw\nn/tmp/${filename(childId)}\np41\nf3\nn${path(childId)}\n`)
  assert.deepEqual(result[0].codexSessions, [path(mainId), reverted])
  assert.equal(result[1].codexSessions, undefined)
})

test('thread identity and explicit spawn parent survive without exporting private metadata or treating forks as children', () => {
  const header = parseCodexSessionHeader(record(childId, { source: spawnSource, session_id: mainId, base_instructions: { text: 'PRIVATE' }, dynamic_tools: [{ secret: 'PRIVATE' }] }), path(childId))
  assert.equal(header.sessionId, childId)
  assert.equal(header.parentSessionId, mainId)
  assert.equal(header.name, 'Explorer')
  assert.equal(header.subagent, true)
  assert.equal(JSON.stringify(header).includes('PRIVATE'), false)
  const fork = parseCodexSessionHeader(record(forkId, { source: 'vscode', originator: 'Codex Desktop', forked_from_id: mainId }), path(forkId))
  assert.equal(fork.subagent, false)
  assert.equal(fork.parentSessionId, undefined)
  assert.throws(() => parseCodexSessionHeader(record(mainId), path(childId)), { code: 'INVALID_METADATA' })
  assert.throws(() => parseCodexSessionHeader(record(childId, { source: { subagent: { thread_spawn: { parent_thread_id: 'bad' } } } }), path(childId)), { code: 'INVALID_METADATA' })
})

test('live shared-process Codex sessions produce a real topology edge and release it with the descriptor', async t => {
  const { main, child } = await fixture(t)
  const processes = processAgents([row()], () => true)
  const files = [{ pid: 40, sessions: [], leases: [], codexSessions: [main, child] }]
  const { agents } = await collectCodexSessions(processes, files, new Set())
  const root = agents.find(a => a.sessionId === mainId)!
  const nested = agents.find(a => a.sessionId === childId)!
  assert.equal(root.memoryBytes, 4096)
  assert.equal(nested.memoryBytes, undefined)
  assert.equal(nested.cpuPercent, undefined)
  assert.equal(nested.state, 'unknown')
  assert.equal(nested.parentId, root.id)
  const graph = projectAgentTopology(agents, 'subagent', 'all', '', new Set())
  assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [[root.id, nested.id]])
  assert.equal(graph.contextCount, 1)
  const released = await collectCodexSessions(processes, [{ ...files[0], codexSessions: [main] }], new Set())
  assert.deepEqual(released.agents.map(a => a.sessionId), [mainId])
  const exited = await collectCodexSessions([], files, new Set())
  assert.deepEqual(exited.agents, [])
})

test('desktop hosts require a writable session and do not double-count wrappers or multiple roots', async t => {
  const { main, fork } = await fixture(t)
  const host = row(41, '/opt/bin/codex -c feature=true app-server --analytics-default-enabled')
  assert.equal(identifyRuntime(host), undefined)
  assert.equal(identifyRuntime(host, true)?.host, true)
  assert.equal(identifyRuntime(row(42, '/opt/bin/codex exec-server'), true), undefined)
  const wrapper = { ...row(40, 'node /opt/node_modules/@openai/codex/bin/codex.js app-server'), executable: '/opt/bin/node' }
  const processes = processAgents([wrapper, { ...host, ppid: 40 }], () => true, true)
  assert.deepEqual(processes.map(a => a.pid), [41])
  assert.deepEqual((await collectCodexSessions(processes, [], new Set([40, 41]))).agents, [])
  const files = [{ pid: 41, sessions: [], leases: [], codexSessions: [main, fork] }]
  const { agents } = await collectCodexSessions(processes, files, new Set([40, 41]))
  assert.equal(agents.length, 2)
  for (const agent of agents) {
    assert.equal(agent.kind, 'main')
    assert.equal(agent.state, 'unknown')
    assert.equal(agent.parentId, undefined)
    assert.equal(agent.memoryBytes, undefined)
  }
})

test('missing sampled parents are explicit; separate process ancestors remap to Codex session ids', async t => {
  const { main, child } = await fixture(t)
  const processes = processAgents([row(40), { ...row(41), ppid: 40 }], () => true)
  const files = [{ pid: 40, sessions: [], leases: [], codexSessions: [main] }, { pid: 41, sessions: [], leases: [], codexSessions: [child] }]
  const { agents } = await collectCodexSessions(ownedSessionAgents(processes, files, []), files, new Set())
  assert.equal(agents[1].parentId, `codex:${mainId}`)
  assert.equal(agents[1].memoryBytes, 4096)
  const orphan = await collectCodexSessions([processes[1]], [files[1]], new Set())
  assert.equal(projectAgentTopology(orphan.agents, 'all', 'all', '', new Set()).issueCount, 1)
  assert.equal(projectAgentTopology(orphan.agents, 'all', 'all', '', new Set()).edges.length, 0)
})

test('ambiguous writers and duplicate thread identities are reported without arbitrary ownership', async t => {
  const { main } = await fixture(t)
  const processes = processAgents([row(40), row(41)], () => true)
  const files = [40, 41].map(pid => ({ pid, sessions: [], leases: [], codexSessions: [main] }))
  const ambiguous = await collectCodexSessions(processes, files, new Set())
  assert.equal(ambiguous.source.state, 'partial')
  assert.equal(ambiguous.agents.some(a => a.sessionId), false)
  const reverted = main.replace('.jsonl', `_${forkId}.jsonl`)
  await writeFile(reverted, `${record(mainId)}\n`)
  const duplicate = await collectCodexSessions([processes[0]], [{ ...files[0], codexSessions: [main, reverted] }], new Set())
  assert.equal(duplicate.source.state, 'partial')
  assert.equal(duplicate.agents.some(a => a.sessionId), false)
})

test('large instruction headers are bounded, conversation records never replace the first header, and errors release resources', async t => {
  const { main } = await fixture(t)
  await writeFile(main, `${record(mainId, { base_instructions: { text: 'PRIVATE'.repeat(20_000) } })}\n{broken conversation\n`)
  assert.equal((await readCodexSessionHeader(main)).sessionId, mainId)
  await writeFile(main, `${record(mainId, { base_instructions: { text: 'x'.repeat(1024 * 1024) } })}\n`)
  await assert.rejects(readCodexSessionHeader(main), { code: 'OC_COLLECTION_LIMIT' })
  await writeFile(main, record(mainId))
  await assert.rejects(readCodexSessionHeader(main), { code: 'INCOMPLETE_HEADER' })
  await writeFile(main, `invalid\n${record(mainId)}\n`)
  await assert.rejects(readCodexSessionHeader(main), SyntaxError)
  await assert.rejects(readCodexSessionHeader(main, AbortSignal.abort()), { name: 'AbortError' })
  const usage = collectionResources.snapshot().global.current
  assert.equal(usage.files, 0)
  assert.equal(usage.fileBytes, 0)
  assert.equal(usage.queued, 0)
})

test('the combined header allowance reports partial coverage instead of silently omitting children', async t => {
  const { main, child } = await fixture(t)
  const processes = processAgents([row()], () => true)
  const files = [{ pid: 40, sessions: [], leases: [], codexSessions: [main, child] }]
  const result = await collectCodexSessions(processes, files, new Set(), undefined, 1)
  assert.equal(result.source.state, 'partial')
  assert.equal(result.agents.length, 1)
  assert.equal(result.agents[0].sessionId, mainId)
  const missing = await collectCodexSessions(processes, [{ ...files[0], codexSessions: [`${main}.missing`] }], new Set())
  assert.equal(missing.source.state, 'partial')
  assert.deepEqual(missing.agents, processes)
})
