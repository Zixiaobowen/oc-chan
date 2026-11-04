import { AlertCircle, ChevronDown, ChevronRight, Database, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { AgentInfo, SourceStatus, SystemSample } from '../../shared/types'
import { AGENT_ACTIVITY_WINDOW_MS } from '../../shared/types'
import type { ResolvedLanguage } from '../../shared/settings'
import { useI18n } from './i18n'

export function NativeSelect(props: ComponentProps<'select'>) {
  return <span className="select-control"><select {...props} /><ChevronDown className="select-chevron" size={16} aria-hidden="true" /></span>
}

export function useDetails() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  function reveal() {
    detailRef.current?.scrollIntoView({ block: 'start' })
    detailRef.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => { if (selectedId) reveal() }, [selectedId])

  const select = useCallback((id: string) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (id === selectedId) {
      detailRef.current?.scrollIntoView({ block: 'start' })
      detailRef.current?.focus({ preventScroll: true })
    } else setSelectedId(id)
  }, [selectedId])
  const close = useCallback(() => {
    setSelectedId(null)
    if (triggerRef.current?.isConnected) triggerRef.current.focus()
  }, [])
  return { selectedId, detailRef, select, close }
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
  disabled: ['已停用', 'Disabled'], unloaded: ['未加载', 'Unloaded'], ok: ['已连接', 'Connected'], partial: ['部分可见', 'Partial coverage'], error: ['采集失败', 'Collection failed'], unsupported: ['不支持', 'Unsupported']
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
  return <div className="empty-state"><Search size={26} strokeWidth={1.5} /><h3>{title}</h3>{children && <p>{children}</p>}</div>
}

export function SectionHeader({ title, count, action, onAction }: { title: string; count?: number; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}{count !== undefined && <span className="count-label">{count}</span>}</h2>{action && <button className="text-button" onClick={onAction}>{action}<ChevronRight size={15} /></button>}</div>
}

export function CollectorError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useI18n()
  if (!error) return null
  return <div role="alert" className="error-notice"><AlertCircle size={18} /><div><strong>{t('更新失败', 'Update failed')}</strong><p>{error}{t('。已有数据保留在上次采样状态。', '. Existing data remains at the last sample.')}</p></div><button className="button secondary" onClick={onRetry}><RefreshCw size={14} />{t('重试', 'Retry')}</button></div>
}

const sourceLabels: Record<string, string> = {
  '本机 CLI 进程': 'Local CLI processes', 'OMP 主代理与子代理': 'OMP main agents and subagents',
  'OMP 本地 socket': 'OMP local socket', 'Tern 主代理状态': 'Tern main agent status',
  '近期调用元数据': 'Recent call metadata', '会话事件订阅': 'Session event subscription',
  '系统指标': 'System metrics', '内存': 'Memory', '磁盘': 'Disk', '网络': 'Network', '进程': 'Processes', '网络接口': 'Network interface',
  '系统调度': 'System schedules', 'OMP 任务元数据': 'OMP task metadata', 'Hermes 任务元数据': 'Hermes task metadata',
  'OMP 任务': 'OMP task', 'Hermes 任务': 'Hermes task', '当前用户 crontab': 'Current user crontab', '调度边界': 'Scheduling boundaries'
}

const sourceDetails: Record<string, string> = {
  '按可执行文件和已知 CLI 入口识别 OMP、Codex、Claude Code、OpenCode；检查 PID 活性并合并 wrapper/native。进程存在不代表正在推理。': 'Identifies OMP, Codex, Claude Code and OpenCode by executable and known CLI entry points; checks PID liveness and merges wrappers with native processes. A live process does not imply active inference.',
  '当前未识别到活跃 CLI 进程；没有扫描保存的历史会话。': 'No active CLI processes identified. Saved historical sessions are not scanned.',
  '未启用 Collab host；当前版本不公开进程内 AgentRegistry 查询 socket。': 'Collab host is not enabled. This version does not expose an in-process AgentRegistry query socket.',
  '未发现 Tern 宿主进程；保留 CLI 进程活性状态。': 'No Tern host process found. CLI process liveness is retained.',
  'CPU 增量采样；内存使用量为活跃内存（含 wired / compressed），不含可回收缓存。进程 CPU 以单核 100% 计。': 'CPU uses incremental sampling. Memory usage is active memory (including wired / compressed), excluding reclaimable cache. Process CPU is measured as 100% per core.',
  '当前采集器仅支持 macOS launchd 与用户 crontab': 'This collector supports macOS launchd and user crontab only.',
  '未配置任务元数据': 'No task metadata configured', '目录不存在': 'Directory does not exist', '当前用户未配置 crontab': 'No crontab configured for the current user',
  'LaunchAgents 状态仅对应当前用户；LaunchDaemons 对应 system。启动 / 常驻服务与定时任务分列。Hermes 调度器与内部任务分别列出。launchd / cron 不提供可靠下次执行时间，不做推算；Hermes 仅显示元数据中带时区且未过期的计划时间，不保证实际执行。': 'LaunchAgents status applies to the current user; LaunchDaemons applies to system. Startup and persistent services are separate from scheduled tasks. The Hermes scheduler and its internal tasks are listed separately. launchd / cron do not provide reliable next-run times, so none are inferred. Hermes shows only future metadata timestamps with a timezone; execution is not guaranteed.'
}

