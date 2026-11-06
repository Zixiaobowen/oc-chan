import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIAGNOSTIC_REPORT_MAX_BYTES, DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS,
  DIAGNOSTIC_REPORT_MAX_RESOURCES, DIAGNOSTIC_REPORT_MAX_SOURCES,
} from '../shared/diagnostic-report'
import type { ResourceBudgetSnapshot, ResourceStatistics } from '../shared/resources'
import type { MonitorSnapshot, SourceDiagnostic, SourceStatus } from '../shared/types'
import { buildDiagnosticReport } from './diagnostic-report'

const now = '2026-11-05T01:02:03.004Z'
const metadata = { version: '0.1.0', electron: '45.2.1', platform: 'darwin', arch: 'arm64', osRelease: '27.2.0' }
const secret = 'PRIVATE_USER_TOKEN_9f27'
function statistics(): ResourceStatistics {
  return {
    current: { commands: 1, files: 2, sockets: 0, stdoutBytes: 8, stderrBytes: 4, commandBytes: 12, fileBytes: 16, socketBytes: 0, queued: 0 },
    peak: { commands: 2, files: 3, sockets: 1, stdoutBytes: 16, stderrBytes: 8, commandBytes: 24, fileBytes: 32, socketBytes: 8, queued: 1 },
    admitted: 8, completed: 6, failed: 1, cancelled: 0, rejected: 2, queueTimeouts: 1,
    totalWaitMs: 2.5, maxWaitMs: 1.5, totalExecutionMs: 20, maxExecutionMs: 10,
  }
}
function budget(): ResourceBudgetSnapshot {
  return {
    limits: { commands: 8, files: 8, sockets: 4, commandBytes: 1024, fileBytes: 1024, socketBytes: 1024,
      queued: 32, queuedPerSource: 8, sources: 32, queueTimeoutMs: 1000 },
    global: statistics(), sources: [{ source: 'agent-processes', ...statistics() }],
  }
}
function source(id = 'launchctl:gui/81234'): SourceStatus {
  return {
    id, label: secret, detail: secret, state: 'partial', lastAttemptAt: now, lastSuccessAt: now,
    diagnostics: [{ sourceId: id, operation: 'services', stage: 'permission', code: 'permission-denied',
      retryable: true, observedAt: now, exitCode: 1 }],
  }
}
function snapshot(): MonitorSnapshot {
  return {
    agents: { data: { collectedAt: now, agents: [], activeSubagentCount: null, sources: [] },
      error: null, refreshing: false, lastAttemptAt: now, lastSuccessAt: now },
    schedules: { data: { collectedAt: now, jobs: [], sources: [source()] }, error: null, refreshing: false },
    system: { data: { collectedAt: now, processes: [], memoryProcesses: [], history: [], sources: [] } as unknown as NonNullable<MonitorSnapshot['system']['data']>,
      error: null, refreshing: false },
    events: { data: { collectedAt: now, revision: 0, retention: { count: 0, newestSequence: 0, oldestObservedAt: null, deletedCount: 0, deletedThrough: null, reason: null, diskBytes: 0 }, coverage: [], sources: [] }, error: null, refreshing: false },
  }
}

