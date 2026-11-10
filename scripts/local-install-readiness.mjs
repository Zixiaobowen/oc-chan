import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify, isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { boundedJson } from './build-app.mjs'

const execute = promisify(execFile)
export const LOCAL_READY_ARGUMENT = '--oc-local-install-receipt='
function requireThat(value, message) { if (!value) throw new Error(message) }
function keys(value, names, field) { requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), `Invalid ${field} fields`) }
function integer(value, field) { requireThat(Number.isSafeInteger(value) && value >= 0, `Unsafe native integer: ${field}`) }
export function validateProcess(value) {
  keys(value, ['pid', 'birth_seconds', 'birth_fraction', 'executable'], 'process')
  for (const key of ['pid', 'birth_seconds', 'birth_fraction']) integer(value[key], key)
  requireThat(value.pid > 1 && value.pid <= 0x7fffffff && value.birth_seconds > 0 && value.birth_fraction < 1000000 && typeof value.executable === 'string' && path.isAbsolute(value.executable) && Buffer.byteLength(value.executable) <= 4096, 'Invalid process identity')
  return value
}
function validateFileIdentity(value) {
  keys(value, ['dev', 'ino', 'uid', 'mode', 'nlink'], 'file identity')
  for (const [key, item] of Object.entries(value)) integer(item, key)
  requireThat(value.uid === process.getuid() && value.ino > 0 && value.nlink > 0, 'Native identity is not owned by this user')
}
function text(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 }
export function validateReadyReceipt(receipt, request, now = Date.now()) {
  keys(receipt, ['request', 'checked_at_ms', 'evidence'], 'readiness receipt')
  requireThat(isDeepStrictEqual(receipt.request, request), 'Receipt belongs to a different request or process')
  integer(receipt.checked_at_ms, 'checked_at_ms')
  requireThat(receipt.checked_at_ms >= request.issued_at_ms && receipt.checked_at_ms <= now && now <= request.expires_at_ms, 'Readiness receipt is stale or from the future')
  const evidence = receipt.evidence
  keys(evidence, ['host_version', 'renderer_entry', 'renderer_committed', 'ipc_round_trip', 'partitions', 'hermes_history', 'history_entries', 'history_reason'], 'readiness evidence')
  requireThat(evidence.host_version === request.version && evidence.renderer_committed === true && evidence.ipc_round_trip === true && text(evidence.renderer_entry), 'Actual renderer commit, host version or IPC round trip is missing')
  keys(evidence.partitions, ['agents', 'schedules', 'events', 'system'], 'partitions')
  for (const [name, partition] of Object.entries(evidence.partitions)) {
    keys(partition, ['enabled', 'installed', 'state', 'reason'], 'partition')
    requireThat(typeof partition.enabled === 'boolean' && typeof partition.installed === 'boolean' && (partition.reason === null || text(partition.reason)), 'Invalid readiness partition values')
    switch (partition.state) {
      case 'ready': requireThat(partition.enabled && partition.installed, 'Ready partition is not installed/enabled'); break
      case 'disabled': requireThat(!partition.enabled && partition.installed, 'Disabled partition is inconsistent'); break
      case 'not-installed': requireThat(name === 'system' && !partition.installed && !partition.enabled, 'Invalid not-installed partition'); break
      case 'unavailable': case 'unsupported': requireThat(name !== 'system' && partition.installed && partition.enabled && text(partition.reason), 'Installed system failure or unexplained source failure cannot pass readiness'); break
      default: throw new Error('Unknown partition readiness')
    }
  }
  integer(evidence.history_entries, 'history_entries')
  requireThat(evidence.history_entries <= 25 && ['available', 'unavailable', 'disabled', 'unsupported'].includes(evidence.hermes_history), 'Invalid actual history readiness')
  requireThat(evidence.history_reason === null || text(evidence.history_reason), 'Invalid history reason')
  if (evidence.hermes_history !== 'available') requireThat(evidence.history_entries === 0 && text(evidence.history_reason), 'Unavailable history needs an actual bounded reason and zero entries')
  return receipt
}
export async function publishPrivateJson(filename, value) {
  const data = Buffer.from(`${JSON.stringify(value)}\n`); requireThat(data.length <= 16 * 1024, 'Local readiness metadata exceeds 16 KiB')
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(data); await file.sync() } finally { await file.close() }
  const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
