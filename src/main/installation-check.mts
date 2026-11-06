import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const INSTALL_CHECK_ARGUMENT = '--oc-chan-install-check='
const MAX_BYTES = 8192
const MAX_AGE_MS = 120_000
const sections = ['agents', 'schedules', 'system', 'events'] as const
export interface InstallationEvidence {
  renderer: true
  ipc: true
  collections: Record<typeof sections[number], 'ready' | 'disabled'>
  history: 'hermes' | 'unavailable' | 'disabled'
  historyEntries: number
}
export interface InstallationRequest {
  schema: 1
  nonce: string
  executable: string
  version: string
  issuedAt: number
}
export interface InstallationCheck {
  directory: string
  filename: string
  request: InstallationRequest
}
interface InstallationResult extends InstallationRequest {
  pid: number
  checkedAt: number
  status: 'ready' | 'failed'
  evidence?: InstallationEvidence
  error?: string
}
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function validRequest(value: unknown): asserts value is InstallationRequest {
  const item = value as InstallationRequest | null
  requireThat(item && item.schema === 1 && typeof item.nonce === 'string' && /^[a-f0-9]{64}$/.test(item.nonce) &&
    typeof item.executable === 'string' && path.isAbsolute(item.executable) && item.executable.length <= 4096 && !/[\x00-\x1f\x7f]/.test(item.executable) &&
    typeof item.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(item.version) &&
    Number.isSafeInteger(item.issuedAt) && item.issuedAt <= Date.now() && Date.now() - item.issuedAt <= MAX_AGE_MS,
  'Invalid or expired installation request')
}
function validEvidence(value: unknown): asserts value is InstallationEvidence {
  const item = value as InstallationEvidence | null
  requireThat(item && item.renderer === true && item.ipc === true && item.collections &&
    sections.every(section => ['ready', 'disabled'].includes(item.collections[section])) &&
    ['hermes', 'unavailable', 'disabled'].includes(item.history) && Number.isSafeInteger(item.historyEntries) &&
    item.historyEntries >= 0 && item.historyEntries <= 25 && (item.history === 'hermes' || item.historyEntries === 0),
  'Renderer, IPC, collection or history readiness evidence is invalid')
}
async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  requireThat(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid!() && (info.mode & 0o777) === 0o700 &&
    /^oc-chan-install-check-[A-Za-z0-9]+$/.test(path.basename(directory)) && await realpath(directory) === directory,
  'Installation check requires its owned private directory')
}
export async function readInstallationJson(filename: string): Promise<unknown> {
  requireThat(['request.json', 'result.json'].includes(path.basename(filename)), 'Invalid installation check filename')
  await privateDirectory(path.dirname(filename))
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    requireThat(info.isFile() && info.nlink === 1 && info.uid === process.getuid!() && (info.mode & 0o777) === 0o600 && info.size > 0 && info.size <= MAX_BYTES, 'Invalid installation check file')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    requireThat(offset === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'Installation check file changed during read')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally { await file.close() }
}
export async function createInstallationCheck(executable: string, version: string): Promise<InstallationCheck> {
  const request: InstallationRequest = { schema: 1, nonce: randomBytes(32).toString('hex'), executable, version, issuedAt: Date.now() }
  validRequest(request)
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'oc-chan-install-check-')))
  const filename = path.join(directory, 'request.json')
  try { await writeFile(filename, JSON.stringify(request), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    try { await rm(directory, { recursive: true }) }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Installation request and cleanup failed') }
    throw error
  }
  return { directory, filename, request }
}
export async function verifyInstallationResult(check: InstallationCheck): Promise<InstallationResult | null> {
  let result: unknown
  try { result = await readInstallationJson(path.join(check.directory, 'result.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await privateDirectory(check.directory)
    return null
  }
  validRequest(result)
  const item = result as InstallationResult
  requireThat(['schema', 'nonce', 'version', 'executable', 'issuedAt'].every(key => item[key as keyof InstallationRequest] === check.request[key as keyof InstallationRequest]) &&
    Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isSafeInteger(item.checkedAt) && item.checkedAt >= item.issuedAt && item.checkedAt <= Date.now(),
  'Installation readiness response does not match this launch')
  if (item.status === 'failed') throw new Error(`Application readiness failed: ${typeof item.error === 'string' ? item.error.slice(0, 512) : 'missing error'}`)
  requireThat(item.status === 'ready', 'Invalid installation readiness status')
  validEvidence(item.evidence)
  return item
}
export async function runInstallationCheck(filename: string, options: {
  executable: string
  version: string
  signal: AbortSignal
  probe: () => Promise<InstallationEvidence | null>
  timeoutMs?: number
}): Promise<void> {
  const request = await readInstallationJson(filename)
  validRequest(request)
  const timeoutMs = options.timeoutMs ?? 30_000
  requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'Invalid installation check deadline')
  const controller = new AbortController()
  const abort = (): void => controller.abort(options.signal.reason ?? new Error('Installation check cancelled'))
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('Renderer/IPC readiness timed out')), timeoutMs)
  let cancelWait: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    cancelWait = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', cancelWait, { once: true })
    if (controller.signal.aborted) cancelWait()
  })
  let result: InstallationResult
  try {
    const evidence = await Promise.race([(async () => {
      requireThat(request.version === options.version && request.executable === await realpath(options.executable), 'Application version or running executable differs from the requested installation')
      let evidence: InstallationEvidence | null = null
      while (!evidence) {
        controller.signal.throwIfAborted()
        evidence = await options.probe()
        if (!evidence) await delay(100, undefined, { signal: controller.signal })
      }
      validEvidence(evidence)
      return evidence
    })(), interrupted])
    result = { ...request, pid: process.pid, checkedAt: Date.now(), status: 'ready', evidence }
  } catch (error) {
    result = { ...request, pid: process.pid, checkedAt: Date.now(), status: 'failed', error: error instanceof Error ? error.message.slice(0, 512) : 'Installation check failed' }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    if (cancelWait) controller.signal.removeEventListener('abort', cancelWait)
  }
  await privateDirectory(path.dirname(filename))
  const output = JSON.stringify(result)
  requireThat(Buffer.byteLength(output) <= MAX_BYTES, 'Installation readiness response exceeds its budget')
  // Atomic publication: a reader must never observe a partially written response.
  const pending = path.join(path.dirname(filename), 'result.pending')
  const destination = path.join(path.dirname(filename), 'result.json')
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let failure: unknown
  try {
    try { await lstat(destination); throw new Error('Installation readiness was already published') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await file.writeFile(output)
    await file.sync()
  } catch (error) { failure = error }
  try { await file.close() }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Readiness write and close failed') : error }
  if (!failure) {
    try { await rename(pending, destination); return }
    catch (error) { failure = error }
  }
  try { await unlink(pending) }
  catch (error) { throw new AggregateError([failure, error], 'Readiness publication and cleanup failed') }
  throw failure
}

