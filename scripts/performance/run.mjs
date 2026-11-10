import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvidenceLog, Distribution, now, readLines, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { prepareSmokeFixtures, Driver, absent } from '../smoke/main-probe.mjs'
import { SessionLoad } from './session-load.mjs'
import { runSoak } from './soak-scenario.mjs'
import { runStress, plugins, assertBudget } from './scenarios.mjs'
import { startSampler } from './sampler.mjs'
import { AssociatedProcesses } from './xpc.mjs'
import { comparisonWorkload, comparisonSettings, observedSettings, alignViewport } from './comparison-workload.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url)), exec = promisify(execFile)
const options = { mode: 'baseline', seed: '20261104', scenario: 'all', sampler: 'user' }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '')
  if (!['mode','seed','scenario','sampler','out'].includes(key) || process.argv[index + 1] === undefined) throw new Error('Invalid performance arguments')
  options[key] = process.argv[index + 1]
}
assert(['baseline','smoke'].includes(options.mode) && ['all','startup','idle','daily','stress','soak'].includes(options.scenario))
assert.equal(options.sampler, 'user', 'Performance never requests additional system permissions')
assert(process.platform === 'darwin' && process.getuid() !== 0 && options.seed.length <= 128)
const full = options.mode === 'baseline', abort = new AbortController()
const fail = error => { if (!abort.signal.aborted) abort.abort(error instanceof Error ? error : new Error(String(error))) }
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.once(signal, () => fail(new Error(`Performance interrupted: ${signal}`)))
const output = options.out ? path.resolve(options.out) : await mkdtemp(path.join(os.tmpdir(), 'oc-chan-performance-'))
if (options.out) await mkdir(output, { mode: 0o700 })
const log = new EvidenceLog(path.join(output, 'evidence'), { gzip: options.scenario === 'soak' })
await log.initialize()
const record = row => log.append(row).catch(error => { fail(error); throw error })
const result = { schema: 3, options, startedAt: new Date().toISOString(), complete: false, runs: [], errors: [],
  scope: { headless: true, permissionRequests: false, processCoverage: 'native descendants and separately measured birth-verified WK instance associations',
    webkitXpc: { method:'acceptance-only WebKit instance SPI, birth identity checked by driver and sampler; shared identities deduplicated',coverage:'reported per run; unavailable roles and expired association leases remain gaps' },
    totalApplicationMemoryComparison: 'no exclusive-cost or improvement claim: associated XPC processes may be shared and incomplete intervals are excluded',
    watchTiming: 'missing: reader start/completion are observed; no event-specific filesystem watch timestamp',
    publication: 'actual core Publisher acceptance before monitor deduplication; delivery and commit have separate coverage',
    hidden: 'native windows remain hidden; acceptance presentation state is explicit and does not change document visibility or native rAF',
    frames: 'milliseconds between draws in distinct observed native rAF timestamp buckets; hidden WK may suspend rAF; neither physical presentation nor display refresh rate',
    webglDraws: 'original WebGL draw methods returned; synchronous calls coalesced by at most one pending microtask, independent of rAF; not GPU completion or presented frames; run-wide including warmup and mode transitions',
    bytes: 'UTF-8 JSON of received event value, excluding Tauri transport envelope; not wire bytes',
    lifecycle: 'acceptance command spawn/exit plus verified sampled birth identities; startup before probe install, unseen grandchildren, and sub-poll lifetimes remain missing',
    readBytes: 'only reads carrying a fixture correlation key; not all filesystem traffic',
    collectionTiming: 'missing: no per-section collect-span hook',
    physicalRefresh: false, sleepNetworkTransitions: false }, evidenceDirectory: log.directory }
