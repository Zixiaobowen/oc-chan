import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSampler } from './sampler.mjs'
import { readLines, until } from './core.mjs'

const exec = promisify(execFile)
const supported = process.platform === 'darwin' && process.getuid() !== 0 && process.geteuid() !== 0

// Every protocol assertion below exercises the native executable. No authorization
// dialog is opened: the sole admin start is already cancelled before invocation.
describe('native sampler transport', { skip: !supported, timeout: 30000 }, () => {
  let directory, binary
  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'occhan-sampler-test-'))
    binary = path.join(directory, 'process sampler')
    await exec('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', fileURLToPath(new URL('./process-sampler.c', import.meta.url)), '-o', binary], { timeout: 30000 })
    await exec('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', fileURLToPath(new URL('./process-sampler-native.test.c', import.meta.url)), '-o', path.join(directory, 'ancestry-test')], { timeout: 30000 })
  })
  after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

  test('native ancestry rejects unreadable or reused parents while retaining verified setuid descendants', async () => {
    // The native harness asserts actual admission decisions, including the
    // failed-read/PID-reuse combination that cannot be scheduled deterministically.
    await exec(path.join(directory, 'ancestry-test'), [], { timeout: 5000 })
  })

  async function sampler(t, { signal, failure = false } = {}) {
    const handle = await startSampler(binary, { privilege: 'user', signal })
    const observed = { rows: [], diagnostics: [], errors: [] }
    readLines(handle.output, line => observed.rows.push(JSON.parse(line)), error => observed.errors.push(error))
    readLines(handle.errors, line => observed.diagnostics.push(line), error => observed.errors.push(error))
    t.after(async () => {
      if (failure) await assert.rejects(handle.dispose())
      else await handle.dispose()
      assert.throws(() => process.kill(handle.process.pid, 0), { code: 'ESRCH' })
    })
    return { handle, observed }
  }

  async function tree(t) {
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process'
      const app = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
      app.once('error', error => { console.error(error); process.exitCode = 1 })
      app.once('spawn', () => console.log(app.pid))
      process.on('SIGTERM', () => {
        if (app.exitCode !== null || app.signalCode !== null) process.exit(0)
        app.once('exit', () => process.exit(0))
        app.kill('SIGTERM')
      })
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    let appPid, failure
    launcher.once('error', error => { failure = error })
    readLines(launcher.stdout, line => { appPid = Number(line) }, error => { failure = error })
    readLines(launcher.stderr, line => { failure = new Error(line) }, error => { failure = error })
    t.after(async () => {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM')
      await until(() => launcher.exitCode !== null || launcher.signalCode !== null, { timeout: 5000 })
      if (appPid) assert.throws(() => process.kill(appPid, 0), { code: 'ESRCH' })
    })
    await until(() => { if (failure) throw failure; return appPid }, { timeout: 5000 })
    return { launcher, appPid }
  }

  test('ready identifies the ordinary owner and keeps final resource rows after stop', async t => {
    const { launcher, appPid } = await tree(t)
    const { handle, observed } = await sampler(t)
    assert.deepEqual(handle.identity, {
      pid: handle.process.pid, effectiveUid: process.geteuid(),
      ownerPid: process.pid, ownerUid: process.getuid()
    })
    assert.equal(handle.input, handle.process.stdin)
    assert.equal(handle.output, handle.process.stdout)
    handle.input.write(`roots ${appPid} ${launcher.pid}\nstop\n`)
    await until(() => handle.process.exitCode !== null, { timeout: 5000 })
    await handle.dispose()
    assert.equal(handle.process.exitCode, 0)
    assert.deepEqual(observed.errors, [])
    assert.deepEqual(observed.diagnostics, [])
    assert.equal(observed.rows.length, 2)
    for (const row of observed.rows) {
      assert.equal(row.type, 'resources')
      assert.ok(row.app.some(item => item.pid === appPid))
      assert.ok(row.development.some(item => item.pid === launcher.pid))
      assert.ok(![...row.app, ...row.development].some(item => [process.pid, handle.identity.pid].includes(item.pid)))
      assert.equal(row.coverage.scope, 'observedProcessesOnly')
    }
  })

  test('explicit associated identities are birth checked and never zero-fill reused PIDs', async t => {
    const { launcher, appPid } = await tree(t)
    const { handle, observed } = await sampler(t)
    handle.input.write(`roots ${appPid} ${launcher.pid}\n`)
    const first = await until(() => observed.rows.find(row => row.type === 'resources'), { timeout:5000 })
    const identity = first.app.find(row => row.pid === appPid)
    const [seconds,microseconds] = identity.startId.split(':')
    handle.input.write(`xpc-reset\nxpc ${appPid} ${seconds} ${microseconds}\n`)
    const associated = await until(() => observed.rows.find(row => row.associated?.length === 1), { timeout:5000 })
    assert.equal(associated.associated[0].startId,identity.startId)
    assert.equal(associated.associated[0].mayBeShared,true)
    assert(associated.associated[0].rssBytes > 0)
    const wrong = `${Number(seconds)+1}:${microseconds}`
    handle.input.write(`xpc-reset\nxpc ${appPid} ${Number(seconds)+1} ${microseconds}\n`)
    const stale = await until(() => observed.rows.find(row => row.associated?.[0]?.startId === wrong), { timeout:5000 })
    assert.equal(stale.associated[0].rssBytes,null)
    assert.equal(stale.associated[0].cpuNs,null)
    assert.notEqual(stale.associated[0].sampleErrors.identity,0)
  })

  test('dispose stops a live idle sampler and is idempotent', async t => {
    const listeners = process.listenerCount('exit')
    const { handle, observed } = await sampler(t)
    const first = handle.dispose()
    assert.equal(handle.dispose(), first)
    await first
    assert.equal(handle.process.exitCode, 0)
    assert.equal(process.listenerCount('exit'), listeners)
    assert.deepEqual(observed.diagnostics, [])
  })

  for (const target of ['owner', 'system', 'sibling']) {
    test(`rejects ${target} as an application root outside the launcher's tree`, async t => {
      const { launcher } = await tree(t)
      const { handle, observed } = await sampler(t, { failure: true })
      let pid = target === 'owner' ? process.pid : 1
      if (target === 'sibling') pid = (await tree(t)).appPid
      handle.input.write(`roots ${pid} ${launcher.pid}\n`)
      await until(() => observed.diagnostics.length, { timeout: 5000 })
      assert.match(observed.diagnostics.join('\n'), /roots/)
      await assert.rejects(handle.dispose())
      assert.notEqual(handle.process.exitCode, 0)
      assert.equal(observed.rows.length, 0)
    })
  }

  for (const [name, input, message] of [
    ['unknown command', 'sample\n', /invalid protocol command/],
    ['non-ASCII input', 'roots \u0000\n', /non-ASCII/],
    ['oversized command', `${'x'.repeat(128)}\n`, /line limit/]
  ]) {
    test(`reports ${name} and terminates the native sampler`, async t => {
      const { handle, observed } = await sampler(t, { failure: true })
      handle.input.write(input)
      await until(() => observed.diagnostics.length, { timeout: 5000 })
      assert.match(observed.diagnostics.join('\n'), message)
      await assert.rejects(handle.dispose())
      assert.notEqual(handle.process.exitCode, 0)
    })
  }

  test('cancellation terminates the owned process and reports its reason', async t => {
    const controller = new AbortController()
    const listeners = process.listenerCount('exit')
    const { handle, observed } = await sampler(t, { signal: controller.signal, failure: true })
    controller.abort(new Error('test measurement cancelled'))
    await assert.rejects(handle.dispose(), /test measurement cancelled/)
    assert.ok(observed.errors.some(error => /test measurement cancelled/.test(String(error))))
    assert.equal(process.listenerCount('exit'), listeners)
  })

  test('pre-cancelled admin mode opens no authorization session or private socket', async () => {
    const sockets = async () => (await readdir('/tmp')).filter(name => name.startsWith('oc-chan-sampler-')).sort()
    const previous = await sockets()
    const listeners = process.listenerCount('exit')
    const controller = new AbortController()
    controller.abort(new Error('cancel before authorization'))
    await assert.rejects(startSampler(binary, { privilege: 'admin', signal: controller.signal }), /cancel before authorization/)
    assert.deepEqual(await sockets(), previous)
    assert.equal(process.listenerCount('exit'), listeners)
  })

  test('cancel during startup releases the native child and lifecycle listener', async () => {
    const controller = new AbortController()
    const listeners = process.listenerCount('exit')
    const started = startSampler(binary, { privilege: 'user', signal: controller.signal })
    controller.abort(new Error('cancel before handshake'))
    await assert.rejects(started, /cancel before handshake/)
    assert.equal(process.listenerCount('exit'), listeners)
  })

  test('missing binary rejects startup and releases its lifecycle listener', async () => {
    const listeners = process.listenerCount('exit')
    await assert.rejects(startSampler(path.join(directory, 'missing'), { privilege: 'user' }), /ENOENT/)
    assert.equal(process.listenerCount('exit'), listeners)
  })

  test('privilege must be explicit and native admin mode refuses an unprivileged invocation', async () => {
    await assert.rejects(startSampler(binary), /explicitly/)
    await assert.rejects(startSampler(binary, { privilege: 'automatic' }), /explicitly/)
    await assert.rejects(exec(binary, ['--connect', path.join(directory, 'unavailable.sock'), String(process.pid), 'a'.repeat(64)], { timeout: 5000 }), error => {
      assert.match(error.stderr, /requires administrator privileges/)
      return true
    })
  })
})
