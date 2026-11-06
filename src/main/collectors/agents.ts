import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import type { AgentInfo, AgentSnapshot, SourceStatus } from '../../shared/types'
import { SessionActivityReader } from './agent-activity'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, ResourceCleanupError, resourceAbortError, settleResourceWork, throwIfAborted } from '../resource-budget'
import { runBudgetedCommand } from '../resource-io'
import { StringDecoder } from 'node:string_decoder'
import { COLLECTION_LIMITS, CollectionLimitError, DirectoryScan } from '../collection-limits'
import { codexRolloutThreadId, collectCodexSessions } from './codex-sessions'

const home = homedir()
const ompRoot = join(home, '.omp')
const sessionRoot = join(ompRoot, 'agent', 'sessions')
const ownersRoot = join(ompRoot, 'run', 'session-owners')
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const maxMetadata = 16 * 1024

export interface ProcessRow {
  pid: number
  ppid: number
  executable: string
  args: string
  cpuPercent: number
  memoryBytes: number
}
interface RuntimeMatch { runtime: string; wrapper: boolean; host?: boolean }
export interface SessionMetadata {
  sessionId: string
  file: string
  summary?: string
  cwd?: string
  parentSession?: string
  startedAt?: string
  model?: string
}
export interface OpenFiles { pid: number; cwd?: string; sessions: string[]; leases: string[]; codexSessions?: string[] }

function checkField(value: unknown): void {
  if (typeof value !== 'string') return
  const bytes = Buffer.byteLength(value)
  if (bytes > COLLECTION_LIMITS.fieldBytes) throw new CollectionLimitError('agent field bytes', COLLECTION_LIMITS.fieldBytes, bytes)
}
function checkCount(scope: string, count: number): void {
  if (count > COLLECTION_LIMITS.directoryEntries) throw new CollectionLimitError(scope, COLLECTION_LIMITS.directoryEntries, count)
}

function text(value: unknown, max = 512): string | undefined {
  checkField(value)
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function errorCode(error: unknown): string {
  const code = object(error)?.code
  return typeof code === 'string' ? code : error instanceof SyntaxError ? 'INVALID_JSON' : 'READ_FAILED'
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw error
  }
}

const ompValueFlags: Record<string, true> = {
  '--model': true, '--smol': true, '--slow': true, '--plan': true, '--provider': true, '--api-key': true,
  '--profile': true, '--alias': true, '--cwd': true, '--mode': true, '--config': true, '--add-dir': true,
  '--session-dir': true, '--models': true, '--tools': true, '--thinking': true, '--service-tier': true,
  '--max-time': true, '--warn-cost': true, '--max-cost': true, '--approval-mode': true, '--skills': true,
  '--hook': true, '--extension': true, '-e': true, '--plugin-dir': true, '--plan-yolo-into': true, '--prewalk-into': true,
}
const codexValueFlags: Record<string, true> = {
  '-c': true, '--config': true, '--enable': true, '--disable': true, '--remote': true, '--remote-auth-token-env': true,
  '-i': true, '--image': true, '-m': true, '--model': true, '--local-provider': true, '-p': true, '--profile': true,
  '-s': true, '--sandbox': true, '-C': true, '--cd': true, '--add-dir': true, '-a': true, '--ask-for-approval': true,
}
const ompBooleanFlags: Record<string, true> = {
  '--continue': true, '-c': true, '--allow-home': true, '--prewalk': true, '--no-prewalk': true, '--plan-yolo': true,
  '--no-session': true, '--no-tools': true, '--no-lsp': true, '--no-pty': true, '--hide-thinking': true,
  '--advisor': true, '--wait-async': true, '--external-thinking': true, '--no-extensions': true, '--no-skills': true,
  '--no-rules': true, '--no-context-files': true, '--no-title': true, '--no-ui': true, '--print-thoughts': true, '--auto-approve': true,
}
const codexBooleanFlags: Record<string, true> = {
  '--strict-config': true, '--oss': true, '--approve-for-me': true, '--dangerously-bypass-approvals-and-sandbox': true,
  '--dangerously-bypass-hook-trust': true, '--worktree': true, '--search': true, '--no-alt-screen': true, '--no-daemon': true, '--full-auto': true,
}
const claudeValueFlags: Record<string, true> = {
  '--model': true, '--agent': true, '--advisor': true, '--settings': true, '--setting-sources': true,
  '--permission-mode': true, '--output-format': true, '--input-format': true, '--effort': true,
  '--debug-file': true, '--session-id': true, '--plugin-dir': true, '--fallback-model': true,
}
const claudeBooleanFlags: Record<string, true> = {
  '--dangerously-skip-permissions': true, '--allow-dangerously-skip-permissions': true,
  '--verbose': true, '--debug': true, '--bare': true, '--strict-mcp-config': true, '--no-chrome': true,
}
const openCodeValueFlags: Record<string, true> = {
  '--log-level': true, '--model': true, '-m': true, '--agent': true, '--port': true, '--hostname': true,
  '--mdns-domain': true, '--cors': true, '--session': true, '-s': true,
}
const openCodeBooleanFlags: Record<string, true> = {
  '--print-logs': true, '--pure': true, '--continue': true, '-c': true, '--fork': true, '--auto': true, '--mdns': true,
}

