import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { collectionResources, resourceAbortError, ResourceCleanupError } from './resource-budget'
import { summarizeDiagnostic } from '../shared/diagnostics'
import type { AgentSnapshot, MonitorUpdate, ScheduleHistory, ScheduledJob, ScheduleSnapshot, SourceHeartbeat, SourceStatus, SystemSnapshot } from '../shared/types'
import { Monitor } from './monitor'
import { createSystemPlugin } from './plugins/system'
import { createAgentsPlugin } from './plugins/agents'
import { createSchedulesPlugin } from './plugins/schedules'
import type { CollectionPluginContext, CollectionPluginDefinition } from './plugins/contracts'
import type { ScheduleCollector } from './collectors/schedules'
import { ScheduleHistoryReader } from './schedule-history'

const empty: AgentSnapshot = { collectedAt: '2026-11-02T00:00:00.000Z', agents: [], sources: [], activeSubagentCount: 0 }
const scheduleSource = (collect: () => Promise<ScheduleSnapshot>) => ({ collect,
  supports: () => false, retry: async (): Promise<ScheduleSnapshot> => { throw new Error('Unsupported test source') }, dispose: () => {} })
const schedulesPlugin = (collector: Pick<ScheduleCollector, 'collect' | 'retry' | 'supports' | 'dispose'>) =>
  createSchedulesPlugin({ uid: 501, createCollector: () => collector })

const systemSnapshot: SystemSnapshot = {
  collectedAt: empty.collectedAt, hostname: 'test', platform: 'darwin', osVersion: 'test',
  cpuModel: 'test', cpuCores: 4, uptimeSeconds: 1, cpuPercent: null,
  memoryTotal: 1024, memoryUsed: 512, memoryAvailable: 512, memoryApp: 256, memoryWired: 128,
  memoryCompressed: 128, swapUsed: 0, diskTotal: null, diskUsed: null, diskAvailable: null,
  rxBytesPerSecond: null, txBytesPerSecond: null, networkInterface: null,
  processes: [], memoryProcesses: [], history: [], sources: [],
}

test('automatic discovery emits only changed sections, retains other references, and never toggles loading', async () => {
  let snapshot = empty
  const schedules: ScheduleSnapshot = { collectedAt: empty.collectedAt, jobs: [], sources: [] }
  const monitor = new Monitor({ plugins: [createAgentsPlugin({ discover: async () => ({ snapshot, sessions: [] }) }), schedulesPlugin(scheduleSource(async () => schedules))] })
  const updates: MonitorUpdate[] = []
  monitor.on('change', (update: MonitorUpdate) => updates.push(update))
  await monitor.refresh('schedules', false)
  const scheduleState = monitor.state.schedules
  const systemState = monitor.state.system
  await monitor.refresh('agents', false)
  assert.deepEqual(updates.map(update => update.section), ['schedules', 'agents'])
  assert.equal(updates.every(update => !update.state.refreshing), true)
  snapshot = { ...empty, collectedAt: '2026-11-02T00:00:02.000Z' }
  await monitor.refresh('agents', false)
  assert.equal(updates.length, 2, 'timestamp alone must not trigger an IPC redraw')
  assert.equal(monitor.state.agents.data?.collectedAt, snapshot.collectedAt)
  assert.equal(monitor.state.schedules, scheduleState)
  assert.equal(monitor.state.system, systemState)
  snapshot = { ...snapshot, sources: [{ id: 'ownership', label: 'Ownership', state: 'error', detail: 'lsof unavailable' }] }
  await monitor.refresh('agents', false)
  assert.deepEqual(updates.map(update => update.section), ['schedules', 'agents', 'agents'])
  assert.deepEqual(Object.keys(updates.at(-1)!).sort(), ['section', 'state'])
  await monitor.stop()
})

test('discovery failures remain visible and a later successful reconciliation clears the error', async () => {
  let fail = true
  const monitor = new Monitor({ plugins: [createAgentsPlugin({ discover: async () => {
    if (fail) throw new Error('process source unavailable')
    return { snapshot: empty, sessions: [] }
  } })] })
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.error, 'process source unavailable')
  fail = false
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.error, null)
  assert.ok(monitor.state.agents.data)
  await monitor.stop()
})

test('stop prevents late section publication from a collector already in flight', async () => {
  let finish!: (value: ScheduleSnapshot) => void
  const collecting = new Promise<ScheduleSnapshot>(resolve => { finish = resolve })
  const monitor = new Monitor({ plugins: [schedulesPlugin(scheduleSource(() => collecting))] })
  const updates: MonitorUpdate[] = []
  monitor.on('change', (update: MonitorUpdate) => updates.push(update))
  const work = monitor.refresh('schedules')
  const beforeStop = updates.length
  const stopping = monitor.stop()
  finish({ collectedAt: empty.collectedAt, jobs: [], sources: [] })
  await Promise.all([work, stopping])
  await monitor.refresh('agents')
  assert.equal(updates.length, beforeStop)
  assert.equal(monitor.state.schedules.data, null)
})

