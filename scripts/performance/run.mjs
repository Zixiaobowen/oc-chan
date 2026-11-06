import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, rm, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvidenceLog, Protocol, now, readLines, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { prepareFixtures, writeEvents, mutateSchedules, setPlistCount, withOversizedSession } from './fixtures.mjs'
import { runSoak } from './soak-scenario.mjs'
import { startSampler } from './sampler.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const exec = promisify(execFile)
const options = { mode: 'baseline', seed: '20261104', scenario: 'all', sampler: 'user' }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].slice(2)
  if (!['mode', 'seed', 'out', 'scenario', 'sampler'].includes(key) || !process.argv[index + 1]) throw new Error('Usage: node scripts/performance/run.mjs --mode baseline|smoke --seed VALUE [--scenario all|startup|idle|daily|stress|soak] [--sampler user|admin] [--out NEW_DIRECTORY]')
  options[key] = process.argv[index + 1]
}
if (!['baseline', 'smoke'].includes(options.mode) || options.seed.length > 128 || process.platform !== 'darwin') throw new Error('Invalid mode/seed or unsupported host')
if (!['all', 'startup', 'idle', 'daily', 'stress', 'soak'].includes(options.scenario)) throw new Error('Invalid measurement scenario')
if (!['user', 'admin'].includes(options.sampler)) throw new Error('Invalid sampler privilege: choose user or admin')
if (process.getuid() === 0 || process.geteuid() === 0) throw new Error('The measurement runner and Electron must run as an ordinary user')
const selected = scenario => options.scenario === 'all' || options.scenario === scenario
const full = options.mode === 'baseline'
const abort = new AbortController()
const fail = error => { if (!abort.signal.aborted) abort.abort(error instanceof Error ? error : new Error(String(error))) }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => fail(new Error(`Measurement cancelled: ${signal}`)))
const output = options.out ? path.resolve(options.out) : await mkdtemp(path.join(os.tmpdir(), 'oc-chan-performance-'))
if (options.out) await mkdir(output, { mode: 0o700 })
const log = new EvidenceLog(path.join(output, 'evidence'), { gzip: options.scenario === 'soak' })
await log.initialize()
const result = { schema: 2, mode: options.mode, seed: options.seed, scenario: options.scenario, sampler: options.sampler, startedAt: new Date().toISOString(), complete: false,
  scope: 'Real headless Electron development build; process-cold fresh profiles, warm OS filesystem caches; synthetic renderer visibility, no native-window claim',
  safety: { logBytes: log.maxBytes, fixtureBytes: 128 * 1024 ** 2, appRssBytes: 2 * 1024 ** 3, eventCorrelationEntries: 32768 },
  runs: [], source: null, host: null, evidenceDirectory: log.directory }
const record = row => log.append(row).catch(fail)
let current
const evidenceScope = { id: 0, label: '', phase: '' }
function recordScoped(kind, label, phase, value) {
  if (evidenceScope.label !== label || evidenceScope.phase !== phase) {
    if (evidenceScope.id >= (options.scenario === 'soak' ? 2048 : 128)) throw new Error('Evidence scope budget exceeded')
    evidenceScope.id++
    evidenceScope.label = label
    evidenceScope.phase = phase
    record(['scope', evidenceScope.id, label, phase])
  }
  return record([kind, evidenceScope.id, value])
}