// Inspect only the command position, never search arbitrary arguments for helper names.
// ps flattens argv, so unknown/value-ambiguous options stop classification conservatively.
function cliCommand(runtime: string, argumentsText: string): string | undefined {
  const tokens = argumentsText.match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []
  const valueFlags = runtime === 'OMP' ? ompValueFlags : runtime === 'Codex' ? codexValueFlags : runtime === 'Claude Code' ? claudeValueFlags : openCodeValueFlags
  const booleanFlags = runtime === 'OMP' ? ompBooleanFlags : runtime === 'Codex' ? codexBooleanFlags : runtime === 'Claude Code' ? claudeBooleanFlags : openCodeBooleanFlags
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') return undefined
    if (/^(?:--help|-h|--version|-v|-V)$/.test(token)) return '__help'
    if (!token.startsWith('-')) return token.replace(/^(["'])(.*)\1$/, '$2')
    if (runtime === 'OMP' && /^(?:-p|--print|--goal|-r|--resume|--restore|--system-prompt|--append-system-prompt|--system-prompt-template)(?:=|$)/.test(token)) return undefined
    if (runtime === 'Claude Code' && /^(?:-p|--print|-c|--continue|-r|--resume|--system-prompt|--append-system-prompt|--agents|--name|-n)(?:=|$)/.test(token)) return undefined
    if (runtime === 'OpenCode' && /^(?:--prompt)(?:=|$)/.test(token)) return undefined
    const equals = token.indexOf('=')
    const flag = equals < 0 ? token : token.slice(0, equals)
    if (valueFlags?.[flag] === true) {
      if (equals < 0) index++
      continue
    }
    if (token.length > 2 && !token.startsWith('--') && valueFlags?.[token.slice(0, 2)] === true) continue
    if (booleanFlags?.[token] === true) continue
    return undefined
  }
  return undefined
}

// Match the executable (or a known interpreter entry point), never prompt/shell substrings.
export function identifyRuntime(row: ProcessRow, includeCodexHosts = false): RuntimeMatch | undefined {
  const executable = row.executable
  const name = basename(executable)
  let runtime: string | undefined
  let wrapper = false
  if (name === 'omp' || /\/Tern\/omp\/versions\/\d+\.\d+\.\d+$/.test(executable)) runtime = 'OMP'
  else if (name === 'codex') runtime = 'Codex'
  else if (name === 'claude') runtime = 'Claude Code'
  else if (name === 'opencode') runtime = 'OpenCode'
  else if (/^(node|bun)(?:-\d+)?$/.test(name)) {
    // ps does not preserve argv quoting; accept only package-specific, anchored script paths.
    const entry = row.args.replace(/^\S+\s+/, '').match(/^(\S+)(?:\s|$)/)?.[1]
    if (entry && /\/@openai\/codex\/bin\/codex\.js$/.test(entry)) runtime = 'Codex'
    else if (entry && /\/@anthropic-ai\/claude-code\/cli\.js$/.test(entry)) runtime = 'Claude Code'
    else if (entry && /\/(?:opencode-ai\/bin\/opencode|@opencode-ai\/[^/]+\/bin\/opencode)$/.test(entry)) runtime = 'OpenCode'
    else if (entry && /\/@oh-my-pi\/pi-coding-agent\/(?:dist\/cli\.js|src\/cli\.ts)$/.test(entry)) runtime = 'OMP'
    wrapper = runtime !== undefined
  }
  if (!runtime) return undefined
  const argv0 = row.args.match(/^\S+/)?.[0] ?? ''
  if (runtime === 'OMP' && basename(argv0).startsWith('__omp_worker_')) return undefined
  let remainder = row.args.startsWith(executable) ? row.args.slice(executable.length).trim() : row.args.replace(/^\S+\s*/, '')
  if (wrapper) remainder = remainder.replace(/^\S+\s*/, '')
  const command = cliCommand(runtime, remainder)
  if (command === '__help') return undefined
  if (runtime === 'Codex' && command === 'app-server' && includeCodexHosts) return { runtime, wrapper, host: true }
  if (runtime === 'OMP' && command && (/^__omp_worker_/.test(command) || /^(?:agents|anonymize|auth|auth-broker|auth-gateway|bench|browser-relay|clip|collab|completions|compress|config|dry-balance|find|gallery|gc|git|grep|grievances|images|install|login|models|play|plugin|predict|ps|read|render|say|search|session|setup|share|shell|skill|stats|stream|tiny-models|token|toks|ttsr|update|usage|worktree|daemon|help)$/.test(command))) return undefined
  if (runtime === 'Codex' && command && /^(?:agents|app-server|exec-server|mcp-server|mcp|plugin|remote-control|app|login|logout|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|migrate-nfs-db|unarchive|cloud|features|help)$/.test(command)) return undefined
  if (runtime === 'Claude Code' && command && /^(?:mcp|daemon|gateway|remote-control|auth|doctor|update|install|plugin|plugins|setup-token|self-hosted-runner|agents|logs|stop|kill|rm|purge|auto-mode)$/.test(command)) return undefined
  if (runtime === 'OpenCode' && command && /^(?:serve|web|mcp|auth|completion|models|stats|export|import|upgrade|uninstall|agent|session)$/.test(command)) return undefined
  return { runtime, wrapper }
}

export function processAgents(rows: ProcessRow[], isAlive: (pid: number) => boolean, includeCodexHosts = false): AgentInfo[] {
  const matches = new Map(rows.flatMap(row => {
    const match = identifyRuntime(row, includeCodexHosts)
    return match && isAlive(row.pid) ? [[row.pid, { row, ...match }] as const] : []
  }))
  const aliases = new Map<number, number>()
  for (const [pid, match] of matches) {
    const parent = matches.get(match.row.ppid)
    if (parent?.wrapper && parent.runtime === match.runtime && !match.wrapper) aliases.set(parent.row.pid, pid)
  }
  const byPid = new Map(rows.map(row => [row.pid, row]))
  return [...matches.values()].filter(match => !aliases.has(match.row.pid)).map(({ row, runtime }) => {
    const visited = new Set([row.pid])
    let ancestor = row.ppid
    let parentId: string | undefined
    while (ancestor > 1 && !visited.has(ancestor)) {
      visited.add(ancestor)
      const canonical = aliases.get(ancestor) ?? ancestor
      if (canonical !== row.pid && matches.has(canonical)) { parentId = `process:${canonical}`; break }
      ancestor = byPid.get(ancestor)?.ppid ?? 0
    }
    return {
      id: `process:${row.pid}`, name: runtime, runtime, kind: parentId ? 'subagent' : 'main',
      state: 'running', pid: row.pid, parentId, cpuPercent: row.cpuPercent, memoryBytes: row.memoryBytes,
      source: 'macOS process table (executable + PID)',
    }
  })
}

export function parseOpenFiles(output: string): OpenFiles[] {
  const result: OpenFiles[] = []
  let row: OpenFiles | undefined
  let descriptor = ''
  let access = ''
  let ownership = 0
  for (let offset = 0; offset < output.length;) {
    const newline = output.indexOf('\n', offset)
    const end = newline < 0 ? output.length : newline
    // Reject before slicing a potentially huge field or allocating a line array.
    if (end - offset > COLLECTION_LIMITS.fieldBytes + 1) throw new CollectionLimitError('agent field bytes', COLLECTION_LIMITS.fieldBytes, end - offset - 1)
    const line = output.slice(offset, end)
    offset = end + 1
    const value = line.slice(1)
    checkField(value)
    if (line.startsWith('p')) {
      const pid = Number(value)
      row = Number.isSafeInteger(pid) && pid > 0 ? { pid, sessions: [], leases: [] } : undefined
      descriptor = ''
      access = ''
      if (row) { checkCount('ownership processes', result.length + 1); result.push(row) }
    } else if (line.startsWith('f')) { descriptor = value; access = '' }
    else if (line.startsWith('a')) access = value
    else if (line.startsWith('n') && row) {
      if (descriptor === 'cwd') row.cwd = text(value, 4096)
      else if (value.startsWith(`${ownersRoot}/`) && value.endsWith('.lock')) {
        const id = basename(value, '.lock')
        if (uuid.test(id)) { checkCount('ownership descriptors', ++ownership); row.leases.push(id) }
      } else if (value.startsWith(`${sessionRoot}/`) && value.endsWith('.jsonl') && !basename(value).startsWith('.')) {
        checkCount('ownership descriptors', ++ownership)
        row.sessions.push(value)
      } else if (/^\d+$/.test(descriptor) && (access === 'u' || access === 'w') && codexRolloutThreadId(value)) {
        checkCount('ownership descriptors', ++ownership)
        ;(row.codexSessions ??= []).push(value)
      }
    }
  }
  return result
}

// Only the current title slot, fixed header and initial model record are parsed.
export function parseSessionHeader(prefix: string, file: string): SessionMetadata | undefined {
  const lines = prefix.split('\n', 4)
  const titleSlot = lines[0].startsWith('{"type":"title",') ? object(JSON.parse(lines[0])) : undefined
  const title = titleSlot?.v === 1 ? text(titleSlot.title, 512)?.replace(/^\p{Co}\s*/u, '').trim() : undefined
  const summary = title && !/^omp$/i.test(title) ? title : undefined
  for (let index = 0; index < Math.min(2, lines.length); index++) {
    const line = lines[index]
    if (!line.startsWith('{"type":"session",')) continue
    const header = object(JSON.parse(line))
    if (!header || typeof header.id !== 'string' || !uuid.test(header.id)) return undefined
    checkField(header.timestamp)
    let model: string | undefined
    const next = lines[index + 1]
    if (next?.startsWith('{"type":"model_change",')) model = text(object(JSON.parse(next))?.model)
    return {
      sessionId: header.id, file, cwd: text(header.cwd, 4096), parentSession: text(header.parentSession, 4096),
      summary,
      startedAt: typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp)) ? header.timestamp : undefined,
      model,
    }
  }
  return undefined
}