test('同来源重试合并，在整轮采集之后排队，期间不启动另一轮全量采集', async () => {
  const collection = Promise.withResolvers<ScheduleSnapshot>()
  const retry = Promise.withResolvers<ScheduleSnapshot>()
  let collecting = 0, retrying = 0
  const snapshot: ScheduleSnapshot = { collectedAt: 'initial', jobs: [], sources: [] }
  const updated: ScheduleSnapshot = { ...snapshot, collectedAt: 'retry' }
  const collector = {
    dispose: () => {},
    collect: () => { collecting++; return collection.promise },
    supports: (sourceId: string) => sourceId === 'launchctl:system',
    retry: async () => { retrying++; return retry.promise }
  }
  const monitor = new Monitor({ plugins: [schedulesPlugin(collector)] })
  const systemState = monitor.state.system
  const full = monitor.refresh('schedules')
  const first = monitor.retrySource('launchctl:system')
  assert.equal(monitor.retrySource('launchctl:system'), first)
  assert.equal(retrying, 0)
  collection.resolve(snapshot)
  await full
  await setImmediate()
  const refreshDuringRetry = monitor.refresh('schedules')
  assert.equal(collecting, 1)
  assert.equal(retrying, 1)
  assert.equal(monitor.state.schedules.refreshing, true)
  retry.resolve(updated)
  await Promise.all([first, refreshDuringRetry])
  assert.equal(monitor.state.schedules.refreshing, false)
  assert.equal(monitor.state.system, systemState)
  await monitor.stop()
})

test('单来源恢复不会清除未恢复的配置错误，完整采集成功才清除', async () => {
  const snapshot: ScheduleSnapshot = { collectedAt: 'initial', jobs: [], sources: [] }
  let failure = false
  const monitor = new Monitor({ plugins: [schedulesPlugin({
    dispose: () => {},
    collect: async () => { if (failure) throw new Error('configuration unreadable'); return snapshot },
    supports: sourceId => sourceId === 'launchctl:system',
    retry: async () => ({ ...snapshot, collectedAt: 'retry' })
  })] })
  await monitor.refresh('schedules')
  failure = true
  await monitor.refresh('schedules')
  await monitor.retrySource('launchctl:system')
  assert.equal(monitor.state.schedules.error, 'configuration unreadable')
  failure = false
  await monitor.refresh('schedules')
  assert.equal(monitor.state.schedules.error, null)
  await monitor.stop()
})

test('未知来源不执行采集，已排队的健康域不被前一域失败取消', async () => {
  const snapshot: ScheduleSnapshot = { collectedAt: 'initial', jobs: [], sources: [] }
  const calls: string[] = []
  const rejected = Promise.withResolvers<ScheduleSnapshot>()
  const monitor = new Monitor({ plugins: [schedulesPlugin({
    dispose: () => {},
    collect: async () => snapshot,
    supports: sourceId => ['launchctl:system', 'launchctl:user/501'].includes(sourceId),
    retry: async sourceId => {
      calls.push(sourceId)
      if (sourceId === 'launchctl:system') return rejected.promise
      return { ...snapshot, collectedAt: sourceId }
    }
  })] })
  await assert.rejects(monitor.retrySource('launchctl:other'), /不支持/)
  assert.deepEqual(calls, [])
  await monitor.refresh('schedules')
  const first = monitor.retrySource('launchctl:system')
  const firstFailure = assert.rejects(first, /retry failed/)
  const second = monitor.retrySource('launchctl:user/501')
  await setImmediate()
  rejected.reject(new Error('retry failed'))
  await Promise.all([firstFailure, second])
  assert.deepEqual(calls, ['launchctl:system', 'launchctl:user/501'])
  assert.equal(monitor.state.schedules.data?.collectedAt, 'launchctl:user/501')
  assert.equal(monitor.state.schedules.error, null)
  await monitor.stop()
})

test('system collector receives cancellation and is disposed exactly once without publishing late results', async () => {
  const pending = Promise.withResolvers<SystemSnapshot>()
  let signal: AbortSignal | undefined, collects = 0, disposals = 0
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: currentSignal => { signal = currentSignal; collects++; return pending.promise },
    dispose: () => { disposals++ },
  }))] })
  const updates: MonitorUpdate[] = []
  monitor.on('change', (update: MonitorUpdate) => updates.push(update))
  const work = monitor.refresh('system')
  const overlapping = monitor.refresh('system')
  await setImmediate()
  assert.equal(collects, 1)
  const beforeStop = updates.length
  const stopping = monitor.stop()
  assert.equal(monitor.stop(), stopping)
  const stopped = assert.rejects(stopping, (error: unknown) => error instanceof AggregateError && summarizeDiagnostic(error, 'shutdown').details.includes('resource=system'))
  assert.equal(signal?.aborted, true)
  pending.reject(new Error('late cancelled IO'))
  await Promise.all([work, overlapping, stopped])
  assert.equal(disposals, 1)
  await monitor.refresh('system')
  assert.equal(collects, 1)
  assert.equal(updates.length, beforeStop)
  assert.equal(monitor.state.system.data, null)
})

