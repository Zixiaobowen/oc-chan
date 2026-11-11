import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promisify, inspect } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvidenceLog, readLines, until } from './performance/core.mjs'
import { Driver, boundedFile, absent, prepareSmokeFixtures } from './smoke/main-probe.mjs'
import { exerciseSmoke, verifyRestart, exerciseRecovery } from './smoke/scenarios.mjs'
import { cleanupDevelopmentInstance } from './local-app-lifecycle.mjs'
import { createMarketFeed } from './smoke/marketplace-feed.mjs'

const root = fileURLToPath(new URL('..', import.meta.url)), exec = promisify(execFile)
const limits = Object.freeze({ totalMs: 1200000, buildMs: 600000, startupMs: 300000, scenarioMs: 360000, restartMs: 60000,
  logBytes: 8 * 1024 * 1024, records: 16384, screenshots: 64, screenshotBytes: 1024 * 1024, settingsBytes: 64 * 1024 })
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--fault', '--out', '--scenario'].includes(key) || !process.argv[index + 1] || Object.hasOwn(options, key)) throw new Error('Usage: node scripts/smoke-renderer.mjs [--scenario all|notifications|topology|marketplace|collectors|sidebar] [--fault fixture|ipc] [--out NEW_DIRECTORY]')
  options[key] = process.argv[index + 1]
}
const scenario = options['--scenario'] ?? 'all', fault = options['--fault'] ?? null
assert(['all', 'notifications', 'topology', 'marketplace', 'collectors', 'sidebar'].includes(scenario), 'Unknown smoke scenario')
assert(fault === null || scenario === 'all' && ['fixture', 'ipc'].includes(fault), 'Unknown or incompatible fault')
assert(process.platform === 'darwin' && process.arch === 'arm64', 'WK smoke requires macOS arm64')
const output = options['--out'] ? path.resolve(options['--out']) : await mkdtemp(path.join(os.tmpdir(), 'oc-chan-smoke-evidence-'))
if (options['--out']) await mkdir(output, { mode: 0o700 })
const log = new EvidenceLog(path.join(output, 'evidence'), { maxBytes: limits.logBytes, chunkBytes: 1024 * 1024 })
await log.initialize()
const result = { schema: 2, startedAt: new Date().toISOString(), complete: false, scenario, fault, limits,
  scope: { execution: 'real hidden Tauri/WKWebView + React + Rust IPC', input: 'AppKit responder mouse/key/text; native select controls and time drafts explicitly use DOM setters',
    fixtures: 'owned live descriptor processes, JSONL/JSON/plist and SQLite files read by production Rust collectors',
    nativeVisibleWindowAcceptance: false, osNotificationDelivery: false, marketplaceUpgradeRollback: ['all','marketplace'].includes(scenario) ? 'real signed Rust versions and bounded loopback HTTP through production worker' : 'not selected' }, stages: [], runs: [], errors: [], cleanup: {} }