export function ownedSessionAgents(processes: AgentInfo[], files: OpenFiles[], metadata: SessionMetadata[]): AgentInfo[] {
  const byFile = new Map(metadata.map(item => [resolve(item.file), item]))
  const result: AgentInfo[] = []
  const primarySessionByPid = new Map<number, string>()
  const ownedIds = new Set<string>()
  for (const descriptors of files) {
    for (const item of metadata) {
      if (descriptors.sessions.includes(item.file) && descriptors.leases.includes(item.sessionId)) ownedIds.add(item.sessionId)
    }
  }
  for (const processInfo of processes) {
    const descriptors = files.find(item => item.pid === processInfo.pid)
    const owned = descriptors ? metadata.filter(item => descriptors.sessions.includes(item.file) && descriptors.leases.includes(item.sessionId)) : []
    if (processInfo.runtime !== 'OMP' || !owned.length) {
      result.push({ ...processInfo, cwd: descriptors?.cwd })
      primarySessionByPid.set(processInfo.pid, processInfo.id)
      continue
    }
    for (const item of owned) {
      // runSubagent writes <parent artifact directory>/<agent id>.jsonl. Ordinary
      // fork/createBranchedSession also writes parentSession, but stays at the session root.
      const artifactParent = byFile.get(resolve(`${dirname(item.file)}.jsonl`))
      const explicitTaskPath = item.parentSession?.endsWith('.jsonl') === true
        && resolve(dirname(item.file)) === resolve(item.parentSession.slice(0, -6))
      const isTaskSession = artifactParent !== undefined || explicitTaskPath
      const sharedProcess = artifactParent !== undefined && owned.some(candidate => candidate.sessionId === artifactParent.sessionId)
      const parentSessionId = artifactParent?.sessionId
      const parentOwned = parentSessionId !== undefined && ownedIds.has(parentSessionId)
      if (!isTaskSession) primarySessionByPid.set(processInfo.pid, `omp:${item.sessionId}`)
      result.push({
        ...processInfo, id: `omp:${item.sessionId}`, sessionId: item.sessionId,
        name: isTaskSession ? text(basename(item.file, '.jsonl'), 160) ?? 'OMP subagent' : 'OMP',
        summary: item.summary,
        kind: isTaskSession ? 'subagent' : processInfo.kind,
        // A task ownership descriptor does not reveal whether its run has settled.
        state: isTaskSession ? 'unknown' : processInfo.state,
        parentId: isTaskSession && parentOwned ? `omp:${parentSessionId}` : processInfo.parentId,
        cwd: item.cwd ?? descriptors?.cwd, startedAt: item.startedAt, model: item.model,
        cpuPercent: sharedProcess ? undefined : processInfo.cpuPercent, memoryBytes: sharedProcess ? undefined : processInfo.memoryBytes,
        source: 'OMP open ownership/session descriptors + session header (initial model)',
      })
    }
  }
  // Preserve ancestry when an independently spawned OMP process gets session metadata.
  for (const item of result) if (item.parentId?.startsWith('process:')) item.parentId = primarySessionByPid.get(Number(item.parentId.slice(8))) ?? item.parentId
  return result
}

