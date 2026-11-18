import { useLayoutEffect, useRef, useState } from 'react'
import type { ScheduleDetail } from '../../shared/types'
import { useI18n } from './i18n'
import { reportDesktopFailure } from './desktop-api'

// Mounted only while this exact selection is visible and collection is active.
// Configuration is never placed in navigation memory or the monitor snapshot.
export default function ScheduleConfiguration({ jobId, identity, onSettled }: {
  jobId: string
  identity: string
  onSettled: () => void
}) {
  const { t, language } = useI18n()
  const [detail, setDetail] = useState<ScheduleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'cancelled'>('loading')
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)

  useLayoutEffect(() => {
    const request = ++generation.current
    const monitor = window.monitor
    setDetail(null)
    setError(null)
    setPhase('loading')
    if (!monitor) {
      setError('桌面数据连接不可用 / Desktop data connection unavailable')
      setPhase('error')
      return
    }
    void monitor.scheduleDetail(jobId, identity).then(value => {
      if (generation.current !== request) return
      if (value.jobId !== jobId) throw new Error('任务配置身份不匹配 / Task configuration identity mismatch')
      setDetail(value)
      setPhase('ready')
    }).catch((failure: unknown) => {
      if (generation.current !== request) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase('error')
    })
    return () => {
      generation.current++
      void monitor.cancelScheduleDetail().catch(reportDesktopFailure)
    }
  }, [jobId, identity, attempt])

  useLayoutEffect(() => {
    if (phase !== 'loading') onSettled()
  }, [phase, onSettled])

  function cancel() {
    generation.current++
    setDetail(null)
    setError(null)
    setPhase('cancelled')
    void window.monitor?.cancelScheduleDetail().catch(reportDesktopFailure)
  }

  return <section className="schedule-history schedule-configuration" aria-labelledby="schedule-configuration-title" aria-busy={phase === 'loading'}>
    <div className="schedule-history-heading">
      <h3 id="schedule-configuration-title">{t('任务配置', 'Task configuration')}</h3>
      {phase === 'loading'
        ? <button type="button" className="text-button" onClick={cancel}>{t('取消读取', 'Cancel read')}</button>
        : <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>{phase === 'error' || phase === 'cancelled' ? t('重试读取配置', 'Retry configuration') : t('刷新配置', 'Refresh configuration')}</button>}
    </div>
    <p className="schedule-history-note">{t('按需读取任务配置，不读取会话或聊天记录；配置内容不代表实际执行结果。', 'Reads task configuration on demand, without reading sessions or chat history. Configuration does not confirm execution results.')}</p>
    <div className="schedule-history-feedback" role="status" aria-live="polite">
      {phase === 'loading' && <p>{t('正在读取配置…', 'Reading configuration…')}</p>}
      {phase === 'cancelled' && <p>{t('配置读取已取消。', 'Configuration read cancelled.')}</p>}
      {phase === 'error' && <div className="schedule-history-error"><p>{t('任务配置读取失败，请重试。', 'Task configuration could not be read. Please retry.')}</p><p>{error}</p></div>}
      {phase === 'ready' && detail && !detail.fields.length && <p>{t('该来源未提供可展示的配置字段。', 'This source provides no configuration fields to display.')}</p>}
    </div>
    {detail && <>
      <dl className="schedule-configuration-fields">{detail.fields.map((field, index) => <div key={`${field.key}:${index}`}><dt>{field.key}</dt><dd><pre>{field.value}</pre></dd></div>)}</dl>
      {detail.notes.map((note, index) => <p className="schedule-history-note" key={index}>{note}</p>)}
      <p className="schedule-history-note">{t('采集于', 'Collected at')} <time dateTime={detail.collectedAt}>{new Date(detail.collectedAt).toLocaleString(language)}</time></p>
    </>}
  </section>
}
