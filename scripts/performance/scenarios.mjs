import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Measurement } from './measurement.mjs'
import { realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createMarketFeed } from '../smoke/marketplace-feed.mjs'
import { exerciseSmoke } from '../smoke/scenarios.mjs'
import { setPlistCount } from './fixtures.mjs'
import { now, readLines, until } from './core.mjs'
const exec = promisify(execFile)

export function assertBudget(snapshot, idle = false) {
  const { limits, global, sources } = snapshot
  for (const key of ['commands','files','sockets','commandBytes','fileBytes','socketBytes','pluginProcesses','pluginProtocolBytes','queued']) {
    assert(Number.isFinite(global.peak[key]) && global.peak[key] <= limits[key], `Resource peak exceeds ${key}`)
    if (idle) assert.equal(global.current[key], 0, `Stopped work retains ${key}`)
  }
  assert(sources.length <= limits.sources && sources.every(source => source.peak.queued <= limits.queuedPerSource))
}
export async function plugins(instance, enabled) {
  const expected = { agents: enabled, schedules: enabled, events: enabled, system: enabled }
  const value = await instance.operation(`window.desktopSettings.update({plugins:${JSON.stringify(expected)}}).then(value=>{if(!value.ok)throw new Error(JSON.stringify(value.error));return {plugins:value.snapshot.settings.plugins}})`)
  assert.deepEqual(value.plugins, expected, 'Plugin preferences must match the successful settings receipt')
  const info = await instance.driver.host('info'); assertBudget(info.resources, !enabled)
  if (!enabled) assert(info.plugins.every(plugin => !plugin.enabled && plugin.phase === 'disabled'), 'Plugin stop failed to drain')
  return { value, plugins: info.plugins, resources: info.resources, notifications: info.notifications }
}

