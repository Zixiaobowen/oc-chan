import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { until } from '../performance/core.mjs'
import { exerciseEmptyEvents, exerciseEvents } from './events-scenarios.mjs'
import { exerciseNotifications } from './notification-scenarios.mjs'
import { exerciseTopology } from './topology-scenarios.mjs'
import { exerciseMarketplace, verifyMarketplaceRestart } from './marketplace-scenarios.mjs'
import { boundedFile } from './main-probe.mjs'

const WAIT_MS = 8_000
const RPC_MS = 5_000
const HISTORY_SIZE = 25
const SCHEDULES = '[data-source-section="schedules"]'
const DRAWER = '#schedule-task-details[data-open="true"]'
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const usageKeys = ['commands', 'files', 'sockets', 'stdoutBytes', 'stderrBytes', 'commandBytes', 'fileBytes', 'socketBytes', 'pluginProcesses', 'pluginProtocolBytes', 'queued']

function failureEvidence(error, depth = 0) {
  const details = { message: String(error).slice(0, 1024) }
  if (depth < 2 && error?.cause) details.cause = failureEvidence(error.cause, depth + 1)
  if (depth < 2 && error instanceof AggregateError) details.errors = error.errors.slice(0, 4).map(item => failureEvidence(item, depth + 1))
  return details
}

function controls({ main, renderer, record, capture }) {
  const evaluate = expression => renderer.evaluate(expression, RPC_MS)
  async function expect(name, predicate, timeout = WAIT_MS) {
    try { return await until(predicate, { timeout, interval: 40 }) }
    catch (error) { throw new Error(`Smoke assertion: ${name}`, { cause: error }) }
  }
  const dom = (name, expression, timeout) => expect(name, () => evaluate(expression), timeout)
  async function key(key, code, _virtualKeyCode, modifiers = 0) {
    await renderer.key(key, code, modifiers)
  }
  async function click(expression) {
    await dom('click target exists and is enabled', `(() => {
      const element = ${expression};
      return !!element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]');
    })()`)
    await evaluate(`(${expression}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`)
    const point = await dom('click target is visible and unobstructed', `(() => {
      const element = ${expression};
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const hit = document.elementFromPoint(x,y);
      return hit && element.contains(hit) ? {x,y} : false;
    })()`)
    await renderer.clickAt(point.x, point.y)
  }
  async function navigate(zh, en) {
    await click(`Array.from(document.querySelectorAll('.nav-item')).find(element => [${JSON.stringify(zh)},${JSON.stringify(en)}].includes(element.querySelector('span')?.textContent))`)
    await dom(`navigation to ${en}`, `[${JSON.stringify(zh)},${JSON.stringify(en)}].includes(${$('.page-heading h1')}?.textContent)`)
  }
  async function frames() {
    // Headless stores every window hidden. The DOM does not promise animation
    // frames to hidden documents, so settle style and layout synchronously and
    // report that mode instead of waiting for a callback WebKit may suspend.
    if (await evaluate('document.visibilityState') === 'hidden') {
      await evaluate('(() => { void document.documentElement.offsetHeight; return true; })()')
      return 'hidden-layout-flush'
    }
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    return 'two-animation-frames'
  }
  async function stage(name, action) {
    record(name, { status: 'started' })
    try {
      assert.deepEqual(await evaluate('window.__ocSmokeRendererErrors'), { entries: [], dropped: 0 }, 'Document error observation is unavailable or captured a renderer exception')
      const details = await action()
      assert.deepEqual(await evaluate('window.__ocSmokeRendererErrors'), { entries: [], dropped: 0 }, 'Renderer raised an uncaught error or rejected promise')
      record(name, { status: 'passed', ...details })
      await capture(name)
      return details
    } catch (error) {
      record(name, { status: 'failed', error: failureEvidence(error) })
      record('renderer-failure-state', await evaluate(`(async () => ({ errors: window.__ocSmokeRendererErrors, hidden: document.hidden, visibilityState: document.visibilityState, displayLive: document.querySelector('.app-shell')?.dataset.displayLive, rootChildren: document.getElementById('root')?.childElementCount, topology: { floor: document.querySelector('.topology-3d-picker select')?.value ?? null, visibleEmployees: Array.from(document.querySelectorAll('.topology-3d-label:not([hidden])'), label => label.dataset.id).slice(0, 32), canvas: (() => { const canvas = document.querySelector('.topology-3d-webgl'); return canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null; })() }, sources: Object.fromEntries(Object.entries(await window.monitor.snapshot()).map(([section, state]) => [section, state.data?.sources.map(({id, state, capabilities, diagnostics}) => ({id, state, capabilities, diagnostics}))])) }))()`))
      try { await capture(`${name}-failed`) }
      catch (captureError) { throw new AggregateError([error, captureError], `${name}: assertion and screenshot failed`) }
      throw error
    }
  }
  async function info() {
    const value = await main.host('info')
    assert.ok(value && Array.isArray(value.windows) && value.resources?.sources, 'smoke control diagnostics must be present')
    assert.ok(value.windows.length > 0 && value.windows.every(window => window.visible === false && window.focusable === false), 'smoke must never show or focus a native window')
    return value
  }
  return { evaluate, expect, dom, click, key, navigate, frames, stage, info }
}

// Open only files explicitly owned by this fixture, reject links, and keep the inode
// open so error injection and restoration cannot accidentally follow a replacement.
async function fixtureFile(manifest, key, maximumBytes, writable = false) {
  assert.ok(manifest && path.isAbsolute(manifest.root), 'fixture root required')
  const expected = path.join(manifest.root, 'home', '.hermes', 'cron', key === 'jobsFile' ? 'jobs.json' : 'executions.db')
  assert.equal(manifest[key], expected, 'fixture path must match its manifest root')
  assert.equal(await realpath(manifest.root), manifest.root, 'fixture root must be canonical')
  for (let directory = path.dirname(expected); directory !== manifest.root; directory = path.dirname(directory)) {
    const stat = await lstat(directory)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'fixture ancestors must be real directories')
  }
  const file = await open(expected, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= maximumBytes, 'fixture file must be regular, single-link and bounded')
    return { file, stat, path: expected }
  } catch (error) { await file.close(); throw error }
}