/** Fixed code, executed only for a requested installation check through the existing preload APIs. */
export const INSTALLATION_PROBE = `(async () => {
  if (!document.querySelector('.app-shell')) return null;
  const settings = await window.desktopSettings.snapshot();
  const snapshot = await window.monitor.snapshot();
  const collections = {};
  for (const section of ['agents', 'schedules', 'system', 'events']) {
    if (!settings.settings.plugins[section]) { collections[section] = 'disabled'; continue; }
    const state = snapshot[section];
    if (!state || state.error) throw new Error('Collection failed: ' + section);
    if (!state.data) return null;
    collections[section] = 'ready';
  }
  let history = 'disabled', historyEntries = 0;
  if (settings.settings.plugins.schedules) {
    const job = snapshot.schedules.data.jobs.find(job => job.id.startsWith('hermes-job:'));
    history = 'unavailable';
    if (job) {
      const page = await window.monitor.scheduleHistory(job.id, 0);
      if (page.source !== 'hermes' || page.offset !== 0 || page.limit !== 25 || !Array.isArray(page.entries) || page.entries.length > 25)
        throw new Error('History readiness failed');
      history = page.source; historyEntries = page.entries.length;
    }
  }
  return { renderer: true, ipc: true, collections, history, historyEntries };
})()`
