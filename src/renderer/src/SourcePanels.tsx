import { useEffect, useRef, useState } from 'react'
import type { MonitorSection, MonitorSnapshot, SourceHeartbeat, SourceStatus } from '../../shared/types'
import { CollectionStatus, CollectorError, Empty, Sources, time } from './components'
import { useI18n } from './i18n'
import DiagnosticPanel from './DiagnosticPanel'
import { useSettings } from './settings'
import SettingsSaveError from './SettingsSaveError'
import './settings.css'
import { useSystemPlugin } from './marketplace'
import SystemPluginNotice from './SystemPluginNotice'

interface SourceGroup {
  id: MonitorSection
  title: string
  sources: SourceStatus[]
  state: MonitorSnapshot[MonitorSection]
}

function observation(section: MonitorSection, state: MonitorSnapshot[MonitorSection]): SourceHeartbeat {
  return { section, lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt,
    sources: state.data?.sources.map(({ id, lastAttemptAt, lastSuccessAt }) => ({ id, lastAttemptAt, lastSuccessAt })) ?? [] }
}

function SourceSection({ group, heartbeat }: { group: SourceGroup; heartbeat?: SourceHeartbeat }) {
  const { t, language } = useI18n()
  const { snapshot: { settings }, saving, error: saveError, update } = useSettings()
  const { installed: systemInstalled, item: systemItem } = useSystemPlugin()
  const enabled = settings.plugins[group.id]
  const changing = useRef(false)
  async function toggle() {
    if (saving || changing.current || (group.id === 'system' && !systemInstalled)) return
    changing.current = true
    try { await update({ plugins: { [group.id]: !enabled } }) }
    finally { changing.current = false }
  }
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function retry() {
    if (!enabled || saving || request.current) return
    request.current = true
    setPending(true)
    setError(null)
    try {
      if (!window.monitor) throw new Error(t('桌面连接不可用。', 'The desktop connection is unavailable.'))
      await window.monitor.refresh(group.id)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      request.current = false
      if (mounted.current) setPending(false)
    }
  }
  if (group.id === 'system' && !systemInstalled) return <section className="panel source-group" data-source-section="system">
    <div className="section-heading"><h2>{group.title}</h2></div><SystemPluginNotice />
  </section>
  return <section className="panel source-group" data-source-section={group.id}>
    {group.id === 'system' && systemItem?.error && <SystemPluginNotice />}
    <div className="section-heading source-group-heading"><h2 id={`collection-${group.id}-label`}>{group.title}</h2>
      <div className="setting-toggle" aria-busy={saving}>
        <button type="button" role="switch" className="setting-switch" aria-labelledby={`collection-${group.id}-label`} aria-describedby={`collection-${group.id}-help`} aria-checked={enabled} aria-disabled={saving} onClick={() => void toggle()}><span /></button>
        <span>{saving && changing.current ? t('正在保存…', 'Saving…') : enabled ? t('采集已开启', 'Collection enabled') : t('采集已停用', 'Collection disabled')}</span>
      </div>
    </div>
    <p className="source-collection-help" id={`collection-${group.id}-help`}>{t('仅控制 OC Chan 的采集；不会停止 Agent 或真实任务。', 'Controls OC Chan collection only; agents and actual tasks keep running.')}{group.id === 'schedules' && t(' 执行历史也依赖此开关。', ' Execution history also depends on this switch.')}</p>
    {saveError?.patch.plugins && Object.hasOwn(saveError.patch.plugins, group.id) && <SettingsSaveError settingLabel={group.title} />}
    <CollectionStatus enabled={enabled} collectedAt={group.state.data?.collectedAt} />
    {enabled && (group.state.error || error) && <div className="source-section-error" role="alert">
      <p>{error || group.state.error}</p>
      <p>{t('保留上次数据；重试只采集此分区。', 'Previous data is retained. Retry collects only this section.')}</p>
      <button className="button secondary" aria-disabled={pending || saving} aria-busy={pending} onClick={() => void retry()}>{pending ? t('正在重试', 'Retrying') : t('重试此分区', 'Retry section')}</button>
    </div>}
    {group.sources.length ? <Sources sources={group.sources} observations={heartbeat?.sources} enabled={enabled} />
      : <Empty title={!enabled ? t('采集已停用 · 尚无数据', 'Collection disabled · No data') : group.state.error ? t('尚无成功数据', 'No successful data yet') : group.state.data ? t('此分区没有来源', 'No sources in this section') : t('尚未完成采集', 'Collection not yet complete')}>
        {t('读取失败与空结果分别报告；不会把缺失数据计为零。', 'Read failures and empty results are reported separately; missing data is never counted as zero.')}
      </Empty>}
    <div className="panel-footer source-section-times" aria-live="off">
      <span>{t('最近尝试', 'Last attempt')} {(heartbeat?.lastAttemptAt ?? group.state.lastAttemptAt) ? time(heartbeat?.lastAttemptAt ?? group.state.lastAttemptAt, language) : t('尚未尝试', 'Not attempted')}</span>
      <span>{t('最近成功采样', 'Last successful sample')} {(heartbeat?.lastSuccessAt ?? group.state.lastSuccessAt) ? time(heartbeat?.lastSuccessAt ?? group.state.lastSuccessAt, language) : t('尚无成功采样', 'No successful sample')}</span>
    </div>
  </section>
}

export default function SourcePanels({ groups, live }: { groups: SourceGroup[]; live: boolean }) {
  const [heartbeats, setHeartbeats] = useState<Partial<Record<MonitorSection, SourceHeartbeat>>>({})
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const api = window.monitor
    if (!live || !api) return
    let active = true
    const received = new Set<MonitorSection>()
    const accept = (heartbeat: SourceHeartbeat) => {
      if (!active) return
      received.add(heartbeat.section)
      setHeartbeats(previous => ({ ...previous, [heartbeat.section]: heartbeat }))
    }
    const unsubscribeSources = api.subscribeSources(accept)
    const unsubscribeData = api.subscribe(update => accept(observation(update.section, update.state)))
    void api.snapshot().then(snapshot => {
      if (!active) return
      setHeartbeats(previous => {
        const next = { ...previous }
        for (const section of ['agents', 'schedules', 'system', 'events'] as const) {
          if (!received.has(section)) next[section] = observation(section, snapshot[section])
        }
        return next
      })
      setError(null)
    }, failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { active = false; unsubscribeSources(); unsubscribeData() }
  }, [live, attempt])
  return <>
    <CollectorError error={error} onRetry={() => setAttempt(value => value + 1)} />
    <DiagnosticPanel />
    {groups.map(group => <SourceSection key={group.id} group={group} heartbeat={heartbeats[group.id]} />)}
  </>
}
