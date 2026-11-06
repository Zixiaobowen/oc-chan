import { types } from 'node:util'
import {
  DIAGNOSTIC_REPORT_MAX_BYTES, DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS,
  DIAGNOSTIC_REPORT_MAX_RESOURCES, DIAGNOSTIC_REPORT_MAX_SOURCES,
  type DiagnosticReportContent, type DiagnosticReportCoverage, type DiagnosticReportLimit,
} from '../shared/diagnostic-report'
import { sourceCapabilities } from '../shared/source-capabilities'
import type { ResourceBudgetSnapshot } from '../shared/resources'
import type { MonitorSnapshot, SourceStatus } from '../shared/types'

const sourceIds: Record<string, true> = {
  processes: true, 'omp-ownership': true, 'tern-state': true, 'omp-socket': true, 'agent-activity': true,
  'omp-cron': true, 'hermes-cron': true, 'hermes-runtime': true, 'hermes-metadata-errors': true,
  crontab: true, 'schedule-semantics': true, system: true, 'system-0': true, 'system-1': true,
  'system-2': true, 'system-3': true, 'network-interface': true, 'collection-resources': true, 'schedule-limits': true,
  'event-store': true, 'hermes-events': true, 'source-events': true,
}
const resourceIds: Record<string, true> = {
  'agent-activity': true, 'agent-metadata': true, 'agent-processes': true, 'agent-ownership': true,
  'agent-collab': true, 'agent-tern': true, 'schedule-files': true, 'schedule-plist': true,
  'schedule-commands': true, 'schedule-metadata': true, 'hermes-history': true,
  'hermes-executions': true, 'hermes-processes': true, 'system-memory': true,
  'system-disk': true, 'system-network': true, 'system-processes': true, 'tern-navigation': true,
  'diagnostic-export': true,
  'event-store': true, 'hermes-events': true,
}
const states = ['ok', 'empty', 'partial', 'error', 'unsupported', 'disabled'] as const
const operations = ['services', 'disabled'] as const
const stages = ['command', 'timeout', 'permission', 'structure', 'row', 'limit', 'queue'] as const
const codes = ['command-failed', 'permission-denied', 'timed-out', 'command-missing', 'output-limit',
  'entry-limit', 'missing-table', 'invalid-row', 'resource-limit', 'queue-timeout'] as const
const usageKeys = ['commands', 'files', 'sockets', 'stdoutBytes', 'stderrBytes', 'commandBytes', 'fileBytes', 'socketBytes', 'queued'] as const
const limitKeys = ['commands', 'files', 'sockets', 'commandBytes', 'fileBytes', 'socketBytes', 'queued', 'queuedPerSource', 'sources', 'queueTimeoutMs'] as const
const statisticKeys = ['admitted', 'completed', 'failed', 'cancelled', 'rejected', 'queueTimeouts',
  'totalWaitMs', 'maxWaitMs', 'totalExecutionMs', 'maxExecutionMs'] as const
const sections = ['agents', 'schedules', 'system', 'events'] as const
const scope = {
  included: ['application-version-and-platform', 'source-capability-status-and-controlled-diagnostics', 'resource-budget-counts', 'collection-times-and-array-totals'],
  excluded: ['usernames', 'paths', 'uids', 'titles', 'content', 'commands', 'environment', 'stderr', 'raw-errors'],
  collection: 'existing-in-memory-snapshot-only; no-network-or-additional-collection',
  coverage: 'included counts emitted records; total is null when unavailable or not fully inspected',
  resources: 'reserved-io-capacity-and-counters; not-heap-or-rss',
} as const

type Metadata = { version: string; electron: string; platform: string; arch: string; osRelease: string }
type SafeDiagnostic = {
  sourceId: string; operation: string | null; stage: string | null; code: string | null
  retryable: boolean | null; observedAt: string | null; exitCode: number | null
}
type SafeSource = {
  id: string; state: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null
  capabilities: { id: string; support: string }[]; diagnostics: SafeDiagnostic[]
}
type SafeResourceStatistics = {
  current: Record<string, number | null>; peak: Record<string, number | null>
} & Partial<Record<typeof statisticKeys[number], number | null>>

/** UTC seconds or milliseconds only; round-trip validation rejects invalid calendar dates. */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || (value.length !== 20 && value.length !== 24)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === (value.length === 20 ? `${value.slice(0, -1)}.000Z` : value)
}