test('report exports controlled evidence and totals without sensitive text, IDs or bodies', () => {
  const input = snapshot()
  input.agents.error = `${secret}: /Users/${secret}/stderr`
  input.agents.data!.agents.push({ id: secret, name: secret, summary: secret, runtime: secret,
    kind: 'main', state: 'working', pid: 81234, sessionId: secret, cwd: `/Users/${secret}`,
    model: secret, source: secret, activity: { kind: 'tool', name: secret, observedAt: secret } })
  input.schedules.data!.jobs.push({ id: secret, name: secret, source: secret, scope: 'user', origin: 'personal',
    kind: 'calendar', schedule: secret, state: 'unknown', file: `/Users/${secret}`, executable: secret })
  Object.assign(input.system.data!, { hostname: secret, cpuModel: secret, osVersion: secret, networkInterface: secret,
    platform: secret, environment: secret, command: secret, stderr: secret })
  input.schedules.data!.sources.push(source(`/Users/${secret}/Library/LaunchAgents`))
  Object.assign(input.schedules.data!.sources[0].diagnostics![0], { message: secret, stderr: secret, command: secret })
  const resources = budget()
  Object.assign(resources.global, { filename: secret, stderr: secret, environment: secret })
  const result = buildDiagnosticReport(input, resources, { ...metadata, username: secret } as typeof metadata, now)
  const report = JSON.parse(result.json)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.generatedAt, now)
  assert.deepEqual(report.metadata, metadata)
  assert.equal(report.sections.agents.hasError, true)
  assert.deepEqual(report.sections.agents.totals, { agents: 1 })
  assert.deepEqual(report.sections.schedules.totals, { jobs: 1 })
  assert.deepEqual(report.sections.system.totals, { processes: 0, memoryProcesses: 0, history: 0 })
  assert.equal(report.sections.schedules.sources[0].id, 'launchctl:gui')
  assert.equal(report.sections.schedules.sources[1].id, 'launchagents:user')
  assert.equal(report.sections.schedules.sources[0].diagnostics[0].code, 'permission-denied')
  assert.equal(report.sections.schedules.sources[0].diagnostics[0].stage, 'permission')
  assert.equal(report.sections.schedules.sources[0].diagnostics[0].exitCode, 1)
  assert.deepEqual(report.sections.schedules.sources[0].capabilities.find((item: { id: string }) => item.id === 'working'),
    { id: 'working', support: 'partial' })
  assert.deepEqual(Object.keys(report.sections.schedules.sources[0].capabilities[0]).sort(), ['id', 'support'])
  assert.deepEqual(result.coverage, { sources: { included: 2, total: 2 }, diagnostics: { included: 2, total: 2 }, resources: { included: 1, total: 1 } })
  assert.deepEqual(result.limits, [])
  assert.deepEqual(report.coverage, result.coverage)
  assert.deepEqual(report.limits, result.limits)
  assert.equal(result.bytes, Buffer.byteLength(result.json))
  assert.ok(result.bytes <= DIAGNOSTIC_REPORT_MAX_BYTES)
  for (const marker of [secret, '81234', '/Users/']) assert.ok(!result.json.includes(marker), marker)
})

test('input getters, conversion hooks and proxy traps never execute; array bodies are not visited', () => {
  const input = snapshot(), resources = budget()
  let invoked = 0
  const forbidden = () => { invoked++; throw new Error(secret) }
  Object.defineProperty(input.agents.data!.agents, '0', { get: forbidden })
  Object.defineProperty(input.schedules.data!.jobs, '0', { get: forbidden })
  Object.defineProperty(input.system.data!.processes, '0', { get: forbidden })
  Object.defineProperty(input.agents, 'error', { get: forbidden })
  Object.defineProperty(input.schedules.data!.sources[0], 'state', { get: forbidden })
  Object.defineProperty(input.schedules.data!.sources[0], 'detail', { get: forbidden })
  Object.defineProperty(input.schedules.data!.sources[0].diagnostics![0], 'code', { get: forbidden })
  Object.defineProperty(resources.global.current, 'files', { get: forbidden })
  for (const target of [input, input.agents, input.schedules.data, input.schedules.data!.sources,
    input.schedules.data!.sources[0], input.schedules.data!.sources[0].diagnostics![0], resources, resources.global]) {
    Object.defineProperty(target, 'toJSON', { get: forbidden })
    Object.defineProperty(target, 'toString', { get: forbidden })
  }
  const proxy = new Proxy({}, { get: forbidden, getOwnPropertyDescriptor: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden })
  input.schedules.data!.sources.push(proxy as SourceStatus, source('hermes-cron'))
  const result = buildDiagnosticReport(input, resources, metadata, now)
  const report = JSON.parse(result.json)
  assert.equal(invoked, 0)
  assert.equal(report.sections.agents.totals.agents, 1)
  assert.equal(report.sections.schedules.totals.jobs, 1)
  assert.equal(report.sections.system.totals.processes, 1)
  assert.equal(report.sections.agents.hasError, null)
  assert.equal(report.sections.schedules.sources[0].state, null)
  assert.equal(report.sections.schedules.sources[0].diagnostics[0].code, null)
  assert.equal(report.resources.global.current.files, null)
  assert.equal(report.sections.schedules.sources[1].id, 'hermes-cron')
  assert.deepEqual(result.coverage.sources, { included: 2, total: 3 })
  assert.equal(result.coverage.diagnostics.total, null)
  assert.ok(result.limits.includes('invalid-fields'))
  assert.ok(!result.json.includes(secret))
})

