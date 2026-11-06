import type { ScheduledJob, SourceDiagnostic, SourceStatus } from '../../shared/types'
import { isResourceAbort, isResourceCleanupFailure, throwIfAborted } from '../resource-budget'
import { runBudgetedCommand, type BudgetedCommandOptions } from '../resource-io'

export interface LaunchRuntime { pid?: number; lastExitCode?: number }
export interface LaunchDomain {
  services: Map<string, LaunchRuntime>
  disabled: Map<string, boolean>
  loadedKnown: boolean
  disabledKnown: boolean
  source: SourceStatus
}
/** Injected commands receive an admitted lease and must settle only after the child closes. */
export type LaunchCommand = (executable: string, args: string[], signal?: AbortSignal, input?: Buffer) => Promise<string>
const MAX_ENTRIES = 8192
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const PLIST_OUTPUT_BYTES = 4 * 1024 * 1024

export async function runLaunchCommand(executable: string, args: string[], signal?: AbortSignal, run?: LaunchCommand, inputFile?: BudgetedCommandOptions['inputFile']): Promise<string> {
  const maxBuffer = executable === '/usr/bin/plutil' ? PLIST_OUTPUT_BYTES : MAX_OUTPUT_BYTES
  const source = executable === '/usr/bin/plutil' ? 'schedule-plist' : 'schedule-commands'
  const { stdout } = await runBudgetedCommand(source, executable, args, {
    timeout: 6000, maxBuffer, inputFile, env: { ...process.env, LC_ALL: 'C' }
  }, signal, run ? input => run(executable, args, signal, input) : undefined)
  return stdout
}

class LaunchParseFailure extends Error {
  constructor(readonly stage: 'structure' | 'row' | 'limit', readonly code: SourceDiagnostic['code']) {
    super(code)
  }
}
function checkOutput(output: string): void {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new LaunchParseFailure('limit', 'output-limit')
}
function checkLabel(label: string): void {
  if (Buffer.byteLength(label) > 1024 || /[\x00-\x1f\x7f]/.test(label)) throw new LaunchParseFailure('row', 'invalid-row')
}

export function parseLaunchServices(output: string): Map<string, LaunchRuntime> {
  checkOutput(output)
  const match = output.match(/^[ \t]*services = \{[ \t]*\r?\n([\s\S]*?)^[ \t]*\}/m)
  if (!match) throw new LaunchParseFailure('structure', 'missing-table')
  const services = new Map<string, LaunchRuntime>()
  for (const item of match[1].matchAll(/[^\r\n]+/g)) {
    const line = item[0]
    if (!line.trim()) continue
    if (services.size >= MAX_ENTRIES) throw new LaunchParseFailure('limit', 'entry-limit')
    const row = line.match(/^\s*(\d+|-)\s+(-?\d+|-|\?|\([a-zA-Z]+\))\s+(.+?)\s*$/)
    if (!row) throw new LaunchParseFailure('row', 'invalid-row')
    checkLabel(row[3])
    const pid = row[1] === '-' ? 0 : Number(row[1])
    const lastExitCode = /^-?\d+$/.test(row[2]) ? Number(row[2]) : undefined
    if (!Number.isSafeInteger(pid) || pid < 0 || pid > 2147483647 ||
        (lastExitCode !== undefined && !Number.isSafeInteger(lastExitCode)) || services.has(row[3]))
      throw new LaunchParseFailure('row', 'invalid-row')
    // '?' and parenthesized launchd flags carry no exit-code evidence.
    services.set(row[3], { pid: pid || undefined, lastExitCode })
  }
  return services
}

export function parseLaunchDisabled(output: string): Map<string, boolean> {
  checkOutput(output)
  const match = output.match(/^[ \t]*disabled services = \{[ \t]*\r?\n([\s\S]*?)^[ \t]*\}/m)
  if (!match) throw new LaunchParseFailure('structure', 'missing-table')
  const disabled = new Map<string, boolean>()
  for (const item of match[1].matchAll(/[^\r\n]+/g)) {
    const line = item[0]
    if (!line.trim()) continue
    if (disabled.size >= MAX_ENTRIES) throw new LaunchParseFailure('limit', 'entry-limit')
    const row = line.match(/^\s*"([^"]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/)
    if (!row) throw new LaunchParseFailure('row', 'invalid-row')
    checkLabel(row[1])
    if (disabled.has(row[1])) throw new LaunchParseFailure('row', 'invalid-row')
    disabled.set(row[1], row[2] === 'true' || row[2] === 'disabled')
  }
  return disabled
}

export function launchState(runtime: LaunchRuntime | undefined, disabled: boolean | undefined,
  plistDisabled: boolean, loadedKnown: boolean, disabledKnown: boolean): ScheduledJob['state'] {
  if (loadedKnown && runtime?.pid) return 'running'
  if (disabledKnown && (disabled === true || (disabled === undefined && plistDisabled))) return 'disabled'
  if (!loadedKnown) return 'unknown'
  if (runtime) return disabledKnown ? 'waiting' : 'unknown'
  return 'unloaded'
}

