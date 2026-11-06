import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { AgentActivity } from '../../shared/types'
import { AGENT_ACTIVITY_WINDOW_MS } from '../../shared/types'
import { collectionResources, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from '../resource-budget'

const maxTailBytes = 128 * 1024
const maxCalls = 32

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w./:|\-]{1,160}$/.test(value) ? value : undefined
}
function timestamp(value: unknown): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

export interface ActivityState {
  calls: Map<string, AgentActivity>
  model?: AgentActivity
}
export function createActivityState(): ActivityState { return { calls: new Map() } }
function clear(state: ActivityState): void { state.calls.clear(); delete state.model }

// Persist only this whitelist. Message text, tool arguments, results and provider payloads
// are neither retained in the cache nor returned to the renderer.
export function consumeActivityRecord(state: ActivityState, value: unknown, now: number): 'ok' | 'invalid' | 'unsupported' {
  const record = object(value)
  if (!record || typeof record.type !== 'string') { clear(state); return 'invalid' }
  const message = object(record.message)
  const data = object(record.data)
  const assistant = record.type === 'message' && message?.role === 'assistant'
  if (assistant && ['stop', 'length', 'abort', 'aborted', 'error'].includes(String(message.stopReason))) {
    clear(state)
    return 'ok'
  }
  if (record.type === 'message' && message?.role === 'user') { clear(state); return 'ok' }
  const start = record.type === 'custom' && record.customType === 'tool_execution_start'
  const result = record.type === 'message' && message?.role === 'toolResult'
  if (!start && !result && !assistant) return 'ok'
  const observed = timestamp(record.timestamp)
  if (observed === undefined || observed > now) { clear(state); return 'invalid' }
  if (result) {
    const id = identifier(message?.toolCallId)
    if (!id) { clear(state); return 'invalid' }
    state.calls.delete(id)
    delete state.model
    return 'ok'
  }
  if (assistant && message?.stopReason !== 'toolUse') { clear(state); return 'unsupported' }
  if (now - observed >= AGENT_ACTIVITY_WINDOW_MS) return 'ok'
  const observedAt = new Date(observed).toISOString()
  if (start) {
    const id = identifier(data?.toolCallId)
    const name = identifier(data?.toolName)
    if (!id || !name) { clear(state); return 'invalid' }
    if (state.calls.size >= maxCalls && !state.calls.has(id)) { clear(state); return 'unsupported' }
    delete state.model
    state.calls.set(id, { kind: 'tool', name, observedAt })
  } else {
    // A persisted toolUse assistant event proves a recent model response, not a
    // currently streaming request. Final assistant replies above never animate.
    state.model = { kind: 'model', observedAt }
  }
  return 'ok'
}

export function recentActivity(state: ActivityState, now: number): AgentActivity | undefined {
  let latest = state.model
  if (latest && (now - Date.parse(latest.observedAt) >= AGENT_ACTIVITY_WINDOW_MS || Date.parse(latest.observedAt) > now)) delete state.model
  latest = state.model
  for (const [id, activity] of state.calls) {
    const age = now - Date.parse(activity.observedAt)
    if (age < 0 || age >= AGENT_ACTIVITY_WINDOW_MS) state.calls.delete(id)
    else if (!latest || activity.observedAt >= latest.observedAt) latest = activity
  }
  return latest
}

interface CacheEntry {
  inode: number
  device: number
  offset: number
  size: number
  modified: number
  state: ActivityState
  issues: string[]
}
export interface ActivityRead { activity?: AgentActivity; issues: string[]; bytesRead: number }

export class SessionActivityReader {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Set<AbortController>>()

