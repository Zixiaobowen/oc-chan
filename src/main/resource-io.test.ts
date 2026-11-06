import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { appendFile, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { collectionResources, RESOURCE_LIMITS, ResourceCleanupError } from './resource-budget'
import { runBudgetedCommand, type BudgetedCommandOptions } from './resource-io'

const options = { timeout: 2000, maxBuffer: 1024 }

test('execution timeout starts after admission rather than while queued', async () => {
  // Exercise execFile's real deadline against an OS child; advancing a fake clock cannot deliver child close events.
  const held = await collectionResources.acquire({ source: 'test-hold', kind: 'command', stdoutBytes: RESOURCE_LIMITS.commandBytes / 2, stderrBytes: RESOURCE_LIMITS.commandBytes / 2 })
  const command = runBudgetedCommand('test-queue-command', '/bin/echo', ['admitted'], { timeout: 100, maxBuffer: 1024 })
  try { await delay(150) } finally { held.release() }
  assert.deepEqual(await command, { stdout: 'admitted\n', stderr: '' })
  const stats = collectionResources.snapshot().sources.find(source => source.source === 'test-queue-command')!
  assert.ok(stats.totalWaitMs >= 120 && stats.totalWaitMs > stats.totalExecutionMs)
  assert.equal(collectionResources.snapshot().global.current.commandBytes, 0)
})

test('spawn failure, output overflow and execution timeout all drain their reservation', async () => {
  // Real process termination and pipe closure are the behavior under test, including Node's execution timer.
  await assert.rejects(runBudgetedCommand('test-command-error', '/oc-chan-missing-executable', [], options), { code: 'ENOENT' })
  await assert.rejects(runBudgetedCommand('test-output', process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { timeout: 2000, maxBuffer: 64 }), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  await assert.rejects(runBudgetedCommand('test-command-timeout', process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 60, maxBuffer: 1024 }), (error: unknown) => error instanceof Error && 'killed' in error && error.killed === true)
  assert.equal(collectionResources.snapshot().global.current.commands, 0)
  assert.equal(collectionResources.snapshot().global.current.commandBytes, 0)
})

test('abort settles only after the actual owned command exits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-command-'))
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }) })
  const filename = path.join(root, 'pid')
  let watcher: ReturnType<typeof watch> | undefined
  let deadline: NodeJS.Timeout | undefined
  const ready = new Promise<number>((resolve, reject) => {
    // Failure deadline only: readiness comes from the child's atomic PID-file rename, never a guessed sleep.
    deadline = setTimeout(() => reject(new Error('Owned command did not announce readiness')), 2000)
    watcher = watch(root, (_event, name) => {
      if (name === 'pid') void readFile(filename, 'utf8').then(value => resolve(Number(value)), reject)
    })
  }).finally(() => { watcher?.close(); clearTimeout(deadline) })
  const code = `const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.tmp',String(process.pid));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);setInterval(()=>{},1000)`
  const result = runBudgetedCommand('test-command-cancel', process.execPath, ['-e', code, filename], { timeout: 5000, maxBuffer: 1024 }, controller.signal).then(() => undefined, error => error)
  const pid = await ready
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  controller.abort()
  const error = await result
  assert.equal(error?.code, 'ABORT_ERR')
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(collectionResources.snapshot().global.current.commands, 0)
})

const inputLimit = 1024 * 1024
const exec = promisify(execFile)
async function inputFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'oc-r02-input-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, filename: path.join(directory, 'input') }
}
function assertInputReleased(): void {
  const current = collectionResources.snapshot().global.current
  for (const key of ['commands', 'files', 'commandBytes', 'fileBytes', 'queued'] as const) assert.equal(current[key], 0, key)
}