test('system section publishes an unknown first CPU sample and then the numeric continuous sample', async () => {
  let cpuPercent: number | null = null
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({ collect: async () => ({ ...systemSnapshot, cpuPercent }), dispose: () => {} }))] })
  try {
    await monitor.refresh('system')
    assert.equal(monitor.state.system.data?.cpuPercent, null)
    assert.equal(monitor.state.system.error, null)
    cpuPercent = 25
    await monitor.refresh('system')
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
  } finally { await monitor.stop() }
})

test('100 stop cycles wait for owned resource release and detach the external signal', async () => {
  for (let cycle = 0; cycle < 100; cycle++) {
    const parent = new AbortController()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const monitor = new Monitor({ signal: parent.signal, plugins: [createSystemPlugin(() => ({
      collect: signal => collectionResources.run({ source: 'monitor-stop-cycle', kind: 'file', bytes: 1, signal }, async () => {
        entered.resolve()
        await release.promise
        throw resourceAbortError()
      }), dispose: () => {}
    }))] })
    const work = monitor.refresh('system')
    await entered.promise
    if (cycle % 2) parent.abort()
    const stop = monitor.stop()
    assert.equal(stop, monitor.stop())
    let stopped = false
    const observed = stop.then(() => { stopped = true })
    await setImmediate()
    assert.equal(stopped, false)
    assert.equal(collectionResources.snapshot().global.current.files, 1)
    release.resolve()
    await Promise.all([work, observed])
    assert.equal(collectionResources.snapshot().global.current.files, 0)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    assert.deepEqual(monitor.diagnostics().pendingSections, [])
    assert.equal(monitor.listenerCount('change'), 0)
  }
})

test('stop rejects a queued source retry before it starts and waits for its preceding collection', async () => {
  const gate = Promise.withResolvers<ScheduleSnapshot>()
  let retries = 0
  const monitor = new Monitor({ plugins: [schedulesPlugin({
    collect: () => gate.promise, supports: () => true,
    retry: async () => { retries++; return { collectedAt: 'late', jobs: [], sources: [] } }, dispose: () => {}
  })] })
  const work = monitor.refresh('schedules')
  const retry = assert.rejects(monitor.retrySource('launchctl:system'), { name: 'AbortError' })
  await setImmediate()
  const stop = monitor.stop()
  gate.resolve({ collectedAt: 'late', jobs: [], sources: [] })
  await Promise.all([work, retry, stop])
  assert.equal(retries, 0)
  assert.equal(monitor.diagnostics().queuedRetries, 0)
  assert.equal(monitor.state.schedules.data, null)
})

test('a synchronous disposal failure does not prevent other cancellation and retains resource identity', async () => {
  const gate = Promise.withResolvers<SystemSnapshot>()
  let signal: AbortSignal | undefined, schedulesDisposed = false
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: value => { signal = value; return gate.promise },
    dispose: () => { throw Object.assign(new Error('private-path'), { code: 'EIO' }) }
  })), schedulesPlugin({ ...scheduleSource(async () => ({ collectedAt: '', jobs: [], sources: [] })), dispose: () => { schedulesDisposed = true } })] })
  await monitor.refresh('schedules')
  const work = monitor.refresh('system')
  await setImmediate()
  const stop = monitor.stop()
  const rejected = assert.rejects(stop, error => {
    const details = summarizeDiagnostic(error, 'shutdown').details
    return details.includes('resource=system') && details.includes('EIO') && !details.includes('private-path')
  })
  assert.equal(signal?.aborted, true)
  gate.reject(resourceAbortError())
  await Promise.all([work, rejected])
  assert.equal(schedulesDisposed, true)
})

test('a cleanup failure already shown in a section remains a shutdown failure', async () => {
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: async () => { throw new ResourceCleanupError('file', Object.assign(new Error(), { code: 'EIO' })) }, dispose: () => {}
  }))] })
  await monitor.refresh('system')
  assert.notEqual(monitor.state.system.error, null)
  await assert.rejects(monitor.setPluginEnabled('system', false), error => summarizeDiagnostic(error, 'shutdown').details.includes('OC_RESOURCE_CLOSE'))
  assert.equal(monitor.pluginStatuses()[0].phase, 'failed')
  assert.notEqual(monitor.state.system.error, null)
  await assert.rejects(monitor.stop(), error => summarizeDiagnostic(error, 'shutdown').details.includes('OC_RESOURCE_CLOSE'))
})