const messages: Record<SourceDiagnostic['code'], string> = {
  'command-failed': '命令执行失败，检查该域是否仍存在后重试',
  'permission-denied': '系统拒绝访问该域；请核对当前登录用户及系统访问限制后重试',
  'timed-out': '命令超过 6 秒，稍后重试',
  'command-missing': 'launchctl 命令不存在，当前系统不支持此读取',
  'output-limit': '命令输出超过 8 MiB，未使用不完整结果',
  'entry-limit': '条目超过 8192 项，未使用不完整结果',
  'resource-limit': '达到共享资源上限，稍后重试',
  'queue-timeout': '等待共享资源超过 10 秒，稍后重试',
  'missing-table': '未找到预期表结构，需要更新 launchctl 解析器',
  'invalid-row': '表内存在无法识别的行，需要更新 launchctl 解析器'
}
function diagnose(error: unknown, sourceId: string, operation: SourceDiagnostic['operation'], observedAt: string): SourceDiagnostic {
  let stage: SourceDiagnostic['stage'] = 'command'
  let code: SourceDiagnostic['code'] = 'command-failed'
  const value = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
  if (error instanceof LaunchParseFailure) { stage = error.stage; code = error.code }
  else if (value.code === 'OC_RESOURCE_LIMIT') { stage = 'limit'; code = 'resource-limit' }
  else if (value.code === 'OC_RESOURCE_QUEUE_TIMEOUT') { stage = 'queue'; code = 'queue-timeout' }
  else if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { stage = 'limit'; code = 'output-limit' }
  else if (value.code === 'EACCES' || value.code === 'EPERM' ||
      (typeof value.stderr === 'string' && /permission denied|operation not permitted|not privileged/i.test(value.stderr))) {
    stage = 'permission'; code = 'permission-denied'
  } else if (value.code === 'ETIMEDOUT' || value.killed === true) { stage = 'timeout'; code = 'timed-out' }
  else if (value.code === 'ENOENT') code = 'command-missing'
  return { sourceId, operation, stage, code, observedAt,
    retryable: code === 'command-failed' || code === 'permission-denied' || code === 'timed-out' ||
      code === 'resource-limit' || code === 'queue-timeout',
    ...(Number.isSafeInteger(value.code) ? { exitCode: value.code as number } : {}) }
}

export class LaunchdCollector {
  readonly domains: readonly string[]
  private readonly readings = new Map<string, LaunchDomain>()
  constructor(private readonly run: LaunchCommand | undefined, uid: number, private readonly now = () => new Date().toISOString()) {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('无效用户 ID / Invalid user ID')
    this.domains = [`gui/${uid}`, `user/${uid}`, 'system']
  }
  clear(): void { this.readings.clear() }
  get(domain: string): LaunchDomain {
    const reading = this.readings.get(domain)
    if (!reading) throw new Error('尚未读取 launchd 域 / launchd domain has not been read')
    return reading
  }
  async read(domain: string, signal?: AbortSignal): Promise<void> {
    if (!this.domains.includes(domain)) throw new Error('未知 launchd 域 / Unknown launchd domain')
    const sourceId = `launchctl:${domain}`
    const previous = this.readings.get(domain)
    const [services, disabled] = await Promise.allSettled([
      runLaunchCommand('/bin/launchctl', ['print', domain], signal, this.run).then(parseLaunchServices),
      runLaunchCommand('/bin/launchctl', ['print-disabled', domain], signal, this.run).then(parseLaunchDisabled)
    ])
    const failures = [services, disabled].flatMap(result => result.status === 'rejected' && (isResourceCleanupFailure(result.reason) || signal?.aborted && !isResourceAbort(result.reason)) ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'launchd 采集关闭失败 / launchd collection cleanup failed')
    throwIfAborted(signal)
    const observedAt = this.now()
    const diagnostics: SourceDiagnostic[] = []
    const detail = [services, disabled].map((reading, index) => {
      const operation = index === 0 ? 'services' : 'disabled'
      if (reading.status === 'fulfilled') return `${index === 0 ? '已加载服务' : '禁用覆盖'}：${reading.value.size} 项`
      const diagnostic = diagnose(reading.reason, sourceId, operation, observedAt)
      diagnostics.push(diagnostic)
      return `${index === 0 ? '服务状态' : '禁用覆盖'}：${messages[diagnostic.code]}${previous ? '（保留上次条目，本轮状态未知）' : ''}`
    }).join('；')
    this.readings.set(domain, {
      // Previous entries preserve membership only. Failed tables never supply current state or PID.
      services: services.status === 'fulfilled' ? services.value : previous?.services ?? new Map(),
      disabled: disabled.status === 'fulfilled' ? disabled.value : previous?.disabled ?? new Map(),
      loadedKnown: services.status === 'fulfilled', disabledKnown: disabled.status === 'fulfilled',
      source: { id: sourceId, label: `launchd 运行状态 · ${domain}`, state: diagnostics.length ? 'partial' : 'ok', detail,
        diagnostics, lastAttemptAt: observedAt, lastSuccessAt: diagnostics.length ? previous?.source.lastSuccessAt : observedAt }
    })
  }
}
