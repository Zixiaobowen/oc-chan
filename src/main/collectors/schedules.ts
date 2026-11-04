import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScheduledJob, ScheduleSnapshot, SourceStatus } from '../../shared/types'

const exec = promisify(execFile)
type RecordValue = Record<string, unknown>
export interface LaunchRuntime { pid?: number; lastExitCode?: number }
interface DomainStatus {
  services: Map<string, LaunchRuntime>
  disabled: Map<string, boolean>
  loadedKnown: boolean
  disabledKnown: boolean
}
interface MetadataJob {
  id: string
  name?: string
  label?: string
  enabled?: boolean
  state?: string
  schedule?: RecordValue
  calendar?: unknown
  nextRun?: string
  notBefore?: string
}
interface PlistEntry { value: RecordValue | null; mtime: number; size: number }
const plistCache = new Map<string, PlistEntry>()
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

// Never surface subprocess stderr: it may include a command, environment, or job payload.
function errorDetail(error: unknown): string {
  const code = record(error) ? error.code : undefined
  if (code === 'EACCES' || code === 'EPERM') return '权限不足'
  if (record(error) && typeof error.stderr === 'string' && /permission denied|operation not permitted|not privileged/i.test(error.stderr)) return '权限不足'
  if (code === 'ENOENT') return '文件或命令不存在'
  if (record(error) && error.killed) return '读取超时'
  if (typeof code === 'number' || typeof code === 'string') return `读取失败（${code}）`
  return '数据格式无效或读取失败'
}
function missing(error: unknown): boolean { return record(error) && error.code === 'ENOENT' }
async function command(executable: string, args: string[]): Promise<string> {
  const { stdout } = await exec(executable, args, {
    timeout: 6000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
  return stdout
}

export function describeCalendar(value: unknown, warnings?: string[]): string {
  const calendars = Array.isArray(value) ? value : [value]
  if (!calendars.length) throw new Error('空日历条件')
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

export function parseLaunchServices(output: string): Map<string, LaunchRuntime> {
  const match = output.match(/^\s*services = \{\s*\n([\s\S]*?)^\s*\}/m)
  if (!match) throw new Error('未找到 launchctl services 表')
  const services = new Map<string, LaunchRuntime>()
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue
    const row = line.match(/^\s*(\d+|-)\s+(-?\d+|-|\([a-zA-Z]+\))\s+(.+?)\s*$/)
    if (!row) throw new Error('未知 launchctl services 行')
    services.set(row[3], { pid: Number(row[1]) > 0 ? Number(row[1]) : undefined,
      lastExitCode: /^-?\d+$/.test(row[2]) ? Number(row[2]) : undefined })
  }
  return services
}

export function parseLaunchDisabled(output: string): Map<string, boolean> {
  const match = output.match(/disabled services = \{([\s\S]*?)\}/)
  if (!match) throw new Error('未找到 launchctl disabled 表')
  const disabled = new Map<string, boolean>()
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue
    const row = line.match(/^\s*"([^"]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/)
    if (!row) throw new Error('未知 launchctl disabled 行')
    disabled.set(row[1], row[2] === 'true' || row[2] === 'disabled')
  }
  return disabled
}

export function launchState(runtime: LaunchRuntime | undefined, disabled: boolean | undefined,
  plistDisabled: boolean, loadedKnown: boolean, disabledKnown: boolean): ScheduledJob['state'] {
  if (runtime?.pid) return 'running'
  if (disabled === true || (disabled === undefined && disabledKnown && plistDisabled)) return 'disabled'
  if (runtime) return 'waiting'
  return loadedKnown ? 'unloaded' : 'unknown'
}

