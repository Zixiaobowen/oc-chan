import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Distribution, now, readLines, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { rotateSessions, appendHermesFailures } from './fixtures.mjs'

const MiB = 1024 ** 2
const normalRss = 1536 * MiB, stressRss = 1792 * MiB

// Fixed-size summaries; only the 24 hourly results are retained in memory.
export class SoakEvidence {
  constructor(instance, full) {
    this.instance = instance; this.full = full; this.started = now(); this.wall = Date.now()
    this.hours = []; this.hour = 0; this.stage = 'initializing'; this.stress = false
    this.counts = {}; this.writes = new Distribution(); this.lateness = new Distribution()
    this.coverage = { resourceSamples: 0, applicationUnavailable: 0, exitedDuringSampling: 0, systemPermissionSamples: 0, missedLifecycles: 0, incompleteLifecycles: 0, clockGaps: 0 }
    this.latest = null; this.previousSample = null; this.lastReceived = now(); this.events = { batches: 0, added: 0, pages: 0, evictionObserved: false }
    this.fixtureQueue = Promise.resolve(); this.fixturePending = 0
    this.firstStableRss = new Distribution(); this.lastStableRss = new Distribution()
  }
  fixture(action) {
    if (++this.fixturePending > 3) { this.fixturePending--; return Promise.reject(new Error('Soak fixture writer queue exceeded')) }
    const operation = this.fixtureQueue.then(action).finally(() => { this.fixturePending-- })
    this.fixtureQueue = operation
    operation.catch(() => {}) // The caller owns failure; retain the rejected chain to forbid reuse.
    return operation
  }
  metric(kind) { this.counts[kind] = (this.counts[kind] ?? 0) + 1 }
  load(count, elapsed, late) { this.counts.generated = (this.counts.generated ?? 0) + count; this.writes.add(elapsed); this.lateness.add(late) }
  clock() {
    const elapsed = now() - this.started
    if (Math.abs(Date.now() - this.wall - elapsed) > 1000) { this.coverage.clockGaps++; throw new Error('Soak wall/monotonic clock discontinuity exceeds 1000ms') }
    if (!this.instance.stopping && now() - this.lastReceived > 3500) { this.coverage.clockGaps++; throw new Error('Soak application resource sampling gap exceeds 3500ms') }
    return elapsed
  }
  resources(row) {
    if (row.type === 'lifecycle') {
      this.coverage.missedLifecycles += Number(row.missed)
      this.coverage.incompleteLifecycles += Number(row.incomplete)
      return
    }
    if (row.type !== 'resources') return
    this.lastReceived = now()
    if (this.previousSample !== null && (row.monotonicMs <= this.previousSample || row.monotonicMs - this.previousSample > 3500)) {
      this.coverage.clockGaps++; throw new Error('Soak sampler monotonic discontinuity or missing resource interval')
    }
    this.previousSample = row.monotonicMs
    this.coverage.resourceSamples++
    this.coverage.systemPermissionSamples += Number(row.coverage.permissionDenied > 0)
    // ESRCH confirms an enumerated identity exited before its resource read. Keep
    // the null sample and CPU gap; never mistake it for an unreadable live task.
    this.coverage.exitedDuringSampling += row.app.reduce((count, proc) => count + Number(proc.sampleState === 'exited'), 0)
    const available = row.app.some(proc => proc.pid === this.instance.pid && proc.sampleState !== 'exited') &&
      row.app.every(proc => proc.sampleState === 'exited' || proc.rssBytes !== null && proc.fdCount !== null && proc.cpuNs !== null)
    if (!available && !this.instance.stopping) { this.coverage.applicationUnavailable++; throw new Error('Soak observed application RSS/CPU/FD sample unavailable') }
    const rssBytes = row.app.reduce((sum, proc) => sum + (proc.rssBytes ?? 0), 0)
    const completeRss = row.app.every(proc => proc.rssBytes !== null)
    if (available && completeRss && this.full && !this.instance.stopping && this.stage === 'stable-L1') {
      if (this.hour === 2 || this.hour === 3) this.firstStableRss.add(rssBytes / MiB)
      if (this.hour === 22 || this.hour === 23) this.lastStableRss.add(rssBytes / MiB)
    }
    this.latest = { atMs: row.atMs, monotonicMs: row.monotonicMs, rssBytes: completeRss ? rssBytes : null, observedRssBytes: rssBytes,
      fd: row.app.reduce((sum, proc) => sum + (proc.fdCount ?? 0), 0), processes: row.app.length,
      observedApp: row.coverage.observedApp, observedDevelopment: row.coverage.observedDevelopment }
    if (!this.instance.stopping && rssBytes > (this.stress ? stressRss : normalRss)) throw new Error(`Soak ${this.stress ? 'stress' : 'normal'} RSS gate exceeded: ${rssBytes}`)
    if (!this.instance.stopping) this.clock()
  }
  result() {
    return { mode: this.full ? '24h-baseline' : 'compressed-two-hour-phase-preflight', elapsedMs: now() - this.started,
      requiredMs: this.full ? 86400000 : 360000, warmupMs: this.full ? 7200000 : 15000, completedHours: this.hours.length,
      hours: this.hours, events: this.events, coverage: this.coverage, trend: this.trend ?? { status: 'unavailable', reason: 'Requires 24 real hours, including 2h warmup and four stable comparison hours' },
      limits: { normalRssBytes: normalRss, stressRssBytes: stressRss, safetyRssBytes: 2 * 1024 ** 3 },
      acceptance: { real24Hours: this.full && this.hours.length === 24 && now() - this.started >= 86400000,
        nativeNotifications: 'unsupported: real headless adapter; no OS notification was requested',
        notificationDedup: 'Real settings IPC, EventNotifications and bounded journal: suppressed batches, duplicate refresh, disable and restart',
        nativeWindow: 'not exercised: headless', hardware16GiB: 'not established by this run; see host.memoryBytes',
        lifecycle: 'Reported raw; missed/incomplete short-lived children preclude full process-tree coverage',
        cpu: 'Only complete application identity intervals; report valid interval counts separately, never extrapolate missing intervals' } }
  }
}

