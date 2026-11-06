import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { MAX_HERMES_JOB_ID_LENGTH, MAX_SCHEDULE_ID_LENGTH, type ScheduledJob, type ScheduleSnapshot, type SourceStatus } from '../../shared/types'
import { collectHermesRuntime, readScheduleMetadata, ReadFailure, type HermesJobMetadata } from './hermes-runtime'
import { LaunchdCollector, launchState, runLaunchCommand, type LaunchCommand } from './launchd'
import { collectionResources, isResourceAbort, isResourceCleanupFailure, resourceAbortError, settleResourceWork, throwIfAborted } from '../resource-budget'
import { COLLECTION_LIMITS, CollectionLimitError, DirectoryScan } from '../collection-limits'
import { sameFileIdentity, type FileIdentity } from '../resource-io'
type RecordValue = Record<string, unknown>
interface MetadataJob extends HermesJobMetadata {
  name?: string
  label?: string
  schedule?: RecordValue
  calendar?: unknown
  nextRun?: string
  notBefore?: string
}
interface PlistEntry { value: RecordValue | null; identity: FileIdentity; bytes: number }
interface PlistCache { entries: Map<string, PlistEntry>; bytes: number }
interface LaunchTemplate { job: ScheduledJob; label: string; disabled: boolean }
interface ScheduleDirectory { directory: string; scope: 'user' | 'system' }
interface ScheduleConfiguration {
  templates: LaunchTemplate[]
  omp: MetadataJob[]
  ompFile: string
  otherJobs: ScheduledJob[]
  sources: SourceStatus[]
  scanned: number
}
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.length) return undefined
  if (value.length > COLLECTION_LIMITS.fieldBytes || Buffer.byteLength(value) > COLLECTION_LIMITS.fieldBytes) throw new CollectionLimitError('metadata field bytes', COLLECTION_LIMITS.fieldBytes, Buffer.byteLength(value))
  return value
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

function projectCalendar(value: unknown): unknown {
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length > COLLECTION_LIMITS.calendarEntries) throw new CollectionLimitError('calendar conditions', COLLECTION_LIMITS.calendarEntries, rows.length)
  const result = rows.map(row => {
    if (!record(row)) throw new Error('无效日历条件')
    const projected: RecordValue = Object.create(null)
    let keys = 0
    for (const key in row) {
      if (!Object.hasOwn(row, key)) continue
      if (++keys > COLLECTION_LIMITS.calendarEntries) throw new CollectionLimitError('calendar fields', COLLECTION_LIMITS.calendarEntries, keys)
      if (Buffer.byteLength(key) > 128) throw new CollectionLimitError('calendar field name bytes', 128, Buffer.byteLength(key))
      projected[key] = integer(row[key]) ? row[key] : null
    }
    return projected
  })
  return Array.isArray(value) ? result : result[0]
}

function jobBytes(job: ScheduledJob): number {
  if (job.id.length > MAX_SCHEDULE_ID_LENGTH) throw new CollectionLimitError('job identifier characters', MAX_SCHEDULE_ID_LENGTH, job.id.length)
  for (const [key, value] of Object.entries(job)) {
    if (typeof value !== 'string') continue
    const limit = key === 'schedule' ? COLLECTION_LIMITS.projectionBytes : COLLECTION_LIMITS.fieldBytes
    if (Buffer.byteLength(value) > limit) throw new CollectionLimitError('job field bytes', limit, Buffer.byteLength(value))
  }
  return Buffer.byteLength(JSON.stringify(job)) + 128
}

