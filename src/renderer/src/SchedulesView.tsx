import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import CalendarClock from 'kubai-icons-react/icons/calendar-clock'
import Search from 'kubai-icons-react/icons/search'
import CircleX from 'kubai-icons-react/icons/circle-x'
import type { ScheduledJob, ScheduleSnapshot } from '../../shared/types'
import { Badge, CollectionStatus, Empty, NativeSelect, Sources, time } from './components'
import { useI18n } from './i18n'
import type { ResolvedLanguage } from '../../shared/settings'
import ScheduleHistory from './ScheduleHistory'
import TaskNotificationSubscription from './TaskNotificationSubscription'
import './schedule-details.css'
import { scheduleTarget, type NavigationIntent, type NavigationTarget } from '../../shared/navigation'
import { MAX_VIEW_QUERY_LENGTH, type ScheduleViewMemory, type ScheduleViewState, type ScrollPosition } from './view-state'
import { reportDesktopFailure } from './desktop-api'
import { isDesktopDocumentVisible } from './desktop-visibility'
import './detail-source-reasons.css'

const scheduleLabels: Record<string, string> = {
  '常驻 / 条件保活（非定时任务）': 'Persistent / conditional keep-alive (not scheduled)',
  '加载时运行（非定时任务）': 'Run when loaded (not scheduled)',
  '按需或事件触发（非定时任务）': 'On demand or event-triggered (not scheduled)',
  '标准目录中未发现对应 plist，触发方式未知': 'No matching plist in standard directories; trigger unknown',
  '休眠或上次仍运行时可能跳过': 'May be skipped while asleep or if the previous run is still active',
  '加载时也运行': 'Also run when loaded',
  '另有 KeepAlive 保活条件': 'Additional KeepAlive conditions',
  'cron 守护进程启动时运行（非定时任务）': 'Run when the cron daemon starts (not scheduled)',
  '每年 1 月 1 日 00:00': 'Every January 1 at 00:00', '每月 1 日 00:00': 'Every month on day 1 at 00:00',
  '每周日 00:00': 'Every Sunday at 00:00', '每日 00:00': 'Daily at 00:00', '每小时 00 分': 'Every hour at minute 00'
}

function scheduleText(value: string, language: ResolvedLanguage): string {
  if (language === 'zh-CN') return value
  if (scheduleLabels[value]) return scheduleLabels[value]
  const timezone = value.match(/^(.*)（(系统本地时间|CRON_TZ=[A-Za-z0-9_+\-\/]+（是否支持由本机 cron 决定）)）$/)
  if (timezone) return `${scheduleText(timezone[1], language)} (${timezone[2] === '系统本地时间' ? 'system local time' : timezone[2].replace('（是否支持由本机 cron 决定）', ' (support depends on the local cron daemon)')})`
  const cron = value.match(/^分 (\S+) · 时 (\S+) · 日 (\S+) · 月 (\S+) · 周 (\S+)（\* 为任意；日与周均受限时满足其一）(?:；(.*))?$/)
  if (cron) return `Minute ${cron[1]} · Hour ${cron[2]} · Day ${cron[3]} · Month ${cron[4]} · Weekday ${cron[5]} (* means any; either day or weekday matches when both are restricted)${cron[6] ? `; ${scheduleText(cron[6], language)}` : ''}`
  if (value.includes('；')) return value.split('；').map(part => scheduleText(part, language)).join('; ')
  if (value.startsWith('或 ')) return `or ${scheduleText(value.slice(2), language)}`
  const interval = value.match(/^每 ([\d.]+) (秒|分钟)$/)
  if (interval) return `Every ${interval[1]} ${interval[2] === '秒' ? 'seconds' : 'minutes'}`
  if (value.startsWith('单次：')) return `Once: ${value.slice(3)}`
  if (value.startsWith('首次执行不早于 ')) return `First run no earlier than ${value.slice('首次执行不早于 '.length)}`
  const calendar = value.match(/^(每月|\d+月)(每日|\d+日|周[日一二三四五六]|（\d+日或周[日一二三四五六]）) (每小时|\d+时)(每分钟|\d+分)$/)
  if (calendar) {
    const weekdays: Record<string, string> = { 周日: 'Sunday', 周一: 'Monday', 周二: 'Tuesday', 周三: 'Wednesday', 周四: 'Thursday', 周五: 'Friday', 周六: 'Saturday' }
    const day = calendar[2] === '每日' ? 'every day' : calendar[2].replace(/\d+日/g, day => `day ${day.slice(0, -1)}`).replace(/周[日一二三四五六]/g, day => weekdays[day]).replace('或', ' or ').replace('（', '(').replace('）', ')')
    return `${calendar[1] === '每月' ? 'Every month' : `Month ${calendar[1].slice(0, -1)}`}, ${day}, ${calendar[3] === '每小时' ? 'every hour' : `hour ${calendar[3].slice(0, -1)}`}, ${calendar[4] === '每分钟' ? 'every minute' : `minute ${calendar[4].slice(0, -1)}`}`
  }
  const extensions = value.match(/^原始扩展字段 (.*)（是否生效未确认）$/)
  if (extensions) return `Raw extension fields ${extensions[1].replaceAll('=未解析的非整数值', '=unparsed non-integer value')} (effect unconfirmed)`
  return value
}

