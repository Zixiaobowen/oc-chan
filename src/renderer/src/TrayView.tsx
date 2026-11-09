import { useEffect, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, Coffee, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react'
import type { MonitorSection, MonitorSnapshot, MonitorUpdate, SystemSnapshot } from '../../shared/types'
import { bytes, Chart, CollectionStatus, Meter, time } from './components'
import { MemoryBreakdown, NetworkTraffic, ProcessRanking } from './SystemMetrics'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './settings.css'
import './tray.css'
import { agentTarget, scheduleTarget, type NavigationTarget } from '../../shared/navigation'
import { useSystemPlugin } from './marketplace'
import SystemPluginNotice from './SystemPluginNotice'

const panels = ['overview', 'cpu', 'memory', 'disk', 'network'] as const
type TrayPanel = typeof panels[number]
const panelStorageKey = 'oc-chan.tray-panels'
const empty: MonitorSnapshot = {
  agents: { data: null, error: null, refreshing: false },
  schedules: { data: null, error: null, refreshing: false },
  system: { data: null, error: null, refreshing: false },
  events: { data: null, error: null, refreshing: false }
}

function SystemPanel({ data, panel }: { data: SystemSnapshot; panel: Exclude<TrayPanel, 'overview'> }) {
  const { t } = useI18n()
  if (panel === 'network') return <NetworkTraffic data={data} />
  if (panel === 'disk') return <>
    <Meter label={t('数据卷空间', 'Data volume space')} value={data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null} detail={t('已用空间占比', 'Used capacity')} tone="blue" />
    <dl className="tray-details">
      <div><dt>{t('已用', 'Used')}</dt><dd>{bytes(data.diskUsed)}</dd></div>
      <div><dt>{t('可用', 'Available')}</dt><dd>{bytes(data.diskAvailable)}</dd></div>
      <div><dt>{t('总容量', 'Total capacity')}</dt><dd>{bytes(data.diskTotal)}</dd></div>
    </dl>
    <p className="tray-note">{t('数据卷 /System/Volumes/Data；显示空间容量。', 'Data volume /System/Volumes/Data; storage capacity.')}</p>
  </>
  const cpu = panel === 'cpu'
  return <>
    <Meter label={cpu ? t('CPU 使用率', 'CPU usage') : t('内存使用率', 'Memory usage')} value={cpu ? data.cpuPercent : data.memoryUsed / data.memoryTotal * 100} detail={cpu ? t(`${data.cpuCores} 个逻辑核心 · 全机 100%`, `${data.cpuCores} logical cores · 100% total`) : `${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}`} tone={cpu ? 'green' : 'blue'} />
    <Chart samples={data.history} field={cpu ? 'cpuPercent' : 'memoryPercent'} label={cpu ? t('CPU 使用率', 'CPU usage') : t('内存使用率', 'Memory usage')} />
    {!cpu && <MemoryBreakdown data={data} />}
    <h2 className="tray-process-title">{cpu ? t('CPU 占用前五', 'Top five by CPU') : t('内存占用前五', 'Top five by memory')}</h2>
    {cpu && <p className="tray-note">{t('进程 CPU 按单核 100% 计', 'Process CPU: 100% per core')}</p>}
    <ProcessRanking processes={cpu ? data.processes : data.memoryProcesses} by={cpu ? 'cpu' : 'memory'} compact />
  </>
}

function MetricSummary({ data, panel, enabled }: { data: SystemSnapshot | null; panel: Exclude<TrayPanel, 'overview'>; enabled: boolean }) {
  const { t } = useI18n()
  const names = { cpu: 'CPU', memory: t('内存', 'Memory'), disk: t('磁盘', 'Disk'), network: t('网络', 'Network') }
  const Icon = { cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Network }[panel]
  const percent = !data ? null : panel === 'cpu' ? data.cpuPercent : panel === 'memory' ? data.memoryUsed / data.memoryTotal * 100 : panel === 'disk' && data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null
  const detail = !enabled ? t('采集已停用 · 旧快照', 'Collection disabled · Retained snapshot') : !data ? t('等待采样', 'Waiting for samples') : panel === 'cpu' ? t(`${data.cpuCores} 个逻辑核心`, `${data.cpuCores} logical cores`) : panel === 'memory' ? `${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}` : panel === 'disk' ? t(`${bytes(data.diskAvailable)} 可用`, `${bytes(data.diskAvailable)} available`) : data.networkInterface ?? t('接口不可用', 'Interface unavailable')
  return <><Icon className="tray-metric-icon" size={17} aria-hidden="true" /><span className="tray-metric-label">{names[panel]}<small>{detail}</small></span>
    {panel === 'network' ? <span className="tray-metric-rates"><span><ArrowDown size={12} aria-hidden="true" /><span className="sr-only">{t('接收', 'Received')}</span>{bytes(data?.rxBytesPerSecond)}/s</span><span><ArrowUp size={12} aria-hidden="true" /><span className="sr-only">{t('发送', 'Sent')}</span>{bytes(data?.txBytesPerSecond)}/s</span></span> : <strong className="tray-metric-value">{percent === null ? '—' : `${percent.toFixed(1)}%`}</strong>}
    <ChevronDown className="tray-disclosure" size={15} aria-hidden="true" />
  </>
}

function MetricSection({ data, panel, enabled }: { data: SystemSnapshot | null; panel: Exclude<TrayPanel, 'overview'>; enabled: boolean }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  return <details className="tray-metric" data-metric={panel} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><MetricSummary data={data} panel={panel} enabled={enabled} /></summary>
    {expanded && <div className="tray-metric-detail">{data ? <SystemPanel data={data} panel={panel} /> : <p className="tray-note">{enabled ? t('等待系统采样', 'Waiting for system samples') : t('采集已停用 · 尚无数据', 'Collection disabled · No data')}</p>}</div>}
  </details>
}

export default function TrayView() {
  const { t, language } = useI18n()
  const { snapshot: { settings } } = useSettings()
  const { installed: systemInstalled, item: systemItem } = useSystemPlugin()
  const systemReady = systemInstalled === true && (!systemItem?.error || systemItem.enabled)
  const [snapshot, setSnapshot] = useState(empty)
  const [selectedPanels, setSelectedPanels] = useState<TrayPanel[]>([...panels])
  const [visible, setVisible] = useState(!document.hidden)
  const [error, setError] = useState<string | null>(null)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(panelStorageKey)
      if (stored !== null) {
        if (stored.length > 128) throw new Error('Tray selection is too large / 托盘显示组合超出限制')
        const value: unknown = JSON.parse(stored)
        if (!Array.isArray(value) || value.length > panels.length || value.some(item => !panels.includes(item)) || new Set(value).size !== value.length) throw new Error('Invalid tray selection / 托盘显示组合无效')
        setSelectedPanels(panels.filter(panel => value.includes(panel)))
      }
    } catch (cause) { setPreferenceError(String(cause)) }
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  useEffect(() => {
    if (!visible) return
    const api = window.monitor
    if (!api) { setError('Desktop data connection unavailable / 未连接桌面数据接口'); return }
    let active = true
    const received = new Set<MonitorSection>()
    const unsubscribe = api.subscribe((update: MonitorUpdate) => {
      if (!active || document.hidden) return
      received.add(update.section)
      setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
    })
    void api.snapshot().then(value => {
      if (!active || document.hidden) return
      setSnapshot(previous => ({
        agents: received.has('agents') ? previous.agents : value.agents,
        schedules: received.has('schedules') ? previous.schedules : value.schedules,
        system: received.has('system') ? previous.system : value.system,
        events: received.has('events') ? previous.events : value.events
      }))
      setError(null)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false; unsubscribe() }
  }, [visible])
  useEffect(() => {
    if (systemInstalled === false) setSnapshot(previous => ({ ...previous, system: empty.system }))
  }, [systemInstalled])
  const system = systemReady ? snapshot.system.data : null
  const agents = snapshot.agents.data
  const jobs = snapshot.schedules.data?.jobs.filter(job => job.kind === 'calendar' || job.kind === 'interval')
  const sections = (['agents', 'schedules', 'system'] as const).filter(section => settings.plugins[section] && (section !== 'system' || systemReady) && (selectedPanels.includes('overview') || section === 'system'))
  const sources = sections.map(section => snapshot[section])
  const collectionError = sources.find(state => state.error)?.error
  const problems = sources.flatMap(state => state.data?.sources.filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled') ?? [])
  function selectPanel(value: TrayPanel, checked: boolean) {
    const next = panels.filter(panel => panel === value ? checked : selectedPanels.includes(panel))
    setSelectedPanels(next)
    try { localStorage.setItem(panelStorageKey, JSON.stringify(next)); setPreferenceError(null) }
    catch (cause) { setPreferenceError(String(cause)) }
  }
  async function openMain(target?: NavigationTarget) {
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.showMainWindow(target)
      setError(null)
    } catch (cause) { setError(String(cause)) }
  }
  return <main className="tray-view">
    <div className="tray-top">
      <header className="tray-heading"><Activity size={23} /><div><h1>OC Chan</h1><p title={system?.hostname}>{system?.hostname || t('此 Mac', 'This Mac')}</p></div>{settings.preventSleep && <Coffee size={18} aria-label={t('防止休眠已开启', 'Prevent sleep enabled')} />}</header>
    </div>
    <div className="tray-content" id="tray-panel">
      <details className="tray-customize">
        <summary><span>{t('显示内容', 'Show metrics')}</span><span>{t(`${selectedPanels.length} 项`, `${selectedPanels.length} selected`)}<ChevronDown className="tray-disclosure" size={15} aria-hidden="true" /></span></summary>
        <fieldset><legend className="sr-only">{t('选择要同时显示的内容', 'Choose metrics to show together')}</legend>{panels.map(panel => <label key={panel}>
          <input type="checkbox" checked={selectedPanels.includes(panel)} onChange={event => selectPanel(panel, event.target.checked)} />
          <span>{{ overview: t('Agent 与任务', 'Agents & schedules'), cpu: 'CPU', memory: t('内存', 'Memory'), disk: t('磁盘', 'Disk'), network: t('网络', 'Network') }[panel]}</span>
        </label>)}</fieldset>
      </details>
      {(error || collectionError) && <p className="setting-error" role="alert">{error || collectionError}{collectionError && t('；保留上次采样数据。', '; retaining the last sample.')}</p>}
      {preferenceError && <p className="setting-error" role="alert">{t('无法保存或读取显示偏好：', 'Could not save or read display preference: ')}{preferenceError}</p>}
      {selectedPanels.includes('overview') && <>
        <CollectionStatus enabled={settings.plugins.agents} collectedAt={agents?.collectedAt} label={t('Agent', 'Agents')} />
        <CollectionStatus enabled={settings.plugins.schedules} collectedAt={snapshot.schedules.data?.collectedAt} label={t('定时任务', 'Schedules')} />
        <dl className="tray-counts"><div><dt>{t('主 Agent', 'Main agents')}{!settings.plugins.agents && <small>{t('采集已停用', 'Collection disabled')}</small>}</dt><dd>{settings.plugins.agents ? agents?.agents.filter(agent => agent.kind === 'main').length ?? '—' : '—'}</dd></div><div><dt>{t('活动子代理', 'Active subagents')}</dt><dd title={t('仅显示已确认的活动数量；不可见时保留未知。', 'Only confirmed activity counts are shown; unavailable counts remain unknown.')}>{settings.plugins.agents ? agents?.activeSubagentCount ?? '—' : '—'}</dd></div><div><dt>{t('定时任务', 'Schedules')}{!settings.plugins.schedules && <small>{t('采集已停用', 'Collection disabled')}</small>}</dt><dd>{settings.plugins.schedules ? jobs?.length ?? '—' : '—'}</dd></div></dl>
        <details className="tray-object-list"><summary>{t('查看 Agent 与任务', 'View agents and tasks')}</summary>
          {agents?.agents.slice(0, 5).map(agent => <button key={agent.id} className="text-button" title={agent.summary || agent.name} onClick={() => void openMain(agentTarget(agent))}>{agent.summary || agent.name}<ArrowUpRight size={14} aria-hidden="true" /></button>)}
          {jobs?.slice(0, 5).map(job => <button key={job.id} className="text-button" title={job.name} onClick={() => void openMain(scheduleTarget(job))}>{job.name}<ArrowUpRight size={14} aria-hidden="true" /></button>)}
          <button className="text-button" onClick={() => void openMain({ kind: 'page', page: 'agents' })}>{t('全部 Agent', 'All agents')}</button>
          <button className="text-button" onClick={() => void openMain({ kind: 'page', page: 'schedules' })}>{t('全部任务', 'All tasks')}</button>
        </details>
      </>}
      {selectedPanels.some(panel => panel !== 'overview') && (systemReady ? <CollectionStatus enabled={settings.plugins.system} collectedAt={system?.collectedAt} label={t('系统监控', 'System monitor')} /> : <SystemPluginNotice onOpen={() => void openMain({ kind: 'page', page: 'plugins' })} />)}
      {systemReady && <div className="tray-metrics">{panels.filter((panel): panel is Exclude<TrayPanel, 'overview'> => panel !== 'overview' && selectedPanels.includes(panel)).map(panel => <MetricSection key={panel} data={system} panel={panel} enabled={settings.plugins.system} />)}</div>}
      {selectedPanels.length === 0 && <p className="tray-note tray-empty">{t('尚未选择内容。展开“显示内容”，勾选你想同时查看的指标。', 'No metrics selected. Open “Show metrics” to choose what to display together.')}</p>}
      {systemReady && <p className="tray-sample">{t('最近系统采样', 'Last system sample')} {system ? time(system.collectedAt, language) : settings.plugins.system ? t('等待采样', 'Waiting for samples') : t('尚无采样', 'No sample')}</p>}
      {problems.length > 0 && <details className="tray-warning"><summary>{t(`${problems.length} 个来源存在限制`, `${problems.length} sources have limitations`)}</summary>{sections.flatMap(section => (snapshot[section].data?.sources ?? []).filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled').map(source => <div key={`${section}-${source.id}`}><p>{source.detail}</p><button className="text-button" onClick={() => void openMain({ kind: 'source', section, id: source.id })}>{t('查看来源', 'View source')}<ArrowUpRight size={14} aria-hidden="true" /></button></div>))}</details>}
    </div>
    <button className="button secondary tray-open" onClick={() => void openMain()}>{t('打开主界面', 'Open main window')}<ArrowUpRight size={15} /></button>
  </main>
}