function checkJobCollection(jobs: readonly ScheduledJob[]): number {
  if (jobs.length > COLLECTION_LIMITS.jobs) throw new CollectionLimitError('jobs across all sources', COLLECTION_LIMITS.jobs, jobs.length)
  let bytes = 0
  for (const job of jobs) {
    bytes += jobBytes(job)
    if (bytes > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('job projection bytes', COLLECTION_LIMITS.jobBytes, bytes)
  }
  return bytes
}

function prunePlists(cache: PlistCache, seen: ReadonlySet<string>): void {
  for (const [file, entry] of cache.entries) if (!seen.has(file)) { cache.entries.delete(file); cache.bytes -= entry.bytes }
}

// Never surface subprocess stderr: it may include a command, environment, or job payload.
function errorDetail(error: unknown): string {
  if (error instanceof ReadFailure || error instanceof CollectionLimitError) return error.message
  const code = record(error) ? error.code : undefined
  if (code === 'OC_RESOURCE_LIMIT') return '达到共享资源上限'
  if (code === 'OC_RESOURCE_QUEUE_TIMEOUT') return '等待共享资源超时'
  if (code === 'OC_COLLECTION_CHANGED') return '文件在读取期间发生变化，本轮未使用此结果 / File changed during reading; this result was not used'
  if (code === 'EACCES' || code === 'EPERM') return '权限不足'
  if (record(error) && typeof error.stderr === 'string' && /permission denied|operation not permitted|not privileged/i.test(error.stderr)) return '权限不足'
  if (code === 'ENOENT') return '文件或命令不存在'
  if (record(error) && error.killed) return '读取超时'
  if (typeof code === 'number' || typeof code === 'string') return `读取失败（${code}）`
  return '数据格式无效或读取失败'
}
function missing(error: unknown): boolean { return record(error) && error.code === 'ENOENT' }

export function describeCalendar(value: unknown, warnings?: string[]): string {
  const calendars = Array.isArray(value) ? value : [value]
  if (!calendars.length) throw new Error('空日历条件')
  if (calendars.length > COLLECTION_LIMITS.calendarEntries) throw new CollectionLimitError('calendar conditions', COLLECTION_LIMITS.calendarEntries, calendars.length)
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
  return calendars.map((calendar) => {
    if (!record(calendar)) throw new Error('无效日历条件')
    const limits: Record<string, [number, number]> = { Month: [1, 12], Day: [1, 31], Weekday: [0, 7], Hour: [0, 23], Minute: [0, 59] }
    const extensions: string[] = []
    for (const [key, val] of Object.entries(calendar)) {
      const bounds = limits[key]
      if (!bounds) {
        // Apple ships additional keys not documented in launchd.plist(5). Preserve their
        // numeric metadata without claiming launchd honors them or exposing arbitrary values.
        const extension = `${key}=${integer(val) ? val : '未解析的非整数值'}`
        extensions.push(extension)
        warnings?.push(`未确认日历扩展字段 ${extension} 是否参与调度`)
        continue
      }
      if (!integer(val) || val < bounds[0] || val > bounds[1]) throw new Error('无效日历字段')
    }
    const month = calendar.Month === undefined ? '每月' : `${calendar.Month}月`
    const day = calendar.Day === undefined ? '' : `${calendar.Day}日`
    const weekday = calendar.Weekday === undefined ? '' : weekdays[calendar.Weekday as number]
    const date = day && weekday ? `（${day}或${weekday}）` : day || weekday || '每日'
    const hour = calendar.Hour === undefined ? '每小时' : `${String(calendar.Hour).padStart(2, '0')}时`
    const minute = calendar.Minute === undefined ? '每分钟' : `${String(calendar.Minute).padStart(2, '0')}分`
    return `${month}${date} ${hour}${minute}${extensions.length ? `；原始扩展字段 ${extensions.join('、')}（是否生效未确认）` : ''}`
  }).join('；或 ')
}

export function describeLaunchSchedule(plist: RecordValue, warnings?: string[]): Pick<ScheduledJob, 'kind' | 'schedule'> {
  const schedules: string[] = []
  if (plist.StartCalendarInterval !== undefined) schedules.push(`${describeCalendar(plist.StartCalendarInterval, warnings)}（系统本地时间）`)
  if (plist.StartInterval !== undefined) {
    if (!integer(plist.StartInterval) || plist.StartInterval <= 0) throw new Error('无效间隔')
    schedules.push(`每 ${plist.StartInterval} 秒；休眠或上次仍运行时可能跳过`)
  }
  if (schedules.length) {
    if (plist.RunAtLoad === true) schedules.push('加载时也运行')
    if (plist.KeepAlive === true || record(plist.KeepAlive)) schedules.push('另有 KeepAlive 保活条件')
    return { kind: plist.StartCalendarInterval !== undefined ? 'calendar' : 'interval', schedule: schedules.join('；') }
  }
  if (plist.KeepAlive === true || record(plist.KeepAlive)) return { kind: 'service', schedule: '常驻 / 条件保活（非定时任务）' }
  if (plist.RunAtLoad === true) return { kind: 'startup', schedule: '加载时运行（非定时任务）' }
  return { kind: 'service', schedule: '按需或事件触发（非定时任务）' }
}


export function projectLaunchPlist(raw: unknown): RecordValue | null {
  if (!record(raw)) throw new Error('plist 不是字典')
  if (!text(raw.Label)) {
    const launchKeys = ['Label', 'Program', 'ProgramArguments', 'BundleProgram', 'StartCalendarInterval',
      'StartInterval', 'RunAtLoad', 'KeepAlive', 'MachServices', 'Sockets', 'LaunchEvents', 'WatchPaths',
      'QueueDirectories', 'StartOnMount', 'Disabled', 'UserName', 'GroupName', 'EnvironmentVariables']
    if (launchKeys.some((key) => Object.hasOwn(raw, key))) throw new Error('服务 plist 缺少有效 Label')
    // Empty uninstall remnants and data dictionaries (e.g. jetsam Version4) are not service definitions.
    return null
  }
  const label = text(raw.Label)!
  if (label.length > MAX_SCHEDULE_ID_LENGTH - 'launchd:system:'.length) throw new CollectionLimitError('launchd label characters', MAX_SCHEDULE_ID_LENGTH - 'launchd:system:'.length, label.length)
  if (raw.StartInterval !== undefined && (!integer(raw.StartInterval) || raw.StartInterval <= 0)) throw new Error('无效间隔')
  const value = { Label: label, StartCalendarInterval: raw.StartCalendarInterval === undefined ? undefined : projectCalendar(raw.StartCalendarInterval),
    StartInterval: raw.StartInterval, RunAtLoad: raw.RunAtLoad === true, KeepAlive: raw.KeepAlive === true || record(raw.KeepAlive),
    Disabled: raw.Disabled === true, Program: text(raw.Program) ?? (Array.isArray(raw.ProgramArguments) ? text(raw.ProgramArguments[0]) : undefined) }
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > COLLECTION_LIMITS.projectionBytes) throw new CollectionLimitError('plist projection bytes', COLLECTION_LIMITS.projectionBytes, bytes)
  return value
}

