import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DiagnosticError, type DiagnosticCode } from '../shared/diagnostics'
import type { AgentInfo, TernTarget } from '../shared/types'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from './resource-budget'
import { runBudgetedCommand, sameFileIdentity } from './resource-io'

const source = 'tern-navigation'
const maxAgents = 10_000
const helperBytes = 64 * 1024
const inspectBytes = 2 * 1024 * 1024
const pluginBytes = 256 * 1024
const resourceBytes = 16 * 1024
const pluginId = 'oc-chan-navigation'
const pluginDigests = {
  'plugin.toml': '16030fddd13a4f54268e99d2dd237f279ae9aac6fd02f451dd7a2360c822dc34',
  'window.luau': 'ba0282155dad6f64da69bc4afdab6b5de3afca509c79bb1c1a5cb01190079fde',
} as const
const helperCodes: Record<TernCode, true> = {
  OC_TERN_UNAVAILABLE: true, OC_TERN_IDENTITY: true, OC_TERN_AMBIGUOUS: true, OC_TERN_TARGET: true,
  OC_TERN_PROTOCOL: true, OC_TERN_RESOURCES: true, OC_TERN_PLUGIN: true, OC_TERN_BUSY: true, OC_TERN_CLOSED: true,
  OC_TERN_TIMEOUT: true, OC_TERN_COMMAND: true, OC_TERN_ACCESSIBILITY: true, OC_TERN_ACTIVATION: true, OC_TERN_WINDOW: true,
}
type TernCode = Extract<DiagnosticCode, `OC_TERN_${string}`>
export type NavigationCommand = (file: string, args: readonly string[], signal: AbortSignal) => Promise<string>
interface TernIdentity { pid: number; executable: string; bundle: string; bundleId: string; teamId: string }
interface Resources { helper: string; plugin: string }
interface Operation { controller: AbortController; deadline: number; timedOut: boolean }

function failure(code: TernCode, cause?: unknown): DiagnosticError {
  return new DiagnosticError(source, cause, code)
}
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    path.isAbsolute(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}
function canonicalPath(value: unknown): value is string {
  return validPath(value) && path.normalize(value) === value && !value.endsWith(path.sep)
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function targetCopy(target: TernTarget): TernTarget {
  const { windowKey, paneId, sessionFile } = target
  if (typeof windowKey !== 'string' || windowKey.length > 128 || /[^A-Za-z0-9._-]/.test(windowKey) ||
      !Number.isSafeInteger(paneId) || paneId <= 0 || !validPath(sessionFile)) throw failure('OC_TERN_TARGET')
  return { windowKey, paneId, sessionFile }
}

export function resolveTernTarget(agents: AgentInfo[], agentId: string): TernTarget {
  if (!Array.isArray(agents) || agents.length > maxAgents) throw failure('OC_TERN_TARGET')
  const byId = new Map<string, AgentInfo>()
  for (const agent of agents) {
    if (!agent || typeof agent.id !== 'string' || byId.has(agent.id)) throw failure('OC_TERN_TARGET')
    byId.set(agent.id, agent)
  }
  const visited = new Set<string>()
  let agent = byId.get(agentId)
  while (agent) {
    if (agent.runtime !== 'OMP' || visited.has(agent.id)) throw failure('OC_TERN_TARGET')
    visited.add(agent.id)
    if (agent.tern) return targetCopy(agent.tern)
    if (!agent.parentId) break
    agent = byId.get(agent.parentId)
    if (!agent) throw failure('OC_TERN_TARGET')
  }
  throw failure('OC_TERN_TARGET')
}

async function checked<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  const result = await action()
  throwIfAborted(signal)
  return result
}
async function directoryIdentity(filename: string, signal: AbortSignal): Promise<Stats> {
  const identity = await checked(signal, () => lstat(filename))
  if (!identity.isDirectory() || await checked(signal, () => realpath(filename)) !== filename) throw failure('OC_TERN_RESOURCES')
  return identity
}
async function verifyFile(filename: string, maxBytes: number, signal: AbortSignal, digest?: string): Promise<void> {
  const identity = await checked(signal, () => lstat(filename))
  if (!identity.isFile() || identity.size <= 0 || identity.size > maxBytes ||
      (!digest && (identity.mode & 0o111) === 0) ||
      await checked(signal, () => realpath(filename)) !== filename) throw failure('OC_TERN_RESOURCES')
  throwIfAborted(signal)
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let failed: unknown
  try {
    const before = await checked(signal, () => handle.stat())
    if (!before.isFile() || !sameFileIdentity(identity, before)) throw failure('OC_TERN_RESOURCES')
    if (digest) {
      // Stat precedes allocation; one extra byte detects growth while reading.
      const buffer = Buffer.allocUnsafe(before.size + 1)
      let used = 0
      while (used < buffer.length) {
        const { bytesRead } = await checked(signal, () => handle.read(buffer, used, buffer.length - used, used))
        if (!bytesRead) break
        used += bytesRead
      }
      if (used !== before.size || createHash('sha256').update(buffer.subarray(0, used)).digest('hex') !== digest) throw failure('OC_TERN_RESOURCES')
    }
    const after = await checked(signal, () => handle.stat())
    const current = await checked(signal, () => lstat(filename))
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, current) || !current.isFile()) throw failure('OC_TERN_RESOURCES')
  } catch (error) { failed = error; throw error }
  finally {
    try { await handle.close() }
    catch (error) { throw new ResourceCleanupError('file', failed ? new AggregateError([failed, error], 'Navigation resource read and close failed') : error) }
  }
}
async function verifyResources(root: string, signal: AbortSignal): Promise<Resources> {
  try {
    return await collectionResources.run({ source, kind: 'file', bytes: resourceBytes + 1, signal }, async () => {
      if (!canonicalPath(root)) throw failure('OC_TERN_RESOURCES')
      const rootIdentity = await directoryIdentity(root, signal)
      const helper = path.join(root, 'present-window'), plugin = path.join(root, 'plugin')
      const pluginIdentity = await directoryIdentity(plugin, signal)
      throwIfAborted(signal)
      const directory = await opendir(plugin, { bufferSize: 3 })
      let failed: unknown
      try {
        const names = new Set<string>()
        for (;;) {
          const entry = await checked(signal, () => directory.read())
          if (!entry) break
          if (!entry.isFile() || !Object.hasOwn(pluginDigests, entry.name) || names.has(entry.name)) throw failure('OC_TERN_RESOURCES')
          names.add(entry.name)
        }
        if (names.size !== 2) throw failure('OC_TERN_RESOURCES')
      } catch (error) { failed = error; throw error }
      finally {
        try { await directory.close() }
        catch (error) { throw new ResourceCleanupError('file', failed ? new AggregateError([failed, error], 'Navigation directory read and close failed') : error) }
      }
      await verifyFile(helper, 2 * 1024 * 1024, signal)
      for (const [name, digest] of Object.entries(pluginDigests)) await verifyFile(path.join(plugin, name), resourceBytes, signal, digest)
      if (!sameFileIdentity(rootIdentity, await directoryIdentity(root, signal)) ||
          !sameFileIdentity(pluginIdentity, await directoryIdentity(plugin, signal))) throw failure('OC_TERN_RESOURCES')
      return { helper, plugin }
    })
  } catch (error) {
    if (error instanceof DiagnosticError || isResourceAbort(error) || isResourceCleanupFailure(error)) throw error
    throw failure('OC_TERN_RESOURCES', error)
  }
}