function jobSource(source: string, language: ResolvedLanguage): string {
  if (language === 'zh-CN') return source
  const labels: Record<string, string> = {
    'crontab · 当前用户': 'crontab · Current user', 'launchd · 运行时服务': 'launchd · Runtime service',
    'launchd · OMP 任务': 'launchd · OMP task', 'OMP 任务 · 未发现 launchd 配置': 'OMP task · No launchd configuration found',
    'launchd · Hermes 调度器': 'launchd · Hermes scheduler', 'Hermes 任务（由调度器执行）': 'Hermes task (run by scheduler)'
  }
  return labels[source] ?? source
}

const stateReasons: Record<NonNullable<ScheduledJob['stateReason']>, [string, string]> = {
  'hermes-read-failed': ['无法读取 Hermes 执行状态，请在「数据来源」查看原因。', 'Hermes execution status could not be read. See Data sources for the cause.'],
  'hermes-dispatching': ['Hermes 已领取本次任务，尚未确认开始执行。', 'Hermes has claimed this run; execution has not been confirmed.'],
  'hermes-unconfirmed': ['执行记录、心跳或进程信息不足，无法确认任务是否仍在运行。', 'The execution record, heartbeat or process information is insufficient to confirm an active run.'],
  'hermes-state-unsupported': ['Hermes 未提供可识别的调度状态。', 'Hermes did not provide a recognized scheduling state.']
}
const runResults: Record<NonNullable<ScheduledJob['lastRun']>['result'], [string, string]> = {
  succeeded: ['执行成功', 'Succeeded'], failed: ['执行失败', 'Failed'],
  'delivery-failed': ['执行成功，投递失败', 'Succeeded; delivery failed'],
  blocked: ['配置阻止执行', 'Blocked by configuration'], unknown: ['结果未确认', 'Result unconfirmed']
}

export function ScheduleTable({ jobs, onSelect, selectedId, memory }: { jobs: ScheduledJob[]; onSelect: (job: ScheduledJob, trigger: HTMLButtonElement) => void; selectedId?: string | null; memory?: ScrollPosition }) {
  const { language, t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || !memory) return
    scroller.scrollTop = memory.top
    scroller.scrollLeft = memory.left
    const save = () => { memory.top = scroller.scrollTop; memory.left = scroller.scrollLeft }
    save()
    scroller.addEventListener('scroll', save, { passive: true })
    return () => { save(); scroller.removeEventListener('scroll', save) }
  }, [memory])
  return <div ref={scrollRef} className="table-scroll"><table className="data-table schedule-table">
    <thead><tr><th scope="col">{t('任务', 'Task')}</th><th scope="col">{t('执行计划', 'Schedule')}</th><th scope="col">{t('范围', 'Scope')}</th><th scope="col">{t('状态', 'Status')}</th></tr></thead>
    <tbody>{jobs.map(job => <tr key={job.id} data-job-id={job.id} data-selected={selectedId === job.id} onClick={event => {
      const trigger = event.currentTarget.querySelector('button')
      if (trigger) onSelect(job, trigger)
    }}>
      <td><button className="entity-button" aria-expanded={selectedId === undefined ? undefined : selectedId === job.id} aria-controls={selectedId === job.id ? 'schedule-task-details' : undefined} onClick={event => { event.stopPropagation(); onSelect(job, event.currentTarget) }}><span className="schedule-avatar"><CalendarClock trigger="none" size={17} aria-hidden="true" /></span><span className="entity-text"><strong title={job.name}>{job.name}</strong><small title={jobSource(job.source, language)}>{jobSource(job.source, language)}</small></span></button></td>
      <td className="schedule-value">{scheduleText(job.schedule, language)}</td>
      <td><span className="muted">{job.scope === 'user' ? t('用户', 'User') : t('系统', 'System')}</span></td>
      <td><Badge state={job.state} /></td>
    </tr>)}</tbody>
  </table></div>
}