async function readMetadata<T>(path: string, limit: number, parse: (prefix: string) => T, signal?: AbortSignal, privateRecord = false): Promise<T> {
  return collectionResources.run({ source: 'agent-metadata', kind: 'file', bytes: limit, signal }, async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (privateRecord ? constants.O_NOFOLLOW : 0))
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= file.close().catch(error => { throw new ResourceCleanupError('file', error) })
    const abort = (): void => { void close().catch(() => { /* Awaited in finally. */ }) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(signal)
      const stat = await file.stat()
      if (!stat.isFile()) throw Object.assign(new Error('NOT_REGULAR_FILE'), { code: 'NOT_REGULAR_FILE' })
      if (privateRecord) {
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('unsafe host record permissions')
        if (stat.size > limit) throw new CollectionLimitError('host record bytes', limit, stat.size)
      }
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(limit)
      const { bytesRead } = await file.read(buffer, 0, limit, 0)
      throwIfAborted(signal)
      if (privateRecord && (await file.stat()).size > limit) throw new CollectionLimitError('host record bytes', limit, limit + 1)
      return parse(buffer.toString('utf8', 0, bytesRead))
    } finally {
      signal?.removeEventListener('abort', abort)
      await close()
      throwIfAborted(signal)
    }
  })
}

async function readProcesses(signal?: AbortSignal): Promise<ProcessRow[]> {
  const { stdout } = await runBudgetedCommand('agent-processes', '/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, signal)
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]), memoryBytes: Number(match[4]) * 1024, executable: match[5], args: '' })
  }
  if (!rows.length) throw new Error('无法解析 macOS 进程表')
  const candidates = rows.filter(row => identifyRuntime(row, true) || /^(node|bun)(?:-\d+)?$/.test(basename(row.executable)))
  if (candidates.length) {
    const { stdout: args } = await runBudgetedCommand('agent-processes', '/bin/ps', ['-ww', '-p', candidates.map(row => row.pid).join(','), '-o', 'pid=,args='], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }, signal)
    const byPid = new Map(candidates.map(row => [row.pid, row]))
    for (const line of args.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      const row = match ? byPid.get(Number(match[1])) : undefined
      if (row && match) row.args = match[2]
    }
  }
  return rows
}