export function launchOrigin(plist: RecordValue, file: string, home: string): ScheduledJob['origin'] {
  const label = text(plist.Label) ?? ''
  if (file.startsWith('/System/Library/') || label.startsWith('com.apple.')) return 'system'
  if (label === 'ai.hermes.cron-tick' || label === 'ai.hermes.gateway') return 'application'
  // A user namespace in the user's own configuration is stronger evidence than its executable.
  if (path.dirname(file) === path.join(home, 'Library/LaunchAgents') && /^(com\.user\.|local\.)/.test(label)) return 'personal'
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : []
  const program = text(plist.Program) ?? text(args[0])
  const applicationPath = (value: unknown): boolean => typeof value === 'string' &&
    (/\.app(?:\/|$)/i.test(value) || value.startsWith('/Library/') || value.startsWith(path.join(home, 'Library') + '/'))
  // Inspect the script entry point, never a shell command or arbitrary payload arguments.
  const programName = program && path.basename(program)
  const interpreter = programName && /^(?:python(?:\d+(?:\.\d+)*)?|node|bun|ruby|perl|(?:ba|z|k|fi)?sh|osascript)$/.test(programName)
  let scriptIndex = 1
  // Python's no-value switches precede the script; inline code and options with values stay unknown.
  if (programName?.startsWith('python')) {
    while (typeof args[scriptIndex] === 'string' && /^-[bBEiIOqRsSuvx]+$/.test(args[scriptIndex] as string)) scriptIndex++
  }
  if (interpreter && args[scriptIndex] === '--') scriptIndex++
  const entry = interpreter ? text(args[scriptIndex]) : program
  if (entry && path.isAbsolute(entry)) {
    const script = path.normalize(entry)
    if (script.startsWith(home + '/') && !applicationPath(script) && !script.includes('/node_modules/') &&
      /\.(?:sh|py|js|mjs|cjs|ts|command|scpt)$/.test(script)) return 'personal'
  }
  if (text(plist.BundleProgram) || applicationPath(program) || (program === '/usr/bin/open' && args.some(applicationPath))) return 'application'
  return 'unknown'
}

async function readPlist(file: string, home: string, run: LaunchCommand | undefined, cache: PlistCache, signal?: AbortSignal): Promise<RecordValue | null> {
  const info = await collectionResources.run({ source: 'schedule-files', kind: 'file', bytes: 0, signal }, () => stat(file))
  if (!info.isFile()) throw Object.assign(new Error('Plist is not a regular file'), { code: 'NOT_REGULAR_FILE' })
  if (info.size > COLLECTION_LIMITS.plistBytes) throw new CollectionLimitError('plist file bytes', COLLECTION_LIMITS.plistBytes, info.size)
  const cached = cache.entries.get(file)
  if (cached && sameFileIdentity(cached.identity, info)) return cached.value
  const converted = await runLaunchCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], signal, run,
    { path: file, maxBytes: COLLECTION_LIMITS.plistBytes, identity: info })
  const after = await collectionResources.run({ source: 'schedule-files', kind: 'file', bytes: 0, signal }, () => stat(file))
  if (!sameFileIdentity(info, after)) throw Object.assign(new Error('Plist changed during conversion'), { code: 'OC_COLLECTION_CHANGED' })
  const raw: unknown = JSON.parse(converted)
  const value = projectLaunchPlist(raw)
  if (value) value.ConfigurationOrigin = launchOrigin(raw as RecordValue, file, home)
  const projectionBytes = Buffer.byteLength(JSON.stringify(value))
  if (projectionBytes > COLLECTION_LIMITS.projectionBytes) throw new CollectionLimitError('plist projection bytes', COLLECTION_LIMITS.projectionBytes, projectionBytes)
  const bytes = projectionBytes + Buffer.byteLength(file) + 128
  const total = cache.bytes - (cached?.bytes ?? 0) + bytes
  if (!cached && cache.entries.size >= COLLECTION_LIMITS.plistCacheEntries) throw new CollectionLimitError('plist cache entries', COLLECTION_LIMITS.plistCacheEntries, cache.entries.size + 1)
  if (total > COLLECTION_LIMITS.plistCacheBytes) throw new CollectionLimitError('plist cache projection bytes', COLLECTION_LIMITS.plistCacheBytes, total)
  cache.entries.set(file, { value, identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }, bytes })
  cache.bytes = total
  return value
}

