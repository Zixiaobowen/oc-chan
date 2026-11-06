import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { until } from '../performance/core.mjs'
import { exerciseEmptyEvents, exerciseEvents } from './events-scenarios.mjs'
import { exerciseNotifications } from './notification-scenarios.mjs'

const WAIT_MS = 8_000
const RPC_MS = 5_000
const HISTORY_SIZE = 25
const SCHEDULES = '[data-source-section="schedules"]'
const DRAWER = '#schedule-task-details[data-open="true"]'
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const usageKeys = ['commands', 'files', 'sockets', 'stdoutBytes', 'stderrBytes', 'commandBytes', 'fileBytes', 'socketBytes', 'queued']

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
  async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    const event = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers }
    await renderer.call('Input.dispatchKeyEvent', { ...event, type: 'keyDown' }, RPC_MS)
    await renderer.call('Input.dispatchKeyEvent', { ...event, type: 'keyUp' }, RPC_MS)
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
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, RPC_MS)
    await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, RPC_MS)
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, RPC_MS)
  }
  async function navigate(zh, en) {
    await click(`Array.from(document.querySelectorAll('.nav-item')).find(element => [${JSON.stringify(zh)},${JSON.stringify(en)}].includes(element.querySelector('span')?.textContent))`)
    await dom(`navigation to ${en}`, `[${JSON.stringify(zh)},${JSON.stringify(en)}].includes(${$('.page-heading h1')}?.textContent)`)
  }
  async function frames() {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  }
  async function stage(name, action) {
    record(name, { status: 'started' })
    try {
      const details = await action()
      record(name, { status: 'passed', ...details })
      await capture(name)
      return details
    } catch (error) {
      record(name, { status: 'failed', error: failureEvidence(error) })
      try { await capture(`${name}-failed`) }
      catch (captureError) { throw new AggregateError([error, captureError], `${name}: assertion and screenshot failed`) }
      throw error
    }
  }
  async function info() {
    const value = await main.evaluate('globalThis.__ocSmokeControl.info()', RPC_MS)
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
  const source = info.resources.sources.find(source => source.source === 'hermes-history')
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

export async function exerciseSmoke({ main, renderer, manifest, record, capture, fault, scenario = 'all' }) {
  assert.ok(fault == null || fault === 'fixture' || fault === 'ipc', 'unknown smoke fault')
  const ui = controls({ main, renderer, record, capture })
  let initial
  await ui.stage('sections-and-sources', async () => {
    await ui.dom('real preload APIs and visible DOM', `!!window.monitor && !!window.desktopSettings && !!${$('.app-shell')} && !document.hidden`)
    await ui.info()
    initial = await ui.expect('all four real IPC sections contain fixture/system data', () => ui.evaluate(`window.monitor.snapshot().then(snapshot => {
      const failed = Object.entries(snapshot).filter(([,state]) => state.error).map(([section,state]) => [section,state.error]);
      if (failed.length) throw new Error(JSON.stringify(failed));
      if (!['agents','schedules','system','events'].every(section => snapshot[section].data && !snapshot[section].refreshing)) return false;
      return {
        sections: Object.fromEntries(['agents','schedules','system','events'].map(section => [section, {error:snapshot[section].error, sources:snapshot[section].data.sources.map(source => ({id:source.id,state:source.state}))}])),
        agent: snapshot.agents.data.agents[0], agentCount: snapshot.agents.data.agents.length,
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
    assert.equal(initial.agentCount, 32, 'L1 must have exactly 32 synthetic agents')
    assert.equal(initial.activeSubagentCount, null, 'unknown active subagent count must remain null')
    assert.equal(initial.taskCount, manifest.plistCount + manifest.hermesJobIds.length)
    assert.deepEqual([...initial.hermesIds].sort(), [...manifest.hermesJobIds].sort())
    assert.ok(initial.cpuCores > 0 && initial.memoryTotal > 0, 'system values must come from a successful real collection')
    await ui.dom('overview preserves unknown active count', `${$('.summary-strip button:nth-child(2) strong')}?.textContent === '—'`)
    await ui.navigate('数据来源', 'Data sources')
    for (const section of ['agents', 'schedules', 'system', 'events']) {
      await ui.dom(`${section} sources rendered`, `${$(`[data-source-section="${section}"]`)}?.querySelectorAll('[data-source-id]').length > 0`)
      for (const source of initial.sections[section].sources) {
        await ui.dom(`${section}/${source.id} source row`, `!!${$(`[data-source-section="${section}"] [data-source-id=${JSON.stringify(source.id)}]`)}`)
      }
    }
    await ui.dom('synthetic origin is visible', `${$('[data-source-id="performance-fixture"]')}?.textContent.includes('Synthetic workload')`)
    return { evidence: { agents: 'synthetic fixture', schedules: 'synthetic files and SQLite', system: 'real local collector' }, agents: initial.agentCount, tasks: initial.taskCount, activeSubagents: null }
  })
  if (scenario === 'notifications') {
    const notifications = await exerciseNotifications({ ui, main, renderer, manifest, capture })
    return { settings: { notifications } }
  }

  await exerciseEmptyEvents(ui)

  await ui.stage('overview-agent-and-escape-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    const inspector = `.agent-inspector[data-agent-id=${JSON.stringify(initial.agent.id)}]`
    await ui.dom('overview opens the exact Agent', `${$(inspector)}?.querySelector('h2')?.textContent === ${JSON.stringify(initial.agent.name)}`)
    await ui.dom('Agent source remains explicitly synthetic', `${$(inspector)}?.textContent.includes('Performance fixture (synthetic)')`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('Agent inspector closes on Escape', `!${$('.agent-inspector')}`)
    await ui.frames()
    const focused = `document.activeElement === ${$(`.react-flow__node[data-id=${JSON.stringify(initial.agent.id)}]`)}`
    record('agent-focus-after-overview-escape', await ui.evaluate(`(() => {
      const active = document.activeElement;
      const expected = ${$(`.react-flow__node[data-id=${JSON.stringify(initial.agent.id)}]`)};
      return { active: { tag: active?.tagName, class: active?.className, label: active?.getAttribute('aria-label'), id: active?.getAttribute('data-id') },
        expected: expected && { connected: expected.isConnected, tabIndex: expected.tabIndex, visibility: getComputedStyle(expected).visibility }, focused: ${focused} };
    })()`))
    assert.equal(await ui.evaluate(focused), true, 'U-07: focus must survive two frames on the original Agent node')
    await ui.key('Enter', 'Enter', 13)
    await ui.dom('returned Agent node remains keyboard operable', `!!${$(inspector)}`)
    await ui.key('Escape', 'Escape', 27)
    await ui.frames()
    assert.equal(await ui.evaluate(focused), true, 'U-07: repeated open/close must retain node focus')
    return { agentId: initial.agent.id, input: 'CDP mouse and Enter/Escape', focusCheckedAfterFrames: 2 }
  })

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
    await renderer.call('Input.insertText', { text: 'Perf schedule 000' }, RPC_MS)
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
      // Keep the real request pending while observing the main-process resource
      // lease. The second CDP operation cancels the same real IPC request.
      pending = renderer.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(hermesId)},0).then(() => ({resolved:true}), error => ({resolved:false,error:String(error)}))`, RPC_MS)
        .then(value => ({ value }), error => ({ protocolError: error }))
      await ui.expect('real history subprocess admitted before cancellation', async () => historyResource(await ui.info()).current.commands === 1, 2_000)
      await ui.evaluate('window.monitor.cancelScheduleHistory(); true')
      const result = await pending
      if (result.protocolError) throw result.protocolError
      assert.equal(result.value.resolved, false, 'cancelled IPC history must reject')
      assert.match(result.value.error, /cancelled|取消|abort/i)
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
      const cleanup = await Promise.allSettled([ui.evaluate('window.monitor.cancelScheduleHistory(); true'), release()])
      if (pending) {
        const result = await pending
        if (result.protocolError) cleanup.push({ status: 'rejected', reason: result.protocolError })
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
      await renderer.evaluate('window.monitor.refresh("schedules")', 35_000)
      const broken = await ui.evaluate(`window.monitor.snapshot().then(value => ({error:value.schedules.error, at:value.schedules.data.collectedAt, count:value.schedules.data.jobs.length, agents:value.agents.data.agents.length, system:!!value.system.data}))`)
      assert.match(broken.error, /Hermes/, 'malformed metadata must expose its section collection error')
      assert.equal(broken.at, previous.at, 'configuration failure must retain the last complete snapshot')
      assert.equal(broken.count, previous.count, 'configuration failure must not replace known tasks with a partial list')
      await ui.dom('broken fixture reports its retained snapshot error', `${$(`${SCHEDULES} .source-section-error[role="alert"]`)}?.textContent.includes('Hermes')`)
      assert.equal(broken.agents, 32, 'fixture failure must not stop Agent collection')
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

  await ui.stage('ipc-disconnection-and-recovery', async () => {
    await ui.navigate('本机概览', 'Overview')
    let failure
    try {
      await main.evaluate('globalThis.__ocSmokeControl.faultSnapshot(true)', RPC_MS)
      const rejected = await ui.evaluate('window.monitor.snapshot().then(() => ({rejected:false}), error => ({rejected:true,error:String(error)}))')
      assert.equal(rejected.rejected, true, 'removing the real snapshot IPC handler must reject')
      assert.match(rejected.error, /monitor:snapshot/)
      await ui.navigate('数据来源', 'Data sources')
      await ui.dom('real snapshot IPC error reaches the source UI', `Array.from(document.querySelectorAll('.error-notice[role="alert"]')).some(element => element.textContent.includes('monitor:snapshot'))`)
      record('ipc-error-observed', { status: 'observed', channel: 'monitor:snapshot', error: rejected.error.slice(0, 512) })
      await capture('ipc-disconnected')
      if (fault !== 'ipc') await main.evaluate('globalThis.__ocSmokeControl.faultSnapshot(false)', RPC_MS)
      await ui.click(`Array.from(document.querySelectorAll('.error-notice')).find(element => element.textContent.includes('monitor:snapshot')).querySelector('button')`)
      await ui.dom('critical IPC recovery: source error must clear', `!Array.from(document.querySelectorAll('.error-notice')).some(element => element.textContent.includes('monitor:snapshot'))`)
      const recovered = await ui.evaluate('window.monitor.snapshot().then(value => ["agents","schedules","system"].every(section => !!value[section].data))')
      assert.equal(recovered, true, 'restored handler must return the actual three-section snapshot')
      return { channel: 'monitor:snapshot', rejectedDuringFault: true, recovered: true }
    } catch (error) { failure = error; throw error }
    finally {
      try { await main.evaluate('globalThis.__ocSmokeControl.faultSnapshot(false)', RPC_MS) }
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
      await renderer.evaluate('window.monitor.refresh("events")', 20_000)
      const error = await ui.evaluate('window.monitor.snapshot().then(value => value.events.error)')
      assert.equal(error, null, `event sample ${sample} failed`)
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
    for (const source of info.resources.sources.filter(source => ['event-store', 'hermes-events'].includes(source.source))) {
      for (const key of usageKeys) assert.equal(source.current[key], 0, 'disabled event plugin must drain its resources')
    }
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
      const filename = await main.evaluate('globalThis.__ocSmokeControl.eventDatabase()', RPC_MS)
      assert.equal(filename, path.join((await ui.info()).userData, 'events', 'events.sqlite'))
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
    return { settings, persistence: 'UI radio -> real preload/settings IPC; runner compares actual settings.json and restarts' }
  })
  return { settings }
}

export async function verifyRestart({ main, renderer, savedSettings, record, capture, scenario = 'all' }) {
  const ui = controls({ main, renderer, record, capture })
  if (scenario === 'notifications') {
    await ui.stage('restart-notification-settings', async () => {
      await ui.dom('restarted real renderer is ready', `!!window.desktopSettings && !!${$('.app-shell')} && !document.hidden`)
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
  await ui.stage('restart-settings-persistence', async () => {
    assert.ok(savedSettings && savedSettings.appearance === 'dark' && savedSettings.darkTheme === 'nord', 'restart must receive the actual saved first-process settings')
    await ui.dom('restarted real renderer is ready', `!!window.desktopSettings && !!${$('.app-shell')} && !document.hidden`)
    await ui.info()
    const snapshot = await ui.evaluate('window.desktopSettings.snapshot()')
    assert.equal(snapshot.settings.appearance, savedSettings.appearance)
    assert.equal(snapshot.settings.darkTheme, savedSettings.darkTheme)
    assert.deepEqual(snapshot.settings.notifications, savedSettings.notifications)
    assert.equal(snapshot.resolvedTheme, 'dark')
    await ui.dom('saved theme applied without a preview', `document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.palette === 'nord'`)
    await ui.navigate('设置', 'Settings')
    await ui.dom('saved radio choices restored on restart', `${$('input[name="appearance"][value="dark"]')}?.checked === true && ${$('input[name="darkTheme"][value="nord"]')}?.checked === true`)
    return { settings: { appearance: snapshot.settings.appearance, darkTheme: snapshot.settings.darkTheme }, persistence: 'new isolated process reading first-process settings.json bytes', nativeWindowAcceptance: false }
  })
}