async function readDomain(domain: string, sources: SourceStatus[]): Promise<DomainStatus> {
  const result: DomainStatus = { services: new Map(), disabled: new Map(), loadedKnown: false, disabledKnown: false }
  const readings = await Promise.allSettled([
    command('/bin/launchctl', ['print', domain]).then(parseLaunchServices),
    command('/bin/launchctl', ['print-disabled', domain]).then(parseLaunchDisabled)
  ])
  const [services, disabled] = readings
  if (services.status === 'fulfilled') { result.services = services.value; result.loadedKnown = true }
  if (disabled.status === 'fulfilled') { result.disabled = disabled.value; result.disabledKnown = true }
  sources.push({ id: `launchctl:${domain}`, label: `launchd 运行状态 · ${domain}`,
    state: result.loadedKnown && result.disabledKnown ? 'ok' : 'partial',
    detail: readings.map((r, index) => r.status === 'fulfilled'
      ? `${index === 0 ? '已加载服务' : '禁用覆盖'}：${r.value.size} 项`
      : `${index === 0 ? '服务状态' : '禁用覆盖'}：${errorDetail(r.reason)}`).join('；') })
  return result
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
  return { Label: raw.Label, StartCalendarInterval: raw.StartCalendarInterval,
    StartInterval: raw.StartInterval, RunAtLoad: raw.RunAtLoad, KeepAlive: raw.KeepAlive,
    Disabled: raw.Disabled, Program: text(raw.Program) ?? (Array.isArray(raw.ProgramArguments) ? text(raw.ProgramArguments[0]) : undefined) }
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

async function readPlist(file: string): Promise<RecordValue | null> {
  const info = await stat(file)
  const cached = plistCache.get(file)
  if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) return cached.value
  const raw: unknown = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]))
  // Cache only scheduling fields, the executable and derived provenance, never arguments or environment variables.
  const value = projectLaunchPlist(raw)
  if (value) value.ConfigurationOrigin = launchOrigin(raw as RecordValue, file, os.homedir())
  plistCache.set(file, { value, mtime: info.mtimeMs, size: info.size })
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

async function readMetadata(file: string, id: string, label: string, sources: SourceStatus[]): Promise<MetadataJob[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!record(raw) || !Array.isArray(raw.jobs)) throw new Error('无效 jobs 数据')
    const jobs: MetadataJob[] = []
    let invalid = 0
    for (const item of raw.jobs) {
      if (!record(item) || !text(item.id) || (item.enabled !== undefined && typeof item.enabled !== 'boolean')) { invalid++; continue }
      // Whitelist metadata. Prompt, script, provider, delivery, and token fields are never accessed.
      const schedule = record(item.schedule) ? { kind: item.schedule.kind, expr: item.schedule.expr,
        minutes: item.schedule.minutes, run_at: item.schedule.run_at } : undefined
      const job: MetadataJob = { id: item.id as string, name: text(item.name), label: text(item.label),
        enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined, state: text(item.state),
        schedule, calendar: item.calendar, nextRun: text(item.next_run_at), notBefore: text(item.not_before) }
      try { metadataSchedule(job) }
      catch { invalid++; continue }
      jobs.push(job)
    }
    sources.push({ id, label, state: invalid ? 'error' : 'ok',
      detail: `${jobs.length} 条任务元数据；仅使用名称、标识、调度与状态${invalid ? `；${invalid} 条格式无效` : ''}` })
    return jobs
  } catch (error) {
    sources.push({ id, label, state: missing(error) ? 'ok' : 'error', detail: missing(error) ? '未配置任务元数据' : errorDetail(error) })
    return []
  }
}

export function mergeOmpMetadata(jobs: ScheduledJob[], metadata: MetadataJob[], file: string): ScheduledJob[] {
  const result = [...jobs]
  const indexed = new Map(result.filter((job) => job.scope === 'user').map((job) => [job.id, job]))
  for (const item of metadata) {
    const label = item.label ?? `com.user.omp-cron.${item.id}`
    const id = `launchd:user:${label}`
    const found = indexed.get(id)
    if (found) {
      found.name = item.name ?? found.name
      found.source = 'launchd · OMP 任务'
      found.origin = 'personal'
      if (!found.file) Object.assign(found, metadataSchedule(item))
      if (item.enabled === false && found.state !== 'running') found.state = 'disabled'
      if (item.notBefore) found.schedule += `；首次执行不早于 ${item.notBefore}`
    } else {
      const entry: ScheduledJob = { id, name: item.name ?? label, source: 'OMP 任务 · 未发现 launchd 配置',
        scope: 'user', origin: 'personal', ...metadataSchedule(item), state: item.enabled === false ? 'disabled' : 'unloaded', file }
      if (item.notBefore) entry.schedule += `；首次执行不早于 ${item.notBefore}`
      indexed.set(id, entry)
      result.push(entry)
    }
  }
  return result
}

export function describeCron(expression: string): string {
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
  let timezone = '系统本地时间'
  const macros: Record<string, string> = { '@yearly': '每年 1 月 1 日 00:00', '@annually': '每年 1 月 1 日 00:00',
    '@monthly': '每月 1 日 00:00', '@weekly': '每周日 00:00', '@daily': '每日 00:00', '@midnight': '每日 00:00',
    '@hourly': '每小时 00 分', '@reboot': 'cron 守护进程启动时运行（非定时任务）' }
  for (const [index, original] of output.split('\n').entries()) {
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
    jobs.push({ id: `crontab:${id}`, name: `crontab 第 ${index + 1} 行`, source: 'crontab · 当前用户', scope: 'user', origin: 'personal',
      kind: macro?.[1] === '@reboot' ? 'startup' : 'calendar',
      schedule: `${schedule}（${timezone}）`, state: 'unknown' })
  }
  return { jobs, invalid }
}