test('real cat receives the complete 1 MiB input boundary through stdin', async t => {
  const { filename } = await inputFixture(t)
  const content = '界'.repeat(Math.floor(inputLimit / 3)) + 'x'.repeat(inputLimit % 3)
  await writeFile(filename, content)
  const result = await runBudgetedCommand('test-input', '/bin/cat', [], {
    timeout: 5000, maxBuffer: inputLimit * 2, inputFile: { path: filename, maxBytes: inputLimit, identity: await stat(filename) },
  })
  assert.equal(Buffer.byteLength(result.stdout), inputLimit)
  assert.equal(result.stdout, content)
  assert.equal(result.stderr, '')
  assertInputReleased()
})

test('oversized input rejects before command execution and releases both resource budgets', async t => {
  const { filename } = await inputFixture(t)
  await writeFile(filename, Buffer.alloc(inputLimit + 1, 97))
  let executed = false
  await assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], {
    ...options, inputFile: { path: filename, maxBytes: inputLimit },
  }, undefined, async () => { executed = true; return '' }), { code: 'OC_COLLECTION_LIMIT' })
  assert.equal(executed, false)
  assertInputReleased()
})

test('growth at the first read rejects before execution and closes the real file descriptor', async t => {
  const { filename } = await inputFixture(t)
  await writeFile(filename, Buffer.alloc(64 * 1024, 97))
  const probe = await open(filename, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  let captured: typeof probe | undefined
  let largestRead = 0
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    largestRead = Math.max(largestRead, Number(args[2]))
    if (!captured) { captured = this; await appendFile(filename, 'growth') }
    return Reflect.apply(original, this, args)
  })
  let executed = false
  await assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], {
    ...options, inputFile: { path: filename, maxBytes: inputLimit },
  }, undefined, async () => { executed = true; return '' }), { code: 'OC_COLLECTION_CHANGED' })
  assert.equal(executed, false)
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assert.ok(largestRead <= 64 * 1024)
  assertInputReleased()
})

test('same-size replacement while queued rejects the captured identity before execution', async t => {
  const { directory, filename } = await inputFixture(t)
  await writeFile(filename, 'original')
  const identity = await stat(filename)
  const held = await collectionResources.acquire({ source: 'test-input-hold', kind: 'command', stdoutBytes: RESOURCE_LIMITS.commandBytes, stderrBytes: 0 })
  t.after(() => held.release())
  let executed = false
  const result = assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], {
    ...options, inputFile: { path: filename, maxBytes: inputLimit, identity },
  }, undefined, async () => { executed = true; return '' }), { code: 'OC_COLLECTION_CHANGED' })
  assert.equal(collectionResources.snapshot().global.current.files, 0)
  const replacement = path.join(directory, 'replacement')
  await writeFile(replacement, 'replaced')
  await rename(replacement, filename)
  held.release()
  await result
  assert.equal(executed, false)
  assertInputReleased()
})

test('queued options cannot redirect input, enlarge its reservation or change the identity snapshot', async t => {
  const { directory, filename } = await inputFixture(t)
  await writeFile(filename, 'bounded')
  const other = path.join(directory, 'other')
  await writeFile(other, 'x'.repeat(4096))
  const identity = await stat(filename)
  const commandOptions: BudgetedCommandOptions = { ...options, inputFile: { path: filename, maxBytes: 7, identity } }
  const held = await collectionResources.acquire({ source: 'test-input-hold', kind: 'command', stdoutBytes: RESOURCE_LIMITS.commandBytes, stderrBytes: 0 })
  t.after(() => held.release())
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  t.after(() => release())
  const result = runBudgetedCommand('test-input', '/bin/cat', [], commandOptions, undefined, async input => {
    assert.equal(input?.toString(), 'bounded')
    entered()
    await gate
    return input!.toString()
  })
  // Observe rejection immediately if admission/identity validation fails; never await a readiness gate alone.
  const admitted = Promise.race([ready, result.then(() => { throw new Error('consumer settled before readiness') })])
  commandOptions.inputFile!.path = other
  commandOptions.inputFile!.maxBytes = 4096
  identity.ino++
  commandOptions.maxBuffer = 4096
  held.release()
  await admitted
  const running = collectionResources.snapshot().global.current
  assert.equal(running.commands, 1)
  assert.equal(running.files, 1)
  assert.equal(running.fileBytes, 8)
  assert.equal(running.commandBytes, options.maxBuffer * 2)
  release()
  assert.equal((await result).stdout, 'bounded')
  assertInputReleased()
})