function ScheduleSourceReason({ job, sources, onSource }: {
  job: ScheduledJob; sources: ScheduleSnapshot['sources']; onSource: (target: Extract<NavigationTarget, { kind: 'source' }>) => void
}) {
  const { t } = useI18n()
  const hermes = job.id.startsWith('hermes-job:')
  const cron = job.id.startsWith('crontab:')
  const launchd = job.id.startsWith('launchd:')
  const metadataOnly = job.source === 'OMP 任务 · 未发现 launchd 配置'
  const omp = metadataOnly || job.source === 'launchd · OMP 任务'
  if (hermes && job.state !== 'unknown' && !job.stateReason) return null
  if (!hermes && !cron && !launchd && !omp) return job.state === 'unknown'
    ? <p className="detail-source-reason">{t('当前状态未知，且未识别到可定位的任务来源；无法确认其状态与历史能力。', 'The current state is unknown and no specific task source has been identified. Status and history capabilities are unconfirmed.')}</p>
    : null
  const sourceLinks: { id: string; label: string }[] = []
  if (hermes) sourceLinks.push({ id: 'hermes-runtime', label: t('查看 Hermes 执行状态来源', 'View Hermes execution status source') })
  if (cron) sourceLinks.push({ id: 'crontab', label: t('查看 crontab 状态与历史限制', 'View crontab status and history limits') })
  if (launchd && !metadataOnly) {
    const domainIds = job.scope === 'system' ? ['launchctl:system'] : sources.filter(source => /^launchctl:(?:gui|user)\/\d+$/.test(source.id)).map(source => source.id)
    for (const id of domainIds) sourceLinks.push({ id, label: t(`查看 launchd ${id.slice('launchctl:'.length)} 状态来源`, `View launchd ${id.slice('launchctl:'.length)} status source`) })
  }
  if (omp) sourceLinks.push({ id: 'omp-cron', label: t('查看 OMP 任务元数据', 'View OMP task metadata') })
  return <div className="detail-source-reason">
    {hermes ? !job.stateReason && <p>{t('尚无足够的执行记录、心跳或进程证据确认当前状态。', 'Execution records, heartbeat or process evidence do not yet confirm the current state.')}</p>
      : cron ? <p>{t('crontab 只提供调度配置，无法确认单个任务当前是否运行，也不提供逐次执行历史。', 'crontab provides schedule configuration only. It does not confirm whether an individual task is running or provide per-run execution history.')}</p>
        : metadataOnly ? <p>{t('仅发现 OMP 任务元数据，未发现对应的 launchd 配置；元数据不证明任务已执行，也不提供逐次执行历史。', 'Only OMP task metadata was found, without a matching launchd configuration. Metadata does not prove the task has run or provide per-run execution history.')}</p>
        : <><p>{job.state === 'unknown'
          ? t('尚未确认该任务的 launchd 运行状态。launchd 当前状态和最近退出码不提供逐次执行历史。', 'The launchd runtime state of this task is unconfirmed. Current launchd status and the last exit code do not provide per-run execution history.')
          : t('launchd 当前状态和最近退出码不提供逐次执行历史。', 'Current launchd status and the last exit code do not provide per-run execution history.')}</p>
          {omp && <p>{t('OMP 任务元数据用于说明任务配置，不代表任务已执行。', 'OMP task metadata describes the task configuration; it does not prove the task has run.')}</p>}
          {job.scope === 'user' && sourceLinks.filter(source => source.id.startsWith('launchctl:')).length > 1 && <p>{t('任务未标明具体用户域，可分别查看以下实际采集域的诊断。', 'The task does not identify a specific user domain. Inspect the diagnostics for each collected domain below.')}</p>}
          {launchd && !metadataOnly && job.scope === 'user' && !sourceLinks.some(source => source.id.startsWith('launchctl:')) && <p>{t('当前快照未提供用户 launchd 域来源，无法定位其状态诊断。', 'The current snapshot contains no user launchd domain source, so its status diagnostics cannot be located.')}</p>}
        </>}
    <div className="detail-source-links">{sourceLinks.map(source => <button key={source.id} type="button" className="text-button detail-source-button" onClick={() => onSource({ kind: 'source', section: 'schedules', id: source.id })}>{source.label}</button>)}</div>
  </div>
}