interface CollabHost { pid: number; endpoint: string; token: string }
export async function socketSnapshot(host: CollabHost, signal?: AbortSignal): Promise<Record<string, unknown>> {
  checkField(host.endpoint)
  checkField(host.token)
  const limit = COLLECTION_LIMITS.projectionBytes
  return collectionResources.run({ source: 'agent-collab', kind: 'socket', bytes: limit, signal }, () => new Promise<Record<string, unknown>>((accept, reject) => {
    const socket = createConnection(host.endpoint)
    const decoder = new StringDecoder('utf8')
    let data = ''
    let bytes = 0
    let done = false
    let failure: Error | undefined
    let closeFailure: ResourceCleanupError | undefined
    let result: Record<string, unknown> | undefined
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      if (done) return
      done = true
      failure = error
      result = value
      clearTimeout(timer)
      socket.destroy()
    }
    const abort = (): void => {
      try { throwIfAborted(signal) } catch (error) { finish(error as Error) }
    }
    const timer = setTimeout(() => finish(new Error('socket timeout')), 500)
    socket.on('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (closeFailure) { reject(closeFailure); return }
      if (failure && !isResourceAbort(failure)) { reject(failure); return }
      try { throwIfAborted(signal) } catch (error) { reject(error); return }
      if (failure) reject(failure)
      else if (result) accept(result)
      else reject(new Error('socket closed without response'))
    })
    socket.on('connect', () => {
      if (!done) socket.write(`${JSON.stringify({ v: 1, token: host.token, op: 'snapshot' })}\n`)
    })
    socket.on('error', error => {
      if (done) closeFailure = new ResourceCleanupError('socket', error)
      else finish(error)
    })
    socket.on('end', () => finish(new Error('socket closed without response')))
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      if (chunk.length > limit - bytes) { finish(new Error('socket response too large')); return }
      bytes += chunk.length
      data += decoder.write(chunk)
      const end = data.indexOf('\n')
      if (end < 0) return
      try {
        const response = object(JSON.parse(data.slice(0, end)))
        const snapshot = object(response?.snapshot)
        if (response?.ok !== true || response.v !== 1 || !snapshot || snapshot.pid !== host.pid) throw new Error('invalid socket response')
        finish(undefined, snapshot)
      } catch { finish(new Error('invalid socket response')) }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  }))
}

