import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import CircleAlert from 'kubai-icons-react/icons/circle-alert'
import ChevronDown from 'kubai-icons-react/icons/chevron-down'
import Focus from 'kubai-icons-react/icons/focus'
import Maximize from 'kubai-icons-react/icons/maximize'
import ZoomOut from 'kubai-icons-react/icons/zoom-out'
import ZoomIn from 'kubai-icons-react/icons/zoom-in'
import RotateCcw from 'kubai-icons-react/icons/rotate-ccw'
import type { AgentInfo } from '../../shared/types'
import type { TopologyGraph } from './agent-topology'
import type { Topology3DSession, TopologyScene } from './agent-topology-scene'
import { buildGalaxyLayout, buildSnapshotGalaxyLayout, MAX_3D_EDGES, MAX_3D_NODES, projectGalaxyLayout } from './agent-topology-3d-layout'
import { NativeSelect } from './components'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './agent-topology-3d.css'

interface Props {
  graph: TopologyGraph
  agents: AgentInfo[]
  selectedId: string | null
  onSelect(id: string): void
  onToggleCollapse(id: string): void
  filtering: boolean
  evidenceCurrent: boolean
  liveIds: ReadonlySet<string>
  session: Topology3DSession
  revealId: string | null
  onRevealed(): void
  onNodesReady(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export default memo(function AgentTopology3D({ graph, agents, selectedId, onSelect, onToggleCollapse, filtering, evidenceCurrent, liveIds, session, revealId, onRevealed, onNodesReady }: Props) {
  const { t } = useI18n()
  const { snapshot: { resolvedTheme, settings } } = useSettings()
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<TopologyScene | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [placementConflict, setPlacementConflict] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(session.taskId)
  const taskStatusId = useId()
  const overBudget = graph.nodes.length > MAX_3D_NODES || graph.edges.length > MAX_3D_EDGES
  const canonical = useMemo(() => {
    if (overBudget) return { full: null, error: null }
    try { return { full: buildSnapshotGalaxyLayout(agents), error: null } }
    catch (error) { return { full: null, error: errorMessage(error) } }
  }, [agents, overBudget, attempt])
  const { full } = canonical
  const { layout, layoutError } = useMemo(() => {
    if (overBudget || canonical.error) return { layout: null, layoutError: canonical.error }
    try { return { layout: full ? projectGalaxyLayout(full, graph) : buildGalaxyLayout(graph), layoutError: null } }
    catch (error) { return { layout: null, layoutError: errorMessage(error) } }
  }, [graph, full, canonical.error, overBudget, attempt])
  const latest = useRef({ graph, layout, full, selectedId, onSelect, liveIds, t, evidenceCurrent, revealId, onRevealed, onNodesReady })
  latest.current = { graph, layout, full, selectedId, onSelect, liveIds, t, evidenceCurrent, revealId, onRevealed, onNodesReady }
  const activeTask = layout?.tasks.find(task => task.id === selectedTaskId)
  const missingTask = layout !== null && selectedTaskId !== null && !activeTask
  const displayError = layoutError || failure
  const sceneUnavailable = loading || !!displayError || !!placementConflict || overBudget
  const hasNodes = graph.nodes.length > 0
  const selected = graph.nodes.find(node => node.agent.id === selectedId)

  useEffect(() => {
    if (overBudget || layoutError) return
    let disposed = false
    let owned: TopologyScene | null = null
    setLoading(true)
    setFailure(null)
    void import('./agent-topology-scene').then(({ TopologyScene }) => {
      const element = host.current
      if (disposed || !element) return
      owned = new TopologyScene(element, session, {
        select: id => selectAgent(id, false),
        task: id => selectTask(id),
        error: setFailure,
        placementConflict: setPlacementConflict,
        notice: setNotice,
        ready: () => latest.current.onNodesReady(),
      })
      scene.current = owned
      const current = latest.current
      if (current.layout && owned.update(current.graph, current.selectedId, current.liveIds, current.t, current.evidenceCurrent, current.layout, current.full)) {
        owned.selectTask(session.taskId)
        revealRequested(owned)
      }
      setLoading(false)
    }).catch(error => {
      if (disposed) return
      owned?.dispose()
      owned = null
      scene.current = null
      setFailure(errorMessage(error))
      setLoading(false)
    })
    return () => { disposed = true; owned?.dispose(); scene.current = null }
  }, [attempt, overBudget, layoutError, session])

  useEffect(() => {
    if (!layout) return
    runScene(current => {
      if (!current.update(graph, selectedId, liveIds, t, evidenceCurrent, layout, full)) return
      current.selectTask(session.taskId)
      revealRequested(current)
    })
  }, [graph, layout, full, selectedId, liveIds, t, resolvedTheme, settings.textSize, settings.uiFont, evidenceCurrent, session, revealId, onNodesReady])

  function runScene(action: (current: TopologyScene) => void) {
    if (!scene.current) return
    try { action(scene.current) }
    catch (error) { setFailure(errorMessage(error)) }
  }

  function rememberTask(id: string | null) {
    session.taskId = id
    setSelectedTaskId(id)
  }

  function selectTask(id: string | null) {
    runScene(current => current.selectTask(id))
    rememberTask(id)
  }

  function revealRequested(current: TopologyScene) {
    const { revealId, selectedId, layout, onRevealed } = latest.current
    if (!revealId || revealId !== selectedId) return
    const taskId = layout?.taskByAgent.get(revealId)
    if (!taskId) return
    current.selectTask(taskId)
    rememberTask(taskId)
    current.focus(revealId)
    onRevealed()
  }

  function selectAgent(id: string, focus: boolean) {
    const current = latest.current
    const taskId = current.layout?.taskByAgent.get(id)
    if (!taskId) return
    selectTask(taskId)
    current.onSelect(id)
    if (focus) runScene(current => current.focus(id))
  }

  return <div className="topology-3d" role="region" aria-label={t('3D 协作拓扑星图', '3D collaboration star map')}>
    <div className="topology-3d-toolbar">
      <label className="topology-3d-picker">{t('任务系统', 'Task system')}
        <NativeSelect value={selectedTaskId ?? ''} title={activeTask?.cwd} aria-describedby={missingTask ? taskStatusId : undefined} disabled={overBudget || !!layoutError} onChange={event => selectTask(event.target.value || null)}>
          <option value="">{t('全部星系与任务', 'All galaxies and tasks')}</option>
          {selectedTaskId !== null && !activeTask && <option value={selectedTaskId}>{t('所选任务（当前不可见）', 'Selected task (currently unavailable)')}</option>}
          {layout?.galaxies.map(galaxy => <optgroup key={galaxy.id} title={galaxy.cwd ?? ''} label={galaxy.cwd ?? (galaxy.id === 'unresolved' ? t('待归属', 'Unassigned') : t('项目未识别', 'Unidentified project'))}>
            {galaxy.tasks.map(task => <option key={task.id} value={task.id} title={task.cwd}>{task.name} · {t(`${task.nodeIds.length} 个 Agent`, `${task.nodeIds.length} ${task.nodeIds.length === 1 ? 'agent' : 'agents'}`)}</option>)}
          </optgroup>)}
        </NativeSelect>
      </label>
      <label className="topology-3d-picker">{t('定位 Agent', 'Locate agent')}
        <NativeSelect value={selected?.agent.id ?? ''} title={selected?.agent.cwd} disabled={sceneUnavailable || !hasNodes} onChange={event => selectAgent(event.target.value, true)}>
          <option value="" disabled>{t('选择 Agent…', 'Choose an agent…')}</option>
          {!overBudget && graph.nodes.map(({ agent }) => <option key={agent.id} value={agent.id} title={agent.cwd}>{agent.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')} · {(agent.summary || agent.name).slice(0, 160)} · {agent.pid}</option>)}
        </NativeSelect>
      </label>
      {layout && hasNodes && <span className="topology-3d-summary">{t(`${layout.galaxies.length} 个星系 · ${layout.tasks.length} 个任务`, `${layout.galaxies.length} ${layout.galaxies.length === 1 ? 'galaxy' : 'galaxies'} · ${layout.tasks.length} ${layout.tasks.length === 1 ? 'task' : 'tasks'}`)}</span>}
    </div>
    {missingTask && <p id={taskStatusId} className="topology-3d-task-status" role="status">{t('所选任务当前不可见，选择已保留。可调整筛选、展开分支或显示全部任务。', 'The selected task is out of view. Adjust filters, expand branches, or show all tasks.')}</p>}
    {!sceneUnavailable && (notice || !full) && <p className="topology-3d-task-status" role="status">{notice || t('快照超过 3D 上限，按当前可见任务分配空间。', 'The snapshot exceeds the 3D limit. Space is allocated for the visible tasks.')}</p>}
    <div className="topology-3d-viewport">
      <div ref={host} className="topology-3d-scene" inert={sceneUnavailable || !hasNodes} onContextMenu={event => event.preventDefault()} />
      {(overBudget || displayError || placementConflict || (loading && hasNodes)) && <div className="topology-3d-message" role={displayError || placementConflict || overBudget ? 'alert' : 'status'}>
        {overBudget ? <><CircleAlert trigger="none" size={22} aria-hidden="true" /><strong>{t('当前关系图超出 3D 显示预算', 'This graph exceeds the 3D display budget')}</strong><p>{t(`当前有 ${graph.nodes.length} 个 Agent 和 ${graph.edges.length} 条关系，3D 上限为 ${MAX_3D_NODES} 个 Agent 和 ${MAX_3D_EDGES} 条关系。请通过搜索或筛选缩小范围，或切换到 2D。`, `The graph has ${graph.nodes.length} agents and ${graph.edges.length} relationships. The 3D limits are ${MAX_3D_NODES} agents and ${MAX_3D_EDGES} relationships. Narrow the search or filters, or switch to 2D.`)}</p></>
          : displayError ? <><CircleAlert trigger="none" size={22} aria-hidden="true" /><strong>{t('3D 视图不可用', '3D view unavailable')}</strong><p>{displayError}</p><button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}>{t('重试 3D', 'Retry 3D')}</button></>
          : placementConflict ? <><CircleAlert trigger="none" size={22} aria-hidden="true" /><p>{placementConflict}</p><button type="button" className="button secondary" onClick={() => runScene(current => current.reset())}>{t('重新布局', 'Reset layout')}</button></>
          : t('正在加载 3D 星图…', 'Loading the 3D star map…')}
      </div>}
    </div>
    <div className="topology-3d-footer">
      <div className="topology-3d-controls" role="group" aria-label={t('3D 星图控制', '3D star map controls')}>
        <div className="topology-3d-actions">
          <button type="button" disabled={sceneUnavailable || !activeTask} onClick={() => { if (activeTask) runScene(current => current.focusTask(activeTask.id)) }}><Focus trigger="none" size={15} aria-hidden="true" />{t('聚焦任务', 'Focus task')}</button>
          <button type="button" disabled={selectedTaskId === null} onClick={() => selectTask(null)}>{t('显示全部任务', 'Show all tasks')}</button>
        </div>
        <div className="topology-3d-actions">
          <button type="button" disabled={sceneUnavailable || !hasNodes} aria-label={t('缩小 3D 视图', 'Zoom out in 3D')} title={t('缩小 3D 视图', 'Zoom out in 3D')} onClick={() => runScene(current => current.zoom(1.25))}><ZoomOut trigger="none" size={16} aria-hidden="true" /></button>
          <button type="button" disabled={sceneUnavailable || !hasNodes} aria-label={t('放大 3D 视图', 'Zoom in in 3D')} title={t('放大 3D 视图', 'Zoom in in 3D')} onClick={() => runScene(current => current.zoom(0.8))}><ZoomIn trigger="none" size={16} aria-hidden="true" /></button>
          <button type="button" disabled={sceneUnavailable || !hasNodes} onClick={() => runScene(current => current.fit())}><Maximize trigger="none" size={15} aria-hidden="true" />{t('适应全部', 'Fit all')}</button>
          <button type="button" disabled={sceneUnavailable || !hasNodes} onClick={() => runScene(current => current.fit(true))}>{t('正视图', 'Front view')}</button>
          <button type="button" disabled={sceneUnavailable || !hasNodes} onClick={() => runScene(current => current.reset())}><RotateCcw trigger="none" size={15} aria-hidden="true" />{t('重新布局', 'Reset layout')}</button>
        </div>
        {selected && <div className="topology-3d-actions">
          <button type="button" disabled={sceneUnavailable} onClick={() => selectAgent(selected.agent.id, true)}><Focus trigger="none" size={15} aria-hidden="true" />{t('聚焦选中 Agent', 'Focus selected agent')}</button>
          {selected.descendantCount > 0 && <button type="button" disabled={filtering} aria-expanded={!selected.collapsed} title={filtering ? t('筛选期间保持展开', 'Branches stay expanded while filtering') : undefined} onClick={() => onToggleCollapse(selected.agent.id)}><ChevronDown trigger="none" size={15} aria-hidden="true" />{selected.collapsed ? t('展开分支', 'Expand branch') : t('收起分支', 'Collapse branch')} ({selected.descendantCount})</button>}
        </div>}
      </div>
      {!sceneUnavailable && hasNodes && <p className="topology-3d-hint">{t('拖动旋转 · Shift 拖动平移 · 滚轮缩放', 'Drag to orbit · Shift-drag to pan · Scroll to zoom')}</p>}
    </div>
  </div>
})
