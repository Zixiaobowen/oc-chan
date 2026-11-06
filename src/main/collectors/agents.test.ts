import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTernSnapshot, collectTernWindows, enrichCollab, enrichSessionActivity, identifyRuntime, ownedSessionAgents, parseOpenFiles, parseSessionHeader, processAgents, socketSnapshot } from './agents'
import type { ProcessRow, SessionMetadata } from './agents'
import { appendFile, chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { consumeActivityRecord, createActivityState, recentActivity, SessionActivityReader } from './agent-activity'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { collectionResources } from '../resource-budget'
import { COLLECTION_LIMITS, DirectoryScan } from '../collection-limits'

const mainId = '01a19a5a-de13-74a4-8e90-08353b52847a'
const childId = '01a19a5e-efc1-74ea-868d-54bc946d1c5a'
const previousId = '01a19a5e-efc4-716f-9f9f-4fa319cc50d5'
const root = join(homedir(), '.omp', 'agent', 'sessions', '-project')
const mainFile = join(root, `${mainId}.jsonl`)
const childFile = join(root, mainId, 'Builder.jsonl')
const main: SessionMetadata = { sessionId: mainId, file: mainFile, cwd: '/project' }
const child: SessionMetadata = { sessionId: childId, file: childFile, parentSession: mainFile, cwd: '/project' }
function row(pid: number, ppid: number, executable: string, args = executable): ProcessRow {
  return { pid, ppid, executable, args, cpuPercent: 2, memoryBytes: 4096 }
}

test('shell prompts, search tools and arbitrary node scripts do not become agents', () => {
  const rows = [
    row(1, 0, '/bin/zsh', 'zsh -c omp --model foo'),
    row(2, 0, '/usr/bin/grep', 'grep codex'),
    row(3, 0, '/usr/local/bin/node', 'node /tmp/app.js --prompt claude'),
    row(4, 0, '/usr/bin/python3', 'python3 monitor-omp.py'),
    row(5, 0, '/usr/bin/echo', 'echo /opt/bin/opencode'),
    row(6, 0, '/opt/bin/omp', 'omp session lease --json -- abc'),
    row(7, 0, '/opt/bin/codex', 'codex app-server'),
  ]
  for (const item of rows) assert.equal(identifyRuntime(item), undefined)
})

test('known CLI executables and package entry points are recognized', () => {
  assert.equal(identifyRuntime(row(1, 0, '/opt/bin/claude'))?.runtime, 'Claude Code')
  assert.equal(identifyRuntime(row(2, 0, '/opt/bin/opencode'))?.runtime, 'OpenCode')
  assert.equal(identifyRuntime(row(3, 0, '/Users/me/Library/Application Support/Tern/omp/versions/18.15.0'))?.runtime, 'OMP')
  assert.equal(identifyRuntime(row(4, 0, '/opt/bin/node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'))?.wrapper, true)
})

test('dead PIDs never survive process discovery and wrapper/native count once', () => {
  const result = processAgents([
    row(10, 1, '/opt/bin/node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'),
    row(11, 10, '/usr/lib/node_modules/@openai/codex/vendor/codex'),
    row(12, 1, '/opt/bin/omp'),
  ], pid => pid !== 12)
  assert.equal(result.length, 1)
  assert.equal(result[0].pid, 11)
  assert.equal(result[0].kind, 'main')
  assert.equal(result[0].parentId, undefined)
})

test('process ancestry crosses an intermediate shell and does not create a wrapper self-parent', () => {
  const result = processAgents([
    row(10, 1, '/opt/bin/omp'),
    row(20, 10, '/bin/zsh'),
    row(21, 20, '/opt/bin/node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'),
    row(22, 21, '/opt/vendor/codex'),
  ], () => true)
  assert.equal(result.length, 2)
  const nested = result.find(item => item.pid === 22)!
  assert.equal(nested.parentId, 'process:10')
  assert.equal(nested.kind, 'subagent')
})

test('session header parsing returns only allowed metadata and ignores conversation payload', () => {
  const prefix = `# title slot\n${JSON.stringify({ type: 'session', id: childId, timestamp: '2026-11-02T03:47:55.457Z', cwd: '/project', parentSession: mainFile, secret: 'never-export' })}\n${JSON.stringify({ type: 'model_change', model: 'provider/model' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'private prompt' } })}\n`
  const metadata = parseSessionHeader(prefix, childFile)!
  assert.equal(metadata.parentSession, mainFile)
  assert.equal(metadata.model, 'provider/model')
  assert.equal(metadata.sessionId, childId)
  assert.equal(JSON.stringify(metadata).includes('private prompt'), false)
  assert.equal(JSON.stringify(metadata).includes('never-export'), false)
  assert.equal(parseSessionHeader('{"type":"session","id":"invalid"}\n', childFile), undefined)
})

test('current title labels the owned session, follows renames and never revives a stale header title', () => {
  const header = JSON.stringify({ type: 'session', id: mainId, title: 'Outdated task' })
  const parse = (title: unknown) => parseSessionHeader(`${JSON.stringify({ type: 'title', v: 1, title })}\n${header}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'private prompt' } })}\n`, mainFile)!
  const metadata = parse('\u{f06a9} AGENT: 添加简短工作摘要')
  const agents = ownedSessionAgents(processAgents([row(40, 1, '/opt/bin/omp')], () => true), [
    { pid: 40, sessions: [mainFile], leases: [mainId] },
  ], [metadata])
  assert.equal(agents[0].summary, 'AGENT: 添加简短工作摘要')
  assert.equal(JSON.stringify(agents).includes('private prompt'), false)
  assert.equal(parse('AGENT: 验证工作摘要').summary, 'AGENT: 验证工作摘要')
  for (const title of ['', 'omp', '   ', 'a'.repeat(513), 'bad\nlabel', 42]) {
    assert.equal(parse(title).summary, undefined)
  }
})

test('same-PID child links use parentSession and retained children never count as running', () => {
  const processes = processAgents([row(40, 1, '/opt/bin/omp')], () => true)
  const result = ownedSessionAgents(processes, [{ pid: 40, sessions: [mainFile, childFile], leases: [mainId, childId] }], [main, child])
  assert.equal(result.length, 2)
  assert.equal(result[0].pid, result[1].pid)
  assert.equal(result[1].parentId, `omp:${mainId}`)
  assert.equal(result[1].kind, 'subagent')
  assert.equal(result[1].state, 'unknown')
  assert.equal(result[1].cpuPercent, undefined)
  assert.equal(result.filter(item => item.kind === 'subagent' && ['working', 'running'].includes(item.state)).length, 0)
})

test('history and an unmatched or released lease cannot create child agents', () => {
  const processes = processAgents([row(40, 1, '/opt/bin/omp')], () => true)
  const historical = { ...child, file: join(root, mainId, 'Finished.jsonl'), sessionId: previousId }
  const result = ownedSessionAgents(processes, [{ pid: 40, sessions: [mainFile, childFile], leases: [mainId, previousId] }], [main, child, historical])
  assert.deepEqual(result.map(item => item.sessionId), [mainId])
  assert.deepEqual(ownedSessionAgents([], [{ pid: 40, sessions: [childFile], leases: [childId] }], [child]), [])
})

test('lsof descriptor parsing preserves PID/session association and ignores unrelated files', () => {
  const lease = join(homedir(), '.omp', 'run', 'session-owners', `${mainId}.lock`)
  const parsed = parseOpenFiles(`p40\nfcwd\nn/project\nf39\nn${lease}\nf51\nn${mainFile}\nf52\nn/tmp/codex-prompt.jsonl\np41\nfcwd\nn/other\n`)
  assert.deepEqual(parsed, [
    { pid: 40, cwd: '/project', sessions: [mainFile], leases: [mainId] },
    { pid: 41, cwd: '/other', sessions: [], leases: [] },
  ])
})

test('Tern working evidence updates only the exact live main session and exports no pane prompt', () => {
  const processes = processAgents([row(40, 1, '/opt/bin/omp')], () => true)
  const agents = ownedSessionAgents(processes, [{ pid: 40, sessions: [mainFile, childFile], leases: [mainId, childId] }], [main, child])
  const matched = applyTernSnapshot(agents, [main, child], { panes: [
    { pane: 101, omp_session_file: mainFile, working: true, exited: null, args: ['private prompt'], title: 'private title' },
    { omp_session_file: childFile, working: false, exited: null },
    { omp_session_file: '/different/session.jsonl', working: false, exited: null },
  ] }, '3')
  assert.equal(matched, 1)
  assert.equal(agents[0].state, 'working')
  assert.equal(agents[1].state, 'unknown')
  assert.deepEqual(agents[0].tern, { windowKey: '3', paneId: 101, sessionFile: mainFile })
  assert.equal(agents[1].tern, undefined)
  assert.equal(JSON.stringify(agents).includes('private'), false)
  assert.equal(applyTernSnapshot(agents, [main], { panes: [{ omp_session_file: mainFile, working: false, exited: 0 }] }, '3'), 0)
  assert.equal(agents[0].state, 'working')
  applyTernSnapshot(agents, [main], { panes: [{ omp_session_file: mainFile, working: false, exited: null }] }, '3')
  assert.equal(agents[0].state, 'idle')
})

test('OMP internal worker entry points and worker argv0 never count as agents', () => {
  const executable = '/Users/me/Library/Application Support/Tern/omp/versions/18.15.0'
  for (const worker of ['__omp_worker_js_eval_process', '__omp_worker_daemon_broker', '__omp_worker_parent_watchdog', '__omp_worker_stats_sync', '__omp_worker_new_internal_role']) {
    assert.equal(identifyRuntime(row(2, 1, executable, `${executable} ${worker}`)), undefined)
    assert.equal(identifyRuntime(row(2, 1, executable, `${worker} --owner 1`)), undefined)
    assert.equal(identifyRuntime(row(2, 1, '/opt/bin/node', `node /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ${worker}`)), undefined)
  }
  const result = processAgents([
    row(1, 0, executable, `${executable} --continue`),
    row(2, 1, executable, `${executable} __omp_worker_js_eval_process`),
    row(3, 1, executable, `${executable} __omp_worker_daemon_broker`),
  ], () => true)
  assert.deepEqual(result.map(agent => agent.pid), [1])
})

test('Codex service subcommands after valued or boolean global options are excluded', () => {
  const executable = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  for (const args of [
    '-c features.code_mode_host=true app-server --analytics-default-enabled',
    '--config features.code_mode_host=true --enable example app-server',
    '--config=features.code_mode_host=true --no-alt-screen app-server',
    '-cfeatures.code_mode_host=true app-server',
    '--profile development --cd /project exec-server',
  ]) assert.equal(identifyRuntime(row(8, 1, executable, `${executable} ${args}`)), undefined)
  assert.equal(identifyRuntime(row(9, 1, '/opt/bin/node', 'node /opt/node_modules/@openai/codex/bin/codex.js -c features.code_mode_host=true app-server')), undefined)
})

test('helper words in option values or user prompts do not suppress real CLI sessions', () => {
  for (const args of [
    'codex -m app-server Explain the architecture',
    'codex --config description="app-server service" Explain the architecture',
    'codex --model gpt-6 Explain app-server startup',
    'codex exec Explain app-server startup',
    'codex -- app-server',
  ]) assert.equal(identifyRuntime(row(9, 1, '/opt/bin/codex', args))?.runtime, 'Codex')
  assert.equal(identifyRuntime(row(10, 1, '/opt/bin/omp', 'omp -p __omp_worker_js_eval_process is a name'))?.runtime, 'OMP')
  assert.equal(identifyRuntime(row(11, 1, '/opt/bin/omp', 'omp --model codex Explain __omp_worker_daemon_broker'))?.runtime, 'OMP')
  assert.equal(identifyRuntime(row(12, 1, '/opt/bin/omp', 'omp --profile work session lease --json')), undefined)
})

test('root-level OMP forks remain main sessions with process resources and accept Tern busy evidence', () => {
  for (const parentSession of [mainFile, mainId]) {
    const fork = { sessionId: childId, file: join(root, `${childId}.jsonl`), parentSession }
    const processes = processAgents([row(40, 1, '/opt/bin/omp'), row(50, 1, '/opt/bin/omp')], () => true)
    const agents = ownedSessionAgents(processes, [
      { pid: 40, sessions: [mainFile], leases: [mainId] },
      { pid: 50, sessions: [fork.file], leases: [childId] },
    ], [main, fork])
    const forkAgent = agents.find(agent => agent.sessionId === childId)!
    assert.equal(forkAgent.kind, 'main')
    assert.equal(forkAgent.parentId, undefined)
    assert.equal(forkAgent.cpuPercent, 2)
    assert.equal(forkAgent.memoryBytes, 4096)
    assert.equal(applyTernSnapshot(agents, [main, fork], { panes: [{ omp_session_file: fork.file, exited: null, working: true }] }, ''), 1)
    assert.equal(forkAgent.state, 'working')
  }
})

test('independent OMP child processes retain ancestry after session enrichment without parentSession', () => {
  const separate = { sessionId: childId, file: join(root, `${childId}.jsonl`) }
  const processes = processAgents([row(40, 1, '/opt/bin/omp'), row(50, 40, '/opt/bin/omp')], () => true)
  const agents = ownedSessionAgents(processes, [
    { pid: 40, sessions: [mainFile], leases: [mainId] },
    { pid: 50, sessions: [separate.file], leases: [childId] },
  ], [main, separate])
  const childAgent = agents.find(agent => agent.sessionId === childId)!
  assert.equal(childAgent.kind, 'subagent')
  assert.equal(childAgent.parentId, `omp:${mainId}`)
  assert.equal(childAgent.state, 'running')
  assert.equal(childAgent.cpuPercent, 2)
  assert.equal(childAgent.memoryBytes, 4096)
})

test('task artifact location identifies a same-process seance even when parentSession points at its source fork', () => {
  const seance = { ...child, parentSession: previousId }
  const agents = ownedSessionAgents(processAgents([row(40, 1, '/opt/bin/omp')], () => true), [
    { pid: 40, sessions: [mainFile, childFile], leases: [mainId, childId] },
  ], [main, seance])
  assert.equal(agents[1].kind, 'subagent')
  assert.equal(agents[1].parentId, `omp:${mainId}`)
  assert.equal(agents[1].state, 'unknown')
  assert.equal(agents[1].cpuPercent, undefined)
})

test('process consumer excludes Claude and OpenCode services without matching prompt words or option values', () => {
  const entries = [
    row(40, 1, '/opt/bin/claude', 'claude mcp serve'),
    row(41, 1, '/opt/bin/claude', 'claude --dangerously-skip-permissions mcp serve'),
    row(42, 1, '/opt/bin/node', 'node /opt/node_modules/@anthropic-ai/claude-code/cli.js mcp serve'),
    row(43, 1, '/opt/bin/claude', 'claude --settings /project/settings.json mcp serve'),
    row(44, 1, '/opt/bin/claude', 'claude daemon run'),
    row(45, 1, '/opt/bin/opencode', 'opencode serve --port 4096'),
    row(46, 1, '/opt/bin/opencode', 'opencode --log-level INFO --print-logs serve'),
    row(47, 1, '/opt/bin/opencode', 'opencode --log-level=DEBUG web'),
    row(48, 1, '/opt/bin/node', 'node /opt/node_modules/opencode-ai/bin/opencode serve'),
    row(50, 1, '/opt/bin/claude', 'claude -p mcp serve'),
    row(51, 1, '/opt/bin/claude', 'claude --model mcp Explain this project'),
    row(52, 1, '/opt/bin/claude', 'claude -- Explain mcp serve'),
    row(53, 1, '/opt/bin/claude', 'claude --system-prompt mcp serve'),
    row(54, 1, '/opt/bin/opencode', 'opencode --prompt serve this project'),
    row(55, 1, '/opt/bin/opencode', 'opencode run Explain serve'),
    row(56, 1, '/opt/bin/opencode', 'opencode --model serve /project'),
    row(57, 1, '/opt/bin/opencode', 'opencode -- serve'),
  ]
  const agents = processAgents(entries, () => true)
  assert.deepEqual(agents.map(agent => agent.pid), [50, 51, 52, 53, 54, 55, 56, 57])
  assert.equal(agents.every(agent => agent.kind === 'main'), true)
})

const activityNow = Date.parse('2026-11-02T12:00:00.000Z')
function toolStart(time = activityNow, id = 'call_1') {
  return { type: 'custom', customType: 'tool_execution_start', timestamp: new Date(time).toISOString(), data: { toolCallId: id, toolName: 'read', args: { path: 'private credential' }, intent: 'private prompt' } }
}
function assistantEvent(stopReason: string, time = activityNow) {
  return { type: 'message', timestamp: new Date(time).toISOString(), message: { role: 'assistant', stopReason, content: [{ type: 'text', text: 'private reply' }], providerPayload: 'private provider credential' } }
}

test('fresh structured tool/model evidence exports only whitelisted activity and expires after six seconds', () => {
  const state = createActivityState()
  assert.equal(consumeActivityRecord(state, assistantEvent('toolUse'), activityNow), 'ok')
  assert.deepEqual(recentActivity(state, activityNow), { kind: 'model', observedAt: new Date(activityNow).toISOString() })
  consumeActivityRecord(state, toolStart(), activityNow)
  assert.deepEqual(recentActivity(state, activityNow), { kind: 'tool', name: 'read', observedAt: new Date(activityNow).toISOString() })
  assert.equal(JSON.stringify(recentActivity(state, activityNow)).includes('private'), false)
  assert.ok(recentActivity(state, activityNow + 5999))
  assert.equal(recentActivity(state, activityNow + 6000), undefined)
  consumeActivityRecord(state, toolStart(activityNow - 6001), activityNow)
  assert.equal(recentActivity(state, activityNow), undefined)
})

test('assistant terminal events clear all pending calls; final text is never model activity', () => {
  for (const reason of ['stop', 'length', 'abort', 'aborted', 'error']) {
    const state = createActivityState()
    consumeActivityRecord(state, toolStart(), activityNow)
    consumeActivityRecord(state, toolStart(activityNow, 'call_2'), activityNow)
    consumeActivityRecord(state, assistantEvent(reason), activityNow)
    assert.equal(recentActivity(state, activityNow), undefined)
    assert.equal(recentActivity(state, activityNow + 1000), undefined)
  }
})

test('tool completion only clears its matching call and malformed/unsupported events suppress activity', () => {
  const state = createActivityState()
  consumeActivityRecord(state, toolStart(), activityNow)
  consumeActivityRecord(state, toolStart(activityNow, 'call_2'), activityNow)
  const result = { type: 'message', timestamp: new Date(activityNow).toISOString(), message: { role: 'toolResult', toolCallId: 'call_1', content: 'private output' } }
  consumeActivityRecord(state, result, activityNow)
  assert.ok(recentActivity(state, activityNow))
  consumeActivityRecord(state, { ...result, message: { ...result.message, toolCallId: 'call_2' } }, activityNow)
  assert.equal(recentActivity(state, activityNow), undefined)
  consumeActivityRecord(state, toolStart(), activityNow)
  assert.equal(consumeActivityRecord(state, { ...toolStart(), timestamp: 'invalid' }, activityNow), 'invalid')
  assert.equal(recentActivity(state, activityNow), undefined)
  assert.equal(consumeActivityRecord(state, toolStart(activityNow + 1), activityNow), 'invalid')
  consumeActivityRecord(state, toolStart(), activityNow)
  assert.equal(consumeActivityRecord(state, assistantEvent('unrecognized'), activityNow), 'unsupported')
  assert.equal(recentActivity(state, activityNow), undefined)
})

test('incremental reader caches unchanged files, joins partial records, and never revives finished keepAlive calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-activity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'session.jsonl')
  const reader = new SessionActivityReader()
  await writeFile(file, `${JSON.stringify(toolStart())}\n`)
  assert.equal((await reader.read(file, activityNow)).activity?.kind, 'tool')
  assert.equal((await reader.read(file, activityNow + 1)).bytesRead, 0)
  const terminal = JSON.stringify(assistantEvent('stop'))
  await appendFile(file, terminal.slice(0, 40))
  const partial = await reader.read(file, activityNow + 2)
  assert.equal(partial.activity, undefined)
  assert.match(partial.issues.join(), /尚未完整/)
  assert.equal((await reader.read(file, activityNow + 3)).bytesRead, 0)
  await appendFile(file, `${terminal.slice(40)}\n`)
  const finished = await reader.read(file, activityNow + 4)
  assert.equal(finished.activity, undefined)
  assert.deepEqual(finished.issues, [])
  assert.equal((await reader.read(file, activityNow + 5)).activity, undefined)
  await appendFile(file, `${JSON.stringify({ type: 'custom', customType: 'todo_hud_state' })}\n`)
  assert.equal((await reader.read(file, activityNow + 6)).activity, undefined)
})