async function command(file, args) {
  const { stdout } = await exec(file, args, { cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
  return stdout.trim()
}
async function fingerprint() {
  const files = []
  async function visit(relative) {
    const absolute = path.join(root, relative)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`Source fingerprint does not follow symlinks: ${relative}`)
    if (info.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) await visit(path.join(relative, child))
    } else if (info.isFile()) {
      if (files.length >= 512 || info.size > 4 * 1024 * 1024) throw new Error('Source fingerprint budget exceeded')
      files.push({ path: relative, bytes: info.size, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') })
    }
  }
  for (const target of ['src', 'scripts', 'electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) await visit(target)
  return { digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
}
async function waitExit(child, timeout = 20000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned child ${child.pid} failed to exit within ${timeout}ms`)), timeout)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
function send(sampler, line) {
  if (!sampler.input.writable || sampler.input.destroyed) throw new Error('Sampler command stream is closed')
  if (sampler.input.writableLength > 64 * 1024) throw new Error('Sampler command backpressure exceeded')
  sampler.input.write(line + '\n')
}
class Run {
  constructor(label, level) {
    this.label = label; this.level = level; this.first = {}; this.protocols = []; this.early = []
    this.measurement = new Measurement(label); this.metrics = true; this.finished = false; this.phase = 'startup'
    this.slices = []
  }
  async start() {
    this.directory = await mkdtemp(path.join(output, 'run-'))
    if (this.level !== 'L0') {
      const fixtures = path.join(this.directory, 'fixtures')
      await mkdir(fixtures)
      this.fixture = await prepareFixtures(fixtures, { seed: options.seed, ...(options.scenario === 'soak' ? { now: Date.now() } : {}) })
    }
    const config = path.join(this.directory, 'config.json')
    await writeFile(config, JSON.stringify({ level: this.level, seed: options.seed, scenario: options.scenario, fixture: this.fixture }), { flag: 'wx', mode: 0o600 })
    this.sampler = await startSampler(path.join(output, 'process-sampler'), { privilege: options.sampler, signal: abort.signal })
    await record(['sampler', this.label, { privilege: options.sampler, ...this.sampler.identity }])
    this.sampler.process.once('error', fail)
    this.sampler.input.on('error', fail)
    this.sampler.process.once('exit', (code, signal) => { if (!this.stopping) fail(new Error(`Sampler exited unexpectedly: ${signal ?? code}`)) })
    readLines(this.sampler.output, line => {
      const row = JSON.parse(line)
      recordScoped('r', this.label, this.phase, row)
      if (row.type === 'resources' && row.app.reduce((sum, item) => sum + (item.rssBytes ?? 0), 0) > 2 * 1024 ** 3)
        throw new Error('Application tree exceeded the 2 GiB measurement safety ceiling')
      if (this.metrics) this.measurement.resources(row)
      this.soak?.resources(row)
      if (row.type === 'resources') record(['observer', this.label, now(), process.memoryUsage().rss, process.cpuUsage(), os.loadavg(), os.freemem()])
    }, fail, 2 * 1024 * 1024)
    readLines(this.sampler.errors, line => { if (line) { this.samplerError = line; if (!this.stopping) fail(new Error(line)) } }, fail)
    abort.signal.throwIfAborted()
    this.startedAt = now()
    this.launcher = spawn(process.execPath, ['scripts/develop.mjs', '--inspect'], {
      cwd: root, env: { ...process.env, OC_CHAN_PERFORMANCE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe']
    })
    this.launcher.once('error', fail)
    this.launcher.once('exit', (code, signal) => {
      if (!this.stopping) fail(new Error(`Development instance exited unexpectedly: ${signal ?? code}`))
    })
    const consume = line => {
      if (line.startsWith('__OC_PERF__')) {
        const rows = JSON.parse(line.slice(11))
        if (!Array.isArray(rows) || rows.length > 128) throw new Error('Performance metric batch exceeded')
        for (const row of rows) this.metric(row)
      } else {
        const inspector = line.match(/Debugger listening on (ws:\/\/\S+)/)
        const renderer = line.match(/DevTools listening on (ws:\/\/\S+)/)
        const instance = line.match(/\[oc-chan\] 无头开发实例：(.*)$/)
        if (inspector) this.inspectorUrl = inspector[1]
        if (renderer) this.rendererUrl = renderer[1]
        if (instance) this.instance = instance[1]
        record(['launcher', this.label, line])
      }
    }
    readLines(this.launcher.stdout, consume, fail)
    readLines(this.launcher.stderr, consume, fail)
    await until(() => this.rendererUrl && this.inspectorUrl && this.ready, { timeout: 120000, signal: abort.signal })
    const address = new URL(this.rendererUrl)
    const response = await fetch(`http://${address.host}/json/list`, { signal: abort.signal })
    if (!response.ok) throw new Error(`CDP target listing failed: ${response.status}`)
    const pages = await response.json()
    if (!Array.isArray(pages) || pages.length > 8) throw new Error('Unexpected renderer target list')
    const page = pages.find(item => item.type === 'page' && !item.url.includes('?view=tray'))
    if (!page) throw new Error('Missing main renderer')
    this.main = await Protocol.connect(page.webSocketDebuggerUrl)
    this.protocols.push(this.main)
    await this.main.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
    this.inspector = await Protocol.connect(this.inspectorUrl)
    this.protocols.push(this.inspector)
    const ready = await this.main.evaluate('({ready:window.__ocPerfState?.ready,bridge:typeof window.monitor?.snapshot,viewport:[innerWidth,innerHeight]})')
    if (!ready.ready || ready.bridge !== 'function') throw new Error('Renderer did not commit an initial complete snapshot')
    const before = now()
    await this.interact(0)
    this.interactiveAt = now()
    this.startupWindows = await this.inspector.evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows().map(window=>({id:window.id,tray:window.webContents.getURL().includes("?view=tray"),visible:window.isVisible(),focusable:window.isFocusable()}))')
    if (this.startupWindows.length !== 1 || this.startupWindows[0].tray || this.startupWindows[0].visible || this.startupWindows[0].focusable)
      throw new Error('Startup must contain exactly one hidden, unfocusable main window')
    this.startupResources = this.measurement.result()
    console.log(`${this.label}: ready in ${Math.round(this.interactiveAt - this.startedAt)}ms; ${address.host}`)
    await record(['startup', this.label, { startedAt: this.startedAt, first: this.first, committedAt: this.ready, interactiveAt: this.interactiveAt, firstInteractionMs: this.interactiveAt - before }])
  }
  async openTray() {
    this.phase = 'first-tray-open'
    const began = now()
    await this.inspector.evaluate('globalThis.__ocPerformanceTray.open()', 15000)
    const response = await fetch(`http://${new URL(this.rendererUrl).host}/json/list`, { signal: abort.signal })
    if (!response.ok) throw new Error(`Tray target listing failed: ${response.status}`)
    const pages = await response.json()
    if (!Array.isArray(pages) || pages.length > 8) throw new Error('Unexpected renderer target list')
    const page = pages.find(item => item.type === 'page' && item.url.includes('?view=tray'))
    if (!page) throw new Error('Explicit tray request did not create its renderer')
    this.tray = await Protocol.connect(page.webSocketDebuggerUrl)
    this.protocols.push(this.tray)
    await this.tray.call('Emulation.setDeviceMetricsOverride', { width: 380, height: 560, deviceScaleFactor: 1, mobile: false })
    await until(() => this.tray.evaluate('window.__ocPerfState?.ready'), { timeout: 10000, signal: abort.signal })
    await this.tray.evaluate(`(async()=>{
      const section=document.querySelector('.tray-metric[data-metric="cpu"]');
      if(!section)throw new Error('Missing tray CPU metric');
      section.querySelector('summary').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(!section.open||!section.querySelector('.tray-metric-detail'))throw new Error('Tray did not respond to expansion');
      section.querySelector('summary').click();
    })()`)
    this.trayOpenMs = now() - began
    await record(['first-tray-interaction', this.label, this.trayOpenMs])
  }
  metric(row) {
    if (!Array.isArray(row) || row.length > 8 || !Number.isFinite(row[1])) throw new Error('Invalid probe metric')
    const [kind, at] = row
    if (!this.soak || ['main', 'spawn', 'exit', 'first', 'commit-ready', 'probe-error', 'read-issue'].includes(kind)) recordScoped('m', this.label, this.phase, row)
    else this.soak.metric(kind)
    if (kind === 'main') {
      if (this.pid) throw new Error('Application restarted during a frozen measurement')
      this.pid = row[2]
      send(this.sampler, `roots ${this.pid} ${this.launcher.pid}`)
      for (const line of this.early) send(this.sampler, line)
      this.early = []
    }
    if (kind === 'first') this.first[row[2]] ??= at
    if (kind === 'commit-ready' && row[2] === 'main') this.ready ??= at
    if (kind === 'spawn' || kind === 'exit') {
      this.children ??= new Set()
      if (kind === 'spawn') {
        if (this.children.size >= 512 && !this.children.has(row[2])) throw new Error('Reported child identity limit exceeded')
        this.children.add(row[2])
      } else this.children.delete(row[2])
      const line = kind === 'spawn' ? `track ${row[2]} ${row[3]}` : `exit ${row[2]}`
      if (this.pid) send(this.sampler, line)
      else { if (this.early.length >= 512) throw new Error('Early child event budget exceeded'); this.early.push(line) }
    }
    if (this.metrics) this.measurement.metric(row)
  }
  async interact(index) {
    const pages = ['agents', 'schedules', 'system', 'overview']
    const page = pages[index % pages.length]
    const began = now()
    const expected = await this.main.evaluate(`(async()=>{
      const names={agents:'协作拓扑',schedules:'定时任务',system:'系统监控',overview:'本机概览'};
      const button=[...document.querySelectorAll('.sidebar nav button')].find(item=>item.textContent.includes(names[${JSON.stringify(page)}]));
      if(!button)throw new Error('Missing navigation target');
      button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));button.click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(button.getAttribute('aria-current')!=='page')throw new Error('Navigation did not commit');
      return {page:${JSON.stringify(page)},overflow:document.documentElement.scrollWidth>innerWidth};})()`)
    this.measurement.roundTrips.add(now() - began)
    if (page === 'schedules') {
      await this.main.evaluate(`(async()=>{
        const input=document.querySelector('.schedule-toolbar input');
        if(!input)throw new Error('Missing schedule filter');
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        for(const text of ['Perf schedule','']){setter.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));}
      })()`)
      if (this.fixture) {
        const job = this.fixture.hermesJobIds[index % this.fixture.hermesJobIds.length]
        const history = await this.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(job)},0).then(value=>({source:value.source,count:value.entries.length,hasMore:value.hasMore}))`)
        if (history.source !== 'hermes' || history.count !== 25 || !history.hasMore)
          throw new Error(`Synthetic history did not traverse the real SQLite reader: ${JSON.stringify({ job, ...history })}`)
      }
    }
    await record(['interaction', this.label, this.phase, expected])
  }
  async duration(seconds, { events = false, frequency = 1, interact = false, mutate = false } = {}) {
    const end = now() + seconds * 1000
    let nextEvent = now(), nextInteraction = now(), nextMutation = now()
    while (now() < end) {
      abort.signal.throwIfAborted()
      const at = now()
      if (events && at >= nextEvent) {
        const sequence = (this.sequence ?? 0) + 1; this.sequence = sequence
        const count = this.level === 'L2' ? 128 : 32
        // Match the probes' monotonic epoch; wall time belongs only in fixture data.
        const timestamp = now()
        if (this.metrics) this.measurement.expect(count, sequence, timestamp)
        const began = now()
        const write = () => writeEvents(this.fixture, { sessionCount: count, sequence, now: Date.now() })
        await (this.soak ? this.soak.fixture(write) : write())
        if (!this.soak) await record(['load', this.label, this.phase, sequence, count, timestamp, now() - began, Math.max(0, at - nextEvent)])
        else this.soak.load(count, now() - began, Math.max(0, at - nextEvent))
        nextEvent += 1000 / frequency
        if (now() - nextEvent > 1000) throw new Error('Load generator fell behind by more than one second; requested load was not achieved')
      }
      if (interact && at >= nextInteraction) { await this.interact(this.interactionIndex ?? 0); this.interactionIndex = (this.interactionIndex ?? 0) + 1; nextInteraction += 15000 }
      if (mutate && at >= nextMutation) {
        const sequence = (this.mutation ?? 0) + 1
        const mutate = () => mutateSchedules(this.fixture, { sequence })
        const changed = await (this.soak ? this.soak.fixture(mutate) : mutate())
        this.mutation = sequence
        nextMutation += 60000
        await record(['mutation', this.label, this.phase, sequence, changed.length, now()])
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  async stop() {
    if (this.finished) return
    this.stopping = true
    const failures = []
    const attempt = async action => { try { await action() } catch (error) { failures.push(error) } }
    if (this.soak && this.inspector?.socket.readyState === WebSocket.OPEN) {
      await attempt(async () => {
        this.soakCleanup = await this.inspector.evaluate('globalThis.__ocPerformanceControl.stop()', 30000)
        await until(() => !this.children?.size, { timeout: 5000 })
        await record(['soak-cleanup', this.label, this.soakCleanup])
        const { diagnostics, resources } = this.soakCleanup
        if (diagnostics.timers || diagnostics.queuedRetries || diagnostics.pendingSections.length || diagnostics.plugins.pending ||
            Object.values(resources.global.current).some(value => value !== 0) || this.children?.size ||
            this.soakCleanup.notificationJournal.summaryCount || this.soakCleanup.notifications.pendingCount)
          throw new Error('Soak stop did not release plugin/timer/IO/child resources')
      })
    }
    for (const connection of this.protocols) await attempt(() => connection.close())
    for (const connection of this.protocols) await attempt(() => until(() => connection.socket.readyState === WebSocket.CLOSED, { timeout: 5000 }))
    if (this.launcher) {
      await attempt(() => {
        if (this.launcher.exitCode === null && this.launcher.signalCode === null) this.launcher.kill('SIGTERM')
      })
      await attempt(() => waitExit(this.launcher))
    }
    if (this.sampler) {
      await attempt(async () => {
        const child = this.sampler.process
        if (child.exitCode === null && child.signalCode === null) {
          send(this.sampler, 'stop')
          await waitExit(child, 5000)
        }
        if (child.exitCode !== 0 || child.signalCode) throw new Error(this.samplerError ?? `Sampler failed: ${child.signalCode ?? child.exitCode}`)
        if (this.samplerError) throw new Error(this.samplerError)
      })
      await attempt(() => this.sampler.dispose())
    }
    if (this.instance) await attempt(async () => {
      if (!this.instance.startsWith(path.join(root, '.dev-instances/instance-'))) throw new Error('Launcher returned an unexpected instance path')
      try { await lstat(this.instance); throw new Error(`Development instance was not cleaned: ${this.instance}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    })
    for (const pid of [this.pid, ...(this.children ?? [])].filter(Boolean)) await attempt(() => {
      try { process.kill(pid, 0); throw new Error(`Owned application process remains alive: ${pid}`) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    if (this.directory) await attempt(() => rm(this.directory, { recursive: true }))
    this.finished = true
    if (failures.length) throw new AggregateError(failures, failures.map(String).join('; '))
  }
  result() { return { ...this.measurement.result(), label: this.label, sampler: this.sampler?.identity, slices: this.slices,
    startupWindows: this.startupWindows, startupResources: this.startupResources, trayOpenMs: this.trayOpenMs, startupMs: {
    firstSnapshot: Math.min(...Object.values(this.first)) - this.startedAt,
    allSnapshots: Math.max(...Object.values(this.first)) - this.startedAt,
    committed: this.ready - this.startedAt, interactive: this.interactiveAt - this.startedAt } } }
}

async function run(label, level, action) {
  abort.signal.throwIfAborted()
  current = new Run(label, level)
  let failure
  try {
    await current.start()
    await action(current)
    if (level !== 'L0') {
      current.resourceBudget = await current.inspector.evaluate('globalThis.__ocPerformanceControl.resources()')
      const { limits, global: { peak }, sources } = current.resourceBudget
      for (const kind of ['commands', 'files', 'sockets', 'commandBytes', 'fileBytes', 'socketBytes', 'queued']) {
        if (peak[kind] > limits[kind]) throw new Error(`Resource peak exceeds ${kind} budget`)
      }
      if (sources.length > limits.sources || sources.some(source => source.peak.queued > limits.queuedPerSource)) throw new Error('Source resource budget exceeded')
      await record(['resource-budget', current.label, current.resourceBudget])
    }
  } catch (error) { failure = error }
  try { await current.stop() } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Measurement and cleanup both failed') : error
  }
  result.runs.push({ ...current.result(), ...(current.soak ? { soak: current.soak.result(), cleanup: current.soakCleanup } : {}), resourceBudget: current.resourceBudget, complete: !failure })
  current = undefined
  await writeFile(path.join(output, 'progress.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  if (failure) throw failure
}

try {
  result.source = { commit: await command('git', ['rev-parse', 'HEAD']), branch: await command('git', ['branch', '--show-current']),
    workspace: await command('git', ['status', '--porcelain']), ...await fingerprint() }
  result.host = { os: await command('/usr/bin/sw_vers', []), arch: process.arch, cpu: os.cpus()[0].model, logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), load: os.loadavg(), power: await command('/usr/bin/pmset', ['-g', 'batt']),
    node: process.version, packages: {}, viewport: { main: [1280, 860], tray: [380, 560], scale: 1 } }
  for (const name of ['electron', 'react', 'react-dom', 'electron-vite', 'vite']) result.host.packages[name] = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version
  await record(['manifest', result])
  await command('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', 'scripts/performance/process-sampler.c', '-o', path.join(output, 'process-sampler')])
  console.log(`Evidence: ${output}`)
  if (options.scenario === 'soak') await run('L1-soak', 'L1', instance => runSoak(instance, {
    full, abort, fail, record, output, result, log, waitExit,
    progress: async heartbeat => {
      result.heartbeat = heartbeat
      await writeFile(path.join(output, 'progress.pending'), JSON.stringify(result, null, 2), { mode: 0o600 })
      await rename(path.join(output, 'progress.pending'), path.join(output, 'progress.json'))
    }
  }))
  if (selected('startup')) for (let index = 0; index < (full ? 10 : 1); index++) await run(`cold-${index + 1}`, 'L0', instance => instance.openTray())
  if (selected('idle')) await run('L0-visibility', 'L0', async instance => {
    await instance.openTray()
    instance.phase = 'warmup'; instance.metrics = false
    await instance.duration(full ? 120 : 2)
    instance.metrics = true
    for (const visible of ['main', 'tray', 'neither']) {
      instance.phase = visible
      instance.measurement = new Measurement(`${instance.label}:${visible}`)
      await instance.main.evaluate(`window.__ocPerfState.visibility(${visible !== 'main'})`)
      await instance.tray.evaluate(`window.__ocPerfState.visibility(${visible !== 'tray'})`)
      await instance.duration(full ? 60 : 2)
      instance.slices.push(instance.measurement.result())
    }
  })
  if (selected('daily')) for (let index = 0; index < (full ? 5 : 1); index++) await run(`L1-${index + 1}`, 'L1', async instance => {
    await instance.openTray()
    instance.phase = 'warmup'; instance.metrics = false
    await instance.duration(full ? 120 : 2, { events: true, interact: true, mutate: true })
    instance.phase = 'measured'; instance.metrics = true; instance.measurement = new Measurement(instance.label)
    await instance.duration(full ? 600 : 8, { events: true, interact: true, mutate: true })
    await instance.duration(1)
  })
  if (selected('stress')) await run('L2-boundaries', 'L2', async instance => {
    await instance.openTray()
    instance.phase = 'warmup'; instance.metrics = false
    await instance.duration(full ? 120 : 2)
    instance.phase = 'burst'; instance.metrics = true; instance.measurement = new Measurement(instance.label)
    await instance.duration(full ? 60 : 2, { events: true, frequency: 10 })
    await instance.duration(1)
    instance.slices.push(instance.measurement.result())
    const previousSchedules = await instance.main.evaluate('window.monitor.snapshot().then(value=>({jobs:value.schedules.data?.jobs.length,collectedAt:value.schedules.data?.collectedAt}))')
    for (const count of [3996, 3997, 4096, 4097]) {
      instance.phase = `plist-${count}`
      instance.measurement = new Measurement(`${instance.label}:${instance.phase}`)
      await setPlistCount(instance.fixture, count)
      await instance.main.evaluate('window.monitor.refresh("schedules")', 120000)
      const observed = await instance.main.evaluate('window.monitor.snapshot().then(value=>({jobs:value.schedules.data?.jobs.length,collectedAt:value.schedules.data?.collectedAt,error:value.schedules.error}))')
      if (count === 3996) {
        if (observed.error || observed.jobs !== 4096) throw new Error(`Configuration workload mismatch: ${JSON.stringify(observed)}`)
        Object.assign(previousSchedules, { jobs: observed.jobs, collectedAt: observed.collectedAt })
      } else if (!observed.error || observed.jobs !== previousSchedules.jobs || observed.collectedAt !== previousSchedules.collectedAt) {
        throw new Error(`Oversized configuration must retain the last complete snapshot: ${JSON.stringify(observed)}`)
      }
      await record(['plist-boundary', count, observed])
      instance.slices.push(instance.measurement.result())
    }
    await setPlistCount(instance.fixture, 1000)
    await instance.main.evaluate('window.monitor.refresh("schedules")', 120000)
    const recoveredSchedules = await instance.main.evaluate('window.monitor.snapshot().then(value=>({jobs:value.schedules.data?.jobs.length,error:value.schedules.error}))')
    if (recoveredSchedules.error || recoveredSchedules.jobs !== 1100) throw new Error(`Configuration recovery failed: ${JSON.stringify(recoveredSchedules)}`)
    await record(['plist-recovered', recoveredSchedules])
    instance.phase = 'concurrent-refresh'
    await instance.main.evaluate('Promise.all(Array.from({length:100},()=>window.monitor.refresh()))', 120000)
    instance.phase = 'history-replacement'
    const ids = instance.fixture.hermesJobIds
    const replacements = await instance.main.evaluate(`Promise.allSettled(Array.from({length:200},(_,index)=>window.monitor.scheduleHistory(${JSON.stringify(ids)}[index%100],0))).then(rows=>({fulfilled:rows.filter(row=>row.status==='fulfilled').length,rejected:rows.filter(row=>row.status==='rejected').length}))`, 120000)
    await record(['history-replacement', replacements])
    if (replacements.fulfilled < 1) throw new Error('No final history request completed')
    for (const count of [128, 500, 2000]) {
      instance.phase = `topology-${count}`
      instance.measurement = new Measurement(`${instance.label}:${instance.phase}`)
      await instance.inspector.evaluate(`globalThis.__ocPerformanceControl.nodes(${count})`, 30000)
      await instance.interact(0)
      await instance.duration(full ? 15 : 2)
      instance.slices.push(instance.measurement.result())
    }
    instance.phase = 'oversized-record'
    await withOversizedSession(instance.fixture, async () => {
      const state = await until(async () => {
        const value = await instance.main.evaluate('window.monitor.snapshot().then(value=>({source:value.agents.data?.sources.find(source=>source.id==="agent-activity"),activity:value.agents.data?.agents.find(agent=>agent.id==="performance:0")?.activity}))')
        return value?.source?.detail.includes('尾部窗口之前的记录未读取') && !value.activity ? value.source : null
      }, { timeout: 5000, signal: abort.signal })
      await record(['oversized-record', state.state])
    })
    instance.phase = 'locked-database'
    const lock = spawn('/usr/bin/sqlite3', ['-batch', '-bail', instance.fixture.database], { stdio: ['pipe', 'pipe', 'pipe'] })
    let locked = false
    lock.once('error', fail)
    readLines(lock.stdout, line => { if (line === 'LOCKED') locked = true }, fail)
    readLines(lock.stderr, line => { if (line) fail(new Error(`Fixture lock failed: ${line}`)) }, fail)
    lock.stdin.on('error', fail)
    try {
      lock.stdin.write("BEGIN EXCLUSIVE; SELECT 'LOCKED';\n")
      await until(() => locked, { timeout: 5000, signal: abort.signal })
      const observed = await instance.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(ids[0])},0).then(()=>({unexpectedSuccess:true}),error=>({error:String(error)}))`)
      if (!/locked|锁定/i.test(observed.error ?? '')) throw new Error(`Database lock was not reported: ${JSON.stringify(observed)}`)
      await record(['locked-database', observed])
    } finally {
      lock.stdin.end('ROLLBACK;\n.quit\n')
      await waitExit(lock, 5000)
    }
    instance.phase = 'history-timeout'
    const database = instance.fixture.database
    await command('/usr/bin/sqlite3', ['-batch', '-bail', database, 'ALTER TABLE executions RENAME TO performance_saved_executions; CREATE VIEW executions AS SELECT * FROM performance_saved_executions WHERE (WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<100000000) SELECT count(*) FROM slow)>0;'])
    try {
      const began = now()
      const observed = await instance.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(ids[0])},0).then(()=>({unexpectedSuccess:true}),error=>({error:String(error)}))`, 10000)
      if (!/超时|timed out/i.test(observed.error ?? '')) throw new Error(`Slow history query did not reach its timeout: ${JSON.stringify(observed)}`)
      await record(['history-timeout', now() - began, observed])
    } finally {
      await command('/usr/bin/sqlite3', ['-batch', '-bail', database, 'DROP VIEW executions; ALTER TABLE performance_saved_executions RENAME TO executions;'])
    }
    const recovered = await instance.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(ids[0])},0).then(value=>value.entries.length)`)
    if (recovered !== 25) throw new Error('History reader did not recover after the timeout fixture')
  })
  const after = await fingerprint()
  if (after.digest !== result.source.digest) throw new Error('Source changed during measurement; results cannot be compared as one version')
  abort.signal.throwIfAborted()
  result.complete = true
} catch (error) {
  result.error = { message: String(error), details: error instanceof AggregateError ? error.errors.map(String) : [], cancellation: abort.signal.aborted ? String(abort.signal.reason) : null }
  process.exitCode = 1
  console.error(result.error.message)
} finally {
  if (current && !current.finished) {
    try { await current.stop() } catch (error) { result.cleanupError = String(error); process.exitCode = 1; result.complete = false }
  }
  result.finishedAt = new Date().toISOString()
  if (abort.signal.aborted) { result.complete = false; process.exitCode = 1; result.cancellation = String(abort.signal.reason) }
  try { await log.close() } catch (error) { result.evidenceError = String(error); result.complete = false; process.exitCode = 1 }
  if (options.scenario === 'soak') {
    try { await rm(path.join(output, 'progress.pending'), { force: true }) }
    catch (error) { result.cleanupError = String(error); result.complete = false; process.exitCode = 1 }
  }
  result.evidenceBytes = log.bytes
  if (options.scenario === 'soak') result.evidenceEncoding = { format: 'jsonl+gzip', rawBytes: log.rawBytes, gzipBytes: log.bytes, diskBudgetBytes: log.maxBytes,
    aggregation: 'Raw one-second resources and all reported child lifecycles; event counts and latency histograms aggregated by hour; minute heartbeats. No per-event trace claim.' }
  result.hostEnd = { freeMemoryBytes: os.freemem(), load: os.loadavg() }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(`Result: ${path.join(output, 'result.json')} (${result.complete ? 'complete' : 'incomplete'})`)
}
