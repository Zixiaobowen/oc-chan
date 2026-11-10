import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Activity from 'kubai-icons-react/icons/activity'
import Bot from 'kubai-icons-react/icons/bot'
import CalendarClock from 'kubai-icons-react/icons/calendar-clock'
import ChevronRight from 'kubai-icons-react/icons/chevron-right'
import CircleHelp from 'kubai-icons-react/icons/circle-help'
import Database from 'kubai-icons-react/icons/database'
import LayoutDashboard from 'kubai-icons-react/icons/layout-dashboard'
import List from 'kubai-icons-react/icons/list'
import MenuIcon from 'kubai-icons-react/icons/menu'
import Pause from 'kubai-icons-react/icons/pause'
import Play from 'kubai-icons-react/icons/play'
import Sync from 'kubai-icons-react/icons/sync'
import Server from 'kubai-icons-react/icons/server'
import Settings from 'kubai-icons-react/icons/settings'
import { AGENT_DISCOVERY_INTERVAL_MS, type MonitorSection, type MonitorSnapshot, type MonitorUpdate, type SourceStatus } from '../../shared/types'
import { createEventView } from './EventsView'
import SourcePanels from './SourcePanels'
import SettingsView from './SettingsView'
import SidebarResizeHandle from './SidebarResizeHandle'
import { GeometrySaveErrors } from './SettingsSaveError'
import { UpdateNotice } from './UpdateSettings'
import { useI18n } from './i18n'
import { CollectionStatus, CollectorError, time } from './components'
import { navigationPage, parseNavigationTarget, type AppPage, type NavigationIntent, type NavigationTarget } from '../../shared/navigation'
import { createScheduleMemory, createTopologyMemory, initialAgentView, initialScheduleView,
  pruneTopologyMemory, reconcileAgentView, reconcileScheduleView, type ScrollPosition } from './view-state'
import { useSettings } from './settings'
import brandIcon from '../../../resources/brand/oc-chan-icon.svg'
import { monitorPlugins, createEmptySnapshot, monitorSections } from '../../shared/plugin-catalog'
import { PluginPage, PluginSlot, useRendererPlugins, type RendererContext } from './plugins'
import MarketplaceView, { type MarketplaceViewState } from './MarketplaceView'
import { useSystemPlugin } from './marketplace'
import SystemPluginNotice from './SystemPluginNotice'
import { isDesktopDocumentVisible, scheduleDesktopUpdate } from './desktop-visibility'

const initial = createEmptySnapshot()