test('unchanged collection advances bounded source heartbeats without resending entities or inventing success', async t => {
  let collectedAt = '2026-11-05T01:00:00.000Z', failing = false
  const source = (): SourceStatus => ({ id: 'launchctl:system', label: 'System', state: failing ? 'error' : 'ok', detail: failing ? 'read failed' : 'one service',
    diagnostics: failing ? [{ sourceId: 'launchctl:system', operation: 'services', stage: 'permission', code: 'permission-denied', retryable: true, observedAt: collectedAt }] : [] })
  const monitor = new Monitor({ plugins: [schedulesPlugin(scheduleSource(async () => ({ collectedAt, jobs: [], sources: [source()] })))] })
  t.after(() => monitor.stop())
  const updates: MonitorUpdate[] = [], heartbeats: SourceHeartbeat[] = []
  monitor.on('change', update => updates.push(update))
  monitor.on('sources', heartbeat => heartbeats.push(heartbeat))
  await monitor.refresh('schedules', false)
  collectedAt = '2026-11-05T01:00:30.000Z'
  await monitor.refresh('schedules', false)
  assert.equal(updates.length, 1)
  assert.equal(heartbeats.at(-1)?.sources[0].lastSuccessAt, collectedAt)
  assert.equal('jobs' in heartbeats.at(-1)!, false)
  failing = true
  collectedAt = '2026-11-05T01:01:00.000Z'
  await monitor.refresh('schedules', false)
  assert.equal(updates.length, 2)
  collectedAt = '2026-11-05T01:01:30.000Z'
  await monitor.refresh('schedules', false)
  assert.equal(updates.length, 2, 'a repeated identical diagnostic sends freshness only')
  assert.equal(heartbeats.at(-1)?.sources[0].lastAttemptAt, collectedAt)
  assert.equal(heartbeats.at(-1)?.sources[0].lastSuccessAt, '2026-11-05T01:00:30.000Z')
  assert.equal(monitor.state.schedules.data?.sources[0].state, 'error')
})

test('a domain retry does not advance configuration or other domains that were not read', async t => {
  const first = '2026-11-05T02:00:00.000Z', next = '2026-11-05T02:00:01.000Z'
  const sources: SourceStatus[] = [
    { id: 'launchctl:system', label: 'System', state: 'ok', detail: 'one service', lastAttemptAt: first, lastSuccessAt: first },
    { id: 'launchctl:user/501', label: 'User', state: 'ok', detail: 'one service', lastAttemptAt: first, lastSuccessAt: first },
    { id: 'hermes-cron', label: 'Hermes', state: 'empty', detail: 'No jobs' }
  ]
  const monitor = new Monitor({ plugins: [schedulesPlugin({
    dispose() {}, supports: id => id === 'launchctl:system',
    collect: async () => ({ collectedAt: first, jobs: [], sources }),
    retry: async () => ({ collectedAt: next, jobs: [], sources: sources.map(source => source.id === 'launchctl:system' ? { ...source, lastAttemptAt: next, lastSuccessAt: next } : source) })
  })] })
  t.after(() => monitor.stop())
  await monitor.refresh('schedules', false)
  const before = monitor.state.schedules.data!.sources
  await monitor.retrySource('launchctl:system')
  const after = monitor.state.schedules.data!.sources
  assert.equal(after[0].lastSuccessAt, next)
  assert.deepEqual(after.slice(1), before.slice(1))
  assert.equal(monitor.state.schedules.lastSuccessAt, first, 'a partial retry is not a full-section success')
})

test('section retries coalesce known failed sources, preserve other sections, and reject unsupported or absent routes', async t => {
  const gate = Promise.withResolvers<void>()
  let attempts = 0
  const monitor = new Monitor({ plugins: [createAgentsPlugin({ discover: async () => {
    attempts++
    if (attempts > 1) await gate.promise
    return { snapshot: { ...empty, collectedAt: `2026-11-05T03:00:0${attempts}.000Z`, sources: [
      { id: 'tern-state', label: 'Tern', state: attempts === 1 ? 'error' as const : 'empty' as const, detail: attempts === 1 ? 'inspect failed' : 'no host' },
      { id: 'unsupported', label: 'Unavailable', state: 'unsupported' as const, detail: 'No interface' },
      { id: 'disabled', label: 'Disabled', state: 'disabled' as const, detail: 'Disabled by user' }
    ] }, sessions: [] }
  } })] })
  t.after(() => monitor.stop())
  await monitor.refresh('agents', false)
  const schedules = monitor.state.schedules, system = monitor.state.system
  assert.equal(monitor.state.agents.data?.sources.find(source => source.id === 'disabled')?.lastAttemptAt, undefined)
  const retry = monitor.retrySource('tern-state')
  assert.equal(monitor.retrySource('tern-state'), retry)
  await assert.rejects(monitor.retrySource('unsupported'))
  await assert.rejects(monitor.retrySource('disabled'))
  await assert.rejects(monitor.retrySource('missing'))
  gate.resolve()
  await retry
  assert.equal(attempts, 2)
  assert.equal(monitor.state.agents.data?.sources.find(source => source.id === 'tern-state')?.state, 'empty')
  assert.equal(monitor.state.schedules, schedules)
  assert.equal(monitor.state.system, system)
  await monitor.stop()
  await assert.rejects(monitor.retrySource('tern-state'), { name: 'AbortError' })
})

