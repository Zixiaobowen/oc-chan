import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, Bot, CalendarClock, ChevronRight, CircleHelp, Database, LayoutDashboard, Menu as MenuIcon, Monitor, Pause, Play, RefreshCw, Server, Settings } from 'lucide-react'
import { AGENT_DISCOVERY_INTERVAL_MS, SAMPLING_INTERVALS, type MonitorSection, type MonitorSnapshot, type MonitorUpdate } from '../../shared/types'
import AgentsView, { AgentTable } from './AgentsView'
import SchedulesView, { ScheduleTable } from './SchedulesView'
import SystemView from './SystemView'
import SettingsView from './SettingsView'
import { useI18n } from './i18n'
import { bytes, CollectorError, duration, Empty, Meter, SectionHeader, Sources, time } from './components'

type Page = 'overview' | 'agents' | 'schedules' | 'system' | 'sources' | 'settings'
const initial: MonitorSnapshot = {
  agents: { data: null, error: null, refreshing: false },
  schedules: { data: null, error: null, refreshing: false },
  system: { data: null, error: null, refreshing: false }
}

export default function App() {
  const { t, language } = useI18n()
  const displayTime = (value?: string) => time(value, language)
  const pages = [
    { id: 'overview', label: t('本机概览', 'Overview'), icon: LayoutDashboard, description: t('Agent、调度任务与系统资源的当前状态。', 'The current state of agents, scheduled tasks and system resources.') },
    { id: 'agents', label: t('Agent 与子代理', 'Agents'), icon: Bot, description: t('在画布中查看 Agent 父子关系，定位项目与运行状态。', 'Explore agent relationships, projects and runtime status on the canvas.') },
    { id: 'schedules', label: t('定时任务', 'Scheduled tasks'), icon: CalendarClock, description: t('本机调度清单，让周期任务与常驻服务各归其位。', 'Local schedules, with recurring tasks and persistent services separated.') },
    { id: 'system', label: t('系统监控', 'System monitor'), icon: Activity, description: t('持续采样 CPU、内存、磁盘与网络。', 'Continuous CPU, memory, disk and network sampling.') },
    { id: 'sources', label: t('数据来源', 'Data sources'), icon: Database, description: t('每个数字从哪里来，哪些范围尚不可见。', 'Where each number comes from and what remains outside visibility.') },
    { id: 'settings', label: t('设置', 'Settings'), icon: Settings, description: t('调整外观、文字与桌面行为。', 'Adjust appearance, typography and desktop behavior.') }
  ] as const
  const [page, setPage] = useState<Page>('overview')
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const navigation = useRef<HTMLElement>(null)
  const navigationToggle = useRef<HTMLButtonElement>(null)
  const navigationFocus = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState(initial)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const paused = pausedAt !== null
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [visible, setVisible] = useState(!document.hidden)
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const change = () => {
      const focused = document.activeElement
      // Capture focus before the controlled layout hides either navigation surface.
      navigationFocus.current = focused instanceof HTMLElement ? focused : null
      setCompactNavigation(media.matches)
    }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useLayoutEffect(() => {
    const previous = navigationFocus.current
    if (!previous) return
    navigationFocus.current = null
    if (!navigation.current?.contains(previous) && previous !== navigationToggle.current) return
    const next = compactNavigation ? navigationToggle.current
      : navigation.current?.contains(previous) ? previous
      : navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')
    next?.focus({ preventScroll: true })
  }, [compactNavigation])

  function navigate(next: Page) {
    setPage(next)
    if (navigation.current?.matches(':popover-open')) navigation.current.hidePopover()
  }
  useEffect(() => {
    const api = window.monitor
    if (!api) { setBridgeError('Desktop data connection unavailable / 未连接桌面数据接口'); return }
    let active = true
    const received = new Set<MonitorSection>()
    const onUpdate = (update: MonitorUpdate) => {
      if (!active) return
      received.add(update.section)
      setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
      if (received.has('agents') && received.has('schedules') && received.has('system')) setBridgeError(null)
    }
    const unsubscribe = paused ? () => {} : api.subscribe(onUpdate)
    if (!paused) void api.snapshot().then(data => {
      if (!active) return
      // Subscribe first; a slower initial read must not replace newer section events.
      setSnapshot(previous => ({
        agents: received.has('agents') ? previous.agents : data.agents,
        schedules: received.has('schedules') ? previous.schedules : data.schedules,
        system: received.has('system') ? previous.system : data.system
      }))
      setBridgeError(null)
    }).catch(error => { if (active) setBridgeError(String(error)) })
    return () => { active = false; unsubscribe() }
  }, [paused])
  useEffect(() => {
    const updateVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  useEffect(() => { content.current?.scrollTo({ top: 0 }) }, [page])

  async function refresh() {
    if (!window.monitor) return
    if (page === 'schedules' && document.activeElement?.closest('.error-notice')) {
      content.current?.querySelector<HTMLInputElement>('.schedule-toolbar input')?.focus()
    }
    try { await window.monitor.refresh(); setBridgeError(null) }
    catch (error) { setBridgeError(String(error)) }
  }
  const agents = snapshot.agents.data
  const schedules = snapshot.schedules.data
  const system = snapshot.system.data
  const agentSourceError = agents?.sources.find(source => source.state === 'error')
  const agentError = snapshot.agents.error || (agentSourceError ? `${agentSourceError.label}: ${agentSourceError.detail}` : null)
  const mainCount = agents?.agents.filter(agent => agent.kind === 'main').length
  const subCount = agents?.activeSubagentCount
  const scheduled = schedules?.jobs.filter(job => ['calendar', 'interval'].includes(job.kind))
  const userScheduled = scheduled?.filter(job => job.scope === 'user')
  const sourceGroups = [
    { title: t('Agent 与子代理', 'Agents'), sources: agents?.sources ?? [], state: snapshot.agents },
    { title: t('定时任务', 'Scheduled tasks'), sources: schedules?.sources ?? [], state: snapshot.schedules },
    { title: t('系统监控', 'System monitor'), sources: system?.sources ?? [], state: snapshot.system }
  ]
  const issues = sourceGroups.reduce((count, group) => count + group.sources.filter(source => source.state !== 'ok').length + Number(Boolean(group.state.error)), 0)
  const currentPage = pages.find(item => item.id === page)!
  const section = page === 'agents' || page === 'system' || page === 'schedules' ? page : undefined
  const sampling = section ? snapshot[section] : undefined
  const samplingError = bridgeError || (section === 'agents' ? agentError : sampling?.error)
  const collecting = sampling ? sampling.refreshing : Object.values(snapshot).some(state => state.refreshing)
  const samplingDetail = section === 'agents'
    ? samplingError ? t('会话更新异常 · 可重试', 'Session update failed · Retry available') : t(`会话事件订阅 · ${collecting && !paused ? '连接中' : '持续更新'}`, `Session events · ${collecting && !paused ? 'Connecting' : 'Live'}`)
    : section
      ? t(`每 ${SAMPLING_INTERVALS[section] / 1000} 秒 · ${collecting && !paused ? '采集中' : `最近成功 ${displayTime(sampling?.data?.collectedAt)}`}`, `Every ${SAMPLING_INTERVALS[section] / 1000}s · ${collecting && !paused ? 'Collecting' : `Last success ${displayTime(sampling?.data?.collectedAt)}`}`)
      : t(`Agent 事件订阅 · 系统 ${SAMPLING_INTERVALS.system / 1000}s · 调度 ${SAMPLING_INTERVALS.schedules / 1000}s`, `Agent events · System ${SAMPLING_INTERVALS.system / 1000}s · Schedules ${SAMPLING_INTERVALS.schedules / 1000}s`)
  const agentEvidenceCurrent = !agentError && !bridgeError
  const agentMotion = !paused && visible && agentEvidenceCurrent
  const previewAgents = agents?.agents.slice(0, 5) ?? []
  const previewJobs = [...(scheduled ?? [])].sort((a, b) => Number(a.scope === 'system') - Number(b.scope === 'system')).slice(0, 4)
  return <div className="app-shell" data-compact-navigation={compactNavigation} data-agent-evidence={agentEvidenceCurrent ? 'current' : 'stale'} data-agent-motion={agentMotion ? 'running' : 'paused'} data-display-live={!paused && visible}>
    <div className="window-drag" />
    <aside ref={navigation} id="main-navigation" className="sidebar" popover={compactNavigation ? 'auto' : undefined}>
      <div className="brand"><span className="brand-mark"><Activity size={23} strokeWidth={2.2} /></span><div><strong>OC Chan</strong><span>{t('本机运行观察', 'Local monitor')}</span></div></div>
      <nav aria-label={t('主导航', 'Main navigation')}>{pages.filter(item => item.id !== 'sources' && item.id !== 'settings').map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><item.icon size={18} /><span>{item.label}</span>{item.id === 'agents' && agents && <small>{agents.agents.length}</small>}{item.id === 'schedules' && scheduled && <small>{scheduled.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${page === 'sources' ? 'selected' : ''}`} onClick={() => navigate('sources')} aria-current={page === 'sources' ? 'page' : undefined}><Database size={18} /><span>{t('数据来源', 'Data sources')}</span>{issues > 0 && <small className="warning-count">{issues}</small>}</button>
        <button className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')} aria-current={page === 'settings' ? 'page' : undefined}><Settings size={18} /><span>{t('设置', 'Settings')}</span></button>
        <div className="device-block"><span className="device-icon"><Monitor size={18} /></span><div><strong title={system?.hostname}>{system?.hostname || t('此 Mac', 'This Mac')}</strong><span>{t('本地采集 · 只读访问', 'Local · Read-only monitoring')}</span></div></div>
      </div>
    </aside>
    <div className="workspace"><header className="topbar"><button ref={navigationToggle} className="navigation-toggle" popoverTarget="main-navigation" aria-label={t('主导航', 'Main navigation')} title={t('主导航', 'Main navigation')}><MenuIcon size={20} aria-hidden="true" /></button><div className="breadcrumb">{t('工作台', 'Workspace')}<ChevronRight size={14} /><span>{currentPage.label}</span></div><div className={`live-state ${paused || samplingError ? 'paused' : ''}`}><span className="status-dot" />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : t('实时显示已开启', 'Live display enabled')}</div></header>
      <main ref={content} className="main-content"><div className="page-heading"><div><h1>{currentPage.label}</h1><p>{currentPage.description}</p></div>{page !== 'settings' && <div className="page-actions">
        <div className={`sampling-status${paused || samplingError ? ' is-paused' : ''}`} role="status" aria-live="off" title={section === 'agents' ? t(`会话活动按事件推送；进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对。最近进程采样 ${displayTime(agents?.collectedAt)}。没有新事件是正常状态。`, `Session activity is event-driven; processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000}s. Last process sample ${displayTime(agents?.collectedAt)}. No new events is normal.`) : undefined}>
          <span><RefreshCw size={14} aria-hidden="true" className={collecting && !paused ? 'spinning' : ''} />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : section === 'agents' ? t('会话事件订阅', 'Session events') : t('自动更新', 'Auto-update')}</span>
          <small>{samplingDetail}</small>
        </div>
        <button className="button secondary" onClick={() => setPausedAt(value => value === null ? Date.now() : null)} aria-pressed={paused}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? t('继续显示', 'Resume display') : t('暂停显示', 'Pause display')}</button>
      </div>}</div>
      {page === 'settings' ? <SettingsView /> : <>
      {paused && <div className="pause-note"><Pause size={14} />{t('当前显示已冻结；后台继续采集。点击“继续”查看最新状态。', 'The display is frozen; collection continues. Resume to see the latest state.')}</div>}
      <CollectorError error={bridgeError} onRetry={() => void refresh()} />
      {(page === 'overview' || page === 'agents') && <CollectorError error={agentError} onRetry={() => void refresh()} />}
      {(page === 'overview' || page === 'schedules') && <CollectorError error={snapshot.schedules.error} onRetry={() => void refresh()} />}
      {(page === 'overview' || page === 'system') && <CollectorError error={snapshot.system.error} onRetry={() => void refresh()} />}
      {page === 'overview' && <>
        <div className="summary-strip">
          <button onClick={() => setPage('agents')}><span>{t('主 Agent', 'Main agents')}</span><strong>{mainCount ?? '—'}<small>{t('个', 'agents')}</small></strong><p>{t('当前存活进程', 'Live processes')}</p></button>
          <button onClick={() => setPage('agents')}><span>{t('活动子代理', 'Active subagents')}</span><strong>{subCount ?? '—'}{subCount != null && <small>{t('个', 'agents')}</small>}</strong><p>{agents && subCount === null ? t('运行时未公开活动数量', 'Runtime does not expose activity counts') : t('已确认的运行实例', 'Confirmed active instances')}</p></button>
          <button onClick={() => setPage('schedules')}><span>{t('定时任务', 'Scheduled tasks')}</span><strong>{scheduled?.length ?? '—'}<small>{t('项', 'tasks')}</small></strong><p>{userScheduled ? t(`${userScheduled.length} 项属于当前用户`, `${userScheduled.length} for the current user`) : t('正在读取任务清单', 'Loading tasks')}</p></button>
          <div><span>{t('开机时间', 'Uptime')}</span><strong className="uptime-number">{system ? duration(system.uptimeSeconds, language) : '—'}</strong><p>{system ? t(`${system.cpuCores} 核 · ${bytes(system.memoryTotal)} 内存`, `${system.cpuCores} cores · ${bytes(system.memoryTotal)} memory`) : t('等待系统采样', 'Waiting for system samples')}</p></div>
        </div>
        <div className="overview-grid"><section className="panel agent-preview"><SectionHeader title={t('Agent 实例', 'Agent instances')} count={agents?.agents.length} action={t('查看全部', 'View all')} onAction={() => setPage('agents')} />{previewAgents.length ? <AgentTable agents={previewAgents} onSelect={() => setPage('agents')} pausedAt={pausedAt} /> : <Empty title={agents ? t('未发现存活的 Agent 实例', 'No live agents found') : t('正在读取 Agent 状态', 'Loading agents')}>{t('支持范围与采集限制可在数据来源中查看。', 'See Data sources for coverage and collection limits.')}</Empty>}<div className="panel-footer" title={t(`进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对；会话活动按事件推送。`, `Processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000}s; session activity is event-driven.`)}><span className="status-dot" /><span>{t('会话事件订阅 · 持续更新', 'Session events · Live')}</span><span>{t('进程采样', 'Process sample')} {displayTime(agents?.collectedAt)}</span></div></section>
          <section className="panel health-panel"><SectionHeader title={t('资源使用', 'Resources')} action={t('详情', 'Details')} onAction={() => setPage('system')} /><Meter label="CPU" value={system?.cpuPercent ?? null} detail={system ? t(`${system.cpuCores} 个逻辑核心`, `${system.cpuCores} logical cores`) : t('等待采样', 'Waiting for samples')} /><Meter label={t('内存', 'Memory')} value={system ? system.memoryUsed / system.memoryTotal * 100 : null} detail={system ? `${bytes(system.memoryUsed)} / ${bytes(system.memoryTotal)}` : t('等待采样', 'Waiting for samples')} tone="blue" /><Meter label={t('磁盘', 'Disk')} value={system?.diskTotal ? (system.diskUsed ?? 0) / system.diskTotal * 100 : null} detail={system ? t(`${bytes(system.diskAvailable)} 可用`, `${bytes(system.diskAvailable)} available`) : t('等待采样', 'Waiting for samples')} tone="warm" /><div className="mini-network"><span><ArrowDown size={14} />{bytes(system?.rxBytesPerSecond)}/s</span><span><ArrowUp size={14} />{bytes(system?.txBytesPerSecond)}/s</span></div></section></div>
        <section className="panel schedule-preview"><SectionHeader title={t('调度清单', 'Schedules')} count={scheduled?.length} action={t('全部任务', 'All tasks')} onAction={() => setPage('schedules')} />{previewJobs.length ? <ScheduleTable jobs={previewJobs} onSelect={() => setPage('schedules')} /> : <Empty title={schedules ? t('未发现定时任务', 'No scheduled tasks found') : t('正在读取定时任务', 'Loading scheduled tasks')}>{t('周期任务与日历任务会显示在这里。', 'Recurring and calendar tasks appear here.')}</Empty>}</section>
        <div className="overview-note"><CircleHelp size={15} /><span>{t('统计范围以本机可读取的数据为准。', 'Counts reflect locally readable data. ')}{issues > 0 ? t(`${issues} 个来源存在限制。`, `${issues} sources have limitations.`) : t('进程存活不代表模型正在生成。', 'A live process does not prove model generation.')}</span><button className="text-button" onClick={() => setPage('sources')}>{t('查看数据来源', 'View data sources')}<ChevronRight size={14} /></button></div>
      </>}
      {page === 'agents' && <AgentsView data={agents} error={agentError} pausedAt={pausedAt} />}
      {page === 'schedules' && <SchedulesView data={schedules} error={samplingError ?? null} />}
      {page === 'system' && <SystemView data={system} />}
      {page === 'sources' && <><div className="source-intro"><Server size={20} /><p>{t('仅查询本机，不连接云端账号。未授权或未公开的数据不会推算为零；采集失败时会保留上次成功数据并提示。', 'Local queries only, without cloud accounts. Unavailable data is never counted as zero. Failed collection preserves the last successful data and shows an error.')}</p></div>{sourceGroups.map(group => <section className="panel source-group" key={group.title}><SectionHeader title={group.title} /><CollectorError error={group.state.error} onRetry={() => void refresh()} />{group.sources.length ? <Sources sources={group.sources} /> : <Empty title={t('尚未完成采集', 'Collection not yet complete')}>{t('后台正在按默认周期采样；失败时可通过上方错误提示重试。', 'Collection runs in the background. Retry using the error message above if it fails.')}</Empty>}<div className="panel-footer">{t('最近成功采样', 'Last successful sample')} {displayTime(group.state.data?.collectedAt)}</div></section>)}</>}
      </>}
      <footer className="page-footer"><span>OC Chan</span><span>{system ? `${system.hostname} · Darwin ${system.osVersion}` : t('正在连接本机', 'Connecting to this Mac')}{paused ? t(' · 显示已暂停', ' · Display paused') : ''}</span></footer>
      </main>
    </div>
  </div>
}
