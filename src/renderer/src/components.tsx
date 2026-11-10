import CircleAlert from 'kubai-icons-react/icons/circle-alert'
import ChevronDown from 'kubai-icons-react/icons/chevron-down'
import ChevronRight from 'kubai-icons-react/icons/chevron-right'
import Database from 'kubai-icons-react/icons/database'
import Sync from 'kubai-icons-react/icons/sync'
import Search from 'kubai-icons-react/icons/search'
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { AgentInfo, SourceCapabilityId, SourceDiagnostic, SourceObservation, SourceStatus } from '../../shared/types'
import { AGENT_ACTIVITY_WINDOW_MS } from '../../shared/types'
import { isScheduleDirectorySource, sourceCapabilities } from '../../shared/source-capabilities'
import './sources.css'
import type { ResolvedLanguage } from '../../shared/settings'
import { useI18n } from './i18n'

export function NativeSelect(props: ComponentProps<'select'>) {
  return <span className="select-control"><select {...props} /><ChevronDown trigger="none" className="select-chevron" size={16} aria-hidden="true" /></span>
}


export function bytes(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(4, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : precision)} ${units[index]}`
}

export function duration(seconds: number, language: ResolvedLanguage = 'zh-CN'): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (language === 'en') return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes} min`
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`
}

export function time(value?: string, language: ResolvedLanguage = 'zh-CN'): string {
  return value ? new Date(value).toLocaleTimeString(language, { hour12: false }) : language === 'zh-CN' ? '等待采集' : 'Waiting for data'
}

const labels: Record<string, [string, string]> = {
  working: ['工作中', 'Working'], idle: ['空闲', 'Idle'], running: ['运行中', 'Running'], unknown: ['状态未知', 'Unknown'], waiting: ['等待触发', 'Waiting'],
  disabled: ['已停用', 'Disabled'], unloaded: ['未加载', 'Unloaded'], ok: ['已连接', 'Connected'], empty: ['暂无数据', 'No data'], partial: ['部分可见', 'Partial coverage'], error: ['采集失败', 'Collection failed'], unsupported: ['不支持', 'Unsupported']
}

export function useRecentAgents(agents: AgentInfo[], pausedAt: number | null): AgentInfo[] {
  const [expiry, setExpiry] = useState(0)
  useEffect(() => {
    if (pausedAt !== null) return
    const now = Date.now()
    let nextExpiry = Infinity
    for (const agent of agents) {
      if (!agent.activity) continue
      const observedAt = Date.parse(agent.activity.observedAt)
      const expiresAt = observedAt + AGENT_ACTIVITY_WINDOW_MS
      if (observedAt <= now && expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt)
    }
    if (!Number.isFinite(nextExpiry)) return
    const timer = window.setTimeout(() => setExpiry(value => value + 1), nextExpiry - now)
    return () => window.clearTimeout(timer)
  }, [agents, expiry, pausedAt])
  return useMemo(() => {
    const now = pausedAt ?? Date.now()
    return agents.map(agent => {
      if (!agent.activity) return agent
      const age = now - Date.parse(agent.activity.observedAt)
      return age >= 0 && age < AGENT_ACTIVITY_WINDOW_MS ? agent : { ...agent, activity: undefined }
    })
  }, [agents, expiry, pausedAt])
}

function useMotionVisibility(active: boolean) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!active || !element) return
    const observer = new IntersectionObserver(([entry]) => {
      element.dataset.motionVisible = String(entry.isIntersecting)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      element.dataset.motionVisible = 'false'
    }
  }, [active])
  return ref
}

export function AgentActivity({ agent }: { agent: AgentInfo }) {
  const { language, t } = useI18n()
  const activity = agent.activity
  const ref = useMotionVisibility(Boolean(activity))
  if (!activity) return null
  const label = `${activity.kind === 'tool' ? t('近期工具调用', 'Recent tool call') : t('近期模型事件', 'Recent model event')}${activity.name ? ` · ${activity.name}` : ''}`
  return <span ref={ref} className="agent-activity" title={t(`${label}；观察于 ${time(activity.observedAt, language)}，不代表调用仍在进行`, `${label}; observed at ${time(activity.observedAt, language)}; does not indicate an ongoing call`)}>
    <span className="agent-activity-mark" aria-hidden="true" />
    <span className="agent-activity-label">{label}</span>
  </span>
}

export function Badge({ state }: { state: string }) {
  const { t } = useI18n()
  const ref = useMotionVisibility(state === 'working')
  return <span ref={ref} className={`badge badge-${state}`}><span className="status-dot" aria-hidden="true" />{labels[state] ? t(...labels[state]) : state}</span>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><Search trigger="none" size={26} strokeWidth={1.5} /><h3>{title}</h3>{children && <p>{children}</p>}</div>
}

export function CollectionStatus({ enabled, collectedAt, label }: { enabled: boolean; collectedAt?: string; label?: string }) {
  const { language, t } = useI18n()
  if (enabled) return null
  return <p className="collection-status"><strong>{label ? `${label} · ` : ''}{t('采集已停用', 'Collection disabled')}</strong><span>{collectedAt
    ? t(`保留 ${new Date(collectedAt).toLocaleString(language, { hour12: false })} 的旧快照；以下不是实时状态。`, `Retained snapshot from ${new Date(collectedAt).toLocaleString(language, { hour12: false })}; the following data is not live.`)
    : t('尚无采样数据。可在「数据来源」中开启采集。', 'No samples collected. Enable collection in Data sources.')}</span></p>
}

export function SectionHeader({ title, count, action, onAction }: { title: string; count?: number; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}{count !== undefined && <span className="count-label">{count}</span>}</h2>{action && <button className="text-button" onClick={onAction}>{action}<ChevronRight trigger="none" size={15} /></button>}</div>
}

export function CollectorError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useI18n()
  if (!error) return null
  return <div role="alert" className="error-notice"><CircleAlert trigger="none" size={18} /><div><strong>{t('更新失败', 'Update failed')}</strong><p>{error}{t('。已有数据保留在上次采样状态。', '. Existing data remains at the last sample.')}</p></div><button className="button secondary" onClick={onRetry}><Sync trigger="none" size={14} />{t('重试', 'Retry')}</button></div>
}

const sourceLabels: Record<string, string> = {
  '本机 CLI 进程': 'Local CLI processes', 'OMP 主代理与子代理': 'OMP main agents and subagents',
  'Codex 主代理与子代理': 'Codex main agents and subagents',
  'OMP 本地 socket': 'OMP local socket', 'Tern 主代理状态': 'Tern main agent status',
  '近期调用元数据': 'Recent call metadata', '会话事件订阅': 'Session event subscription',
  '系统调度': 'System schedules', 'OMP 任务元数据': 'OMP task metadata', 'Hermes 任务元数据': 'Hermes task metadata',
  'Hermes 执行状态': 'Hermes execution status',
  '采集资源额度': 'Collection resource limits', '调度资源边界': 'Schedule resource limits',
  'OMP 任务': 'OMP task', 'Hermes 任务': 'Hermes task', '当前用户 crontab': 'Current user crontab', '调度边界': 'Scheduling boundaries'
}

const sourceDetails: Record<string, string> = {
  '按可执行文件和已知 CLI 入口识别 OMP、Codex、Claude Code、OpenCode；检查 PID 活性并合并 wrapper/native。进程存在不代表正在推理。': 'Identifies OMP, Codex, Claude Code and OpenCode by executable and known CLI entry points; checks PID liveness and merges wrappers with native processes. A live process does not imply active inference.',
  '当前未识别到活跃 CLI 进程；没有扫描保存的历史会话。': 'No active CLI processes identified. Saved historical sessions are not scanned.',
  '未启用 Collab host；当前版本不公开进程内 AgentRegistry 查询 socket。': 'Collab host is not enabled. This version does not expose an in-process AgentRegistry query socket.',
  '未发现 Tern 宿主进程；保留 CLI 进程活性状态。': 'No Tern host process found. CLI process liveness is retained.',
  '当前采集器仅支持 macOS launchd 与用户 crontab': 'This collector supports macOS launchd and user crontab only.',
  '未配置任务元数据': 'No task metadata configured', '目录不存在': 'Directory does not exist', '当前用户未配置 crontab': 'No crontab configured for the current user',
  'LaunchAgents 状态仅对应当前用户；LaunchDaemons 对应 system。启动 / 常驻服务与定时任务分列。Hermes 调度器与内部任务分别列出。launchd / cron 不提供可靠下次执行时间，不做推算；Hermes 仅显示元数据中带时区且未过期的计划时间，不保证实际执行。': 'LaunchAgents status applies to the current user; LaunchDaemons applies to system. Startup and persistent services are separate from scheduled tasks. The Hermes scheduler and its internal tasks are listed separately. launchd / cron do not provide reliable next-run times, so none are inferred. Hermes shows only future metadata timestamps with a timezone; execution is not guaranteed.'
}

const launchDiagnosticDetails = {
  'command-failed': 'Command failed. Check whether the domain still exists, then retry.',
  'permission-denied': 'The OS denied access. Check the logged-in user and system access restrictions, then retry.',
  'timed-out': 'Command exceeded 6 seconds. Retry later.',
  'command-missing': 'launchctl is missing; this system does not support the read.',
  'output-limit': 'Output exceeded 8 MiB; incomplete results were not used.',
  'entry-limit': 'The table exceeded 8192 entries; incomplete results were not used.',
  'missing-table': 'The expected table is missing. The launchctl parser needs updating.',
  'invalid-row': 'The table contains an unrecognized row. The launchctl parser needs updating.',
  'resource-limit': 'Collection resource capacity or the waiting queue is full. Retry after current work finishes.',
  'queue-timeout': 'Waiting for collection capacity timed out; the command was not started. Retry later.'
}

function sourceDetail(source: SourceStatus): string {
  const value = source.detail
  if (source.resources) {
    const { limits, global: { current, peak, rejected, queueTimeouts, maxWaitMs, maxExecutionMs } } = source.resources
    const mib = (value: number) => (value / 1024 ** 2).toFixed(2)
    return `Commands ${current.commands}/${limits.commands} (peak ${peak.commands}), file reads ${current.files}/${limits.files} (peak ${peak.files}), sockets ${current.sockets}/${limits.sockets} (peak ${peak.sockets}); ` +
      `output reserved ${mib(current.commandBytes)}/${mib(limits.commandBytes)} MiB (peak ${mib(peak.commandBytes)}; stdout/stderr charged separately); ` +
      `files reserved ${mib(current.fileBytes)}/${mib(limits.fileBytes)} MiB (peak ${mib(peak.fileBytes)}), sockets reserved ${mib(current.socketBytes)}/${mib(limits.socketBytes)} MiB (peak ${mib(peak.socketBytes)}); ` +
      `queued ${current.queued}/${limits.queued} (peak ${peak.queued}), rejected ${rejected} (${queueTimeouts} queue timeouts); longest wait ${Math.round(maxWaitMs)} ms / execution ${Math.round(maxExecutionMs)} ms. Raw IO reservations, not parsed objects or process memory.`
  }
  if (sourceDetails[value]) return sourceDetails[value]
  // Diagnostic errors remain exactly as reported by their source.
  if (source.state === 'error') return value
  switch (source.id) {
    case 'schedule-limits': return value
      .replace(/^目录条目 (\d+)\/(\d+)（所有用户与系统目录合计，含非 plist）；任务 (\d+)\/(\d+)；缓存 (\d+)\/(\d+) 项，投影 (\d+)\/(\d+) 字节（含键与固定元数据估算）；任务投影最多 (\d+) 字节。字节额度不代表 JS heap 或 RSS。$/, 'Directory entries $1/$2 across user and system directories, including non-plist entries; jobs $3/$4; cache $5/$6 entries, $7/$8 projected bytes including keys and fixed metadata estimates; job projections capped at $9 bytes. These byte budgets do not measure JS heap or RSS.')
    case 'omp-socket': return value.replace(/^读取 (\d+) 个活跃 host；(\d+) 个读取失败。socket 仅提供主会话元数据，不公开子代理 roster。(本轮限制最多 32 个 host。)?$/, (_, active: string, failed: string, limited: string | undefined) => `Read ${active} active hosts; ${failed} failed. The socket exposes only main-session metadata, not the subagent roster.${limited ? ' Limited to 32 hosts per pass.' : ''}`)
    case 'tern-state': return value
      .replace(/^枚举 (\d+) 个 Tern 窗口，读取 (\d+) 个，按精确 session 关联 (\d+) 个主代理 working\/idle；不提供子代理生命周期。/, 'Discovered $1 Tern windows, read $2 and matched $3 main agents by exact session for working/idle status. Subagent lifecycle is unavailable.')
      .replace(/ 窗口读取失败：(.*?)。/, ' Window reads failed: $1.')
      .replace(/ (\d+) 个窗口 key 格式无效。/, ' $1 window keys have invalid format.')
      .replace(/ 本轮最多 16 个窗口、并发 4。$/, ' Limited to 16 windows, with concurrency 4.')
    case 'codex-sessions': return value
      .replace(/^关联 (\d+) 个 Codex 会话；观察到 (\d+) 个可写 rollout 文件。/, 'Matched $1 Codex sessions from $2 writable rollout files. ')
      .replace('仅使用存活 CLI 或 app-server 当前持有的会话，按明确父线程 ID 关联子代理；普通 fork 不建立父子关系。不扫描历史目录，不解析会话正文。会话驻留不证明正在工作，子代理与桌面会话的忙闲保持未知；共享进程资源不重复计算。OMP 与 Codex 每轮合计最多 128 个会话头部，Codex 每个头部最多 1 MiB。', 'Only sessions held by live CLI or app-server processes are included. Explicit parent thread IDs link subagents; ordinary forks do not create parent links. History is not scanned and conversation content is not parsed. Residency does not prove ongoing work; subagent and desktop session activity remains unknown. Shared process resources are not counted twice. OMP and Codex share a limit of 128 headers per pass, with at most 1 MiB per Codex header.')
      .replace(/ 本轮读取不完整：(.*?)。/, ' This read is incomplete: $1.')
    case 'omp-ownership': return value
      .replace(/^观察到 (\d+) 个 ownership 描述符；同进程 task 以父会话的专用 artifacts 目录识别，普通 fork 的 parentSession 不代表子代理；独立进程保留已确认祖先关系。OMP keepAlive 会保留已完成子代理，直到 park 才释放 lease，因此这些 task 显示未知，不计作活动；当前版本无独立可查询的实时子代理状态。模型为头部初始模型，可能已切换。/, 'Observed $1 ownership descriptors. In-process tasks are identified through the parent session’s dedicated artifacts directory; parentSession on a regular fork does not imply a subagent. Confirmed ancestry is retained for separate processes. OMP keepAlive retains completed subagents until park releases the lease, so these tasks are marked unknown and excluded from active counts. This version exposes no independently queryable live subagent status. The model is the initial header value and may have changed.')
      .replace(/ (\d+) 个头部无法解析。/, ' $1 headers could not be parsed.')
      .replace(' 本轮最多读取 128 个打开文件的头部。', ' At most 128 open-file headers are read per pass.')
      .replace(/ 每轮有界 ps\/lsof，不启动 OMP CLI、不扫描历史目录；仅当前持有 session\/lease 的会话读取有界调用元数据。macOS lsof 不报告此 flock 是否持有。自定义 session 目录\/隔离 profile 未覆盖。$/, ' Each pass uses bounded ps/lsof calls without starting OMP CLI or scanning history. Bounded call metadata is read only for sessions currently holding a session/lease. macOS lsof does not report whether this flock is held. Custom session directories and isolated profiles are not covered.')
    case 'agent-activity': return value
      .replace(/^读取 (\d+) 个当前持有 session\/lease 的 OMP 会话，(\d+) 个有最近 6 秒调用证据；每文件增量或尾部最多 128 KiB，最多 128 个会话。完成\/取消\/错误清除，不将最终回复算作调用，不改变忙闲或未知状态，不推算子代理活动数量。/, 'Read $1 OMP sessions currently holding session/lease; $2 have call evidence from the last 6 seconds. Incremental or tail reads are capped at 128 KiB per file and 128 sessions. Completion, cancellation and errors clear activity; final replies are not calls. Busy/idle/unknown status is unchanged, and subagent activity counts are not inferred.')
      .replace(/^监听 (\d+)\/(\d+) 个当前持有 session\/lease 的 OMP 会话；文件事件按 (\d+)ms 固定窗口合并，再增量读取（磁盘耗时另计），完成后以 (\d+)ms 固定窗口跨会话合并发布，不执行 ps\/lsof\/Tern。进程、资源和归属每 (\d+) 秒独立发现。每文件最多 128 KiB、最多 128 个会话，不扫描历史目录。(\d+) 个会话有最近 6 秒调用证据；完成\/取消\/错误清除，不改变忙闲或未知状态，不推算子代理数量。/, 'Watching $1/$2 OMP sessions currently holding session/lease. File events are coalesced in fixed $3ms windows before incremental reads (disk time excluded), then completed reads share a fixed $4ms publication window, without ps/lsof/Tern. Processes, resources and ownership are discovered separately every $5 seconds. Reads are capped at 128 KiB per file and 128 sessions; history is not scanned. $6 sessions have call evidence from the last 6 seconds. Completion, cancellation and errors clear activity; busy/idle/unknown status is unchanged, and subagent counts are not inferred.')
      .replace(/ (\d+) 个会话读取不完整：/, ' $1 session reads are incomplete: ')
      .replace(/ (\d+) 个进程缺少支持的当前会话调用来源。/, ' $1 processes lack a supported call source for the current session.')
      .replace(/ 长推理尚未落盘与超出 6 秒的调用不会持续亮起。$/, ' Long inference not yet written to disk and calls older than 6 seconds do not stay highlighted.')
      .replace(/ 长推理尚未落盘与超出 6 秒的调用不会持续亮起；监听失败仅在正常发现时重新挂接，无轮询兜底。$/, ' Long inference not yet written to disk and calls older than 6 seconds do not stay highlighted. Failed watchers reconnect only during regular discovery; there is no polling fallback.')
    case 'crontab': return value.replace(/^(\d+) 条；不读取其他用户 crontab；cron 不提供每条任务的运行状态$/, '$1 entries; other users’ crontabs are not read. cron does not report per-task runtime status.')
    case 'omp-cron':
    case 'hermes-cron': return value.replace(/^(\d+) 条任务元数据；仅使用名称、标识、调度与状态$/, '$1 task metadata entries; only names, identifiers, schedules and status are used.')
    case 'hermes-runtime': return value.replace(/^已核对 (\d+) 条任务的执行记录与心跳；(\d+) 条当前状态未确认。每次最多读取 256 条任务，每个任务只返回最新执行记录；不读取执行正文。$/, 'Checked execution records and heartbeats for $1 tasks; $2 current states are unconfirmed. Each pass reads at most 256 tasks and returns only the latest execution per task, without execution content.')
  }
  if (source.id.startsWith('launchctl:')) return (['services', 'disabled'] as const).map(operation => {
    const label = operation === 'services' ? 'Loaded services' : 'Disable overrides'
    const diagnostic = source.diagnostics?.find(item => item.operation === operation)
    if (diagnostic) return `${label}: ${launchDiagnosticDetails[diagnostic.code]} Previously observed entries, if any, have no current status.`
    const count = value.match(operation === 'services' ? /已加载服务：(\d+) 项/ : /禁用覆盖：(\d+) 项/)
    return `${label}: ${count ? `${count[1]} entries` : 'unknown'}`
  }).join('; ')
  if (isScheduleDirectorySource(source.id)) return value
    .replace('目录不存在（ENOENT）；未配置此可选调度来源 / Optional schedule directory is not configured', 'Directory does not exist (ENOENT); this optional schedule source is not configured.')
    .replace(/^(\d+) 个 plist；(\d+) 个非服务数据 \/ 空字典已跳过；(\d+) 个同域同 Label 重复已合并/, '$1 plist files; skipped $2 non-service data / empty dictionaries; merged $3 duplicates with the same domain and Label')
    .replace(/；(\d+) 个任务含未确认的日历扩展，任务已保留；/, '; $1 tasks contain unconfirmed calendar extensions and have been retained; ')
  return value
}

const capabilityLabels: Record<SourceCapabilityId, [string, string]> = {
  processes: ['进程识别', 'Process identification'], working: ['工作／空闲', 'Working / idle'],
  relationships: ['父子关系', 'Parent–child links'], activity: ['近期调用', 'Recent calls'],
  'active-count': ['精确活动数量', 'Exact active count'], history: ['逐次执行历史', 'Execution history'], navigation: ['跳转定位', 'Navigation']
}
const diagnosticStages: Record<SourceDiagnostic['stage'], [string, string]> = {
  command: ['执行命令', 'Command'], timeout: ['执行超时', 'Execution timeout'], permission: ['访问权限', 'Permissions'],
  structure: ['输出结构', 'Output structure'], row: ['记录解析', 'Record parsing'], limit: ['资源上限', 'Resource limit'], queue: ['资源排队', 'Resource queue']
}

function SourceRow({ source, observation, enabled }: { source: SourceStatus; observation?: SourceObservation; enabled: boolean }) {
  const { language, t } = useI18n()
  const [pending, setPending] = useState(false)
  const [keepAction, setKeepAction] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const name = language === 'zh-CN' ? source.label : sourceLabels[source.label] ??
    (source.id.startsWith('launchctl:') ? source.label.replace(/^launchd 运行状态 · /, 'launchd runtime status · ') : source.label)
  const capabilities = sourceCapabilities(source)
  const canRetry = enabled && (source.retry === 'section' && source.state === 'error' || source.retry === 'source' &&
    (source.state === 'error' || source.state === 'partial') && Boolean(source.diagnostics?.some(diagnostic => diagnostic.retryable)))
  async function retry() {
    if (!canRetry || request.current) return
    request.current = true
    setPending(true)
    setError(null)
    try {
      if (!window.monitor) throw new Error(t('桌面连接不可用。', 'The desktop connection is unavailable.'))
      await window.monitor.retrySource(source.id)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      request.current = false
      if (mounted.current) setPending(false)
    }
  }
  const observed = observation ?? source
  return <div className="source-row" data-source-id={source.id} tabIndex={-1}>
    <Database trigger="none" size={18} aria-hidden="true" />
    <div className="source-body">
      <div className="source-title"><strong>{name}</strong><Badge state={enabled ? source.state : 'disabled'} /></div>
      <p>{language === 'zh-CN' ? source.detail : sourceDetail(source)}</p>
      <dl className="source-timing" aria-live="off">
        <div><dt>{t('最近尝试', 'Last attempt')}</dt><dd>{observed.lastAttemptAt ? <time dateTime={observed.lastAttemptAt}>{new Date(observed.lastAttemptAt).toLocaleString(language, { hour12: false })}</time> : t('尚未尝试', 'Not attempted')}</dd></div>
        <div><dt>{t('最近完整成功', 'Last complete success')}</dt><dd>{observed.lastSuccessAt ? <time dateTime={observed.lastSuccessAt}>{new Date(observed.lastSuccessAt).toLocaleString(language, { hour12: false })}</time> : t('尚无完整成功采样', 'No complete successful sample')}</dd></div>
      </dl>
      {source.diagnostics?.map(diagnostic => <div className="source-diagnostic" key={diagnostic.operation}>
        <span>{diagnostic.operation === 'services' ? t('服务表', 'Service table') : t('禁用覆盖', 'Disable overrides')}</span>
        <span>{t(...diagnosticStages[diagnostic.stage])}</span><code>{diagnostic.code}</code>
        {diagnostic.exitCode !== undefined && <span>{t('退出码', 'Exit code')} {diagnostic.exitCode}</span>}
      </div>)}
      {(canRetry || pending || keepAction) && <div className="source-actions">
        <button className="button secondary" aria-busy={pending} aria-disabled={pending || !canRetry}
          onFocus={() => setKeepAction(true)} onBlur={() => setKeepAction(false)} onClick={() => void retry()}>
          <Sync trigger="none" size={14} aria-hidden="true" />{pending ? t('正在重新读取', 'Reading again') : !enabled ? t('采集已停用', 'Collection disabled') : !canRetry ? t('已重新检查', 'Checked') : source.retry === 'source' ? t('重试此来源', 'Retry source') : t('重试所属分区', 'Retry section')}
        </button>
        {source.retry === 'section' && <span>{t('该来源与同分区共用采集；其它分区保持当前数据。', 'This source shares collection with its section; other sections retain their data.')}</span>}
      </div>}
      {enabled && error && <p className="source-retry-error" role="alert">{error}</p>}
      {capabilities.length > 0 && <details className="source-capabilities">
        <summary>{t('能力与限制', 'Capabilities and limits')}</summary>
        <dl>{capabilities.map(capability => <div className="source-capability" key={capability.id}>
          <dt>{t(...capabilityLabels[capability.id])}<span className={`source-support source-support-${capability.support}`}>{capability.support === 'supported' ? t('支持', 'Supported') : capability.support === 'partial' ? t('部分支持', 'Partly supported') : t('不支持', 'Not supported')}</span></dt>
          <dd>{capability.reason[language]}</dd>
        </div>)}</dl>
      </details>}
    </div>
  </div>
}

export function Sources({ sources, compact = false, observations, enabled = true }: { sources: SourceStatus[]; compact?: boolean; observations?: SourceObservation[]; enabled?: boolean }) {
  const { t } = useI18n()
  const byId = useMemo(() => observations ? new Map(observations.map(observation => [observation.id, observation])) : undefined, [observations])
  if (compact) {
    const problems = enabled ? sources.filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled') : []
    return problems.length > 0 ? <div className="coverage-note"><CircleAlert trigger="none" size={15} /><span>{t(`${problems.length} 个数据来源存在覆盖限制，详情见「数据来源」。`, `${problems.length} data sources have limited coverage. See Data sources for details.`)}</span></div> : null
  }
  return <div className="source-list">{sources.map(source => <SourceRow key={source.id} source={source} observation={byId?.get(source.id)} enabled={enabled} />)}</div>
}


export function Meter({ label, value, detail, tone = 'green' }: { label: string; value: number | null; detail: string; tone?: string }) {
  return <div className={`meter meter-${tone}`}><div className="meter-title"><span>{label}</span><strong>{value === null ? '—' : `${value.toFixed(1)}%`}</strong></div><div className="meter-track" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} /></div><p>{detail}</p></div>
}
