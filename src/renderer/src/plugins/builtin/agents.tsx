import type { RendererContext, RendererContribution } from '../types'
import { useI18n } from '../../i18n'
import { Empty, SectionHeader, Sources, time, CollectionStatus } from '../../components'
import { agentTarget, scheduleTarget } from '../../../../shared/navigation'
import AgentsView, { AgentTable } from '../../AgentsView'
import ArrowUpRight from 'kubai-icons-react/icons/arrow-up-right'
function Page(context: RendererContext) { return context.agents ? <AgentsView {...context.agents} /> : null }
function Summary({ snapshot, plugins, navigate: setPage, openTarget }: RendererContext) {
 const { t } = useI18n()
 const agents = snapshot.agents.data
 const mainCount = agents?.agents.filter(agent => agent.kind === 'main').length
 const subCount = agents?.activeSubagentCount
 return <>          <button onClick={() => setPage('agents')}><span>{t('主 Agent', 'Main agents')}</span><strong>{plugins.agents ? mainCount ?? '—' : '—'}<small>{t('个', 'agents')}</small></strong><p>{plugins.agents ? t('当前存活进程', 'Live processes') : t('采集已停用', 'Collection disabled')}</p></button>
          <button onClick={() => plugins.agents && agents && subCount === null ? openTarget({ kind: 'source', section: 'agents', id: agents.agents.some(agent => agent.runtime === 'OMP') ? 'omp-ownership' : agents.agents.some(agent => agent.runtime === 'Codex') ? 'codex-sessions' : 'processes' }) : setPage('agents')}><span>{t('活动子代理', 'Active subagents')}</span><strong>{plugins.agents ? subCount ?? '—' : '—'}{plugins.agents && subCount != null && <small>{t('个', 'agents')}</small>}</strong><p>{!plugins.agents ? t('采集已停用', 'Collection disabled') : agents && subCount === null ? t('查看数量未知的来源说明', 'Why the activity count is unknown') : t('已确认的运行实例', 'Confirmed active instances')}</p></button></>
}
function Overview({ snapshot, plugins, paused, agents: view, navigate, openTarget }: RendererContext) {
 const { t, language } = useI18n()
 const displayTime = (value?: string) => time(value, language)
 const agents = snapshot.agents.data
 const previewAgents = agents?.agents.slice(0, 5) ?? []
 const agentFrozenAt = view?.pausedAt ?? null
 return <section className="panel agent-preview"><SectionHeader title={t('Agent 实例', 'Agent instances')} count={agents?.agents.length} action={t('查看全部', 'View all')} onAction={() => navigate('agents')} />{previewAgents.length ? <AgentTable agents={previewAgents} onSelect={agent => openTarget(agentTarget(agent))} pausedAt={agentFrozenAt} /> : <Empty title={!plugins.agents ? t('采集已停用', 'Collection disabled') : agents ? t('未发现存活的 Agent 实例', 'No live agents found') : t('正在读取 Agent 状态', 'Loading agents')}>{t('支持范围与采集限制可在数据来源中查看。', 'See Data sources for coverage and collection limits.')}</Empty>}<div className="panel-footer"><span className="status-dot" /><span>{!plugins.agents ? t('旧快照 · 不再更新', 'Retained snapshot · No updates') : paused ? t('显示已暂停', 'Display paused') : t('会话事件订阅 · 持续更新', 'Session events · Live')}</span><span>{t('进程采样', 'Process sample')} {agents ? displayTime(agents.collectedAt) : t('尚无采样', 'No sample')}</span></div></section>
}
function Tray({ snapshot, plugins, openTarget: openMain }: RendererContext) {
 const { t } = useI18n()
 const settings = { plugins }
 const agents = snapshot.agents.data
 const jobs = snapshot.schedules.data?.jobs.filter(job => job.kind === 'calendar' || job.kind === 'interval')
 return <>        <CollectionStatus enabled={settings.plugins.agents} collectedAt={agents?.collectedAt} label={t('Agent', 'Agents')} />
        <CollectionStatus enabled={settings.plugins.schedules} collectedAt={snapshot.schedules.data?.collectedAt} label={t('定时任务', 'Schedules')} />
        <dl className="tray-counts"><div><dt>{t('主 Agent', 'Main agents')}{!settings.plugins.agents && <small>{t('采集已停用', 'Collection disabled')}</small>}</dt><dd>{settings.plugins.agents ? agents?.agents.filter(agent => agent.kind === 'main').length ?? '—' : '—'}</dd></div><div><dt>{t('活动子代理', 'Active subagents')}</dt><dd title={t('仅显示已确认的活动数量；不可见时保留未知。', 'Only confirmed activity counts are shown; unavailable counts remain unknown.')}>{settings.plugins.agents ? agents?.activeSubagentCount ?? '—' : '—'}</dd></div><div><dt>{t('定时任务', 'Schedules')}{!settings.plugins.schedules && <small>{t('采集已停用', 'Collection disabled')}</small>}</dt><dd>{settings.plugins.schedules ? jobs?.length ?? '—' : '—'}</dd></div></dl>
        <details className="tray-object-list"><summary>{t('查看 Agent 与任务', 'View agents and tasks')}</summary>
          {agents?.agents.slice(0, 5).map(agent => <button key={agent.id} className="text-button" title={agent.summary || agent.name} onClick={() => void openMain(agentTarget(agent))}>{agent.summary || agent.name}<ArrowUpRight trigger="none" size={14} aria-hidden="true" /></button>)}
          {jobs?.slice(0, 5).map(job => <button key={job.id} className="text-button" title={job.name} onClick={() => void openMain(scheduleTarget(job))}>{job.name}<ArrowUpRight trigger="none" size={14} aria-hidden="true" /></button>)}
          <button className="text-button" onClick={() => void openMain({ kind: 'page', page: 'agents' })}>{t('全部 Agent', 'All agents')}</button>
          <button className="text-button" onClick={() => void openMain({ kind: 'page', page: 'schedules' })}>{t('全部任务', 'All tasks')}</button>
        </details></>
}
const contribution: RendererContribution = { id: 'agents', section: 'agents', retainWhenDisabled: true, Page, Summary, Overview, Source: Sources,
 tray: [{ id: 'overview', label: ['Agent 与任务', 'Agents & schedules'], sections: ['agents', 'schedules'], Component: Tray }] }
export default contribution
