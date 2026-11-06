import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { AgentInfo, SourceStatus } from '../../shared/types'
import type { OpenFiles } from './agents'
import { COLLECTION_LIMITS, CollectionLimitError } from '../collection-limits'
import { collectionResources, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from '../resource-budget'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const identifier = new RegExp(`^${uuid}$`, 'i')
const rolloutPath = new RegExp(`/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_${uuid})?\\.jsonl$`, 'i')
const maxHeaderBytes = 1024 * 1024
const maxSessions = 128

interface CodexSession {
  file: string
  sessionId: string
  parentSessionId?: string
  subagent: boolean
  name?: string
  cwd?: string
  startedAt?: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function field(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const bytes = Buffer.byteLength(value)
  if (bytes > COLLECTION_LIMITS.fieldBytes) throw new CollectionLimitError('Codex metadata field bytes', COLLECTION_LIMITS.fieldBytes, bytes)
  if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw Object.assign(new Error('Invalid Codex metadata field'), { code: 'INVALID_METADATA' })
  return value
}
function failureCode(error: unknown): string {
  const code = object(error)?.code
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : error instanceof SyntaxError ? 'INVALID_JSON' : 'READ_FAILED'
}

/** Paths come from live Codex descriptors, including a custom CODEX_HOME. */
export function codexRolloutThreadId(path: string): string | undefined {
  return path.startsWith('/') ? rolloutPath.exec(path)?.[1].toLowerCase() : undefined
}

export function parseCodexSessionHeader(line: string, file: string): CodexSession {
  const record = object(JSON.parse(line))
  const payload = object(record?.payload)
  const id = field(payload?.id, 36)
  if (record?.type !== 'session_meta' || !id || !identifier.test(id) || id.toLowerCase() !== codexRolloutThreadId(file)) {
    throw Object.assign(new Error('Invalid Codex session identity'), { code: 'INVALID_METADATA' })
  }
  const subagent = object(payload?.source)?.subagent
  const spawn = object(object(subagent)?.thread_spawn)
  const parent = field(spawn?.parent_thread_id, 36)
  if (spawn && (!parent || !identifier.test(parent))) throw Object.assign(new Error('Invalid Codex parent identity'), { code: 'INVALID_METADATA' })
  const nickname = field(payload?.agent_nickname ?? spawn?.agent_nickname, 160)
  const role = field(payload?.agent_role ?? spawn?.agent_role, 160)
  const startedAt = field(payload?.timestamp, 64)
  // Do not export base_instructions, tools, messages, root session_id or forked_from_id.
  return {
    file, sessionId: id.toLowerCase(), parentSessionId: parent?.toLowerCase(), subagent: subagent !== undefined,
    name: nickname ?? role, cwd: field(payload?.cwd, 4096),
    startedAt: startedAt && Number.isFinite(Date.parse(startedAt)) ? startedAt : undefined,
  }
}

/** Read only a complete first record, with a byte ceiling before allocating/parsing. */
export async function readCodexSessionHeader(path: string, signal?: AbortSignal): Promise<CodexSession> {
  return collectionResources.run({ source: 'agent-metadata', kind: 'file', bytes: maxHeaderBytes, signal }, async () => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= handle.close().catch(error => { throw new ResourceCleanupError('file', error) })
    const abort = (): void => { void close().catch(() => { /* Awaited in finally. */ }) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(signal)
      const stat = await handle.stat()
      if (!stat.isFile()) throw Object.assign(new Error('Not a regular rollout file'), { code: 'NOT_REGULAR_FILE' })
      const buffer = Buffer.allocUnsafe(Math.min(stat.size, maxHeaderBytes))
      let used = 0
      while (used < buffer.length) {
        throwIfAborted(signal)
        const { bytesRead } = await handle.read(buffer, used, Math.min(16 * 1024, buffer.length - used), used)
        throwIfAborted(signal)
        if (!bytesRead) break
        const end = buffer.subarray(used, used + bytesRead).indexOf(10)
        if (end >= 0) return parseCodexSessionHeader(buffer.toString('utf8', 0, used + end), path)
        used += bytesRead
      }
      if (used === maxHeaderBytes) throw new CollectionLimitError('Codex session header bytes', maxHeaderBytes, maxHeaderBytes + 1)
      throw Object.assign(new Error('Incomplete Codex session header'), { code: 'INCOMPLETE_HEADER' })
    } finally {
      signal?.removeEventListener('abort', abort)
      await close()
      throwIfAborted(signal)
    }
  })
}

export async function collectCodexSessions(processes: AgentInfo[], files: OpenFiles[], hosts: ReadonlySet<number>,
  signal?: AbortSignal, available = maxSessions): Promise<{ agents: AgentInfo[]; source: SourceStatus }> {
  const codex = new Map(processes.filter(agent => agent.runtime === 'Codex').map(agent => [agent.pid, agent]))
  const owners = new Map<string, Set<number>>()
  for (const descriptors of files) {
    if (!codex.has(descriptors.pid)) continue
    for (const file of descriptors.codexSessions ?? []) {
      let pids = owners.get(file)
      if (!pids) { pids = new Set(); owners.set(file, pids) }
      pids.add(descriptors.pid)
    }
  }
  const sessions = new Map<string, { session: CodexSession; pid: number }>()
  const ambiguous = new Set<string>()
  const issues = new Set<string>()
  let attempted = 0
  const limit = Math.min(maxSessions, Math.max(0, available))
  for (const [file, pids] of owners) {
    if (attempted >= limit) { issues.add('SESSION_LIMIT'); break }
    attempted++
    if (pids.size !== 1) { issues.add('AMBIGUOUS_OWNER'); continue }
    try {
      const session = await readCodexSessionHeader(file, signal)
      if (sessions.has(session.sessionId) || ambiguous.has(session.sessionId)) {
        sessions.delete(session.sessionId)
        ambiguous.add(session.sessionId)
        issues.add('AMBIGUOUS_SESSION')
      } else sessions.set(session.sessionId, { session, pid: pids.values().next().value! })
    } catch (error) {
      if (isResourceCleanupFailure(error) || signal?.aborted) throw error
      issues.add(failureCode(error))
    }
  }
  throwIfAborted(signal)
  const byPid = new Map<number, CodexSession[]>()
  for (const { session, pid } of sessions.values()) {
    const items = byPid.get(pid)
    if (items) items.push(session)
    else byPid.set(pid, [session])
  }
  const primaryIds = new Map<string, string>()
  const agents: AgentInfo[] = []
  for (const processInfo of processes) {
    const owned = byPid.get(processInfo.pid)
    if (processInfo.runtime !== 'Codex' || !owned?.length) {
      if (!hosts.has(processInfo.pid)) agents.push(processInfo)
      continue
    }
    const roots = owned.filter(session => !session.subagent)
    const primary = roots.length === 1 ? roots[0] : owned.length === 1 ? owned[0] : undefined
    if (primary) primaryIds.set(processInfo.id, `codex:${primary.sessionId}`)
    for (const session of owned) {
      const hasResources = session === primary
      agents.push({
        ...processInfo, id: `codex:${session.sessionId}`, sessionId: session.sessionId,
        name: session.name ?? (session.subagent ? 'Codex subagent' : 'Codex'),
        kind: session.subagent ? 'subagent' : processInfo.kind,
        parentId: session.subagent ? session.parentSessionId && `codex:${session.parentSessionId}` : processInfo.parentId,
        state: session.subagent || hosts.has(processInfo.pid) ? 'unknown' : processInfo.state,
        cwd: session.cwd ?? processInfo.cwd, startedAt: session.startedAt,
        cpuPercent: hasResources ? processInfo.cpuPercent : undefined,
        memoryBytes: hasResources ? processInfo.memoryBytes : undefined,
        source: 'Codex live writable rollout descriptor + session_meta',
      })
    }
  }
  for (const agent of agents) if (agent.parentId && primaryIds.has(agent.parentId)) agent.parentId = primaryIds.get(agent.parentId)
  return {
    agents,
    source: {
      id: 'codex-sessions', label: 'Codex 主代理与子代理',
      state: issues.size ? 'partial' : sessions.size ? 'ok' : 'empty',
      detail: `关联 ${sessions.size} 个 Codex 会话；观察到 ${owners.size} 个可写 rollout 文件。仅使用存活 CLI 或 app-server 当前持有的会话，按明确父线程 ID 关联子代理；普通 fork 不建立父子关系。不扫描历史目录，不解析会话正文。会话驻留不证明正在工作，子代理与桌面会话的忙闲保持未知；共享进程资源不重复计算。OMP 与 Codex 每轮合计最多 128 个会话头部，Codex 每个头部最多 1 MiB。${issues.size ? ` 本轮读取不完整：${[...issues].join('、')}。` : ''}`,
    },
  }
}