function sourceDetail(source: SourceStatus): string {
  const value = source.detail
  if (sourceDetails[value]) return sourceDetails[value]
  // Diagnostic errors remain exactly as reported by their source.
  if (source.state === 'error') return value
  switch (source.id) {
    case 'network-interface': return value.replace(/^默认接口 (.*)；仅统计此接口，避免虚拟网卡重复计数。首个采样周期速率尚不可用。$/, 'Default interface $1; only this interface is counted to avoid duplicate virtual-interface traffic. Rates are unavailable during the first sampling interval.')
    case 'omp-socket': return value.replace(/^读取 (\d+) 个活跃 host；(\d+) 个读取失败。socket 仅提供主会话元数据，不公开子代理 roster。(本轮限制最多 32 个 host。)?$/, (_, active: string, failed: string, limited: string | undefined) => `Read ${active} active hosts; ${failed} failed. The socket exposes only main-session metadata, not the subagent roster.${limited ? ' Limited to 32 hosts per pass.' : ''}`)
    case 'tern-state': return value
      .replace(/^枚举 (\d+) 个 Tern 窗口，读取 (\d+) 个，按精确 session 关联 (\d+) 个主代理 working\/idle；不提供子代理生命周期。/, 'Discovered $1 Tern windows, read $2 and matched $3 main agents by exact session for working/idle status. Subagent lifecycle is unavailable.')
      .replace(/ 窗口读取失败：(.*?)。/, ' Window reads failed: $1.')
      .replace(/ (\d+) 个窗口 key 格式无效。/, ' $1 window keys have invalid format.')
      .replace(/ 本轮最多 16 个窗口、并发 4。$/, ' Limited to 16 windows, with concurrency 4.')
    case 'omp-ownership': return value
      .replace(/^观察到 (\d+) 个 ownership 描述符；同进程 task 以父会话的专用 artifacts 目录识别，普通 fork 的 parentSession 不代表子代理；独立进程保留已确认祖先关系。OMP keepAlive 会保留已完成子代理，直到 park 才释放 lease，因此这些 task 显示未知，不计作活动；当前版本无独立可查询的实时子代理状态。模型为头部初始模型，可能已切换。/, 'Observed $1 ownership descriptors. In-process tasks are identified through the parent session’s dedicated artifacts directory; parentSession on a regular fork does not imply a subagent. Confirmed ancestry is retained for separate processes. OMP keepAlive retains completed subagents until park releases the lease, so these tasks are marked unknown and excluded from active counts. This version exposes no independently queryable live subagent status. The model is the initial header value and may have changed.')
      .replace(/ (\d+) 个头部无法解析。/, ' $1 headers could not be parsed.')
      .replace(' 本轮最多读取 128 个打开文件的头部。', ' At most 128 open-file headers are read per pass.')
      .replace(/ 每轮有界 ps\/lsof，不启动 OMP CLI、不扫描历史目录；仅当前持有 session\/lease 的会话读取有界调用元数据。macOS lsof 不报告此 flock 是否持有。自定义 session 目录\/隔离 profile 未覆盖。$/, ' Each pass uses bounded ps/lsof calls without starting OMP CLI or scanning history. Bounded call metadata is read only for sessions currently holding a session/lease. macOS lsof does not report whether this flock is held. Custom session directories and isolated profiles are not covered.')
    case 'agent-activity': return value
      .replace(/^读取 (\d+) 个当前持有 session\/lease 的 OMP 会话，(\d+) 个有最近 6 秒调用证据；每文件增量或尾部最多 128 KiB，最多 128 个会话。完成\/取消\/错误清除，不将最终回复算作调用，不改变忙闲或未知状态，不推算子代理活动数量。/, 'Read $1 OMP sessions currently holding session/lease; $2 have call evidence from the last 6 seconds. Incremental or tail reads are capped at 128 KiB per file and 128 sessions. Completion, cancellation and errors clear activity; final replies are not calls. Busy/idle/unknown status is unchanged, and subagent activity counts are not inferred.')
      .replace(/^监听 (\d+)\/(\d+) 个当前持有 session\/lease 的 OMP 会话；文件事件按 (\d+)ms 固定窗口合并，再增量读取（磁盘耗时另计），不执行 ps\/lsof\/Tern。进程、资源和归属每 (\d+) 秒独立发现。每文件最多 128 KiB、最多 128 个会话，不扫描历史目录。(\d+) 个会话有最近 6 秒调用证据；完成\/取消\/错误清除，不改变忙闲或未知状态，不推算子代理数量。/, 'Watching $1/$2 OMP sessions currently holding session/lease. File events are coalesced in fixed $3ms windows before incremental reads (disk time excluded), without ps/lsof/Tern. Processes, resources and ownership are discovered separately every $4 seconds. Reads are capped at 128 KiB per file and 128 sessions; history is not scanned. $5 sessions have call evidence from the last 6 seconds. Completion, cancellation and errors clear activity; busy/idle/unknown status is unchanged, and subagent counts are not inferred.')
      .replace(/ (\d+) 个会话读取不完整：/, ' $1 session reads are incomplete: ')
      .replace(/ (\d+) 个进程缺少支持的当前会话调用来源。/, ' $1 processes lack a supported call source for the current session.')
      .replace(/ 长推理尚未落盘与超出 6 秒的调用不会持续亮起。$/, ' Long inference not yet written to disk and calls older than 6 seconds do not stay highlighted.')
      .replace(/ 长推理尚未落盘与超出 6 秒的调用不会持续亮起；监听失败仅在正常发现时重新挂接，无轮询兜底。$/, ' Long inference not yet written to disk and calls older than 6 seconds do not stay highlighted. Failed watchers reconnect only during regular discovery; there is no polling fallback.')
    case 'crontab': return value.replace(/^(\d+) 条；不读取其他用户 crontab；cron 不提供每条任务的运行状态$/, '$1 entries; other users’ crontabs are not read. cron does not report per-task runtime status.')
    case 'omp-cron':
    case 'hermes-cron': return value.replace(/^(\d+) 条任务元数据；仅使用名称、标识、调度与状态$/, '$1 task metadata entries; only names, identifiers, schedules and status are used.')
  }
  if (source.id.startsWith('launchctl:')) return value.split('；').map(part => part
    .replace(/^已加载服务：(\d+) 项$/, 'Loaded services: $1 entries')
    .replace(/^禁用覆盖：(\d+) 项$/, 'Disable overrides: $1 entries')
    .replace(/^服务状态：/, 'Service status: ')
    .replace(/^禁用覆盖：/, 'Disable overrides: ')).join('; ')
  if (source.id.startsWith('/')) return value
    .replace(/^(\d+) 个 plist；(\d+) 个非服务数据 \/ 空字典已跳过；(\d+) 个同域同 Label 重复已合并/, '$1 plist files; skipped $2 non-service data / empty dictionaries; merged $3 duplicates with the same domain and Label')
    .replace(/；(\d+) 个任务含未确认的日历扩展，任务已保留；/, '; $1 tasks contain unconfirmed calendar extensions and have been retained; ')
  return value
}

