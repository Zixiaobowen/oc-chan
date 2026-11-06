import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowRight, Bot, CornerDownRight, Search, X } from 'lucide-react'
import type { AgentInfo, AgentSnapshot } from '../../shared/types'
import { AGENT_DISCOVERY_INTERVAL_MS } from '../../shared/types'
import { AgentActivity, Badge, bytes, CollectionStatus, Empty, NativeSelect, Sources, time, useRecentAgents } from './components'
import AgentTopology from './AgentTopology'
import { orderAgentTopology, pageAgentTopology, projectAgentTopology, type AgentActivityFilter, type AgentKindFilter } from './agent-topology'
import { useI18n } from './i18n'
import { agentTarget, type NavigationIntent, type NavigationTarget } from '../../shared/navigation'
import { MAX_SAVED_TOPOLOGY_NODES, MAX_VIEW_QUERY_LENGTH, type AgentViewState, type TopologyMemory } from './view-state'
import './detail-source-reasons.css'

const EMPTY_AGENTS: AgentInfo[] = []

export function AgentTable({ agents, onSelect, pausedAt }: { agents: AgentInfo[]; onSelect: (agent: AgentInfo) => void; pausedAt: number | null }) {
  const { t } = useI18n()
  const recentAgents = useRecentAgents(agents, pausedAt)
  return <div className="table-scroll"><table className="data-table agent-table">
    <thead><tr><th>{t('Agent / 项目', 'Agent / Project')}</th><th>{t('运行时', 'Runtime')}</th><th>{t('状态 / 近期调用', 'Status / Recent calls')}</th><th>PID</th><th className="numeric">CPU</th><th className="numeric">{t('内存', 'Memory')}</th></tr></thead>
    <tbody>{recentAgents.map(agent => <tr key={agent.id}>
      <td><button className="entity-button" onClick={() => onSelect(agent)}>{agent.kind === 'subagent' ? <CornerDownRight size={17} /> : <span className="agent-avatar"><Bot size={17} /></span>}<span className="entity-text"><strong title={agent.summary || agent.name}>{agent.summary || agent.name}</strong><small title={agent.cwd}>{agent.kind === 'subagent' ? t('子代理', 'Subagent') : agent.cwd || t('工作目录不可见', 'Working directory unavailable')}</small></span></button></td>
      <td><span className="runtime-label">{agent.runtime}</span></td>
      <td><div className="agent-state-cell"><Badge state={agent.state} /><AgentActivity agent={agent} /></div></td>
      <td className="mono muted">{agent.pid}</td>
      <td className="numeric mono">{agent.cpuPercent !== undefined ? `${agent.cpuPercent.toFixed(1)}%` : '—'}</td>
      <td className="numeric mono">{bytes(agent.memoryBytes)}</td>
    </tr>)}</tbody>
  </table></div>
}

