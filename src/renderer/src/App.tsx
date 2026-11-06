import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, Bot, CalendarClock, ChevronRight, CircleHelp, Database, LayoutDashboard, List, Menu as MenuIcon, Monitor, Pause, Play, RefreshCw, Server, Settings } from 'lucide-react'
import { AGENT_DISCOVERY_INTERVAL_MS, SAMPLING_INTERVALS, type MonitorSection, type MonitorSnapshot, type MonitorUpdate, type SourceStatus } from '../../shared/types'
import AgentsView, { AgentTable } from './AgentsView'
import SchedulesView, { ScheduleTable } from './SchedulesView'
import EventsView, { createEventView } from './EventsView'
import SystemView from './SystemView'
import SourcePanels from './SourcePanels'
import SettingsView from './SettingsView'
import SidebarResizeHandle from './SidebarResizeHandle'
import { GeometrySaveErrors } from './SettingsSaveError'
import { useI18n } from './i18n'
import { bytes, CollectionStatus, CollectorError, duration, Empty, Meter, SectionHeader, time } from './components'
import { agentTarget, navigationPage, parseNavigationTarget, scheduleTarget, type AppPage, type NavigationIntent, type NavigationTarget } from '../../shared/navigation'
import { createScheduleMemory, createTopologyMemory, initialAgentView, initialScheduleView,
  pruneTopologyMemory, reconcileAgentView, reconcileScheduleView, type ScrollPosition } from './view-state'
import { useSettings } from './settings'

const initial: MonitorSnapshot = {
  agents: { data: null, error: null, refreshing: false },
  schedules: { data: null, error: null, refreshing: false },
  system: { data: null, error: null, refreshing: false },
  events: { data: null, error: null, refreshing: false }
}

