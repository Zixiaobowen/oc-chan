import { useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import ChevronLeft from 'kubai-icons-react/icons/chevron-left'
import ChevronRight from 'kubai-icons-react/icons/chevron-right'
import Sync from 'kubai-icons-react/icons/sync'
import { EVENT_MAX_RECORDS, EVENT_PAGE_SIZE, EVENT_TYPES, type EventCoverage, type EventPage, type EventQuery, type LocalEvent, type LocalEventType } from '../../shared/events'
import { agentTarget, scheduleTarget, type NavigationTarget } from '../../shared/navigation'
import type { MonitorSnapshot } from '../../shared/types'
import { NativeSelect } from './components'
import { useI18n } from './i18n'
import './events.css'

type EventRange = 'all' | '1h' | '24h' | '7d'
interface EventFilters { sourceId: string; type: LocalEventType | 'all'; range: EventRange }
interface EventRequest {
  query: EventQuery
  filters: EventFilters
  history: (number | null)[]
  pageNumber: number
  reason: 'apply' | 'refresh' | 'previous' | 'next' | 'latest' | 'clear'
}
export interface EventViewState {
  draft: EventFilters
  applied: EventFilters
  query: EventQuery
  page: EventPage | null
  history: (number | null)[]
  pageNumber: number
  request: EventRequest | null
  requestId: number
  error: string | null
  readAt: string | null
  coverageOpen: boolean
}

const MAX_CURSOR_HISTORY = 200
const defaultFilters = (): EventFilters => ({ sourceId: '', type: 'all', range: 'all' })
const typeLabels: Record<LocalEventType, [string, string]> = {
  'execution-failed': ['执行失败', 'Execution failed'],
  'delivery-failed': ['投递失败', 'Delivery failed'],
  'source-unavailable': ['来源不可用', 'Source unavailable'],
  'source-recovered': ['来源恢复', 'Source recovered']
}
const rangeLabels: Record<EventRange, [string, string]> = {
  all: ['全部时间', 'All time'], '1h': ['最近 1 小时', 'Last hour'],
  '24h': ['最近 24 小时', 'Last 24 hours'], '7d': ['最近 7 天', 'Last 7 days']
}
const coverageLabels: Record<EventCoverage['state'], [string, string]> = {
  baseline: ['建立基线', 'Establishing baseline'], observing: ['持续观察', 'Observing'],
  'catching-up': ['补读中', 'Catching up'], gap: ['存在断档', 'Coverage gap'],
  disabled: ['已停用', 'Disabled'], unavailable: ['不可用', 'Unavailable']
}

export function createEventView(): EventViewState {
  return { draft: defaultFilters(), applied: defaultFilters(), query: {}, page: null, history: [],
    pageNumber: 1, request: null, requestId: 0, error: null, readAt: null, coverageOpen: false }
}

function filterQuery(filters: EventFilters): EventQuery {
  const query: EventQuery = {}
  if (filters.sourceId) query.sourceId = filters.sourceId
  if (filters.type !== 'all') query.type = filters.type
  if (filters.range !== 'all') {
    const now = Date.now()
    const duration = filters.range === '1h' ? 3_600_000 : filters.range === '24h' ? 86_400_000 : 604_800_000
    query.from = new Date(now - duration).toISOString()
    query.to = new Date(now).toISOString()
  }
  return query
}

function EventIdentity({ entry, snapshot, onNavigate }: {
  entry: LocalEvent
  snapshot: MonitorSnapshot
  onNavigate: (target: NavigationTarget) => void
}) {
  const { t } = useI18n()
  const target = entry.target
  let name = entry.entityId
  let reason: string | null = null
  let navigable = false
  if (target?.kind === 'agent') {
    const agent = snapshot.agents.data?.agents.find(value => value.id === target.id)
    if (agent && agentTarget(agent).identity === target.identity) {
      name = agent.name
      navigable = true
    } else reason = !snapshot.agents.data
      ? t('尚无 Agent 数据，无法核对身份。', 'No agent data is available to verify this identity.')
      : agent ? t('同 ID 的 Agent 身份已变化，不跳转。', 'The agent with this ID has a different identity; navigation is unavailable.')
        : t('此 Agent 已不在当前快照中，不跳转。', 'This agent is absent from the current snapshot; navigation is unavailable.')
  } else if (target?.kind === 'schedule') {
    const job = snapshot.schedules.data?.jobs.find(value => value.id === target.id)
    if (job && scheduleTarget(job).identity === target.identity) {
      name = job.name
      navigable = true
    } else reason = !snapshot.schedules.data
      ? t('尚无任务数据，无法核对身份。', 'No schedule data is available to verify this identity.')
      : job ? t('同 ID 的任务身份已变化，不跳转。', 'The schedule with this ID has a different identity; navigation is unavailable.')
        : t('此任务已不在当前快照中，不跳转。', 'This schedule is absent from the current snapshot; navigation is unavailable.')
  } else if (target?.kind === 'source') {
    const source = snapshot[target.section].data?.sources.find(value => value.id === target.id)
    name = source?.label ?? target.id
    navigable = true
    if (!source) reason = t('来源已不在当前快照中；可查看来源页的失效说明。', 'This source is absent from the current snapshot; open Sources for the unavailable-target explanation.')
  }
  return <div className="event-identity">
    <strong>{name}</strong>
    <span className="event-id">{t('原始对象 ID', 'Original entity ID')}: {entry.entityId}</span>
    {target && target.id !== entry.entityId && <span className="event-id">{t('目标 ID', 'Target ID')}: {target.id}</span>}
    {reason && <p className="event-target-reason">{reason}</p>}
    {navigable && target && <button type="button" className="text-button" data-event-action="target" onClick={() => onNavigate(target)}>
      {target.kind === 'source' ? t('查看来源', 'View source') : target.kind === 'agent' ? t('查看 Agent', 'View agent') : t('查看任务', 'View schedule')}
    </button>}
    {!target && <span className="event-target-reason">{t('此记录没有可导航目标。', 'This record has no navigation target.')}</span>}
  </div>
}

export default function EventsView({ snapshot, enabled, active, view, onViewChange, onNavigate }: {
  snapshot: MonitorSnapshot
  enabled: boolean
  active: boolean
  view: EventViewState
  onViewChange: Dispatch<SetStateAction<EventViewState>>
  onNavigate: (target: NavigationTarget) => void
}) {
  const { t, language } = useI18n()
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'inactive'>('loading')
  const viewRef = useRef(view)
  viewRef.current = view
  const generation = useRef(0)
  const lastRequestId = useRef(view.requestId)
  const canRead = enabled && active && visible

  useLayoutEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        generation.current += 1
        window.monitor?.cancelEvents()
      }
      setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useLayoutEffect(() => {
    const token = ++generation.current
    const monitor = window.monitor
    monitor?.cancelEvents()
    if (!canRead) {
      setPhase('inactive')
      return () => { generation.current += 1; monitor?.cancelEvents() }
    }
    const current = viewRef.current
    // Activation restores the successful page; only a new explicit request changes its cursor.
    const requested = current.requestId !== lastRequestId.current
    lastRequestId.current = current.requestId
    const request: EventRequest = (requested || !current.page) && current.request ? current.request : {
      query: current.query, filters: current.applied, history: current.history, pageNumber: current.pageNumber, reason: 'refresh'
    }
    setPhase('loading')
    function fail(failure: unknown) {
      if (generation.current !== token) return
      onViewChange(previous => ({ ...previous, request, error: failure instanceof Error ? failure.message : String(failure) }))
      setPhase('error')
    }
    if (!monitor) {
      fail(new Error('桌面数据连接不可用 / Desktop data connection unavailable'))
      return
    }
    monitor.events(request.query).then(page => {
      if (generation.current !== token) return
      if (page.entries.length > EVENT_PAGE_SIZE || request.query.upper !== undefined && page.upper !== request.query.upper) {
        fail(new Error('事件页与请求不匹配，请重试 / Event page does not match the request; please retry'))
        return
      }
      onViewChange(previous => ({ ...previous, applied: request.filters, query: { ...request.query, upper: page.upper },
        page, history: request.history, pageNumber: request.pageNumber, request: null, error: null, readAt: new Date().toISOString() }))
      setPhase('ready')
    }, fail)
    return () => { generation.current += 1; monitor.cancelEvents() }
  }, [canRead, view.requestId, onViewChange])

  function requestPage(request: EventRequest) {
    if (!canRead) return
    generation.current += 1
    window.monitor?.cancelEvents()
    setPhase('loading')
    onViewChange(previous => ({ ...previous, request, requestId: previous.requestId + 1, error: null }))
  }

  function apply(filters: EventFilters, reason: 'apply' | 'clear' | 'latest') {
    requestPage({ query: filterQuery(filters), filters, history: [], pageNumber: 1, reason })
  }

  function previousPage() {
    if (!view.page || !view.history.length) return
    const history = view.history.slice(0, -1)
    const before = view.history[view.history.length - 1]
    const { before: _before, ...query } = view.query
    requestPage({ query: before === null ? query : { ...query, before }, filters: view.applied,
      history, pageNumber: view.pageNumber - 1, reason: 'previous' })
  }

  function nextPage() {
    if (!view.page || view.page.next === null) return
    requestPage({ query: { ...view.query, before: view.page.next }, filters: view.applied,
      history: [...view.history, view.query.before ?? null].slice(-MAX_CURSOR_HISTORY), pageNumber: view.pageNumber + 1, reason: 'next' })
  }

  function timestamp(value: string | null | undefined) {
    if (!value) return t('未记录', 'Not recorded')
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString(language) : t('时间未知', 'Time unknown')
  }

  function filterDescription(filters: EventFilters, query: EventQuery) {
    return `${filters.sourceId || t('全部来源', 'All sources')} · ${filters.type === 'all' ? t('全部类型', 'All types') : t(...typeLabels[filters.type])} · ${query.from && query.to ? `${timestamp(query.from)} – ${timestamp(query.to)}` : t('全部发现时间', 'All discovery times')}`
  }

  const page = view.page
  const latestSnapshot = snapshot.events.data
  const newer = !!page && !!latestSnapshot && latestSnapshot.retention.newestSequence > page.upper
  const removedSinceRead = !!page && !!latestSnapshot && latestSnapshot.retention.deletedCount > page.retention.deletedCount
  const draftChanged = view.draft.sourceId !== view.applied.sourceId || view.draft.type !== view.applied.type || view.draft.range !== view.applied.range
  const busy = canRead && phase === 'loading'
  const unavailable = !canRead || busy
  const coverage = page?.coverage ?? latestSnapshot?.coverage
  const retention = page?.retention ?? latestSnapshot?.retention
  const sourceOptions = useMemo(() => {
    const ids = new Set(['hermes-events', 'collection:agents', 'collection:schedules', 'collection:system'])
    for (const state of Object.values(snapshot)) for (const source of state.data?.sources ?? []) ids.add(source.id)
    for (const entry of page?.entries ?? []) ids.add(entry.sourceId)
    if (view.draft.sourceId) ids.add(view.draft.sourceId)
    if (view.applied.sourceId) ids.add(view.applied.sourceId)
    return [...ids].sort()
  }, [snapshot, page, view.draft.sourceId, view.applied.sourceId])
  const limitedCoverage = coverage?.filter(item => item.state !== 'observing' || item.lastGap).length ?? 0

  return <section className="events-view" aria-label={t('事件', 'Events')} aria-busy={busy}>
    <form className="event-filters" onSubmit={event => { event.preventDefault(); if (!unavailable) apply(view.draft, 'apply') }}>
      <div className="event-filter event-filter-source">
        <label htmlFor="event-source-filter">{t('来源 ID', 'Source ID')}</label>
        <input id="event-source-filter" list="event-source-options" maxLength={128} value={view.draft.sourceId}
          placeholder={t('全部来源；输入精确 ID', 'All sources; enter exact ID')} autoComplete="off" spellCheck={false}
          onChange={event => { const sourceId = event.target.value; onViewChange(previous => ({ ...previous, draft: { ...previous.draft, sourceId } })) }} />
        <datalist id="event-source-options">{sourceOptions.map(id => <option value={id} key={id} />)}</datalist>
      </div>
      <div className="event-filter">
        <label htmlFor="event-type-filter">{t('事件类型', 'Event type')}</label>
        <NativeSelect id="event-type-filter" value={view.draft.type} onChange={event => {
          const type = event.target.value as EventFilters['type']; onViewChange(previous => ({ ...previous, draft: { ...previous.draft, type } }))
        }}><option value="all">{t('全部类型', 'All types')}</option>{EVENT_TYPES.map(type => <option value={type} key={type}>{t(...typeLabels[type])}</option>)}</NativeSelect>
      </div>
      <div className="event-filter">
        <label htmlFor="event-range-filter">{t('发现时间', 'Discovered')}</label>
        <NativeSelect id="event-range-filter" value={view.draft.range} onChange={event => {
          const range = event.target.value as EventRange; onViewChange(previous => ({ ...previous, draft: { ...previous.draft, range } }))
        }}>{(Object.keys(rangeLabels) as EventRange[]).map(range => <option value={range} key={range}>{t(...rangeLabels[range])}</option>)}</NativeSelect>
      </div>
      <div className="event-filter-actions">
        <button type="submit" className="button primary" data-event-action="apply" aria-disabled={unavailable}>{t('应用筛选', 'Apply filters')}</button>
        <button type="button" className="text-button" data-event-action="clear" aria-disabled={unavailable} onClick={() => {
          if (unavailable) return
          const filters = defaultFilters()
          onViewChange(previous => ({ ...previous, draft: filters }))
          apply(filters, 'clear')
        }}>{t('清除筛选', 'Clear filters')}</button>
      </div>
    </form>
    <p className="event-filter-help">{t('按精确来源 ID 和发现时间筛选；点击应用后固定时间范围。发生时间可能更早，也可能未记录。', 'Filter by exact source ID and discovery time. Applying freezes the time range. Occurrence time may be earlier or unrecorded.')}
      {draftChanged && <strong> {t('草稿尚未应用。', 'Draft filters are not applied.')}</strong>}
    </p>

    <div className="event-feedback" role="status" aria-live="polite" aria-atomic="true">
      {!enabled && <p>{page ? t('本地事件已停用。已取消读取，保留上次成功页；重新启用后再读取。', 'Local events are disabled. Reads are cancelled; the last successful page is retained until enabled again.') : t('本地事件未启用，尚无读取数据。可在数据来源页开启本地事件。', 'Local events are disabled; no page has been read. Enable local events in Sources.')}</p>}
      {enabled && !canRead && <p>{page ? t('显示已暂停，保留当前页；后台事件采集仍可继续。', 'Display paused; the current page is retained. Background event collection can continue.') : t('显示已暂停，尚未读取事件。恢复显示后读取第一页。', 'Display paused; events have not been read. Resume to read the first page.')}</p>}
      {busy && <p>{page ? t('正在读取；下方仍为上次成功页。', 'Reading; the last successful page remains below.') : t('正在读取事件…', 'Reading events…')}</p>}
      {newer && <p>{t('有新记录。当前页保持不变；点击“查看最新”时更新。新记录可能不符合当前筛选。', 'New records are available. This page stays unchanged until you choose “View latest”; new records may not match these filters.')}</p>}
    </div>
    {view.error && <div className="event-error" role="alert">
      <p><strong>{t('事件读取失败。', 'Event read failed.')}</strong> {page ? t('下方保留上次成功页，失败请求没有替换列表或游标。', 'The last successful page remains below; the failed request did not replace the list or cursor.') : t('尚无成功读取结果，不能判定没有事件。', 'No successful result is available; this does not mean there are no events.')}</p>
      {view.request && <p>{['apply', 'clear'].includes(view.request.reason) ? t('新筛选未应用：', 'New filters were not applied: ') : t('未完成的请求：', 'Unfinished request: ')}{filterDescription(view.request.filters, view.request.query)} · {t(`第 ${view.request.pageNumber} 页`, `Page ${view.request.pageNumber}`)}</p>}
      <p>{view.error}</p>
      <button type="button" className="button secondary" data-event-action="retry" aria-disabled={unavailable} onClick={() => { if (!unavailable && view.request) requestPage(view.request) }}>{t('重试失败请求', 'Retry failed request')}</button>
    </div>}
    {snapshot.events.error && <p className="event-collection-error">{t('事件采集异常：', 'Event collection error: ')}{snapshot.events.error} {t('列表读取与后台采集分别报告；可在数据来源页查看并重试采集。', 'List reads and background collection are reported separately; inspect and retry collection in Sources.')}</p>}

    <div className="event-results-heading">
      <div>
        <h2>{t('本地事件记录', 'Local event records')}</h2>
        <p className="event-counts">{page ? t(`本页 ${page.entries.length} 条 · 第 ${view.pageNumber} 页 · 全库保留 ${page.retention.count.toLocaleString(language)} 条（读取时）`, `${page.entries.length} on this page · Page ${view.pageNumber} · ${page.retention.count.toLocaleString(language)} retained in the database at read time`) : t('本页尚未读取 · 全库数量见保留信息', 'Page not yet read · Database count is in retention details')}</p>
      </div>
      <div className="event-list-actions">
        <button type="button" className="button secondary" data-event-action="refresh" aria-disabled={unavailable} onClick={() => {
          if (!unavailable) requestPage({ query: view.query, filters: view.applied, history: view.history, pageNumber: view.pageNumber, reason: 'refresh' })
        }}><Sync trigger="none" size={14} aria-hidden="true" />{t('刷新本页', 'Refresh page')}</button>
        <button type="button" className="button secondary" data-event-action="latest" aria-disabled={unavailable} onClick={() => { if (!unavailable) apply(view.applied, 'latest') }}>{t('查看最新', 'View latest')}</button>
      </div>
    </div>
    {page && <p className="event-applied">{t('当前列表条件：', 'Current list filters: ')}{filterDescription(view.applied, view.query)}<br />{t('读取于', 'Read at')} {timestamp(view.readAt)}{!canRead || phase !== 'ready' ? t(' · 保留数据', ' · Retained data') : ''}</p>}
    {removedSinceRead && <p className="event-retention-warning">{t('读取后已有记录被保留策略清理。当前页是读取时的数据；刷新本页会重新核对，可能出现空页。', 'Retention has removed records since this page was read. This page reflects that earlier read; refreshing rechecks it and may return an empty page.')}</p>}
    {page && !page.entries.length && <div className="event-empty">
      <h3>{page.retention.count === 0 ? t('尚无保留事件', 'No retained events') : view.query.before !== undefined ? t('这一页已没有记录', 'No records remain on this page') : t('没有匹配的事件', 'No matching events')}</h3>
      <p>{page.retention.count === 0 ? t('当前本地库中没有保留记录；这不代表过去没有异常。首次观察建立基线，停用与覆盖断档期间可能没有记录。', 'The local database has no retained records; this does not prove there were no past failures. Initial observation establishes a baseline, and disabled collection or coverage gaps can leave records missing.') : view.query.before !== undefined ? t('记录可能已被保留策略清理。可返回上一页或查看最新，当前筛选仍保留。', 'Retention may have removed these records. Return to the previous page or view latest; the applied filters are retained.') : t('全库仍有记录，但不符合当前来源、类型或发现时间。可修改筛选后应用，或清除筛选。', 'The database contains records outside these source, type, or discovery-time filters. Apply different filters or clear them.')}</p>
    </div>}
    {page && page.entries.length > 0 && <ol className="event-list" aria-label={t('当前页事件', 'Events on this page')}>
      {page.entries.map(entry => <li key={entry.id} data-event-id={entry.id}>
        <div className="event-row-heading"><h3 data-event-type={entry.type}>{t(...typeLabels[entry.type])}</h3><span className="event-id">{t('事件 ID', 'Event ID')}: {entry.id}</span></div>
        <EventIdentity entry={entry} snapshot={snapshot} onNavigate={onNavigate} />
        <dl className="event-metadata">
          <div><dt>{t('来源 ID', 'Source ID')}</dt><dd className="event-id">{entry.sourceId}</dd></div>
          <div><dt>{t('结果代码', 'Result code')}</dt><dd className="event-id">{entry.resultCode || t('未记录', 'Not recorded')}</dd></div>
          <div><dt>{t('发生时间', 'Occurred')}</dt><dd>{timestamp(entry.occurredAt)}</dd></div>
          <div><dt>{t('发现时间', 'Discovered')}</dt><dd>{timestamp(entry.observedAt)}</dd></div>
        </dl>
      </li>)}
    </ol>}
    <nav className="event-pagination" aria-label={t('事件分页', 'Event pages')}>
      <button type="button" className="button secondary" data-event-action="previous" aria-disabled={unavailable || !view.history.length} onClick={() => { if (!unavailable) previousPage() }}><ChevronLeft trigger="none" size={15} aria-hidden="true" />{t('上一页', 'Previous')}</button>
      <span>{t(`每页最多 ${EVENT_PAGE_SIZE} 条`, `Up to ${EVENT_PAGE_SIZE} per page`)}</span>
      <button type="button" className="button secondary" data-event-action="next" aria-disabled={unavailable || !page || page.next === null} onClick={() => { if (!unavailable) nextPage() }}>{t('下一页', 'Next')}<ChevronRight trigger="none" size={15} aria-hidden="true" /></button>
    </nav>
    {view.pageNumber > view.history.length + 1 && <p className="event-history-limit">{t(`只保留最近 ${MAX_CURSOR_HISTORY} 个返回游标；更早的页面请用“查看最新”重新进入。`, `Only the last ${MAX_CURSOR_HISTORY} return cursors are retained; use “View latest” to revisit earlier pages.`)}</p>}

    <details className="event-coverage" open={view.coverageOpen} onToggle={event => {
      const coverageOpen = event.currentTarget.open
      onViewChange(previous => previous.coverageOpen === coverageOpen ? previous : { ...previous, coverageOpen })
    }}>
      <summary>{t('保留与采集覆盖', 'Retention and collection coverage')} · {retention ? t(`保留 ${retention.count.toLocaleString(language)} 条`, `${retention.count.toLocaleString(language)} retained`) : t('尚无数据', 'No data yet')}{limitedCoverage > 0 && t(` · ${limitedCoverage} 个来源存在覆盖限制或历史断档`, ` · ${limitedCoverage} sources have coverage limits or a previous gap`)}</summary>
      <div className="event-coverage-body">
        <p>{t(`最多保留 7 天、${EVENT_MAX_RECORDS.toLocaleString(language)} 条，磁盘上限 20 MiB。按发现时间保留；不会补造缺失记录。`, `Retained for up to 7 days or ${EVENT_MAX_RECORDS.toLocaleString(language)} records, with a 20 MiB disk limit. Retention uses discovery time; missing records are not reconstructed.`)}</p>
        {retention ? <dl className="event-retention-metadata">
          <div><dt>{t('全库保留数量', 'Database retained count')}</dt><dd>{retention.count.toLocaleString(language)}{page ? t('（本页读取时）', ' (at page read)') : ''}</dd></div>
          <div><dt>{t('最早保留的发现时间', 'Oldest retained discovery')}</dt><dd>{timestamp(retention.oldestObservedAt)}</dd></div>
          <div><dt>{t('累计删除', 'Total deleted')}</dt><dd>{retention.deletedCount.toLocaleString(language)}</dd></div>
          <div><dt>{t('删除截至发现时间', 'Deleted through discovery time')}</dt><dd>{timestamp(retention.deletedThrough)}</dd></div>
          <div><dt>{t('最近清理原因', 'Last cleanup reason')}</dt><dd>{retention.reason === 'age' ? t('超过 7 天', 'Older than 7 days') : retention.reason === 'count' ? t('超过数量上限', 'Record limit exceeded') : retention.reason === 'bytes' ? t('超过磁盘上限', 'Disk limit exceeded') : t('尚无清理记录', 'No cleanup recorded')}</dd></div>
          <div><dt>{t('磁盘占用', 'Disk usage')}</dt><dd>{(retention.diskBytes / 1024 / 1024).toLocaleString(language, { maximumFractionDigits: 2 })} MiB</dd></div>
        </dl> : <p>{t('尚无保留策略的成功数据，数量未知。', 'Retention data is not yet available; the count is unknown.')}</p>}
        <h3>{t('来源覆盖', 'Source coverage')}</h3>
        <p>{t('只记录已观察到的执行失败、投递失败、来源不可用与来源恢复。基线、补读、停用、不可用与断档均不等于完整覆盖。', 'Records observed execution failures, delivery failures, source unavailability, and recovery only. Baselines, catch-up, disabled or unavailable sources, and gaps do not provide complete coverage.')}{page && t(' 下列覆盖信息来自本页读取时。', ' Coverage below is from this page’s read.')}</p>
        {coverage?.length ? <ul className="event-coverage-list">{coverage.map(item => <li key={item.sourceId}>
          <div className="event-coverage-heading"><strong className="event-id">{item.sourceId}</strong><span data-coverage-state={item.state}>{t(...coverageLabels[item.state])}</span></div>
          <dl className="event-metadata">
            <div><dt>{t('覆盖起点', 'Coverage since')}</dt><dd>{timestamp(item.since)}</dd></div>
            <div><dt>{t('最近观察', 'Last observed')}</dt><dd>{timestamp(item.observedAt)}</dd></div>
            <div><dt>{t('覆盖代码', 'Coverage code')}</dt><dd className="event-id">{item.code ?? t('未记录', 'Not recorded')}</dd></div>
          </dl>
          {item.lastGap && <p className="event-gap">{t('最近断档：', 'Last gap: ')}{timestamp(item.lastGap.from)} – {timestamp(item.lastGap.to)} · {t('代码', 'Code')}: <span className="event-id">{item.lastGap.code}</span> · {t('记录的断档次数', 'Recorded gap occurrences')}: {item.lastGap.count.toLocaleString(language)}</p>}
        </li>)}</ul> : <p>{t('尚无来源覆盖记录；不能据此认定没有异常。', 'No source coverage has been recorded; this does not establish an absence of failures.')}</p>}
      </div>
    </details>
  </section>
}