function AgentStateReason({ agent, onSource }: { agent: AgentInfo; onSource: (target: Extract<NavigationTarget, { kind: 'source' }>) => void }) {
  const { t } = useI18n()
  let sourceId: string
  let explanation: string
  let label: string
  if (agent.runtime === 'OMP' && agent.kind === 'subagent' && agent.state === 'unknown') {
    sourceId = 'omp-ownership'
    explanation = t('会话归属能确认子代理存在，但保留的会话不能证明它仍在工作，因此活动状态未知。', 'Session ownership confirms this subagent exists, but a retained session does not confirm ongoing work. Its activity state is unknown.')
    label = t('查看 OMP 子代理状态限制', 'View OMP subagent status limits')
  } else if (agent.runtime === 'Codex' && agent.state === 'unknown' && agent.sessionId) {
    sourceId = 'codex-sessions'
    explanation = t('Codex 仍持有此会话，但会话驻留不能确认它正在工作、已完成还是空闲。', 'Codex still holds this session, but residency does not establish whether it is working, completed or idle.')
    label = t('查看 Codex 会话状态限制', 'View Codex session status limits')
  } else if (agent.state === 'running') {
    sourceId = 'processes'
    explanation = t('目前只确认 CLI 进程存活，无法据此判断正在工作还是空闲。', 'Only CLI process liveness is confirmed. It does not establish whether the agent is working or idle.')
    label = t('查看 CLI 进程证据', 'View CLI process evidence')
  } else if (agent.runtime === 'OMP' && agent.kind === 'main' && (agent.state === 'working' || agent.state === 'idle') && agent.source === 'Tern pane working state + OMP ownership/session descriptors') {
    sourceId = 'tern-state'
    explanation = t('忙闲状态来自按会话精确关联的 Tern 标签页工作状态。该证据仅覆盖此主代理。', 'Working or idle status comes from the Tern pane matched to this exact session. This evidence covers this main agent only.')
    label = t('查看 Tern 主代理状态证据', 'View Tern main-agent status evidence')
  } else if (agent.state === 'unknown') {
    return <div className="span-2"><dt>{t('状态说明', 'Status details')}</dt><dd>{t('当前证据不足以确认活动状态，且未识别到可定位的状态来源。', 'Current evidence does not confirm activity, and no specific status source has been identified.')}</dd></div>
  } else return null
  return <div className="span-2"><dt>{t('状态说明', 'Status details')}</dt><dd className="detail-source-reason"><p>{explanation}</p><button type="button" className="text-button detail-source-button" onClick={() => onSource({ kind: 'source', section: 'agents', id: sourceId })}>{label}</button></dd></div>
}