let current
async function command(file, args) { return (await exec(file, args, { cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim() }
async function fingerprint() {
  const files = []
  async function visit(relative) {
    const absolute = path.join(root, relative), info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`Source fingerprint refuses symlink: ${relative}`)
    if (info.isDirectory()) { for (const child of (await readdir(absolute)).sort()) if (!['target','gen','node_modules'].includes(child)) await visit(path.join(relative, child)) }
    else if (info.isFile()) {
      if (files.length >= 8192 || info.size > 16 * 1024 * 1024) throw new Error('Source fingerprint budget exceeded')
      files.push({ path: relative, bytes: info.size, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') })
    }
  }
  for (const target of ['src','scripts','crates','src-tauri','native','Cargo.toml','Cargo.lock','rust-toolchain.toml','vite.config.ts','package.json','package-lock.json','tsconfig.json']) await visit(target)
  return { digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
}
async function processes() {
  return (await command('/bin/ps', ['-axo','pid=,ppid=,lstart=,command='])).split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line)
    return match ? { pid: Number(match[1]), parent: Number(match[2]), birth: match[3], command: match[4] } : null
  }).filter(Boolean)
}
async function deadline(promise, timeout, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
class Run {
  constructor(label, level) {
    this.label = label; this.level = level; this.phase = 'startup'; this.sequence = 0; this.metrics = true
    this.measurement = new Measurement(label); this.frames = new Distribution(); this.slices = []; this.calibrations = []; this.stages = {}; this.loaded = 0
    this.draws = { batches: 0, calls: 0, byView: { main: { batches: 0, calls: 0 }, tray: { batches: 0, calls: 0 } } }; this.rendererEvidence = {}
    this.workloadExecuted = { warmupEvents:0, measuredEvents:0, writtenBytes:0, interactions:0, historyQueries:0, mutationBatches:0, mutatedFiles:0 }
    this.children = new Set(); this.lifecycleIdentities = new Map(); this.lifecycleGaps = 0
    this.channelTraffic = Object.fromEntries(['main','tray'].map(view => [view,Object.fromEntries(['monitor','sources','settings','updates','marketplace','navigation'].map(key => [key,{messages:0,bytes:0}]))]))
    this.associated = new AssociatedProcesses(label)
  }
  async start() {
    this.directory = await mkdtemp(path.join(output, 'run-'))
    const fixtures = path.join(this.directory, 'fixtures'); await mkdir(fixtures, { mode: 0o700 })
    if (this.level === 'L0') {
      this.fixture = { home:path.join(fixtures,'home') }; await mkdir(this.fixture.home, { mode:0o700 })
    } else {
      this.fixture = await prepareSmokeFixtures(fixtures, options.seed, this.level === 'L2' || options.scenario === 'soak' ? 128 : 32)
      this.load = new SessionLoad(this.fixture); await this.load.initialize()
    }
    this.workload = await comparisonWorkload({ ...options, level:this.level })
    const settingsSeed = path.join(this.directory,'settings.json')
    await writeFile(settingsSeed,JSON.stringify(comparisonSettings),{flag:'wx',mode:0o600})
    this.sampler = await startSampler(path.join(output, 'process-sampler'), { privilege: 'user' })
    readLines(this.sampler.output, line => {
      const row = JSON.parse(line)
      if (row.type === 'lifecycle') {
        const expected = this.lifecycleIdentities.get(row.pid)
        this.lifecycleIdentities.delete(row.pid)
        if (!expected || row.startId !== expected) {
          this.lifecycleGaps++; row.incomplete = true; row.missed = true
          row.identityMismatch = true; row.maxRssBytes = null
        }
      }
      // Sampling before app-spawn has no application identity yet.
      if (!this.pid) return
      if (this.metrics) this.measurement.resources(row)
      if (this.metrics) this.associated.resources(row)
      this.soak?.resources(row)
      void record(['resources', this.label, this.phase, row]).catch(fail)
    }, fail, 2 * 1024 * 1024)
    readLines(this.sampler.errors, line => { if (line) fail(new Error(line)) }, fail)
    this.sampler.input.on('error', fail)
    this.startedAt = now()
    this.launcher = spawn('npm', ['run','dev'], { cwd: root, env: { ...process.env, OC_CHAN_HEADLESS: '1', OC_CHAN_HOME: this.fixture.home, OC_CHAN_PERFORMANCE: '1', OC_CHAN_ACCEPTANCE_SETTINGS:settingsSeed, OC_CHAN_ACCEPTANCE_RECOVERY:'0' }, stdio: ['ignore','pipe','pipe'] })
    this.launcher.once('error', fail)
    this.completion = new Promise(resolve => this.launcher.once('close', (code, signal) => { this.exited = true; this.exit = { code, signal }; resolve(); if (!this.stopping) fail(new Error(`Owned dev exited: ${signal ?? code}`)) }))
    const consume = line => {
      const match = /^\[oc-chan\] 独立 Rust 实例：(.*)$/.exec(line)
      if (match) { assert.equal(path.dirname(match[1]), path.join(root, '.dev-instances')); this.instance = match[1] }
      if (line.startsWith('__OC_PERF_STAGE__')) {
        const stage = JSON.parse(line.slice('__OC_PERF_STAGE__'.length)); this.stages[stage.performanceStage] = stage
        if (stage.performanceStage === 'app-spawn') { this.pid = stage.pid; this.associated.rootPid = this.pid; this.send(`roots ${this.pid} ${this.launcher.pid}`) }
      } else if (line.startsWith('{')) {
        let value
        try { value = JSON.parse(line) } catch (error) { throw new Error('Invalid application JSON evidence', { cause: error }) }
        if (value.driverDirectory) { assert(!this.receipt, 'Unexpected driver restart'); this.receipt = value }
        if (value.shutdownReport) this.shutdownReport = value.shutdownReport
      }
      void record(['launcher', this.label, line]).catch(fail)
    }
    readLines(this.launcher.stdout, consume, fail); readLines(this.launcher.stderr, consume, fail)
    await until(() => this.receipt && this.instance, { timeout: 600000, signal: abort.signal })
    assert.equal(this.pid, this.receipt.pid, 'Missing or mismatched application spawn timing')
    this.identity = (await processes()).find(row => row.pid === this.pid); assert(this.identity)
    this.driver = await Driver.open(this.receipt)
    await this.driver.waitForView('main', { timeout:60000, signal:abort.signal })
    this.main = this.driver.view('main')
    await this.driver.host('performance-start'); this.probing = true
    await this.driver.host('shutdown-report')
    await until(() => this.main.evaluate('Boolean(window.__ocPerf && window.monitor && document.querySelector(".app-shell"))'), { timeout: 60000, signal: abort.signal })
    this.viewport = { main:await alignViewport(this.main,1280,860) }
    this.settingsObserved = await observedSettings(this.main)
    await this.main.evaluate('window.__ocPerf.visibility(false)')
    await this.calibrate()
    await this.operation('window.monitor.refresh()')
    await until(() => this.main.evaluate('window.__ocPerf.status().ready'), { timeout: 60000, signal: abort.signal })
    this.readyObservedAt = now()
    await this.interact(0); this.interactiveAt = now()
    const native = await this.main.inspect(); assert(!native.visible && !native.key && !native.appActive && native.activationPolicy === 2)
    this.native = native
    const info = await this.driver.host('info'); assert.equal(info.home, this.fixture.home); assert.equal(info.profile, path.join(this.instance, 'profile'))
    await this.drain()
    if (this.level === 'L1') {
      await this.operation('window.pluginMarketplace.install("system").then(value=>{if(value.error)throw new Error(value.error);return null})')
      await this.operation('window.monitor.refresh("system")')
      assert(await this.main.evaluate('window.monitor.snapshot().then(value=>Boolean(value.system.data && !value.system.error))'), 'Native system plugin failed to initialize')
      if (this.workload?.scenario === 'daily') {
        const selected = await this.main.evaluate(`window.monitor.snapshot().then(value=>value.agents.data.agents.filter(agent=>${JSON.stringify(this.fixture.agentIds)}.includes(agent.id)).map(agent=>({id:agent.id,pid:agent.pid})))`)
        assert.equal(selected.length,32,'Production discovery did not recover all real fixture sessions')
        assert.equal(new Set(selected.map(agent=>agent.pid)).size,4,'Fixture process ownership mismatch')
        this.fixtureDiscovery = { sessions:selected.length, processes:new Set(selected.map(agent=>agent.pid)).size }
        await record(['real-fixture-discovery',this.label,selected])
      }
    }
  }
  send(line) { assert(this.sampler.input.writable && this.sampler.input.writableLength < 65536); this.sampler.input.write(line + '\n') }
  async refreshAssociations() {
    if (this.associated.latest && now()-this.associated.latest.at < 500) return
    const observations = []
    for (const [view, renderer] of [['main',this.main],['tray',this.tray]]) {
      if (!renderer) continue
      const native = await renderer.inspect()
      assert(!native.visible && !native.key && !native.appActive, 'Performance window became visible')
      observations.push({view,processes:native.processes})
    }
    const state = this.associated.update(observations)
    this.send('xpc-reset')
    for (const identity of state.identities) this.send(`xpc ${identity.pid} ${identity.startSeconds} ${identity.startMicroseconds}`)
    await record(['webkit-association',this.label,this.phase,state])
  }
  async calibrate() {
    for (const [domain, clock] of [['rust', () => this.driver.host('performance-clock')], ['main', () => this.main.evaluate('({atMs:window.__ocPerf.clock()})')], ...(this.tray ? [['tray', () => this.tray.evaluate('({atMs:window.__ocPerf.clock()})')]] : [])]) {
      let best
      for (let index = 0; index < 7; index++) {
        const before = now(), remote = await clock(), after = now()
        assert(Number.isFinite(remote.atMs))
        const sample = { domain, at: after, offsetMs: (before + after) / 2 - remote.atMs, errorBoundMs: (after - before) / 2 }
        if (!best || sample.errorBoundMs < best.errorBoundMs) best = sample
      }
      this.offsets ??= {}; this.offsets[domain] = best.offsetMs
      if (this.calibrations.length === 256) this.calibrations.shift()
      this.calibrations.push(best); await record(['clock', this.label, best])
    }
  }
  async drain() {
    await this.refreshAssociations()
    const buffered = []
    const take = async (domain, read) => {
      for (let batch = 0; batch < 65; batch++) {
        const value = await read(); assert.equal(value.overflow, 0, `Observer overflow: ${domain}`)
        assert(value.rows.length <= 128)
        if (domain !== 'rust') this.rendererEvidence[domain] = { documentHidden: value.documentHidden, visibilityState: value.visibilityState, nativeRafTimestamp: value.nativeRafTimestamp }
        for (const row of value.rows) {
          assert(Array.isArray(row) && Number.isFinite(row[1]))
          row[1] += this.offsets[domain]
          if (row[0] === 'r') row[4] += this.offsets[domain]
          if (row[0] === 'input') row[3] += this.offsets[domain]
          buffered.push(row)
        }
        if (!value.remaining) return
      }
      throw new Error(`Probe drain did not converge: ${domain}`)
    }
    await take('rust', () => this.driver.host('performance-drain'))
    await take('main', () => this.main.evaluate('window.__ocPerf.drain()'))
    if (this.tray) await take('tray', () => this.tray.evaluate('window.__ocPerf.drain()'))
    buffered.sort((a,b) => a[1] - b[1])
    for (const row of buffered) {
      if (row[0] === 'spawn') {
        assert(this.children.size < 512 && !this.children.has(row[2]), 'Child observation identity budget/reuse')
        assert(this.lifecycleIdentities.size < 512, 'Lifecycle receipt backlog exceeded')
        this.children.add(row[2])
        this.lifecycleIdentities.set(row[2], row[4] ? `${row[4].startSeconds}:${String(row[4].startMicroseconds).padStart(6,'0')}` : null)
        this.send(`track ${row[2]} ${row[3]}`)
      }
      if (row[0] === 'exit') {
        if (this.children.delete(row[2])) this.send(`exit ${row[2]}`)
        else this.lifecycleGaps++
      }
      if (row[0] === 'commit-ready' && row[2] === 'main') this.initialCommit ??= row[1]
      if (row[0] === 'channel-payload') {
        const traffic = this.channelTraffic[row[2]]?.[row[3]]
        assert(traffic && Number.isSafeInteger(row[4]) && row[4] >= 0)
        traffic.messages++; traffic.bytes += row[4]
      }
      if (row[0] === 'webgl-draw-batch') {
        const counters = this.draws.byView[row[2]]
        assert(counters && Number.isSafeInteger(row[3]) && row[3] > 0 && row[3] <= 65536, 'Invalid WebGL draw batch')
        assert(Number.isSafeInteger(this.draws.calls + row[3]) && this.draws.batches < Number.MAX_SAFE_INTEGER, 'WebGL draw counter budget exceeded')
        this.draws.batches++; this.draws.calls += row[3]; counters.batches++; counters.calls += row[3]
      } else if (row[0] === 'webgl-frame') this.frames.add(row[3])
      else if (this.metrics) this.measurement.metric(row)
      if (this.soak) this.soak.metric(row[0]); else await record(['metric', this.label, this.phase, row])
    }
  }
  async openTray() {
    const began = now(); await this.driver.host('ensure-tray')
    await this.driver.waitForView('tray', { timeout:60000, signal:abort.signal })
    this.tray = this.driver.view('tray')
    await until(() => this.tray.evaluate('Boolean(window.__ocPerf && window.monitor)'), { timeout: 30000, signal: abort.signal })
    this.viewport.tray = await alignViewport(this.tray,380,560)
    await this.tray.evaluate('window.__ocPerf.visibility(false)'); await this.calibrate()
    await until(() => this.tray.evaluate('window.__ocPerf.status().ready'), { timeout: 30000, signal: abort.signal })
    const native = await this.tray.inspect(); assert(!native.visible && !native.key && !native.appActive)
    this.nativeTray = native
    this.trayOpenMs = now() - began
  }
  // Long product operations run inside WK while short driver requests continue draining
  // the bounded observers. Their Promise is always awaited before releasing the slot.
  async operation(expression, timeout = 120000) {
    const token = this.operationId = (this.operationId ?? 0) + 1
    await this.main.evaluate(`(()=>{if(window.__ocPerfOperation)throw new Error('Operation busy');const state=window.__ocPerfOperation={token:${token},done:false};Promise.resolve().then(()=>(${expression})).then(value=>{state.value=value;state.done=true},error=>{state.error=String(error);state.done=true});return true})()`)
    try {
      const value = await until(async () => { await this.drain(); const state = await this.main.evaluate('window.__ocPerfOperation'); return state.done ? state : null }, { timeout, interval: 50, signal: abort.signal })
      if (value.error) throw new Error(value.error)
      return value.value
    } finally { await this.main.evaluate('(()=>{if(window.__ocPerfOperation?.done)delete window.__ocPerfOperation;return true})()') }
  }
  async interact(index) {
    const names = ['协作拓扑','定时任务','系统监控','本机概览'], name = names[index % names.length], began = now()
    const point = await this.main.evaluate(`(()=>{const button=[...document.querySelectorAll('.sidebar nav button')].find(item=>item.textContent.includes(${JSON.stringify(name)}));if(!button)throw new Error('Navigation missing');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,commits:window.__ocPerf.status().commits}})()`)
    await this.main.clickAt(point.x, point.y)
    await until(() => this.main.evaluate(`(()=>{const b=[...document.querySelectorAll('.sidebar nav button')].find(item=>item.textContent.includes(${JSON.stringify(name)}));return b?.getAttribute('aria-current')==='page'})()`), { signal: abort.signal })
    this.measurement.roundTrips.add(now() - began)
    this.workloadExecuted.interactions++
    if (index % names.length === 1 && this.level !== 'L0') {
      const page = await this.operation(`window.monitor.scheduleHistory(${JSON.stringify(this.fixture.hermesJobIds[0])},0)`)
      assert.equal(page.entries.length, 25, 'Real SQLite history page mismatch')
      this.workloadExecuted.historyQueries++
    }
    await this.drain()
  }
  async duration(seconds, { events = false, frequency = 1, interact = false, mutate = false } = {}) {
    const end = now() + seconds * 1000; let next = now(), nextInput = now(), nextMutation = now(), nextClock = now() + 60000
    while (now() < end) {
      abort.signal.throwIfAborted()
      if (events && now() >= next) {
        const at = now(), count = this.level === 'L2' ? 128 : 32, sequence = ++this.sequence
        if (this.metrics) this.measurement.expect(count, sequence, at)
        const load = await this.load.write(count, sequence); this.loaded += count
        this.workloadExecuted[this.metrics ? 'measuredEvents' : 'warmupEvents'] += count
        this.workloadExecuted.writtenBytes += load.bytes
        this.soak?.load(count, now() - at, Math.max(0, at - next))
        if (!this.soak) await record(['load', this.label, this.phase, at, now() - at, load])
        next += 1000 / frequency
        if (now() - next > 1000) throw new Error('Requested event load fell behind more than 1s')
      }
      if (interact && now() >= nextInput) { await this.interact(this.interactionIndex ?? 0); this.interactionIndex = (this.interactionIndex ?? 0) + 1; nextInput += 15000 }
      if (mutate && now() >= nextMutation) {
        const { mutateSchedules } = await import('./fixtures.mjs')
        const changed = await mutateSchedules(this.fixture, { sequence: this.mutation = (this.mutation ?? 0) + 1 })
        this.workloadExecuted.mutationBatches++; this.workloadExecuted.mutatedFiles += changed.length
        nextMutation += 60000
      }
      await this.drain()
      if (now() >= nextClock) { await this.calibrate(); nextClock += 60000 }
      this.soak?.clock()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  summary() {
    const begin = this.stages['build-start']?.atMs, built = this.stages['build-end']?.atMs, spawned = this.stages['app-spawn']?.atMs
    return { ...this.measurement.result(), slices: this.slices, frames: this.frames.result(), webglDraws: this.draws, rendererEvidence: this.rendererEvidence, calibrations: this.calibrations, loaded: this.loaded,
      workload:this.workload, workloadExecuted:this.workloadExecuted, fixtureDiscovery:this.fixtureDiscovery, viewport:this.viewport, settingsObserved:this.settingsObserved,
      channelTraffic:this.channelTraffic, lifecycleIdentityGaps:this.lifecycleGaps,
      associatedProcesses:this.associated.result(),
      startupMs: { build: begin === undefined || built === undefined ? null : built - begin, applicationToCommitObserved: spawned === undefined ? null : this.initialCommit - spawned,
        applicationToInteractive: spawned === undefined ? null : this.interactiveAt - spawned, total: this.interactiveAt - this.startedAt },
      stages: this.stages, native: this.native, nativeTray:this.nativeTray, trayOpenMs: this.trayOpenMs, shutdownReport: this.shutdownReport, soak: this.soak?.result() }
  }
  async stop() {
    this.stopping = true; const errors = []
    const attempt = async action => { try { await action() } catch (error) { errors.push(error) } }
    if (this.driver && !this.driver.closed) {
      if (this.probing) await attempt(async () => { await this.drain(); const final = await this.driver.host('performance-stop'); assert.equal(final.overflow, 0); assert.equal(final.remaining, 0, 'Undrained performance rows at uninstall'); await record(['final-core-observations',this.label,final]); this.probing = false })
      await attempt(async () => { for (const view of [this.main, this.tray].filter(Boolean)) await view.evaluate('window.__ocPerf.dispose()'); await this.driver.request('quit'); await deadline(this.completion, 30000, 'application drain') })
      this.driver.close()
    }
    if (this.launcher && !this.exited) await attempt(async () => {
      const rows = await processes(), owned = new Set([this.launcher.pid])
      for (let pass = 0; pass < 8; pass++) for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
      const developers = rows.filter(row => owned.has(row.pid) && /(?:^|\s)(?:\S*\/)?scripts\/develop\.mjs(?:\s|$)/.test(row.command))
      assert.equal(developers.length, 1, 'Cannot identify owned developer process; preserve evidence')
      const owner = developers[0], live = (await processes()).find(row => row.pid === owner.pid); assert.equal(live?.birth, owner.birth)
      process.kill(owner.pid, 'SIGTERM'); await deadline(this.completion, 30000, 'owned developer drain')
    })
    if (this.sampler) await attempt(() => this.sampler.dispose())
    if (this.fixture?.stopAgents) await attempt(() => this.fixture.stopAgents())
    if (this.exited && this.receipt) await attempt(async () => {
      assert(await absent(this.receipt.driverDirectory), 'Driver directory remains')
      assert(await absent(this.instance), 'Development instance remains')
      assert(!(await processes()).some(row => row.pid === this.pid && row.birth === this.identity?.birth), 'Owned application remains alive')
      assert(this.shutdownReport, 'Missing shutdown report')
      assert.equal(this.shutdownReport.documents, 0); assert.equal(this.shutdownReport.requests, 0)
      assertBudget(this.shutdownReport.resources, true)
    })
    if (errors.length) throw new AggregateError(errors, 'Performance cleanup failed')
  }
}
async function run(label, level, action) {
  current = new Run(label, level)
  let failure
  try { await current.start(); await action(current); await current.drain(); assertBudget((await current.driver.host('info')).resources) }
  catch (error) { failure = error }
  const instance = current
  try { await instance.stop() }
  catch (cleanup) { failure = failure ? new AggregateError([failure, cleanup], 'Performance scenario and cleanup failed') : cleanup }
  finally { result.runs.push(instance.summary()); current = null }
  if (failure) throw failure
}
const selected = name => options.scenario === 'all' || options.scenario === name
const totalTimer = setTimeout(() => fail(new Error('Performance total deadline exceeded')), (options.scenario === 'soak' ? full ? 25 * 3600 : 1200 : full ? 4 * 3600 : 1800) * 1000)
try {
  result.source = { commit: await command('git',['rev-parse','HEAD']), branch: await command('git',['branch','--show-current']), workspace: await command('git',['status','--porcelain']), ...await fingerprint() }
  result.host = { os: await command('/usr/bin/sw_vers',[]), arch: process.arch, cpu: os.cpus()[0].model, logicalCores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, power: await command('/usr/bin/pmset',['-g','batt']) }
  await record(['manifest', result])
  await command('/usr/bin/clang', ['-O2','-Wall','-Wextra','scripts/performance/process-sampler.c','-o',path.join(output,'process-sampler')])
  if (options.scenario === 'soak') await run('L1-soak','L1', instance => runSoak(instance, { full, abort, record, progress: async heartbeat => {
    result.heartbeat = heartbeat; await writeFile(path.join(output,'progress.pending'), JSON.stringify(result, null, 2), { mode: 0o600 }); await rename(path.join(output,'progress.pending'),path.join(output,'progress.json'))
  } }))
  if (selected('startup')) for (let index = 0; index < (full ? 10 : 1); index++) await run(`cold-${index+1}`,'L0', instance => instance.openTray())
  if (selected('idle')) await run('L0-visibility','L0', async instance => {
    await instance.openTray(); instance.metrics = false; await instance.duration(full ? 120 : 2); instance.metrics = true
    for (const visible of ['main','tray','neither']) {
      instance.phase = visible; instance.measurement = new Measurement(`${instance.label}:${visible}`)
      await instance.main.evaluate(`window.__ocPerf.visibility(${visible !== 'main'})`); await instance.tray.evaluate(`window.__ocPerf.visibility(${visible !== 'tray'})`)
      await instance.duration(full ? 60 : 2); instance.slices.push(instance.measurement.result())
    }
  })
  if (selected('daily')) for (let index = 0; index < (full ? 5 : 1); index++) await run(`L1-${index+1}`,'L1', async instance => {
    await instance.openTray(); instance.metrics = false; await instance.duration(full ? 120 : 2, { events: true }); instance.metrics = true
    instance.measurement = new Measurement(instance.label); instance.phase = 'measured'
    await instance.duration(full ? 600 : 8, { events: true, interact: true, mutate: true }); await instance.duration(2)
    assert(instance.measurement.counters.committed > 0, 'No real React event commit observed')
  })
  if (selected('stress')) await run('L2-boundaries','L2', instance => runStress(instance, { full, abort, record }))
  assert.equal((await fingerprint()).digest, result.source.digest, 'Source changed during measurement')
  abort.signal.throwIfAborted(); result.complete = true
} catch (error) {
  result.errors.push(String(error.stack ?? error)); if (error instanceof AggregateError) result.errors.push(...error.errors.map(String)); process.exitCode = 1
} finally {
  clearTimeout(totalTimer)
  if (current) { try { await current.stop() } catch (error) { result.errors.push(String(error)); process.exitCode = 1 } }
  try { await log.close() } catch (error) { result.errors.push(String(error)); process.exitCode = 1 }
  result.complete &&= result.errors.length === 0; result.finishedAt = new Date().toISOString()
  await writeFile(path.join(output,'result.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(`Performance evidence: ${output}`)
}