async function replaceContents(owned, contents) {
  const current = await lstat(owned.path)
  assert.equal(current.ino, owned.stat.ino, 'fixture inode changed')
  assert.equal(current.dev, owned.stat.dev, 'fixture device changed')
  assert.ok(current.isFile() && !current.isSymbolicLink() && current.nlink === 1, 'fixture file was replaced or linked')
  await owned.file.truncate(0)
  let offset = 0
  while (offset < contents.length) {
    const { bytesWritten } = await owned.file.write(contents, offset, contents.length - offset, offset)
    assert.ok(bytesWritten > 0, 'fixture write made no progress')
    offset += bytesWritten
  }
  await owned.file.sync()
}

// A real SQLite lock gives the real history subprocess a bounded 500 ms busy
// window. No provider/bridge replacement or artificial successful response.
async function lockHistory(manifest) {
  const owned = await fixtureFile(manifest, 'database', 128 * 1024 * 1024)
  await owned.file.close()
  return lockDatabase(owned.path)
}

async function lockDatabase(filename) {
  const child = spawn('/usr/bin/sqlite3', ['-batch', '-bail', filename], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = '', failure, ready = false, finished = false
  let resolveReady, rejectReady
  const acquired = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  function fail(error) {
    failure ??= error
    rejectReady(error)
    if (!finished) child.kill('SIGKILL')
  }
  const deadline = setTimeout(() => fail(new Error('Smoke SQLite lock exceeded 6 seconds')), 6_000)
  const closed = new Promise(resolve => {
    child.once('error', fail)
    child.once('close', (code, signal) => {
      finished = true
      clearTimeout(deadline)
      if (code !== 0 || signal) failure ??= new Error(`Smoke SQLite lock exited ${code}/${signal}: ${errors.slice(0, 512)}`)
      if (!ready) rejectReady(failure ?? new Error('SQLite lock closed before acquisition'))
      resolve()
    })
  })
  child.stdin.on('error', fail)
  child.stdout.on('data', chunk => {
    output += chunk.toString('utf8')
    if (Buffer.byteLength(output) > 4096) { fail(new Error('SQLite lock stdout budget exceeded')); return }
    if (output.includes('OC_SMOKE_LOCKED\n')) { ready = true; resolveReady() }
  })
  child.stderr.on('data', chunk => {
    errors += chunk.toString('utf8')
    if (Buffer.byteLength(errors) > 4096) fail(new Error('SQLite lock stderr budget exceeded'))
  })
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  child.stdin.write('.timeout 1000\nBEGIN EXCLUSIVE;\n.print OC_SMOKE_LOCKED\n')
  try { await acquired }
  catch (error) { child.kill('SIGKILL'); await closed; throw failure ?? error }
  return async () => {
    if (!finished) child.stdin.end('ROLLBACK;\n.quit\n')
    await closed
    if (failure) throw failure
    assert.equal(errors, '', 'SQLite lock emitted unexpected diagnostics')
  }
}

function historyResource(info) {
  const source = info.resources.sources.find(source => source.source === 'history')
  assert.ok(source, 'real Hermes history resource accounting must exist')
  for (const key of usageKeys) assert.ok(Number.isFinite(source.current[key]), `history ${key} must be known`)
  assert.ok(Number.isSafeInteger(source.cancelled), 'history cancellation count must be known')
  return source
}

async function closeTask(ui, id) {
  await ui.key('Escape', 'Escape', 27)
  await ui.dom('task drawer is closed and inert', `(() => {
    const drawer = ${$('#schedule-task-details')};
    return drawer?.dataset.open === 'false' && drawer.inert && drawer.getAttribute('aria-hidden') === 'true';
  })()`)
  await ui.frames()
  await ui.dom('task Escape returns focus to its original row', `document.activeElement === ${$(`.schedule-panel [data-job-id=${JSON.stringify(id)}] button`)}`)
}

async function historyPage(ui, start) {
  await ui.dom(`Hermes history page begins at ${start}`, `(() => {
    const history = ${$('.schedule-history')};
    const list = history?.querySelector('.schedule-history-list');
    return history?.getAttribute('aria-busy') === 'false' && !history.querySelector('.schedule-history-error') && list?.start === ${start} && list.children.length === ${HISTORY_SIZE};
  })()`)
  return ui.evaluate(`Array.from(document.querySelectorAll('.schedule-history-list .schedule-execution-id'), element => element.textContent)`)
}

export async function exerciseSmoke({ main, renderer, manifest, record, capture, fault, scenario = 'all', feed }) {
  assert.ok(fault == null || fault === 'fixture' || fault === 'ipc', 'unknown smoke fault')
  const ui = controls({ main, renderer, record, capture })
  if (scenario === 'all') await exerciseBoundaries({ ui, main, renderer, record })
  const market = await exerciseMarketplace({ ui, main, renderer, feed, thorough: scenario === 'marketplace' || scenario === 'all' })
  if (scenario === 'marketplace') return market
  let initial
  await ui.stage('sections-and-sources', async () => {
    await ui.dom('real desktop APIs and mounted DOM', `!!window.monitor && !!window.desktopSettings && !!${$('.app-shell')}`)
    await ui.info()
    record('document-presentation', await ui.evaluate(`({ hidden: document.hidden, visibilityState: document.visibilityState, displayLive: ${$('.app-shell')}?.dataset.displayLive })`))
    await ui.dom('headless presentation receives live data', `${$('.app-shell')}?.dataset.displayLive === 'true'`)
    initial = await ui.expect('all four real IPC sections contain fixture/system data', () => ui.evaluate(`window.monitor.snapshot().then(snapshot => {
      const failed = Object.entries(snapshot).filter(([,state]) => state.error).map(([section,state]) => [section,state.error]);
      if (failed.length) throw new Error(JSON.stringify(failed));
      if (!['agents','schedules','system','events'].every(section => snapshot[section].data && !snapshot[section].refreshing)) return false;
      return {
        sections: Object.fromEntries(['agents','schedules','system','events'].map(section => [section, {error:snapshot[section].error, sources:snapshot[section].data.sources.map(source => ({id:source.id,state:source.state}))}])),
        agent: snapshot.agents.data.agents[0], agentCount: snapshot.agents.data.agents.length,
        fixtureAgentCount: snapshot.agents.data.agents.filter(agent => ${JSON.stringify(manifest.agentIds)}.includes(agent.id)).length,
        activeSubagentCount: snapshot.agents.data.activeSubagentCount,
        taskCount: snapshot.schedules.data.jobs.length,
        hermesIds: snapshot.schedules.data.jobs.filter(job => job.id.startsWith('hermes-job:')).map(job => job.id),
        cpuCores: snapshot.system.data.cpuCores, memoryTotal:snapshot.system.data.memoryTotal
      };
    })`), 35_000)
    for (const [section, value] of Object.entries(initial.sections)) {
      assert.equal(value.error, null, `${section} collection failed`)
      assert.ok(value.sources.length > 0, `${section} must expose sources`)
    }
    assert.equal(initial.fixtureAgentCount, 32, 'All 32 live descriptor-backed fixture agents must be discovered')
    assert.equal(initial.activeSubagentCount, null, 'unknown active subagent count must remain null')
    assert.ok(initial.taskCount >= manifest.plistCount + manifest.hermesJobIds.length, 'Fixture jobs must coexist with real system launchd sources')
    assert.deepEqual([...initial.hermesIds].sort(), [...manifest.hermesJobIds].sort())
    assert.ok(initial.cpuCores > 0 && initial.memoryTotal > 0, 'system values must come from a successful real collection')
    await ui.navigate('本机概览', 'Overview')
    await ui.dom('overview preserves unknown active count', `${$('.summary-strip button:nth-child(2) strong')}?.textContent === '—'`)
    await ui.navigate('数据来源', 'Data sources')
    for (const section of ['agents', 'schedules', 'system', 'events']) {
      await ui.dom(`${section} sources rendered`, `${$(`[data-source-section="${section}"]`)}?.querySelectorAll('[data-source-id]').length > 0`)
      for (const source of initial.sections[section].sources) {
        await ui.dom(`${section}/${source.id} source row`, `!!${$(`[data-source-section="${section}"] [data-source-id=${JSON.stringify(source.id)}]`)}`)
      }
    }
    await ui.dom('real descriptor provenance is visible', `!!${$('[data-source-id="omp-ownership"]')}`)
    return { evidence: { agents: 'real ps/lsof over 32 owned fixture sessions', schedules: 'fixture files and SQLite through production collectors', system: 'real Rust macOS collector' }, agents: initial.agentCount, fixtureAgents: initial.fixtureAgentCount, tasks: initial.taskCount, activeSubagents: null }
  })
  if (scenario === 'collectors') return { collectors: initial }
  if (scenario === 'notifications') {
    const notifications = await exerciseNotifications({ ui, main, renderer, manifest, capture })
    return { settings: { notifications } }
  }
  const topology = await exerciseTopology({ ui, renderer, record, agent: initial.agent })
  if (scenario === 'topology') return topology

  await exerciseEmptyEvents(ui)


  await ui.stage('overview-task-and-unsupported-history', async () => {
    await ui.navigate('本机概览', 'Overview')
    const preview = await ui.evaluate(`(() => { const row = ${$('.schedule-preview [data-job-id]')}; return { id:row?.dataset.jobId, name:row?.querySelector('strong')?.textContent }; })()`)
    assert.ok(manifest.hermesJobIds.includes(preview.id), 'fixture overview must expose a known Hermes task')
    await ui.click($('.schedule-preview .entity-button'))
    await ui.dom('overview opens the exact task', `${$(DRAWER)}?.dataset.jobId === ${JSON.stringify(preview.id)} && ${$('.schedule-drawer-name')}?.textContent === ${JSON.stringify(preview.name)}`)
    await historyPage(ui, 1)
    await closeTask(ui, preview.id)
    const unsupportedId = await ui.evaluate(`${$('.schedule-panel [data-job-id^="launchd:"]')}?.dataset.jobId`)
    assert.ok(unsupportedId?.startsWith('launchd:'), 'fixture must expose launchd history limitations')
    await ui.click($(`.schedule-panel [data-job-id=${JSON.stringify(unsupportedId)}] button`))
    await ui.dom('unsupported task details identity', `${$(DRAWER)}?.dataset.jobId === ${JSON.stringify(unsupportedId)}`)
    await ui.dom('unsupported history is explicit, not an empty success', `(() => {
      const history = ${$('.schedule-history')};
      return history?.getAttribute('aria-busy') === 'false' && /不提供逐次执行历史|does not provide per-run execution history/.test(history.textContent) && !history.querySelector('.schedule-history-list');
    })()`)
    const unavailable = await ui.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(unsupportedId)},0)`)
    assert.equal(unavailable.source, 'unavailable')
    assert.deepEqual(unavailable.entries, [])
    assert.equal(unavailable.hasMore, false)
    await closeTask(ui, unsupportedId)
    return { overviewJobId: preview.id, unsupportedJobId: unsupportedId, source: unavailable.source, taskFocusRestored: true }
  })

  const hermesId = manifest.hermesJobIds[0]
  await ui.stage('hermes-history-pagination', async () => {
    await ui.click($('.schedule-toolbar input'))
    await renderer.text('Perf schedule 000')
    await ui.dom('Hermes fixture search resolves one task', `document.querySelectorAll('.schedule-panel tbody tr').length === 1 && !!${$(`.schedule-panel [data-job-id=${JSON.stringify(hermesId)}]`)}`)
    await ui.click($(`.schedule-panel [data-job-id=${JSON.stringify(hermesId)}] button`))
    await ui.dom('Hermes details identity', `${$(DRAWER)}?.dataset.jobId === ${JSON.stringify(hermesId)}`)
    const first = await historyPage(ui, 1)
    assert.equal(new Set(first).size, HISTORY_SIZE)
    assert.ok(first.every(id => /^perf-execution-\d{5}$/.test(id)), 'history must come from synthetic SQLite rows')
    await ui.click($('.schedule-history-pagination button:last-child'))
    const second = await historyPage(ui, 26)
    assert.equal(new Set([...first, ...second]).size, HISTORY_SIZE * 2, 'history pages must not overlap')
    assert.equal(await ui.evaluate(`document.activeElement === ${$('#schedule-history-title')}`), true, 'history pagination focus')
    await ui.click($('.schedule-history-pagination button:first-child'))
    assert.deepEqual(await historyPage(ui, 1), first, 'previous page must restore the same real history rows')
    return { jobId: hermesId, pageSize: HISTORY_SIZE, firstPage: [first[0], first.at(-1)], secondPage: [second[0], second.at(-1)] }
  })

  await ui.stage('history-cancellation-and-release', async () => {
    await closeTask(ui, hermesId)
    const before = historyResource(await ui.info())
    const release = await lockHistory(manifest)
    let failure, pending
    try {
      // Start the real request without occupying the driver's single request slot.
      // The page retains exactly one settled-or-pending promise until cleanup.
      pending = await renderer.evaluate(`(() => { if (window.__ocAcceptancePending) throw new Error('Pending request already exists'); window.__ocAcceptancePending = window.monitor.scheduleHistory(${JSON.stringify(hermesId)},0).then(() => ({resolved:true}), error => ({resolved:false,error:String(error)})); return true; })()`, RPC_MS)
      await ui.expect('real history subprocess admitted before cancellation', async () => historyResource(await ui.info()).current.commands === 1, 2_000)
      await ui.evaluate('window.monitor.cancelScheduleHistory().then(() => true)')
      const result = await renderer.evaluate('window.__ocAcceptancePending', RPC_MS)
      assert.equal(result.resolved, false, 'cancelled IPC history must reject')
      assert.match(result.error, /cancelled|取消|abort/i)
      await ui.expect('cancelled history releases every reserved resource', async () => {
        const source = historyResource(await ui.info())
        return source.cancelled > before.cancelled && usageKeys.every(key => source.current[key] === 0)
      }, 2_000)
      const afterBridge = historyResource(await ui.info())
      await ui.click($(`.schedule-panel [data-job-id=${JSON.stringify(hermesId)}] button`))
      await ui.expect('drawer starts a real history read', async () => historyResource(await ui.info()).current.commands === 1, 2_000)
      await closeTask(ui, hermesId)
      await ui.expect('closing the drawer cancels and drains history', async () => {
        const source = historyResource(await ui.info())
        return source.cancelled > afterBridge.cancelled && usageKeys.every(key => source.current[key] === 0)
      }, 2_000)
    } catch (error) { failure = error }
    finally {
      const cleanup = await Promise.allSettled([ui.evaluate('window.monitor.cancelScheduleHistory().then(() => true)'), release()])
      if (pending) {
        try { await renderer.evaluate('window.__ocAcceptancePending.then(() => {delete window.__ocAcceptancePending; return true;})', RPC_MS) }
        catch (error) { cleanup.push({ status: 'rejected', reason: error }) }
      }
      const errors = [failure, ...cleanup.filter(result => result.status === 'rejected').map(result => result.reason)].filter(Boolean)
      if (errors.length) throw new AggregateError(errors, 'History cancellation or SQLite lock cleanup failed')
    }
    await ui.click($(`.schedule-panel [data-job-id=${JSON.stringify(hermesId)}] button`))
    await historyPage(ui, 1)
    await closeTask(ui, hermesId)
    const after = historyResource(await ui.info())
    assert.ok(usageKeys.every(key => after.current[key] === 0), 'successful recovery history must release resources')
    return { cancellations: after.cancelled - before.cancelled, current: after.current, recovery: 'real SQLite read after lock release' }
  })

  await ui.stage('fixture-source-failure-and-recovery', async () => {
    await ui.navigate('数据来源', 'Data sources')
    const owned = await fixtureFile(manifest, 'jobsFile', 128 * 1024, true)
    let original, dirty = false, failure
    try {
      const previous = await ui.evaluate('window.monitor.snapshot().then(value => ({at:value.schedules.data.collectedAt,count:value.schedules.data.jobs.length}))')
      original = await owned.file.readFile()
      dirty = true
      await replaceContents(owned, Buffer.from('{"jobs": [invalid smoke fixture\n'))
      const refresh = await renderer.evaluate('window.monitor.refresh("schedules").then(() => ({rejected:false}), error => ({rejected:true,error:String(error)}))', 35_000)
      assert.equal(refresh.rejected, true, 'invalid schedule configuration must reject the refresh request')
      assert.match(refresh.error, /OC_SCHEDULE_CONFIGURATION/, 'refresh must retain its configuration failure code')
      const broken = await ui.evaluate(`window.monitor.snapshot().then(value => ({error:value.schedules.error, at:value.schedules.data.collectedAt, count:value.schedules.data.jobs.length, agents:value.agents.data.agents.map(agent => agent.id), system:!!value.system.data}))`)
      assert.match(broken.error, /Hermes/, 'malformed metadata must expose its section collection error')
      assert.equal(broken.at, previous.at, 'configuration failure must retain the last complete snapshot')
      assert.equal(broken.count, previous.count, 'configuration failure must not replace known tasks with a partial list')
      await ui.dom('broken fixture reports its retained snapshot error', `${$(`${SCHEDULES} .source-section-error[role="alert"]`)}?.textContent.includes('Hermes')`)
      assert.deepEqual(broken.agents.filter(id => manifest.agentIds.includes(id)).sort(), [...manifest.agentIds].sort(), 'fixture failure must not stop real Agent collection')
      assert.equal(broken.system, true, 'fixture failure must not remove system data')
      record('fixture-error-observed', { status: 'observed', source: 'hermes-cron', error: broken.error, retainedTasks: broken.count, synthetic: true })
      await ui.evaluate(`${$(`${SCHEDULES} .source-section-error`)}.scrollIntoView({block:'center',behavior:'instant'})`)
      await capture('fixture-source-error')
      if (fault !== 'fixture') {
        await replaceContents(owned, original)
        dirty = false
      }
      await ui.click($(`${SCHEDULES} .source-section-error button`))
      await ui.dom('critical fixture recovery: section error must clear', `!${$(`${SCHEDULES} .source-section-error`)}`, 20_000)
      const restored = await ui.evaluate(`window.monitor.snapshot().then(value => ({error:value.schedules.error, source:value.schedules.data.sources.find(source => source.id === 'hermes-cron').state, count:value.schedules.data.jobs.filter(job => job.id.startsWith('hermes-job:')).length}))`)
      assert.equal(restored.error, null)
      assert.equal(restored.source, 'ok')
      assert.equal(restored.count, manifest.hermesJobIds.length)
      return { source: 'hermes-cron', state: restored.source, recoveredTasks: restored.count }
    } catch (error) { failure = error; throw error }
    finally {
      const errors = []
      if (dirty && original) {
        try { await replaceContents(owned, original) }
        catch (error) { errors.push(error) }
      }
      try { await owned.file.close() }
      catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError([failure, ...errors].filter(Boolean), 'Fixture restore/close failed')
    }
  })

  await ui.stage('ipc-command-rejection-and-recovery', async () => {
    await ui.navigate('本机概览', 'Overview')
    let failure
    try {
      await main.host('fault-command', { targetCommand: 'monitor_snapshot', enabled: true })
      const rejected = await ui.evaluate('window.monitor.snapshot().then(() => ({rejected:false}), error => ({rejected:true,error:String(error)}))')
      assert.equal(rejected.rejected, true, 'the faulted native snapshot request must reject')
      assert.match(rejected.error, /OC_ACCEPTANCE_REJECTION/)
      await ui.navigate('数据来源', 'Data sources')
      await ui.dom('real snapshot IPC error reaches the source UI', `Array.from(document.querySelectorAll('.error-notice[role="alert"]')).some(element => element.textContent.includes('OC_ACCEPTANCE_REJECTION'))`)
      record('ipc-error-observed', { status: 'observed', channel: 'monitor_snapshot', error: rejected.error.slice(0, 512) })
      await capture('ipc-rejected')
      if (fault !== 'ipc') await main.host('fault-command', { targetCommand: 'monitor_snapshot', enabled: false })
      await ui.click(`Array.from(document.querySelectorAll('.error-notice')).find(element => element.textContent.includes('OC_ACCEPTANCE_REJECTION')).querySelector('button')`)
      await ui.dom('critical IPC recovery: source error must clear', `!Array.from(document.querySelectorAll('.error-notice')).some(element => element.textContent.includes('OC_ACCEPTANCE_REJECTION'))`)
      const recovered = await ui.evaluate('window.monitor.snapshot().then(value => ["agents","schedules","system"].every(section => !!value[section].data))')
      assert.equal(recovered, true, 'restored handler must return the actual three-section snapshot')
      return { channel: 'monitor_snapshot', rejectedDuringFault: true, recovered: true }
    } catch (error) { failure = error; throw error }
    finally {
      try { await main.host('fault-command', { targetCommand: 'monitor_snapshot', enabled: false }) }
      catch (error) { throw new AggregateError([failure, error].filter(Boolean), 'Snapshot IPC handler restoration failed') }
    }
  })

  await ui.stage('events-deduplication-and-plugin-restart', async () => {
    await ui.navigate('数据来源', 'Data sources')
    const before = await ui.evaluate('window.monitor.events({sourceId:"hermes-events"})')
    assert.deepEqual(before.entries, [], 'the initial execution history must only establish a baseline')
    const owned = await fixtureFile(manifest, 'database', 128 * 1024 * 1024)
    const db = new DatabaseSync(owned.path)
    try {
      db.exec('PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=16777216')
      const insert = db.prepare('INSERT INTO executions(id,job_id,status,claimed_at,finished_at,delivery_outcome) VALUES(?,?,?,?,?,?)')
      const now = new Date().toISOString(), job = manifest.hermesJobIds[0].slice('hermes-job:'.length)
      insert.run('smoke-event-first', job, 'failed', now, now, 'failed')
      insert.run('smoke-event-second', job, 'failed', now, now, 'delivered')
    } finally { db.close(); await owned.file.close() }
    const started = performance.now()
    for (let sample = 0; sample < 100; sample++) {
      const sampleStarted = performance.now()
      record('events-deduplication-sample', { sample, phase: 'refresh-started' })
      await renderer.evaluate('window.monitor.refresh("events")', 20_000)
      const refreshedAt = performance.now()
      record('events-deduplication-sample', { sample, phase: 'snapshot-started', refreshMs: refreshedAt - sampleStarted })
      const error = await ui.evaluate('window.monitor.snapshot().then(value => value.events.error)')
      assert.equal(error, null, `event sample ${sample} failed`)
      record('events-deduplication-sample', { sample, phase: 'passed', snapshotMs: performance.now() - refreshedAt })
    }
    const page = await ui.evaluate('window.monitor.events({sourceId:"hermes-events"})')
    assert.deepEqual(page.entries.map(event => event.type).sort(), ['delivery-failed', 'execution-failed', 'execution-failed'])
    assert.equal(new Set(page.entries.map(event => event.id)).size, 3)
    assert.ok(page.entries.every(event => event.target?.kind === 'schedule' && event.target.id === manifest.hermesJobIds[0]))
    await ui.click($('[data-source-section="events"] [role="switch"]'))
    await ui.dom('event plugin is disabled', `${$('[data-source-section="events"] [role="switch"]')}?.getAttribute('aria-checked') === 'false'`)
    const disabled = await ui.evaluate('window.monitor.events().then(() => false, () => true)')
    assert.equal(disabled, true, 'disabled event plugin must reject new queries')
    const info = await ui.info()
    const events = info.resources.sources.find(source => source.source === 'events')
    assert.ok(events, 'real event resource accounting must exist')
    for (const key of usageKeys) assert.equal(events.current[key], 0, 'disabled event plugin must drain its resources')
    await ui.click($('[data-source-section="events"] [role="switch"]'))
    await ui.dom('event plugin is enabled', `${$('[data-source-section="events"] [role="switch"]')}?.getAttribute('aria-checked') === 'true'`)
    await renderer.evaluate('window.monitor.refresh("events")', 20_000)
    const restarted = await ui.evaluate('window.monitor.events({sourceId:"hermes-events"})')
    assert.deepEqual(restarted.entries.map(event => event.id), page.entries.map(event => event.id), 'new plugin instance must restore durable deduplication')
    assert.ok(restarted.retention.diskBytes <= 20 * 1024 * 1024)
    await ui.dom('event range is actually rendered', `${$('[data-source-section="events"]')}?.textContent.includes('10000')`)
    return { samples: 100, durationMs: performance.now() - started, types: page.entries.map(event => event.type), retention: restarted.retention, coverage: restarted.coverage }
  })

  await exerciseEvents({ ui, main, renderer, capture, lockHistory: () => lockHistory(manifest),
    lockEvents: async () => {
      const filename = path.join((await ui.info()).profile, 'events', 'events.sqlite')
      return lockDatabase(filename)
    },
    appendExecution: async () => {
      const owned = await fixtureFile(manifest, 'database', 128 * 1024 * 1024)
      let database
      try {
        database = new DatabaseSync(owned.path)
        database.exec('PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=16777216')
        const now = new Date().toISOString()
        database.prepare('INSERT INTO executions(id,job_id,status,claimed_at,finished_at,delivery_outcome) VALUES(?,?,?,?,?,?)')
          .run('smoke-f05-background', manifest.hermesJobIds[0].slice('hermes-job:'.length), 'failed', now, now, 'delivered')
        return now
      } finally { try { database?.close() } finally { await owned.file.close() } }
    }
  })
  const notifications = await exerciseNotifications({ ui, main, renderer, manifest, capture })

  const settings = { appearance: 'dark', darkTheme: 'nord', notifications }
  await ui.stage('theme-ui-save', async () => {
    await ui.navigate('设置', 'Settings')
    await ui.click($('input[type="radio"][name="appearance"][value="dark"]'))
    await ui.dom('dark appearance saved by real settings IPC', `${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && document.documentElement.dataset.theme === 'dark'`)
    await ui.click($('input[type="radio"][name="darkTheme"][value="nord"]'))
    await ui.dom('Nord theme save settled', `${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && ${$('input[name="darkTheme"][value="nord"]')}?.checked === true`)
    await ui.key('Escape', 'Escape', 27)
    await ui.navigate('本机概览', 'Overview')
    const saved = await ui.evaluate('window.desktopSettings.snapshot()')
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(saved.settings[key], value, `${key} must be genuinely saved, not previewed`)
    assert.equal(saved.resolvedTheme, 'dark')
    assert.equal(await ui.evaluate('document.documentElement.dataset.palette'), 'nord')
    await ui.info()
    return { settings, persistence: 'UI radio -> real Tauri settings IPC; runner compares actual settings.json and restarts' }
  })
  return { settings }
}

export async function verifyRestart({ main, renderer, savedSettings, record, capture, scenario = 'all' }) {
  const ui = controls({ main, renderer, record, capture })
  if (scenario === 'marketplace') return verifyMarketplaceRestart(ui)
  if (scenario === 'notifications') {
    await ui.stage('restart-notification-settings', async () => {
      await ui.dom('restarted real renderer is ready', `!!window.desktopSettings && !!${$('.app-shell')}`)
      await ui.info()
      const snapshot = await ui.evaluate('window.desktopSettings.snapshot()')
      assert.deepEqual(snapshot.settings.notifications, savedSettings.notifications)
      assert.equal(snapshot.notifications.phase, 'off')
      await ui.navigate('设置', 'Settings')
      await ui.dom('notification preferences are rendered after restart', `${$('#setting-notifications [role="switch"]')}?.getAttribute('aria-checked') === 'false' && ${$('#setting-notifications .notification-status')}?.dataset.phase === 'off'`)
      return { notifications: snapshot.settings.notifications, nativeNotificationAcceptance: false }
    })
    return
  }
  if (scenario === 'topology') {
    await ui.stage('restart-office-and-theme', async () => {
      await ui.dom('restarted real renderer is ready', `!!window.desktopSettings && !!${$('.app-shell')}`)
      await ui.info()
      const snapshot = await ui.evaluate('window.desktopSettings.snapshot()')
      assert.equal(snapshot.settings.appearance, savedSettings.appearance)
      assert.equal(snapshot.resolvedTheme, 'dark')
      await ui.navigate('协作拓扑', 'Agent topology')
      await ui.dom('restart opens the office with the saved appearance', `!!${$('.topology-3d-webgl')} && !${$('.topology-3d-message')} && document.documentElement.dataset.theme === 'dark'`)
      return { appearance: snapshot.settings.appearance, topology: '3D', nativeWindowAcceptance: false }
    })
    return
  }
  await ui.stage('restart-settings-persistence', async () => {
    assert.ok(savedSettings && savedSettings.appearance === 'dark' && savedSettings.darkTheme === 'nord', 'restart must receive the actual saved first-process settings')
    await ui.dom('restarted real renderer is ready', `!!window.desktopSettings && !!${$('.app-shell')}`)
    await ui.info()
    const snapshot = await ui.evaluate('window.desktopSettings.snapshot()')
    assert.equal(snapshot.settings.appearance, savedSettings.appearance)
    assert.equal(snapshot.settings.darkTheme, savedSettings.darkTheme)
    assert.deepEqual(snapshot.settings.notifications, savedSettings.notifications)
    assert.equal(snapshot.resolvedTheme, 'dark')
    await ui.dom('saved theme applied without a preview', `document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.palette === 'nord'`)
    await ui.navigate('设置', 'Settings')
    await ui.dom('saved radio choices restored on restart', `${$('input[name="appearance"][value="dark"]')}?.checked === true && ${$('input[name="darkTheme"][value="nord"]')}?.checked === true`)
    return { settings: { appearance: snapshot.settings.appearance, darkTheme: snapshot.settings.darkTheme }, persistence: 'new owned process reopens the identical profile and installed plugin files', nativeWindowAcceptance: false }
  })
  if (scenario === 'all') await verifyMarketplaceRestart(ui)
}

async function denied(renderer, command, owner, args = {}, keyExpression = 'window.__OC_DESKTOP_DOCUMENT__') {
  const outcome = await renderer.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, {owner:${JSON.stringify(owner)},args:${JSON.stringify(args)}}, {headers:{'X-OC-Document':${keyExpression}}}).then(() => ({rejected:false}), error => ({rejected:true,error:JSON.stringify(error)}))`)
  assert.equal(outcome.rejected, true, `Unauthorized ${command} was accepted`)
  assert(outcome.error?.length, 'Rejection must contain diagnostic evidence')
  return outcome
}

async function exerciseBoundaries({ ui, main, renderer, record }) {
  await ui.stage('ipc-owner-document-and-argument-boundaries', async () => {
    const initial = await ui.expect('main document commits and subscribes', async () => {
      const value = (await ui.info()).windows.find(item => item.view === 'main')
      return value?.committed && value.subscribed.monitor ? value : false
    })
    const descriptor = await renderer.evaluate('(() => {const d=Object.getOwnPropertyDescriptor(window,"__OC_DESKTOP_DOCUMENT__"); return {readonly:!d.writable,permanent:!d.configurable,key:d.value};})()')
    assert.equal(descriptor.readonly, true); assert.equal(descriptor.permanent, true)
    assert.match(descriptor.key, /^[a-f0-9-]{36}$/)
    const failures = []
    failures.push(await denied(renderer, 'monitor_snapshot', 0))
    failures.push(await denied(renderer, 'monitor_snapshot', initial.owner, {}, JSON.stringify('00000000-0000-4000-8000-000000000000')))
    failures.push(await denied(renderer, 'settings_update', initial.owner, { impossibleSetting: true }))
    failures.push(await denied(renderer, 'settings_update', initial.owner, { oversized: 'x'.repeat(128 * 1024 + 1) }))
    const accessibility = await renderer.evaluate('window.desktopSettings.accessibilityState()')
    assert.equal(accessibility.availability, 'headless')
    assert.equal(accessibility.status, 'unknown')
    for (const target of ['accessibility', 'notifications']) {
      const outcome = await denied(renderer, 'settings_open_permission_settings', initial.owner, { target })
      assert.match(outcome.error, /OC_HEADLESS/)
      failures.push(outcome)
    }
    failures.push(await denied(renderer, 'settings_open_permission_settings', initial.owner, { target: 'invalid' }))
    const unknown = await renderer.evaluate('window.__TAURI_INTERNALS__.invoke("oc_unlisted_acceptance_command",{}).then(()=>false,()=>true)')
    assert.equal(unknown, true)
    const owners = [initial.owner]
    for (let index = 0; index < 3; index++) {
      const old = owners.at(-1)
      assert.deepEqual(await renderer.evaluate('window.__ocSmokeRendererErrors'), { entries: [], dropped: 0 }, 'Renderer error before document reload')
      await renderer.reload()
      const next = await ui.expect('reload revokes owner and completes a fresh handshake', async () => {
        const value = (await main.host('info')).windows.find(item => item.view === 'main')
        return value?.committed && value.subscribed.monitor && value.owner !== old ? value : false
      }, 20000)
      owners.push(next.owner)
      failures.push(await denied(renderer, 'monitor_snapshot', old))
      assert((await renderer.evaluate('window.monitor.snapshot()')).agents)
      assert.deepEqual(await renderer.evaluate('window.__ocSmokeRendererErrors'), { entries: [], dropped: 0 }, 'Reloaded document error observation is unavailable or captured a renderer exception')
    }
    assert.equal(new Set(owners).size, owners.length)
    await main.host('ensure-tray')
    const tray = main.view('tray')
    const trayState = await ui.expect('tray has its own committed owner', async () => {
      const value = (await main.host('info')).windows.find(item => item.view === 'tray')
      return value?.committed ? value : false
    }, 20000)
    assert.notEqual(trayState.owner, owners.at(-1))
    failures.push(await denied(tray, 'monitor_snapshot', owners.at(-1)))
    failures.push(await denied(tray, 'settings_update', trayState.owner, { patch: { appearance: 'dark' } }))
    failures.push(await denied(tray, 'settings_accessibility_state', trayState.owner))
    failures.push(await denied(tray, 'settings_open_permission_settings', trayState.owner, { target: 'accessibility' }))
    failures.push(await denied(renderer, 'recovery_snapshot', owners.at(-1)))
    for (const view of [renderer, tray]) {
      const native = await view.inspect()
      assert.equal(native.visible, false); assert.equal(native.key, false); assert.equal(native.appActive, false); assert.equal(native.activationPolicy, 2)
    }
    return { owners, trayOwner: trayState.owner, rejectedRequests: failures.length, failures }
  })
  await ui.stage('ipc-duplicate-callback-subscriptions', async () => {
    const appearance = (await renderer.evaluate('window.desktopSettings.snapshot()')).settings.appearance
    const changed = appearance === 'dark' ? 'light' : 'dark'
    await renderer.evaluate(`(() => {
      if (window.__ocSmokeDuplicateSubscription) throw new Error('Subscription check already active');
      const state = { count: 0, expected: ${JSON.stringify(changed)} };
      const listener = snapshot => { if (snapshot.settings.appearance === state.expected) state.count++; };
      state.first = window.desktopSettings.subscribe(listener); state.second = window.desktopSettings.subscribe(listener);
      window.__ocSmokeDuplicateSubscription = state; return true;
    })()`)
    try {
      await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(changed)}})`)
      await ui.dom('both registrations receive a real settings change', 'window.__ocSmokeDuplicateSubscription.count >= 2')
      await renderer.evaluate(`(() => { const state=window.__ocSmokeDuplicateSubscription; state.first(); state.first(); state.count=0; state.expected=${JSON.stringify(appearance)}; return true; })()`)
      await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(appearance)}})`)
      await ui.dom('unsubscribing one registration preserves the other', 'window.__ocSmokeDuplicateSubscription.count >= 1')
      await renderer.evaluate(`(() => { const state=window.__ocSmokeDuplicateSubscription; state.second(); state.count=0; state.expected=${JSON.stringify(changed)}; return true; })()`)
      await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(changed)}})`)
      await ui.expect('settings event is delivered and acknowledged after both unsubscribe', async () => {
        const state = (await main.host('info')).windows.find(item => item.view === 'main').push
        return state.inFlight === 0 && state.pending === 0
      })
      assert.equal(await renderer.evaluate('window.__ocSmokeDuplicateSubscription.count'), 0)
    } finally {
      await renderer.evaluate('(() => { const state=window.__ocSmokeDuplicateSubscription; state.first(); state.second(); delete window.__ocSmokeDuplicateSubscription; return true; })()')
      await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(appearance)}})`)
    }
    return { sameCallback: true, remainingRegistrationReceivesChanges: true, callbacksAfterBothUnsubscribe: 0 }
  })
  await ui.stage('ipc-slow-consumer-coalesces-and-drains', async () => {
    const appearance = (await renderer.evaluate('window.desktopSettings.snapshot()')).settings.appearance
    let failure, held = false, peakPending = 0, peakBytes = 0
    try {
      await renderer.evaluate(`(() => {
        if (!window.__ocSmokeAck) throw new Error('Smoke ACK control is unavailable');
        window.__ocSmokeAck.hold();
        return true;
      })()`)
      held = true
      for (let index = 0; index < 16; index++) {
        await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(index % 2 ? 'light' : 'dark')}})`)
        const state = (await main.host('info')).windows.find(item => item.view === 'main').push
        assert(state.inFlight <= 1 && state.pending <= 13 && state.bytes <= 16 * 1024 * 1024)
        peakPending = Math.max(peakPending, state.pending); peakBytes = Math.max(peakBytes, state.bytes)
      }
      assert(peakPending > 0, 'Repeated real pushes must wait behind the withheld acknowledgement')
      assert((await renderer.evaluate('window.monitor.snapshot()')).agents, 'Independent IPC remains responsive under push backpressure')
      const acknowledgement = await renderer.evaluate('window.__ocSmokeAck.state()')
      assert.equal(acknowledgement.pending, 1, 'One real acknowledgement must be withheld')
      assert.equal(acknowledgement.duplicate, 0)
    } catch (error) { failure = error; throw error }
    finally {
      const cleanup = []
      if (held) {
        try {
          await renderer.evaluate('window.__ocSmokeAck.release().then(() => true)')
        } catch (error) { cleanup.push(error) }
      }
      try { await renderer.evaluate(`window.desktopSettings.update({appearance:${JSON.stringify(appearance)}})`) } catch (error) { cleanup.push(error) }
      if (cleanup.length) throw new AggregateError([failure,...cleanup].filter(Boolean), 'Ack/appearance restoration failed')
    }
    await ui.expect('real acknowledgement drains coalesced push messages', async () => {
      const state = (await main.host('info')).windows.find(item => item.view === 'main').push
      return state.inFlight === 0 && state.pending === 0 && state.bytes === 0
    })
    const restored = await renderer.evaluate('window.desktopSettings.snapshot()')
    assert.equal(restored.settings.appearance, appearance, 'Appearance must be restored after ACK release')
    const acknowledgement = await renderer.evaluate('window.__ocSmokeAck.state()')
    assert.equal(acknowledgement.held, false)
    assert.equal(acknowledgement.pending, 0)
    assert.equal(acknowledgement.releasing, false)
    assert.equal(acknowledgement.duplicate, 0)
    return { withheldAcks: 1, actualSettingsUpdates: 16, peakPending, peakBytes, pendingLimit: 13, bytesLimit: 16 * 1024 * 1024 }
  })
  await ui.stage('navigation-frame-popup-and-download-boundaries', async () => {
    // Persist each action before awaiting WK: a timed-out driver socket cannot
    // supply renderer diagnostics afterward. Only this fixed sequence is logged.
    async function checkpoint(step, action) {
      const started = performance.now()
      record('navigation-boundary-checkpoint', { step, status: 'started' })
      try {
        const value = await action()
        record('navigation-boundary-checkpoint', { step, status: 'completed', elapsedMs: performance.now() - started, value })
        return value
      } catch (error) {
        record('navigation-boundary-checkpoint', { step, status: 'failed', elapsedMs: performance.now() - started, error: failureEvidence(error) })
        throw error
      }
    }
    const before = await checkpoint('initial-main-url', () => renderer.evaluate('location.href'))
    const blockedFrame = await checkpoint('iframe-csp-rejection', () => renderer.evaluate(`new Promise((resolve,reject) => {
      const frame=document.createElement('iframe'); let timer;
      const cleanup=()=>{clearTimeout(timer);document.removeEventListener('securitypolicyviolation',observed);frame.remove();};
      const observed=event=>{if(event.effectiveDirective==='frame-src'){cleanup();resolve({directive:event.effectiveDirective,blocked:event.blockedURI});}};
      document.addEventListener('securitypolicyviolation',observed);
      timer=setTimeout(()=>{cleanup();reject(new Error('No CSP frame rejection observed'));},3000);
      frame.src=location.href;document.body.append(frame);
    })`))
    assert.equal(blockedFrame.directive, 'frame-src')
    await checkpoint('main-navigation-request', () => renderer.evaluate('(() => {location.assign("https://invalid.example/oc-acceptance-denied");return true;})()'))
    await checkpoint('main-navigation-two-animation-frames', () => ui.frames())
    assert.equal(await checkpoint('main-url-after-navigation', () => renderer.evaluate('location.href')), before)
    const windowsBefore = await checkpoint('window-count-before-popup', async () => (await ui.info()).windows.length)
    await checkpoint('popup-request', () => renderer.evaluate('(() => {window.open("https://invalid.example/oc-acceptance-popup", "_blank");return true;})()'))
    await checkpoint('download-request', () => renderer.evaluate('(() => {const a=document.createElement("a");a.href="data:text/plain,oc-acceptance-denied";a.download="oc-acceptance-denied.txt";a.click();return true;})()'))
    await checkpoint('popup-download-two-animation-frames', () => ui.frames())
    assert.equal(await checkpoint('window-count-after-popup-download', async () => (await ui.info()).windows.length), windowsBefore)
    assert.equal(await checkpoint('main-url-after-popup-download', () => renderer.evaluate('location.href')), before)
    return { blockedFrame, unchangedMainUrl: before, windowCount: windowsBefore, visibleWindowAcceptance: false }
  })
}

export async function exerciseRecovery({ driver, profile, bytes, capture }) {
  const recovery = driver.view('recovery')
  const snapshot = await recovery.evaluate('window.startupRecovery.snapshot()')
  assert.equal(snapshot.failure.reason, 'invalid-json')
  assert.equal(snapshot.failure.filePath, path.join(profile, 'settings.json'))
  assert.equal(await recovery.evaluate('Boolean(window.monitor || window.desktopSettings || window.pluginMarketplace || window.appUpdates)'), false)
  await denied(recovery, 'monitor_snapshot', 0)
  const stillBroken = await recovery.evaluate('window.startupRecovery.retry()')
  assert.equal(stillBroken.ready, false)
  await capture('invalid-settings', 'recovery')
  assert.equal(path.basename(profile), 'profile')
  assert.equal(path.basename(path.dirname(path.dirname(profile))), '.dev-instances')
  const file = await open(path.join(profile, 'settings.json'), constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && stat.size < 65536)
    await replaceContents({ file, stat, path: path.join(profile, 'settings.json') }, bytes)
  } finally { await file.close() }
  // A real native click starts retry; completion closes this very WKWebView.
  const point = await recovery.evaluate('(() => {const r=document.querySelector(".startup-recovery-actions .primary").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()')
  await recovery.clickAt(point.x, point.y)
  await until(async () => {
    const info = await driver.host('info')
    return info.windows.some(item => item.view === 'main' && item.committed) && info.windows.every(item => item.view !== 'recovery')
  }, { timeout: 20000 })
  await assert.rejects(recovery.inspect(), /window|窗口|live/i)
  const main = driver.view('main')
  const native = await main.inspect()
  assert.equal(native.visible, false); assert.equal(native.key, false); assert.equal(native.appActive, false)
  const savedSettings = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(await boundedFile(path.join(profile, 'settings.json'), 65536), bytes, 'Recovery must retain the stored Dock and sleep preferences')
  // The public snapshot exposes native runtime switches; headless mode keeps both off.
  assert.deepEqual((await main.evaluate('window.desktopSettings.snapshot()')).settings, { ...savedSettings, showDock: false, preventSleep: false })
  await capture('recovered-main')
}