function decode(output: string): unknown {
  try { return JSON.parse(output) }
  catch (error) { throw failure('OC_TERN_PROTOCOL', error) }
}
function identityFrom(output: string): TernIdentity {
  const value = decode(output)
  if (!record(value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || (value.pid as number) > 2_147_483_647 ||
      value.bundleId !== 'so.stencil.tern' || value.teamId !== 'VTLHGQC72S' ||
      !canonicalPath(value.bundle) || !canonicalPath(value.executable) ||
      value.executable !== path.join(value.bundle, 'Contents', 'MacOS', 'tern')) throw failure('OC_TERN_IDENTITY')
  return { pid: value.pid as number, executable: value.executable, bundle: value.bundle, bundleId: value.bundleId, teamId: value.teamId }
}
function verifyPane(output: string, target: TernTarget): void {
  const value = decode(output)
  if (!record(value) || !Array.isArray(value.panes) || value.panes.length > 10_000) throw failure('OC_TERN_PROTOCOL')
  let matches = 0
  for (const pane of value.panes) {
    if (!record(pane) || !Number.isSafeInteger(pane.pane) || (pane.pane as number) <= 0) throw failure('OC_TERN_PROTOCOL')
    if (pane.pane === target.paneId) {
      if (pane.exited != null || pane.omp_session_file !== target.sessionFile) throw failure('OC_TERN_TARGET')
      matches++
    }
  }
  if (matches !== 1) throw failure('OC_TERN_TARGET')
}
function pluginReady(output: string): boolean {
  const value = decode(output)
  if (!record(value) || !Array.isArray(value.plugins) || value.plugins.length > 256) throw failure('OC_TERN_PROTOCOL')
  let ready = false
  const ids = new Set<string>()
  for (const plugin of value.plugins) {
    if (!record(plugin) || typeof plugin.id !== 'string' || plugin.id.length > 256 || ids.has(plugin.id)) throw failure('OC_TERN_PLUGIN')
    ids.add(plugin.id)
    if (plugin.id === pluginId) {
      if (plugin.status !== 'ready' || plugin.window !== true || plugin.version !== '1.0.0') throw failure('OC_TERN_PLUGIN')
      ready = true
    }
  }
  return ready
}

/** One navigation owns its resources until every file and child actually closes. */
export class TernNavigation {
  private active?: { operation: Operation; promise: Promise<void> }
  private closed = false

  constructor(private readonly resources: string, private readonly execute?: NavigationCommand, private readonly totalTimeoutMs = 10_000) {
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 10_000) throw new RangeError('Invalid Tern navigation deadline')
  }

  focus(agents: AgentInfo[], agentId: string): Promise<void> {
    if (this.closed) return Promise.reject(failure('OC_TERN_CLOSED'))
    if (this.active) return Promise.reject(failure('OC_TERN_BUSY'))
    const operation: Operation = { controller: new AbortController(), deadline: performance.now() + this.totalTimeoutMs, timedOut: false }
    const timer = setTimeout(() => { operation.timedOut = true; operation.controller.abort() }, this.totalTimeoutMs)
    const promise = this.navigate(agents, agentId, operation).catch(error => {
      if (isResourceCleanupFailure(error)) throw error
      if (operation.timedOut) throw failure('OC_TERN_TIMEOUT', error)
      throw error
    }).finally(() => { clearTimeout(timer); this.active = undefined })
    this.active = { operation, promise }
    return promise
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    active.operation.controller.abort()
    try { await active.promise }
    catch (error) { if (!isResourceAbort(error)) throw error }
  }

  close(): Promise<void> {
    this.closed = true
    return this.cancel()
  }

  private async command(operation: Operation, file: string, args: readonly string[], maxBuffer: number, helper = false): Promise<string> {
    const signal = operation.controller.signal
    throwIfAborted(signal)
    const remaining = Math.floor(operation.deadline - performance.now())
    if (remaining < 1) {
      operation.timedOut = true
      operation.controller.abort()
      throw failure('OC_TERN_TIMEOUT')
    }
    try {
      const { stdout } = await runBudgetedCommand(source, file, args, { timeout: remaining, maxBuffer }, signal,
        this.execute ? () => this.execute!(file, args, signal) : undefined)
      throwIfAborted(signal)
      if (performance.now() >= operation.deadline) {
        operation.timedOut = true
        operation.controller.abort()
        throw failure('OC_TERN_TIMEOUT')
      }
      return stdout
    } catch (error) {
      if (error instanceof DiagnosticError || isResourceAbort(error) || isResourceCleanupFailure(error)) throw error
      if (performance.now() >= operation.deadline) operation.timedOut = true
      // The native runner uses the remaining overall budget as its only execution timeout.
      if (!this.execute && error && typeof error === 'object' &&
          Object.getOwnPropertyDescriptor(error, 'killed')?.value === true &&
          Object.getOwnPropertyDescriptor(error, 'signal')?.value === 'SIGKILL' &&
          Object.getOwnPropertyDescriptor(error, 'code')?.value !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') operation.timedOut = true
      let code: TernCode = 'OC_TERN_COMMAND'
      if (helper && error && typeof error === 'object') {
        const stderr = Object.getOwnPropertyDescriptor(error, 'stderr')?.value
        if (typeof stderr === 'string' && stderr.length <= 64 && /^OC_TERN_[A-Z]+\n$/.test(stderr)) {
          const candidate = stderr.slice(0, -1) as TernCode
          if (Object.hasOwn(helperCodes, candidate)) code = candidate
        }
      }
      throw failure(code, error)
    }
  }

  private async navigate(agents: AgentInfo[], agentId: string, operation: Operation): Promise<void> {
    const target = resolveTernTarget(agents, agentId)
    const resources = await verifyResources(this.resources, operation.controller.signal)
    const identity = identityFrom(await this.command(operation, resources.helper, ['probe'], helperBytes, true))
    const inspectArgs = ['inspect', '--json', '--window', target.windowKey]
    const pluginArgs = ['plugin', 'list', '--json']
    verifyPane(await this.command(operation, identity.executable, inspectArgs, inspectBytes), target)
    if (!pluginReady(await this.command(operation, identity.executable, pluginArgs, pluginBytes))) {
      // Re-read the fixed bundled payload immediately before installing it.
      await verifyResources(this.resources, operation.controller.signal)
      await this.command(operation, identity.executable, ['plugin', 'install', resources.plugin, '--json'], pluginBytes)
      if (!pluginReady(await this.command(operation, identity.executable, pluginArgs, pluginBytes))) throw failure('OC_TERN_PLUGIN')
    }
    const current = identityFrom(await this.command(operation, resources.helper, ['probe'], helperBytes, true))
    if (current.pid !== identity.pid || current.executable !== identity.executable || current.bundle !== identity.bundle) throw failure('OC_TERN_IDENTITY')
    verifyPane(await this.command(operation, identity.executable, inspectArgs, inspectBytes), target)
    const focused = decode(await this.command(operation, identity.executable, ['focus', String(target.paneId), '--json', '--window', target.windowKey], helperBytes))
    if (!record(focused) || focused.block !== target.paneId) throw failure('OC_TERN_TARGET')
    const presented = decode(await this.command(operation, resources.helper,
      ['present', String(identity.pid), identity.executable, target.windowKey], helperBytes, true))
    if (!record(presented) || presented.pid !== identity.pid || presented.main !== true ||
        typeof presented.windowTitle !== 'string' || presented.windowTitle.length > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(presented.windowTitle) ||
        !presented.windowTitle.startsWith(`[Tern ${JSON.stringify(target.windowKey)}] `)) throw failure('OC_TERN_WINDOW')
  }
}