function assertBudget(snapshot, idle = false) {
  const { limits, global, sources } = snapshot
  for (const key of ['commands', 'files', 'sockets', 'commandBytes', 'fileBytes', 'socketBytes', 'queued']) {
    if (global.peak[key] > limits[key]) throw new Error(`Soak resource peak exceeds ${key}`)
    if (idle && global.current[key] !== 0) throw new Error(`Stopped plugins retain ${key}`)
  }
  if (sources.length > limits.sources || sources.some(source => source.peak.queued > limits.queuedPerSource)) throw new Error('Soak source budget exceeded')
}
function assertStopped(diagnostics) {
  if (diagnostics.timers || diagnostics.queuedRetries || diagnostics.pendingSections.length || diagnostics.plugins.pending ||
      diagnostics.plugins.plugins.some(plugin => plugin.collecting || plugin.starting || plugin.stopping || plugin.retrying || plugin.enabled)) throw new Error('Disabled plugins retain lifecycle work')
}

export async function runSoak(instance, context) {
  const { full, abort, record, fail, log, progress, waitExit } = context
  const evidence = instance.soak = new SoakEvidence(instance, full)
  const hourMs = full ? 3600000 : 180000, hours = full ? 24 : 2
  const deadline = evidence.started + hourMs * hours
  const minuteMs = full ? 60000 : 10000
  let generation = 0, failureSequence = 0, nextRotate = now(), nextEvents = now(), pendingHeartbeat = null
  let heartbeatStarted = 0
  const phase = name => { evidence.stage = name; instance.phase = `hour-${evidence.hour + 1}:${name}` }
  const emitHeartbeat = async () => {
    abort.signal.throwIfAborted(); evidence.clock()
    if (log.failure) throw log.failure
    const value = { complete: false, at: new Date().toISOString(), monotonicElapsedMs: now() - evidence.started, plannedDurationMs: hourMs * hours,
      phaseHour: evidence.hour + 1, stage: evidence.stage, completedHours: evidence.hours.length, latestResource: evidence.latest,
      eventBatches: evidence.events.batches, evidenceRawBytes: log.rawBytes, evidenceGzipBytes: log.bytes, real24Hours: false }
    await record(['soak-minute-heartbeat', value])
    await progress(value)
    abort.signal.throwIfAborted()
  }
  const heartbeat = () => {
    if (pendingHeartbeat) return pendingHeartbeat
    heartbeatStarted = now()
    pendingHeartbeat = emitHeartbeat().finally(() => { pendingHeartbeat = null })
    return pendingHeartbeat
  }
  const timer = setInterval(() => {
    if (pendingHeartbeat) {
      if (now() - heartbeatStarted >= minuteMs) fail(new Error('Soak heartbeat writer exceeded one heartbeat interval'))
      return
    }
    heartbeat().catch(fail)
  }, minuteMs)
  const rotate = async () => {
    const value = await evidence.fixture(() => rotateSessions(instance.fixture, { generation: ++generation, now: Date.now() }))
    await instance.inspector.evaluate(`globalThis.__ocPerformanceControl.sessions(${JSON.stringify(value.sessions)})`)
    await instance.main.evaluate('window.monitor.refresh("agents")', 30000)
    nextRotate = now() + (full ? 10 * 60000 : 30000)
    await record(['soak-rotation', evidence.hour + 1, generation, value.bytes])
  }
  const notifications = async () => {
    const value = await instance.inspector.evaluate('(async()=>({state:globalThis.__ocPerformanceTray.notifications(),journal:await globalThis.__ocPerformanceControl.notificationJournal()}))()')
    if (value.state.permission !== 'unsupported' || value.state.lastSentAt !== null || value.journal.sentAt !== 0 ||
        value.journal.bytes > 64 * 1024 || value.state.pendingCount !== value.journal.summaryCount || value.state.phase === 'error')
      throw new Error(`Headless notification state/journal mismatch: ${JSON.stringify(value)}`)
    return value
  }
  const setNotifications = async enabled => {
    const result = await instance.main.evaluate(`window.desktopSettings.update({notifications:{enabled:${enabled},sourceIds:['hermes-events'],tasks:[],types:['execution-failed','delivery-failed'],quiet:{enabled:false,startMinute:1320,endMinute:480},showTaskNames:false}})`)
    if (!result.ok) throw new Error(`Soak notification settings failed: ${JSON.stringify(result.error)}`)
  }
  const eventPages = () => instance.main.evaluate(`(async()=>{
    const ids=[],types={};let next,upper,pages=0,last;
    do {last=await window.monitor.events({sourceId:'hermes-events',...(next===undefined?{}:{before:next,upper})});
      if(last.entries.length>50)throw new Error('Event page exceeds 50');
      if(upper!==undefined&&last.upper!==upper)throw new Error('Event page cursor changed');
      upper=last.upper;next=last.next;pages++;for(const row of last.entries){ids.push(row.id);types[row.type]=(types[row.type]??0)+1;}
    }while(next!==null&&pages<4);
    if(new Set(ids).size!==ids.length)throw new Error('Duplicate events across pages');
    return {ids,types,pages,retention:last.retention,coverage:last.coverage};})()`, 30000)
  const appendFailures = async () => {
    const beforeNotifications = await notifications()
    const batch = await evidence.fixture(() => appendHermesFailures(instance.fixture, { sequence: failureSequence++, now: Date.now(), count: 40 }))
    const suffixes = batch.executionIds.flatMap(id => ['execution-failed', 'delivery-failed'].map(type =>
      createHash('sha256').update(JSON.stringify([id, type])).digest('hex').slice(0, 32)))
    let page
    for (let attempt = 0; attempt < 12; attempt++) {
      abort.signal.throwIfAborted()
      await instance.main.evaluate('window.monitor.refresh("events")', 30000)
      page = await eventPages()
      if (suffixes.every(suffix => page.ids.some(id => id.endsWith(':' + suffix)))) break
      if (attempt === 11) throw new Error('New Hermes failures did not reach the real event reader/store/IPC')
    }
    if (page.pages < 2 || suffixes.some(suffix => page.ids.filter(id => id.endsWith(':' + suffix)).length !== 1)) throw new Error('Hermes event pagination/uniqueness mismatch')
    const claimedNotifications = await notifications()
    if (claimedNotifications.journal.summaryCount !== beforeNotifications.journal.summaryCount + suffixes.length ||
        claimedNotifications.journal.cursor.sequence <= beforeNotifications.journal.cursor.sequence)
      throw new Error('Real EventNotifications did not claim and suppress exactly the new Hermes batch')
    await instance.main.evaluate('(async()=>{await window.monitor.refresh("events");await window.monitor.refresh("events")})()', 30000)
    const duplicateNotifications = await notifications()
    if (duplicateNotifications.journal.summaryCount !== claimedNotifications.journal.summaryCount ||
        duplicateNotifications.journal.identity !== claimedNotifications.journal.identity ||
        duplicateNotifications.journal.cursor.sequence < claimedNotifications.journal.cursor.sequence)
      throw new Error('Repeated event refresh duplicated notification claims or reset the cursor')
    const repeated = await eventPages()
    if (suffixes.some(suffix => repeated.ids.filter(id => id.endsWith(':' + suffix)).length !== 1)) throw new Error('Repeated collection duplicated or lost Hermes events')
    if (repeated.retention.count > 10000 || repeated.retention.diskBytes > 20 * MiB) throw new Error('Event retention exceeded count/disk budget')
    evidence.events.batches++; evidence.events.added += suffixes.length; evidence.events.pages += page.pages + repeated.pages
    evidence.events.evictionObserved ||= repeated.retention.deletedCount > 0 || evidence.events.added > repeated.retention.count
    evidence.events.latestRetention = repeated.retention
    evidence.events.latestCoverage = repeated.coverage
    evidence.events.notifications = duplicateNotifications
    await record(['soak-events', evidence.hour + 1, { added: suffixes.length, pages: page.pages, repeatedPages: repeated.pages, retention: repeated.retention, coverage: repeated.coverage, notifications: duplicateNotifications }])
    nextEvents = now() + minuteMs
  }
  const lockRecovery = async () => {
    const lock = spawn('/usr/bin/sqlite3', ['-batch', '-bail', instance.fixture.database], { stdio: ['pipe', 'pipe', 'pipe'] })
    let locked = false, lockFailure
    lock.once('error', error => { lockFailure = error; fail(error) })
    lock.stdin.on('error', error => { lockFailure = error; fail(error) })
    readLines(lock.stdout, line => { if (line === 'LOCKED') locked = true }, fail)
    readLines(lock.stderr, line => { if (line) { lockFailure = new Error(`Soak fixture lock: ${line}`); fail(lockFailure) } }, fail)
    try {
      lock.stdin.write("BEGIN EXCLUSIVE; SELECT 'LOCKED';\n")
      await until(() => locked, { timeout: 5000, signal: abort.signal })
      const value = await instance.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(instance.fixture.hermesJobIds[0])},0).then(()=>({unexpectedSuccess:true}),error=>({error:String(error)}))`)
      if (!/locked|锁定/i.test(value.error ?? '')) throw new Error('Soak SQLite exclusive lock was not surfaced')
      await record(['soak-sqlite-locked', evidence.hour + 1, value])
    } finally {
      if (lock.exitCode === null && lock.signalCode === null) lock.stdin.end('ROLLBACK;\n.quit\n')
      try { await waitExit(lock, 5000) } catch (error) { lock.kill('SIGKILL'); await waitExit(lock, 5000); throw error }
    }
    if (lockFailure || lock.exitCode !== 0) throw lockFailure ?? new Error(`SQLite lock owner exited ${lock.exitCode}`)
    const recovered = await instance.main.evaluate(`window.monitor.scheduleHistory(${JSON.stringify(instance.fixture.hermesJobIds[0])},0).then(value=>value.entries.length)`)
    if (recovered !== 25) throw new Error('Soak SQLite reader failed to recover')
    await record(['soak-sqlite-recovered', evidence.hour + 1, recovered])
  }
  try {
    await instance.openTray()
    await heartbeat()
    await setNotifications(true)
    await instance.main.evaluate('window.monitor.refresh("events")', 30000)
    // Baseline before any append: historic fixture failures must not be replayed.
    const baseline = await eventPages()
    if (baseline.ids.length) throw new Error('Events plugin replayed historic failures during initial baseline')
    await record(['soak-event-baseline', baseline])
    if (!full) { phase('compressed-warmup'); await instance.duration(15, { events: true, mutate: true, interact: true }) }
    for (let hour = 0; hour < hours; hour++) {
      evidence.hour = hour
      const hourEnd = evidence.started + (hour + 1) * hourMs
      evidence.counts = {}; evidence.writes = new Distribution(); evidence.lateness = new Distribution()
      instance.measurement = new Measurement(`soak:hour-${hour + 1}:perturbations`)
      phase('session-generation'); await rotate()
      phase('concurrent-refresh')
      await instance.main.evaluate('Promise.all(Array.from({length:100},()=>window.monitor.refresh()))', 120000)
      phase('history-replacement')
      const replacement = await instance.main.evaluate(`Promise.allSettled(Array.from({length:200},(_,index)=>window.monitor.scheduleHistory(${JSON.stringify(instance.fixture.hermesJobIds)}[index%100],0))).then(rows=>({fulfilled:rows.filter(row=>row.status==='fulfilled').length,rejected:rows.filter(row=>row.status==='rejected').length}))`, 120000)
      if (!replacement.fulfilled) throw new Error('Soak final history replacement did not complete')
      await record(['soak-history-replacements', hour + 1, replacement])
      phase('sqlite-lock-recovery'); await lockRecovery()
      phase('plugins-off')
      const beforeStopNotifications = await notifications()
      const stopped = await instance.inspector.evaluate('globalThis.__ocPerformanceControl.plugins(false)', 30000)
      assertStopped(stopped)
      const stoppedNotifications = await notifications()
      if (stoppedNotifications.journal.summaryCount !== 0 || stoppedNotifications.journal.cursor.sequence < beforeStopNotifications.journal.cursor.sequence)
        throw new Error('Disabling events failed to clear pending notifications or preserve claims')
      const idleResources = await instance.inspector.evaluate('globalThis.__ocPerformanceControl.resources()')
      assertBudget(idleResources, true)
      await record(['soak-plugins-off', hour + 1, stopped, idleResources, stoppedNotifications])
      phase('plugins-on')
      await instance.inspector.evaluate('globalThis.__ocPerformanceControl.plugins(true)', 30000)
      await instance.main.evaluate('window.monitor.refresh()', 120000)
      const restartedNotifications = await notifications()
      if (restartedNotifications.journal.summaryCount !== 0 || restartedNotifications.journal.identity !== stoppedNotifications.journal.identity ||
          restartedNotifications.journal.cursor.sequence < stoppedNotifications.journal.cursor.sequence) throw new Error('Restarting events replayed notification history')
      phase('event-failures'); await appendFailures()
      phase('notifications-off-on')
      const claimed = await notifications()
      await setNotifications(false)
      const disabled = await notifications()
      if (disabled.state.phase !== 'off' || disabled.journal.summaryCount !== 0 || disabled.journal.cursor.sequence < claimed.journal.cursor.sequence)
        throw new Error('Turning notifications off did not clear pending summary and preserve the cursor')
      await setNotifications(true)
      await instance.main.evaluate('(async()=>{await window.monitor.refresh("events");await window.monitor.refresh("events")})()', 30000)
      const enabled = await notifications()
      if (enabled.journal.summaryCount !== 0 || enabled.journal.identity !== claimed.journal.identity || enabled.journal.cursor.sequence < claimed.journal.cursor.sequence)
        throw new Error('Re-enabling notifications replayed already claimed events')
      await record(['soak-notifications-off-on', hour + 1, { claimed, disabled, enabled }])
      phase('events-ui-pagination')
      await instance.main.evaluate(`(()=>{const button=[...document.querySelectorAll('.sidebar nav button')].find(item=>item.textContent.includes('事件'));if(!button)throw new Error('Missing event navigation');button.click()})()`)
      await until(() => instance.main.evaluate(`(()=>{const button=document.querySelector('[data-event-action="latest"]');if(!button||button.getAttribute('aria-disabled')==='true')return false;button.click();return true})()`), { timeout: 15000, signal: abort.signal })
      const firstPage = await until(() => instance.main.evaluate(`(()=>{const ids=[...document.querySelectorAll('.event-list [data-event-id]')].map(row=>row.dataset.eventId);return /第 1 页|Page 1/.test(document.querySelector('.event-counts')?.textContent??'')&&ids.length&&document.querySelector('[data-event-action="next"]')?.getAttribute('aria-disabled')==='false'?ids:null})()`), { timeout: 15000, signal: abort.signal })
      await instance.main.evaluate(`document.querySelector('[data-event-action="next"]').click()`)
      const secondPage = await until(() => instance.main.evaluate(`(()=>{const ids=[...document.querySelectorAll('.event-list [data-event-id]')].map(row=>row.dataset.eventId);return /第 2 页|Page 2/.test(document.querySelector('.event-counts')?.textContent??'')&&ids.length?ids:null})()`), { timeout: 15000, signal: abort.signal })
      if (firstPage.length > 50 || secondPage.length > 50 || new Set([...firstPage, ...secondPage]).size !== firstPage.length + secondPage.length)
        throw new Error('Real event UI pagination duplicated rows or exceeded its page bound')
      await record(['soak-events-ui', hour + 1, { firstPage: firstPage.length, secondPage: secondPage.length, distinct: true }])
      await instance.interact(0)
      phase('L2-burst'); evidence.stress = true
      await instance.inspector.evaluate('globalThis.__ocPerformanceControl.nodes(128)', 30000)
      instance.level = 'L2'
      const burstAt = now()
      await instance.duration(full ? 55 : 3, { events: true, frequency: 10 })
      const burstMs = now() - burstAt
      if (burstMs > 60000) throw new Error('L2 burst exceeded 60 seconds')
      await record(['soak-L2-burst', hour + 1, { sessions: 128, frequency: 10, elapsedMs: burstMs }])
      instance.level = 'L1'
      await instance.inspector.evaluate('globalThis.__ocPerformanceControl.nodes(32)', 30000)
      phase('post-burst-cooldown')
      await instance.duration(full ? 60 : 5)
      evidence.stress = false
      if (!evidence.latest || evidence.latest.rssBytes === null || evidence.latest.rssBytes > normalRss) throw new Error('Soak RSS did not establish a complete sample below the normal budget after burst')
      const perturbations = instance.measurement.result()
      const postBurst = { ...evidence.latest }
      phase(full && hour < 2 ? 'warmup-L1' : 'stable-L1')
      instance.measurement = new Measurement(`soak:hour-${hour + 1}:stable-L1`)
      const stableAt = now(), idleMs = full ? 60000 : 5000
      const stableEnd = hourEnd - idleMs
      const load = instance.duration(Math.max(0, stableEnd - now()) / 1000, { events: true, mutate: true, interact: true })
      load.catch(fail)
      try {
        while (now() < stableEnd) {
          abort.signal.throwIfAborted(); evidence.clock()
          if (now() >= nextRotate) await rotate()
          if (now() >= nextEvents) await appendFailures()
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } catch (error) { fail(error); throw error }
      finally { await load }
      if (now() - stableAt < (full ? 300000 : 10000)) throw new Error('Hourly perturbations left insufficient stable L1 observation time')
      const stable = instance.measurement.result()
      if (!stable.applicationRssMiB.count || !stable.counters.expected || !stable.counters.committed) throw new Error('Stable L1 lacks resource or committed-event observations')
      const latency = stable.latencyMs.eventToCommit, cpu = stable.applicationCpuOneCorePercent
      const latencyExceeded = latency.p95 === null || latency.p99 === null || latency.p95 > 350 || latency.p99 > 500
      const cpuExceeded = cpu.p95 !== null && cpu.p95 > 60 || cpu.p99 !== null && cpu.p99 > 100 || cpu.overflow > 0
      const sufficientCpu = cpu.count >= 100 && cpu.p95 !== null && cpu.p99 !== null
      const gates = {
        enforced: !full || hour >= 2,
        latency: { status: latencyExceeded ? 'failed' : 'passed', p95Ms: latency.p95, p99Ms: latency.p99, p95LimitMs: 350, p99LimitMs: 500,
          committedSamples: latency.count, expectedEvents: stable.counters.expected, scope: 'Committed events only; coalesced/uncommitted events remain in the denominator counters' },
        cpu: { status: cpuExceeded ? 'failed' : sufficientCpu ? 'passed-observed-intervals' : 'insufficient',
          p95OneCorePercent: cpu.p95, p99OneCorePercent: cpu.p99, p95Limit: 60, p99Limit: 100,
          validIntervals: cpu.count, minimumIntervals: 100, resourceSamples: stable.counters.resourceSamples,
          incompleteIntervals: stable.counters.incompleteApplicationCpuIntervals,
          coverage: sufficientCpu ? 'At least 100 complete identity intervals; excludes missing intervals and does not establish full-tree CPU coverage' : 'Fewer than 100 valid intervals or undefined percentile; no CPU acceptance claim' }
      }
      await record(['soak-hour-gates', hour + 1, gates])
      phase('idle-falloff'); instance.measurement = new Measurement(`soak:hour-${hour + 1}:idle`)
      await instance.duration(Math.max(0, hourEnd - now()) / 1000)
      const idle = instance.measurement.result()
      const hourlyNotifications = await notifications()
      const resources = await instance.inspector.evaluate('globalThis.__ocPerformanceControl.resources()')
      assertBudget(resources)
      const summary = { hour: hour + 1, warmup: full && hour < 2, endElapsedMs: now() - evidence.started, stableElapsedMs: hourEnd - idleMs - stableAt,
        perturbations, stable, gates, idle, postBurst, resources, notifications: hourlyNotifications, generated: { counts: evidence.counts, writeMs: evidence.writes.result(), latenessMs: evidence.lateness.result() } }
      evidence.hours.push(summary)
      await record(['soak-hour', summary]); await heartbeat()
      if (gates.enforced && (latencyExceeded || cpuExceeded)) throw new Error(`Stable L1 hourly acceptance failed: hour ${hour + 1}, latency=${gates.latency.status}, CPU=${gates.cpu.status}`)
    }
    if (now() < deadline) throw new Error('Soak completed before its monotonic duration deadline')
    if (full) {
      const first = evidence.hours.slice(2, 4).map(hour => hour.stable), last = evidence.hours.slice(-2).map(hour => hour.stable)
      const mean = (rows, field) => rows.some(row => row[field].mean === null) ? null : rows.reduce((sum, row) => sum + row[field].mean * row[field].count, 0) / rows.reduce((sum, row) => sum + row[field].count, 0)
      const firstMedian = evidence.firstStableRss.percentile(.5), lastMedian = evidence.lastStableRss.percentile(.5)
      const medianLimit = firstMedian === null ? null : Math.max(firstMedian * .1, 64)
      const medianDelta = firstMedian === null || lastMedian === null ? null : lastMedian - firstMedian
      const medianFailed = medianDelta === null || medianDelta > medianLimit
      evidence.trend = { status: 'measured', firstHours: [3, 4], lastHours: [23, 24],
        rssMeanMiB: { first: mean(first, 'applicationRssMiB'), last: mean(last, 'applicationRssMiB') },
        rssMedianMiB: { status: medianFailed ? 'failed' : 'passed', first: firstMedian, last: lastMedian, delta: medianDelta, maximumGrowth: medianLimit,
          firstSamples: evidence.firstStableRss.count, lastSamples: evidence.lastStableRss.count, resolutionMiB: .25,
          scope: 'Merged complete stable-L1 RSS snapshots from hours 3/4 and 23/24; snapshots with null RSS remain coverage gaps; threshold=max(first median*10%,64MiB)' },
        cpuOneCorePercent: { first: mean(first, 'applicationCpuOneCorePercent'), last: mean(last, 'applicationCpuOneCorePercent'), validIntervals: [...first, ...last].map(row => row.applicationCpuOneCorePercent.count) },
        fdMax: { first: Math.max(...first.map(row => row.maxObservedFd)), last: Math.max(...last.map(row => row.maxObservedFd)) },
        processMax: { first: Math.max(...first.map(row => row.maxObservedProcesses)), last: Math.max(...last.map(row => row.maxObservedProcesses)) } }
      evidence.trend.rssMeanMiB.delta = evidence.trend.rssMeanMiB.last - evidence.trend.rssMeanMiB.first
      evidence.trend.eventToCommitP95Ms = { first: first.map(row => row.latencyMs.eventToCommit.p95), last: last.map(row => row.latencyMs.eventToCommit.p95), note: 'Per-hour percentiles; not an average or merged percentile' }
      if ([...first, ...last].some(row => !row.applicationCpuOneCorePercent.count)) evidence.trend.cpuOneCorePercent.status = 'insufficient complete identity intervals'
      else evidence.trend.cpuOneCorePercent.status = 'observed complete intervals only'
      await record(['soak-trend', evidence.trend])
      if (medianFailed) throw new Error(`Soak merged RSS median growth failed: ${medianDelta} MiB > ${medianLimit} MiB, or missing comparison samples`)
    }
  } finally {
    clearInterval(timer)
    if (pendingHeartbeat) await pendingHeartbeat
    const { hours: _hours, ...summary } = evidence.result()
    await record(['soak-end', summary])
  }
}