test('unknown identities and invalid controlled fields are explicit and do not discard other sources', () => {
  const input = snapshot(), resources = budget()
  const bad = source(secret)
  Object.assign(bad, { state: secret, lastAttemptAt: secret, lastSuccessAt: secret })
  Object.assign(bad.diagnostics![0], { operation: secret, stage: secret, code: secret, retryable: secret,
    observedAt: secret, exitCode: secret })
  input.schedules.data!.sources = [null as unknown as SourceStatus, bad, source('launchctl:user/81234'), source('processes')]
  const unknownBudget = { ...statistics(), source: secret }
  Object.assign(unknownBudget.current, { commands: secret, files: NaN, sockets: Infinity, queued: -1 })
  Object.assign(unknownBudget, { completed: Number.MAX_VALUE, totalWaitMs: secret })
  const result = buildDiagnosticReport(input, { ...resources, sources: [unknownBudget] }, metadata, now)
  const report = JSON.parse(result.json)
  const sources = report.sections.schedules.sources
  assert.deepEqual(sources.map((item: { id: string }) => item.id), ['unknown', 'launchctl:user', 'processes'])
  assert.equal(sources[0].state, null)
  assert.equal(sources[0].lastAttemptAt, null)
  assert.deepEqual(sources[0].capabilities, [])
  assert.deepEqual(sources[0].diagnostics[0], { sourceId: 'unknown', operation: null, stage: null, code: null,
    retryable: null, observedAt: null, exitCode: null })
  assert.equal(sources[1].diagnostics[0].stage, 'permission')
  assert.equal(report.resources.sources[0].source, 'unknown')
  for (const key of ['commands', 'files', 'sockets', 'queued']) assert.equal(report.resources.sources[0].current[key], null)
  assert.equal(report.resources.sources[0].completed, null)
  assert.ok(result.limits.includes('invalid-fields'))
  assert.ok(!result.json.includes(secret))
})

test('metadata rejects suffixes, nonprimitive values and oversized values without coercion', () => {
  const input = snapshot()
  let invoked = 0
  const coercible = { toString() { invoked++; return secret }, toJSON() { invoked++; return secret } }
  for (const key of ['version', 'electron', 'platform', 'arch', 'osRelease'] as const) {
    for (const value of [`${metadata[key]}-${secret}`, `${metadata[key]}\n`, `${metadata[key]}\r`, secret.repeat(20_000), coercible, null]) {
      const result = buildDiagnosticReport(input, budget(), { ...metadata, [key]: value } as typeof metadata, now)
      assert.equal(JSON.parse(result.json).metadata[key], null)
      assert.ok(result.limits.includes('invalid-fields'))
      assert.ok(!result.json.includes(secret))
    }
  }
  const accessor = { ...metadata }
  Object.defineProperty(accessor, 'version', { get() { invoked++; throw new Error(secret) } })
  assert.equal(JSON.parse(buildDiagnosticReport(input, budget(), accessor, now).json).metadata.version, null)
  assert.equal(invoked, 0)
})

test('short ISO timestamps reject invalid dates, non-UTC forms and trailing content', () => {
  const input = snapshot()
  for (const value of ['2026-02-29T01:02:03Z', '2026-11-05T24:00:00Z', '2026-13-05T01:02:03Z',
    '2026-11-05T01:02:03+00:00', `2026-11-05T01:02:03Z${secret}`, secret]) {
    input.agents.lastAttemptAt = value
    input.schedules.data!.sources[0].diagnostics![0].observedAt = value
    const result = buildDiagnosticReport(input, budget(), metadata, now)
    const report = JSON.parse(result.json)
    assert.equal(report.sections.agents.lastAttemptAt, null)
    assert.equal(report.sections.schedules.sources[0].diagnostics[0].observedAt, null)
    assert.ok(result.limits.includes('invalid-fields'))
    assert.throws(() => buildDiagnosticReport(input, budget(), metadata, value), { message: 'Invalid diagnostic generation time' })
  }
  for (const value of ['2024-02-29T01:02:03Z', now]) {
    input.agents.lastAttemptAt = value
    input.schedules.data!.sources[0].diagnostics![0].observedAt = value
    const report = JSON.parse(buildDiagnosticReport(input, budget(), metadata, value).json)
    assert.equal(report.generatedAt, value)
    assert.equal(report.sections.agents.lastAttemptAt, value)
  }
})

