import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, writeFile, rm, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvidenceLog, Protocol, readLines, until } from './performance/core.mjs'
import { prepareFixtures } from './performance/fixtures.mjs'
import { exerciseSmoke, verifyRestart } from './smoke/scenarios.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const exec = promisify(execFile)
// Covers 3D round trips, 100 event samples and bilingual layout checks within the total deadline.
const limits = Object.freeze({ totalMs: 420000, startupMs: 120000, scenarioMs: 300000, restartMs: 60000,
  logBytes: 8 * 1024 * 1024, records: 16384, screenshots: 40, screenshotBytes: 2 * 1024 * 1024,
  settingsBytes: 64 * 1024, protocolPending: 32, fixtureBytes: 128 * 1024 * 1024 })
const options = { fault: null }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--fault', '--out', '--scenario'].includes(key) || !process.argv[index + 1] || Object.hasOwn(options, key))
    throw new Error('Usage: node scripts/smoke-renderer.mjs [--scenario all|notifications|topology] [--fault fixture|ipc] [--out NEW_DIRECTORY]')
  options[key] = process.argv[index + 1]
}
options.fault = options['--fault'] ?? null
if (options.fault !== null && !['fixture', 'ipc'].includes(options.fault)) throw new Error('Unknown smoke fault')
options.scenario = options['--scenario'] ?? 'all'
if (!['all', 'notifications', 'topology'].includes(options.scenario) || options.fault && options.scenario !== 'all') throw new Error('Unknown smoke scenario or incompatible fault')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Renderer smoke currently requires macOS arm64')
if (typeof WebSocket !== 'function') throw new Error('Renderer smoke requires Node with the built-in WebSocket API')
const output = options['--out'] ? path.resolve(options['--out']) : await mkdtemp(path.join(os.tmpdir(), 'oc-chan-smoke-evidence-'))
if (options['--out']) await mkdir(output, { mode: 0o700 })
const log = new EvidenceLog(path.join(output, 'evidence'), { maxBytes: limits.logBytes, chunkBytes: 1024 * 1024 })
await log.initialize()
const result = { schema: 1, startedAt: new Date().toISOString(), complete: false, fault: options.fault, limits,
  scope: { execution: 'real headless Electron + preload + React + IPC',
    synthetic: 'performance L1: 32 agent metadata records, fixture schedules and SQLite execution history',
    real: 'system collection, fixture file readers, SQLite history reader, settings persistence',
    restart: 'new independent profile seeded with the exact first-process settings.json bytes; no localStorage reuse',
    nativeWindowAcceptance: false }, stages: [], runs: [], errors: [], cleanup: {} }
result.scope.scenario = options.scenario
const abort = new AbortController()
let current, workDirectory, recordCount = 0, screenshots = 0, screenshotBytes = 0
let activeWork
const fail = error => { if (!abort.signal.aborted) abort.abort(error instanceof Error ? error : new Error(String(error))) }
const errorText = error => String(error?.stack ?? error).slice(0, 16384)
function record(name, details) {
  if (typeof name !== 'string' || name.length > 160 || ++recordCount > limits.records) throw new Error('Smoke evidence record budget exceeded')
  const row = { at: new Date().toISOString(), run: current?.label ?? null, name, details }
  if (Buffer.byteLength(JSON.stringify(row)) > 256 * 1024) throw new Error('Smoke evidence row budget exceeded')
  void log.append(row).catch(fail)
}
function rememberError(stage, error) {
  if (result.errors.length >= 32) throw new Error('Smoke failure evidence budget exceeded')
  result.errors.push({ stage, error: errorText(error) })
  console.error(`[smoke] ${stage}: ${errorText(error)}`)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => fail(new Error(`Smoke interrupted: ${signal}`)))
const totalTimer = setTimeout(() => fail(new Error('Smoke total deadline exceeded')), limits.totalMs)

