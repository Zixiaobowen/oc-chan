import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import test from 'node:test'
import { ROOT } from './build-app.mjs'
import { compileLocalProcessTool, nativeProcess, validateProcess, validateReadyReceipt } from './local-install-readiness.mjs'

const exec = promisify(execFile)
function receiptFixture() {
  const request = { schema: 1, transaction: 'b53a76cd-a128-478c-b028-d49ba9f9bc2e', bundle: '/isolated/OC Chan.app', version: '1.2.3', issued_at_ms: 1000, expires_at_ms: 61000,
    process: { pid: 1234, birth_seconds: 1, birth_fraction: 0, executable: '/isolated/OC Chan.app/Contents/MacOS/oc-chan' } }
  const ready = { enabled: true, installed: true, state: 'ready', reason: null }
  const receipt = { request: structuredClone(request), checked_at_ms: 2000, evidence: { host_version: '1.2.3', renderer_entry: '/src/main.tsx', renderer_committed: true, ipc_round_trip: true,
    partitions: { agents: { ...ready }, schedules: { ...ready }, events: { ...ready }, system: { enabled: false, installed: false, state: 'not-installed', reason: null } },
    hermes_history: 'unavailable', history_entries: 0, history_reason: 'No history source is installed' } }
  return { request, receipt }
}
test('receipt validation accepts explicit actual unavailability without claiming history data', () => {
  const { receipt, request } = receiptFixture(); assert.equal(validateReadyReceipt(receipt, request, 3000), receipt)
  receipt.evidence.partitions.agents = { enabled: true, installed: true, state: 'unsupported', reason: 'Source does not expose this capability' }
  validateReadyReceipt(receipt, request, 3000)
})
for (const [name, mutate] of [
  ['missing real renderer commit', value => { value.evidence.renderer_committed = false }],
  ['missing IPC', value => { value.evidence.ipc_round_trip = false }],
  ['foreign process birth', value => { value.request.process.birth_fraction++ }],
  ['installed system failure', value => { value.evidence.partitions.system = { enabled: true, installed: true, state: 'unavailable', reason: 'collector failed' } }],
  ['unexplained unavailable history', value => { value.evidence.history_reason = null }],
  ['invented unavailable history rows', value => { value.evidence.history_entries = 1 }],
  ['unexpected fields', value => { value.evidence.first_frame = true }]
]) test(`receipt rejects ${name}`, () => {
  const { receipt, request } = receiptFixture(); mutate(receipt); assert.throws(() => validateReadyReceipt(receipt, request, 3000))
})
test('future and expired receipts plus unsafe process integers fail closed', () => {
  const { receipt, request } = receiptFixture(); assert.throws(() => validateReadyReceipt(receipt, request, 1001), /future/); assert.throws(() => validateReadyReceipt(receipt, request, 62000), /stale/)
  assert.throws(() => validateProcess({ ...request.process, birth_seconds: Number.MAX_SAFE_INTEGER + 1 }), /Unsafe native integer/)
})
test('real native gate holds a parent-owned POSIX lock and drains a child before exec on EOF', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oc-local-gate-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tool = await compileLocalProcessTool(ROOT, directory), bundle = path.join(directory, 'OC Chan.app')
  // Compile with the same native toolchain as the gate, before it holds a lock.
  // The observation must not depend on macOS's separate Python installation.
  const lockObserver = path.join(directory, 'local-install-lock-test')
  await exec('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', path.join(ROOT, 'scripts/local-install-lock.test.c'), '-o', lockObserver], { cwd: ROOT, timeout: 30000, maxBuffer: 512 * 1024 })
  const observeLock = async filename => JSON.parse((await exec(lockObserver, [filename], { timeout: 5000, maxBuffer: 1024 })).stdout)
  await mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true })
  await copyFile('/bin/sleep', path.join(bundle, 'Contents/MacOS/oc-chan'))
  const authorizationDirectory = path.join(directory, 'oc-local-install-b53a76cd-a128-478c-b028-d49ba9f9bc2e'); await mkdir(authorizationDirectory, { mode: 0o700 })
  const child = spawn(tool, ['launch', path.join(bundle, 'Contents/MacOS/oc-chan'), path.join(authorizationDirectory, 'authorization.json')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const completed = once(child, 'close'), lines = createInterface({ input: child.stdout }); let diagnostics = ''
  child.stderr.on('data', value => { diagnostics += value })
  t.after(async () => { child.stdin.end(); await completed; lines.close() })
  const [line] = await once(lines, 'line'), gate = JSON.parse(line)
  assert.equal(gate.installer.pid, child.pid); assert.equal(gate.installer.executable, tool)
  assert.equal((await nativeProcess(tool, 'inspect', gate.process.pid)).process.executable, tool, 'child is still blocked before exec')
  const locked = await observeLock(gate.lock)
  assert.deepEqual(locked, { pid: child.pid, write: true, start: 0, length: 0 })
  child.stdin.end(); const [code, signal] = await completed
  assert.equal(signal, null, diagnostics); assert.equal(code, 125, diagnostics)
  assert.equal((await nativeProcess(tool, 'inspect', gate.process.pid)).process, null)
  assert.deepEqual(await observeLock(gate.lock), { unlocked: true }, 'parent exit releases the POSIX lock')
})