function requireCompleteConfiguration(sources: SourceStatus[]): void {
  const failures = sources.filter((source) => source.state === 'error')
  if (failures.length) {
    // Details are constructed by this collector from paths, counts, and sanitized errors;
    // never include subprocess output or raw metadata/cron contents here.
    throw new Error(`调度配置采集不完整，未更新快照：${failures.map((source) => `${source.label}：${source.detail}`).join('；')}`)
  }
}

export function assembleScheduleSnapshot(jobs: ScheduledJob[], sources: SourceStatus[], collectedAt: string): ScheduleSnapshot {
  requireCompleteConfiguration(sources)
  return { collectedAt, jobs: [...jobs].sort((a, b) => a.id.localeCompare(b.id)), sources }
}

export async function collectSchedules(): Promise<ScheduleSnapshot> {
  if (process.platform !== 'darwin') return { collectedAt: new Date().toISOString(), jobs: [], sources: [
    { id: 'schedules', label: '系统调度', state: 'unsupported', detail: '当前采集器仅支持 macOS launchd 与用户 crontab' }
  ] }
  const sources: SourceStatus[] = []
  const home = os.homedir()
  const uid = process.getuid!()
  const [gui, user, system, omp, hermes] = await Promise.all([
    readDomain(`gui/${uid}`, sources), readDomain(`user/${uid}`, sources), readDomain('system', sources),
    readMetadata(path.join(home, '.omp/cron/jobs.json'), 'omp-cron', 'OMP 任务元数据', sources),
    readMetadata(path.join(home, '.hermes/cron/jobs.json'), 'hermes-cron', 'Hermes 任务元数据', sources)
  ])
  const directories = [
    { directory: path.join(home, 'Library/LaunchAgents'), scope: 'user' as const },
    { directory: '/Library/LaunchAgents', scope: 'user' as const },
    { directory: '/Library/LaunchDaemons', scope: 'system' as const },
    { directory: '/System/Library/LaunchAgents', scope: 'user' as const },
    { directory: '/System/Library/LaunchDaemons', scope: 'system' as const }
  ]
  const jobs = new Map<string, ScheduledJob>()
  const seenFiles = new Set<string>()
  for (const { directory, scope } of directories) {
    let filenames: string[]
    try { filenames = (await readdir(directory)).filter((name) => name.endsWith('.plist')).sort() }
    catch (error) {
      sources.push({ id: directory, label: directory, state: missing(error) ? 'ok' : 'error',
        detail: missing(error) ? '目录不存在' : errorDetail(error) })
      continue
    }
    let failures = 0
    let duplicates = 0
    let nonServices = 0
    let unconfirmedCalendars = 0
    let firstCalendarWarning = ''
    let firstFailure = ''
    let offset = 0
    // Four plutil processes at most; subsequent polls use mtime/size metadata cache.
    await Promise.all(Array.from({ length: Math.min(4, filenames.length) }, async () => {
      while (offset < filenames.length) {
        const file = path.join(directory, filenames[offset++])
        seenFiles.add(file)
        try {
          const plist = await readPlist(file)
          if (plist === null) { nonServices++; continue }
          const label = plist.Label as string
          const id = `launchd:${scope}:${label}`
          if (jobs.has(id)) { duplicates++; continue }
          const domain = scope === 'system' ? system : gui.services.has(label) ? gui : user.services.has(label) ? user : gui
          const loadedKnown = scope === 'system' ? system.loadedKnown : gui.loadedKnown && user.loadedKnown
          const runtime = domain.services.get(label)
          const disabled = domain.disabled.get(label)
          const hermesScheduler = label === 'ai.hermes.cron-tick' || label === 'ai.hermes.gateway'
          const calendarWarnings: string[] = []
          const schedule = describeLaunchSchedule(plist, calendarWarnings)
          if (calendarWarnings.length) {
            unconfirmedCalendars++
            if (!firstCalendarWarning) firstCalendarWarning = `${path.basename(file)}：${calendarWarnings.join('；')}`
          }
          jobs.set(id, { id, name: hermesScheduler ? `${label}（调度器 / 服务）` : label,
            source: hermesScheduler ? 'launchd · Hermes 调度器' : 'launchd', scope, origin: plist.ConfigurationOrigin as ScheduledJob['origin'],
            ...schedule, state: launchState(runtime, disabled, plist.Disabled === true, loadedKnown, domain.disabledKnown),
            pid: runtime?.pid, lastExitCode: runtime?.lastExitCode, file, executable: text(plist.Program) ? path.basename(plist.Program as string) : undefined })
        } catch (error) {
          failures++
          if (!firstFailure) firstFailure = `${path.basename(file)}：${errorDetail(error)}`
        }
      }
    }))
    sources.push({ id: directory, label: directory, state: failures ? 'error' : unconfirmedCalendars ? 'partial' : 'ok',
      detail: `${filenames.length} 个 plist；${nonServices} 个非服务数据 / 空字典已跳过；${duplicates} 个同域同 Label 重复已合并${failures ? `；${failures} 个读取失败；${firstFailure}` : ''}${unconfirmedCalendars ? `；${unconfirmedCalendars} 个任务含未确认的日历扩展，任务已保留；${firstCalendarWarning}` : ''}` })
  }
  for (const file of plistCache.keys()) if (!seenFiles.has(file)) plistCache.delete(file)
  // A missing/unreadable service configuration must never reappear as an unclassified
  // runtime service. The monitor retains the entire previous snapshot when this throws.
  requireCompleteConfiguration(sources)
  // Services registered at runtime need not have a plist in the five standard directories.
  for (const [scope, domain] of [['user', gui], ['user', user], ['system', system]] as const) {
    for (const [label, runtime] of domain.services) {
      const id = `launchd:${scope}:${label}`
      if (jobs.has(id)) continue
      jobs.set(id, { id, name: label, scope, source: 'launchd · 运行时服务', kind: 'service',
        origin: label.startsWith('com.apple.') ? 'system' : 'unknown',
        schedule: '已加载；标准目录中未发现对应 plist，触发方式未知',
        state: launchState(runtime, domain.disabled.get(label), false, domain.loadedKnown, domain.disabledKnown),
        pid: runtime.pid, lastExitCode: runtime.lastExitCode })
    }
  }
  let merged = [...jobs.values()]
  for (const item of omp) {
    try { merged = mergeOmpMetadata(merged, [item], path.join(home, '.omp/cron/jobs.json')) }
    catch (error) { sources.push({ id: `omp-job:${item.id}`, label: 'OMP 任务', state: 'error', detail: errorDetail(error) }) }
  }
  const hermesSeen = new Set<string>()
  for (const item of hermes) {
    if (hermesSeen.has(item.id)) continue
    hermesSeen.add(item.id)
    try {
      const disabled = item.enabled === false || item.state === 'paused' || item.state === 'completed'
      const next = item.nextRun && /(?:Z|[+-]\d\d:\d\d)$/.test(item.nextRun) ? Date.parse(item.nextRun) : NaN
      merged.push({ id: `hermes-job:${item.id}`, name: item.name ?? item.id, source: 'Hermes 任务（由调度器执行）', scope: 'user', origin: 'personal',
        ...metadataSchedule(item), state: disabled ? 'disabled' : 'unknown',
        nextRun: !disabled && Number.isFinite(next) && next > Date.now() ? new Date(next).toISOString() : undefined,
        file: path.join(home, '.hermes/cron/jobs.json') })
    } catch (error) { sources.push({ id: `hermes-job:${item.id}`, label: 'Hermes 任务', state: 'error', detail: errorDetail(error) }) }
  }
  try {
    const parsed = parseCrontab(await command('/usr/bin/crontab', ['-l']))
    merged.push(...parsed.jobs)
    sources.push({ id: 'crontab', label: '当前用户 crontab', state: parsed.invalid ? 'error' : 'ok',
      detail: `${parsed.jobs.length} 条；不读取其他用户 crontab；cron 不提供每条任务的运行状态${parsed.invalid ? `；${parsed.invalid} 行无法解析` : ''}` })
  } catch (error) {
    const absent = record(error) && error.code === 1 && typeof error.stderr === 'string' && /no crontab for /i.test(error.stderr)
    sources.push({ id: 'crontab', label: '当前用户 crontab', state: absent ? 'ok' : 'error', detail: absent ? '当前用户未配置 crontab' : errorDetail(error) })
  }
  sources.push({ id: 'schedule-semantics', label: '调度边界', state: 'ok',
    detail: 'LaunchAgents 状态仅对应当前用户；LaunchDaemons 对应 system。启动 / 常驻服务与定时任务分列。Hermes 调度器与内部任务分别列出。launchd / cron 不提供可靠下次执行时间，不做推算；Hermes 仅显示元数据中带时区且未过期的计划时间，不保证实际执行。' })
  return assembleScheduleSnapshot(merged, sources, new Date().toISOString())
}
