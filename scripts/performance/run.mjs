import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Driver } from '../smoke-renderer.mjs'
import { captureDeliverySource } from '../delivery-source.mjs'
import { EvidenceLog, Distribution, now, readLines, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { startSampler } from './sampler.mjs'
import { prepareSmokeFixtures } from './agent-fixtures.mjs'
import { SessionLoad } from './session-load.mjs'
import { mutateSchedules } from './fixtures.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url)), exec = promisify(execFile)
const options = { mode: 'smoke', scenario: 'idle', seed: '20261104', sampler: 'user' }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '')
  assert(['mode', 'scenario', 'seed', 'sampler', 'out'].includes(key) && process.argv[index + 1], 'Invalid performance arguments')
  options[key] = process.argv[index + 1]
}
assert(['smoke', 'baseline'].includes(options.mode))
assert(['all', 'startup', 'idle', 'daily', 'stress', 'soak'].includes(options.scenario))
assert.equal(options.sampler, 'user', 'Performance never requests additional system permissions')
assert(process.platform === 'darwin' && process.getuid() !== 0)
const output = options.out ? path.resolve(options.out) : await mkdtemp(path.join(os.tmpdir(), 'oc-gpui-performance-'))
if (options.out) await mkdir(output, { mode: 0o700 })
const log = new EvidenceLog(path.join(output, 'evidence'), { gzip: options.scenario === 'soak' })
await log.initialize()
const abort = new AbortController(), fail = error => abort.abort(error)
const interrupted = () => fail(new Error('Performance interrupted'))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupted)
const result = { schema: 4, renderer: 'gpui', options, complete: false, runs: [], errors: [], startedAt: new Date().toISOString(),
  scope: { processCoverage: 'birth-verified native host and observed descendants; launcher measured separately',
    workload: 'isolated HOME; production ps/lsof session discovery; daily 32 sessions at 1Hz, stress 128 sessions at 10Hz, soak 128 sessions at 1Hz with hourly 10Hz bursts; bounded real schedule file mutations',
    missing: ['sub-poll helper lifetimes', 'GPU memory and completion', 'presented frames and refresh rate', 'event-to-paint latency', 'old DOM-only fault and topology scenarios', 'sleep and network transitions'],
    acceptance: 'measurement evidence only; no performance improvement or product acceptance claim' } }