test('tail reader bounds large files and reports malformed, oversized, truncated, rotated and missing data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-activity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'session.jsonl')
  const reader = new SessionActivityReader()
  await writeFile(file, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(300000) } })}\n${JSON.stringify(toolStart())}\n`)
  const bounded = await reader.read(file, activityNow)
  assert.ok(bounded.bytesRead <= 128 * 1024)
  assert.equal(bounded.activity?.kind, 'tool')
  assert.match(bounded.issues.join(), /尾部窗口/)
  assert.equal((await reader.read(file, activityNow + 1)).activity?.kind, 'tool')
  await appendFile(file, '{invalid json}\n')
  const malformed = await reader.read(file, activityNow + 2)
  assert.equal(malformed.activity, undefined)
  assert.match(malformed.issues.join(), /损坏/)
  await writeFile(file, `${JSON.stringify(toolStart())}\n`)
  const truncated = await reader.read(file, activityNow + 3)
  assert.equal(truncated.activity, undefined)
  assert.match(truncated.issues.join(), /截断或替换/)
  await rename(file, `${file}.old`)
  await writeFile(file, `${JSON.stringify(toolStart())}\n`)
  const rotated = await reader.read(file, activityNow + 4)
  assert.equal(rotated.activity, undefined)
  assert.match(rotated.issues.join(), /截断或替换/)
  await appendFile(file, 'x'.repeat(200000))
  const oversized = await reader.read(file, activityNow + 5)
  assert.equal(oversized.activity, undefined)
  assert.ok(oversized.bytesRead <= 128 * 1024)
  assert.match(oversized.issues.join(), /尚未完整/)
  assert.match((await reader.read(`${file}.missing`, activityNow)).issues.join(), /ENOENT/)
})

test('owned child call evidence preserves unknown state and old completed keepAlive sessions stay still', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-activity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'Builder.jsonl')
  await writeFile(file, `${JSON.stringify(toolStart(activityNow - 20000))}\n${JSON.stringify(assistantEvent('stop', activityNow - 10000))}\n`)
  const agents = ownedSessionAgents(processAgents([row(40, 1, '/opt/bin/omp')], () => true), [
    { pid: 40, sessions: [mainFile, childFile], leases: [mainId, childId] },
  ], [main, child])
  const reader = new SessionActivityReader()
  await enrichSessionActivity(agents, [{ ...child, file }], reader, activityNow)
  assert.equal(agents[1].activity, undefined)
  assert.equal(agents[1].state, 'unknown')
  await appendFile(file, `${JSON.stringify(toolStart())}\n`)
  await enrichSessionActivity(agents, [{ ...child, file }], reader, activityNow)
  assert.equal(agents.find(agent => agent.sessionId === childId)?.activity?.kind, 'tool')
  assert.equal(agents[1].state, 'unknown')
  await enrichSessionActivity(agents, [], reader, activityNow)
  assert.equal(agents[1].activity, undefined)
})

test('a call written during asynchronous sampling remains visible on the next unchanged read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-activity-clock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'Builder.jsonl')
  await writeFile(file, `${JSON.stringify(toolStart(activityNow + 5))}\n`)
  const agents = ownedSessionAgents(processAgents([row(40, 1, '/opt/bin/omp')], () => true), [
    { pid: 40, sessions: [mainFile, childFile], leases: [mainId, childId] },
  ], [main, child]).filter(agent => agent.kind === 'subagent')
  let clock = activityNow
  t.mock.method(Date, 'now', () => clock)
  const reader = new SessionActivityReader()
  const sampling = enrichSessionActivity(agents, [{ ...child, file }], reader)
  clock += 10
  assert.equal((await sampling).state, 'ok')
  assert.equal(agents[0].activity?.kind, 'tool')
  clock += 2000
  const unchanged = await reader.read(file)
  assert.equal(unchanged.activity?.kind, 'tool')
  assert.deepEqual(unchanged.issues, [])
})

test('Tern enumerates actual window keys including empty key, deduplicates clients and reports individual failures', async () => {
  const other = { ...main, sessionId: previousId, file: join(root, `${previousId}.jsonl`) }
  const agents = ownedSessionAgents(processAgents([row(40, 1, '/opt/bin/omp'), row(50, 1, '/opt/bin/omp')], () => true), [
    { pid: 40, sessions: [mainFile], leases: [mainId] }, { pid: 50, sessions: [other.file], leases: [previousId] },
  ], [main, other])
  const seen: string[] = []
  const status = await collectTernWindows(agents, [main, other], { clients: [
    { kind: 'window', window: '' }, { kind: 'window', window: '3' }, { kind: 'window', window: '3' },
    { kind: 'cli', window: '99' }, { kind: 'window', window: 'failed' },
  ] }, async key => {
    seen.push(key)
    if (key === 'failed') throw new Error('window closed')
    return { panes: [{ omp_session_file: key === '' ? mainFile : other.file, working: key === '', exited: null }] }
  })
  assert.deepEqual(seen.sort(), ['', '3', 'failed'])
  assert.equal(agents[0].state, 'working')
  assert.equal(agents[1].state, 'idle')
  assert.equal(status.state, 'partial')
  assert.match(status.detail, /窗口读取失败：failed/)
})

test('Tern window sampling limits both count and concurrency and rejects missing protocol', async () => {
  let running = 0
  let maximum = 0
  let calls = 0
  const status = await collectTernWindows([], [], { clients: Array.from({ length: 20 }, (_, i) => ({ kind: 'window', window: String(i) })) }, async () => {
    calls++
    maximum = Math.max(maximum, ++running)
    await nextTurn()
    running--
    return { panes: [] }
  })
  assert.equal(calls, 16)
  assert.ok(maximum <= 4)
  assert.match(status.detail, /最多 16 个窗口/)
  await assert.rejects(collectTernWindows([], [], {}, async () => ({ panes: [] })), /clients protocol/)
})

test('observed composite toolCallId format matches completion without leaking identity', () => {
  const state = createActivityState()
  const id = 'call_0123456789|fc_0123456789'
  consumeActivityRecord(state, toolStart(activityNow, id), activityNow)
  assert.equal(recentActivity(state, activityNow)?.kind, 'tool')
  assert.equal(JSON.stringify(recentActivity(state, activityNow)).includes(id), false)
  consumeActivityRecord(state, { type: 'message', timestamp: new Date(activityNow).toISOString(), message: { role: 'toolResult', toolCallId: id } }, activityNow)
  assert.equal(recentActivity(state, activityNow), undefined)
})

test('queued activity reads cancel before opening and retain removes pending session work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r01-file-'))
  const path = join(directory, 'session.jsonl')
  await writeFile(path, `${JSON.stringify(toolStart())}\n`)
  // ES2022 does not expose Promise.withResolvers in the project's TypeScript lib.
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  let opened = 0
  const holding = Promise.all(Array.from({ length: 8 }, () => collectionResources.run({ source: 'agent-test-files', kind: 'file', bytes: 0 }, async () => {
    const file = await open(path, 'r')
    try {
      if (++opened === 8) entered()
      await gate
    } finally { await file.close() }
  })))
  t.after(async () => { release(); await holding; await rm(directory, { recursive: true, force: true }) })
  await ready
  const reader = new SessionActivityReader()
  const controller = new AbortController()
  const cancelled = assert.rejects(reader.read(path, activityNow, controller.signal), { name: 'AbortError', code: 'ABORT_ERR' })
  controller.abort()
  await cancelled
  const removed = assert.rejects(reader.read(path, activityNow), { name: 'AbortError', code: 'ABORT_ERR' })
  reader.retain(new Set())
  await removed
  release()
  await holding
  assert.equal((await reader.read(path, activityNow)).activity?.kind, 'tool')
})

test('socket responses accept the UTF8 byte boundary and decode split characters, but reject bytes beyond it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r01-sock-'))
  const endpoint = join(directory, 'host.sock')
  const sockets = new Set<Socket>()
  const limit = 64 * 1024
  const empty = `${JSON.stringify({ v: 1, ok: true, snapshot: { pid: 42, sessionName: '' } })}\n`
  const available = limit - Buffer.byteLength(empty)
  const name = '界'.repeat(Math.floor(available / 3)) + 'a'.repeat(available % 3)
  let oversized = false
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      const reply = Buffer.from(`${JSON.stringify({ v: 1, ok: true, snapshot: { pid: 42, sessionName: name + (oversized ? '界' : '') } })}\n`)
      const split = reply.indexOf(Buffer.from('界')) + 1
      socket.write(reply.subarray(0, split))
      setImmediate(() => socket.end(reply.subarray(split)))
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  const snapshot = await socketSnapshot({ pid: 42, endpoint, token: 'test' })
  assert.equal(snapshot.sessionName, name)
  oversized = true
  await assert.rejects(socketSnapshot({ pid: 42, endpoint, token: 'test' }), /socket response too large/)
})

test('socket admission cancels a queued connection and aborts the eight admitted connections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r01-sock-'))
  const endpoint = join(directory, 'host.sock')
  const sockets = new Set<Socket>()
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let connections = 0
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.resume()
    if (++connections === 8) entered()
  })
  const activeController = new AbortController()
  t.after(async () => {
    activeController.abort()
    for (const socket of sockets) socket.destroy()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  const host = { pid: 42, endpoint, token: 'test' }
  const active = Array.from({ length: 8 }, () => assert.rejects(socketSnapshot(host, activeController.signal), { name: 'AbortError', code: 'ABORT_ERR' }))
  await ready
  const queuedController = new AbortController()
  const queued = assert.rejects(socketSnapshot(host, queuedController.signal), { name: 'AbortError', code: 'ABORT_ERR' })
  queuedController.abort()
  await queued
  assert.equal(connections, 8)
  activeController.abort()
  await Promise.all(active)
})

async function collabFixture(t: TestContext, onRequest?: (socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r02-host-'))
  const registry = join(directory, 'registry')
  await mkdir(registry, { mode: 0o700 })
  const endpoint = join(directory, 'host.sock')
  const sockets = new Set<Socket>()
  let connections = 0
  const server = createServer(socket => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      if (onRequest) onRequest(socket)
      else socket.end(`${JSON.stringify({ v: 1, ok: true, snapshot: { pid: process.pid, busy: false } })}\n`)
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  const record = JSON.stringify({ version: 1, pid: process.pid, endpoint, token: 'test' })
  const agents = processAgents([row(process.pid, 1, '/opt/bin/omp')], () => true)
  return { directory, registry, endpoint, record, agents, connections: () => connections }
}

function assertAgentResourcesReleased(): void {
  const usage = collectionResources.snapshot().global.current
  assert.equal(usage.files, 0)
  assert.equal(usage.fileBytes, 0)
  assert.equal(usage.sockets, 0)
  assert.equal(usage.socketBytes, 0)
  assert.equal(usage.queued, 0)
}

test('collab counts filtered entries at 4096, rejects 4097 before sockets and releases cancelled directory scans', async t => {
  const fixture = await collabFixture(t)
  await writeFile(join(fixture.registry, 'host.json'), fixture.record, { mode: 0o600 })
  for (let start = 0; start < 4095; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 4095 - start) }, (_, index) => writeFile(join(fixture.registry, `ignored-${start + index}.txt`), '')))
  }
  const accepted = await enrichCollab(fixture.agents, undefined, fixture.registry)
  assert.equal(accepted.state, 'ok')
  assert.equal(fixture.connections(), 1)
  assertAgentResourcesReleased()
  const controller = new AbortController()
  const scan = new DirectoryScan()
  await assert.rejects(scan.read(fixture.registry, 'agent-collab', controller.signal, () => {
    if (scan.scanned === 32) controller.abort()
    return false
  }), { name: 'AbortError', code: 'ABORT_ERR' })
  assert.equal(scan.scanned, 32)
  assertAgentResourcesReleased()
  await writeFile(join(fixture.registry, 'one-more.txt'), '')
  const refused = await enrichCollab(fixture.agents, undefined, fixture.registry)
  assert.equal(refused.state, 'partial')
  assert.match(refused.detail, /OC_COLLECTION_LIMIT/)
  assert.match(refused.detail, /4096.*非 JSON/)
  assert.equal(fixture.connections(), 1)
  assertAgentResourcesReleased()
})

test('collab contacts at most 32 hosts and makes incomplete coverage explicit', async t => {
  const fixture = await collabFixture(t)
  for (let index = 0; index < 33; index++) await writeFile(join(fixture.registry, `host-${index}.json`), fixture.record, { mode: 0o600 })
  const result = await enrichCollab(fixture.agents, undefined, fixture.registry)
  assert.equal(result.state, 'partial')
  assert.match(result.detail, /最多 32 个 host/)
  assert.equal(fixture.connections(), 32)
  assertAgentResourcesReleased()
})

test('collab refuses oversized records and fields before connecting, with exact byte boundary accepted', async t => {
  const fixture = await collabFixture(t)
  const path = join(fixture.registry, 'host.json')
  const exact = fixture.record + ' '.repeat(COLLECTION_LIMITS.fieldBytes - Buffer.byteLength(fixture.record))
  await writeFile(path, exact, { mode: 0o600 })
  assert.equal((await enrichCollab(fixture.agents, undefined, fixture.registry)).state, 'ok')
  assert.equal(fixture.connections(), 1)
  await appendFile(path, ' ')
  const result = await enrichCollab(fixture.agents, undefined, fixture.registry)
  assert.equal(result.state, 'partial')
  assert.match(result.detail, /OC_COLLECTION_LIMIT/)
  assert.equal(fixture.connections(), 1)
  await assert.rejects(socketSnapshot({ pid: process.pid, endpoint: fixture.endpoint, token: '界'.repeat(1366) }), { code: 'OC_COLLECTION_LIMIT' })
  await assert.rejects(socketSnapshot({ pid: process.pid, endpoint: '/'.repeat(4097), token: 'test' }), { code: 'OC_COLLECTION_LIMIT' })
  assert.equal(fixture.connections(), 1)
  assertAgentResourcesReleased()
})

test('collab preserves private registry, record permissions, symlink and host identity checks', async t => {
  const fixture = await collabFixture(t)
  const path = join(fixture.registry, 'host.json')
  await writeFile(path, fixture.record, { mode: 0o600 })
  await chmod(fixture.registry, 0o755)
  assert.equal((await enrichCollab(fixture.agents, undefined, fixture.registry)).state, 'error')
  await chmod(fixture.registry, 0o700)
  await chmod(path, 0o644)
  assert.equal((await enrichCollab(fixture.agents, undefined, fixture.registry)).state, 'partial')
  await rename(path, join(fixture.directory, 'original.json'))
  await symlink(join(fixture.directory, 'original.json'), path)
  assert.equal((await enrichCollab(fixture.agents, undefined, fixture.registry)).state, 'partial')
  const linked = join(fixture.directory, 'linked')
  await symlink(fixture.registry, linked)
  assert.equal((await enrichCollab(fixture.agents, undefined, linked)).state, 'error')
  await rm(path)
  await writeFile(path, fixture.record, { mode: 0o600 })
  assert.equal((await enrichCollab([], undefined, fixture.registry)).state, 'empty')
  assert.equal(fixture.connections(), 0)
  assertAgentResourcesReleased()
})

test('collab cancellation waits for every socket and queued read to release', async t => {
  const controller = new AbortController()
  let requests = 0
  const fixture = await collabFixture(t, () => { if (++requests === 8) controller.abort() })
  t.after(() => controller.abort())
  for (let index = 0; index < 32; index++) await writeFile(join(fixture.registry, `host-${index}.json`), fixture.record, { mode: 0o600 })
  await assert.rejects(enrichCollab(fixture.agents, controller.signal, fixture.registry), { name: 'AbortError', code: 'ABORT_ERR' })
  assertAgentResourcesReleased()
  assert.equal(fixture.connections(), 8)
})

test('ownership bounds aggregate descriptors across processes and checks UTF8 fields before retaining paths', () => {
  const lease = join(homedir(), '.omp', 'run', 'session-owners', `${mainId}.lock`)
  const half = `f1\nn${lease}\n`.repeat(2048)
  const exact = `p40\n${half}p41\n${half}`
  const parsed = parseOpenFiles(exact)
  assert.equal(parsed[0].leases.length + parsed[1].leases.length, 4096)
  assert.throws(() => parseOpenFiles(`${exact}f2\nn${mainFile}\n`), { code: 'OC_COLLECTION_LIMIT' })
  assert.throws(() => parseOpenFiles('p40\n'.repeat(4097)), { code: 'OC_COLLECTION_LIMIT' })
  assert.equal(parseOpenFiles(`p40\nfcwd\nn/${'a'.repeat(4095)}\n`)[0].cwd?.length, 4096)
  assert.throws(() => parseOpenFiles(`p40\nfcwd\nn/${'a'.repeat(4096)}\n`), { code: 'OC_COLLECTION_LIMIT' })
  assert.throws(() => parseOpenFiles(`p40\nfcwd\nn/${'界'.repeat(1366)}\n`), { code: 'OC_COLLECTION_LIMIT' })
  assert.throws(() => parseSessionHeader(JSON.stringify({ type: 'session', id: mainId, cwd: '界'.repeat(1366) }), mainFile), { code: 'OC_COLLECTION_LIMIT' })
})

test('Tern rejects oversized host arrays before window inspection or pane association', async () => {
  let inspections = 0
  await assert.rejects(collectTernWindows([], [], { clients: Array(4097).fill({ kind: 'window', window: '1' }) }, async () => {
    inspections++
    return { panes: [] }
  }), { code: 'OC_COLLECTION_LIMIT' })
  assert.equal(inspections, 0)
  assert.throws(() => applyTernSnapshot([], [], { panes: Array(4097).fill({}) }, ''), { code: 'OC_COLLECTION_LIMIT' })
})

test('oversized collaboration metadata leaves the process unchanged and reports incomplete source', async t => {
  const fixture = await collabFixture(t, socket => {
    socket.end(`${JSON.stringify({ v: 1, ok: true, snapshot: { pid: process.pid, sessionName: 'new name', cwd: '界'.repeat(1366), busy: false } })}\n`)
  })
  await writeFile(join(fixture.registry, 'host.json'), fixture.record, { mode: 0o600 })
  const before = { ...fixture.agents[0] }
  const status = await enrichCollab(fixture.agents, undefined, fixture.registry)
  assert.equal(status.state, 'partial')
  assert.match(status.detail, /OC_COLLECTION_LIMIT/)
  assert.deepEqual(fixture.agents[0], before)
  assertAgentResourcesReleased()
})

test('activity coverage remains 128 owned sessions and explicitly reports the uncovered session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r02-coverage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const metadata: SessionMetadata[] = []
  const agents = []
  for (let index = 0; index < 129; index++) {
    const sessionId = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
    const file = join(directory, `${sessionId}.jsonl`)
    await writeFile(file, `${JSON.stringify(toolStart())}\n`)
    metadata.push({ sessionId, file })
    agents.push({ ...processAgents([row(process.pid, 1, '/opt/bin/omp')], () => true)[0], id: `omp:${sessionId}`, sessionId })
  }
  const status = await enrichSessionActivity(agents, metadata, new SessionActivityReader(), activityNow)
  assert.equal(status.state, 'partial')
  assert.match(status.detail, /读取 128 个/)
  assert.match(status.detail, /1 个进程缺少/)
  assert.equal(agents.filter(agent => agent.activity).length, 128)
  assert.equal(agents[128].activity, undefined)
  assertAgentResourcesReleased()
})
