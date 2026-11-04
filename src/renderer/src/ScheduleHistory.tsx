import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { ScheduleExecution, ScheduleHistory as HistoryPage } from '../../shared/types'
import { useI18n } from './i18n'

const executionLabels: Record<ScheduleExecution['status'], [string, string]> = {
  claimed: ['已领取', 'Claimed'],
  running: ['运行记录', 'Recorded as running'],
  succeeded: ['执行成功', 'Succeeded'],
  failed: ['执行失败', 'Failed'],
  unknown: ['执行结果未知', 'Execution result unknown']
}
const deliveryLabels: Record<NonNullable<ScheduleExecution['delivery']>, [string, string]> = {
  delivered: ['已投递', 'Delivered'],
  failed: ['投递失败', 'Delivery failed'],
  skipped: ['已跳过投递', 'Delivery skipped'],
  unknown: ['投递结果未知', 'Delivery result unknown']
}

export default function ScheduleHistory({ jobId, active }: { jobId: string; active: boolean }) {
  const { language, t } = useI18n()
  const [offset, setOffset] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pageNavigation = useRef(false)
  const restoreCachedPage = useRef(false)

  useLayoutEffect(() => {
    if (!active) return
    if (restoreCachedPage.current) {
      restoreCachedPage.current = false
      setError(null)
      setPhase('ready')
      return
    }
    let current = true
    const monitor = window.monitor
    setError(null)
    if (!monitor) {
      setError('桌面数据连接不可用 / Desktop data connection unavailable')
      setPhase('error')
      return
    }
    setPhase('loading')
    monitor.scheduleHistory(jobId, offset).then(result => {
      if (!current) return
      if (result.jobId !== jobId) {
        setError('执行历史与当前任务不匹配 / History does not match the selected task')
        setPhase('error')
        return
      }
      setPage(result)
      setPhase('ready')
    }, (failure: unknown) => {
      if (!current) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase('error')
    })
    return () => {
      current = false
      monitor.cancelScheduleHistory()
    }
  }, [jobId, active, offset, attempt])

  useLayoutEffect(() => {
    if (phase === 'loading' || !pageNavigation.current) return
    pageNavigation.current = false
    const heading = headingRef.current
    const scroller = heading?.closest('.schedule-drawer-scroll')
    if (heading && scroller && document.activeElement === heading) {
      scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20
    }
  }, [phase, page])

  function changePage(nextOffset: number) {
    if (phase === 'loading') return
    restoreCachedPage.current = phase === 'error' && page?.offset === nextOffset
    pageNavigation.current = true
    headingRef.current?.focus({ preventScroll: true })
    setOffset(nextOffset)
  }

  function timestamp(value: string | undefined) {
    if (!value) return t('未记录', 'Not recorded')
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString(language) : t('时间未知', 'Time unknown')
  }

  return <section className="schedule-history" aria-labelledby="schedule-history-title" aria-busy={phase === 'loading'}>
    <div className="schedule-history-heading">
      <h3 id="schedule-history-title" ref={headingRef} tabIndex={-1}>{t('执行历史', 'Execution history')}</h3>
      <button className="text-button" onClick={() => { if (phase !== 'loading') setAttempt(value => value + 1) }} aria-disabled={phase === 'loading'} aria-label={t('刷新执行历史', 'Refresh execution history')}><RefreshCw size={14} aria-hidden="true" />{phase === 'loading' ? t('读取中', 'Loading') : t('刷新', 'Refresh')}</button>
    </div>
    <p className="schedule-history-note">{t('这里展示数据库中的执行记录。“运行记录”不代表进程仍然存活；当前状态见上方。', 'These are database execution records. “Recorded as running” does not confirm a live process; see the current status above.')}</p>
    <div role="status" aria-live="polite" aria-atomic="true" className={`schedule-history-feedback${phase === 'loading' && page?.offset === offset && page.entries.length ? ' schedule-history-feedback-retained' : ''}`}>
      {phase === 'loading' && <p>{t('正在读取执行历史…', 'Loading execution history…')}</p>}
      {phase === 'error' && <div className="schedule-history-error"><p>{t('执行历史读取失败，请重试。', 'Execution history could not be read. Please retry.')}</p>{error && <p>{error}</p>}</div>}
      {phase === 'ready' && page?.source === 'unavailable' && <p>{t('该来源不提供逐次执行历史。当前状态与最近退出码不等同于执行记录。', 'This source does not provide per-run execution history. Current status and the last exit code are not execution records.')}</p>}
      {phase === 'ready' && page?.source === 'hermes' && !page.entries.length && <p>{page.offset ? t('这一页已没有执行记录，可返回上一页。', 'This page has no execution records. Return to the previous page.') : t('尚无执行记录。任务配置和下次计划不代表任务已经执行。', 'No execution records yet. A task configuration or next run time does not mean it has run.')}</p>}
    </div>
    {phase === 'error' && <button className="button secondary schedule-history-retry" onClick={() => {
      headingRef.current?.focus({ preventScroll: true })
      pageNavigation.current = true
      setAttempt(value => value + 1)
    }}>{t('重试读取', 'Retry')}</button>}
    {page?.offset === offset && page.source === 'hermes' && page.entries.length > 0 && <ol className="schedule-history-list" start={page.offset + 1}>
      {page.entries.map(entry => {
        const elapsed = entry.startedAt && entry.finishedAt ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt) : null
        return <li key={entry.id}>
          <div className="schedule-execution-heading"><strong data-result={entry.status}>{t(...executionLabels[entry.status])}</strong><span className="schedule-execution-id" title={entry.id}>{entry.id}</span></div>
          <dl className="schedule-execution-metadata">
            <div><dt>{t('投递结果', 'Delivery result')}</dt><dd data-delivery={entry.delivery}>{entry.delivery ? t(...deliveryLabels[entry.delivery]) : t('未记录', 'Not recorded')}</dd></div>
            <div><dt>{t('领取', 'Claimed')}</dt><dd>{timestamp(entry.claimedAt)}</dd></div>
            <div><dt>{t('开始', 'Started')}</dt><dd>{timestamp(entry.startedAt)}</dd></div>
            <div><dt>{t('结束', 'Finished')}</dt><dd>{timestamp(entry.finishedAt)}</dd></div>
            {entry.startedAt && <div><dt>{t('执行时长', 'Duration')}</dt><dd>{elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0 ? t(`${(elapsed / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} 秒`, `${(elapsed / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} seconds`) : entry.finishedAt ? t('时间记录不足以计算', 'Cannot calculate from recorded times') : t('尚无结束记录', 'No finish recorded')}</dd></div>}
          </dl>
        </li>
      })}
    </ol>}
    {page && <footer className="schedule-history-footer">
      <p>{t('采集于', 'Collected at')} {timestamp(page.collectedAt)}</p>
      {page.source === 'hermes' && <>
        <p>{page.entries.length ? t(`第 ${page.offset + 1}–${page.offset + page.entries.length} 条 · 每页最多 ${page.limit} 条`, `Records ${page.offset + 1}–${page.offset + page.entries.length} · Up to ${page.limit} per page`) : t(`本页 0 条 · 从第 ${page.offset + 1} 条开始 · 每页最多 ${page.limit} 条`, `0 records · Starting at ${page.offset + 1} · Up to ${page.limit} per page`)}{phase !== 'ready' ? t('（上次读取）', ' (previous read)') : ''}</p>
        <nav className="schedule-history-pagination" aria-label={t('执行历史分页', 'Execution history pages')}>
          <button className="button secondary" disabled={offset === 0 || phase === 'error' && page.offset !== offset - page.limit} aria-disabled={phase === 'loading'} onClick={() => changePage(Math.max(0, offset - page.limit))}><ChevronLeft size={15} aria-hidden="true" />{t('上一页', 'Previous')}</button>
          <button className="button secondary" disabled={phase === 'error' ? page.offset !== offset + page.limit : !page.hasMore} aria-disabled={phase === 'loading'} onClick={() => changePage(offset + page.limit)}>{t('下一页', 'Next')}<ChevronRight size={15} aria-hidden="true" /></button>
        </nav>
      </>}
    </footer>}
  </section>
}