test('real FIFO and directory inputs are rejected without blocking or spawning a consumer', { timeout: 5000 }, async t => {
  const { directory } = await inputFixture(t)
  const fifo = path.join(directory, 'pipe')
  await exec('mkfifo', [fifo])
  let executions = 0
  for (const filename of [fifo, directory]) {
    await assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], {
      ...options, inputFile: { path: filename, maxBytes: inputLimit },
    }, undefined, async () => { executions++; return '' }), { code: 'NOT_REGULAR_FILE' })
    assertInputReleased()
  }
  assert.equal(executions, 0)
})

test('input reservations drain on spawn failure and queued cancellation starts no consumer', async t => {
  const { filename } = await inputFixture(t)
  await writeFile(filename, 'input')
  const withInput = { ...options, inputFile: { path: filename, maxBytes: inputLimit } }
  await assert.rejects(runBudgetedCommand('test-input', '/oc-chan-missing-executable', [], withInput), { code: 'ENOENT' })
  assertInputReleased()
  const held = await collectionResources.acquire({ source: 'test-input-hold', kind: 'file', bytes: RESOURCE_LIMITS.fileBytes })
  const controller = new AbortController()
  t.after(() => { controller.abort(); held.release() })
  let executed = false
  const cancelled = assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], withInput, controller.signal, async () => { executed = true; return '' }), { code: 'ABORT_ERR' })
  assert.equal(collectionResources.snapshot().global.current.commands, 0)
  controller.abort()
  await cancelled
  assert.equal(executed, false)
  held.release()
  assertInputReleased()
})

test('post-read identity change rejects even when byte count and size are unchanged', async t => {
  const { filename } = await inputFixture(t)
  await writeFile(filename, 'same-size input')
  const probe = await open(filename, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const originalStat = prototype.stat
  const originalRead = prototype.read
  await probe.close()
  let captured: typeof probe | undefined
  let readFinished = false
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    captured = this
    const result = await Reflect.apply(originalRead, this, args)
    readFinished = true
    return result
  })
  t.mock.method(prototype, 'stat', async function (this: typeof probe, ...args: unknown[]) {
    const result = await Reflect.apply(originalStat, this, args) as import('node:fs').Stats
    // Deterministic filesystem identity transition after the real read, independent of clock resolution.
    if (this === captured && readFinished) result.ctimeMs += 1
    return result
  })
  let executed = false
  await assert.rejects(runBudgetedCommand('test-input', '/bin/cat', [], {
    ...options, inputFile: { path: filename, maxBytes: inputLimit },
  }, undefined, async () => { executed = true; return '' }), { code: 'OC_COLLECTION_CHANGED' })
  assert.equal(executed, false)
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assertInputReleased()
})

test('input close failure is preserved when cancellation arrives at the close boundary', async t => {
  const { filename } = await inputFixture(t)
  await writeFile(filename, 'input')
  const probe = await open(filename, 'r')
  const prototype = Object.getPrototypeOf(probe), read = prototype.read
  await probe.close()
  const controller = new AbortController()
  const failure = Object.assign(new Error('close failure'), { code: 'EIO' })
  let handle: typeof probe | undefined, executed = false
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    if (!handle) {
      handle = this
      const close = this.close.bind(this)
      this.close = async () => { await close(); controller.abort(); throw failure }
    }
    return Reflect.apply(read, this, args)
  })
  await assert.rejects(runBudgetedCommand('test-input-close', '/bin/cat', [], {
    ...options, inputFile: { path: filename, maxBytes: inputLimit }
  }, controller.signal, async () => { executed = true; return '' }), error => error instanceof ResourceCleanupError && error.cause === failure)
  assert.equal(executed, false)
  assert.ok(handle)
  await assert.rejects(handle.stat(), { code: 'EBADF' })
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'test-input-close')?.failed, 1)
  assertInputReleased()
})
