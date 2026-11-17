import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, lstat, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { prepareSmokeFixtures } from './performance/agent-fixtures.mjs'
import { exerciseGpui } from './smoke/gpui-scenarios.mjs'
import { createMarketFeed } from './smoke/marketplace-feed.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export class Driver {
  static async open(receipt) {
    assert.equal(receipt.protocol, 'OC_CHAN_GPUI_ACCEPTANCE_V1')
    assert(Number.isSafeInteger(receipt.pid) && receipt.pid > 0)
    assert.match(receipt.driverDirectory, new RegExp(`^/tmp/ocgpui-${receipt.pid}-[a-f0-9]{12}$`))
    const directory = await lstat(receipt.driverDirectory)
    assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700)
    const tokenPath = path.join(receipt.driverDirectory, 'token'), info = await lstat(tokenPath)
    assert(info.isFile() && !info.isSymbolicLink() && info.size === 64 && (info.mode & 0o777) === 0o600)
    const token = await readFile(tokenPath, 'utf8'); assert.match(token, /^[a-f0-9]{64}$/)
    return new Driver(receipt, token)
  }
  constructor(receipt, token) { this.receipt = receipt; this.token = token; this.sequence = 0; this.pending = 0; this.closed = false }
  async request(command, args = {}) {
    assert(!this.closed && this.pending < 4, 'Driver is closed or busy'); this.pending++
    try {
      return await new Promise((resolve, reject) => {
        const id = ++this.sequence, socket = connect(path.join(this.receipt.driverDirectory, 'driver.sock'))
        let bytes = 0, chunks = [], settled = false
        const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value) }
        socket.setTimeout(20000, () => finish(new Error('GPUI driver request deadline')))
        socket.on('error', error => finish(error))
        socket.on('connect', () => socket.write(JSON.stringify({ ...args, id, token: this.token, command }) + '\n'))
        socket.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 1024 * 1024) return finish(new Error('GPUI driver output exceeds budget'))
          chunks.push(chunk)
          if (!chunk.includes(10)) return
          try {
            const response = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(response.id, id)
            if (!response.result?.ok) throw new Error(response.result?.error ?? 'GPUI request failed')
            finish(null, response.result.value)
          } catch (error) { finish(error) }
        })
        socket.on('end', () => { if (!settled) finish(new Error('GPUI driver disconnected')) })
      })
    } finally { this.pending-- }
  }
  close() { this.closed = true }
}
async function until(action, timeout = 60000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { const result = await action(); if (result) return result } catch (error) { if (error.fatal) throw error; last = error }
    await delay(100)
  }
  throw new Error('GPUI readiness deadline', { cause: last })
}
export async function smoke({ output, scenario = 'all', ...unsupported } = {}) {
  assert.deepEqual(Object.keys(unsupported), [], 'Smoke only owns instances created by this invocation')
  assert(['all', 'basic', 'marketplace', 'topology', 'notifications', 'collectors', 'sidebar', 'schedules'].includes(scenario), 'Unknown GPUI scenario')
  output ??= await mkdtemp(path.join(os.tmpdir(), 'oc-gpui-evidence-'))
  await mkdir(output, { recursive: true, mode: 0o700 })
  output = await realpath(output)
  const fixtureDirectory = path.join(output, 'fixtures'); await mkdir(fixtureDirectory, { mode: 0o700 })
  const manifest = await prepareSmokeFixtures(fixtureDirectory)
  const result = { renderer: 'gpui-metal', scenario, complete: false, visibleWindowAcceptance: false, screenshots: [], checks: [], errors: [] }
  let evidenceBytes = 0
  const record = (name, details) => {
    const bytes = Buffer.byteLength(JSON.stringify({ name, details }))
    assert(result.checks.length < 512 && bytes <= 1024 * 1024 && evidenceBytes + bytes <= 32 * 1024 * 1024, 'Smoke evidence exceeds its explicit record/byte budget')
    evidenceBytes += bytes; result.checks.push({ name, details })
  }
  let feed
  let startupEnvironment
  let instance, driver, active, buildBytes, settingsBytes, corrupted = false, failure
  const runs = []
  const deadline = async (promise, milliseconds, message) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  function hidden(state) {
    assert.equal(state.native.visible, false); assert.equal(state.native.key, false)
    assert.equal(state.native.appActive, false); assert.equal(state.native.activationPolicy, 2)
    return state
  }
  async function launch(name, recovery = false, cleanupInstance = false) {
    const resumed = Boolean(instance)
    const run = { name, log: '', receipt: null, exit: null, failure: null }
    runs.push(run); active = run
    run.child = spawn(process.execPath, ['scripts/develop.mjs', ...(cleanupInstance ? [] : ['--no-cleanup']), ...(resumed ? ['--resume-instance', instance] : [])], {
      cwd: root, env: { ...startupEnvironment, ...(recovery ? { OC_CHAN_ACCEPTANCE_RECOVERY: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    run.completion = new Promise(resolve => run.child.once('close', (code, signal) => { run.exit = { code, signal }; resolve(run.exit) }))
    run.child.once('error', error => { run.failure = error })
    for (const stream of [run.child.stdout, run.child.stderr]) {
      let buffered = ''
      stream.on('data', chunk => {
        const text = chunk.toString(); run.log += text; process.stdout.write(text); buffered += text
        if (Buffer.byteLength(run.log) > 8 * 1024 * 1024) { run.failure = new Error('Launcher log exceeds budget'); run.log = run.log.slice(-1024 * 1024) }
        if (buffered.length > 256 * 1024) { run.failure = new Error('Launcher line exceeds budget'); buffered = ''; return }
        let end
        while ((end = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
          try {
            const match = /^\[oc-chan\] 独立 Rust 实例：(.*)$/.exec(line)
            if (match) {
              const owned = match[1]
              assert.equal(path.dirname(owned), path.join(root, '.dev-instances'))
              assert.match(path.basename(owned), /^instance-[\w-]+$/)
              if (instance) assert.equal(owned, instance)
              else instance = owned
              run.instance = owned
            }
            if (line.startsWith('{')) {
              const parsed = JSON.parse(line)
              if (parsed.driverDirectory) { assert(!run.receipt, 'Duplicate driver receipt'); run.receipt = parsed }
              if (parsed.developmentStage === 'build-complete') { assert.equal(parsed.instance, instance); assert.equal(parsed.resumed, resumed); run.buildReady = true }
            }
          } catch (error) { run.failure = error }
        }
      })
    }
    await until(() => {
      if (run.failure) throw Object.assign(run.failure, { fatal: true })
      if (run.exit) throw Object.assign(new Error(`Launcher exited ${JSON.stringify(run.exit)}`), { fatal: true })
      return run.receipt && run.instance && run.buildReady
    }, resumed ? 120000 : 1200000)
    driver = await Driver.open(run.receipt); run.driver = driver
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(run.receipt.pid), '-o', 'ppid='], { timeout: 2000, maxBuffer: 4096 })
    assert.equal(Number(stdout.trim()), run.child.pid, 'Driver must belong to this launcher child')
    const currentBuild = await readFile(path.join(instance, 'build.json'))
    if (buildBytes) assert.deepEqual(currentBuild, buildBytes, 'Restart must reuse the identical build receipt')
    else buildBytes = currentBuild
    record(`${name}-receipt`, { launcherPid: run.child.pid, receipt: run.receipt, instance, resumed })
  }
  async function stop() {
    await driver.request('quit'); driver.close()
    await deadline(active.completion, 30000, 'Owned launcher did not drain')
    assert.deepEqual(active.exit, { code: 0, signal: null })
    if (active.failure) throw active.failure
    await assert.rejects(lstat(active.receipt.driverDirectory), { code: 'ENOENT' })
    record(`${active.name}-stopped`, { exit: active.exit, driverDirectoryRemoved: true })
  }
  async function settingsState(expected) {
    await until(async () => { const state = hidden(await driver.request('inspect')); return state.ui?.settingsLoaded && state })
    await driver.request('navigate', { page: 'settings' })
    const state = await until(async () => { const value = hidden(await driver.request('inspect')); return value.ui?.page === 'settings' && value.ui?.settings?.settings && value })
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(state.ui.settings.settings[key], value, `Restart UI ${key}`)
    record(`${active.name}-settings`, state)
  }
  try {
    feed = ['all', 'marketplace'].includes(scenario) ? await createMarketFeed(path.join(output, 'market-fixtures'), { record }) : null
    startupEnvironment = { ...process.env, OC_CHAN_HOME: manifest.home,
      ...(scenario === 'schedules' ? { OC_CHAN_ACCEPTANCE_SCHEDULE_DETAIL: '1' } : {}),
      ...(feed ? { OC_CHAN_ACCEPTANCE_MARKET_FIXTURES: JSON.stringify(feed.startupRoots()) } : {}) }
    delete startupEnvironment.OC_CHAN_ACCEPTANCE_RECOVERY
    await launch('initial', false, scenario === 'schedules')
    const first = await until(async () => { const value = await driver.request('inspect'); return value.ui?.settingsLoaded && value })
    assert.equal(first.native.visible, false); assert.equal(first.native.key, false); assert.equal(first.native.appActive, false); assert.equal(first.native.activationPolicy, 2)
    record('real-hidden-gpui-view', first)
    const glyphPath = path.join(instance, 'native-text-probe.png')
    const glyph = await driver.request('text-probe', { path: glyphPath })
    assert(glyph.probe.paintSucceeded && glyph.probe.manualLine.glyphCount > 0 && glyph.probe.directAscii.metrics.glyphCount > 0, 'Native GPUI text system did not paint real glyphs')
    assert.equal(glyph.probe.native.visible, false); assert.equal(glyph.probe.native.key, false)
    await copyFile(glyphPath, path.join(output, 'native-text-probe.png')); record('real-native-glyphs', glyph.probe)
    await until(async () => { const state = await driver.request('inspect'); const seen = new Set(state.ui?.agents?.map(agent => agent.id)); return manifest.agentIds.every(id => seen.has(id)) })
    const pages = scenario === 'schedules' ? ['schedules'] : scenario === 'marketplace' ? ['plugins', 'settings'] : scenario === 'topology' ? ['agents'] : ['overview', 'agents', 'schedules', 'events', 'sources', 'settings', 'plugins']
    for (const [width, height] of [[1280, 860], [880, 640]]) {
      await driver.request('resize', { width, height })
      for (const page of pages) {
        await driver.request('navigate', { page })
        const state = await until(async () => { const value = await driver.request('inspect'); return value.ui?.page === page && value })
        assert.equal(state.native.visible, false); assert.equal(state.native.key, false); assert.equal(state.native.appActive, false); assert.equal(state.native.activationPolicy, 2)
        const name = `${page}-${width}x${height}.png`, capture = path.join(instance, name)
        await driver.request('capture', { path: capture })
        await copyFile(capture, path.join(output, name))
        const image = await readFile(path.join(output, name)); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        result.screenshots.push(name); record(`${page}-${width}`, state)
      }
    }
    const expectedSettings = await exerciseGpui({ driver, instance, output, manifest, scenario, feed, record })
    if (scenario === 'schedules') {
      await stop()
      await assert.rejects(lstat(instance), { code: 'ENOENT' })
      result.complete = true
      return result
    }
    settingsBytes = await readFile(path.join(instance, 'profile/settings.json'))
    assert(settingsBytes.length <= 64 * 1024, 'Settings file exceeds budget')
    const saved = JSON.parse(settingsBytes)
    for (const [key, value] of Object.entries(expectedSettings)) assert.deepEqual(saved[key], value, `Persisted ${key}`)
    result.expectedSettings = expectedSettings
    await driver.request('open', { view: 'tray' })
    const tray = await until(async () => { const value = await driver.request('inspect', { view: 'tray' }); return value.ui && value })
    hidden(tray); record('tray-view', tray)
    await stop()
    await launch('restart')
    await settingsState(expectedSettings)
    await stop()
    const settingsPath = path.join(instance, 'profile/settings.json')
    const profile = await lstat(path.dirname(settingsPath)), settingsFile = await lstat(settingsPath)
    assert(profile.isDirectory() && !profile.isSymbolicLink() && profile.uid === process.getuid())
    assert(settingsFile.isFile() && !settingsFile.isSymbolicLink() && settingsFile.uid === process.getuid())
    assert.equal(await realpath(settingsPath), settingsPath)
    await writeFile(path.join(output, 'settings-valid.json'), settingsBytes, { mode: 0o600 })
    corrupted = true
    await writeFile(settingsPath, '{"invalid":', { mode: 0o600 })
    await launch('recovery', true)
    const recovery = await until(async () => {
      const state = hidden(await driver.request('inspect', { view: 'recovery' }))
      return state.ui?.buttons?.recovery_retry && state.ui?.buttons?.recovery_quit && state
    })
    record('recovery-real-view', recovery)
    const capture = path.join(instance, 'recovery-failure.png')
    await driver.request('capture', { view: 'recovery', path: capture })
    await copyFile(capture, path.join(output, 'recovery-failure.png'))
    assert.equal((await readFile(capture)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    result.screenshots.push('recovery-failure.png')
    await writeFile(settingsPath, settingsBytes); corrupted = false
    const rect = recovery.ui.buttons.recovery_retry
    assert(rect.width > 0 && rect.height > 0)
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    assert(point.x > 0 && point.x < recovery.native.width && point.y > 0 && point.y < recovery.native.height)
    for (const kind of ['move', 'down', 'up']) await driver.request('mouse', { view: 'recovery', ...point, kind })
    await settingsState(expectedSettings)
    record('recovery-native-retry', { button: 'recovery_retry', nativeMouseEvents: 3 })
    await stop()
    await launch('cleanup', false, true)
    await settingsState(expectedSettings)
    await stop()
    await assert.rejects(lstat(instance), { code: 'ENOENT' })
    result.complete = true
  } catch (error) {
    failure = error; result.errors.push(error.stack)
    if (driver && !driver.closed && active?.driver === driver) {
      const view = active.name === 'recovery' && corrupted ? 'recovery' : 'main'
      try {
        const state = await driver.request('inspect', { view })
        await writeFile(path.join(output, `${active.name}-failed.json`), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
        const capture = path.join(instance, `${active.name}-failed.png`)
        await driver.request('capture', { view, path: capture })
        await copyFile(capture, path.join(output, `${active.name}-failed.png`))
      } catch (diagnostic) { result.errors.push(diagnostic.stack); failure = new AggregateError([failure, diagnostic], 'Smoke and failure capture failed') }
    }
  }
  finally {
    const cleanupErrors = []
    const cleanup = async action => { try { await action() } catch (error) { cleanupErrors.push(error); result.errors.push(error.stack ?? String(error)) } }
    if (active && !active.exit) {
      if (driver && !driver.closed) await cleanup(async () => { await driver.request('quit'); driver.close(); await deadline(active.completion, 30000, 'Owned application shutdown deadline') })
      if (!active.exit) await cleanup(async () => { active.child.kill('SIGTERM'); await deadline(active.completion, 35000, 'Owned development launcher failed to drain; preserving instance') })
    }
    driver?.close()
    if (active?.receipt) await cleanup(() => assert.rejects(lstat(active.receipt.driverDirectory), { code: 'ENOENT' }))
    if (corrupted && active?.exit) await cleanup(() => writeFile(path.join(instance, 'profile/settings.json'), settingsBytes))
    await cleanup(() => deadline(manifest.stopAgents(), 30000, 'Fixture shutdown deadline'))
    if (feed) { await cleanup(async () => { result.feed = feed.evidence() }); await cleanup(() => deadline(feed.close(), 30000, 'Feed shutdown deadline')) }
    if (cleanupErrors.length) { result.complete = false; failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Smoke and cleanup failed') }
    result.runs = runs.map(run => ({ name: run.name, instance: run.instance, launcherPid: run.child.pid, receipt: run.receipt, exit: run.exit }))
    await cleanup(() => writeFile(path.join(output, 'launcher.log'), runs.map(run => `\n[${run.name}]\n${run.log}`).join(''), { mode: 0o600 }))
    await cleanup(() => writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }))
    if (cleanupErrors.length) { result.complete = false; failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Smoke evidence or cleanup failed') }
    console.log(JSON.stringify({ complete: result.complete, evidence: output, errors: result.errors }))
  }
  if (failure) throw failure
  return result
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1]
    assert(['--scenario', '--out'].includes(key) && value, 'Usage: smoke-renderer.mjs [--scenario NAME] [--out DIR]')
    options[key === '--out' ? 'output' : 'scenario'] = value
  }
  smoke(options).catch(error => { console.error(error); process.exitCode = 1 })
}