/** Projects known data properties only. No traversal of agent/job bodies or input serialization. */
export function buildDiagnosticReport(snapshot: MonitorSnapshot, resources: ResourceBudgetSnapshot,
  metadata: Metadata, generatedAt: string): DiagnosticReportContent {
  if (!isTimestamp(generatedAt)) throw new TypeError('Invalid diagnostic generation time')
  const limits = new Set<DiagnosticReportLimit>()
  const unreadable = Symbol('unreadable')
  const invalid = (): null => { limits.add('invalid-fields'); return null }
  const object = (value: unknown): object | null => {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return invalid()
    return value
  }
  const data = (value: unknown, key: string): unknown => {
    const record = object(value)
    if (!record) return unreadable
    const property = Object.getOwnPropertyDescriptor(record, key)
    if (!property) return undefined
    if (!('value' in property)) { invalid(); return unreadable }
    return property.value
  }
  const arrayLength = (value: unknown): number | null => {
    if (!object(value) || !Array.isArray(value)) return invalid()
    const length = data(value, 'length')
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : invalid()
  }
  const timestamp = (value: unknown): string | null => value === undefined ? null : isTimestamp(value) ? value : invalid()
  const enumeration = (value: unknown, allowed: readonly string[]): string | null =>
    typeof value === 'string' && value.length <= 64 && allowed.includes(value) ? value : invalid()
  const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : invalid()
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : invalid()
  const numericFields = (value: unknown, keys: readonly string[]): Record<string, number | null> => {
    const result: Record<string, number | null> = {}
    for (const key of keys) result[key] = number(data(value, key))
    return result
  }
  const statistics = (value: unknown) => ({
    current: numericFields(data(value, 'current'), usageKeys),
    peak: numericFields(data(value, 'peak'), usageKeys),
    ...numericFields(value, statisticKeys),
  })
  const version = (value: unknown): string | null =>
    typeof value === 'string' && value.length <= 32 && /^\d{1,9}\.\d{1,9}\.\d{1,9}(?![\s\S])/.test(value) ? value : invalid()
  const canonicalSource = (value: unknown): { id: string; capabilityId: string } => {
    if (typeof value === 'string' && value.length <= 4096) {
      if (Object.hasOwn(sourceIds, value)) return { id: value, capabilityId: value }
      if (value === 'launchctl:system') return { id: value, capabilityId: value }
      if (/^launchctl:(gui|user)\/\d{1,10}(?![\s\S])/.test(value)) {
        const domain = value.startsWith('launchctl:gui/') ? 'gui' : 'user'
        return { id: `launchctl:${domain}`, capabilityId: `launchctl:${domain}/0` }
      }
      switch (value) {
        case '/Library/LaunchAgents': return { id: 'launchagents:local', capabilityId: '/Library/LaunchAgents' }
        case '/Library/LaunchDaemons': return { id: 'launchdaemons:local', capabilityId: '/Library/LaunchDaemons' }
        case '/System/Library/LaunchAgents': return { id: 'launchagents:system', capabilityId: '/System/Library/LaunchAgents' }
        case '/System/Library/LaunchDaemons': return { id: 'launchdaemons:system', capabilityId: '/System/Library/LaunchDaemons' }
      }
      if (/^\/[^\0\r\n]+\/Library\/LaunchAgents(?![\s\S])/.test(value))
        return { id: 'launchagents:user', capabilityId: '/user/Library/LaunchAgents' }
    }
    invalid()
    return { id: 'unknown', capabilityId: 'unknown' }
  }
  const coverage: DiagnosticReportCoverage = {
    sources: { included: 0, total: 0 }, diagnostics: { included: 0, total: 0 }, resources: { included: 0, total: 0 },
  }
  // All strings and field sets are bounded before serialization. Reserve 16 KiB for fixed
  // metadata, section summaries, global statistics and limit/coverage bookkeeping.
  let remainingBytes = DIAGNOSTIC_REPORT_MAX_BYTES - 16 * 1024
  const admit = (value: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1
    if (bytes > remainingBytes) { limits.add('bytes'); return false }
    remainingBytes -= bytes
    return true
  }
  let inspectedSources = 0, inspectedDiagnostics = 0
  const sourceList = (value: unknown): SafeSource[] => {
    const count = arrayLength(value)
    if (count === null) {
      coverage.sources.total = null
      coverage.diagnostics.total = null
      return []
    }
    if (coverage.sources.total !== null) coverage.sources.total += count
    const available = Math.min(count, DIAGNOSTIC_REPORT_MAX_SOURCES - inspectedSources)
    if (available < count) { limits.add('sources'); coverage.diagnostics.total = null }
    const result: SafeSource[] = []
    for (let index = 0; index < available; index++) {
      inspectedSources++
      const raw = data(value, String(index))
      if (!object(raw)) { coverage.diagnostics.total = null; continue }
      const canonical = canonicalSource(data(raw, 'id'))
      const source: SafeSource = {
        id: canonical.id, state: enumeration(data(raw, 'state'), states),
        lastAttemptAt: timestamp(data(raw, 'lastAttemptAt')), lastSuccessAt: timestamp(data(raw, 'lastSuccessAt')),
        capabilities: sourceCapabilities({ id: canonical.capabilityId } as SourceStatus).map(({ id, support }) => ({ id, support })),
        diagnostics: [],
      }
      const diagnostics = data(raw, 'diagnostics')
      const diagnosticCount = diagnostics === undefined ? 0 : arrayLength(diagnostics)
      if (diagnosticCount === null) coverage.diagnostics.total = null
      else if (coverage.diagnostics.total !== null) coverage.diagnostics.total += diagnosticCount
      const diagnosticAvailable = Math.min(diagnosticCount ?? 0, DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS - inspectedDiagnostics)
      if (diagnosticAvailable < (diagnosticCount ?? 0)) limits.add('diagnostics')
      if (!admit(source)) continue
      for (let diagnosticIndex = 0; diagnosticIndex < diagnosticAvailable; diagnosticIndex++) {
        inspectedDiagnostics++
        const rawDiagnostic = data(diagnostics, String(diagnosticIndex))
        if (!object(rawDiagnostic)) continue
        const exitCode = data(rawDiagnostic, 'exitCode')
        const diagnostic: SafeDiagnostic = {
          sourceId: canonicalSource(data(rawDiagnostic, 'sourceId')).id,
          operation: enumeration(data(rawDiagnostic, 'operation'), operations),
          stage: enumeration(data(rawDiagnostic, 'stage'), stages), code: enumeration(data(rawDiagnostic, 'code'), codes),
          retryable: boolean(data(rawDiagnostic, 'retryable')), observedAt: timestamp(data(rawDiagnostic, 'observedAt')),
          exitCode: exitCode === undefined ? null : typeof exitCode === 'number' && Number.isInteger(exitCode)
            && exitCode >= -2147483648 && exitCode <= 2147483647 ? exitCode : invalid(),
        }
        if (admit(diagnostic)) { source.diagnostics.push(diagnostic); coverage.diagnostics.included++ }
      }
      result.push(source)
      coverage.sources.included++
    }
    return result
  }
  const sectionReports = {} as Record<typeof sections[number], {
    dataAvailable: boolean; hasError: boolean | null; refreshing: boolean | null
    lastAttemptAt: string | null; lastSuccessAt: string | null; collectedAt: string | null
    totals: Record<string, number | null>; sources: SafeSource[]
  }>
  for (const section of sections) {
    const state = data(snapshot, section), raw = data(state, 'data'), error = data(state, 'error')
    const available = raw !== null && raw !== undefined && object(raw) !== null
    if (raw === undefined) invalid()
    const total = (key: string): number | null => available ? arrayLength(data(raw, key)) : null
    sectionReports[section] = {
      dataAvailable: available,
      hasError: error === null ? false : typeof error === 'string' ? true : invalid(),
      refreshing: boolean(data(state, 'refreshing')),
      lastAttemptAt: timestamp(data(state, 'lastAttemptAt')), lastSuccessAt: timestamp(data(state, 'lastSuccessAt')),
      collectedAt: available ? timestamp(data(raw, 'collectedAt')) : null,
      totals: section === 'agents' ? { agents: total('agents') } : section === 'schedules' ? { jobs: total('jobs') }
        : section === 'events' ? { events: available ? number(data(data(raw, 'retention'), 'count')) : null }
          : { processes: total('processes'), memoryProcesses: total('memoryProcesses'), history: total('history') },
      sources: available ? sourceList(data(raw, 'sources')) : [],
    }
    if (!available) { coverage.sources.total = null; coverage.diagnostics.total = null }
  }
  const resourceSources = data(resources, 'sources'), resourceCount = arrayLength(resourceSources)
  coverage.resources.total = resourceCount
  const resourceAvailable = Math.min(resourceCount ?? 0, DIAGNOSTIC_REPORT_MAX_RESOURCES)
  if (resourceAvailable < (resourceCount ?? 0)) limits.add('resources')
  const resourceReports: (SafeResourceStatistics & { source: string })[] = []
  for (let index = 0; index < resourceAvailable; index++) {
    const raw = data(resourceSources, String(index))
    if (!object(raw)) continue
    const id = data(raw, 'source')
    const known = typeof id === 'string' && id.length <= 64 && Object.hasOwn(resourceIds, id)
    if (!known) invalid()
    const resource = { source: known ? id : 'unknown', ...statistics(raw) }
    if (admit(resource)) { resourceReports.push(resource); coverage.resources.included++ }
  }
  const report = {
    schemaVersion: 1, generatedAt, scope,
    metadata: {
      version: version(data(metadata, 'version')), electron: version(data(metadata, 'electron')),
      platform: enumeration(data(metadata, 'platform'), ['darwin', 'linux', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']),
      arch: enumeration(data(metadata, 'arch'), ['arm', 'arm64', 'ia32', 'x64', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x']),
      osRelease: version(data(metadata, 'osRelease')),
    },
    sections: sectionReports,
    resources: { limits: numericFields(data(resources, 'limits'), limitKeys), global: statistics(data(resources, 'global')), sources: resourceReports },
    coverage, limits: [...limits],
  }
  const json = JSON.stringify(report)
  const bytes = Buffer.byteLength(json)
  if (bytes > DIAGNOSTIC_REPORT_MAX_BYTES) throw new RangeError('Diagnostic report byte budget exceeded')
  return { generatedAt, bytes, json, coverage, limits: report.limits }
}