export default memo(function SchedulesView({ data, enabled, error, intent, onConsumed, view, onViewChange, memory, onSource }: {
  data: ScheduleSnapshot | null
  enabled: boolean
  error: string | null
  intent: NavigationIntent | null
  onConsumed: (sequence: number) => void
  view: ScheduleViewState
  onViewChange: Dispatch<SetStateAction<ScheduleViewState>>
  memory: ScheduleViewMemory
  onSource: (target: Extract<NavigationTarget, { kind: 'source' }>) => void
}) {
  const { language, t } = useI18n()
  const { query, kind, scope, status, selectedId, identity, unavailable, open, historyOffset } = view
  const updateView = useCallback((patch: Partial<ScheduleViewState>) => onViewChange(current => ({ ...current, ...patch })), [onViewChange])
  const consumed = useRef(0)
  const revealPending = useRef<{ id: string; identity: string } | null>(null)
  const focusPending = useRef(false)
  const restoreDetail = useRef<ScrollPosition | null>(open && !unavailable ? { ...memory.detail } : null)
  const [documentHidden, setDocumentHidden] = useState(() => !isDesktopDocumentVisible())
  const [retainedJob, setRetainedJob] = useState<ScheduledJob | undefined>(undefined)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const filtering = kind !== 'scheduled' || scope !== 'all' || status !== 'all' || Boolean(query.trim())
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (data?.jobs ?? []).filter(job => {
      const scheduled = job.kind === 'calendar' || job.kind === 'interval'
      if (kind === 'scheduled' && !scheduled || kind === 'services' && scheduled) return false
      if (scope === 'personal' ? job.origin !== 'personal' : scope !== 'all' && job.scope !== scope) return false
      if (status !== 'all' && job.state !== status) return false
      return !search || job.name.toLowerCase().includes(search) || jobSource(job.source, language).toLowerCase().includes(search) || scheduleText(job.schedule, language).toLowerCase().includes(search)
    })
  }, [data, query, kind, scope, status, language])
  const candidate = data?.jobs.find(job => job.id === selectedId)
  const selected = !unavailable && candidate && scheduleTarget(candidate).identity === identity ? candidate : undefined
  const selectedVisible = Boolean(selected && filtered.some(job => job.id === selectedId))
  const displayed = open ? selected : retainedJob
  const saveDetailScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller || restoreDetail.current) return
    memory.detail.top = scroller.scrollTop
    memory.detail.left = scroller.scrollLeft
  }, [memory])
  const restoreDetailScroll = useCallback(() => {
    const position = restoreDetail.current
    const scroller = scrollRef.current
    if (!position || !scroller) return
    scroller.scrollTop = position.top
    scroller.scrollLeft = position.left
    restoreDetail.current = null
    saveDetailScroll()
  }, [saveDetailScroll])
  function beginDetailInteraction() {
    restoreDetail.current = null
    saveDetailScroll()
  }
  const closeDetails = useCallback(() => {
    void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
    updateView({ open: false })
    const trigger = selectedVisible && selectedId
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-job-id="${CSS.escape(selectedId)}"] button`)
      : null
    if (trigger) trigger.focus({ preventScroll: true })
    else searchRef.current?.focus({ preventScroll: true })
  }, [selectedVisible, selectedId, updateView])
  function selectJob(job: ScheduledJob) {
    revealPending.current = null
    if (open && !unavailable && selectedId === job.id && identity === scheduleTarget(job).identity) {
      closeRef.current?.focus({ preventScroll: true })
      return
    }
    void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
    restoreDetail.current = null
    memory.detail.top = 0
    memory.detail.left = 0
    focusPending.current = true
    updateView({ selectedId: job.id, identity: scheduleTarget(job).identity, unavailable: false, open: true, historyOffset: 0 })
  }
  useLayoutEffect(() => {
    if (!intent || intent.target.kind !== 'schedule' || consumed.current === intent.sequence) return
    consumed.current = intent.sequence
    revealPending.current = { id: intent.target.id, identity: intent.target.identity }
    if (!open || unavailable || selectedId !== intent.target.id || identity !== intent.target.identity) {
      void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
      restoreDetail.current = null
      memory.detail.top = 0
      memory.detail.left = 0
      focusPending.current = true
      updateView({ selectedId: intent.target.id, identity: intent.target.identity, unavailable: false, open: true, historyOffset: 0 })
    } else closeRef.current?.focus({ preventScroll: true })
    onConsumed(intent.sequence)
  }, [intent, identity, selectedId, open, unavailable, onConsumed, updateView, memory])
  useLayoutEffect(() => {
    const target = revealPending.current
    if (!target || !selectedVisible || selectedId !== target.id || identity !== target.identity) return
    revealPending.current = null
    listRef.current?.querySelector<HTMLButtonElement>(`[data-job-id="${CSS.escape(target.id)}"] button`)?.scrollIntoView({ block: 'center' })
  }, [selectedVisible, selectedId, identity, filtered])
  useLayoutEffect(() => {
    if (!open) return
    const scroller = scrollRef.current
    if (focusPending.current) {
      focusPending.current = false
      if (scroller) { scroller.scrollTop = 0; scroller.scrollLeft = 0 }
      closeRef.current?.focus({ preventScroll: true })
    } else if (restoreDetail.current && scroller && selected) {
      scroller.scrollTop = restoreDetail.current.top
      scroller.scrollLeft = restoreDetail.current.left
    }
    if (unavailable) {
      restoreDetail.current = null
      if (scroller) { scroller.scrollTop = 0; scroller.scrollLeft = 0 }
    }
  }, [open, selectedId, identity, selected, unavailable])
  useLayoutEffect(() => {
    if (open || unavailable) setRetainedJob(open ? selected : undefined)
  }, [open, selected, unavailable])
  useEffect(() => {
    if (open || !retainedJob) return
    const drawer = drawerRef.current
    if (!drawer) { setRetainedJob(undefined); return }
    const style = getComputedStyle(drawer)
    const seconds = (value: string) => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)
    const delays = style.transitionDelay.split(',').map(seconds)
    const duration = Math.max(0, ...style.transitionDuration.split(',').map((value, index) => seconds(value) + delays[index % delays.length]))
    const timer = window.setTimeout(() => setRetainedJob(undefined), duration)
    return () => window.clearTimeout(timer)
  }, [open, retainedJob, documentHidden])
  useLayoutEffect(() => () => saveDetailScroll(), [saveDetailScroll])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeDetails()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeDetails])
  useEffect(() => {
    if (!open) return
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      const drawer = drawerRef.current
      if (!(target instanceof HTMLElement) || !drawer || drawer.contains(target)) return
      const bounds = target.getBoundingClientRect()
      const panel = drawer.getBoundingClientRect()
      const x = bounds.left + bounds.width / 2
      const y = bounds.top + bounds.height / 2
      if (x >= panel.left && x < panel.right && y >= panel.top && y < panel.bottom) {
        void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
        updateView({ open: false })
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open, updateView])
  useEffect(() => {
    const onVisibility = () => {
      const hidden = !isDesktopDocumentVisible()
      if (hidden) void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
      setDocumentHidden(hidden)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      void window.monitor?.cancelScheduleHistory().catch(reportDesktopFailure)
    }
  }, [])
  function clearFilters() {
    updateView({ kind: 'scheduled', scope: 'all', status: 'all', query: '' })
    searchRef.current?.focus()
  }
  return <>
    <div className="toolbar schedule-toolbar">
      <div className="segmented" role="group" aria-label={t('任务类型', 'Task type')}>
        {([['scheduled', t('定时任务', 'Scheduled tasks')], ['services', t('服务 / 启动项', 'Services / Startup')], ['all', t('全部', 'All')]] as const).map(([value, label]) => <button key={value} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => updateView({ kind: value })}>{label}</button>)}
      </div>
      <div className="toolbar-right">
        <label className="schedule-filter">{t('范围', 'Scope')}
          <NativeSelect aria-label={t('任务范围', 'Task scope')} aria-describedby={scope === 'personal' ? 'schedule-personal-help' : undefined} value={scope} onChange={event => updateView({ scope: event.target.value as typeof scope })}>
            <option value="all">{t('所有范围', 'All scopes')}</option>
            <optgroup label={t('按配置来源', 'By configuration source')}>
              <option value="personal">{t('个人配置', 'Personal configuration')}</option>
            </optgroup>
            <optgroup label={t('按运行范围', 'By execution scope')}>
              <option value="user">{t('当前用户', 'Current user')}</option>
              <option value="system">{t('系统', 'System')}</option>
            </optgroup>
          </NativeSelect>
        </label>
        <label className="schedule-filter">{t('状态', 'Status')}
          <NativeSelect aria-label={t('任务状态', 'Task status')} value={status} onChange={event => updateView({ status: event.target.value as typeof status })}>
            <option value="all">{t('所有状态', 'All statuses')}</option>
            <option value="running">{t('运行中', 'Running')}</option>
            <option value="waiting">{t('等待触发', 'Waiting')}</option>
            <option value="disabled">{t('已停用', 'Disabled')}</option>
            <option value="unloaded">{t('未加载', 'Unloaded')}</option>
            <option value="unknown">{t('状态未知', 'Unknown')}</option>
          </NativeSelect>
        </label>
        <label className="search-field"><Search trigger="none" size={16} aria-hidden="true" /><input ref={searchRef} aria-label={t('搜索定时任务', 'Search scheduled tasks')} maxLength={MAX_VIEW_QUERY_LENGTH} value={query} onChange={event => updateView({ query: event.target.value })} placeholder={t('搜索任务或执行计划', 'Search tasks or schedules')} /></label>
      </div>
    </div>
    {scope === 'personal' && <p id="schedule-personal-help" className="footnote">{t('按任务元数据、个人命名及主目录脚本识别个人配置，排除苹果任务、应用更新器和调度器自身。无法确认归属的任务可在“所有范围”查看。', 'Personal configuration is identified from task metadata, personal naming and scripts in your home directory. Apple tasks, app updaters and schedulers themselves are excluded. Tasks with uncertain ownership remain under All scopes.')}</p>}
    <section ref={listRef} className="panel schedule-panel" aria-label={t('任务列表', 'Task list')}>
      <div className="list-caption schedule-caption">
        <div className="schedule-result-summary">
          <span role="status" aria-live="polite" aria-atomic="true">{data ? t(`${filtered.length} 项${kind === 'scheduled' ? '定时任务' : kind === 'services' ? '服务 / 启动项' : '任务'}`, `${filtered.length} ${kind === 'scheduled' ? 'scheduled tasks' : kind === 'services' ? 'services / startup items' : 'tasks'}`) : !enabled ? t('采集已停用 · 数量未知', 'Collection disabled · Count unknown') : error ? t('采集失败 · 数量未知', 'Collection failed · Count unknown') : t('正在读取 · 数量待确认', 'Loading · Count pending')}</span>
          {filtering && <button className="text-button" onClick={clearFilters}>{t('清除筛选', 'Clear filters')}</button>}
        </div>
        {data && <span>{t('采样于', 'Sampled at')} {time(data.collectedAt, language)}</span>}
      </div>
      {!data ? <Empty title={!enabled ? t('任务采集已停用', 'Schedule collection disabled') : error ? t('尚未取得调度数据', 'Schedule data unavailable') : t('正在读取调度配置', 'Reading schedule configuration')}>{!enabled ? t('尚无快照。可在数据来源中开启采集；真实任务继续运行。', 'No snapshot yet. Enable collection in Data sources; actual tasks keep running.') : error ? t('请查看上方错误信息并重试。', 'Review the error above and retry.') : t('首次查询需要读取系统与用户任务。', 'The first query reads system and user tasks.')}</Empty> : filtered.length ? <ScheduleTable jobs={filtered} selectedId={open && selected ? selectedId : null} onSelect={selectJob} memory={memory.list} /> : <Empty title={t('没有匹配的任务', 'No matching tasks')}>{t('调整任务类型、范围、状态或搜索词。', 'Adjust the task type, scope, status or search.')}</Empty>}
    </section>
    <aside ref={drawerRef} id="schedule-task-details" data-job-id={selectedId} className="schedule-drawer" data-open={open} data-motion-paused={documentHidden} inert={!open} aria-hidden={!open} aria-labelledby="schedule-drawer-title" role="dialog" aria-modal="false">
      <header className="schedule-drawer-header">
        <h2 id="schedule-drawer-title">{t('任务详情', 'Task details')}</h2>
        <button ref={closeRef} className="icon-button" aria-label={t('关闭任务详情', 'Close task details')} title={t('关闭任务详情 (Esc)', 'Close task details (Esc)')} onClick={closeDetails}><CircleX trigger="none" size={18} aria-hidden="true" /></button>
      </header>
      <div ref={scrollRef} className="schedule-drawer-scroll" onScroll={() => { if (open && selected) saveDetailScroll() }} onWheel={beginDetailInteraction} onTouchStart={beginDetailInteraction} onPointerDown={beginDetailInteraction} onKeyDownCapture={event => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) beginDetailInteraction()
      }}>
        <h3 className="schedule-drawer-name">{displayed?.name ?? t('任务已不在当前列表', 'Task no longer in the current list')}</h3>
        <CollectionStatus enabled={enabled} collectedAt={data?.collectedAt} />
        {displayed && <p className="schedule-drawer-source">{jobSource(displayed.source, language)}</p>}
        {displayed && !selectedVisible && <p className="footnote">{t('该任务不在当前筛选结果中，详情保留当前快照。', 'This task is outside the current filters. Its details remain available from the current snapshot.')} <button className="text-button" onClick={() => { updateView({ kind: 'all', scope: 'all', status: 'all', query: '' }); revealPending.current = selectedId && identity ? { id: selectedId, identity } : null; closeRef.current?.focus({ preventScroll: true }) }}>{t('清除筛选并定位', 'Clear filters and locate')}</button></p>}
        {!displayed && <p className="footnote">{t('最新采集中该任务已不存在或身份已变化。关闭详情后可搜索其他任务。', 'This task is missing from the latest collection or its identity has changed. Close the details to search for another task.')}</p>}
        {displayed && <>
          <dl className="schedule-drawer-metadata">
            <div><dt>{t('当前状态', 'Current status')}</dt><dd><Badge state={displayed.state} /></dd></div>
            {displayed.id.startsWith('hermes-job:') ? <>
              <div><dt>{t('最近执行结果', 'Last run result')}</dt><dd>{displayed.lastRun ? t(...runResults[displayed.lastRun.result]) : t('暂无执行记录', 'No run recorded')}</dd></div>
              {displayed.lastRun?.at && <div><dt>{t('结果记录时间', 'Result recorded at')}</dt><dd>{new Date(displayed.lastRun.at).toLocaleString(language)}</dd></div>}
            </> : <div><dt>{t('最近退出码', 'Last exit code')}</dt><dd>{displayed.lastExitCode ?? t('来源未提供', 'Not provided by source')}</dd></div>}
            {displayed.stateReason && <div><dt>{t('状态说明', 'Status details')}</dt><dd>{t(...stateReasons[displayed.stateReason])}</dd></div>}
            <div><dt>{t('执行计划', 'Schedule')}</dt><dd>{scheduleText(displayed.schedule, language)}</dd></div>
            <div><dt>{t('运行范围', 'Execution scope')}</dt><dd>{displayed.scope === 'user' ? t('当前用户', 'Current user') : t('系统', 'System')}</dd></div>
            <div><dt>{t('配置文件', 'Configuration file')}</dt><dd className="mono">{displayed.file || t('来源未提供文件路径', 'Source did not provide a file path')}</dd></div>
            <div><dt>{t('可执行程序', 'Executable')}</dt><dd className="mono">{displayed.executable || t('来源未提供', 'Not provided by source')}</dd></div>
            {displayed.pid && <div><dt>{t('当前 PID', 'Current PID')}</dt><dd className="mono">{displayed.pid}</dd></div>}
            {displayed.nextRun && <div><dt>{t('下次计划', 'Next run')}</dt><dd>{new Date(displayed.nextRun).toLocaleString(language)}</dd></div>}
          </dl>
          <ScheduleSourceReason job={displayed} sources={data?.sources ?? []} onSource={onSource} />
          {open && selected && <TaskNotificationSubscription key={`notification:${identity}`} job={selected} />}
          {open && selected && <ScheduleHistory key={identity} jobId={selected.id} enabled={enabled} active={!documentHidden} offset={historyOffset} onOffsetChange={offset => updateView({ historyOffset: offset })} onSettled={restoreDetailScroll} />}
        </>}
      </div>
    </aside>
    {data && <Sources sources={data.sources} compact enabled={enabled} />}
    <p className="footnote">{t('定时任务数包括已识别的周期与日历调度配置（含停用项）。登录启动项与常驻服务单独列出；这里仅查看，不会执行或修改任务。', 'Scheduled task counts include recognized interval and calendar schedules, including disabled entries. Login items and persistent services are listed separately. This view does not run or modify tasks.')}</p>
  </>
})