const abort = new AbortController()
let current, manifest, feed, work, count = 0, screenshotCount = 0
const runningStages = new Set()
const retainedInstances = new Set()
const fail = error => { if (!abort.signal.aborted) abort.abort(error instanceof Error ? error : new Error(String(error))) }
const message = error => inspect(error, { depth: 4, maxArrayLength: 8, maxStringLength: 4096, customInspect: false }).slice(0, 16384)
function record(name, details) {
  assert(++count <= limits.records && name.length <= 160, 'Evidence count/name limit')
  const row = { at: new Date().toISOString(), run: current?.label ?? null, name, details }
  assert(Buffer.byteLength(JSON.stringify(row)) <= 256 * 1024, 'Evidence row limit')
  void log.append(row).catch(fail)
}
async function deadline(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function stage(name, ms, action) {
  abort.signal.throwIfAborted()
  const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; result.stages.push(entry)
  let onAbort
  const operation = Promise.resolve().then(action)
  runningStages.add(operation)
  operation.then(() => runningStages.delete(operation), () => runningStages.delete(operation))
  try {
    const value = await deadline(Promise.race([operation, new Promise((_, reject) => {
      onAbort = () => reject(abort.signal.reason); abort.signal.addEventListener('abort', onAbort, { once: true })
    })]), ms, name)
    entry.status = 'passed'; return value
  } catch (error) {
    fail(error)
    if (runningStages.has(operation)) {
      current?.driver?.close()
      try { await operation }
      catch (drainError) { if (drainError !== error) error = new AggregateError([error, drainError], `${name}: failure and owned operation drainage`) }
    }
    entry.status = 'failed'; entry.error = message(error); throw error
  }
  finally { abort.signal.removeEventListener('abort', onAbort); entry.finishedAt = new Date().toISOString(); record(name, entry) }
}
async function capture(name, view = 'main') {
  assert(current?.driver && ++screenshotCount <= limits.screenshots, 'Screenshot admission exceeded')
  const image = await current.driver.view(view).capture()
  assert(typeof image.pngBase64 === 'string' && image.pngBase64.length <= Math.ceil(limits.screenshotBytes / 3) * 4, 'Screenshot response exceeded limit')
  const bytes = Buffer.from(image.pngBase64, 'base64')
  assert(bytes.length <= limits.screenshotBytes && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a', 'Invalid WK PNG')
  const filename = `${String(screenshotCount).padStart(2,'0')}-${current.label}-${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.png`
  await writeFile(path.join(output, filename), bytes, { flag: 'wx', mode: 0o600 })
  record('native-wk-snapshot', { file: filename, width: image.width, height: image.height, bytes: bytes.length, view })
}
async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  const rows = stdout.trim().split('\n'); assert(rows.length <= 16384, 'Process enumeration limit')
  return rows.map(line => { const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line); assert(match, 'Invalid process identity'); return { pid: Number(match[1]), parent: Number(match[2]), birth: match[3], command: match[4] } })
}
class Instance {
  constructor(label) { this.label = label; this.stopping = false; this.exited = false; this.evidence = { label }; result.runs.push(this.evidence) }
  async build(settingsSeed, recovery = false, resumeInstance = null) {
    this.keep = !recovery && scenario !== 'collectors'
    const env = { ...process.env, OC_CHAN_HEADLESS: '1', OC_CHAN_SMOKE: '1', OC_CHAN_HOME: manifest.home, OC_CHAN_ACCEPTANCE_RECOVERY: recovery ? '1' : '0' }
    delete env.OC_CHAN_ACCEPTANCE_SETTINGS
    delete env.OC_CHAN_ACCEPTANCE_MARKET_FIXTURES
    if (feed) env.OC_CHAN_ACCEPTANCE_MARKET_FIXTURES = JSON.stringify(feed.startupRoots())
    if (settingsSeed) env.OC_CHAN_ACCEPTANCE_SETTINGS = settingsSeed
    const args = ['run', 'dev']
    if (this.keep || resumeInstance) args.push('--', ...(resumeInstance ? ['--resume-instance', resumeInstance] : []), ...(this.keep ? ['--no-cleanup'] : []))
    this.launcher = spawn('npm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.launcher.once('error', fail)
    this.completion = new Promise(resolve => this.launcher.once('close', (code, signal) => {
      this.exited = true; this.exit = { code, signal }; resolve(this.exit)
      if (!this.stopping) fail(new Error(`Owned npm dev exited unexpectedly: ${signal ?? code}`))
    }))
    const consume = line => {
      const instance = /^\[oc-chan\] 独立 Rust 实例：(.*)$/.exec(line)
      if (instance) {
        assert.equal(path.dirname(instance[1]), path.join(root, '.dev-instances'))
        assert.match(path.basename(instance[1]), /^instance-[a-zA-Z0-9]+$/)
        assert(!this.instance || this.instance === instance[1], 'Development instance identity changed')
        this.instance = instance[1]
        if (this.keep) retainedInstances.add(this.instance)
      }
      if (line.startsWith('{')) {
        let value
        try { value = JSON.parse(line) } catch (error) { throw new Error('Invalid application JSON evidence', { cause: error }) }
        if (value.developmentStage !== undefined) {
          assert.equal(value.developmentStage, 'build-complete', 'Unknown development lifecycle signal')
          assert.equal(value.instance, this.instance, 'Build completion must belong to this instance')
          assert.equal(value.resumed, resumeInstance !== null, 'Build completion resume mode mismatch')
          assert.equal(this.buildCompletedAt, undefined, 'Duplicate build completion')
          this.buildCompletedAt = performance.now()
          record('development-build-complete', value)
        }
        if (value.driverDirectory) { assert(!this.receipt, 'Driver restarted unexpectedly'); this.receipt = value }
        if (value.shutdownReport) this.shutdownReport = value.shutdownReport
      }
      record('launcher', { line })
    }
    readLines(this.launcher.stdout, consume, fail); readLines(this.launcher.stderr, consume, fail)
    // Match the existing performance harness's bounded cold-build budget.
    await until(() => this.buildCompletedAt !== undefined, { timeout: limits.buildMs, signal: abort.signal })
  }
  async start(recovery = false) {
    assert(this.buildCompletedAt !== undefined, 'Application startup requires verified build completion')
    await until(() => this.instance && this.receipt, { timeout: limits.startupMs, signal: abort.signal })
    this.driver = await Driver.open(this.receipt, record)
    this.renderer = this.driver.view(recovery ? 'recovery' : 'main')
    this.appIdentity = (await processes()).find(row => row.pid === this.receipt.pid)
    assert(this.appIdentity, 'Native application identity is missing')
    await this.driver.waitForView(recovery ? 'recovery' : 'main', { timeout: 60000, signal: abort.signal })
    await until(() => this.renderer.evaluate(recovery ? 'Boolean(window.startupRecovery && document.querySelector("main"))' : 'Boolean(window.monitor && window.desktopSettings && document.querySelector(".app-shell"))'), { timeout: 60000, signal: abort.signal })
    if (!recovery) {
      const info = await this.driver.host('info'); assert.equal(info.profile, path.join(this.instance, 'profile')); assert.equal(info.home, manifest.home)
      await this.driver.host('shutdown-report')
    }
    await this.hidden(recovery ? 'recovery' : 'main')
    this.evidence.instance = this.instance; this.evidence.driverDirectory = this.receipt.driverDirectory; this.evidence.pid = this.receipt.pid
  }
  async hidden(view = 'main') {
    const native = await this.driver.view(view).inspect()
    assert.equal(native.visible, false); assert.equal(native.key, false); assert.equal(native.appActive, false); assert.equal(native.activationPolicy, 2)
    assert.deepEqual(native.inactiveScheduling, { supported: true, policy: 'none', value: 2 }, 'Headless acceptance requires active WebKit scheduling (macOS 14+)')
    record('headless-invariant', { view, native }); return native
  }
  async quit() {
    this.stopping = true
    await this.driver.request('quit')
    this.driver.close()
    await deadline(this.completion, 30000, 'owned instance exit')
    assert.deepEqual(this.exit, { code: 0, signal: null }, 'npm dev did not exit normally')
    await this.confirmCleanup()
  }
  async confirmCleanup() {
    assert.equal(await absent(this.instance), !this.keep, this.keep ? 'Retained restart instance disappeared' : 'Development profile was not removed by its launcher')
    assert(await absent(this.receipt.driverDirectory), 'WK socket/token directory survived shutdown')
    const alive = (await processes()).find(row => row.pid === this.receipt.pid && row.birth === this.appIdentity.birth)
    assert(!alive, 'Owned native application is still alive')
    assert(this.shutdownReport, 'Host omitted the requested shutdown resource receipt')
    this.evidence.shutdownReport = this.shutdownReport
    assert.equal(this.shutdownReport.documents, 0, 'Host retained document owners after shutdown')
    assert.equal(this.shutdownReport.requests, 0, 'Host retained admitted requests after shutdown')
    for (const value of Object.values(this.shutdownReport.resources.global.current)) assert.equal(value, 0, 'Host retained a resource reservation')
    this.evidence.cleanup = { launcherExited: this.exited, applicationExited: true, profileRetainedForRestart: this.keep, profileRemoved: !this.keep, driverRemoved: true }
  }
  async cleanup() {
    this.stopping = true
    const errors = []
    if (!this.exited && this.driver && !this.driver.closed) {
      try { await this.quit() } catch (error) { errors.push(error) }
    }
    this.driver?.close()
    if (!this.exited) {
      // Signal only the actual develop.mjs descendant of our own npm process.
      // Its ownership-aware shutdown drains its detached build/application children.
      try {
        const rows = await processes(), descendants = new Set([this.launcher.pid])
        for (let pass = 0; pass < 8; pass++) for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid)
        const developers = rows.filter(row => descendants.has(row.pid) && /(?:^|\s)(?:\S*\/)?scripts\/develop\.mjs(?:\s|$)/.test(row.command))
        assert.equal(developers.length, 1, 'Cannot identify the owned developer process; preserving instance')
        const developer = developers[0], current = (await processes()).find(row => row.pid === developer.pid)
        assert.equal(current?.birth, developer.birth, 'Developer process identity changed')
        process.kill(developer.pid, 'SIGTERM')
        await deadline(this.completion, 20000, 'owned developer drain')
      } catch (error) { errors.push(error) }
    }
    if (this.exited && this.instance && this.receipt && this.appIdentity) {
      try { await this.confirmCleanup() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned instance cleanup failed')
  }
}
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.once(signal, () => fail(new Error(`Smoke interrupted: ${signal}`)))
const timer = setTimeout(() => fail(new Error('Smoke total deadline exceeded')), limits.totalMs)
try {
  console.log(`[smoke] 证据目录：${output}`)
  work = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-smoke-work-'))
  work = await realpath(work)
  const fixtures = path.join(work, 'fixtures'); await mkdir(fixtures, { mode: 0o700 })
  manifest = await stage('prepare-real-fixtures', 60000, () => prepareSmokeFixtures(fixtures))
  record('fixture-identities', { home: manifest.home, agents: manifest.agentIds, pids: manifest.agentPids, historyRows: manifest.historyRows })
  if (['all','marketplace'].includes(scenario)) feed = await stage('build-signed-market-fixtures', 300000, () => createMarketFeed(path.join(work, 'market-fixtures'), { signal: abort.signal, record }))
  current = new Instance('first')
  await stage('first-build', limits.buildMs, () => current.build())
  await stage('first-startup', limits.startupMs - (performance.now() - current.buildCompletedAt), () => current.start())
  await capture('startup')
  const exercised = await stage('real-wk-scenarios', limits.scenarioMs, () => exerciseSmoke({ main: current.driver, renderer: current.renderer, manifest, record, capture, fault, scenario, feed }))
  assert(!fault, `Injected ${fault} fault did not fail its mandatory assertion`)
  if (scenario !== 'collectors') {
    assert(exercised?.settings && Object.keys(exercised.settings).length, 'Scenario omitted expected persisted settings')
    const bytes = await boundedFile(path.join(current.instance, 'profile/settings.json'), limits.settingsBytes)
    const saved = JSON.parse(bytes.toString('utf8'))
    for (const [key, value] of Object.entries(exercised.settings)) assert.deepEqual(saved[key], value, `Persisted setting mismatch: ${key}`)
    const seed = path.join(output, 'saved-settings.json'); await writeFile(seed, bytes, { flag: 'wx', mode: 0o600 })
    record('settings-file', { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    const first = current.instance
    await stage('first-exit', 30000, () => current.quit())
    current = new Instance('restart')
    await stage('restart-build', limits.buildMs, () => current.build(undefined, false, first))
    await stage('restart-startup', limits.startupMs - (performance.now() - current.buildCompletedAt), () => current.start())
    assert.equal(current.instance, first, 'Restart must reopen the original profile and installed plugin identities')
    await stage('restart-state', limits.restartMs, () => verifyRestart({ main: current.driver, renderer: current.renderer, savedSettings: saved, record, capture, scenario }))
    await stage('restart-exit', 30000, () => current.quit())
    if (scenario === 'all') {
      const broken = path.join(work, 'broken-settings.json'); await writeFile(broken, '{"broken":', { flag: 'wx', mode: 0o600 })
      current = new Instance('recovery')
      await stage('recovery-build', limits.buildMs, () => current.build(broken, true))
      await stage('recovery-startup', limits.startupMs - (performance.now() - current.buildCompletedAt), () => current.start(true))
      await stage('recovery-boundary-and-retry', 60000, () => exerciseRecovery({ driver: current.driver, profile: path.join(current.instance, 'profile'), bytes, capture }))
      await current.driver.host('shutdown-report')
      await stage('recovery-exit', 30000, () => current.quit())
    }
  } else await stage('collector-exit', 30000, () => current.quit())
  result.complete = true
} catch (error) {
  result.errors.push(message(error)); fail(error); process.exitCode = 1
} finally {
  clearTimeout(timer)
  try { if (current && !current.exited) await current.cleanup() } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  let stagesDrained = false
  try {
    if (runningStages.size) current?.driver?.close()
    await Promise.allSettled([...runningStages])
    stagesDrained = true
  } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  let feedClosed = !feed
  if (feed) {
    try { result.marketplaceFeed = feed.evidence(); await feed.close(); feedClosed = true }
    catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  }
  result.cleanup.retainedInstances = []
  if (stagesDrained) for (const instance of retainedInstances) {
    try {
      const receipt = await cleanupDevelopmentInstance({ root, instance })
      assert(await absent(instance), 'Owned resumed instance survived targeted cleanup')
      result.cleanup.retainedInstances.push({ instance, removed: true, receipt })
    } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  }
  try {
    result.cleanup.fixtureProcessesStopped = false
    if (manifest) { await manifest.stopAgents(); result.cleanup.fixtureProcessesStopped = true }
  } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  if (work && stagesDrained && feedClosed && result.cleanup.fixtureProcessesStopped) {
    try { await rm(work, { recursive: true }); result.cleanup.fixtureDirectoryRemoved = true } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  }
  result.finishedAt = new Date().toISOString()
  try { await log.close() } catch (error) { result.errors.push(message(error)); result.complete = false; process.exitCode = 1 }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ complete: result.complete, evidence: output, errors: result.errors }))
}