export default memo(function AgentsView({ data, enabled, error, pausedAt, intent, onConsumed, view, onViewChange, memory, onSource }: {
  data: AgentSnapshot | null; enabled: boolean; error: string | null; pausedAt: number | null; intent: NavigationIntent | null
  onConsumed: (sequence: number) => void; view: AgentViewState; onViewChange: Dispatch<SetStateAction<AgentViewState>>; memory: TopologyMemory
  onSource: (target: Extract<NavigationTarget, { kind: 'source' }>) => void
}) {
  const { language, t } = useI18n()
  const paused = pausedAt !== null
  const { query, kind, activity, collapsedIds, selectedId, identity, unavailable, open } = view
  const detailRef = useRef<HTMLElement>(null)
  const revealPending = useRef(false)
  const [collapseLimit, setCollapseLimit] = useState(false)
  const patchView = useCallback((patch: Partial<AgentViewState>) => onViewChange(current => ({ ...current, ...patch })), [onViewChange])
  const setQuery = (query: string) => patchView({ query, topologyPage: null })
  const setKind = (kind: AgentKindFilter) => patchView({ kind, topologyPage: null })
  const setActivity = (activity: AgentActivityFilter) => patchView({ activity, topologyPage: null })
  const consumed = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusReturn = useRef<{ id: string; from: Element | null } | null>(null)
  const restoreNodeFocus = useCallback(() => {
    const pending = focusReturn.current
    if (!pending) return
    if (document.activeElement !== document.body && document.activeElement !== pending.from) {
      focusReturn.current = null
      return
    }
    const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(pending.id)}"]`)
    if (node && getComputedStyle(node).visibility === 'hidden') return
    focusReturn.current = null
    ;(node ?? searchRef.current)?.focus({ preventScroll: true })
  }, [])
  const agents = useRecentAgents(data?.agents ?? EMPTY_AGENTS, pausedAt)
  const graph = useMemo(() => projectAgentTopology(agents, kind, activity, query, collapsedIds), [agents, kind, activity, query, collapsedIds])
  const pageOrder = useMemo(() => orderAgentTopology(graph), [graph.layoutKey])
  const topologyPage = useMemo(() => pageAgentTopology(graph, pageOrder, view.topologyPage), [graph, pageOrder, view.topologyPage])
  const filterKey = JSON.stringify([kind, activity, query.trim().toLowerCase()])
  const filtering = kind !== 'all' || activity !== 'all' || Boolean(query.trim())
  const candidate = agents.find(agent => agent.id === selectedId)
  const selected = !unavailable && candidate && agentTarget(candidate).identity === identity ? candidate : undefined
  const selectedIncluded = Boolean(selected && pageOrder.pageById.has(selected.id))
  const selectedVisible = Boolean(selected && topologyPage.graph.nodes.some(node => node.agent.id === selectedId))
  const parent = selected?.parentId ? agents.find(agent => agent.id === selected.parentId) : undefined

  const toggleCollapse = useCallback((id: string) => {
    if (!collapsedIds.has(id) && (id.length > 512 || collapsedIds.size >= MAX_SAVED_TOPOLOGY_NODES)) {
      setCollapseLimit(true)
      return
    }
    setCollapseLimit(false)
    onViewChange(current => {
      const next = new Set(current.collapsedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...current, collapsedIds: next }
    })
  }, [collapsedIds, onViewChange])
  const select = useCallback((id: string) => {
    const agent = agents.find(item => item.id === id)
    if (!agent) return
    focusReturn.current = null
    revealPending.current = true
    patchView({ selectedId: id, identity: agentTarget(agent).identity, unavailable: false, open: true, topologyPage: pageOrder.pageById.get(id) ?? null })
  }, [agents, pageOrder, patchView])
  const close = useCallback(() => {
    focusReturn.current = selectedVisible && selectedId ? { id: selectedId, from: document.activeElement } : null
    patchView({ selectedId: null, identity: null, unavailable: false, open: false })
    if (!focusReturn.current) searchRef.current?.focus({ preventScroll: true })
  }, [patchView, selectedVisible, selectedId])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])
  useLayoutEffect(() => {
    if (!intent || intent.target.kind !== 'agent' || consumed.current === intent.sequence) return
    focusReturn.current = null
    consumed.current = intent.sequence
    if (!open || selectedId !== intent.target.id || identity !== intent.target.identity) {
      revealPending.current = true
      patchView({ selectedId: intent.target.id, identity: intent.target.identity, unavailable: false, open: true, topologyPage: pageOrder.pageById.get(intent.target.id) ?? null })
    }
    onConsumed(intent.sequence)
  }, [intent, identity, selectedId, open, pageOrder, patchView, onConsumed])
  useLayoutEffect(() => {
    if (!open || !revealPending.current) return
    revealPending.current = false
    detailRef.current?.scrollIntoView({ block: 'start' })
    detailRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [view, open])
  function locateSelected() {
    if (!selected) return
    if (selectedIncluded) patchView({ topologyPage: pageOrder.pageById.get(selected.id)! })
    else {
      const unfiltered = projectAgentTopology(agents, 'all', 'all', '', new Set())
      patchView({ query: '', kind: 'all', activity: 'all', collapsedIds: new Set(), topologyPage: orderAgentTopology(unfiltered).pageById.get(selected.id) ?? null })
    }
    detailRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }
  return <>
    <div className="toolbar">
      <div className="agent-filters">
        <div className="segmented" role="group" aria-label={t('Agent 类型', 'Agent type')}>
          {([['all', t('全部', 'All')], ['main', t('主 Agent', 'Main agents')], ['subagent', t('子代理', 'Subagents')]] as const).map(([value, label]) =>
            <button key={value} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <label className="agent-activity-filter">{t('活跃状态', 'Activity')}
          <NativeSelect value={activity} aria-describedby="agent-activity-filter-help" onChange={event => setActivity(event.target.value as AgentActivityFilter)}>
            <option value="all">{t('全部', 'All')}</option>
            <option value="active">{t('活跃', 'Active')}</option>
            <option value="inactive">{t('不活跃', 'Inactive')}</option>
          </NativeSelect>
        </label>
      </div>
      <label className="search-field agent-search"><Search size={16} /><input ref={searchRef} aria-label={t('搜索 Agent', 'Search agents')} maxLength={MAX_VIEW_QUERY_LENGTH} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索工作内容、名称、项目或 PID', 'Search work, name, project or PID')} /></label>
    </div>
    <section className="panel topology-panel" aria-label={t('协作拓扑', 'Agent topology')}>
      <div className="list-caption topology-caption">
        <span>{data ? <><strong>{filtering ? t(`${graph.matchCount} 个匹配`, `${graph.matchCount} matches`) : t(`${data.agents.length} 个 Agent`, `${data.agents.length} agents`)}</strong> · {t(`${graph.edges.length} 条父子关系`, `${graph.edges.length} parent-child relationships`)}{graph.contextCount > 0 && t(` · ${graph.contextCount} 个关联节点`, ` · ${graph.contextCount} related nodes`)}{graph.hiddenCount > 0 && t(` · 已收起 ${graph.hiddenCount} 个节点`, ` · ${graph.hiddenCount} collapsed nodes`)}</> : !enabled ? t('采集已停用 · 数量未知', 'Collection disabled · Count unknown') : error ? t('采集失败 · 数量未知', 'Collection failed · Count unknown') : t('正在读取 · 数量待确认', 'Loading · Count pending')}</span>
        <span title={enabled ? t(`会话活动按事件推送；进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对。最近进程采样 ${time(data?.collectedAt, language)}。没有新事件不代表断开。`, `Session activity is pushed as events; processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000} seconds. Last process sample: ${time(data?.collectedAt, language)}. No new events does not mean disconnected.`) : undefined}>{!enabled ? t('采集已停用 · 旧快照', 'Collection disabled · Retained snapshot') : paused ? t('显示已暂停', 'Display paused') : error ? t('更新失败', 'Update failed') : t('会话事件订阅 · 持续更新', 'Session events · Live updates')}</span>
      </div>
      {topologyPage.count > 1 && <nav className="topology-pagination" aria-label={t('拓扑分页', 'Topology pages')}>
        <div className="topology-page-summary" role="status" aria-live="polite" aria-atomic="true">
          <span>{t(`本页 ${topologyPage.graph.nodes.length} / ${topologyPage.totalNodes} 个展开节点 · 匹配 ${topologyPage.shownMatches} / ${graph.matchCount}`, `This page: ${topologyPage.graph.nodes.length} / ${topologyPage.totalNodes} expanded nodes · ${topologyPage.shownMatches} / ${graph.matchCount} matches`)}</span>
          {topologyPage.boundaryEdges > 0 && <small>{t(`${topologyPage.boundaryEdges} 条父子关系跨页；节点提供父节点定位，后续分支可翻页查看。`, `${topologyPage.boundaryEdges} relationships cross pages. Locate parents from their nodes; browse later pages for more branches.`)}</small>}
        </div>
        <div className="topology-page-actions">
          <button type="button" className="button secondary" aria-disabled={topologyPage.index === 0} onClick={() => { if (topologyPage.index > 0) patchView({ topologyPage: topologyPage.index - 1 }) }}>{t('上一页', 'Previous')}</button>
          <span>{t(`第 ${topologyPage.index + 1} / ${topologyPage.count} 页`, `Page ${topologyPage.index + 1} / ${topologyPage.count}`)}</span>
          <button type="button" className="button secondary" aria-disabled={topologyPage.index + 1 === topologyPage.count} onClick={() => { if (topologyPage.index + 1 < topologyPage.count) patchView({ topologyPage: topologyPage.index + 1 }) }}>{t('下一页', 'Next')}</button>
        </div>
      </nav>}
      <div className={`agent-topology-workspace${open ? ' has-detail' : ''}`}>
        {!data ? <div className="topology-empty"><Empty title={!enabled ? t('Agent 采集已停用', 'Agent collection disabled') : error ? t('尚未取得 Agent 数据', 'Agent data unavailable') : t('正在连接本机 Agent', 'Connecting to local agents')}>{!enabled ? t('尚无快照。可在数据来源中开启采集，不会影响 Agent 的运行。', 'No snapshot yet. Enable collection in Data sources; running agents are unaffected.') : error ? t('请查看上方错误信息并重试。', 'Review the error above and retry.') : t('读取活动进程与父子关系。', 'Reading active processes and parent-child relationships.')}</Empty></div>
          : <div className="topology-stage">
            <AgentTopology graph={topologyPage.graph} pageIndex={topologyPage.index} selectedId={selected ? selectedId : null} onSelect={select} onToggleCollapse={toggleCollapse} filterKey={filterKey} memory={memory} onNodesReady={restoreNodeFocus} />
            {!graph.nodes.length && <div className="topology-empty topology-empty-overlay"><Empty title={filtering ? t('没有匹配的 Agent', 'No matching agents') : !enabled ? t('旧快照中没有 Agent', 'No agents in the retained snapshot') : t('当前未发现运行中的 Agent', 'No running agents found')}>{filtering ? t('调整类型、活跃状态或搜索词。活跃筛选保留命中节点的父链与子树。', 'Adjust type, activity or search. Active filters preserve ancestors and descendants of matching nodes.') : !enabled ? t('在数据来源中重新开启采集以获取新状态。', 'Enable collection in Data sources for a fresh sample.') : t('启动 Agent 后等待下次采样；覆盖范围见数据来源。', 'Start an agent and wait for the next sample. See Data sources for coverage.')}</Empty>{filtering && <button className="button secondary" onClick={() => { setQuery(''); setKind('all'); setActivity('all') }}>{t('清除筛选', 'Clear filters')}</button>}</div>}
          </div>}
        {open && <section ref={detailRef} tabIndex={-1} data-agent-id={selectedId ?? undefined} aria-label={t('Agent 详情', 'Agent details')} className="agent-inspector">
          <div className="section-heading"><h2>{selected?.name ?? t('Agent 已离开当前采样', 'Agent no longer in the current sample')}</h2><button className="icon-button" onClick={close} aria-label={t('关闭 Agent 详情', 'Close agent details')} title={t('关闭 Agent 详情 (Esc)', 'Close agent details (Esc)')} aria-keyshortcuts="Escape"><X size={18} aria-hidden="true" /></button></div>
          <CollectionStatus enabled={enabled} collectedAt={data?.collectedAt} />
          {selected && !selectedVisible && <p className="footnote">{selectedIncluded ? t('该 Agent 位于其它分页。', 'This agent is on another page.') : t('该 Agent 不在当前筛选结果或展开分支中。', 'This agent is outside the current filters or expanded branches.')} <button className="text-button" onClick={locateSelected}>{selectedIncluded ? t('定位到该页', 'Locate on its page') : t('清除筛选并定位', 'Clear filters and locate')}</button></p>}
          {selected ? <dl className="detail-grid">
            <div className="span-2"><dt>{t('工作摘要', 'Work summary')}</dt><dd>{selected.summary || t('未提供会话标题', 'No session title provided')}</dd></div>
            <div><dt>{t('角色', 'Role')}</dt><dd>{selected.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')}</dd></div>
            <div><dt>{t('运行状态', 'Status')}</dt><dd><Badge state={selected.state} /></dd></div>
            <AgentStateReason agent={selected} onSource={onSource} />
            <div className="span-2"><dt>{t('近期调用', 'Recent calls')}</dt><dd>{selected.activity ? <><AgentActivity agent={selected} /><small className="agent-activity-explanation">{t(`观察于 ${time(selected.activity.observedAt, language)}；仅表示近 6 秒收到事件，不代表仍在执行。`, `Observed at ${time(selected.activity.observedAt, language)}; an event arrived within the last 6 seconds, which does not indicate ongoing execution.`)}</small></> : t('近 6 秒未观察到调用事件', 'No call events observed in the last 6 seconds')}</dd></div>
            <div><dt>{t('进程', 'Process')}</dt><dd className="mono">{selected.pid}</dd></div>
            <div><dt>{t('运行时', 'Runtime')}</dt><dd>{selected.runtime}</dd></div>
            <div><dt>CPU</dt><dd className="mono">{selected.cpuPercent === undefined ? '—' : `${selected.cpuPercent.toFixed(1)}%`}</dd></div>
            <div><dt>{t('内存', 'Memory')}</dt><dd className="mono">{bytes(selected.memoryBytes)}</dd></div>
            <div className="span-2"><dt>{t('父 Agent', 'Parent agent')}</dt><dd>{parent ? `${parent.name} · PID ${parent.pid}` : selected.parentId ? t(`${selected.parentId}（当前采样不可见）`, `${selected.parentId} (not in the current sample)`) : selected.kind === 'subagent' ? t('来源未提供父 Agent', 'Source did not provide a parent agent') : t('无已确认的父 Agent', 'No confirmed parent agent')}</dd></div>
            <div className="span-2"><dt>{t('模型', 'Model')}</dt><dd>{selected.model || t('来源未提供', 'Not provided by source')}</dd></div>
            <div className="span-2"><dt>{t('工作目录', 'Working directory')}</dt><dd className="mono">{selected.cwd || t('来源未提供', 'Not provided by source')}</dd></div>
            <div className="span-2"><dt>{t('来源', 'Source')}</dt><dd>{selected.source}</dd></div>
          </dl> : <p className="muted">{t('当前采样中该 Agent 已不存在或身份已变化。详情保持打开，可查看最新画布及采集状态。', 'This agent is missing from the current sample or its identity has changed. Details remain open while you review the latest canvas and collection status.')}</p>}
        </section>}
      </div>
      <div className="topology-footer"><span>{t('父 Agent', 'Parent agent')} <ArrowRight size={14} /> {t('子代理', 'Subagent')}</span><span>{graph.issueCount > 0 ? t(`${graph.issueCount} 个节点的关系待确认，见节点提示。`, `Relationships for ${graph.issueCount} nodes need confirmation. See node hints.`) : filtering ? t('关联节点用于保留父子关系；筛选期间展开分支。', 'Related nodes preserve parent-child relationships; branches stay expanded while filtering.') : t('拖动节点整理位置，点击查看详情。', 'Drag nodes to arrange them. Click to view details.')}</span><span className="topology-motion-legend">{t('同一工作目录的节点同色；状态看图标与文字。', 'Nodes sharing a working directory share a color; icons and text show status. ')}<i className="topology-legend-stream" aria-hidden="true" />{t('流动只表示父 → 子方向；', 'Flow indicates parent → child direction only; ')}<i className="topology-legend-stream is-active" aria-hidden="true" />{t('加粗表示子节点工作中或近 6 秒收到调用事件，不代表调用仍在执行。', 'thicker flow indicates a working child or a call event within the last 6 seconds, not an ongoing call.')}</span></div>
    </section>
    {collapseLimit && <p className="footnote" role="status">{t('本次会话最多保留 4096 个分支的折叠状态；超长标识不保存。请先展开部分分支。', 'This session saves collapse state for up to 4096 branches; oversized identifiers are not saved. Expand some branches first.')}</p>}
    {data && <Sources sources={data.sources} compact enabled={enabled} />}
    <p id="agent-activity-filter-help" className="footnote">{t('活跃：工作中或近 6 秒收到调用事件，不代表调用仍在执行。活跃筛选同时显示命中节点的子代理；非活跃子代理标为关联上下文，不计入匹配数。不活跃：明确空闲且没有近期调用。仅进程存活或状态未知的 Agent 不归入不活跃，可在“全部”中查看。同进程子代理不重复分摊 CPU 与内存。', 'Active: working or a call event observed within 6 seconds, without implying that the call is still executing. Active filters also show descendants of matching agents; descendants without activity are related context and excluded from the match count. Inactive: explicitly idle with no recent calls. Agents with only process liveness or unknown state are not classified as inactive; view them under All. Subagents sharing a process do not duplicate CPU or memory usage.')}</p>
  </>
})
