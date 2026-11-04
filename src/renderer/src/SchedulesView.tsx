import { useMemo, useRef, useState } from 'react'
import { CalendarClock, Search, X } from 'lucide-react'
import type { ScheduledJob, ScheduleSnapshot } from '../../shared/types'
import { Badge, Empty, NativeSelect, Sources, time, useDetails } from './components'
import { useI18n } from './i18n'
import type { ResolvedLanguage } from '../../shared/settings'

const scheduleLabels: Record<string, string> = {
  '常驻 / 条件保活（非定时任务）': 'Persistent / conditional keep-alive (not scheduled)',
  '加载时运行（非定时任务）': 'Run when loaded (not scheduled)',
  '按需或事件触发（非定时任务）': 'On demand or event-triggered (not scheduled)',
  '已加载；标准目录中未发现对应 plist，触发方式未知': 'Loaded; no matching plist in standard directories; trigger unknown',
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

export function ScheduleTable({ jobs, onSelect, selectedId }: { jobs: ScheduledJob[]; onSelect: (job: ScheduledJob) => void; selectedId?: string | null }) {
  const { language, t } = useI18n()
  return <div className="table-scroll"><table className="data-table schedule-table">
    <thead><tr><th scope="col">{t('任务', 'Task')}</th><th scope="col">{t('执行计划', 'Schedule')}</th><th scope="col">{t('范围', 'Scope')}</th><th scope="col">{t('状态', 'Status')}</th></tr></thead>
    <tbody>{jobs.map(job => <tr key={job.id} data-selected={selectedId === job.id}>
      <td><button className="entity-button" aria-expanded={selectedId === undefined ? undefined : selectedId === job.id} aria-controls={selectedId === job.id ? 'schedule-task-details' : undefined} onClick={() => onSelect(job)}><span className="schedule-avatar"><CalendarClock size={17} aria-hidden="true" /></span><span className="entity-text"><strong title={job.name}>{job.name}</strong><small title={jobSource(job.source, language)}>{jobSource(job.source, language)}</small></span></button></td>
      <td className="schedule-value">{scheduleText(job.schedule, language)}</td>
      <td><span className="muted">{job.scope === 'user' ? t('用户', 'User') : t('系统', 'System')}</span></td>
      <td><Badge state={job.state} /></td>
    </tr>)}</tbody>
  </table></div>
}

export default function SchedulesView({ data, error }: { data: ScheduleSnapshot | null; error: string | null }) {
  const { language, t } = useI18n()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('scheduled')
  const [scope, setScope] = useState<'all' | 'personal' | ScheduledJob['scope']>('all')
  const [status, setStatus] = useState<'all' | ScheduledJob['state']>('all')
  const { selectedId, detailRef, select, close } = useDetails()
  const searchRef = useRef<HTMLInputElement>(null)
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
  const selected = data?.jobs.find(job => job.id === selectedId)
  const selectedVisible = selectedId !== null && filtered.some(job => job.id === selectedId)
  function closeDetails() {
    close()
    if (!selectedVisible) searchRef.current?.focus()
  }
  function clearFilters() {
    setKind('scheduled')
    setScope('all')
    setStatus('all')
    setQuery('')
    searchRef.current?.focus()
  }
  return <>
    <div className="toolbar schedule-toolbar">
      <div className="segmented" role="group" aria-label={t('任务类型', 'Task type')}>
        {[['scheduled', t('定时任务', 'Scheduled tasks')], ['services', t('服务 / 启动项', 'Services / Startup')], ['all', t('全部', 'All')]].map(([value, label]) => <button key={value} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>)}
      </div>
      <div className="toolbar-right">
        <label className="schedule-filter">{t('范围', 'Scope')}
          <NativeSelect aria-label={t('任务范围', 'Task scope')} aria-describedby={scope === 'personal' ? 'schedule-personal-help' : undefined} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
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
          <NativeSelect aria-label={t('任务状态', 'Task status')} value={status} onChange={event => setStatus(event.target.value as typeof status)}>
            <option value="all">{t('所有状态', 'All statuses')}</option>
            <option value="running">{t('运行中', 'Running')}</option>
            <option value="waiting">{t('等待触发', 'Waiting')}</option>
            <option value="disabled">{t('已停用', 'Disabled')}</option>
            <option value="unloaded">{t('未加载', 'Unloaded')}</option>
            <option value="unknown">{t('状态未知', 'Unknown')}</option>
          </NativeSelect>
        </label>
        <label className="search-field"><Search size={16} aria-hidden="true" /><input ref={searchRef} aria-label={t('搜索定时任务', 'Search scheduled tasks')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索任务或执行计划', 'Search tasks or schedules')} /></label>
      </div>
    </div>
    {scope === 'personal' && <p id="schedule-personal-help" className="footnote">{t('按任务元数据、个人命名及主目录脚本识别个人配置，排除苹果任务、应用更新器和调度器自身。无法确认归属的任务可在“所有范围”查看。', 'Personal configuration is identified from task metadata, personal naming and scripts in your home directory. Apple tasks, app updaters and schedulers themselves are excluded. Tasks with uncertain ownership remain under All scopes.')}</p>}
    <section className="panel schedule-panel" aria-label={t('任务列表', 'Task list')}>
      <div className="list-caption schedule-caption">
        <div className="schedule-result-summary">
          <span role="status" aria-live="polite" aria-atomic="true">{data ? t(`${filtered.length} 项${kind === 'scheduled' ? '定时任务' : kind === 'services' ? '服务 / 启动项' : '任务'}`, `${filtered.length} ${kind === 'scheduled' ? 'scheduled tasks' : kind === 'services' ? 'services / startup items' : 'tasks'}`) : error ? t('采集失败 · 数量未知', 'Collection failed · Count unknown') : t('正在读取 · 数量待确认', 'Loading · Count pending')}</span>
          {filtering && <button className="text-button" onClick={clearFilters}>{t('清除筛选', 'Clear filters')}</button>}
        </div>
        {data && <span>{t('采样于', 'Sampled at')} {time(data.collectedAt, language)}</span>}
      </div>
      {!data ? <Empty title={error ? t('尚未取得调度数据', 'Schedule data unavailable') : t('正在读取调度配置', 'Reading schedule configuration')}>{error ? t('请查看上方错误信息并重试。', 'Review the error above and retry.') : t('首次查询需要读取系统与用户任务。', 'The first query reads system and user tasks.')}</Empty> : filtered.length ? <ScheduleTable jobs={filtered} selectedId={selectedId} onSelect={job => select(job.id)} /> : <Empty title={t('没有匹配的任务', 'No matching tasks')}>{t('调整任务类型、范围、状态或搜索词。', 'Adjust the task type, scope, status or search.')}</Empty>}
    </section>
    {selectedId && <section id="schedule-task-details" ref={detailRef} tabIndex={-1} aria-label={t('任务详情', 'Task details')} className="detail-panel schedule-detail" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetails() } }}>
      <div className="section-heading"><h2>{selected?.name ?? t('任务已不在当前列表', 'Task no longer in the current list')}</h2><button className="icon-button" aria-label={t('关闭任务详情', 'Close task details')} onClick={closeDetails}><X size={18} /></button></div>
      {selected && !selectedVisible && <p className="footnote">{t('该任务不在当前筛选结果中，详情保留当前快照。', 'This task is outside the current filters. Its details remain available from the current snapshot.')}</p>}
      {selected && <dl className="detail-grid">
        <div><dt>{t('当前状态', 'Current status')}</dt><dd><Badge state={selected.state} /></dd></div>
        {selected.id.startsWith('hermes-job:') ? <>
          <div><dt>{t('最近执行结果', 'Last run result')}</dt><dd>{selected.lastRun ? t(...runResults[selected.lastRun.result]) : t('暂无执行记录', 'No run recorded')}</dd></div>
          {selected.lastRun?.at && <div><dt>{t('结果记录时间', 'Result recorded at')}</dt><dd>{new Date(selected.lastRun.at).toLocaleString(language)}</dd></div>}
        </> : <div><dt>{t('最近退出码', 'Last exit code')}</dt><dd>{selected.lastExitCode ?? t('来源未提供', 'Not provided by source')}</dd></div>}
        {selected.stateReason && <div className="span-2"><dt>{t('状态说明', 'Status details')}</dt><dd>{t(...stateReasons[selected.stateReason])}</dd></div>}
        <div className="span-2"><dt>{t('执行计划', 'Schedule')}</dt><dd>{scheduleText(selected.schedule, language)}</dd></div>
        <div className="span-2"><dt>{t('配置文件', 'Configuration file')}</dt><dd className="mono">{selected.file || t('来源未提供文件路径', 'Source did not provide a file path')}</dd></div>
        <div className="span-2"><dt>{t('可执行程序', 'Executable')}</dt><dd className="mono">{selected.executable || t('来源未提供', 'Not provided by source')}</dd></div>
        {selected.pid && <div><dt>{t('当前 PID', 'Current PID')}</dt><dd className="mono">{selected.pid}</dd></div>}
        {selected.nextRun && <div><dt>{t('下次计划', 'Next run')}</dt><dd>{new Date(selected.nextRun).toLocaleString(language)}</dd></div>}
      </dl>}
    </section>}
    {data && <Sources sources={data.sources} compact />}
    <p className="footnote">{t('定时任务数包括已识别的周期与日历调度配置（含停用项）。登录启动项与常驻服务单独列出；这里仅查看，不会执行或修改任务。', 'Scheduled task counts include recognized interval and calendar schedules, including disabled entries. Login items and persistent services are listed separately. This view does not run or modify tasks.')}</p>
  </>
}
