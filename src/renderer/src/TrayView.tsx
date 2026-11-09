import { useEffect, useState } from 'react'
import Activity from 'kubai-icons-react/icons/activity'
import ArrowUpRight from 'kubai-icons-react/icons/arrow-up-right'
import ChevronDown from 'kubai-icons-react/icons/chevron-down'
import Coffee from 'kubai-icons-react/icons/coffee'
import type { MonitorSection, MonitorSnapshot, MonitorUpdate } from '../../shared/types'
import { createEmptySnapshot, monitorSections } from '../../shared/plugin-catalog'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import { PluginSlot, useRendererPlugins, type RendererContext } from './plugins'
import { isTrayPanelSelected, parseTraySelection, updateTraySelection } from './plugins/tray-selection'
import ContributionBoundary from './plugins/ContributionBoundary'
import './settings.css'
import './tray.css'
import type { NavigationTarget } from '../../shared/navigation'

const panelStorageKey = 'oc-chan.tray-panels'
export default function TrayView() {
  const { t } = useI18n()
  const { snapshot: { settings } } = useSettings()
  const renderer = useRendererPlugins(settings.plugins)
  const [snapshot, setSnapshot] = useState(createEmptySnapshot)
  const [selection, setSelection] = useState(() => parseTraySelection(null))
  const [visible, setVisible] = useState(!document.hidden)
  const [error, setError] = useState<string | null>(null)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  useEffect(() => {
    try { setSelection(parseTraySelection(localStorage.getItem(panelStorageKey))) }
    catch (cause) { setPreferenceError(String(cause)) }
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
      setSnapshot(previous => Object.fromEntries(monitorSections.map(section => [section, received.has(section) ? previous[section] : value[section]])) as MonitorSnapshot)
      setError(null)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false; unsubscribe() }
  }, [visible])
  const panels = renderer.contributions.flatMap(plugin => plugin.tray ?? [])
  const selected = panels.filter(panel => isTrayPanelSelected(selection, panel.id))
  const sections = [...new Set(selected.flatMap(panel => panel.sections))].filter(section => settings.plugins[section])
  const sources = sections.map(section => snapshot[section])
  const collectionError = sources.find(state => state.error)?.error
  const problems = sources.flatMap(state => state.data?.sources.filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled') ?? [])
  function selectPanel(value: string, checked: boolean) {
    try {
      const next = updateTraySelection(selection, value, checked)
      setSelection(next)
      localStorage.setItem(panelStorageKey, JSON.stringify(next))
      setPreferenceError(null)
    } catch (cause) { setPreferenceError(String(cause)) }
  }
  async function openMain(target?: NavigationTarget) {
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.showMainWindow(target)
      setError(null)
    } catch (cause) { setError(String(cause)) }
  }
  const context: RendererContext = { snapshot, plugins: settings.plugins, paused: false, visible,
    navigate: page => { void openMain({ kind: 'page', page }) }, openTarget: target => { void openMain(target) } }
  return <main className="tray-view">
    <div className="tray-top">
      <header className="tray-heading"><Activity trigger="none" size={23} /><div><h1>OC Chan</h1><PluginSlot contributions={renderer.contributions} slot="TrayHeading" context={context} /></div>{settings.preventSleep && <Coffee trigger="none" size={18} title={t('防止休眠已开启', 'Prevent sleep enabled')} />}</header>
    </div>
    <div className="tray-content" id="tray-panel">
      <details className="tray-customize">
        <summary><span>{t('显示内容', 'Show metrics')}</span><span>{t(`${selected.length} 项`, `${selected.length} selected`)}<ChevronDown trigger="none" className="tray-disclosure" size={15} aria-hidden="true" /></span></summary>
        <fieldset><legend className="sr-only">{t('选择要同时显示的内容', 'Choose metrics to show together')}</legend>{panels.map(panel => <label key={panel.id}>
          <input type="checkbox" checked={isTrayPanelSelected(selection, panel.id)} onChange={event => selectPanel(panel.id, event.target.checked)} />
          <span>{t(...panel.label)}</span>
        </label>)}</fieldset>
      </details>
      {(error || collectionError) && <p className="setting-error" role="alert">{error || collectionError}{collectionError && t('；保留上次采样数据。', '; retaining the last sample.')}</p>}
      {Object.entries(renderer.errors).map(([id, message]) => <p key={id} className="setting-error" role="alert">{message} <button className="text-button" onClick={renderer.retry}>{t('重试', 'Retry')}</button></p>)}
      {preferenceError && <p className="setting-error" role="alert">{t('无法保存或读取显示偏好：', 'Could not save or read display preference: ')}{preferenceError}</p>}
      <div className="tray-metrics">{selected.map(panel => <ContributionBoundary key={panel.id}><panel.Component {...context} /></ContributionBoundary>)}</div>
      {selected.length === 0 && <p className="tray-note tray-empty">{t('尚未选择内容。展开“显示内容”，勾选你想同时查看的指标。', 'No metrics selected. Open “Show metrics” to choose what to display together.')}</p>}
      <PluginSlot contributions={renderer.contributions} slot="TrayFooter" context={context} />
      {problems.length > 0 && <details className="tray-warning"><summary>{t(`${problems.length} 个来源存在限制`, `${problems.length} sources have limitations`)}</summary>{sections.flatMap(section => (snapshot[section].data?.sources ?? []).filter(source => source.state !== 'ok' && source.state !== 'empty' && source.state !== 'disabled').map(source => <div key={`${section}-${source.id}`}><p>{source.detail}</p><button className="text-button" onClick={() => void openMain({ kind: 'source', section, id: source.id })}>{t('查看来源', 'View source')}<ArrowUpRight trigger="none" size={14} aria-hidden="true" /></button></div>))}</details>}
    </div>
    <button className="button secondary tray-open" onClick={() => void openMain()}>{t('打开主界面', 'Open main window')}<ArrowUpRight trigger="none" size={15} /></button>
  </main>
}