const binary = path.join(output, 'process-sampler')
async function run(scenario) {
  const directory = await mkdtemp(path.join(output, `${scenario}-`)), loaded = ['daily', 'stress', 'soak'].includes(scenario)
  const sessionCount = scenario === 'daily' ? 32 : 128, fixtureDirectory = path.join(directory, 'fixtures')
  await mkdir(fixtureDirectory, { mode: 0o700 })
  const fixture = loaded ? await prepareSmokeFixtures(fixtureDirectory, options.seed, sessionCount) : null
  const home = fixture?.home ?? path.join(directory, 'home')
  if (!fixture) await mkdir(home, { mode: 0o700 })
  const load = fixture ? new SessionLoad(fixture) : null
  const workload = { sessions: fixture ? sessionCount : 0, fixtureProcesses: fixture?.agentPids.length ?? 0, writes: 0, bytes: 0, batches: 0, scheduleMutations: 0, rotations: 0 }
  const measurement = new Measurement(scenario), roundTrips = new Distribution()
  let receipt, driver, sampler, stopping = false, failure, observed, sampleCount = 0, lastSample = now()
  const began = now(), launcher = spawn(process.execPath, ['scripts/develop.mjs'], { cwd: root,
    env: { ...process.env, OC_CHAN_HEADLESS: '1', OC_CHAN_HOME: home, OC_CHAN_ACCEPTANCE_RECOVERY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const completion = new Promise(resolve => {
    launcher.once('error', error => { fail(error); resolve({ error }) })
    launcher.once('close', (code, signal) => { if (!stopping) fail(new Error(`GPUI launcher exited: ${signal ?? code}`)); resolve({ code, signal }) })
  })
  const consume = line => {
    if (line.startsWith('{')) { const value = JSON.parse(line); if (value.driverDirectory) { assert(!receipt, 'Driver restarted'); receipt = value } }
    void log.append(['launcher', scenario, line]).catch(fail)
  }
  readLines(launcher.stdout, consume, fail); readLines(launcher.stderr, consume, fail)
  const elapsed = async action => {
    const at = now(), value = await action(); roundTrips.add(now() - at); return value
  }
  let readyMs
  try {
    if (load) await load.initialize()
    await until(() => receipt, { timeout: 600000, signal: abort.signal })
    driver = await Driver.open(receipt)
    await until(async () => {
      const state = await driver.request('state')
      assert(!['fault', 'stopping', 'stopped'].includes(state.phase), `Native startup failed: ${JSON.stringify(state)}`)
      assert(!state.views.main?.error, JSON.stringify(state.views.main?.error))
      return state.phase === 'running' && state.views.main?.connected
    }, { timeout: 60000, signal: abort.signal })
    observed = await until(async () => {
      const value = await driver.request('inspect')
      assert(!value.error, JSON.stringify(value.error))
      return value.ui?.settingsLoaded ? value : null
    }, { timeout: 60000, signal: abort.signal })
    readyMs = now() - began
    assert.equal(observed.native.visible, false); assert.equal(observed.native.key, false)
    if (fixture) {
      const expected = new Set(fixture.agentIds)
      observed = await until(async () => {
        const value = await driver.request('inspect'), selected = value.ui?.agents?.filter(agent => expected.has(agent.id)) ?? []
        if (selected.length !== sessionCount) return null
        assert.deepEqual([...new Set(selected.map(agent => agent.pid))].sort(), [...fixture.agentPids].sort(), 'Production discovery PID ownership differs')
        return value
      }, { timeout: 60000, signal: abort.signal })
      await log.append(['fixture-discovery', scenario, observed.ui.agents.filter(agent => expected.has(agent.id))])
    }
    sampler = await startSampler(binary, { privilege: 'user', signal: abort.signal })
    readLines(sampler.output, line => {
      const row = JSON.parse(line)
      if (row.type === 'resources') { sampleCount++; lastSample = now(); measurement.resources(row) }
      void log.append(['resources', scenario, row]).catch(fail)
    }, fail)
    readLines(sampler.errors, line => { if (line) fail(new Error(line)) }, fail)
    sampler.input.write(`roots ${receipt.pid} ${launcher.pid}\n`)
    await until(() => sampleCount > 0, { timeout: 5000, signal: abort.signal })
    const seconds = options.mode === 'smoke' ? 8 : scenario === 'soak' ? 86400 : scenario === 'daily' ? 600 : 60
    const navigation = ['agents', 'schedules', 'events', 'system', 'overview'], started = now(), end = started + seconds * 1000
    let next = started, nextLoad = started, nextMutation = started + 60000, nextRotation = started + 60000, index = 0
    while (now() < end) {
      abort.signal.throwIfAborted()
      assert(now() - lastSample < 5000, 'Native resource sampling stopped')
      if (load && now() >= nextLoad) {
        const burst = scenario === 'stress' || scenario === 'soak' && (now() - started) % 3600000 < 60000
        const value = await load.write(sessionCount, ++workload.batches)
        workload.writes += value.count; workload.bytes += value.bytes; workload.rotations = value.rotations
        await log.append(['session-load', scenario, value])
        nextLoad += burst ? 100 : 1000
        assert(now() - nextLoad < 1000, 'Requested session pressure fell behind more than one second')
      }
      if (load && now() >= nextRotation) { await load.rotate(); nextRotation += 60000 }
      if (fixture && now() >= nextMutation) {
        const changed = await mutateSchedules(fixture, { sequence: ++workload.scheduleMutations })
        await log.append(['schedule-mutation', scenario, changed]); nextMutation += 60000
      }
      if (['daily', 'stress', 'soak'].includes(scenario) && now() >= next) {
        const page = navigation[index++ % navigation.length]
        await elapsed(() => driver.request('navigate', { page }))
        observed = await driver.request('inspect')
        assert.equal(observed.ui.page, page)
        assert.equal(observed.native.visible, false); assert.equal(observed.native.key, false)
        await log.append(['navigation', scenario, page, observed])
        next = now() + 15000
      }
      await delay(10, undefined, { signal: abort.signal })
    }
    assert(sampleCount >= 2 && measurement.appRss.count > 0, 'No measured native host samples')
    if (load) assert(workload.writes >= sessionCount && workload.bytes > 0, 'No actual session pressure was written')
    const measured = measurement.result()
    result.runs.push({ scenario, elapsedMs: now() - began, launchToSettingsObservedMs: readyMs, samples: sampleCount,
      navigationCommands: index, workload, driverRoundTripMs: roundTrips.result(), native: observed.native,
      applicationRssMiB: measured.applicationRssMiB, applicationCpuOneCorePercent: measured.applicationCpuOneCorePercent,
      developmentRssMiB: measured.developmentRssMiB, developmentCpuOneCorePercent: measured.developmentCpuOneCorePercent,
      maxObservedFd: measured.maxObservedFd, maxObservedProcesses: measured.maxObservedProcesses,
      coverage: { resourceSamples: measured.counters.resourceSamples, incompleteResourceSamples: measured.counters.incompleteResourceSamples,
        incompleteApplicationSamples: measured.counters.incompleteApplicationSamples, incompleteApplicationCpuIntervals: measured.counters.incompleteApplicationCpuIntervals } })
  } catch (error) { failure = error }
  stopping = true
  const failures = failure ? [failure] : []
  if (sampler) try { await sampler.dispose() } catch (error) { failures.push(error) }
  let quitRequested = false
  if (driver) try { await driver.request('quit'); quitRequested = true } catch (error) { failures.push(error) }
  driver?.close()
  if (!quitRequested && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM')
  try {
    await until(() => launcher.exitCode !== null || launcher.signalCode !== null, { timeout: 30000 })
    const exit = await completion
    if (quitRequested) assert.equal(exit.code, 0, `Launcher shutdown failed: ${exit.signal ?? exit.error}`)
  } catch (error) {
    failures.push(error)
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM')
      try { await until(() => launcher.exitCode !== null || launcher.signalCode !== null, { timeout: 35000 }) } catch (drain) { failures.push(drain) }
    }
  }
  if (fixture) try { await fixture.stopAgents() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'GPUI measurement or cleanup failed')
}
try {
  result.source = await captureDeliverySource(root)
  result.host = { arch: process.arch, memoryBytes: os.totalmem(), cpu: os.cpus()[0].model, node: process.version }
  await exec('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', path.join(root, 'scripts/performance/process-sampler.c'), '-o', binary], { timeout: 30000, maxBuffer: 1024 * 1024 })
  for (const scenario of options.scenario === 'all' ? ['startup', 'idle', 'daily', 'stress'] : [options.scenario]) await run(scenario)
  assert.equal((await captureDeliverySource(root)).digest, result.source.digest, 'Source changed during measurement')
  abort.signal.throwIfAborted(); result.complete = true
} catch (error) {
  result.errors.push(String(error.stack ?? error)); if (error instanceof AggregateError) result.errors.push(...error.errors.map(String)); process.exitCode = 1
} finally {
  try { await log.close() } catch (error) { result.errors.push(String(error)); process.exitCode = 1 }
  result.complete &&= result.errors.length === 0; result.finishedAt = new Date().toISOString()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupted)
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(`GPUI native process evidence: ${output}`)
}