async function boundedFile(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error(`Invalid evidence/input file: ${filename}`)
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw new Error(`File changed while reading: ${filename}`)
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}
async function absent(filename) {
  try { await lstat(filename); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function deadline(work, milliseconds, label) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function stage(name, milliseconds, action) {
  abort.signal.throwIfAborted()
  if (result.stages.length >= 32) throw new Error('Smoke stage budget exceeded')
  const entry = { name, startedAt: new Date().toISOString(), status: 'running' }
  result.stages.push(entry)
  record('stage-start', { name })
  let onAbort
  const work = Promise.resolve().then(action)
  activeWork = work
  work.then(() => { if (activeWork === work) activeWork = undefined }, () => { if (activeWork === work) activeWork = undefined })
  try {
    const value = await deadline(Promise.race([work, new Promise((_, reject) => {
      onAbort = () => reject(abort.signal.reason)
      abort.signal.addEventListener('abort', onAbort, { once: true })
      if (abort.signal.aborted) onAbort()
    })]), milliseconds, name)
    entry.status = 'passed'
    record('stage-pass', { name })
    return value
  } catch (error) {
    entry.status = 'failed'
    entry.error = errorText(error)
    throw error
  } finally {
    abort.signal.removeEventListener('abort', onAbort)
    entry.finishedAt = new Date().toISOString()
  }
}
async function capture(name) {
  if (!current?.renderer) throw new Error('No renderer available for screenshot')
  if (typeof name !== 'string' || name.length > 160 || screenshots >= limits.screenshots) throw new Error('Screenshot count/name budget exceeded')
  const index = ++screenshots
  const { data } = await current.renderer.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 10000)
  if (typeof data !== 'string' || data.length > Math.ceil(limits.screenshotBytes / 3) * 4) throw new Error('Screenshot byte budget exceeded')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > limits.screenshotBytes) throw new Error('Screenshot byte budget exceeded')
  const filename = `${String(index).padStart(2, '0')}-${current.label}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
  await writeFile(path.join(output, filename), bytes, { flag: 'wx', mode: 0o600 })
  screenshotBytes += bytes.length
  record('screenshot', { name, file: filename, bytes: bytes.length })
  return filename
}
async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 })
  const rows = stdout.trim().split('\n')
  if (rows.length > 16384) throw new Error('Process table exceeds smoke budget')
  return rows.map(row => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row)
    if (!match) throw new Error('Invalid process table')
    return { pid: Number(match[1]), group: Number(match[2]) }
  })
}
async function signalGroup(group, signal) {
  try { process.kill(-group, signal) } catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code === 'EPERM' && !(await processTable()).some(row => row.group === group)) {
      record('process-group-absent', { group, signal, kernelCode: 'EPERM', independentlyConfirmed: true })
      return
    }
    throw error
  }
}
class Instance {
  constructor(label) {
    this.label = label; this.groups = new Set(); this.protocols = []; this.stopping = false; this.exited = false
    this.evidence = { label, cleanup: {} }
    result.runs.push(this.evidence)
  }
  async start(manifest, settingsSeed) {
    this.exitReport = path.join(output, `${this.label}-exit.json`)
    const filename = path.join(workDirectory, `${this.label}-config.json`)
    await writeFile(filename, JSON.stringify({ level: 'L1', seed: 20261104, fixture: manifest,
      smoke: { exitReport: this.exitReport, ...(settingsSeed ? { settingsSeed } : {}) } }), { flag: 'wx', mode: 0o600 })
    this.launcher = spawn(process.execPath, ['scripts/develop.mjs', '--inspect'], {
      cwd: root, env: { ...process.env, OC_CHAN_SMOKE_CONFIG: filename, OC_CHAN_PERFORMANCE_CONFIG: filename },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.launcher.once('error', error => { this.spawnError = error; fail(error) })
    this.launcher.once('close', (code, signal) => {
      this.exited = true; this.exit = { code, signal }
      if (!this.stopping) fail(new Error(`Smoke launcher exited unexpectedly: ${signal ?? code}`))
    })
    const consume = line => {
      const instance = /\[oc-chan\] 无头开发实例：(.*)$/.exec(line)
      const group = /\[oc-chan\] 验收子进程组：(\d+)$/.exec(line)
      const inspector = /Debugger listening on (ws:\/\/\S+)/.exec(line)
      const renderer = /DevTools listening on (ws:\/\/\S+)/.exec(line)
      if (instance) {
        const directory = path.resolve(instance[1])
        if (path.dirname(directory) !== path.join(root, '.dev-instances') || !/^instance-[a-zA-Z0-9]+$/.test(path.basename(directory)))
          throw new Error('Launcher reported an unowned instance directory')
        if (this.instance && this.instance !== directory) throw new Error('Launcher changed smoke profile')
        this.instance = directory
      }
      if (group) {
        if (this.groups.size >= 2) throw new Error('Unexpected development process restart')
        this.groups.add(Number(group[1]))
      }
      if (inspector) { if (this.inspectorUrl) throw new Error('Main process restarted during smoke'); this.inspectorUrl = inspector[1] }
      if (renderer) { if (this.rendererUrl) throw new Error('Renderer endpoint restarted during smoke'); this.rendererUrl = renderer[1] }
      record('launcher', { label: this.label, line })
    }
    readLines(this.launcher.stdout, consume, fail)
    readLines(this.launcher.stderr, consume, fail)
    await until(() => this.instance && this.inspectorUrl && this.rendererUrl, { timeout: limits.startupMs, signal: abort.signal })
    this.main = await Protocol.connect(this.inspectorUrl)
    this.protocols.push(this.main)
    const address = new URL(this.rendererUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('Non-local CDP endpoint')
    const page = await until(async () => {
      const response = await fetch(`http://${address.host}/json/list`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) })
      if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`)
      const text = await response.text()
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('CDP target list exceeds budget')
      const pages = JSON.parse(text)
      if (!Array.isArray(pages) || pages.length > 8) throw new Error('Unexpected CDP target list')
      return pages.find(item => item.type === 'page' && item.url && item.url !== 'about:blank' && !item.url.includes('?view=tray'))
    }, { timeout: 30000, signal: abort.signal })
    this.renderer = await Protocol.connect(page.webSocketDebuggerUrl)
    this.protocols.push(this.renderer)
    await this.renderer.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
    await until(() => this.renderer.evaluate('Boolean(window.__ocPerfState?.ready && window.monitor && window.desktopSettings)'), { timeout: 60000, signal: abort.signal })
    await this.hidden('startup')
    this.evidence.instance = this.instance
    this.evidence.processGroups = [...this.groups]
    this.evidence.launcherPid = this.launcher.pid
  }
  async hidden(phase) {
    const info = await this.main.evaluate('globalThis.__ocSmokeControl.info()')
    assert.equal(info.userData, path.join(this.instance, 'user-data'))
    assert.equal(info.windows.length, 1, 'Expected exactly one smoke window')
    for (const window of info.windows) {
      assert.equal(window.visible, false, 'Smoke window became visible')
      assert.equal(window.focusable, false, 'Smoke window became focusable')
    }
    record('headless-evidence', { phase, ...info })
    return info
  }
  async quit() {
    await this.hidden('before-quit')
    this.stopping = true
    assert.equal((await this.main.evaluate('globalThis.__ocSmokeControl.quit()')).scheduled, true)
    // Node inspector connections must close before process exit can complete.
    await this.disconnect()
    await until(() => this.exited, { timeout: 20000 })
    assert.deepEqual(this.exit, { code: 0, signal: null }, 'Launcher did not exit normally')
    const report = JSON.parse((await boundedFile(this.exitReport, 128 * 1024)).toString('utf8'))
    this.evidence.exit = report
    assert.equal(report.code, 0)
    assert.equal(report.monitor.stopped, true)
    assert.equal(report.monitor.timers, 0)
    assert.deepEqual(report.monitor.pendingSections, [])
    assert.equal(report.monitor.queuedRetries, 0)
    assert.equal(report.monitor.plugins.closed, true)
    assert.equal(report.monitor.plugins.pending, 0)
    const usage = report.resources?.global?.current
    assert.ok(usage && Object.keys(usage).length > 0, 'Missing shutdown resource evidence')
    for (const value of Object.values(usage)) assert.equal(value, 0, 'Shutdown left a collection resource reservation')
    await this.confirmCleanup()
    record('normal-exit', { label: this.label, report: path.basename(this.exitReport), cleanup: this.evidence.cleanup })
  }
  async disconnect() {
    for (const protocol of this.protocols) protocol.close()
    await Promise.all(this.protocols.map(protocol => until(() => protocol.socket.readyState === WebSocket.CLOSED, { timeout: 5000 })))
  }
  async confirmCleanup() {
    const members = (await processTable()).filter(row => this.groups.has(row.group) || row.pid === this.launcher?.pid)
    assert.deepEqual(members, [], 'Owned development processes remain')
    assert.ok(!this.instance || await absent(this.instance), 'Launcher did not remove its independent profile')
    this.evidence.cleanup = { processesGone: true, profileRemoved: true }
  }
  async cleanup() {
    this.stopping = true
    const failures = []
    const attempt = async action => { try { await action() } catch (error) { failures.push(error) } }
    if (!this.exited && this.main?.socket.readyState === WebSocket.OPEN && this.renderer)
      await attempt(() => this.quit())
    await attempt(() => this.disconnect())
    if (this.launcher?.pid && !this.exited) {
      await attempt(async () => { if (!this.launcher.kill('SIGTERM') && !this.exited) throw new Error('Could not signal owned launcher') })
      await attempt(() => until(() => this.exited, { timeout: 17000 }))
    }
    for (const group of this.groups) await attempt(() => signalGroup(group, 'SIGKILL'))
    if (this.launcher?.pid && !this.exited) await attempt(async () => {
      this.forcedLauncherKill = true
      if (!this.launcher.kill('SIGKILL') && !this.exited) throw new Error('Could not kill owned launcher')
      await until(() => this.exited, { timeout: 5000 })
    })
    let processesGone = false
    await attempt(async () => {
      if (this.forcedLauncherKill && this.groups.size === 0)
        throw new Error('Launcher was killed before announcing its process group; descendants cannot be confirmed absent')
      await until(async () => !(await processTable()).some(row => this.groups.has(row.group) || row.pid === this.launcher?.pid), { timeout: 5000 })
      processesGone = true
    })
    if (processesGone && this.instance) await attempt(async () => {
      // This path was obtained from this launcher's validated instance announcement only.
      await rm(this.instance, { recursive: true, force: true })
    })
    this.evidence.cleanup = { processesGone, profileRemoved: !this.instance || await absent(this.instance) }
    if (failures.length) throw new AggregateError(failures, failures.map(errorText).join('\n'))
  }
}

try {
  console.log(`[smoke] 证据目录：${output}`)
  workDirectory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-smoke-work-'))
  const fixtureRoot = path.join(workDirectory, 'fixtures')
  await mkdir(fixtureRoot, { mode: 0o700 })
  const manifest = await stage('prepare-fixtures', 60000, () => prepareFixtures(fixtureRoot, { seed: 20261104 }))
  record('fixture-scope', { seed: manifest.seed, syntheticAgents: 32, sessions: manifest.sessions.length,
    hermesJobs: manifest.hermesJobIds.length, historyRows: manifest.historyRows, plistCount: manifest.plistCount })
  current = new Instance('first')
  await stage('first-startup', limits.startupMs, () => current.start(manifest))
  await capture('startup')
  const exercised = await stage('exercise-smoke', limits.scenarioMs, () => exerciseSmoke({
    main: current.main, renderer: current.renderer, manifest, record, capture, fault: options.fault, scenario: options.scenario
  }))
  if (options.fault) throw new Error(`Injected ${options.fault} fault did not fail its required assertion`)
  const savedBytes = await stage('read-real-settings', 10000, async () => {
    assert.ok(exercised?.settings && typeof exercised.settings === 'object' && Object.keys(exercised.settings).length > 0,
      'Scenario must return an expected settings patch')
    const bytes = await boundedFile(path.join(current.instance, 'user-data/settings.json'), limits.settingsBytes)
    const saved = JSON.parse(bytes.toString('utf8'))
    for (const [key, value] of Object.entries(exercised.settings)) assert.deepEqual(saved[key], value, `Persisted setting mismatch: ${key}`)
    const seed = path.join(output, 'saved-settings.json')
    await writeFile(seed, bytes, { flag: 'wx', mode: 0o600 })
    record('actual-settings-saved', { file: 'saved-settings.json', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), expected: exercised.settings })
    return bytes
  })
  const firstProfile = current.instance
  await stage('first-normal-exit', 30000, () => current.quit())
  current = new Instance('restart')
  await stage('restart-startup', limits.startupMs, () => current.start(manifest, path.join(output, 'saved-settings.json')))
  assert.notEqual(current.instance, firstProfile, 'Restart must use an independent profile')
  const restartedBytes = await boundedFile(path.join(current.instance, 'user-data/settings.json'), limits.settingsBytes)
  assert.ok(savedBytes.equals(restartedBytes), 'Restart did not read the exact saved settings bytes')
  record('restart-seed-identical', { bytes: restartedBytes.length, sha256: createHash('sha256').update(restartedBytes).digest('hex') })
  await stage('verify-restart', limits.restartMs, () => verifyRestart({ main: current.main, renderer: current.renderer,
    savedSettings: JSON.parse(savedBytes.toString('utf8')), record, capture, scenario: options.scenario }))
  await stage('restart-normal-exit', 30000, () => current.quit())
  result.complete = true
} catch (error) {
  rememberError(result.stages.at(-1)?.name ?? 'setup', error)
  if (current?.renderer) {
    try { await capture('failure') } catch (captureError) { rememberError('failure-screenshot', captureError) }
    try { record('failure-state', await current.main.evaluate('globalThis.__ocSmokeControl.info()', 3000)) }
    catch (infoError) { rememberError('failure-state', infoError) }
  }
} finally {
  clearTimeout(totalTimer)
  if (current) {
    try { await current.cleanup() } catch (error) { result.complete = false; rememberError('instance-cleanup', error) }
  }
  let settled = !activeWork
  if (activeWork) {
    try {
      await deadline(activeWork.then(() => {}, error => { rememberError('interrupted-stage-settlement', error) }), 5000, 'stage settlement')
      settled = true
    } catch (error) { result.complete = false; rememberError('stage-settlement', error) }
  }
  const processesGone = !current || current.evidence.cleanup.processesGone === true
  if (workDirectory && settled && processesGone) {
    try { await rm(workDirectory, { recursive: true, force: true }); result.cleanup.workDirectoryRemoved = await absent(workDirectory) }
    catch (error) { result.complete = false; rememberError('fixture-cleanup', error) }
  } else if (workDirectory) {
    result.complete = false
    result.cleanup.preservedWorkDirectory = workDirectory
  }
  try { await log.close() } catch (error) { result.complete = false; rememberError('evidence-close', error) }
  if (abort.signal.aborted) { result.complete = false; rememberError('run-aborted', abort.signal.reason) }
  result.finishedAt = new Date().toISOString()
  result.evidence = { directory: output, logBytes: log.bytes, records: recordCount, screenshots, screenshotBytes }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(`[smoke] ${result.complete ? 'PASS' : 'FAIL'}：${path.join(output, 'result.json')}`)
  if (!result.complete) process.exitCode = 1
}
