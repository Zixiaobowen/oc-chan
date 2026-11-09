import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { chmod, link, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { createInstallationCheck, readInstallationJson, runInstallationCheck, verifyInstallationResult, type InstallationEvidence } from './installation-check.mjs'

const version = '0.1.0'
const evidence: InstallationEvidence = { renderer: true, ipc: true, collections: { agents: 'ready', schedules: 'ready', system: 'ready', events: 'disabled' }, history: 'hermes', historyEntries: 2 }
const execute = promisify(execFile)
async function fixture(t: TestContext, requestedVersion = version) {
  const executable = await realpath(process.execPath)
  const check = await createInstallationCheck(executable, requestedVersion)
  t.after(() => rm(check.directory, { recursive: true, force: true }))
  return { check, options: { executable, version: requestedVersion, signal: new AbortController().signal, probe: async () => evidence, timeoutMs: 1000 } }
}
test('readiness is bound to one launch and includes renderer, IPC, collection and history evidence', async t => {
  const { check, options } = await fixture(t)
  assert.equal(await verifyInstallationResult(check), null)
  await runInstallationCheck(check.filename, options)
  const result = await verifyInstallationResult(check)
  assert.equal(result?.status, 'ready')
  assert.equal(result?.pid, process.pid)
  assert.equal(result?.executable, await realpath(process.execPath))
  assert.deepEqual(result?.evidence, evidence)
  const other = await createInstallationCheck(options.executable, version)
  t.after(() => rm(other.directory, { recursive: true, force: true }))
  await writeFile(path.join(other.directory, 'result.json'), await readFile(path.join(check.directory, 'result.json')), { mode: 0o600 })
  await assert.rejects(verifyInstallationResult(other), /does not match/)
})
for (const requestedVersion of ['2.0.0', '2.0.0-rc.1', '2.0.0+local.7', '2.0.0-rc.1+local.7', '2.0.0+001']) {
  test(`readiness preserves the complete canonical SemVer identity: ${requestedVersion}`, async t => {
    const { check, options } = await fixture(t, requestedVersion)
    const request = await readInstallationJson(check.filename)
    assert.deepEqual(request, check.request)
    assert.equal(check.request.version, requestedVersion)
    await runInstallationCheck(check.filename, options)
    const result = await verifyInstallationResult(check)
    assert.equal(result?.status, 'ready')
    assert.equal(result?.version, requestedVersion)
    assert.deepEqual(result?.evidence, evidence)
  })
}
test('creation, request consumption and result verification reject noncanonical or invalid SemVer', async t => {
  const { check, options } = await fixture(t)
  let probes = 0
  const invalidVersions = ['', 'v2.0.0', '=2.0.0', ' 2.0.0', '2.0.0 ', '2.0', '02.0.0', '2.00.0', '2.0.00',
    '-2.0.0', '2.0.0-01', '2.0.0-rc.01', '2.0.0-rc..1', '2.0.0-', '2.0.0+', '2.0.0+local..7',
    '2.0.0+local+7', '2.0.0-rc_1', '9007199254740992.0.0', `2.0.0+${'a'.repeat(256)}`]
  for (const invalidVersion of invalidVersions) {
    await assert.rejects(createInstallationCheck(options.executable, invalidVersion), /Invalid or expired installation request/)
    const request = { ...check.request, version: invalidVersion }
    await writeFile(check.filename, JSON.stringify(request))
    await assert.rejects(runInstallationCheck(check.filename, { ...options, probe: async () => { probes++; return evidence } }), /Invalid or expired installation request/)
    await writeFile(path.join(check.directory, 'result.json'), JSON.stringify({ ...request, pid: process.pid, checkedAt: Date.now(), status: 'ready', evidence }), { mode: 0o600 })
    await assert.rejects(verifyInstallationResult(check), /Invalid or expired installation request/)
  }
  assert.equal(probes, 0)
})
for (const mismatch of ['version', 'executable'] as const) test(`a mismatching ${mismatch} never passes readiness`, async t => {
  const { check, options } = await fixture(t)
  let probes = 0
  await runInstallationCheck(check.filename, { ...options, [mismatch]: mismatch === 'version' ? '9.0.0' : '/bin/sh', probe: async () => { probes++; return evidence } })
  await assert.rejects(verifyInstallationResult(check), /differs from/)
  assert.equal(probes, 0)
})
for (const error of ['renderer crashed', 'IPC handler is unavailable', 'History readiness failed']) test(`${error} is an installation failure`, async t => {
  const { check, options } = await fixture(t)
  await runInstallationCheck(check.filename, { ...options, probe: async () => { throw new Error(error) } })
  await assert.rejects(verifyInstallationResult(check), new RegExp(error))
})
for (const hangs of [false, true]) test(`readiness deadline rejects ${hangs ? 'a stuck IPC request' : 'a blank renderer'}`, async t => {
  const { check, options } = await fixture(t)
  await runInstallationCheck(check.filename, { ...options, timeoutMs: 20, probe: () => hangs ? new Promise(() => {}) : Promise.resolve(null) })
  await assert.rejects(verifyInstallationResult(check), /timed out/)
})
test('shutdown cancels an in-flight readiness check and releases its abort listener', async t => {
  const { check, options } = await fixture(t)
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const work = runInstallationCheck(check.filename, { ...options, signal: controller.signal, probe: () => { started.resolve(); return new Promise(() => {}) } })
  await started.promise
  controller.abort(new Error('Application is quitting'))
  await work
  await assert.rejects(verifyInstallationResult(check), /Application is quitting/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('already cancelled startup does not probe or produce a ready response', async t => {
  const { check, options } = await fixture(t)
  const controller = new AbortController()
  controller.abort(new Error('Already stopped'))
  let probes = 0
  await runInstallationCheck(check.filename, { ...options, signal: controller.signal, probe: async () => { probes++; return evidence } })
  await assert.rejects(verifyInstallationResult(check), /Already stopped/)
  assert.equal(probes, 0)
})
test('invalid collection or history evidence cannot acknowledge success', async t => {
  const { check, options } = await fixture(t)
  await runInstallationCheck(check.filename, { ...options, probe: async () => ({ ...evidence, historyEntries: 26 }) })
  await assert.rejects(verifyInstallationResult(check), /readiness evidence is invalid/)
})
test('stale requests and oversized request files are refused before probing', async t => {
  const { check, options } = await fixture(t)
  await writeFile(check.filename, JSON.stringify({ ...check.request, issuedAt: Date.now() - 120001 }))
  await assert.rejects(runInstallationCheck(check.filename, options), /expired/)
  await writeFile(check.filename, 'x'.repeat(8193))
  await assert.rejects(runInstallationCheck(check.filename, options), /Invalid installation check file/)
})
test('request symlinks, hard links and non-private directories are refused', async t => {
  const { check } = await fixture(t)
  const saved = path.join(check.directory, 'saved.json')
  await writeFile(saved, await readFile(check.filename), { mode: 0o600 })
  await rm(check.filename)
  await symlink(saved, check.filename)
  await assert.rejects(readInstallationJson(check.filename), { code: 'ELOOP' })
  await rm(check.filename)
  await link(saved, check.filename)
  await assert.rejects(readInstallationJson(check.filename), /Invalid installation check file/)
  await rm(saved)
  await chmod(check.directory, 0o755)
  await assert.rejects(readInstallationJson(check.filename), /private directory/)
})
for (const name of ['request.json', 'result.json']) {
  test(`a FIFO at ${name} is rejected without waiting for a writer`, async t => {
    const { check } = await fixture(t)
    const filename = path.join(check.directory, name)
    if (name === 'request.json') await rm(filename)
    await execute('mkfifo', ['-m', '600', filename], { timeout: 1000 })
    // Isolate the reader so a blocking-open regression is killed instead of hanging the test runner's thread pool.
    const reader = `
      import assert from 'node:assert/strict';
      import { readInstallationJson } from ${JSON.stringify(new URL('./installation-check.mts', import.meta.url).href)};
      await assert.rejects(readInstallationJson(process.argv[1]), /Invalid installation check file/);
    `
    await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', reader, filename], {
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024
    })
  })
}
test('a directory in place of a readiness file is rejected', async t => {
  const { check } = await fixture(t)
  await rm(check.filename)
  await mkdir(check.filename, { mode: 0o700 })
  await assert.rejects(readInstallationJson(check.filename), /Invalid installation check file/)
})
test('a published result cannot be replaced by a subsequent check', async t => {
  const { check, options } = await fixture(t)
  await runInstallationCheck(check.filename, options)
  const filename = path.join(check.directory, 'result.json')
  const original = await readFile(filename)
  await assert.rejects(runInstallationCheck(check.filename, options), /already published/)
  assert.deepEqual(await readFile(filename), original)
})