test('monitor has no implicit collectors, accepts explicit section plugins, and rejects duplicate ownership', async () => {
  const monitor = new Monitor()
  await monitor.refresh()
  assert.deepEqual(monitor.pluginStatuses(), [])
  assert.equal(monitor.state.agents.data, null)
  assert.equal(monitor.state.schedules.data, null)
  assert.equal(monitor.state.system.data, null)
  monitor.cancelScheduleHistory()
  await assert.rejects(monitor.readScheduleHistory('missing'), /not registered/)
  await monitor.stop()
  const system = createSystemPlugin()
  assert.throws(() => new Monitor({ plugins: [system, { ...system, id: 'duplicate-system' }] }), /Duplicate collection section/)
  const agents = createAgentsPlugin({ discover: async () => ({ snapshot: empty, sessions: [] }) })
  const schedules = schedulesPlugin(scheduleSource(async () => ({ collectedAt: '', jobs: [], sources: [] })))
  const explicit = new Monitor({ plugins: [agents, schedules] })
  await explicit.refresh()
  assert.equal(explicit.pluginStatuses().length, 2)
  assert.ok(explicit.state.agents.data)
  assert.ok(explicit.state.schedules.data)
  await explicit.stop()
})

test('disabled plugins retain measurements and timestamps and skip both manual and automatic collection', async t => {
  let factories = 0, collects = 0, disposals = 0
  const monitor = new Monitor({
    plugins: [createSystemPlugin(() => {
      factories++
      return {
        collect: async () => { collects++; return { ...systemSnapshot, cpuPercent: 37,
          sources: [{ id: 'cpu', label: 'CPU', state: 'ok', detail: 'Measured' }] } },
        dispose: () => { disposals++ }
      }
    })]
  })
  t.after(() => monitor.stop())
  assert.equal(factories, 0)
  await monitor.setPluginEnabled('system', false)
  monitor.start()
  await setImmediate()
  assert.equal(factories, 0, 'starting a disabled plugin must not instantiate its collector')
  await monitor.setPluginEnabled('system', true)
  await monitor.refresh('system')
  const before = monitor.state.system
  const firstDisable = monitor.setPluginEnabled('system', false)
  assert.equal(monitor.setPluginEnabled('system', false), firstDisable)
  await firstDisable
  const disabled = monitor.state.system
  const count = collects
  await monitor.refresh('system')
  await monitor.refresh()
  assert.equal(collects, count)
  assert.equal(disposals, 1)
  assert.equal(monitor.diagnostics().plugins.timers, 0)
  assert.equal(monitor.state.system, disabled)
  assert.equal(disabled.data?.cpuPercent, 37)
  assert.equal(disabled.data?.collectedAt, before.data?.collectedAt)
  assert.equal(disabled.lastAttemptAt, before.lastAttemptAt)
  assert.equal(disabled.lastSuccessAt, before.lastSuccessAt)
  assert.equal(disabled.data?.sources[0].lastSuccessAt, before.data?.sources[0].lastSuccessAt)
  assert.equal(disabled.data?.sources[0].state, 'disabled')
  assert.equal(disabled.refreshing, false)
})

test('repeated system enable cycles create fresh collectors and reset sampling baselines', async t => {
  let factories = 0, disposals = 0
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => {
    factories++
    let sampled = false
    return {
      collect: async () => {
        const snapshot = { ...systemSnapshot, cpuPercent: sampled ? 25 : null, rxBytesPerSecond: sampled ? 128 : null }
        sampled = true
        return snapshot
      },
      dispose: () => { disposals++ }
    }
  })] })
  t.after(() => monitor.stop())
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) {
      const enabling = monitor.setPluginEnabled('system', true)
      assert.equal(monitor.setPluginEnabled('system', true), enabling)
      await enabling
    }
    if (!cycle) await monitor.refresh('system')
    assert.equal(monitor.state.system.data?.cpuPercent, null)
    assert.equal(monitor.state.system.data?.rxBytesPerSecond, null)
    await monitor.refresh('system')
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
    await monitor.setPluginEnabled('system', false)
    await monitor.setPluginEnabled('system', false)
    assert.equal(factories, cycle + 1)
    assert.equal(disposals, cycle + 1)
  }
})

