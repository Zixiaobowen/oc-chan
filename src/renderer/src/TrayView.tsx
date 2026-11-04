import { useEffect, useState } from 'react'
import { Activity, ArrowUpRight, Coffee } from 'lucide-react'
import type { MonitorSection, MonitorSnapshot, MonitorUpdate } from '../../shared/types'
import { bytes, Meter, time } from './components'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './settings.css'

const empty: MonitorSnapshot = {
  agents: { data: null, error: null, refreshing: false },
  schedules: { data: null, error: null, refreshing: false },
  system: { data: null, error: null, refreshing: false }
}
export default function TrayView() {
  const { t, language } = useI18n()
  const { snapshot: { settings } } = useSettings()
  const [snapshot, setSnapshot] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const api = window.monitor
    if (!api) { setError('Desktop data connection unavailable / 未连接桌面数据接口'); return }
    let active = true
    const received = new Set<MonitorSection>()
    const unsubscribe = api.subscribe((update: MonitorUpdate) => {
      received.add(update.section)
      if (active) setSnapshot(previous => ({ ...previous, [update.section]: update.state }))
    })
    void api.snapshot().then(value => {
      if (active) setSnapshot(previous => ({
        agents: received.has('agents') ? previous.agents : value.agents,
        schedules: received.has('schedules') ? previous.schedules : value.schedules,
        system: received.has('system') ? previous.system : value.system
      }))
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false; unsubscribe() }
  }, [])
  const system = snapshot.system.data
  const agents = snapshot.agents.data
  const jobs = snapshot.schedules.data?.jobs.filter(job => job.kind === 'calendar' || job.kind === 'interval')
  const sources = [snapshot.agents, snapshot.schedules, snapshot.system]
  const collectionError = sources.find(state => state.error)?.error
  const issues = sources.reduce((sum, state) => sum + (state.data?.sources.filter(source => source.state !== 'ok').length ?? 0), 0)
  async function openMain() {
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.showMainWindow()
      setError(null)
    } catch (cause) { setError(String(cause)) }
  }
  return <main className="tray-view">
    <div className="tray-content">
    <header className="tray-heading"><Activity size={23} /><div><h1>OC Chan</h1><p>{system?.hostname || t('此 Mac', 'This Mac')}</p></div>{settings.preventSleep && <Coffee size={18} aria-label={t('防止休眠已开启', 'Prevent sleep enabled')} />}</header>
    {(error || collectionError) && <p className="setting-error" role="alert">{error || collectionError}</p>}
    <dl className="tray-counts"><div><dt>{t('主 Agent', 'Main agents')}</dt><dd>{agents?.agents.filter(agent => agent.kind === 'main').length ?? '—'}</dd></div><div><dt>{t('活动子代理', 'Active subagents')}</dt><dd title={t('仅显示已确认的活动数量；不可见时保留未知。', 'Only confirmed activity counts are shown; unavailable counts remain unknown.')}>{agents?.activeSubagentCount ?? '—'}</dd></div><div><dt>{t('定时任务', 'Schedules')}</dt><dd>{jobs?.length ?? '—'}</dd></div></dl>
    <Meter label="CPU" value={system?.cpuPercent ?? null} detail={system ? t(`${system.cpuCores} 个逻辑核心`, `${system.cpuCores} logical cores`) : t('等待采样', 'Waiting for samples')} />
    <Meter label={t('内存', 'Memory')} value={system ? system.memoryUsed / system.memoryTotal * 100 : null} detail={system ? `${bytes(system.memoryUsed)} / ${bytes(system.memoryTotal)}` : t('等待采样', 'Waiting for samples')} tone="blue" />
    <p className="tray-sample">{t('最近系统采样', 'Last system sample')} {time(system?.collectedAt, language)}</p>
    {issues > 0 && <p className="tray-warning">{t(`${issues} 个来源存在限制，可在主界面查看。`, `${issues} sources have limitations. See the main window for details.`)}</p>}
    </div>
    <button className="button secondary tray-open" onClick={() => void openMain()}>{t('打开主界面', 'Open main window')}<ArrowUpRight size={15} /></button>
  </main>
}