export async function replacements(instance, record) {
  const refresh = await instance.operation(`Promise.allSettled(Array.from({length:100},()=>window.monitor.refresh())).then(rows=>({count:rows.length,fulfilled:rows.filter(r=>r.status==='fulfilled').length,errors:rows.filter(r=>r.status==='rejected').map(r=>({code:r.reason?.code,name:r.reason?.name,message:String(r.reason)})).slice(0,100)}))`)
  assert.equal(refresh.count, 100); assert(refresh.fulfilled > 0)
  assert(refresh.errors.every(error => error.code === 'OC_IPC_BUSY'), 'Refresh burst produced an uncontrolled error')
  await instance.operation('window.monitor.refresh()')
  const ids = JSON.stringify(instance.fixture.hermesJobIds)
  const history = await instance.operation(`Promise.allSettled(Array.from({length:200},(_,i)=>window.monitor.scheduleHistory(${ids}[i%100],0))).then(rows=>({count:rows.length,fulfilled:rows.filter(r=>r.status==='fulfilled').length,errors:rows.filter(r=>r.status==='rejected').map(r=>({code:r.reason?.code,name:r.reason?.name,message:String(r.reason)})).slice(0,200)}))`)
  assert.equal(history.count, 200); assert(history.fulfilled > 0, 'Final replacement never completed')
  assert(history.errors.every(error => error.code === 'OC_IPC_BUSY' || error.code === 'ABORT_ERR' || error.name === 'AbortError'), 'History burst produced an uncontrolled error')
  const page = await instance.operation(`window.monitor.scheduleHistory(${ids}[99],0).then(value=>({count:value.entries.length,source:value.source}))`)
  assert.equal(page.count, 25); assert.equal(page.source, 'hermes')
  await record(['refresh-and-history-replacement', { refresh, history, finalPage: page, resources: (await instance.driver.host('info')).resources }])
  return { refresh, history }
}
export async function lockedHistory(instance, { abort, record }) {
  const child = spawn('/usr/bin/sqlite3', ['-batch','-bail',instance.fixture.database], { stdio: ['pipe','pipe','pipe'] })
  let locked = false, failure
  child.on('error', error => { failure = error }); child.stdin.on('error', error => { failure = error })
  readLines(child.stdout, line => { if (line === 'LOCKED') locked = true }, error => { failure = error })
  readLines(child.stderr, line => { if (line) failure = new Error(line) }, error => { failure = error })
  const job = JSON.stringify(instance.fixture.hermesJobIds[0])
  try {
    child.stdin.write("BEGIN EXCLUSIVE; SELECT 'LOCKED';\n")
    await until(() => { if (failure) throw failure; return locked }, { timeout: 5000, signal: abort.signal })
    const result = await instance.operation(`window.monitor.scheduleHistory(${job},0).then(()=>({unexpected:true}),error=>({error:String(error)}))`)
    assert.match(result.error ?? '', /locked|锁|busy|OC_.*(?:TIMEOUT|SQLITE)/i)
    await record(['sqlite-lock', result])
  } finally {
    child.stdin.end('ROLLBACK;\n.quit\n')
    try { await until(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5000 }) }
    catch (error) { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5000 }); throw error }
  }
  if (failure) throw failure
  assert.equal(await instance.operation(`window.monitor.scheduleHistory(${job},0).then(value=>value.entries.length)`), 25)
}
export async function slowHistory(instance, record) {
  const sql = text => exec('/usr/bin/sqlite3', ['-batch','-bail',instance.fixture.database,text], { timeout: 30000, maxBuffer: 65536 })
  await sql('ALTER TABLE executions RENAME TO performance_saved_executions; CREATE VIEW executions AS SELECT * FROM performance_saved_executions WHERE (WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<100000000) SELECT count(*) FROM slow)>0;')
  try {
    const began = now(), job = JSON.stringify(instance.fixture.hermesJobIds[0])
    const result = await instance.operation(`window.monitor.scheduleHistory(${job},0).then(()=>({unexpected:true}),error=>({error:String(error)}))`, 15000)
    assert.match(result.error ?? '', /timeout|timed out|超时|deadline|interrupt|中断/i)
    await record(['sqlite-timeout', { elapsedMs: now()-began, result }])
  } finally { await sql('DROP VIEW executions; ALTER TABLE performance_saved_executions RENAME TO executions;') }
}
export async function runStress(instance, context) {
  const { full, abort, record } = context
  instance.phase = 'real-marketplace-faults'
  const assets = path.join(await realpath(instance.directory), 'market-assets')
  const pendingRecords = new Set()
  let recordFailure
  const log = (name, details) => {
    assert(pendingRecords.size < 256, 'Marketplace evidence queue exceeded')
    const task = record(['marketplace',name,details]); pendingRecords.add(task)
    task.then(() => pendingRecords.delete(task), error => { recordFailure ??= error; pendingRecords.delete(task) })
  }
  const feed = await createMarketFeed(assets, { signal: abort.signal, record: log })
  let captures = 0
  try {
    const renderer = { ...instance.main, evaluate: async expression => { await instance.drain(); const value = await instance.main.evaluate(expression); await instance.drain(); return value } }
    await exerciseSmoke({ main:instance.driver, renderer, manifest:instance.fixture, record:log, scenario:'marketplace', feed,
      capture:async name => {
        assert(++captures <= 64, 'Screenshot count exceeded')
        const image = await instance.main.capture(); const bytes = Buffer.from(image.pngBase64,'base64')
        assert(bytes.length <= 1024*1024 && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a')
        await writeFile(path.join(instance.directory, `market-${captures}-${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.png`), bytes, { flag:'wx',mode:0o600 })
      } })
  } finally { await feed.close(); await Promise.all(pendingRecords); if (recordFailure) throw recordFailure }
  await instance.interact(0)
  await instance.openTray(); instance.metrics = false; await instance.duration(full ? 120 : 2); instance.metrics = true
  instance.phase = '128-session-burst'; instance.measurement = new Measurement(instance.phase)
  await instance.duration(full ? 60 : 2, { events: true, frequency: 10 }); await instance.duration(2)
  assert(instance.measurement.counters.expected >= 128 && instance.measurement.counters.committed > 0, 'Real session burst lacks commits')
  instance.slices.push(instance.measurement.result())
  instance.phase = 'plist-boundaries'
  for (const count of [3996,3997,4096,4097]) {
    await setPlistCount(instance.fixture, count)
    const previous = await instance.main.evaluate('window.monitor.snapshot().then(value=>({count:value.schedules.data?.jobs.length,at:value.schedules.data?.collectedAt}))')
    const refresh = await instance.operation('window.monitor.refresh("schedules").then(()=>({rejected:false}),error=>({rejected:true,error:String(error)}))')
    const observed = await instance.main.evaluate(`window.monitor.snapshot().then(value=>({count:value.schedules.data?.jobs.length,at:value.schedules.data?.collectedAt,error:value.schedules.error,sources:value.schedules.data?.sources}))`)
    assert((observed.count ?? 0) <= 4096, 'Schedule publication exceeds fixed bound')
    if (refresh.rejected) {
      assert.match(refresh.error, /OC_COLLECTION_LIMIT/, 'Oversized schedule refresh must preserve its resource-limit cause')
      assert(observed.error, 'Rejected schedule refresh lacks a visible section error')
      assert.equal(observed.at, previous.at, 'Rejected schedule refresh replaced the last complete snapshot')
      assert.equal(observed.count, previous.count, 'Rejected schedule refresh published a partial task list')
    }
    if (count >= 4096) assert(refresh.rejected, 'Oversized schedule source was accepted without a complete budget')
    await record(['plist-boundary', { count, refresh, observed, scope: 'real fixture user directory plus actual machine system sources' }])
  }
  await setPlistCount(instance.fixture,1000); await instance.operation('window.monitor.refresh("schedules")')
  const recovered = await instance.main.evaluate('window.monitor.snapshot().then(value=>({count:value.schedules.data?.jobs.length,error:value.schedules.error}))')
  assert(!recovered.error && recovered.count >= 1100, 'Schedule source failed to recover')
  instance.phase = 'replacements'; await replacements(instance, record)
  instance.phase = 'oversized-record'
  await instance.load.oversized(async () => {
    const observed = await until(async () => {
      await instance.drain()
      const sources = await instance.main.evaluate('window.monitor.snapshot().then(value=>value.agents.data?.sources)')
      return sources?.find(source => /JSONL|尾部|record|记录|limit|窗口/i.test(source.detail ?? '') && source.state !== 'ok')
    }, { timeout: 15000, signal: abort.signal })
    await record(['oversized-session', observed])
  })
  instance.phase = 'database'; await lockedHistory(instance, context); await slowHistory(instance, record)
  const original = await instance.main.evaluate('window.desktopSettings.snapshot().then(value=>value.settings.plugins)')
  for (let index = 0; index < (full ? 20 : 2); index++) {
    instance.phase = `plugins-cycle-${index}`
    await record(['plugins-off', await plugins(instance,false)]); await instance.duration(full ? 2 : .2)
    await record(['plugins-on', await plugins(instance,true)]); await instance.duration(full ? 2 : .2)
  }
  const restored = await instance.operation(`window.desktopSettings.update({plugins:${JSON.stringify(original)}}).then(value=>{if(!value.ok)throw new Error(JSON.stringify(value.error));return value.snapshot.settings.plugins})`)
  assert.deepEqual(restored, original, 'Original plugin preferences must be restored')
  instance.phase = 'topology'; await instance.interact(0)
  // Pause incoming display updates while rendering a bounded expansion of real nodes.
  // This is explicitly renderer load, separate from the 128 real session denominator.
  await instance.main.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(item=>/暂停显示|Pause display/.test(item.textContent));if(!b)throw new Error('Pause display control missing');b.click();return true})()`)
  for (const count of [128,500,2000]) {
    for (const mode of ['2D','3D']) {
      instance.phase = `topology-${count}-${mode}`
      await instance.drain()
      const drawsBefore = { ...instance.draws.byView.main }, framesBefore = instance.frames.count
      const before = await instance.main.evaluate('window.__ocPerf.status().commits')
      // Project while still in 2D before entering 3D, so initial draws use this load.
      const projected = await instance.main.evaluate(`window.__ocPerf.topology(${count})`)
      await until(() => instance.main.evaluate(`window.__ocPerf.status().commits>${before}`), { signal: abort.signal })
      await instance.main.evaluate(`(()=>{const b=[...document.querySelectorAll('.topology-mode button')].find(item=>item.textContent===${JSON.stringify(mode)});if(!b)throw new Error('Topology mode control missing');b.click();return true})()`)
      const observed = await until(async () => {
        await instance.drain()
        const value = await instance.main.evaluate(`(()=>{
          const caption=document.querySelector('.topology-caption strong')?.textContent??'';
          const pageSummary=document.querySelector('.topology-page-summary')?.textContent??'';
          const page=/^(?:本页 |This page: )(\\d+) \\/ (\\d+)/.exec(pageSummary);
          const picker=document.querySelectorAll('.topology-3d-picker select')[1];
          const alert=document.querySelector('.topology-3d-message[role="alert"]');
          return {mode:document.querySelector('.topology-mode button[aria-pressed="true"]')?.textContent,
            caption,pageSummary,pageNodes:page?Number(page[1]):null,totalExpandedNodes:page?Number(page[2]):null,
            employeeNodes:picker?[...picker.options].filter(option=>option.value).length:null,
            mounted2DNodes:document.querySelectorAll('.react-flow__node').length,
            canvas:Boolean(document.querySelector('.topology-3d-scene canvas')),
            alert:alert?{title:alert.querySelector('strong')?.textContent,detail:alert.querySelector('p')?.textContent}:null,
            probe:window.__ocPerf.status()};
        })()`)
        if (value.mode !== mode || !new RegExp(`^${count} (?:个 Agent|agents)$`).test(value.caption)) return null
        if (mode === '3D') return value.alert || (value.canvas && value.employeeNodes === count && instance.draws.byView.main.calls > drawsBefore.calls) ? value : null
        return value.mounted2DNodes > 0 ? value : null
      }, { signal: abort.signal })
      let outcome = 'rendered', actualGraphNodes
      if (mode === '3D' && count === 2000) {
        assert.match(observed.alert?.title ?? '', /^(?:当前关系图超出 3D 显示预算|This graph exceeds the 3D display budget)$/)
        const budget = /^(?:当前 |Current: )(\d+)(?: 位员工、| employees, )(\d+)(?: 条关系；上限 | relationships; limits: )(\d+) \/ (\d+)/.exec(observed.alert.detail)
        assert(budget, '3D budget rejection lacks graph counts and limits')
        assert.equal(Number(budget[1]), count); assert.equal(Number(budget[3]), 1200); assert.equal(Number(budget[4]), 2400)
        assert(Number(budget[1]) > Number(budget[3]) || Number(budget[2]) > Number(budget[4]))
        assert(!observed.canvas, 'Rejected 3D graph allocated a scene canvas')
        actualGraphNodes = Number(budget[1]); outcome = 'budget-rejected'
      } else if (mode === '3D') {
        assert.equal(observed.alert, null, `3D rendering failed: ${JSON.stringify(observed.alert)}`)
        actualGraphNodes = observed.employeeNodes
        assert.equal(actualGraphNodes, count)
        assert(instance.draws.byView.main.calls > drawsBefore.calls, 'Real WebGL did not submit draws')
      } else {
        actualGraphNodes = observed.pageNodes ?? count
        assert.equal(actualGraphNodes, Math.min(count, 200), '2D graph page differs from the layout budget')
        if (observed.pageNodes !== null) assert.equal(observed.totalExpandedNodes, count)
      }
      await instance.duration(full ? 15 : 2)
      await record(['topology-render-load', { ...projected, mode, outcome, actualGraphNodes,
        accepted3DGraphNodes: mode === '3D' && outcome === 'rendered' ? actualGraphNodes : 0,
        drawBatches: instance.draws.byView.main.batches - drawsBefore.batches, drawCalls: instance.draws.byView.main.calls - drawsBefore.calls,
        nativeRafDrawIntervals: instance.frames.count - framesBefore, observed,
        drawScope: 'main-view original WebGL calls from before projection and mode switch through the observation period; not presented frames or per-node GPU completion' }])
    }
  }
  instance.phase = 'topology-budget-recovery'
  await instance.drain()
  const recoveryDraws = { ...instance.draws.byView.main }
  const recoveryCommits = await instance.main.evaluate('window.__ocPerf.status().commits')
  await instance.main.evaluate('window.__ocPerf.topology(128)')
  const topologyRecovery = await until(async () => {
    await instance.drain()
    const value = await instance.main.evaluate(`(()=>{
      const picker=document.querySelectorAll('.topology-3d-picker select')[1];
      return {actualGraphNodes:picker?[...picker.options].filter(option=>option.value).length:0,
        canvas:Boolean(document.querySelector('.topology-3d-scene canvas')),
        alert:document.querySelector('.topology-3d-message[role="alert"]')?.textContent??null,
        probe:window.__ocPerf.status()};
    })()`)
    return value.probe.commits > recoveryCommits && value.actualGraphNodes === 128 && value.canvas && !value.alert && instance.draws.byView.main.calls > recoveryDraws.calls ? value : null
  }, { signal: abort.signal })
  await record(['topology-budget-recovery', { ...topologyRecovery,
    drawBatches: instance.draws.byView.main.batches - recoveryDraws.batches, drawCalls: instance.draws.byView.main.calls - recoveryDraws.calls }])
  await instance.main.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(item=>/继续显示|Resume display/.test(item.textContent));if(!b)throw new Error('Resume display control missing');b.click();return true})()`)
  await instance.operation('window.monitor.refresh()')
  instance.phase = 'recovery'; await instance.duration(full ? 60 : 2)
}