async function privateJson(filename) {
  const before = await lstat(filename)
  requireThat(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o777) === 0o600, 'Receipt is not a private owned regular file')
  const value = await boundedJson(filename, 16 * 1024), after = await lstat(filename)
  requireThat(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Receipt changed while reading')
  return value
}
export async function compileLocalProcessTool(root, directory) {
  const tool = path.join(directory, 'local-install-process')
  await execute('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'AppKit', path.join(root, 'scripts/local-install-process.m'), '-o', tool], { cwd: root, timeout: 120000, maxBuffer: 512 * 1024 })
  return realpath(tool)
}
export async function nativeProcess(tool, action, value) {
  const { stdout } = await execute(tool, [action, String(value)], { timeout: 5000, maxBuffer: 64 * 1024 })
  return JSON.parse(stdout)
}
export async function stopApplication(tool, bundle) {
  const observed = await nativeProcess(tool, 'quit', bundle); const deadline = Date.now() + 15000
  for (const item of observed) validateProcess(item.process)
  while (true) {
    let alive = false
    for (const item of observed) {
      const current = (await nativeProcess(tool, 'inspect', item.process.pid)).process
      if (!current) continue
      requireThat(isDeepStrictEqual(current, item.process), 'PID was reused while waiting for the application to exit'); alive = true
    }
    if (!alive) return observed.length > 0
    requireThat(Date.now() < deadline, 'Application refused to exit within 15 seconds; replacement stopped')
    await delay(100)
  }
}
export async function launchForReadiness({ tool, bundle, version, evidenceDirectory, signal }) {
  signal?.throwIfAborted()
  bundle = await realpath(bundle)
  const transaction = randomUUID(), directory = path.join(evidenceDirectory, `oc-local-install-${transaction}`)
  await mkdir(directory, { mode: 0o700 }); const authorizationPath = path.join(directory, 'authorization.json')
  const executable = await realpath(path.join(bundle, 'Contents/MacOS/oc-chan'))
  const child = spawn(tool, ['launch', executable, authorizationPath], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let failure, stderr = '', stdout = '', response, settled = false
  const abort = () => { failure ??= signal.reason; child.stdin.end() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const completed = new Promise(resolve => {
    child.once('error', error => { failure = error })
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }) })
  })
  completed.then(() => signal?.removeEventListener('abort', abort))
  const announced = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    for (const stream of [child.stdout, child.stderr]) stream.once('error', error => { failure = error; child.stdin.end(); reject(error) })
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (Buffer.byteLength(stdout) > 16 * 1024) { reject(new Error('Native gate response exceeds budget')); child.stdin.end(); return }
      if (stdout.includes('\n') && !response) { try { response = JSON.parse(stdout.trim()); resolve(response) } catch (error) { reject(error); child.stdin.end() } }
    })
    child.stderr.on('data', chunk => { if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) <= 64 * 1024) stderr += chunk; else { failure ??= new Error('Native gate diagnostics exceed budget'); child.stdin.end() } })
    completed.then(result => { if (!response) reject(failure ?? new Error(`Native gate exited before announcing identity: ${result.signal ?? result.code}: ${stderr}`)) })
  })
  const write = value => new Promise((resolve, reject) => { if (settled) reject(failure ?? new Error('Native gate already exited')); else child.stdin.write(value, error => error ? reject(error) : resolve()) })
  child.stdin.on('error', error => { failure ??= error })
  async function abandon() {
    child.stdin.end(); const result = await completed
    requireThat(!result.signal && result.code === 125, `Native launch cleanup failed (${result.signal ?? result.code}): ${stderr}`)
  }
  let timer
  try {
    const gate = await Promise.race([announced, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native gate did not initialize within 5 seconds')), 5000) })])
    clearTimeout(timer)
    signal?.throwIfAborted()
    validateProcess(gate.installer); validateProcess(gate.process); validateFileIdentity(gate.bundle_identity); validateFileIdentity(gate.lock_identity)
    requireThat(gate.installer.pid === child.pid && gate.installer.executable === tool && gate.process.executable === executable && gate.lock === path.join(directory, 'gate.lock'), 'Native gate announced unexpected ownership')
    requireThat(gate.lock_identity.mode === (0o100000 | 0o600) && gate.lock_identity.nlink === 1 && (gate.bundle_identity.mode & 0o170000) === 0o040000 && (gate.bundle_identity.mode & 0o022) === 0, 'Native gate lock or bundle has unsafe permissions')
    const issued = Date.now(), request = { schema: 1, transaction, bundle, version, issued_at_ms: issued, expires_at_ms: issued + 60000, process: gate.process }
    requireThat(gate.process.birth_seconds * 1000 + Math.floor(gate.process.birth_fraction / 1000) <= issued, 'Native child birth is in the future')
    const authorization = { schema: 1, request, installer: gate.installer, bundle_identity: gate.bundle_identity, lock_identity: gate.lock_identity, lock: gate.lock }
    await publishPrivateJson(authorizationPath, authorization); await write('G')
    return {
      directory, request, abandon,
      async verify() {
        const deadline = Math.min(request.expires_at_ms, issued + 45000)
        while (Date.now() < deadline) {
          signal?.throwIfAborted()
          requireThat(!settled, `Native parent exited during startup: ${stderr}`)
          let receipt
          try { receipt = await privateJson(path.join(directory, 'receipt.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (receipt) {
            validateReadyReceipt(receipt, request)
            const prove = async () => {
              requireThat(isDeepStrictEqual((await nativeProcess(tool, 'inspect', request.process.pid)).process, request.process), 'Launched process exited or changed identity')
              const applications = await nativeProcess(tool, 'applications', bundle)
              requireThat(applications.length === 1 && applications[0].ready === true && isDeepStrictEqual(applications[0].process, request.process), 'Receipt does not match the actual finished-launching application')
            }
            await prove(); await delay(2000); signal?.throwIfAborted(); await prove(); validateReadyReceipt(receipt, request)
            await write('C'); child.stdin.end(); const result = await completed
            requireThat(!result.signal && result.code === 0 && !failure, `Native parent could not commit readiness: ${stderr}`)
            return receipt
          }
          const actual = (await nativeProcess(tool, 'inspect', request.process.pid)).process
          requireThat(actual && actual.birth_seconds === request.process.birth_seconds && actual.birth_fraction === request.process.birth_fraction, 'New application exited before publishing readiness')
          await delay(100)
        }
        throw new Error('Application did not complete real renderer, IPC, collection and history readiness within 45 seconds')
      }
    }
  } catch (error) {
    clearTimeout(timer)
    try { await abandon() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Launch initialization and cancellation failed') }
    throw error
  }
}