export function Sources({ sources, compact = false }: { sources: SourceStatus[]; compact?: boolean }) {
  const { language, t } = useI18n()
  if (compact) {
    const problems = sources.filter(source => source.state !== 'ok')
    return problems.length > 0 ? <div className="coverage-note"><AlertCircle size={15} /><span>{t(`${problems.length} 个数据来源存在覆盖限制，详情见「数据来源」。`, `${problems.length} data sources have limited coverage. See Data sources for details.`)}</span></div> : null
  }
  return <div className="source-list">{sources.map(source => <div className="source-row" key={source.id}><Database size={18} /><div><div className="source-title"><strong>{language === 'zh-CN' ? source.label : sourceLabels[source.label] ?? (source.id.startsWith('launchctl:') ? source.label.replace(/^launchd 运行状态 · /, 'launchd runtime status · ') : source.label)}</strong><Badge state={source.state} /></div><p>{language === 'zh-CN' ? source.detail : sourceDetail(source)}</p></div></div>)}</div>
}

export function Chart({ samples, field, label }: { samples: SystemSample[]; field: 'cpuPercent' | 'memoryPercent'; label: string }) {
  const { t } = useI18n()
  const width = 600, height = 125
  const start = samples[0]?.at ?? 0
  const end = samples.at(-1)?.at ?? start
  const points = samples.map(sample => `${end > start ? (sample.at - start) / (end - start) * width : width},${height - Math.max(0, Math.min(100, sample[field])) / 100 * height}`).join(' ')
  return <div className={`chart chart-${field}`}><div className="chart-axis"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t(`${label}，最近 ${samples.length} 次采样`, `${label}, last ${samples.length} samples`)}><path d={`M0,0 H${width} M0,${height / 2} H${width} M0,${height} H${width}`} className="chart-grid" />{samples.length > 1 && <><polygon points={`0,${height} ${points} ${width},${height}`} className="chart-area" /><polyline points={points} className="chart-line" /></>}</svg><div className="chart-time"><span>{samples.length > 1 ? t(`${Math.round((end - start) / 1000)} 秒前`, `${Math.round((end - start) / 1000)} seconds ago`) : t('收集趋势中', 'Collecting trend data')}</span><span>{t('现在', 'Now')}</span></div></div>
}

export function Meter({ label, value, detail, tone = 'green' }: { label: string; value: number | null; detail: string; tone?: string }) {
  return <div className={`meter meter-${tone}`}><div className="meter-title"><span>{label}</span><strong>{value === null ? '—' : `${value.toFixed(1)}%`}</strong></div><div className="meter-track" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} /></div><p>{detail}</p></div>
}