function metadataSchedule(job: MetadataJob): Pick<ScheduledJob, 'kind' | 'schedule'> {
  const schedule = job.schedule
  if (schedule?.kind === 'interval' && typeof schedule.minutes === 'number' && schedule.minutes > 0)
    return { kind: 'interval', schedule: `每 ${schedule.minutes} 分钟` }
  if (schedule?.kind === 'once' && text(schedule.run_at)) return { kind: 'calendar', schedule: `单次：${schedule.run_at}` }
  if (schedule?.kind === 'cron' && text(schedule.expr)) return { kind: 'calendar', schedule: describeCron(schedule.expr as string) }
  if (job.calendar !== undefined) return { kind: 'calendar', schedule: `${describeCalendar(job.calendar)}（系统本地时间）` }
  throw new Error('未知任务调度格式')
}

async function readMetadata(file: string, id: string, label: string, sources: SourceStatus[], signal?: AbortSignal): Promise<MetadataJob[]> {
  try {
    const raw = await readScheduleMetadata(file, signal)
    if (!record(raw) || !Array.isArray(raw.jobs)) throw new Error('无效 jobs 数据')
    if (raw.jobs.length > COLLECTION_LIMITS.jobs) throw new CollectionLimitError('metadata jobs', COLLECTION_LIMITS.jobs, raw.jobs.length)
    const jobs: MetadataJob[] = []
    let invalid = 0
    for (const item of raw.jobs) {
      if (!record(item) || !text(item.id) || (item.enabled !== undefined && typeof item.enabled !== 'boolean')) { invalid++; continue }
      // Whitelist scheduling and execution metadata; never expose prompts, commands or error bodies.
      if ((item.id as string).length > MAX_HERMES_JOB_ID_LENGTH) throw new CollectionLimitError('metadata job identifier characters', MAX_HERMES_JOB_ID_LENGTH, (item.id as string).length)
      const schedule = record(item.schedule) ? { kind: text(item.schedule.kind), expr: text(item.schedule.expr),
        minutes: typeof item.schedule.minutes === 'number' ? item.schedule.minutes : undefined, run_at: text(item.schedule.run_at) } : undefined
      const job: MetadataJob = { id: item.id as string, name: text(item.name), label: text(item.label),
        enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined, state: text(item.state),
        schedule, calendar: item.calendar === undefined ? undefined : projectCalendar(item.calendar), nextRun: text(item.next_run_at), notBefore: text(item.not_before),
        fireClaimAt: item.fire_claim == null ? undefined : record(item.fire_claim) ? text(item.fire_claim.at) ?? null : null,
        lastRunAt: text(item.last_run_at), lastStatus: text(item.last_status) }
      try { metadataSchedule(job) }
      catch { invalid++; continue }
      jobs.push(job)
    }
    sources.push({ id, label, state: invalid ? 'error' : jobs.length ? 'ok' : 'empty',
      detail: `${jobs.length} 条任务元数据；仅使用名称、标识、调度与状态${invalid ? `；${invalid} 条格式无效` : ''}` })
    return jobs
  } catch (error) {
    if (isResourceCleanupFailure(error) || signal?.aborted) throw error
    sources.push({ id, label, state: missing(error) ? 'empty' : 'error', detail: missing(error) ? '未配置任务元数据' : errorDetail(error) })
    return []
  }
}

