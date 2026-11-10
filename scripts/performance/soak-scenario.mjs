import assert from 'node:assert/strict'
import { Distribution, now, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { appendHermesFailures } from './fixtures.mjs'
import { assertBudget, replacements, lockedHistory, plugins } from './scenarios.mjs'
import { eventPagination } from './event-ui.mjs'
const MiB = 1024 ** 2, normalRss = 1536 * MiB, stressRss = 1792 * MiB

// All retained histograms and hourly summaries have fixed capacities. These are
// confirmed descendants only: WebKit XPC remains a separate uncovered budget.
export class SoakEvidence {
  constructor(instance, full) {
    this.instance = instance; this.full = full; this.started = now(); this.wall = Date.now()
    this.hours = []; this.hour = 0; this.stage = 'initializing'; this.stress = false
    this.counts = {}; this.writes = new Distribution(); this.lateness = new Distribution()
    this.coverage = { resourceSamples: 0, applicationUnavailable: 0, exitedDuringSampling: 0, systemPermissionSamples: 0, missedLifecycles: 0, incompleteLifecycles: 0, clockGaps: 0 }
    this.latest = null; this.previousSample = null; this.lastReceived = now(); this.events = { batches: 0, executions: 0, added: 0, pages: 0, evictionObserved: false }
    this.fixtureQueue = Promise.resolve(); this.fixturePending = 0
    this.firstStableRss = new Distribution(); this.lastStableRss = new Distribution()
  }
  fixture(action) {
    if (++this.fixturePending > 3) { this.fixturePending--; return Promise.reject(new Error('Soak fixture writer queue exceeded')) }
    const operation = this.fixtureQueue.then(action).finally(() => { this.fixturePending-- })
    this.fixtureQueue = operation
    operation.catch(() => {}) // Caller owns rejection; rejected chain prevents subsequent reuse.
    return operation
  }
  metric(kind) { this.counts[kind] = (this.counts[kind] ?? 0) + 1 }
  load(count, elapsed, late) { this.counts.generated = (this.counts.generated ?? 0) + count; this.writes.add(elapsed); this.lateness.add(late) }
  clock() {
    const elapsed = now() - this.started
    if (Math.abs(Date.now() - this.wall - elapsed) > 1000) { this.coverage.clockGaps++; throw new Error('Soak wall/monotonic clock discontinuity exceeds 1000ms') }
    if (!this.instance.stopping && now() - this.lastReceived > 3500) { this.coverage.clockGaps++; throw new Error('Soak resource sampling gap exceeds 3500ms') }
    return elapsed
  }
  resources(row) {
    if (row.type === 'lifecycle') { this.coverage.missedLifecycles += Number(row.missed); this.coverage.incompleteLifecycles += Number(row.incomplete); return }
    if (row.type !== 'resources') return
    this.lastReceived = now()
    if (this.previousSample !== null && (row.monotonicMs <= this.previousSample || row.monotonicMs - this.previousSample > 3500)) { this.coverage.clockGaps++; throw new Error('Soak sampler discontinuity') }
    this.previousSample = row.monotonicMs; this.coverage.resourceSamples++
    this.coverage.systemPermissionSamples += Number(row.coverage.permissionDenied > 0)
    this.coverage.exitedDuringSampling += row.app.reduce((count, proc) => count + Number(proc.sampleState === 'exited'), 0)
    const available = row.app.some(proc => proc.pid === this.instance.pid && proc.sampleState !== 'exited') && row.app.every(proc => proc.sampleState === 'exited' || proc.rssBytes !== null && proc.fdCount !== null && proc.cpuNs !== null)
    if (!available && !this.instance.stopping) { this.coverage.applicationUnavailable++; throw new Error('Soak observed application RSS/CPU/FD sample unavailable') }
    const rssBytes = row.app.reduce((sum, proc) => sum + (proc.rssBytes ?? 0), 0), completeRss = row.app.every(proc => proc.rssBytes !== null)
    if (available && completeRss && this.full && !this.instance.stopping && this.stage === 'stable-L1') {
      if (this.hour === 2 || this.hour === 3) this.firstStableRss.add(rssBytes / MiB)
      if (this.hour === 22 || this.hour === 23) this.lastStableRss.add(rssBytes / MiB)
    }
    this.latest = { atMs: row.atMs, monotonicMs: row.monotonicMs, rssBytes: completeRss ? rssBytes : null, observedRssBytes: rssBytes,
      fd: row.app.reduce((sum, proc) => sum + (proc.fdCount ?? 0), 0), processes: row.app.length, observedApp: row.coverage.observedApp, observedDevelopment: row.coverage.observedDevelopment }
    if (!this.instance.stopping && rssBytes > (this.stress ? stressRss : normalRss)) throw new Error(`Soak confirmed-descendant RSS gate exceeded: ${rssBytes}`)
    if (!this.instance.stopping) this.clock()
  }
  result() {
    return { mode: this.full ? '24h-baseline' : 'compressed-two-phase-preflight', elapsedMs: now() - this.started, requiredMs: this.full ? 86400000 : 360000,
      completedHours: this.hours.length, hours: this.hours, events: this.events, coverage: this.coverage,
      trend: this.trend ?? { status: 'unavailable', reason: 'Requires 24 real hours and complete comparison samples' },
      limits: { normalRssBytes: normalRss, stressRssBytes: stressRss, safetyRssBytes: 2 * 1024 ** 3 },
      acceptance: { real24Hours: this.full && this.hours.length === 24 && now()-this.started >= 86400000,
        nativeNotifications: 'read-only permission query and controller start/stop only; types:[] filters every event and no native send is attempted', journalPersistence: 'not independently read from disk',
        processCoverage: 'hourly native-descendant trend excludes XPC; per-run associatedProcesses separately includes verified shared identities and explicit gaps; no exclusive-cost improvement claim',
        nativeWindow: 'headless only', hardware16GiB: 'not established', sleepNetworkTransitions: 'not exercised' } }
  }
}

export async function runSoak(instance, { full, abort, record, progress }) {
  const evidence = instance.soak = new SoakEvidence(instance, full), hours = full ? 24 : 2, hourMs = full ? 3600000 : 180000
  let failureSequence = 0
  const phase = value => { evidence.stage = value; instance.phase = `hour-${evidence.hour+1}:${value}` }
  const notifications = async () => {
    const value = (await instance.driver.host('info')).notifications
    assert(value && value.state, 'Missing notification controller observations')
    assert(['not-determined','denied','authorized','provisional'].includes(value.state.permission), 'Missing actual read-only macOS notification permission'); assert.equal(value.nativeHandles, 0)
    assert.notEqual(value.state.phase, 'error'); assert.equal(value.state.lastSentAt, null)
    if (value.journal) { assert(value.journal.cooldownCount <= 64 && value.journal.sentAtCount <= 3); assert.equal(value.journal.sentAtCount, 0) }
    return value
  }
  const setNotifications = async enabled => {
    const value = await instance.operation(`window.desktopSettings.snapshot().then(value=>window.desktopSettings.update({notifications:{...value.settings.notifications,enabled:${enabled},sourceIds:['hermes-events'],types:[]}})).then(value=>{if(!value.ok)throw new Error(JSON.stringify(value.error));return {enabled:value.snapshot.settings.notifications.enabled,types:value.snapshot.settings.notifications.types}})`)
    assert.deepEqual(value, { enabled, types: [] }, 'Notification settings receipt must match the requested state')
    return value
  }
  const eventPage = (query = {}) => instance.operation(`window.monitor.events(${JSON.stringify({ sourceId:'hermes-events', ...query })}).then(value=>({ids:value.entries.map(event=>event.id),next:value.next,upper:value.upper,retention:value.retention,coverage:value.coverage}))`)
  await instance.openTray(); assert.deepEqual(await setNotifications(true), {enabled:true,types:[]}, 'soak notification settings receipt'); await instance.operation('window.monitor.refresh("events")')
  const baseline = await eventPage(); assert.equal(baseline.ids.length, 0, 'Historic failure baseline replayed')
  await record(['soak-event-baseline', baseline])
  assert.equal((await notifications()).journal?.summaryCount, 0, 'Fresh soak profile must expose its journal with no pending notification summary')
  for (let hour = 0; hour < hours; hour++) {
    abort.signal.throwIfAborted(); evidence.hour = hour; const hourEnd = evidence.started + (hour+1)*hourMs
    evidence.counts = {}; evidence.writes = new Distribution(); evidence.lateness = new Distribution()
    instance.measurement = new Measurement(`soak-${hour+1}:perturbations`)
    phase('session-rotation'); await instance.load.rotate(); await instance.operation('window.monitor.refresh("agents")')
    phase('replacements'); await replacements(instance, record)
    phase('locked-sqlite'); await lockedHistory(instance,{abort,record})
    phase('plugins-off'); const before = await notifications(); const stopped = await plugins(instance,false)
    assert.equal(stopped.notifications.state.pendingCount, 0)
    await record(['soak-plugins-off', hour+1, stopped]); await instance.duration(full ? 5 : .5)
    phase('plugins-on'); await plugins(instance,true); await instance.operation('window.monitor.refresh()')
    const restarted = await notifications()
    if (before.journal && restarted.journal) { assert.equal(restarted.journal.identity,before.journal.identity); assert(restarted.journal.cursor.sequence >= before.journal.cursor.sequence) }
    phase('event-failures')
    for (let batch = 0; batch < (full ? 6 : 2); batch++) {
      const previousIds = new Set((await eventPage()).ids)
      const added = await evidence.fixture(() => appendHermesFailures(instance.fixture,{sequence:++failureSequence, now:Date.now(), count:40}))
      let collectionPasses = 0
      const first = await until(async () => {
        await instance.operation('window.monitor.refresh("events")'); collectionPasses++
        const page = await eventPage(), coverage = page.coverage.find(source => source.sourceId === 'hermes-events')
        assert(coverage && ['catching-up', 'observing'].includes(coverage.state), 'Hermes collection lost observing coverage')
        return coverage.state === 'observing' ? page : null
      }, { timeout: 10000, signal: abort.signal })
      assert(first.next !== null, 'Real failure batch did not produce a second page')
      const second = await eventPage({ before:first.next, upper:first.upper })
      assert(first.retention.count <= 10000 && first.retention.diskBytes <= 20 * 1024 * 1024)
      evidence.events.evictionObserved ||= first.retention.deletedCount > 0
      assert(first.ids.length <= 50 && second.ids.length <= 50)
      assert.equal(new Set([...first.ids,...second.ids]).size,first.ids.length+second.ids.length)
      const newIds = [...first.ids, ...second.ids].filter(id => !previousIds.has(id))
      assert.equal(newIds.length, added.count * 2, 'Each new execution must publish both failure events before checking deduplication')
      evidence.events.batches++; evidence.events.executions += added.count; evidence.events.added += newIds.length
      evidence.events.pages += 2
      const claimed = await notifications(); await instance.operation('window.monitor.refresh("events")'); const duplicate = await notifications()
      if (claimed.journal && duplicate.journal) assert.equal(duplicate.journal.cursor.sequence,claimed.journal.cursor.sequence,'Duplicate refresh reclaimed notifications')
      await record(['soak-event-batch', { hour:hour+1, executions:added.count, events:newIds.length, collectionPasses, first, second, notifications:duplicate }])
    }
    phase('events-ui-pagination'); await record(['soak-event-ui',hour+1,await eventPagination(instance,abort.signal)])
    const claimed = await notifications(); await setNotifications(false); const disabled = await notifications(); assert.equal(disabled.state.pendingCount,0)
    await setNotifications(true); await instance.operation('window.monitor.refresh("events")'); const resumed = await notifications()
    if (claimed.journal && resumed.journal) { assert.equal(resumed.journal.identity,claimed.journal.identity); assert.equal(resumed.journal.cursor.sequence,claimed.journal.cursor.sequence) }
    phase('128-session-burst'); evidence.stress = true; instance.level = 'L2'
    await instance.duration(full ? 55 : 3,{events:true,frequency:10}); instance.level = 'L1'
    phase('post-burst-cooldown'); await instance.duration(full ? 60 : 5); evidence.stress = false
    const perturbations = instance.measurement.result(); assert(evidence.latest?.rssBytes !== null && evidence.latest?.rssBytes <= normalRss)
    phase(full && hour < 2 ? 'warmup-L1' : 'stable-L1'); instance.measurement = new Measurement(`soak-${hour+1}:stable`)
    const stableStart = now(), idleMs = full ? 60000 : 5000
    // Serial chunks preserve one writer and one driver; rotate real files every ten minutes.
    while (now() < hourEnd-idleMs) {
      const seconds = Math.min(600,(hourEnd-idleMs-now())/1000)
      await instance.duration(seconds,{events:true,interact:true,mutate:true})
      if (now() < hourEnd-idleMs) await instance.load.rotate()
      await progress({ elapsedMs:now()-evidence.started,hour:hour+1,phase:evidence.stage,resources:evidence.latest,counters:instance.measurement.counters })
    }
    assert(now()-stableStart >= (full ? 300000 : 10000),'Perturbations left insufficient stable observation')
    const stable = instance.measurement.result(), latency=stable.latencyMs.eventToCommit, cpu=stable.applicationCpuOneCorePercent
    assert(stable.counters.expected > 0 && stable.counters.committed > 0 && stable.applicationRssMiB.count > 0)
    const gates = { enforced:!full || hour>=2, latency:{p95:latency.p95,p99:latency.p99,limits:[350,500]}, cpu:{p95:cpu.p95,p99:cpu.p99,validIntervals:cpu.count,minimum:100,status:cpu.count>=100?'observed-intervals':'insufficient'}, associatedProcesses:instance.associated.result(),totalApplicationRss:'exclusive cost unavailable: associated XPC may be shared' }
    phase('idle-falloff'); instance.measurement = new Measurement(`soak-${hour+1}:idle`); await instance.duration(Math.max(0,hourEnd-now())/1000)
    const resources=(await instance.driver.host('info')).resources; assertBudget(resources)
    const summary={hour:hour+1,elapsedMs:now()-evidence.started,stableElapsedMs:now()-stableStart-idleMs,perturbations,stable,idle:instance.measurement.result(),gates,resources,notifications:await notifications(),generated:{counts:evidence.counts,writeMs:evidence.writes.result(),latenessMs:evidence.lateness.result()}}
    evidence.hours.push(summary); await record(['soak-hour',summary]); await progress({hour:hour+1,elapsedMs:now()-evidence.started,gates})
    if (gates.enforced) { assert(latency.p95!==null && latency.p99!==null && latency.p95<=350 && latency.p99<=500,'Committed-event latency gate exceeded'); assert(cpu.p95===null || cpu.p95<=60,'Observed CPU p95 exceeded'); assert(cpu.p99===null || cpu.p99<=100,'Observed CPU p99 exceeded') }
  }
  assert(now()-evidence.started >= hours*hourMs)
  if (full) {
    assert(evidence.events.evictionObserved, 'Full soak did not observe bounded event retention eviction')
    const first=evidence.firstStableRss.percentile(.5),last=evidence.lastStableRss.percentile(.5),limit=first===null?null:Math.max(first*.1,64)
    evidence.trend={scope:'confirmed host descendants only; excludes XPC',firstHours:[3,4],lastHours:[23,24],firstMedianMiB:first,lastMedianMiB:last,deltaMiB:first===null||last===null?null:last-first,maximumGrowthMiB:limit,firstSamples:evidence.firstStableRss.count,lastSamples:evidence.lastStableRss.count}
    assert(first!==null && last!==null && last-first<=limit,'Observed descendant RSS growth gate exceeded or comparison missing')
  }
  await record(['soak-end',evidence.result()])
}
