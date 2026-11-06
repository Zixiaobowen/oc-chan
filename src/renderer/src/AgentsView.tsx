import { memo, useCallback, useMemo, useState } from 'react'
import { ArrowRight, Bot, CornerDownRight, Search, X } from 'lucide-react'
import type { AgentInfo, AgentSnapshot } from '../../shared/types'
import { AGENT_DISCOVERY_INTERVAL_MS } from '../../shared/types'
import { AgentActivity, Badge, bytes, Empty, NativeSelect, Sources, time, useDetails, useRecentAgents } from './components'
import AgentTopology from './AgentTopology'
import AgentTopology3D from './AgentTopology3D'
import type { Topology3DSession } from './agent-topology-scene'
import { projectAgentTopology, type AgentActivityFilter, type AgentKindFilter } from './agent-topology'
import { useI18n } from './i18n'

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

export default memo(function AgentsView({ data, error, pausedAt }: { data: AgentSnapshot | null; error: string | null; pausedAt: number | null }) {
  const { language, t } = useI18n()
  const paused = pausedAt !== null
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AgentKindFilter>('all')
  const [activity, setActivity] = useState<AgentActivityFilter>('all')
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<'2d' | '3d'>('3d')
  const [spatialSession] = useState<Topology3DSession>(() => ({ positions: new Map(), floorByAgent: new Map(), floorId: null }))
  const { selectedId, detailRef, select, close } = useDetails()
  const agents = useRecentAgents(data?.agents ?? EMPTY_AGENTS, pausedAt)
  const liveIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents])
  const graph = useMemo(() => projectAgentTopology(agents, kind, activity, query, collapsedIds), [agents, kind, activity, query, collapsedIds])
  const filterKey = JSON.stringify([kind, activity, query.trim().toLowerCase()])
  const filtering = kind !== 'all' || activity !== 'all' || Boolean(query.trim())
  const selected = agents.find(agent => agent.id === selectedId)
  const parent = selected?.parentId ? agents.find(agent => agent.id === selected.parentId) : undefined

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
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
      <label className="search-field agent-search"><Search size={16} /><input aria-label={t('搜索 Agent', 'Search agents')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索工作内容、名称、项目或 PID', 'Search work, name, project or PID')} /></label>
    </div>
    <section className="panel topology-panel" aria-label={t('Agent 关系拓扑', 'Agent relationship topology')}>
      <div className="list-caption topology-caption">
        <span>{data ? <><strong>{filtering ? t(`${graph.matchCount} 个匹配`, `${graph.matchCount} matches`) : t(`${data.agents.length} 个 Agent`, `${data.agents.length} agents`)}</strong> · {t(`${graph.edges.length} 条父子关系`, `${graph.edges.length} parent-child relationships`)}{graph.contextCount > 0 && t(` · ${graph.contextCount} 个关联节点`, ` · ${graph.contextCount} related nodes`)}{graph.hiddenCount > 0 && t(` · 已收起 ${graph.hiddenCount} 个节点`, ` · ${graph.hiddenCount} collapsed nodes`)}</> : error ? t('采集失败 · 数量未知', 'Collection failed · Count unknown') : t('正在读取 · 数量待确认', 'Loading · Count pending')}</span>
        <span title={t(`会话活动按事件推送；进程、资源与归属每 ${AGENT_DISCOVERY_INTERVAL_MS / 1000} 秒核对。最近进程采样 ${time(data?.collectedAt, language)}。没有新事件不代表断开。`, `Session activity is pushed as events; processes, resources and ownership are checked every ${AGENT_DISCOVERY_INTERVAL_MS / 1000} seconds. Last process sample: ${time(data?.collectedAt, language)}. No new events does not mean disconnected.`)}>{paused ? t('显示已暂停', 'Display paused') : error ? t('更新失败', 'Update failed') : t('会话事件订阅 · 持续更新', 'Session events · Live updates')}</span>
      </div>
      <div className="list-caption topology-mode">
        <span>{t('协作拓扑', 'Collaboration topology')}</span>
        <div className="segmented" role="group" aria-label={t('拓扑视图', 'Topology view')}>
          <button type="button" aria-pressed={view === '3d'} className={view === '3d' ? 'active' : ''} onClick={() => setView('3d')}>3D</button>
          <button type="button" aria-pressed={view === '2d'} className={view === '2d' ? 'active' : ''} onClick={() => setView('2d')}>2D</button>
        </div>
      </div>
      <div className={`agent-topology-workspace${selectedId ? ' has-detail' : ''}`}>
        {!data ? <div className="topology-empty"><Empty title={error ? t('尚未取得 Agent 数据', 'Agent data unavailable') : t('正在连接本机 Agent', 'Connecting to local agents')}>{error ? t('请查看上方错误信息并重试。', 'Review the error above and retry.') : t('读取活动进程与父子关系。', 'Reading active processes and parent-child relationships.')}</Empty></div>
          : <div className="topology-stage">
            {view === '3d'
              ? <AgentTopology3D graph={graph} selectedId={selectedId} onSelect={select} onToggleCollapse={toggleCollapse} filtering={filtering} evidenceCurrent={!error} liveIds={liveIds} session={spatialSession} />
              : <AgentTopology graph={graph} selectedId={selectedId} onSelect={select} onToggleCollapse={toggleCollapse} filterKey={filterKey} />}
            {!graph.nodes.length && <div className="topology-empty topology-empty-overlay"><Empty title={filtering ? t('没有匹配的 Agent', 'No matching agents') : t('当前未发现运行中的 Agent', 'No running agents found')}>{filtering ? t('调整类型、活跃状态或搜索词。活跃状态筛选保留命中节点的父链。', 'Adjust type, activity or search. Activity filters preserve ancestors of matching nodes.') : t('启动 Agent 后等待下次采样；覆盖范围见数据来源。', 'Start an agent and wait for the next sample. See Data sources for coverage.')}</Empty>{filtering && <button className="button secondary" onClick={() => { setQuery(''); setKind('all'); setActivity('all') }}>{t('清除筛选', 'Clear filters')}</button>}</div>}
          </div>}
        {selectedId && <section ref={detailRef} tabIndex={-1} aria-label={t('Agent 详情', 'Agent details')} className="agent-inspector">
          <div className="section-heading"><h2>{selected?.name ?? t('Agent 已离开当前采样', 'Agent no longer in the current sample')}</h2><button className="icon-button" onClick={close} aria-label={t('关闭 Agent 详情', 'Close agent details')}><X size={18} /></button></div>
          {selected ? <dl className="detail-grid">
            <div className="span-2"><dt>{t('工作摘要', 'Work summary')}</dt><dd>{selected.summary || t('未提供会话标题', 'No session title provided')}</dd></div>
            <div><dt>{t('角色', 'Role')}</dt><dd>{selected.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')}</dd></div>
            <div><dt>{t('运行状态', 'Status')}</dt><dd><Badge state={selected.state} /></dd></div>
            <div className="span-2"><dt>{t('近期调用', 'Recent calls')}</dt><dd>{selected.activity ? <><AgentActivity agent={selected} /><small className="agent-activity-explanation">{t(`观察于 ${time(selected.activity.observedAt, language)}；仅表示近 6 秒收到事件，不代表仍在执行。`, `Observed at ${time(selected.activity.observedAt, language)}; an event arrived within the last 6 seconds, which does not indicate ongoing execution.`)}</small></> : t('近 6 秒未观察到调用事件', 'No call events observed in the last 6 seconds')}</dd></div>
            <div><dt>{t('进程', 'Process')}</dt><dd className="mono">{selected.pid}</dd></div>
            <div><dt>{t('运行时', 'Runtime')}</dt><dd>{selected.runtime}</dd></div>
            <div><dt>CPU</dt><dd className="mono">{selected.cpuPercent === undefined ? '—' : `${selected.cpuPercent.toFixed(1)}%`}</dd></div>
            <div><dt>{t('内存', 'Memory')}</dt><dd className="mono">{bytes(selected.memoryBytes)}</dd></div>
            <div className="span-2"><dt>{t('父 Agent', 'Parent agent')}</dt><dd>{parent ? `${parent.name} · PID ${parent.pid}` : selected.parentId ? t(`${selected.parentId}（当前采样不可见）`, `${selected.parentId} (not in the current sample)`) : selected.kind === 'subagent' ? t('来源未提供父 Agent', 'Source did not provide a parent agent') : t('无已确认的父 Agent', 'No confirmed parent agent')}</dd></div>
            <div className="span-2"><dt>{t('模型', 'Model')}</dt><dd>{selected.model || t('来源未提供', 'Not provided by source')}</dd></div>
            <div className="span-2"><dt>{t('工作目录', 'Working directory')}</dt><dd className="mono">{selected.cwd || t('来源未提供', 'Not provided by source')}</dd></div>
            <div className="span-2"><dt>{t('来源', 'Source')}</dt><dd>{selected.source}</dd></div>
          </dl> : <p className="muted">{t('进程或子代理已结束，或当前来源暂不可用。详情保持打开，可查看最新画布及采集状态。', 'The process or subagent has ended, or its source is temporarily unavailable. Details remain open while you review the latest canvas and collection status.')}</p>}
        </section>}
      </div>
      <div className="topology-footer"><span>{t('父 Agent', 'Parent agent')} <ArrowRight size={14} /> {t('子代理', 'Subagent')}</span><span>{graph.issueCount > 0 ? t(`${graph.issueCount} 个节点的关系待确认，见节点提示。`, `Relationships for ${graph.issueCount} nodes need confirmation. See node hints.`) : filtering ? t('关联节点用于保留父子关系；筛选期间展开分支。', 'Related nodes preserve parent-child relationships; branches stay expanded while filtering.') : t('拖动节点整理位置，点击查看详情。', 'Drag nodes to arrange them. Click to view details.')}</span>{view === '2d' && <span className="topology-motion-legend"><i className="topology-legend-stream" aria-hidden="true" />{t('流动只表示父 → 子方向；绿色增强表示工作中或近 6 秒收到调用事件，不代表调用仍在执行。', 'Flow indicates parent → child direction; green emphasis indicates working status or a call event within 6 seconds, not an ongoing call.')}</span>}</div>
    </section>
    {data && <Sources sources={data.sources} compact />}
    <p id="agent-activity-filter-help" className="footnote">{t('活跃：工作中或近 6 秒收到调用事件，不代表调用仍在执行。不活跃：明确空闲且没有近期调用。仅进程存活或状态未知的 Agent 不归入不活跃，可在“全部”中查看。同进程子代理不重复分摊 CPU 与内存。', 'Active: working or a call event observed within 6 seconds, without implying that the call is still executing. Inactive: explicitly idle with no recent calls. Agents with only process liveness or unknown state are not classified as inactive; view them under All. Subagents sharing a process do not duplicate CPU or memory usage.')}</p>
  </>
})