test('one plugin failure stays visible while independent plugins continue and later success clears it', async t => {
  let failing = true
  const monitor = new Monitor({
    plugins: [createAgentsPlugin({ discover: async () => ({ snapshot: empty, sessions: [] }) }),
      schedulesPlugin(scheduleSource(async () => ({ collectedAt: empty.collectedAt, jobs: [], sources: [] }))),
      createSystemPlugin(() => ({ collect: async () => {
        if (failing) throw new Error('system unavailable')
        return systemSnapshot
      }, dispose() {} }))]
  })
  t.after(() => monitor.stop())
  await monitor.refresh()
  assert.equal(monitor.state.system.error, 'system unavailable')
  assert.equal(monitor.state.system.refreshing, false)
  assert.ok(monitor.state.agents.data)
  assert.ok(monitor.state.schedules.data)
  failing = false
  await monitor.refresh('system')
  assert.equal(monitor.state.system.error, null)
  assert.equal(monitor.state.system.data?.collectedAt, systemSnapshot.collectedAt)
})

test('plugin snapshots preserve source heartbeat semantics for unchanged automatic samples', async t => {
  let collectedAt = '2026-11-05T04:00:00.000Z'
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: async () => ({ ...systemSnapshot, collectedAt, sources: [{ id: 'cpu', label: 'CPU', state: 'ok', detail: 'Measured' }] }),
    dispose() {}
  }))] })
  t.after(() => monitor.stop())
  const updates: MonitorUpdate[] = [], heartbeats: SourceHeartbeat[] = []
  monitor.on('change', update => updates.push(update))
  monitor.on('sources', heartbeat => heartbeats.push(heartbeat))
  await monitor.refresh('system', false)
  collectedAt = '2026-11-05T04:00:03.000Z'
  await monitor.refresh('system', false)
  assert.equal(updates.length, 1)
  assert.equal(heartbeats.at(-1)?.sources[0].lastSuccessAt, collectedAt)
  assert.equal(monitor.state.system.lastSuccessAt, collectedAt)
})

test('disable waits for real collection settlement, blocks opposite transitions, and rejects late publication', async t => {
  const gate = Promise.withResolvers<SystemSnapshot>()
  let calls = 0, signal: AbortSignal | undefined, disposals = 0
  const definition = createSystemPlugin(() => ({
    collect: async current => {
      signal = current
      return ++calls === 1 ? { ...systemSnapshot, sources: [{ id: 'cpu', label: 'CPU', state: 'ok', detail: 'Measured' }] } : gate.promise
    },
    dispose: () => { disposals++ }
  }))
  const monitor = new Monitor({ plugins: [definition] })
  t.after(() => monitor.stop())
  await monitor.refresh('system')
  const before = monitor.state.system.data
  const work = monitor.refresh('system')
  await setImmediate()
  const disabling = monitor.setPluginEnabled('system', false)
  assert.equal(monitor.setPluginEnabled('system', false), disabling)
  assert.equal(signal?.aborted, true)
  assert.equal(monitor.state.system.refreshing, false)
  let finished = false
  const drained = disabling.then(() => { finished = true })
  await assert.rejects(monitor.setPluginEnabled('system', true))
  assert.match(monitor.state.system.error ?? '', /opposing lifecycle transition/)
  await setImmediate()
  assert.equal(finished, false)
  assert.equal(monitor.diagnostics().plugins.pending > 0, true)
  gate.resolve({ ...systemSnapshot, collectedAt: 'late', cpuPercent: 99 })
  await Promise.all([work, drained])
  assert.equal(disposals, 1)
  assert.equal(monitor.state.system.data?.collectedAt, before?.collectedAt)
  assert.equal(monitor.state.system.data?.cpuPercent, before?.cpuPercent)
  assert.equal(monitor.state.system.data?.sources[0].state, 'disabled')
  assert.equal(monitor.state.system.error, null)
  assert.equal(monitor.pluginStatuses()[0].phase, 'disabled')
})

test('successful disable clears a previous collection error while retaining measurements and timestamps', async t => {
  let failing = false
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: async () => {
      if (failing) throw new Error('system sample failed')
      return { ...systemSnapshot, cpuPercent: 37, sources: [{ id: 'cpu', label: 'CPU', state: 'ok', detail: 'Measured' }] }
    }, dispose() {}
  }))] })
  t.after(() => monitor.stop())
  await monitor.refresh('system')
  failing = true
  await monitor.refresh('system')
  assert.equal(monitor.state.system.error, 'system sample failed')
  const before = monitor.state.system
  await monitor.setPluginEnabled('system', false)
  const disabled = monitor.state.system
  assert.equal(monitor.pluginStatuses()[0].phase, 'disabled')
  assert.equal(disabled.error, null)
  assert.equal(disabled.refreshing, false)
  assert.equal(disabled.data?.cpuPercent, 37)
  assert.equal(disabled.data?.collectedAt, before.data?.collectedAt)
  assert.equal(disabled.lastAttemptAt, before.lastAttemptAt)
  assert.equal(disabled.lastSuccessAt, before.lastSuccessAt)
  assert.equal(disabled.data?.sources[0].lastAttemptAt, before.data?.sources[0].lastAttemptAt)
  assert.equal(disabled.data?.sources[0].lastSuccessAt, before.data?.sources[0].lastSuccessAt)
  assert.equal(disabled.data?.sources[0].state, 'disabled')
})