test('missing data is distinct from successfully collected empty arrays', () => {
  const input = snapshot()
  input.schedules.data!.sources = []
  const empty = JSON.parse(buildDiagnosticReport(input, budget(), metadata, now).json)
  assert.equal(empty.sections.agents.dataAvailable, true)
  assert.equal(empty.sections.agents.totals.agents, 0)
  assert.deepEqual(empty.coverage.sources, { included: 0, total: 0 })
  assert.deepEqual(empty.coverage.diagnostics, { included: 0, total: 0 })
  input.agents.data = null
  input.agents.error = secret
  const missing = buildDiagnosticReport(input, budget(), metadata, now)
  const report = JSON.parse(missing.json)
  assert.equal(report.sections.agents.dataAvailable, false)
  assert.equal(report.sections.agents.hasError, true)
  assert.equal(report.sections.agents.collectedAt, null)
  assert.equal(report.sections.agents.totals.agents, null)
  assert.equal(report.coverage.sources.total, null)
  assert.equal(report.coverage.diagnostics.total, null)
  assert.deepEqual(missing.limits, [])
  assert.ok(!missing.json.includes(secret))
})

test('aggregate source, diagnostic and resource quotas accept the boundary and explain omissions', () => {
  const input = snapshot()
  const first = source('processes')
  first.diagnostics = Array.from({ length: DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS }, () => ({ ...source().diagnostics![0] }))
  input.agents.data!.sources = [first]
  input.schedules.data!.sources = Array.from({ length: DIAGNOSTIC_REPORT_MAX_SOURCES - 1 }, () => ({ ...source('hermes-cron'), diagnostics: [] }))
  const resources = { ...budget(), sources: Array.from({ length: DIAGNOSTIC_REPORT_MAX_RESOURCES }, () => ({ source: 'agent-processes', ...statistics() })) }
  const exact = buildDiagnosticReport(input, resources, metadata, now)
  assert.deepEqual(exact.limits, [])
  assert.deepEqual(exact.coverage, {
    sources: { included: 64, total: 64 }, diagnostics: { included: 128, total: 128 }, resources: { included: 32, total: 32 },
  })
  let invoked = 0
  const forbidden = () => { invoked++; throw new Error(secret) }
  Object.defineProperty(first.diagnostics, String(DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS), { get: forbidden })
  Object.defineProperty(resources.sources, String(DIAGNOSTIC_REPORT_MAX_RESOURCES), { get: forbidden })
  const diagnosticOverflow = buildDiagnosticReport(input, resources, metadata, now)
  assert.deepEqual(diagnosticOverflow.coverage.diagnostics, { included: 128, total: 129 })
  assert.deepEqual(diagnosticOverflow.coverage.resources, { included: 32, total: 33 })
  assert.ok(diagnosticOverflow.limits.includes('diagnostics'))
  assert.ok(diagnosticOverflow.limits.includes('resources'))
  input.system.data!.sources = [source('system')]
  const overflow = buildDiagnosticReport(input, resources, metadata, now)
  assert.deepEqual(overflow.coverage.sources, { included: 64, total: 65 })
  assert.equal(overflow.coverage.diagnostics.total, null)
  assert.ok(overflow.limits.includes('sources'))
  assert.ok(overflow.bytes <= DIAGNOSTIC_REPORT_MAX_BYTES)
  assert.equal(JSON.parse(overflow.json).schemaVersion, 1)
  assert.equal(invoked, 0)
})

test('huge sparse arrays remain bounded and retain real totals without reading past quotas', () => {
  const input = snapshot(), resources = budget()
  const diagnostics: SourceDiagnostic[] = []
  diagnostics.length = 0xffff_ffff
  const first = source()
  first.diagnostics = diagnostics
  const sources: SourceStatus[] = [first]
  sources.length = 0xffff_ffff
  input.schedules.data!.sources = sources
  const resourceSources: ResourceBudgetSnapshot['sources'][number][] = []
  resourceSources.length = 0xffff_ffff
  const result = buildDiagnosticReport(input, { ...resources, sources: resourceSources }, metadata, now)
  assert.deepEqual(result.coverage.sources, { included: 1, total: 0xffff_ffff })
  assert.equal(result.coverage.diagnostics.total, null)
  assert.deepEqual(result.coverage.resources, { included: 0, total: 0xffff_ffff })
  for (const limit of ['sources', 'diagnostics', 'resources', 'invalid-fields'] as const) assert.ok(result.limits.includes(limit))
  assert.ok(result.bytes <= DIAGNOSTIC_REPORT_MAX_BYTES)
  assert.equal(JSON.parse(result.json).schemaVersion, 1)
})