export async function enrichCollab(agents: AgentInfo[], signal?: AbortSignal, directory = join(ompRoot, 'run', 'collab-hosts')): Promise<SourceStatus> {
  let names: string[]
  try {
    await collectionResources.run({ source: 'agent-collab', kind: 'file', bytes: 0, signal }, async () => {
      const stat = await lstat(directory)
      throwIfAborted(signal)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('unsafe registry permissions')
    })
    names = await new DirectoryScan().read(directory, 'agent-collab', signal, name => /^[a-z0-9-]+\.json$/.test(name))
  } catch (error) {
    if (isResourceCleanupFailure(error)) throw error
    throwIfAborted(signal)
    return { id: 'omp-socket', label: 'OMP 本地 socket', state: errorCode(error) === 'ENOENT' ? 'empty' : errorCode(error) === 'OC_COLLECTION_LIMIT' ? 'partial' : 'error', detail: errorCode(error) === 'ENOENT' ? '未启用 Collab host；当前版本不公开进程内 AgentRegistry 查询 socket。' : `无法读取私有 host registry（${errorCode(error)}）。${errorCode(error) === 'OC_COLLECTION_LIMIT' ? '目录条目超过 4096 个（包含非 JSON）；本轮未连接任何 host。' : ''}` }
  }
  let succeeded = 0
  let failed = 0
  let limited = 0
  const reads = await Promise.allSettled(names.slice(0, 32).map(async name => {
    try {
      const record = await readMetadata(join(directory, name), COLLECTION_LIMITS.fieldBytes, prefix => object(JSON.parse(prefix)), signal, true)
      if (!record || record.version !== 1 || !Number.isSafeInteger(record.pid) || typeof record.pid !== 'number' || record.pid <= 0 || !text(record.endpoint, 4096)?.startsWith('/') || !text(record.token, 4096)) throw new Error('invalid host record')
      // Only contact sockets already owned by a positively identified live OMP process.
      if (!agents.some(agent => agent.runtime === 'OMP' && agent.pid === record.pid) || !alive(record.pid)) return
      const snapshot = await socketSnapshot(record as unknown as CollabHost, signal)
      const agent = agents.find(item => item.pid === snapshot.pid && item.kind === 'main' && (!item.sessionId || item.sessionId === snapshot.sessionId))
      if (!agent) return
      const sessionName = text(snapshot.sessionName, 160)
      const cwd = text(snapshot.cwd, 4096)
      const model = object(snapshot.model)
      const provider = text(model?.provider)
      const modelId = text(model?.id)
      checkField(snapshot.sessionId)
      agent.name = sessionName ?? agent.name
      agent.cwd = cwd ?? agent.cwd
      if (provider && modelId) agent.model = `${provider}/${modelId}`
      if (typeof snapshot.busy === 'boolean') agent.state = snapshot.busy ? 'working' : 'idle'
      agent.source = 'OMP authenticated local socket snapshot'
      succeeded++
    } catch (error) {
      if (isResourceCleanupFailure(error) || signal?.aborted) throw error
      failed++
      if (errorCode(error) === 'OC_COLLECTION_LIMIT') limited++
    }
  }))
  const failures = reads.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) {
    if (failures.every(isResourceAbort)) throw resourceAbortError()
    throw new AggregateError(failures, 'Collab 读取失败 / Collab read failed')
  }
  throwIfAborted(signal)
  return { id: 'omp-socket', label: 'OMP 本地 socket', state: failed || names.length > 32 ? 'partial' : succeeded ? 'ok' : 'empty', detail: `读取 ${succeeded} 个活跃 host；${failed} 个读取失败。socket 仅提供主会话元数据，不公开子代理 roster。${names.length > 32 ? '本轮限制最多 32 个 host。' : ''}${limited ? ` ${limited} 个 host 超过元数据上限（OC_COLLECTION_LIMIT），本轮读取不完整。` : ''}` }
}

export function applyTernSnapshot(agents: AgentInfo[], metadata: SessionMetadata[], snapshot: unknown, windowKey: string): number {
  const panes = object(snapshot)?.panes
  if (!Array.isArray(panes)) throw new Error('invalid Tern inspect protocol')
  checkCount('Tern panes', panes.length)
  checkField(windowKey)
  const byFile = new Map(metadata.map(item => [item.file, item.sessionId]))
  let matched = 0
  for (const value of panes) {
    const pane = object(value)
    if (!pane || pane.exited != null || typeof pane.working !== 'boolean' || typeof pane.omp_session_file !== 'string') continue
    checkField(pane.omp_session_file)
    const id = byFile.get(pane.omp_session_file)
    if (!id) continue
    const agent = agents.find(item => item.sessionId === id && item.runtime === 'OMP' && item.kind === 'main')
    if (!agent) continue
    agent.state = pane.working ? 'working' : 'idle'
    agent.source = 'Tern pane working state + OMP ownership/session descriptors'
    if (typeof pane.pane === 'number' && Number.isSafeInteger(pane.pane) && pane.pane > 0) {
      agent.tern = { windowKey, paneId: pane.pane, sessionFile: pane.omp_session_file }
    }
    matched++
  }
  return matched
}