test('failed disposal remains visible after disabling and retains system identity through monitor shutdown', async () => {
  const monitor = new Monitor({ plugins: [createSystemPlugin(() => ({
    collect: async () => ({ ...systemSnapshot, sources: [{ id: 'cpu', label: 'CPU', state: 'ok', detail: 'Measured' }] }),
    dispose: () => { throw Object.assign(new Error('system disposal failed'), { code: 'EIO' }) }
  }))] })
  await monitor.refresh('system')
  const before = monitor.state.system
  await assert.rejects(monitor.setPluginEnabled('system', false), /system disposal failed/)
  assert.equal(monitor.pluginStatuses()[0].phase, 'failed')
  assert.equal(monitor.state.system.error, 'system disposal failed')
  assert.equal(monitor.state.system.refreshing, false)
  assert.equal(monitor.state.system.data?.collectedAt, before.data?.collectedAt)
  assert.equal(monitor.state.system.lastAttemptAt, before.lastAttemptAt)
  assert.equal(monitor.state.system.lastSuccessAt, before.lastSuccessAt)
  assert.equal(monitor.state.system.data?.sources[0].state, 'disabled')
  await assert.rejects(monitor.stop(), error => {
    const details = summarizeDiagnostic(error, 'shutdown').details
    return details.includes('resource=system') && details.includes('EIO')
  })
})

test('incremental agent activity retains discovery errors and observation times until full reconciliation succeeds', async t => {
  const initial = '2026-11-05T05:00:00.000Z', changed = '2026-11-05T05:00:01.000Z'
  let context: CollectionPluginContext<'agents'> | undefined, failing = false
  let data: AgentSnapshot = { ...empty, collectedAt: initial,
    sources: [{ id: 'processes', label: 'Processes', state: 'ok', detail: 'Measured' }] }
  const plugin: CollectionPluginDefinition<'agents'> = {
    id: 'agents', section: 'agents', capabilities: [], intervalMs: 1000, timeoutMs: 1000,
    create: current => {
      context = current
      return { collect: async () => {
        if (failing) throw new Error('discovery unavailable')
        current.publish(data, true)
        return data
      }, stop() {} }
    }
  }
  const monitor = new Monitor({ plugins: [plugin] })
  t.after(() => monitor.stop())
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.lastSuccessAt, initial, 'a full result following an incremental snapshot with the same timestamp is still a sample')
  assert.equal(monitor.state.agents.data?.sources[0].lastSuccessAt, initial)
  failing = true
  await monitor.refresh('agents', false)
  const failed = monitor.state.agents
  data = { ...data, collectedAt: changed, activeSubagentCount: 1 }
  context!.publish(data, true)
  assert.equal(monitor.state.agents.data?.activeSubagentCount, 1)
  assert.equal(monitor.state.agents.error, 'discovery unavailable')
  assert.equal(monitor.state.agents.lastAttemptAt, failed.lastAttemptAt)
  assert.equal(monitor.state.agents.lastSuccessAt, initial)
  assert.equal(monitor.state.agents.data?.sources[0].lastAttemptAt, initial)
  assert.equal(monitor.state.agents.data?.sources[0].lastSuccessAt, initial)
  failing = false
  await monitor.refresh('agents', false)
  assert.equal(monitor.state.agents.error, null)
  assert.equal(monitor.state.agents.lastSuccessAt, changed)
  assert.equal(monitor.state.agents.data?.sources[0].lastSuccessAt, changed)
})

test('a source retry records its attempt without advancing unrelated domains or full-section success', async t => {
  const first = '2026-11-05T06:00:00.000Z', retryAt = '2026-11-05T06:00:01.000Z'
  const sources: SourceStatus[] = [
    { id: 'launchctl:system', label: 'System', state: 'ok', detail: 'Measured' },
    { id: 'launchctl:user/501', label: 'User', state: 'ok', detail: 'Measured' },
    { id: 'hermes-cron', label: 'Hermes', state: 'empty', detail: 'No jobs' }
  ]
  const monitor = new Monitor({ plugins: [schedulesPlugin({
    collect: async () => ({ collectedAt: first, jobs: [], sources }),
    retry: async () => ({ collectedAt: retryAt, jobs: [], sources }), supports: () => true, dispose() {}
  })] })
  t.after(() => monitor.stop())
  await monitor.refresh('schedules', false)
  const retry = monitor.retrySource('launchctl:system')
  const attempt = monitor.state.schedules.lastAttemptAt
  await retry
  assert.equal(monitor.state.schedules.data?.sources[0].lastAttemptAt, retryAt)
  assert.equal(monitor.state.schedules.data?.sources[0].lastSuccessAt, retryAt)
  assert.equal(monitor.state.schedules.data?.sources[1].lastSuccessAt, first)
  assert.equal(monitor.state.schedules.data?.sources[2].lastSuccessAt, first)
  assert.equal(monitor.state.schedules.lastAttemptAt, attempt)
  assert.equal(monitor.state.schedules.lastSuccessAt, first)
})