export function mergeOmpMetadata(jobs: ScheduledJob[], metadata: MetadataJob[], file: string): ScheduledJob[] {
  let bytes = checkJobCollection(jobs)
  const result = [...jobs]
  const indexed = new Map(result.filter((job) => job.scope === 'user').map((job) => [job.id, job]))
  for (const item of metadata) {
    const label = item.label ?? `com.user.omp-cron.${item.id}`
    const id = `launchd:user:${label}`
    const found = indexed.get(id)
    if (found) {
      const oldBytes = jobBytes(found)
      const update = { ...found, name: item.name ?? found.name, source: 'launchd · OMP 任务', origin: 'personal' as const }
      if (!found.file) Object.assign(update, metadataSchedule(item))
      if (item.enabled === false && update.state !== 'running') update.state = 'disabled'
      if (item.notBefore) update.schedule += `；首次执行不早于 ${item.notBefore}`
      const total = bytes - oldBytes + jobBytes(update)
      if (total > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('job projection bytes', COLLECTION_LIMITS.jobBytes, total)
      Object.assign(found, update)
      bytes = total
    } else {
      const entry: ScheduledJob = { id, name: item.name ?? label, source: 'OMP 任务 · 未发现 launchd 配置',
        scope: 'user', origin: 'personal', ...metadataSchedule(item), state: item.enabled === false ? 'disabled' : 'unloaded', file }
      if (item.notBefore) entry.schedule += `；首次执行不早于 ${item.notBefore}`
      if (result.length >= COLLECTION_LIMITS.jobs) throw new CollectionLimitError('jobs across all sources', COLLECTION_LIMITS.jobs, result.length + 1)
      bytes += jobBytes(entry)
      if (bytes > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('job projection bytes', COLLECTION_LIMITS.jobBytes, bytes)
      indexed.set(id, entry)
      result.push(entry)
    }
  }
  return result
}

export function describeCron(expression: string): string {
  text(expression)
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('不是五字段 cron')
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  for (const [index, field] of fields.entries()) {
    const names = index === 3 ? months : index === 4 ? weekdays : []
    const numeric = field.toLowerCase().replace(/[a-z]+/g, (name) => {
      const position = names.indexOf(name)
      return position < 0 ? 'invalid' : String(position + (index === 3 ? 1 : 0))
    })
    for (const part of numeric.split(',')) {
      if (!/^(?:\*|\d+(?:-\d+)?)(?:\/[1-9]\d*)?$/.test(part)) throw new Error('无效 cron 字段')
      const [range] = part.split('/')
      if (range !== '*' && range.split('-').some((value) => Number(value) < bounds[index][0] || Number(value) > bounds[index][1])) throw new Error('cron 字段越界')
    }
  }
  return `分 ${fields[0]} · 时 ${fields[1]} · 日 ${fields[2]} · 月 ${fields[3]} · 周 ${fields[4]}（* 为任意；日与周均受限时满足其一）`
}

export function parseCrontab(output: string): { jobs: ScheduledJob[]; invalid: number } {
  const jobs: ScheduledJob[] = []
  let invalid = 0
  let index = -1, bytes = 0
  let timezone = '系统本地时间'
  const macros: Record<string, string> = { '@yearly': '每年 1 月 1 日 00:00', '@annually': '每年 1 月 1 日 00:00',
    '@monthly': '每月 1 日 00:00', '@weekly': '每周日 00:00', '@daily': '每日 00:00', '@midnight': '每日 00:00',
    '@hourly': '每小时 00 分', '@reboot': 'cron 守护进程启动时运行（非定时任务）' }
  for (const [original] of output.matchAll(/[^\n]*(?:\n|$)/g)) {
    index++
    if (Buffer.byteLength(original) > COLLECTION_LIMITS.fieldBytes) throw new CollectionLimitError('crontab line bytes', COLLECTION_LIMITS.fieldBytes, Buffer.byteLength(original))
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    if (/^[A-Za-z_][A-Za-z_0-9]*\s*=/.test(line)) {
      const tz = line.match(/^CRON_TZ\s*=\s*["']?([A-Za-z0-9_+\-/]+)["']?\s*$/)
      if (tz) timezone = `CRON_TZ=${tz[1]}（是否支持由本机 cron 决定）`
      continue
    }
    const macro = line.match(/^(@\w+)\s+\S/)
    const normal = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\S/)
    if ((!macro && !normal) || (macro && !macros[macro[1]])) { invalid++; continue }
    const expression = macro ? macro[1] : normal![1]
    let schedule: string
    try { schedule = macro ? macros[expression] : describeCron(expression) }
    catch { invalid++; continue }
    const id = createHash('sha256').update(`${index}:${line}`).digest('hex').slice(0, 16)
    if (jobs.length >= COLLECTION_LIMITS.jobs) throw new CollectionLimitError('crontab jobs', COLLECTION_LIMITS.jobs, jobs.length + 1)
    const job: ScheduledJob = { id: `crontab:${id}`, name: `crontab 第 ${index + 1} 行`, source: 'crontab · 当前用户', scope: 'user', origin: 'personal',
      kind: macro?.[1] === '@reboot' ? 'startup' : 'calendar',
      schedule: `${schedule}（${timezone}）`, state: 'unknown' }
    bytes += jobBytes(job)
    if (bytes > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('crontab job bytes', COLLECTION_LIMITS.jobBytes, bytes)
    jobs.push(job)
  }
  return { jobs, invalid }
}

function requireCompleteConfiguration(sources: SourceStatus[]): void {
  if (sources.length > COLLECTION_LIMITS.sources) throw new CollectionLimitError('source records', COLLECTION_LIMITS.sources, sources.length)
  const failures = sources.filter((source) => source.state === 'error')
  if (failures.length) {
    // Details are constructed by this collector from paths, counts, and sanitized errors;
    // never include subprocess output or raw metadata/cron contents here.
    throw new Error(`调度配置采集不完整，未更新快照：${failures.map((source) => `${source.label}：${source.detail}`).join('；')}`)
  }
}

export function assembleScheduleSnapshot(jobs: ScheduledJob[], sources: SourceStatus[], collectedAt: string): ScheduleSnapshot {
  requireCompleteConfiguration(sources)
  checkJobCollection(jobs)
  return { collectedAt, jobs: [...jobs].sort((a, b) => a.id.localeCompare(b.id)), sources }
}

async function readConfiguration(home: string, directories: readonly ScheduleDirectory[], run: LaunchCommand | undefined,
  plistCache: PlistCache, signal?: AbortSignal): Promise<ScheduleConfiguration> {
  let runtimeDrain: Promise<PromiseSettledResult<unknown>[]> | undefined
  let failure: { error: unknown } | undefined
  try {
    const sources: SourceStatus[] = []
    const ompFile = path.join(home, '.omp/cron/jobs.json')
    const hermesMetadata = readMetadata(path.join(home, '.hermes/cron/jobs.json'), 'hermes-cron', 'Hermes 任务元数据', sources, signal)
    const hermesRuntimePromise = Promise.allSettled([hermesMetadata.then(jobs => jobs.length
      ? collectHermesRuntime(jobs, path.join(home, '.hermes/cron/executions.db'), signal) : undefined)])
    runtimeDrain = hermesRuntimePromise
    const [omp, hermes] = await settleResourceWork([
      readMetadata(ompFile, 'omp-cron', 'OMP 任务元数据', sources, signal), hermesMetadata
    ])
    const templates = new Map<string, LaunchTemplate>()
    const seenFiles = new Set<string>()
    const scan = new DirectoryScan()
    const scannedDirectories: (ScheduleDirectory & { filenames: string[] })[] = []
    for (const { directory, scope } of directories) {
      let filenames: string[]
      try {
        filenames = await scan.read(directory, 'schedule-files', signal, name => name.endsWith('.plist'))
        filenames.sort()
      }
      catch (error) {
        if (isResourceCleanupFailure(error) || signal?.aborted) throw error
        sources.push({ id: directory, label: directory, state: missing(error) ? 'ok' : 'error',
          detail: missing(error) ? '目录不存在' : errorDetail(error) })
        continue
      }
      for (const name of filenames) seenFiles.add(path.join(directory, name))
      scannedDirectories.push({ directory, scope, filenames })
    }
    prunePlists(plistCache, seenFiles)
    let templateBytes = 0
    for (const { directory, scope, filenames } of scannedDirectories) {
      let failures = 0
      let duplicates = 0
      let nonServices = 0
      let unconfirmedCalendars = 0
      let firstCalendarWarning = ''
      let firstFailure = ''
      let offset = 0
      // Four conversions at most; unchanged identity/ctime/mtime/size reuses the bounded projection.
      await settleResourceWork(Array.from({ length: Math.min(4, filenames.length) }, async () => {
        while (offset < filenames.length) {
          throwIfAborted(signal)
          const file = path.join(directory, filenames[offset++])
          try {
            const plist = await readPlist(file, home, run, plistCache, signal)
            if (plist === null) { nonServices++; continue }
            const label = plist.Label as string
            const id = `launchd:${scope}:${label}`
            if (templates.has(id)) { duplicates++; continue }
            const hermesScheduler = label === 'ai.hermes.cron-tick' || label === 'ai.hermes.gateway'
            const calendarWarnings: string[] = []
            const schedule = describeLaunchSchedule(plist, calendarWarnings)
            if (calendarWarnings.length) {
              unconfirmedCalendars++
              if (!firstCalendarWarning) firstCalendarWarning = `${path.basename(file)}：${calendarWarnings.join('；')}`
            }
            const job: ScheduledJob = {
              id, name: hermesScheduler ? `${label}（调度器 / 服务）` : label,
              source: hermesScheduler ? 'launchd · Hermes 调度器' : 'launchd', scope, origin: plist.ConfigurationOrigin as ScheduledJob['origin'],
              ...schedule, state: 'unknown', file, executable: text(plist.Program) ? path.basename(plist.Program as string) : undefined
            }
            const bytes = jobBytes(job)
            if (templateBytes + bytes > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('configured job bytes', COLLECTION_LIMITS.jobBytes, templateBytes + bytes)
            templateBytes += bytes
            templates.set(id, { label, disabled: plist.Disabled === true, job })
          } catch (error) {
            if (isResourceCleanupFailure(error) || signal?.aborted) throw error
            failures++
            if (!firstFailure) firstFailure = `${path.basename(file)}：${errorDetail(error)}`
          }
        }
      }))
      sources.push({ id: directory, label: directory, state: failures ? 'error' : unconfirmedCalendars ? 'partial' : 'ok',
        detail: `${filenames.length} 个 plist；${nonServices} 个非服务数据 / 空字典已跳过；${duplicates} 个同域同 Label 重复已合并${failures ? `；${failures} 个读取失败；${firstFailure}` : ''}${unconfirmedCalendars ? `；${unconfirmedCalendars} 个任务含未确认的日历扩展，任务已保留；${firstCalendarWarning}` : ''}` })
    }
    const otherJobs: ScheduledJob[] = []
    const [runtimeResult] = await hermesRuntimePromise
    if (runtimeResult.status === 'rejected') throw runtimeResult.reason
    const hermesRuntime = runtimeResult.value
    if (hermesRuntime) sources.push(hermesRuntime.source)
    const hermesSeen = new Set<string>()
    let invalidHermes = 0, firstHermesError = ''
    for (const item of hermes) {
      if (hermesSeen.has(item.id)) continue
      hermesSeen.add(item.id)
      try {
        const disabled = item.enabled === false || item.state === 'paused' || item.state === 'completed'
        const next = item.nextRun && /(?:Z|[+-]\d\d:\d\d)$/.test(item.nextRun) ? Date.parse(item.nextRun) : NaN
        otherJobs.push({ id: `hermes-job:${item.id}`, name: item.name ?? item.id, source: 'Hermes 任务（由调度器执行）', scope: 'user', origin: 'personal',
          ...metadataSchedule(item), ...hermesRuntime!.statuses.get(item.id)!,
          nextRun: !disabled && Number.isFinite(next) && next > Date.now() ? new Date(next).toISOString() : undefined,
          file: path.join(home, '.hermes/cron/jobs.json') })
      } catch (error) { invalidHermes++; firstHermesError ||= errorDetail(error) }
    }
    if (invalidHermes) sources.push({ id: 'hermes-metadata-errors', label: 'Hermes 任务', state: 'error', detail: `${invalidHermes} 条无效元数据；${firstHermesError}` })
    try {
      const parsed = parseCrontab(await runLaunchCommand('/usr/bin/crontab', ['-l'], signal, run))
      if (otherJobs.length + parsed.jobs.length > COLLECTION_LIMITS.jobs) throw new CollectionLimitError('metadata and cron jobs', COLLECTION_LIMITS.jobs, otherJobs.length + parsed.jobs.length)
      otherJobs.push(...parsed.jobs)
      sources.push({ id: 'crontab', label: '当前用户 crontab', state: parsed.invalid ? 'error' : parsed.jobs.length ? 'ok' : 'empty',
        detail: `${parsed.jobs.length} 条；不读取其他用户 crontab；cron 不提供每条任务的运行状态${parsed.invalid ? `；${parsed.invalid} 行无法解析` : ''}` })
    } catch (error) {
      if (isResourceCleanupFailure(error) || signal?.aborted) throw error
      const absent = record(error) && error.code === 1 && typeof error.stderr === 'string' && /no crontab for /i.test(error.stderr)
      sources.push({ id: 'crontab', label: '当前用户 crontab', state: absent ? 'empty' : 'error', detail: absent ? '当前用户未配置 crontab' : errorDetail(error) })
    }
    sources.push({ id: 'schedule-semantics', label: '调度边界', state: 'ok',
      detail: 'LaunchAgents 状态仅对应当前用户；LaunchDaemons 对应 system。启动 / 常驻服务与定时任务分列。Hermes 调度器与内部任务分别列出。launchd / cron 不提供可靠下次执行时间，不做推算；Hermes 仅显示元数据中带时区且未过期的计划时间，不保证实际执行。' })
    throwIfAborted(signal)
    requireCompleteConfiguration(sources)
    checkJobCollection(otherJobs)
    return { templates: [...templates.values()], omp, ompFile, otherJobs, sources, scanned: scan.scanned }
  } catch (error) { failure = { error }; throw error }
  finally {
    const result = runtimeDrain && (await runtimeDrain)[0]
    if (result?.status === 'rejected' && !isResourceAbort(result.reason) && result.reason !== failure?.error)
      throw failure ? new AggregateError([failure.error, result.reason], '调度读取与运行状态关闭失败 / Schedule read and runtime cleanup failed') : result.reason
  }
}

export class ScheduleCollector {
  private readonly launchd: LaunchdCollector
  private readonly home: string
  private readonly directories: readonly ScheduleDirectory[]
  private readonly run?: LaunchCommand
  private readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly plistCache: PlistCache = { entries: new Map(), bytes: 0 }
  private configuration?: ScheduleConfiguration
  private disposed = false

  constructor(options: { home?: string; uid?: number; directories?: readonly ScheduleDirectory[]; run?: LaunchCommand; signal?: AbortSignal } = {}) {
    this.home = options.home ?? os.homedir()
    this.run = options.run
    this.signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal
    this.launchd = new LaunchdCollector(this.run, options.uid ?? process.getuid?.() ?? 0)
    this.directories = options.directories ?? [
      { directory: path.join(this.home, 'Library/LaunchAgents'), scope: 'user' },
      { directory: '/Library/LaunchAgents', scope: 'user' },
      { directory: '/Library/LaunchDaemons', scope: 'system' },
      { directory: '/System/Library/LaunchAgents', scope: 'user' },
      { directory: '/System/Library/LaunchDaemons', scope: 'system' }
    ]
    if (this.directories.length > 16) throw new CollectionLimitError('schedule directories', 16, this.directories.length)
  }

  supports(sourceId: string): boolean {
    return this.launchd.domains.some(domain => sourceId === `launchctl:${domain}`)
  }

  diagnostics() {
    return { cachedPlists: this.plistCache.entries.size, cachedProjectionBytes: this.plistCache.bytes,
      maxPlists: COLLECTION_LIMITS.plistCacheEntries, maxProjectionBytes: COLLECTION_LIMITS.plistCacheBytes,
      scanned: this.configuration?.scanned ?? null, maxScanned: COLLECTION_LIMITS.directoryEntries }
  }

  dispose(): void {
    this.disposed = true
    this.controller.abort()
    this.configuration = undefined
    this.plistCache.entries.clear()
    this.plistCache.bytes = 0
    this.launchd.clear()
  }

  async collect(signal?: AbortSignal): Promise<ScheduleSnapshot> {
    if (this.disposed) throw resourceAbortError()
    const operationSignal = signal ? AbortSignal.any([this.signal, signal]) : this.signal
    throwIfAborted(operationSignal)
    if (process.platform !== 'darwin') return { collectedAt: new Date().toISOString(), jobs: [], sources: [
      { id: 'schedules', label: '系统调度', state: 'unsupported', detail: '当前采集器仅支持 macOS launchd 与用户 crontab' }
    ] }
    const [configuration, domains] = await Promise.allSettled([
      readConfiguration(this.home, this.directories, this.run, this.plistCache, operationSignal),
      settleResourceWork(this.launchd.domains.map(domain => this.launchd.read(domain, operationSignal)))
    ])
    if (this.disposed) { this.plistCache.entries.clear(); this.plistCache.bytes = 0; this.launchd.clear() }
    if (domains.status === 'rejected' || configuration.status === 'rejected') {
      const failures = [configuration, domains].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, '调度采集失败 / Schedule collection failed')
    }
    throwIfAborted(operationSignal)
    const snapshot = this.compose(configuration.value)
    this.configuration = configuration.value
    return snapshot
  }

  async retry(sourceId: string, signal?: AbortSignal): Promise<ScheduleSnapshot> {
    if (this.disposed) throw resourceAbortError()
    const operationSignal = signal ? AbortSignal.any([this.signal, signal]) : this.signal
    throwIfAborted(operationSignal)
    if (!this.supports(sourceId)) throw new Error('此来源不支持单独重试 / Source does not support individual retry')
    if (!this.configuration) throw new Error('尚无完整任务配置，请刷新任务列表 / Refresh schedules before retrying a source')
    await this.launchd.read(sourceId.slice('launchctl:'.length), operationSignal)
    if (this.disposed) { this.launchd.clear(); throw resourceAbortError() }
    throwIfAborted(operationSignal)
    return this.compose(this.configuration)
  }

  private compose(configuration: ScheduleConfiguration): ScheduleSnapshot {
    const [gui, user, system] = this.launchd.domains.map(domain => this.launchd.get(domain))
    const sources = [gui.source, user.source, system.source, ...configuration.sources]
    const jobs = new Map<string, ScheduledJob>()
    let bytes = 0
    const add = (job: ScheduledJob) => {
      const previous = jobs.get(job.id)
      if (!previous && jobs.size >= COLLECTION_LIMITS.jobs) throw new CollectionLimitError('jobs across all sources', COLLECTION_LIMITS.jobs, jobs.size + 1)
      const total = bytes - (previous ? jobBytes(previous) : 0) + jobBytes(job)
      if (total > COLLECTION_LIMITS.jobBytes) throw new CollectionLimitError('job projection bytes', COLLECTION_LIMITS.jobBytes, total)
      jobs.set(job.id, job)
      bytes = total
    }
    for (const { job, label, disabled } of configuration.templates) {
      const domain = job.scope === 'system' ? system
        : gui.loadedKnown && gui.services.has(label) ? gui : user.loadedKnown && user.services.has(label) ? user : gui
      const loadedKnown = job.scope === 'system' ? system.loadedKnown
        : domain.loadedKnown && domain.services.has(label) || gui.loadedKnown && user.loadedKnown
      const runtime = domain.loadedKnown ? domain.services.get(label) : undefined
      add({ ...job, state: launchState(runtime, domain.disabled.get(label), disabled, loadedKnown, domain.disabledKnown),
        pid: runtime?.pid, lastExitCode: runtime?.lastExitCode })
    }
    for (const [scope, domain] of [['user', gui], ['user', user], ['system', system]] as const) {
      for (const [label, entry] of domain.services) {
        const id = `launchd:${scope}:${label}`
        const existing = jobs.get(id)
        if (existing && (existing.file || existing.state !== 'unknown')) continue
        const runtime = domain.loadedKnown ? entry : undefined
        add({ id, name: label, scope, source: 'launchd · 运行时服务', kind: 'service',
          origin: label.startsWith('com.apple.') ? 'system' : 'unknown',
          schedule: '标准目录中未发现对应 plist，触发方式未知',
          state: launchState(runtime, domain.disabled.get(label), false, domain.loadedKnown, domain.disabledKnown),
          pid: runtime?.pid, lastExitCode: runtime?.lastExitCode })
      }
    }
    const merged = mergeOmpMetadata([...jobs.values()], configuration.omp, configuration.ompFile)
    if (merged.length + configuration.otherJobs.length > COLLECTION_LIMITS.jobs) throw new CollectionLimitError('jobs across all sources', COLLECTION_LIMITS.jobs, merged.length + configuration.otherJobs.length)
    sources.push({ id: 'schedule-limits', label: '调度资源边界', state: 'ok',
      detail: `目录条目 ${configuration.scanned}/${COLLECTION_LIMITS.directoryEntries}（所有用户与系统目录合计，含非 plist）；任务 ${merged.length + configuration.otherJobs.length}/${COLLECTION_LIMITS.jobs}；缓存 ${this.plistCache.entries.size}/${COLLECTION_LIMITS.plistCacheEntries} 项，投影 ${this.plistCache.bytes}/${COLLECTION_LIMITS.plistCacheBytes} 字节（含键与固定元数据估算）；任务投影最多 ${COLLECTION_LIMITS.jobBytes} 字节。字节额度不代表 JS heap 或 RSS。` })
    return assembleScheduleSnapshot([...merged, ...configuration.otherJobs], sources, new Date().toISOString())
  }
}