export async function collectTernWindows(agents: AgentInfo[], metadata: SessionMetadata[], snapshot: unknown, inspectWindow: (key: string) => Promise<unknown>, signal?: AbortSignal): Promise<SourceStatus> {
  const clients = object(snapshot)?.clients
  if (!Array.isArray(clients)) throw new Error('invalid Tern clients protocol')
  checkCount('Tern clients', clients.length)
  const keys = new Set<string>()
  let invalid = 0
  for (const value of clients) {
    const client = object(value)
    if (client?.kind !== 'window') continue
    if (typeof client.window !== 'string' || client.window.length > 128 || /[\x00-\x1f\x7f]/.test(client.window)) { invalid++; continue }
    keys.add(client.window)
  }
  const windows = [...keys].slice(0, 16)
  const failed: string[] = []
  let matched = 0
  let cursor = 0
  await settleResourceWork(Array.from({ length: Math.min(4, windows.length) }, async () => {
    while (cursor < windows.length) {
      throwIfAborted(signal)
      const key = windows[cursor++]
      try { matched += applyTernSnapshot(agents, metadata, await inspectWindow(key), key) }
      catch (error) {
        if (isResourceCleanupFailure(error) || signal?.aborted) throw error
        failed.push(key || '首窗')
      }
    }
  }))
  return {
    id: 'tern-state', label: 'Tern 主代理状态',
    state: failed.length || invalid || keys.size > windows.length || !matched ? 'partial' : 'ok',
    detail: `枚举 ${keys.size} 个 Tern 窗口，读取 ${windows.length - failed.length} 个，按精确 session 关联 ${matched} 个主代理 working/idle；不提供子代理生命周期。${failed.length ? ` 窗口读取失败：${failed.join('、')}。` : ''}${invalid ? ` ${invalid} 个窗口 key 格式无效。` : ''}${keys.size > 16 ? ' 本轮最多 16 个窗口、并发 4。' : ''}`,
  }
}

async function enrichTern(agents: AgentInfo[], metadata: SessionMetadata[], rows: ProcessRow[], signal?: AbortSignal): Promise<SourceStatus> {
  const tern = rows.find(row => row.executable.endsWith('/Tern.app/Contents/MacOS/tern'))
  if (!tern) return { id: 'tern-state', label: 'Tern 主代理状态', state: 'empty', detail: '未发现 Tern 宿主进程；保留 CLI 进程活性状态。' }
  try {
    const { stdout } = await runBudgetedCommand('agent-tern', tern.executable, ['inspect', '--json'], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }, signal)
    return await collectTernWindows(agents, metadata, JSON.parse(stdout), async key => {
      const { stdout: window } = await runBudgetedCommand('agent-tern', tern.executable, ['inspect', '--json', '--window', key], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }, signal)
      return JSON.parse(window)
    }, signal)
  } catch (error) {
    if (isResourceCleanupFailure(error) || signal?.aborted) throw error
    return { id: 'tern-state', label: 'Tern 主代理状态', state: 'error', detail: `Tern inspect 不可用（${errorCode(error)}）；保留 PID 活性，不猜测忙闲。` }
  }
}

export async function enrichSessionActivity(agents: AgentInfo[], metadata: SessionMetadata[], reader = new SessionActivityReader(), now?: number, signal?: AbortSignal): Promise<SourceStatus> {
  const bySession = new Map(metadata.map(item => [item.sessionId, item.file]))
  const owned = agents.filter(agent => agent.runtime === 'OMP' && agent.sessionId && bySession.has(agent.sessionId)).slice(0, 128)
  reader.retain(new Set(owned.map(agent => bySession.get(agent.sessionId!)!)))
  let observed = 0
  let incomplete = 0
  const issues = new Set<string>()
  for (const agent of agents) delete agent.activity
  for (const agent of owned) {
    const result = await reader.read(bySession.get(agent.sessionId!)!, now, signal)
    if (result.activity) { agent.activity = result.activity; observed++ }
    if (result.issues.length) incomplete++
    for (const issue of result.issues) issues.add(issue)
  }
  const unsupported = agents.length - owned.length
  return {
    id: 'agent-activity', label: '近期调用元数据',
    state: incomplete || unsupported ? 'partial' : owned.length ? 'ok' : 'unsupported',
    detail: `读取 ${owned.length} 个当前持有 session/lease 的 OMP 会话，${observed} 个有最近 6 秒调用证据；每文件增量或尾部最多 128 KiB，最多 128 个会话。完成/取消/错误清除，不将最终回复算作调用，不改变忙闲或未知状态，不推算子代理活动数量。${incomplete ? ` ${incomplete} 个会话读取不完整：${[...issues].join('；')}。` : ''}${unsupported ? ` ${unsupported} 个进程缺少支持的当前会话调用来源。` : ''} 长推理尚未落盘与超出 6 秒的调用不会持续亮起。`,
  }
}

export interface AgentDiscovery { snapshot: AgentSnapshot; sessions: SessionMetadata[] }

