import { useEffect, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, Coffee, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react'
import type { MonitorSection, MonitorSnapshot, MonitorUpdate, SystemSnapshot } from '../../shared/types'
import { bytes, Chart, Meter, time } from './components'
import { MemoryBreakdown, NetworkTraffic, ProcessRanking } from './SystemMetrics'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './settings.css'
import './tray.css'

const panels = ['overview', 'cpu', 'memory', 'disk', 'network'] as const
type TrayPanel = typeof panels[number]
const panelStorageKey = 'oc-chan.tray-panels'
const empty: MonitorSnapshot = {
  agents: { data: null, error: null, refreshing: false },
  schedules: { data: null, error: null, refreshing: false },
  system: { data: null, error: null, refreshing: false }
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

function MetricSummary({ data, panel }: { data: SystemSnapshot | null; panel: Exclude<TrayPanel, 'overview'> }) {
  const { t } = useI18n()
  const names = { cpu: 'CPU', memory: t('内存', 'Memory'), disk: t('磁盘', 'Disk'), network: t('网络', 'Network') }
  const Icon = { cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Network }[panel]
  const percent = !data ? null : panel === 'cpu' ? data.cpuPercent : panel === 'memory' ? data.memoryUsed / data.memoryTotal * 100 : panel === 'disk' && data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null
  const detail = !data ? t('等待采样', 'Waiting for samples') : panel === 'cpu' ? t(`${data.cpuCores} 个逻辑核心`, `${data.cpuCores} logical cores`) : panel === 'memory' ? `${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}` : panel === 'disk' ? t(`${bytes(data.diskAvailable)} 可用`, `${bytes(data.diskAvailable)} available`) : data.networkInterface ?? t('接口不可用', 'Interface unavailable')
  return <><Icon className="tray-metric-icon" size={17} aria-hidden="true" /><span className="tray-metric-label">{names[panel]}<small>{detail}</small></span>
    {panel === 'network' ? <span className="tray-metric-rates"><span><ArrowDown size={12} aria-hidden="true" /><span className="sr-only">{t('接收', 'Received')}</span>{bytes(data?.rxBytesPerSecond)}/s</span><span><ArrowUp size={12} aria-hidden="true" /><span className="sr-only">{t('发送', 'Sent')}</span>{bytes(data?.txBytesPerSecond)}/s</span></span> : <strong className="tray-metric-value">{percent === null ? '—' : `${percent.toFixed(1)}%`}</strong>}
    <ChevronDown className="tray-disclosure" size={15} aria-hidden="true" />
  </>
}

function MetricSection({ data, panel }: { data: SystemSnapshot | null; panel: Exclude<TrayPanel, 'overview'> }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  return <details className="tray-metric" data-metric={panel} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><MetricSummary data={data} panel={panel} /></summary>
    {expanded && <div className="tray-metric-detail">{data ? <SystemPanel data={data} panel={panel} /> : <p className="tray-note">{t('等待系统采样', 'Waiting for system samples')}</p>}</div>}
  </details>
}

export default function TrayView() {
  const { t, language } = useI18n()
  const { snapshot: { settings } } = useSettings()
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
      received.add(update.section)
      if (active) setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
    })
    void api.snapshot().then(value => {
      if (!active) return
      setSnapshot(previous => ({
        agents: received.has('agents') ? previous.agents : value.agents,
        schedules: received.has('schedules') ? previous.schedules : value.schedules,
        system: received.has('system') ? previous.system : value.system
      }))
      setError(null)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false; unsubscribe() }
  }, [visible])
  const system = snapshot.system.data
  const agents = snapshot.agents.data
  const jobs = snapshot.schedules.data?.jobs.filter(job => job.kind === 'calendar' || job.kind === 'interval')
  const sources = selectedPanels.includes('overview') ? [snapshot.agents, snapshot.schedules, snapshot.system] : [snapshot.system]
  const collectionError = sources.find(state => state.error)?.error
  const problems = sources.flatMap(state => state.data?.sources.filter(source => source.state !== 'ok') ?? [])
  function selectPanel(value: TrayPanel, checked: boolean) {
    const next = panels.filter(panel => panel === value ? checked : selectedPanels.includes(panel))
    setSelectedPanels(next)
    try { localStorage.setItem(panelStorageKey, JSON.stringify(next)); setPreferenceError(null) }
    catch (cause) { setPreferenceError(String(cause)) }
  }
  async function openMain() {
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.showMainWindow()
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
      {selectedPanels.includes('overview') &&
        <dl className="tray-counts"><div><dt>{t('主 Agent', 'Main agents')}</dt><dd>{agents?.agents.filter(agent => agent.kind === 'main').length ?? '—'}</dd></div><div><dt>{t('活动子代理', 'Active subagents')}</dt><dd title={t('仅显示已确认的活动数量；不可见时保留未知。', 'Only confirmed activity counts are shown; unavailable counts remain unknown.')}>{agents?.activeSubagentCount ?? '—'}</dd></div><div><dt>{t('定时任务', 'Schedules')}</dt><dd>{jobs?.length ?? '—'}</dd></div></dl>
      }
      <div className="tray-metrics">{panels.filter((panel): panel is Exclude<TrayPanel, 'overview'> => panel !== 'overview' && selectedPanels.includes(panel)).map(panel => <MetricSection key={panel} data={system} panel={panel} />)}</div>
      {selectedPanels.length === 0 && <p className="tray-note tray-empty">{t('尚未选择内容。展开“显示内容”，勾选你想同时查看的指标。', 'No metrics selected. Open “Show metrics” to choose what to display together.')}</p>}
      <p className="tray-sample">{t('最近系统采样', 'Last system sample')} {time(system?.collectedAt, language)}</p>
      {problems.length > 0 && <details className="tray-warning"><summary>{t(`${problems.length} 个来源存在限制`, `${problems.length} sources have limitations`)}</summary>{problems.map((source, index) => <p key={`${source.id}-${index}`}>{source.detail}</p>)}</details>}
    </div>
    <button className="button secondary tray-open" onClick={() => void openMain()}>{t('打开主界面', 'Open main window')}<ArrowUpRight size={15} /></button>
  </main>
}