const scheduledJob: ScheduledJob = { id: 'hermes:cron:job', name: 'Job', source: 'Hermes', scope: 'user', origin: 'personal', kind: 'calendar', schedule: '* * * * *', state: 'waiting' }
const executionHistory: ScheduleHistory = { jobId: scheduledJob.id, source: 'hermes', entries: [], offset: 0, limit: 50, hasMore: false, collectedAt: empty.collectedAt }

test('schedule history uses the public plugin capability and stays uninitialized while disabled', async t => {
  let collectors = 0, readers = 0, reads = 0
  const monitor = new Monitor({ plugins: [createSchedulesPlugin({
    createCollector: () => { collectors++; return scheduleSource(async () => ({ collectedAt: empty.collectedAt, jobs: [scheduledJob], sources: [] })) },
    createHistory: () => { readers++; return new ScheduleHistoryReader({ providers: [{ supports: () => true,
      read: async (job, offset) => { reads++; return { ...executionHistory, jobId: job.id, offset } }
    }] }) }
  })] })
  t.after(() => monitor.stop())
  monitor.cancelScheduleHistory()
  assert.equal(collectors, 0)
  assert.equal(readers, 0)
  await monitor.setPluginEnabled('schedules', false)
  monitor.start()
  await monitor.refresh()
  await assert.rejects(monitor.readScheduleHistory(scheduledJob.id))
  assert.equal(collectors, 0)
  assert.equal(readers, 0)
  await monitor.setPluginEnabled('schedules', true)
  assert.equal(collectors, 1)
  const history = await monitor.readScheduleHistory(scheduledJob.id, 50)
  assert.equal(history.offset, 50)
  assert.equal(history.jobId, scheduledJob.id)
  await assert.rejects(monitor.readScheduleHistory('unknown'), /Unknown scheduled job/)
  assert.equal(reads, 1)
  await monitor.setPluginEnabled('schedules', false)
  await assert.rejects(monitor.readScheduleHistory(scheduledJob.id), /disabled/)
  assert.equal(reads, 1)
})

test('disabling schedule collection cancels history, waits for actual resources, and reads from a fresh generation', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let readers = 0, signal: AbortSignal | undefined, disabled = false
  const monitor = new Monitor({ plugins: [createSchedulesPlugin({
    createCollector: () => scheduleSource(async () => ({ collectedAt: empty.collectedAt, jobs: [scheduledJob], sources: [] })),
    createHistory: () => {
      const generation = ++readers
      return new ScheduleHistoryReader({ providers: [{ supports: () => true,
        read: async (_job, offset, current) => {
          if (generation === 1) return collectionResources.run({ source: 'monitor-history-drain', kind: 'file', bytes: 1, signal: current }, async () => {
            signal = current
            entered.resolve()
            await release.promise
            return executionHistory
          })
          return { ...executionHistory, offset, collectedAt: 'fresh-generation' }
        }
      }] })
    }
  })] })
  t.after(() => monitor.stop())
  await monitor.refresh('schedules')
  const history = assert.rejects(monitor.readScheduleHistory(scheduledJob.id), { name: 'AbortError' })
  await entered.promise
  const stopping = monitor.setPluginEnabled('schedules', false).then(() => { disabled = true })
  assert.equal(signal?.aborted, true)
  await history
  await setImmediate()
  assert.equal(disabled, false)
  assert.equal(collectionResources.snapshot().global.current.files, 1)
  release.resolve()
  await stopping
  assert.equal(collectionResources.snapshot().global.current.files, 0)
  await monitor.setPluginEnabled('schedules', true)
  const fresh = await monitor.readScheduleHistory(scheduledJob.id, 50)
  assert.equal(fresh.collectedAt, 'fresh-generation')
  assert.equal(fresh.offset, 50)
  assert.equal(readers, 2)
})

test('explicit history cancellation rejects old results without disabling future schedule reads', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let reads = 0
  const monitor = new Monitor({ plugins: [createSchedulesPlugin({
    createCollector: () => scheduleSource(async () => ({ collectedAt: empty.collectedAt, jobs: [scheduledJob], sources: [] })),
    createHistory: () => new ScheduleHistoryReader({ providers: [{ supports: () => true, read: async (_job, offset) => {
      if (++reads === 1) { entered.resolve(); await release.promise }
      return { ...executionHistory, offset }
    } }] })
  })] })
  t.after(() => monitor.stop())
  await monitor.refresh('schedules')
  const old = assert.rejects(monitor.readScheduleHistory(scheduledJob.id), { name: 'AbortError' })
  await entered.promise
  monitor.cancelScheduleHistory()
  await old
  const next = monitor.readScheduleHistory(scheduledJob.id, 50)
  release.resolve()
  assert.equal((await next).offset, 50)
  assert.equal(monitor.pluginStatuses()[0].enabled, true)
})