export async function discoverAgents(signal?: AbortSignal): Promise<AgentDiscovery> {
  if (process.platform !== 'darwin') throw new Error('Agent 采集器仅支持 macOS')
  const rows = await readProcesses(signal)
  let agents = processAgents(rows, alive, true)
  const codexHosts = new Set(rows.filter(row => identifyRuntime(row, true)?.host).map(row => row.pid))
  let openFiles: OpenFiles[] = []
  let metadataReads = 0
  let ownershipError: string | undefined
  const metadata: SessionMetadata[] = []
  const sources: SourceStatus[] = [{ id: 'processes', label: '本机 CLI 进程', state: agents.length ? 'ok' : 'empty', detail: '按可执行文件和已知 CLI 入口识别 OMP、Codex、Claude Code、OpenCode；检查 PID 活性并合并 wrapper/native。进程存在不代表正在推理。' }]
  if (agents.length) {
    try {
      const { stdout } = await runBudgetedCommand('agent-ownership', '/usr/sbin/lsof', ['-nP', '-a', '-p', agents.map(agent => agent.pid).join(','), '-F', 'pfan'], { timeout: 1800, maxBuffer: 4 * 1024 * 1024 }, signal)
      const files = parseOpenFiles(stdout)
      openFiles = files
      const paths = [...new Set(files.flatMap(item => item.sessions))]
      let unreadable = 0
      // Bounded by live descriptors; no readdir or recursive scan of saved sessions.
      for (const path of paths.slice(0, 128)) {
        metadataReads++
        try {
          const item = await readMetadata(path, maxMetadata, prefix => parseSessionHeader(prefix, path), signal)
          if (item) metadata.push(item)
          else unreadable++
        } catch (error) { if (isResourceCleanupFailure(error) || signal?.aborted) throw error; unreadable++ }
      }
      const ownershipCount = new Set(files.flatMap(item => item.leases)).size
      agents = ownedSessionAgents(agents, files, metadata)
      sources.push({ id: 'omp-ownership', label: 'OMP 主代理与子代理', state: 'partial', detail: `观察到 ${ownershipCount} 个 ownership 描述符；同进程 task 以父会话的专用 artifacts 目录识别，普通 fork 的 parentSession 不代表子代理；独立进程保留已确认祖先关系。OMP keepAlive 会保留已完成子代理，直到 park 才释放 lease，因此这些 task 显示未知，不计作活动；当前版本无独立可查询的实时子代理状态。模型为头部初始模型，可能已切换。${unreadable ? ` ${unreadable} 个头部无法解析。` : ''}${paths.length > 128 ? ' 本轮最多读取 128 个打开文件的头部。' : ''} 每轮有界 ps/lsof，不启动 OMP CLI、不扫描历史目录；仅当前持有 session/lease 的会话读取有界调用元数据。macOS lsof 不报告此 flock 是否持有。自定义 session 目录/隔离 profile 未覆盖。` })
    } catch (error) {
      if (isResourceCleanupFailure(error) || signal?.aborted) throw error
      ownershipError = errorCode(error)
      sources.push({ id: 'omp-ownership', label: 'OMP 主代理与子代理', state: 'error', detail: `打开文件/会话 lease 读取失败（${errorCode(error)}）；仅保留已确认进程，不推断子代理。` })
    }
  } else sources.push({ id: 'omp-ownership', label: 'OMP 主代理与子代理', state: 'empty', detail: '当前未识别到活跃 CLI 进程；没有扫描保存的历史会话。' })
  const codex = await collectCodexSessions(agents, openFiles, codexHosts, signal, 128 - metadataReads)
  agents = codex.agents
  sources.push(ownershipError ? { id: 'codex-sessions', label: 'Codex 主代理与子代理', state: 'error',
    detail: `打开文件读取失败（${ownershipError}）；无法确认 Codex 会话归属。` } : codex.source)
  sources.push(await enrichTern(agents, metadata, rows, signal))
  sources.push(await enrichCollab(agents, signal))
  // Processes may have exited while reading metadata; a stale registry must not revive them.
  agents = agents.filter(agent => alive(agent.pid))
  const owned = new Set(agents.flatMap(agent => agent.sessionId ? [agent.sessionId] : []))
  return {
    snapshot: { collectedAt: new Date().toISOString(), agents, sources, activeSubagentCount: agents.length ? null : 0 },
    sessions: metadata.filter(item => owned.has(item.sessionId)).slice(0, 128),
  }
}

export async function collectAgents(signal?: AbortSignal): Promise<AgentSnapshot> {
  const { snapshot, sessions } = await discoverAgents(signal)
  snapshot.sources.push(await enrichSessionActivity(snapshot.agents, sessions, undefined, undefined, signal))
  return snapshot
}