export default function App() {
  const { t, language } = useI18n()
  const { snapshot: { settings: { plugins } } } = useSettings()
  const displayTime = (value?: string) => time(value, language)
  const pages = [
    { id: 'overview', label: t('本机概览', 'Overview'), icon: LayoutDashboard, description: t('Agent、调度任务与系统资源的当前状态。', 'The current state of agents, scheduled tasks and system resources.') },
    { id: 'agents', label: t('协作拓扑', 'Agent topology'), icon: Bot, description: t('在画布中查看 Agent 父子关系，定位项目与运行状态。', 'Explore agent relationships, projects and runtime status on the canvas.') },
    { id: 'schedules', label: t('定时任务', 'Scheduled tasks'), icon: CalendarClock, description: t('本机调度清单，让周期任务与常驻服务各归其位。', 'Local schedules, with recurring tasks and persistent services separated.') },
    { id: 'events', label: t('事件', 'Events'), icon: List, description: t('查看已确认的异常与恢复，回到原任务和数据来源。', 'Review confirmed failures and recoveries, then return to their tasks and sources.') },
    { id: 'system', label: t('系统监控', 'System monitor'), icon: Activity, description: t('持续采样 CPU、内存、磁盘与网络。', 'Continuous CPU, memory, disk and network sampling.') },
    { id: 'sources', label: t('数据来源', 'Data sources'), icon: Database, description: t('每个数字从哪里来，哪些范围尚不可见。', 'Where each number comes from and what remains outside visibility.') },
    { id: 'settings', label: t('设置', 'Settings'), icon: Settings, description: t('调整外观、文字与桌面行为。', 'Adjust appearance, typography and desktop behavior.') }
  ] as const
  const [page, setPageValue] = useState<AppPage>('overview')
  const [agentView, setAgentView] = useState(initialAgentView)
  const [scheduleView, setScheduleView] = useState(initialScheduleView)
  const [eventView, setEventView] = useState(createEventView)
  const [processOrder, setProcessOrder] = useState<'cpu' | 'memory'>('cpu')
  const [topologyMemory] = useState(createTopologyMemory)
  const [scheduleMemory] = useState(createScheduleMemory)
  const pageRef = useRef(page)
  pageRef.current = page
  const content = useRef<HTMLElement>(null)
  const pageScroll = useRef<Record<AppPage, ScrollPosition>>({
    overview: { top: 0, left: 0 }, agents: { top: 0, left: 0 }, schedules: { top: 0, left: 0 },
    system: { top: 0, left: 0 }, events: { top: 0, left: 0 }, sources: { top: 0, left: 0 }, settings: { top: 0, left: 0 }
  })
  const restoringScroll = useRef(false)
  const setPage = useCallback((next: AppPage) => {
    const element = content.current
    if (element) {
      const saved = pageScroll.current[pageRef.current]
      saved.top = element.scrollTop
      saved.left = element.scrollLeft
    }
    setPageValue(next)
  }, [])
  const [intent, setIntent] = useState<NavigationIntent | null>(null)
  const [sourceTarget, setSourceTarget] = useState<Extract<NavigationTarget, { kind: 'source' }> | null>(null)
  const navigationSequence = useRef(0)
  const focusedSource = useRef<NavigationTarget | null>(null)
  const receivedNavigation = useRef(0)
  const openTarget = useCallback((target: NavigationTarget) => {
    setPage(navigationPage(target))
    setIntent(target.kind === 'agent' || target.kind === 'schedule' ? { sequence: ++navigationSequence.current, target } : null)
    if (target.kind === 'source') setSourceTarget(target)
  }, [setPage])
  const consumeIntent = useCallback((sequence: number) => {
    setIntent(current => current?.sequence === sequence ? null : current)
  }, [])
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const navigation = useRef<HTMLElement>(null)
  const navigationToggle = useRef<HTMLButtonElement>(null)
  const navigationFocus = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState(initial)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const paused = pausedAt !== null
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [hiddenAt, setHiddenAt] = useState<number | null>(() => document.hidden ? Date.now() : null)
  const visible = hiddenAt === null
  const frozenAt = pausedAt ?? hiddenAt
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
    if (!navigation.current?.contains(previous) && previous !== navigationToggle.current && !previous.matches('.sidebar-resize-handle')) return
    const next = compactNavigation ? navigationToggle.current
      : navigation.current?.contains(previous) ? previous
      : navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')
    next?.focus({ preventScroll: true })
  }, [compactNavigation])

  function navigate(next: AppPage) {
    openTarget({ kind: 'page', page: next })
    if (navigation.current?.matches(':popover-open')) navigation.current.hidePopover()
  }
  useEffect(() => {
    const api = window.monitor
    if (!api) return
    let active = true
    const receive = () => {
      void api.navigation().then(async request => {
        if (!active || !request) return
        if (request.sequence > receivedNavigation.current) {
          openTarget(parseNavigationTarget(request.target))
          receivedNavigation.current = request.sequence
        }
        await api.acknowledgeNavigation(request.sequence)
      }).catch(error => { if (active) setBridgeError(String(error)) })
    }
    const unsubscribe = api.onNavigation(receive)
    receive()
    return () => { active = false; unsubscribe() }
  }, [openTarget])
  useEffect(() => {
    if (paused || !visible) return
    const api = window.monitor
    if (!api) { setBridgeError('Desktop data connection unavailable / 未连接桌面数据接口'); return }
    let active = true
    const received = new Set<MonitorSection>()
    const onUpdate = (update: MonitorUpdate) => {
      if (!active || document.hidden) return
      received.add(update.section)
      setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
      if (received.has('agents') && received.has('schedules') && received.has('system') && received.has('events')) setBridgeError(null)
    }
    const unsubscribe = api.subscribe(onUpdate)
    void api.snapshot().then(data => {
      if (!active || document.hidden) return
      // Subscribe first; a slower initial read must not replace newer section events.
      setSnapshot(previous => ({
        agents: received.has('agents') ? previous.agents : data.agents,
        schedules: received.has('schedules') ? previous.schedules : data.schedules,
        system: received.has('system') ? previous.system : data.system,
        events: received.has('events') ? previous.events : data.events
      }))
      setBridgeError(null)
    }).catch(error => { if (active) setBridgeError(String(error)) })
    return () => { active = false; unsubscribe() }
  }, [paused, visible])
  useEffect(() => {
    setAgentView(view => reconcileAgentView(view, snapshot.agents.data))
  }, [snapshot.agents.data, agentView.selectedId, agentView.identity])
  useEffect(() => {
    if (snapshot.agents.data) pruneTopologyMemory(topologyMemory, snapshot.agents.data.agents)
  }, [snapshot.agents.data, topologyMemory])
  useEffect(() => {
    setScheduleView(view => reconcileScheduleView(view, snapshot.schedules.data))
  }, [snapshot.schedules.data, scheduleView.selectedId, scheduleView.identity])
  useEffect(() => {
    const updateVisibility = () => setHiddenAt(at => document.hidden ? at ?? Date.now() : null)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  useLayoutEffect(() => {
    if (intent || (page === 'sources' && sourceTarget && focusedSource.current !== sourceTarget)) return
    const element = content.current
    if (!element) return
    const saved = pageScroll.current[page]
    restoringScroll.current = true
    element.scrollTo({ top: saved.top, left: saved.left, behavior: 'instant' })
    const frame = requestAnimationFrame(() => { restoringScroll.current = false })
    return () => { cancelAnimationFrame(frame); restoringScroll.current = false }
  }, [page])
  useLayoutEffect(() => {
    if (page !== 'sources' || !sourceTarget || focusedSource.current === sourceTarget) return
    if (!snapshot[sourceTarget.section].data && plugins[sourceTarget.section]) return
    const row = content.current?.querySelector<HTMLElement>(`[data-source-section="${sourceTarget.section}"] [data-source-id="${CSS.escape(sourceTarget.id)}"]`)
    const target = row ?? content.current?.querySelector<HTMLElement>('.source-navigation-note')
    if (!target) return
    focusedSource.current = sourceTarget
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
  }, [page, sourceTarget, snapshot, plugins])

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
  const agentError = plugins.agents ? snapshot.agents.error || (agentSourceError ? `${agentSourceError.label}: ${agentSourceError.detail}` : null) : null
  const mainCount = agents?.agents.filter(agent => agent.kind === 'main').length
  const subCount = agents?.activeSubagentCount
  const scheduled = schedules?.jobs.filter(job => ['calendar', 'interval'].includes(job.kind))
  const userScheduled = scheduled?.filter(job => job.scope === 'user')
  const sourceGroups = [
    { id: 'agents' as const, title: t('协作拓扑', 'Agent topology'), sources: agents?.sources ?? [], state: snapshot.agents },
    { id: 'schedules' as const, title: t('定时任务', 'Scheduled tasks'), sources: schedules?.sources ?? [], state: snapshot.schedules },
    { id: 'system' as const, title: t('系统监控', 'System monitor'), sources: system?.sources ?? [], state: snapshot.system },
    { id: 'events' as const, title: t('本地事件', 'Local events'), sources: snapshot.events.data?.sources ?? [], state: snapshot.events }
  ]
  const issues = sourceGroups.reduce((count, group) => count + (plugins[group.id] ? group.sources.filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled').length + Number(Boolean(group.state.error)) : 0), 0)
  const currentPage = pages.find(item => item.id === page)!
  const section = page === 'agents' || page === 'system' || page === 'schedules' || page === 'events' ? page : undefined
  const sampling = section ? snapshot[section] : undefined
  const collectionDisabled = section ? !plugins[section] : !Object.values(plugins).some(Boolean)
  const partiallyDisabled = !section && Object.values(plugins).some(enabled => !enabled)
  const samplingError = bridgeError || (!collectionDisabled ? section === 'agents' ? agentError : sampling?.error : null)
  const collecting = section ? plugins[section] && Boolean(sampling?.refreshing) : sourceGroups.some(group => plugins[group.id] && group.state.refreshing)
  const samplingDetail = collectionDisabled ? t('请在数据来源中开启采集；上游任务不受影响。', 'Enable collection in Data sources; upstream tasks are unaffected.') : partiallyDisabled ? t('仅更新已开启的来源；停用来源保留旧快照。', 'Only enabled sources update; disabled sources retain old snapshots.') : section === 'agents'
    ? samplingError ? t('会话更新异常 · 可重试', 'Session update failed · Retry available') : t(`会话事件订阅 · ${collecting && !paused ? '连接中' : '持续更新'}`, `Session events · ${collecting && !paused ? 'Connecting' : 'Live'}`)
    : section
      ? t(`每 ${SAMPLING_INTERVALS[section] / 1000} 秒 · ${collecting && !paused ? '采集中' : `最近成功 ${displayTime(sampling?.data?.collectedAt)}`}`, `Every ${SAMPLING_INTERVALS[section] / 1000}s · ${collecting && !paused ? 'Collecting' : `Last success ${displayTime(sampling?.data?.collectedAt)}`}`)
      : t(`Agent 事件订阅 · 系统 ${SAMPLING_INTERVALS.system / 1000}s · 调度 ${SAMPLING_INTERVALS.schedules / 1000}s`, `Agent events · System ${SAMPLING_INTERVALS.system / 1000}s · Schedules ${SAMPLING_INTERVALS.schedules / 1000}s`)
  const agentEvidenceCurrent = plugins.agents && !agentError && !bridgeError
  const agentMotion = !paused && visible && agentEvidenceCurrent
  const agentFrozenAt = plugins.agents ? frozenAt : frozenAt ?? (agents ? Date.parse(agents.collectedAt) : 0)
  const previewAgents = agents?.agents.slice(0, 5) ?? []
  const previewJobs = [...(scheduled ?? [])].sort((a, b) => Number(a.scope === 'system') - Number(b.scope === 'system')).slice(0, 4)
  return <div className="app-shell" data-compact-navigation={compactNavigation} data-agent-collection={plugins.agents} data-agent-evidence={agentEvidenceCurrent ? 'current' : 'stale'} data-agent-motion={agentMotion ? 'running' : 'paused'} data-display-live={!paused && visible}>
    <div className="window-drag" />
    <aside ref={navigation} id="main-navigation" className="sidebar" popover={compactNavigation ? 'auto' : undefined}>
      <div className="brand"><span className="brand-mark"><Activity size={23} strokeWidth={2.2} /></span><div><strong>OC Chan</strong><span>{t('本机运行观察', 'Local monitor')}</span></div></div>
      <nav aria-label={t('主导航', 'Main navigation')}>{pages.filter(item => item.id !== 'sources' && item.id !== 'settings').map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><item.icon size={18} /><span>{item.label}</span>{item.id === 'agents' && plugins.agents && agents && <small>{agents.agents.length}</small>}{item.id === 'schedules' && plugins.schedules && scheduled && <small>{scheduled.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${page === 'sources' ? 'selected' : ''}`} onClick={() => navigate('sources')} aria-current={page === 'sources' ? 'page' : undefined}><Database size={18} /><span>{t('数据来源', 'Data sources')}</span>{issues > 0 && <small className="warning-count">{issues}</small>}</button>
        <button className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')} aria-current={page === 'settings' ? 'page' : undefined}><Settings size={18} /><span>{t('设置', 'Settings')}</span></button>
        <div className="device-block"><span className="device-icon"><Monitor size={18} /></span><div><strong title={system?.hostname}>{system?.hostname || t('此 Mac', 'This Mac')}</strong><span>{t('本地采集 · 只读访问', 'Local · Read-only monitoring')}</span></div></div>
      </div>
    </aside>
    <SidebarResizeHandle compact={compactNavigation} />
    <div className="workspace"><header className="topbar"><button ref={navigationToggle} className="navigation-toggle" popoverTarget="main-navigation" aria-label={t('主导航', 'Main navigation')} title={t('主导航', 'Main navigation')}><MenuIcon size={20} aria-hidden="true" /></button><div className="breadcrumb">{t('工作台', 'Workspace')}<ChevronRight size={14} /><span>{currentPage.label}</span></div><div className={`live-state ${paused || samplingError || collectionDisabled || partiallyDisabled ? 'paused' : ''}`}><span className="status-dot" />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : collectionDisabled ? t('采集已停用', 'Collection disabled') : partiallyDisabled ? t('部分采集已停用', 'Some collection disabled') : t('实时显示已开启', 'Live display enabled')}</div></header>
      <main ref={content} className="main-content" onScroll={event => {
        if (restoringScroll.current) return
        const saved = pageScroll.current[page]
        saved.top = event.currentTarget.scrollTop
        saved.left = event.currentTarget.scrollLeft
      }}><div className="page-heading"><div><h1>{currentPage.label}</h1><p>{currentPage.description}</p></div>{page !== 'settings' && <div className="page-actions">
        <div className={`sampling-status${paused || samplingError || collectionDisabled || partiallyDisabled ? ' is-paused' : ''}`} role="status" aria-live="off" title={section === 'agents' && plugins.agents ? t(`会话活动按事件推送；进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对。最近进程采样 ${displayTime(agents?.collectedAt)}。没有新事件是正常状态。`, `Session activity is event-driven; processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000}s. Last process sample ${displayTime(agents?.collectedAt)}. No new events is normal.`) : undefined}>
          <span><RefreshCw size={14} aria-hidden="true" className={collecting && !paused ? 'spinning' : ''} />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : collectionDisabled ? t('采集已停用', 'Collection disabled') : partiallyDisabled ? t('部分采集已停用', 'Some collection disabled') : section === 'agents' ? t('会话事件订阅', 'Session events') : t('自动更新', 'Auto-update')}</span>
          <small>{samplingDetail}</small>
        </div>
        <button className="button secondary" onClick={() => setPausedAt(value => value === null ? Date.now() : null)} aria-pressed={paused}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? t('继续显示', 'Resume display') : t('暂停显示', 'Pause display')}</button>
      </div>}</div>
      <GeometrySaveErrors />
      {page === 'settings' ? <SettingsView sources={sourceGroups.flatMap<SourceStatus>(group => group.id === 'events'
        ? group.sources.filter(source => source.id === 'hermes-events')
        : [{ id: `collection:${group.id}`, label: t(`${group.title}采集`, `${group.title} collection`),
          state: !plugins[group.id] ? 'disabled' : group.state.error ? 'error' : group.state.lastSuccessAt ? 'ok' : 'unsupported',
          detail: t('整个采集分区持续失败或恢复时通知。', 'Notify when this collection section remains unavailable or recovers.') }, ...group.sources])} /> : <>
      {paused && <div className="pause-note"><Pause size={14} />{t('当前显示已冻结；已开启的来源继续采集。点击“继续”查看最新状态。', 'The display is frozen; enabled sources keep collecting. Resume to see the latest state.')}</div>}
      {(section || page === 'overview') && sourceGroups.filter(group => !section || group.id === section).map(group => <CollectionStatus key={group.id} enabled={plugins[group.id]} collectedAt={group.state.data?.collectedAt} label={group.title} />)}
      <CollectorError error={bridgeError} onRetry={() => void refresh()} />
      {(page === 'overview' || page === 'agents') && <CollectorError error={agentError} onRetry={() => void refresh()} />}
      {(page === 'overview' || page === 'schedules') && plugins.schedules && <CollectorError error={snapshot.schedules.error} onRetry={() => void refresh()} />}
      {(page === 'overview' || page === 'system') && plugins.system && <CollectorError error={snapshot.system.error} onRetry={() => void refresh()} />}
      {(page === 'overview' || page === 'events') && plugins.events && <CollectorError error={snapshot.events.error} onRetry={() => void refresh()} />}
      {page === 'overview' && <>
        <div className="summary-strip">
          <button onClick={() => setPage('agents')}><span>{t('主 Agent', 'Main agents')}</span><strong>{plugins.agents ? mainCount ?? '—' : '—'}<small>{t('个', 'agents')}</small></strong><p>{plugins.agents ? t('当前存活进程', 'Live processes') : t('采集已停用', 'Collection disabled')}</p></button>
          <button onClick={() => plugins.agents && agents && subCount === null ? openTarget({ kind: 'source', section: 'agents', id: 'omp-ownership' }) : setPage('agents')}><span>{t('活动子代理', 'Active subagents')}</span><strong>{plugins.agents ? subCount ?? '—' : '—'}{plugins.agents && subCount != null && <small>{t('个', 'agents')}</small>}</strong><p>{!plugins.agents ? t('采集已停用', 'Collection disabled') : agents && subCount === null ? t('查看数量未知的来源说明', 'Why the activity count is unknown') : t('已确认的运行实例', 'Confirmed active instances')}</p></button>
          <button onClick={() => setPage('schedules')}><span>{t('定时任务', 'Scheduled tasks')}</span><strong>{plugins.schedules ? scheduled?.length ?? '—' : '—'}<small>{t('项', 'tasks')}</small></strong><p>{!plugins.schedules ? t('采集已停用', 'Collection disabled') : userScheduled ? t(`${userScheduled.length} 项属于当前用户`, `${userScheduled.length} for the current user`) : t('正在读取任务清单', 'Loading tasks')}</p></button>
          <div><span>{t('开机时间', 'Uptime')}</span><strong className="uptime-number">{plugins.system && system ? duration(system.uptimeSeconds, language) : '—'}</strong><p>{!plugins.system ? t('采集已停用', 'Collection disabled') : system ? t(`${system.cpuCores} 核 · ${bytes(system.memoryTotal)} 内存`, `${system.cpuCores} cores · ${bytes(system.memoryTotal)} memory`) : t('等待系统采样', 'Waiting for system samples')}</p></div>
        </div>
        <div className="overview-grid"><section className="panel agent-preview"><SectionHeader title={t('Agent 实例', 'Agent instances')} count={agents?.agents.length} action={t('查看全部', 'View all')} onAction={() => navigate('agents')} />{previewAgents.length ? <AgentTable agents={previewAgents} onSelect={agent => openTarget(agentTarget(agent))} pausedAt={agentFrozenAt} /> : <Empty title={!plugins.agents ? t('采集已停用', 'Collection disabled') : agents ? t('未发现存活的 Agent 实例', 'No live agents found') : t('正在读取 Agent 状态', 'Loading agents')}>{t('支持范围与采集限制可在数据来源中查看。', 'See Data sources for coverage and collection limits.')}</Empty>}<div className="panel-footer"><span className="status-dot" /><span>{!plugins.agents ? t('旧快照 · 不再更新', 'Retained snapshot · No updates') : paused ? t('显示已暂停', 'Display paused') : t('会话事件订阅 · 持续更新', 'Session events · Live')}</span><span>{t('进程采样', 'Process sample')} {agents ? displayTime(agents.collectedAt) : t('尚无采样', 'No sample')}</span></div></section>
          <section className="panel health-panel"><SectionHeader title={t('资源使用', 'Resources')} action={t('详情', 'Details')} onAction={() => setPage('system')} /><Meter label="CPU" value={system?.cpuPercent ?? null} detail={system ? t(`${system.cpuCores} 个逻辑核心`, `${system.cpuCores} logical cores`) : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} /><Meter label={t('内存', 'Memory')} value={system ? system.memoryUsed / system.memoryTotal * 100 : null} detail={system ? `${bytes(system.memoryUsed)} / ${bytes(system.memoryTotal)}` : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} tone="blue" /><Meter label={t('磁盘', 'Disk')} value={system?.diskTotal ? (system.diskUsed ?? 0) / system.diskTotal * 100 : null} detail={system ? t(`${bytes(system.diskAvailable)} 可用`, `${bytes(system.diskAvailable)} available`) : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} tone="warm" /><div className="mini-network"><span><ArrowDown size={14} />{bytes(system?.rxBytesPerSecond)}/s</span><span><ArrowUp size={14} />{bytes(system?.txBytesPerSecond)}/s</span></div></section></div>
        <section className="panel schedule-preview"><SectionHeader title={t('调度清单', 'Schedules')} count={scheduled?.length} action={t('全部任务', 'All tasks')} onAction={() => navigate('schedules')} />{previewJobs.length ? <ScheduleTable jobs={previewJobs} onSelect={job => openTarget(scheduleTarget(job))} /> : <Empty title={!plugins.schedules ? t('采集已停用', 'Collection disabled') : schedules ? t('未发现定时任务', 'No scheduled tasks found') : t('正在读取定时任务', 'Loading scheduled tasks')}>{t('周期任务与日历任务会显示在这里。', 'Recurring and calendar tasks appear here.')}</Empty>}</section>
        <div className="overview-note"><CircleHelp size={15} /><span>{t('统计范围以本机可读取的数据为准。', 'Counts reflect locally readable data. ')}{issues > 0 ? t(`${issues} 个来源存在限制。`, `${issues} sources have limitations.`) : t('进程存活不代表模型正在生成。', 'A live process does not prove model generation.')}</span><button className="text-button" onClick={() => setPage('sources')}>{t('查看数据来源', 'View data sources')}<ChevronRight size={14} /></button></div>
      </>}
      {page === 'agents' && <AgentsView data={agents} enabled={plugins.agents} error={agentError} pausedAt={agentFrozenAt} intent={intent} onConsumed={consumeIntent} view={agentView} onViewChange={setAgentView} memory={topologyMemory} onSource={openTarget} />}
      {page === 'schedules' && <SchedulesView data={schedules} enabled={plugins.schedules} error={samplingError ?? null} intent={intent} onConsumed={consumeIntent} view={scheduleView} onViewChange={setScheduleView} memory={scheduleMemory} onSource={openTarget} />}
      {page === 'events' && <EventsView snapshot={snapshot} enabled={plugins.events} active={!paused && visible} view={eventView} onViewChange={setEventView} onNavigate={openTarget} />}
      {page === 'system' && <SystemView data={system} enabled={plugins.system} processOrder={processOrder} onProcessOrderChange={setProcessOrder} />}
      {page === 'sources' && <><div className="source-intro"><Server size={20} /><p>{t('仅查询本机，不连接云端账号。未授权或未公开的数据不会推算为零；采集失败时会保留上次成功数据并提示。', 'Local queries only, without cloud accounts. Unavailable data is never counted as zero. Failed collection preserves the last successful data and shows an error.')}</p></div>
        {sourceTarget && <p className="footnote source-navigation-note" tabIndex={-1}>{sourceGroups.find(group => group.id === sourceTarget.section)?.sources.some(source => source.id === sourceTarget.id) ? t('已定位指定数据来源。', 'The requested source is selected.') : t('指定来源已不在当前快照中。', 'The requested source is no longer in the current snapshot.')} <button className="text-button" onClick={() => { setSourceTarget(null); navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus() }}>{t('关闭定位', 'Dismiss selection')}</button></p>}
        <SourcePanels groups={sourceGroups} live={!paused && visible} /></>}
      </>}
      <footer className="page-footer"><span>OC Chan</span><span>{system ? `${system.hostname} · Darwin ${system.osVersion}` : plugins.system ? t('正在连接本机', 'Connecting to this Mac') : t('系统采集已停用', 'System collection disabled')}{paused ? t(' · 显示已暂停', ' · Display paused') : ''}</span></footer>
      </main>
    </div>
  </div>
}