test('malformed roots, revoked proxies and inherited properties remain controlled', () => {
  const proxy = Proxy.revocable({}, {})
  proxy.revoke()
  for (const value of [proxy.proxy, null, [], Object.create({ agents: snapshot().agents })]) {
    const result = buildDiagnosticReport(value as MonitorSnapshot, budget(), metadata, now)
    assert.ok(result.limits.includes('invalid-fields'))
    assert.equal(JSON.parse(result.json).sections.agents.dataAvailable, false)
    assert.ok(result.bytes <= DIAGNOSTIC_REPORT_MAX_BYTES)
  }
  const input = snapshot()
  Object.defineProperty(input.schedules.data!.sources[0], 'diagnostics', { get() { throw new Error(secret) } })
  const report = buildDiagnosticReport(input, budget(), metadata, now)
  assert.equal(report.coverage.diagnostics.total, null)
  assert.ok(report.limits.includes('invalid-fields'))
})

test('canonical source identities classify launch directories and never accept arbitrary prefixes', () => {
  const input = snapshot()
  const ids = ['launchctl:system', 'launchctl:gui/0', 'launchctl:user/4294967295',
    '/Library/LaunchAgents', '/Library/LaunchDaemons', '/System/Library/LaunchAgents', '/System/Library/LaunchDaemons',
    `/Volumes/${secret}/home/Library/LaunchAgents`, `launchctl:system/${secret}`, `processes-${secret}`, 'constructor', '__proto__',
    'launchctl:gui/0\n', '/Users/example/Library/LaunchAgents\n']
  input.schedules.data!.sources = ids.map(id => ({ ...source(id), diagnostics: [] }))
  const result = buildDiagnosticReport(input, budget(), metadata, now)
  const sources = JSON.parse(result.json).sections.schedules.sources
  assert.deepEqual(sources.map((item: { id: string }) => item.id), [
    'launchctl:system', 'launchctl:gui', 'launchctl:user', 'launchagents:local', 'launchdaemons:local',
    'launchagents:system', 'launchdaemons:system', 'launchagents:user', 'unknown', 'unknown', 'unknown', 'unknown',
    'unknown', 'unknown',
  ])
  assert.ok(!result.json.includes(secret))
  assert.ok(!result.json.includes('4294967295'))
  assert.ok(result.limits.includes('invalid-fields'))
})

test('finite resource counters and signed process exit-code boundaries retain evidence', () => {
  const input = snapshot(), resources = budget()
  const current = { ...resources.global.current, commands: 0, fileBytes: Number.MAX_SAFE_INTEGER }
  const sourceStats = { ...statistics(), current, source: 'diagnostic-export', totalWaitMs: 0.125 }
  for (const value of [-2147483648, 0, 2147483647]) {
    input.schedules.data!.sources[0].diagnostics![0].exitCode = value
    const result = buildDiagnosticReport(input, { ...resources, sources: [sourceStats] }, metadata, now)
    const report = JSON.parse(result.json)
    assert.equal(report.sections.schedules.sources[0].diagnostics[0].exitCode, value)
    assert.equal(report.resources.sources[0].current.fileBytes, Number.MAX_SAFE_INTEGER)
    assert.equal(report.resources.sources[0].current.commands, 0)
    assert.equal(report.resources.sources[0].totalWaitMs, 0.125)
    assert.deepEqual(result.limits, [])
  }
  for (const value of [-2147483649, 2147483648, NaN, Infinity, 0.5]) {
    input.schedules.data!.sources[0].diagnostics![0].exitCode = value
    const result = buildDiagnosticReport(input, resources, metadata, now)
    assert.equal(JSON.parse(result.json).sections.schedules.sources[0].diagnostics[0].exitCode, null)
    assert.ok(result.limits.includes('invalid-fields'))
  }
})