export default function App() {
  const { t, language } = useI18n()
  const { snapshot: { settings: { plugins: preferences } } } = useSettings()
  const { installed: systemInstalled, item: systemItem } = useSystemPlugin()
  const plugins = useMemo(() => ({ ...preferences, system: systemInstalled === true && Boolean(systemItem?.enabled) && preferences.system }), [preferences, systemInstalled, systemItem?.enabled])
  const renderer = useRendererPlugins(plugins, systemInstalled === true)
  const displayTime = (value?: string) => time(value, language)
  const pages = [
    { id: 'overview', label: t('本机概览', 'Overview'), icon: LayoutDashboard, description: t('Agent、调度任务与系统资源的当前状态。', 'The current state of agents, scheduled tasks and system resources.') },
    ...monitorPlugins.map(plugin => ({ id: plugin.page.id, label: t(...plugin.page.label), description: t(...plugin.page.description), icon: ({ agents: Bot, schedules: CalendarClock, events: List } as Partial<Record<MonitorSection, typeof Activity>>)[plugin.section] ?? Activity })),
    { id: 'plugins', label: t('插件市场', 'Plugin marketplace'), icon: Server, description: t('安装、更新与卸载本机采集插件。', 'Install, update and uninstall local collection plugins.') },
    { id: 'sources', label: t('数据来源', 'Data sources'), icon: Database, description: t('每个数字从哪里来，哪些范围尚不可见。', 'Where each number comes from and what remains outside visibility.') },
    { id: 'settings', label: t('设置', 'Settings'), icon: Settings, description: t('调整外观、文字与桌面行为。', 'Adjust appearance, typography and desktop behavior.') }
  ] as const
  const [page, setPageValue] = useState<AppPage>('overview')
  const [agentView, setAgentView] = useState(initialAgentView)
  const [scheduleView, setScheduleView] = useState(initialScheduleView)
  const [eventView, setEventView] = useState(createEventView)
  const [marketView, setMarketView] = useState<MarketplaceViewState>({ search: '', filter: 'all' })
  const [topologyMemory] = useState(createTopologyMemory)
  const [scheduleMemory] = useState(createScheduleMemory)
  const pageRef = useRef(page)
  pageRef.current = page
  const content = useRef<HTMLElement>(null)
  const pageScroll = useRef<Record<AppPage, ScrollPosition>>(Object.fromEntries(pages.map(item => [item.id, { top: 0, left: 0 }])) as Record<AppPage, ScrollPosition>)
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
  const [storedSnapshot, setSnapshot] = useState(initial)
  const snapshot = systemInstalled === true ? storedSnapshot : { ...storedSnapshot, system: initial.system }
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const paused = pausedAt !== null
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [hiddenAt, setHiddenAt] = useState<number | null>(() => isDesktopDocumentVisible() ? null : Date.now())
  const visible = hiddenAt === null
  const frozenAt = pausedAt ?? hiddenAt
  const focusUpdates = useRef(false)
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
      if (!active || !isDesktopDocumentVisible() || (update.section === 'system' && systemInstalled !== true)) return
      received.add(update.section)
      setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
      if (monitorSections.every(section => received.has(section))) setBridgeError(null)
    }
    const unsubscribe = api.subscribe(onUpdate)
    void api.snapshot().then(data => {
      if (!active || !isDesktopDocumentVisible()) return
      // Subscribe first; a slower initial read must not replace newer section events.
      setSnapshot(previous => Object.fromEntries(monitorSections.map(section => [section, section === 'system' && systemInstalled !== true ? initial.system : received.has(section) ? previous[section] : data[section]])) as MonitorSnapshot)
      setBridgeError(null)
    }).catch(error => { if (active) setBridgeError(String(error)) })
    return () => { active = false; unsubscribe() }
  }, [paused, visible, systemInstalled])
  useEffect(() => {
    if (systemInstalled === false) setSnapshot(previous => ({ ...previous, system: initial.system }))
  }, [systemInstalled])
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
    const updateVisibility = () => setHiddenAt(at => isDesktopDocumentVisible() ? null : at ?? Date.now())
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  useLayoutEffect(() => {
    if (page === 'settings' && focusUpdates.current) {
      focusUpdates.current = false
      const heading = content.current?.querySelector<HTMLElement>('#app-updates-title')
      heading?.focus({ preventScroll: true })
      heading?.scrollIntoView({ block: 'start' })
      return
    }
    if (intent || (page === 'sources' && sourceTarget && focusedSource.current !== sourceTarget)) return
    const element = content.current
    if (!element) return
    const saved = pageScroll.current[page]
    restoringScroll.current = true
    element.scrollTo({ top: saved.top, left: saved.left, behavior: 'instant' })
    const update = scheduleDesktopUpdate(() => { restoringScroll.current = false })
    return () => { update.cancel(); restoringScroll.current = false }
  }, [page, renderer.contributions.find(plugin => plugin.section === page)])
  useLayoutEffect(() => {
    if (page !== 'sources' || !sourceTarget || focusedSource.current === sourceTarget) return
    if (!snapshot[sourceTarget.section].data && plugins[sourceTarget.section]) return
    const requestedPlugin = monitorPlugins.find(plugin => plugin.section === sourceTarget.section)
    if (plugins[sourceTarget.section] && !renderer.contributions.some(plugin => plugin.section === sourceTarget.section) && requestedPlugin && !renderer.errors[requestedPlugin.id]) return
    const row = content.current?.querySelector<HTMLElement>(`[data-source-section="${sourceTarget.section}"] [data-source-id="${CSS.escape(sourceTarget.id)}"]`)
    const target = row ?? content.current?.querySelector<HTMLElement>('.source-navigation-note')
    if (!target) return
    focusedSource.current = sourceTarget
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
  }, [page, sourceTarget, snapshot, plugins, renderer.contributions, renderer.errors])

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

  const agentSourceError = agents?.sources.find(source => source.state === 'error')
  const agentError = plugins.agents ? snapshot.agents.error || (agentSourceError ? `${agentSourceError.label}: ${agentSourceError.detail}` : null) : null
  const scheduled = schedules?.jobs.filter(job => ['calendar', 'interval'].includes(job.kind))
  const sourceGroups = monitorPlugins.map(plugin => ({ id: plugin.section, title: t(...plugin.page.label), description: t(...plugin.description), sources: snapshot[plugin.section].data?.sources ?? [], state: snapshot[plugin.section], contribution: renderer.contributions.find(item => item.id === plugin.id) }))
  const issues = sourceGroups.reduce((count, group) => count + (plugins[group.id] ? group.sources.filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled').length + Number(Boolean(group.state.error)) : 0), 0)
  const currentPage = pages.find(item => item.id === page)!
  const section = monitorPlugins.find(plugin => plugin.page.id === page)?.section
  const sampling = section ? snapshot[section] : undefined
  const collectionDisabled = section ? !plugins[section] : !Object.values(plugins).some(Boolean)
  const partiallyDisabled = !section && Object.values(plugins).some(enabled => !enabled)
  const samplingError = bridgeError || (!collectionDisabled ? section === 'agents' ? agentError : sampling?.error : null)
  const collecting = section ? plugins[section] && Boolean(sampling?.refreshing) : sourceGroups.some(group => plugins[group.id] && group.state.refreshing)
  const samplingDetail = section === 'system' && !systemInstalled ? systemInstalled === null ? t('正在读取插件状态。', 'Loading plugin status.') : t('请在插件市场安装系统监控。', 'Install System monitor from the plugin marketplace.') : collectionDisabled ? t('请在数据来源中开启采集；上游任务不受影响。', 'Enable collection in Data sources; upstream tasks are unaffected.') : partiallyDisabled ? t('仅更新已开启的来源；停用来源保留旧快照。', 'Only enabled sources update; disabled sources retain old snapshots.') : section === 'agents'
    ? samplingError ? t('会话更新异常 · 可重试', 'Session update failed · Retry available') : t(`会话事件订阅 · ${collecting && !paused ? '连接中' : '持续更新'}`, `Session events · ${collecting && !paused ? 'Connecting' : 'Live'}`)
    : section
      ? t(`每 ${monitorPlugins.find(plugin => plugin.section === section)!.intervalMs / 1000} 秒 · ${collecting && !paused ? '采集中' : `最近成功 ${displayTime(sampling?.data?.collectedAt)}`}`, `Every ${monitorPlugins.find(plugin => plugin.section === section)!.intervalMs / 1000}s · ${collecting && !paused ? 'Collecting' : `Last success ${displayTime(sampling?.data?.collectedAt)}`}`)
      : monitorPlugins.filter(plugin => plugins[plugin.section]).map(plugin => t(...plugin.label) + ' ' + plugin.intervalMs / 1000 + 's').join(' · ')
  const agentEvidenceCurrent = plugins.agents && !agentError && !bridgeError
  const agentMotion = !paused && visible && agentEvidenceCurrent
  const agentFrozenAt = plugins.agents ? frozenAt : frozenAt ?? (agents ? Date.parse(agents.collectedAt) : 0)
  const pluginContext: RendererContext = { snapshot, plugins, paused, visible, navigate, openTarget,
    agents: { data: agents, enabled: plugins.agents, error: agentError, pausedAt: agentFrozenAt, intent, onConsumed: consumeIntent, view: agentView, onViewChange: setAgentView, memory: topologyMemory, onSource: openTarget },
    schedules: { data: schedules, enabled: plugins.schedules, error: samplingError ?? null, intent, onConsumed: consumeIntent, view: scheduleView, onViewChange: setScheduleView, memory: scheduleMemory, onSource: openTarget },
    events: { snapshot, enabled: plugins.events, active: !paused && visible, view: eventView, onViewChange: setEventView, onNavigate: openTarget }
  }
  return <div className="app-shell" data-compact-navigation={compactNavigation} data-agent-collection={plugins.agents} data-agent-evidence={agentEvidenceCurrent ? 'current' : 'stale'} data-agent-motion={agentMotion ? 'running' : 'paused'} data-display-live={!paused && visible}>
    <div className="window-drag" />
    <aside ref={navigation} id="main-navigation" className="sidebar" popover={compactNavigation ? 'auto' : undefined}>
      <div className="brand"><img className="brand-mark" src={brandIcon} width={35} height={35} alt="" aria-hidden="true" /><div><strong>OC Chan</strong><span>{t('本机运行观察', 'Local monitor')}</span></div></div>
      <nav aria-label={t('主导航', 'Main navigation')}>{pages.filter(item => item.id !== 'sources' && item.id !== 'settings').map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><item.icon trigger="none" size={18} /><span>{item.label}</span>{item.id === 'agents' && plugins.agents && agents && <small>{agents.agents.length}</small>}{item.id === 'schedules' && plugins.schedules && scheduled && <small>{scheduled.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${page === 'sources' ? 'selected' : ''}`} onClick={() => navigate('sources')} aria-current={page === 'sources' ? 'page' : undefined}><Database trigger="none" size={18} /><span>{t('数据来源', 'Data sources')}</span>{issues > 0 && <small className="warning-count">{issues}</small>}</button>
        <button className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')} aria-current={page === 'settings' ? 'page' : undefined}><Settings trigger="none" size={18} /><span>{t('设置', 'Settings')}</span></button>
        <PluginSlot contributions={renderer.contributions} slot="Device" context={pluginContext} />
      </div>
    </aside>
    <SidebarResizeHandle compact={compactNavigation} />
    <div className="workspace"><header className="topbar"><button ref={navigationToggle} className="navigation-toggle" popoverTarget="main-navigation" aria-label={t('主导航', 'Main navigation')} title={t('主导航', 'Main navigation')}><MenuIcon trigger="none" size={20} aria-hidden="true" /></button><div className="breadcrumb">{t('工作台', 'Workspace')}<ChevronRight trigger="none" size={14} /><span>{currentPage.label}</span></div><div className={`live-state ${paused || samplingError || collectionDisabled || partiallyDisabled ? 'paused' : ''}`}><span className="status-dot" />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : collectionDisabled ? t('采集已停用', 'Collection disabled') : partiallyDisabled ? t('部分采集已停用', 'Some collection disabled') : t('实时显示已开启', 'Live display enabled')}</div></header>
      <main ref={content} className="main-content" onScroll={event => {
        if (restoringScroll.current) return
        const saved = pageScroll.current[page]
        saved.top = event.currentTarget.scrollTop
        saved.left = event.currentTarget.scrollLeft
      }}><div className="page-heading"><div><h1 tabIndex={-1}>{currentPage.label}</h1><p>{currentPage.description}</p></div>{page !== 'settings' && page !== 'plugins' && <div className="page-actions">
        <div className={`sampling-status${paused || samplingError || collectionDisabled || partiallyDisabled ? ' is-paused' : ''}`} role="status" aria-live="off" title={section === 'agents' && plugins.agents ? t(`会话活动按事件推送；进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对。最近进程采样 ${displayTime(agents?.collectedAt)}。没有新事件是正常状态。`, `Session activity is event-driven; processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000}s. Last process sample ${displayTime(agents?.collectedAt)}. No new events is normal.`) : undefined}>
          <span><Sync trigger="none" size={14} aria-hidden="true" className={collecting && !paused ? 'spinning' : ''} />{paused ? t('显示已暂停', 'Display paused') : samplingError ? t('更新异常', 'Update failed') : collectionDisabled ? t('采集已停用', 'Collection disabled') : partiallyDisabled ? t('部分采集已停用', 'Some collection disabled') : section === 'agents' ? t('会话事件订阅', 'Session events') : t('自动更新', 'Auto-update')}</span>
          <small>{samplingDetail}</small>
        </div>
        <button className="button secondary" onClick={() => setPausedAt(value => value === null ? Date.now() : null)} aria-pressed={paused}>{paused ? <Play trigger="none" size={15} /> : <Pause trigger="none" size={15} />}{paused ? t('继续显示', 'Resume display') : t('暂停显示', 'Pause display')}</button>
      </div>}</div>
      <GeometrySaveErrors />
      {page === 'plugins' ? <MarketplaceView view={marketView} onViewChange={setMarketView} /> : page === 'settings' ? <SettingsView onOpenMarketplace={() => navigate('plugins')} sources={sourceGroups.flatMap<SourceStatus>(group => group.id === 'events'
        ? group.sources.filter(source => source.id === 'hermes-events')
        : [{ id: `collection:${group.id}`, label: t(`${group.title}采集`, `${group.title} collection`),
          state: !plugins[group.id] ? 'disabled' : group.state.error ? 'error' : group.state.lastSuccessAt ? 'ok' : 'unsupported',
          detail: t('整个采集分区持续失败或恢复时通知。', 'Notify when this collection section remains unavailable or recovers.') }, ...group.sources])} /> : <>
      <UpdateNotice onOpen={() => { focusUpdates.current = true; navigate('settings') }} />
      {paused && <div className="pause-note"><Pause trigger="none" size={14} />{t('当前显示已冻结；已开启的来源继续采集。点击“继续”查看最新状态。', 'The display is frozen; enabled sources keep collecting. Resume to see the latest state.')}</div>}
      {(section || page === 'overview') && sourceGroups.filter(group => (!section || group.id === section) && (plugins[group.id] || group.contribution)).map(group => <CollectionStatus key={group.id} enabled={plugins[group.id]} collectedAt={group.state.data?.collectedAt} label={group.title} />)}
      <CollectorError error={bridgeError} onRetry={() => void refresh()} />
      {(page === 'overview' || page === 'agents') && <CollectorError error={agentError} onRetry={() => void refresh()} />}
      {sourceGroups.filter(group => group.id !== 'agents' && (page === 'overview' || section === group.id) && plugins[group.id]).map(group => <CollectorError key={group.id} error={group.state.error} onRetry={() => void refresh()} />)}
      {Object.entries(renderer.errors).map(([id, error]) => <CollectorError key={id} error={error} onRetry={renderer.retry} />)}
      {page === 'overview' && <>
        <div className="summary-strip"><PluginSlot contributions={renderer.contributions} slot="Summary" context={pluginContext} /></div>
        <div className="overview-grid"><PluginSlot contributions={renderer.contributions} slot="Overview" context={pluginContext} />{(systemInstalled !== true || systemItem?.error) && <section className="panel health-panel"><SystemPluginNotice onOpen={() => navigate('plugins')} /></section>}</div>
        <PluginSlot contributions={renderer.contributions} slot="OverviewAfter" context={pluginContext} />
        <div className="overview-note"><CircleHelp trigger="none" size={15} /><span>{t('统计范围以本机可读取的数据为准。', 'Counts reflect locally readable data. ')}{issues > 0 ? t(`${issues} 个来源存在限制。`, `${issues} sources have limitations.`) : t('进程存活不代表模型正在生成。', 'A live process does not prove model generation.')}</span><button className="text-button" onClick={() => setPage('sources')}>{t('查看数据来源', 'View data sources')}<ChevronRight trigger="none" size={14} /></button></div>
      </>}
      {section && (section === 'system' && systemInstalled !== true ? <div className="panel"><SystemPluginNotice onOpen={() => navigate('plugins')} /></div> : <PluginPage contribution={renderer.contributions.find(plugin => plugin.section === section)} enabled={plugins[section]} error={renderer.errors[monitorPlugins.find(plugin => plugin.section === section)!.id]} context={pluginContext} retry={renderer.retry} />)}
      {page === 'sources' && <><div className="source-intro"><Server trigger="none" size={20} /><p>{t('仅查询本机，不连接云端账号。未授权或未公开的数据不会推算为零；采集失败时会保留上次成功数据并提示。', 'Local queries only, without cloud accounts. Unavailable data is never counted as zero. Failed collection preserves the last successful data and shows an error.')}</p></div>
        {sourceTarget && <p className="footnote source-navigation-note" tabIndex={-1}>{sourceGroups.find(group => group.id === sourceTarget.section)?.sources.some(source => source.id === sourceTarget.id) ? t('已定位指定数据来源。', 'The requested source is selected.') : t('指定来源已不在当前快照中。', 'The requested source is no longer in the current snapshot.')} <button className="text-button" onClick={() => { setSourceTarget(null); navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus() }}>{t('关闭定位', 'Dismiss selection')}</button></p>}
        <SourcePanels groups={sourceGroups} live={!paused && visible} /></>}
      </>}
      <footer className="page-footer"><span>OC Chan</span><span><PluginSlot contributions={renderer.contributions} slot="Footer" context={pluginContext} />{paused ? t(' · 显示已暂停', ' · Display paused') : ''}</span></footer>
      </main>
    </div>
  </div>
}