  retain(paths: Set<string>): void {
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path)
    for (const [path, controllers] of this.inFlight) {
      if (!paths.has(path)) for (const controller of controllers) controller.abort()
    }
  }

  async read(path: string, now?: number, signal?: AbortSignal): Promise<ActivityRead> {
    const controller = new AbortController()
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let controllers = this.inFlight.get(path)
    if (!controllers) { controllers = new Set(); this.inFlight.set(path, controllers) }
    controllers.add(controller)
    try {
      const result = await collectionResources.run({ source: 'agent-activity', kind: 'file', bytes: maxTailBytes, signal: operationSignal }, () => this.readFile(path, now, operationSignal))
      throwIfAborted(operationSignal)
      return result
    } catch (error) {
      this.cache.delete(path)
      if (isResourceCleanupFailure(error)) throw error
      throwIfAborted(operationSignal)
      const code = object(error)?.code
      return { issues: [`会话读取失败（${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'READ_FAILED'}）`], bytesRead: 0 }
    } finally {
      controllers.delete(controller)
      if (!controllers.size) this.inFlight.delete(path)
    }
  }

  private async readFile(path: string, now: number | undefined, signal: AbortSignal): Promise<ActivityRead> {
    const file: FileHandle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= file.close()
    const abort = (): void => { void close().catch(() => { /* Awaited in finally. */ }) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      throwIfAborted(signal)
      const stat = await file.stat()
      throwIfAborted(signal)
      if (!stat.isFile()) throw Object.assign(new Error('NOT_REGULAR_FILE'), { code: 'NOT_REGULAR_FILE' })
      let entry = this.cache.get(path)
      const reset = entry && (entry.inode !== stat.ino || entry.device !== stat.dev || stat.size < entry.size || (stat.size === entry.size && stat.mtimeMs !== entry.modified))
      if (!entry || reset) {
        entry = { inode: stat.ino, device: stat.dev, offset: 0, size: 0, modified: 0, state: createActivityState(), issues: reset ? ['文件被截断或替换'] : [] }
        this.cache.set(path, entry)
      }
      if (stat.size === entry.size && stat.mtimeMs === entry.modified) {
        return { activity: entry.issues.some(issue => issue !== '尾部窗口之前的记录未读取') ? undefined : recentActivity(entry.state, now ?? Date.now()), issues: [...entry.issues], bytesRead: 0 }
      }
      const start = Math.max(entry.offset, stat.size - maxTailBytes)
      const omitted = start > entry.offset
      if (omitted) clear(entry.state)
      const allocated = Buffer.allocUnsafe(stat.size - start)
      const { bytesRead } = await file.read(allocated, 0, allocated.length, start)
      throwIfAborted(signal)
      // Calls can be appended while this file or an earlier session is being read.
      now ??= Date.now()
      const buffer = allocated.subarray(0, bytesRead)
      const issues = reset ? ['文件被截断或替换'] : []
      if (omitted) issues.push('尾部窗口之前的记录未读取')
      if (bytesRead !== allocated.length) issues.push('读取期间文件发生截断')
      const end = buffer.lastIndexOf(10, bytesRead - 1)
      let begin = 0
      if (omitted) {
        const first = buffer.indexOf(10)
        begin = first < 0 ? bytesRead : first + 1
      }
      if (end < bytesRead - 1 || (bytesRead > 0 && end < 0)) issues.push('尾部记录尚未完整或超过读取上限')
      for (let cursor = begin; cursor <= end;) {
        const next = buffer.indexOf(10, cursor)
        if (next < 0 || next > end) break
        const line = buffer.toString('utf8', cursor, next)
        cursor = next + 1
        if (!line || line.startsWith('# ')) continue
        try {
          const result = consumeActivityRecord(entry.state, JSON.parse(line), now)
          if (result !== 'ok') issues.push(result === 'invalid' ? '调用记录格式无效' : '调用事件格式不支持')
        } catch { clear(entry.state); issues.push('JSONL 记录损坏') }
      }
      entry.offset = end >= 0 ? start + end + 1 : start
      entry.size = stat.size
      entry.modified = stat.mtimeMs
      // Omitted earlier history alone does not invalidate a complete recent event.
      // Any unread trailing fragment or damaged event might hide a terminal record.
      const unsafe = issues.some(issue => issue !== '尾部窗口之前的记录未读取')
      if (unsafe) clear(entry.state)
      entry.issues = [...new Set(issues)]
      return { activity: unsafe ? undefined : recentActivity(entry.state, now), issues: entry.issues, bytesRead }
    } finally {
      signal.removeEventListener('abort', abort)
      try { await close() }
      catch (error) { throw new ResourceCleanupError('file', error) }
    }
  }
}
