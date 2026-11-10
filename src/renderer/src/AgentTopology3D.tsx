import { memo, useEffect, useMemo, useRef, useState } from 'react'
import CircleAlert from 'kubai-icons-react/icons/circle-alert'
import ArrowUpRight from 'kubai-icons-react/icons/arrow-up-right'
import ChevronDown from 'kubai-icons-react/icons/chevron-down'
import Focus from 'kubai-icons-react/icons/focus'
import Maximize from 'kubai-icons-react/icons/maximize'
import ZoomOut from 'kubai-icons-react/icons/zoom-out'
import ZoomIn from 'kubai-icons-react/icons/zoom-in'
import RotateCcw from 'kubai-icons-react/icons/rotate-ccw'
import type { TopologyGraph } from './agent-topology'
import type { Topology3DSession, TopologyScene } from './agent-topology-scene'
import { buildOfficeLayout, MAX_3D_EDGES, MAX_3D_NODES } from './agent-topology-3d-layout'
import { NativeSelect } from './components'
import AgentContextMenu, { type AgentMenuAnchor } from './AgentContextMenu'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './agent-topology-3d.css'

interface Props {
  graph: TopologyGraph
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

export default memo(function AgentTopology3D({ graph, selectedId, onSelect, onToggleCollapse, filtering, evidenceCurrent, liveIds, session, revealId, onRevealed, onNodesReady }: Props) {
  const { t } = useI18n()
  const { snapshot: { resolvedTheme, settings } } = useSettings()
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<TopologyScene | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [menu, setMenu] = useState<AgentMenuAnchor | null>(null)
  const [navigating, setNavigating] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [picked, setPicked] = useState('')
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(session.floorId)
  const overBudget = graph.nodes.length > MAX_3D_NODES || graph.edges.length > MAX_3D_EDGES
  const { layout, layoutError } = useMemo(() => {
    if (overBudget) return { layout: null, layoutError: null }
    try { return { layout: buildOfficeLayout(graph), layoutError: null } }
    catch (error) { return { layout: null, layoutError: error instanceof Error ? error.message : String(error) } }
  }, [graph, overBudget, attempt])
  const latest = useRef({ graph, layout, selectedId, onSelect, liveIds, t, evidenceCurrent, floorId: selectedFloorId, revealId, onRevealed, onNodesReady })
  latest.current = { graph, layout, selectedId, onSelect, liveIds, t, evidenceCurrent, floorId: selectedFloorId, revealId, onRevealed, onNodesReady }
  const activeFloor = layout?.floors.find(floor => floor.id === selectedFloorId)
  const missingFloor = selectedFloorId !== null && !activeFloor && !overBudget && !layoutError
  const displayError = layoutError || failure
  const sceneUnavailable = loading || !!displayError || overBudget
  const selected = graph.nodes.find(node => node.agent.id === selectedId)
  const pickerId = selected ? selected.agent.id : graph.nodes.some(node => node.agent.id === picked) ? picked : ''

  useEffect(() => {
    if (overBudget || layoutError) return
    let disposed = false
    let owned: TopologyScene | null = null
    setLoading(true)
    setFailure(null)
    void import('./agent-topology-scene').then(({ TopologyScene }) => {
      if (disposed) return
      owned = new TopologyScene(host.current!, session, {
        select: id => selectEmployee(id, false),
        floor: id => selectFloor(id),
        menu: (agentId, x, y, trigger) => setMenu({ agentId, x, y, trigger }),
        error: message => setFailure(message),
        ready: () => latest.current.onNodesReady(),
      })
      scene.current = owned
      const current = latest.current
      owned.update(current.graph, current.selectedId, current.liveIds, current.t, current.evidenceCurrent)
      owned.selectFloor(current.floorId)
      revealRequested()
      setLoading(false)
    }).catch(error => {
      owned?.dispose()
      scene.current = null
      if (!disposed) { setFailure(error instanceof Error ? error.message : String(error)); setLoading(false) }
    })
    return () => { disposed = true; owned?.dispose(); scene.current = null }
  }, [attempt, overBudget, layoutError, session])

  useEffect(() => {
    if (!scene.current || overBudget || layoutError) return
    try {
      const current = latest.current
      scene.current.update(graph, selectedId, liveIds, t, evidenceCurrent)
      scene.current.selectFloor(current.floorId)
      revealRequested()
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
  }, [graph, selectedId, liveIds, t, resolvedTheme, settings.textSize, settings.uiFont, evidenceCurrent, overBudget, layoutError, revealId, onNodesReady])

  function selectFloor(id: string | null) {
    setSelectedFloorId(id)
    latest.current.floorId = id
    try { scene.current?.selectFloor(id) }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    session.floorId = id
  }

  function revealRequested() {
    const current = latest.current
    const floorId = current.revealId && current.layout?.floorByAgent.get(current.revealId)
    if (!floorId || !scene.current || !current.revealId) return
    selectFloor(floorId)
    scene.current.focus(current.revealId)
    current.onRevealed()
  }

  function selectEmployee(id: string, focus: boolean) {
    const current = latest.current
    const floorId = current.layout?.floorByAgent.get(id)
    if (!floorId) return
    selectFloor(floorId)
    current.onSelect(id)
    if (focus) {
      try { scene.current?.focus(id) }
      catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    }
  }

  function closeMenu(restoreFocus: boolean) {
    if (restoreFocus) menu?.trigger?.focus({ preventScroll: true })
    setMenu(null)
  }

  async function navigate(id: string) {
    if (navigating) return
    closeMenu(true)
    setNavigating(true)
    setNavigationError(null)
    try {
      if (!window.monitor) throw new Error(t('桌面连接不可用，请重新打开应用。', 'Desktop connection unavailable. Reopen the app.'))
      const result = await window.monitor.focusAgentInTern(id)
      if (result.error) setNavigationError(result.error)
    } catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)) }
    finally { setNavigating(false) }
  }

  return <div className="topology-3d" role="region" aria-label={t('3D 协作拓扑', '3D collaboration topology')}>
    <div className="topology-3d-toolbar">
      <label className="topology-3d-picker">{t('任务楼层', 'Task floor')}
        <NativeSelect value={selectedFloorId ?? ''} title={activeFloor?.cwd} disabled={overBudget || !!layoutError} onChange={event => selectFloor(event.target.value || null)}>
          <option value="">{t('全部项目与任务', 'All projects and tasks')}</option>
          {selectedFloorId !== null && !activeFloor && <option value={selectedFloorId}>{t('已选楼层（当前不可见）', 'Selected floor (currently unavailable)')}</option>}
          {layout?.buildings.map(building => <optgroup key={building.id} label={building.cwd ? building.name : t('项目未识别', 'Unidentified project')} title={building.cwd}>
            {building.floors.map(floor => <option key={floor.id} value={floor.id} title={floor.cwd}>{floor.level} F / {floor.unresolved ? `${t('待归属', 'Unassigned')} · ` : ''}{floor.name} / {t(`${floor.nodeIds.length} 人`, `${floor.nodeIds.length} employees`)}</option>)}
          </optgroup>)}
        </NativeSelect>
      </label>
      <label className="topology-3d-picker">{t('定位员工', 'Locate employee')}
        <NativeSelect value={pickerId} disabled={sceneUnavailable || !graph.nodes.length} onChange={event => {
          const id = event.target.value
          setPicked(id)
          if (id) selectEmployee(id, true)
        }}>
          <option value="">{t('选择员工（Agent）…', 'Choose an employee (agent)…')}</option>
          {!overBudget && graph.nodes.map(node => <option key={node.agent.id} value={node.agent.id} title={node.agent.cwd}>{node.agent.kind === 'main' ? t('主 Agent', 'Main agent') : t('子 Agent', 'Subagent')} · {(node.agent.summary || node.agent.name).slice(0, 160)} · {node.agent.pid}</option>)}
        </NativeSelect>
      </label>
      <span className="topology-3d-hint">{t('拖动旋转 · Shift 拖动平移 · 滚轮缩放', 'Drag to orbit · Shift-drag to pan · Scroll to zoom')}</span>
      {layout && <span className="topology-3d-summary">{t(`${layout.buildings.length} 个项目 · ${layout.floors.length} 个任务楼层`, `${layout.buildings.length} projects · ${layout.floors.length} task floors`)}</span>}
    </div>
    {missingFloor && <p className="topology-3d-note topology-3d-floor-status" role="status">{t('所选任务楼层不在当前筛选或折叠后的数据中，已保留选择；可调整筛选、展开分支，或显示全部楼层。', 'The selected task floor is absent from the current filtered or collapsed data. Its selection is preserved. Adjust filters, expand branches, or show all floors.')}</p>}
    <div className="topology-3d-viewport">
      <div ref={host} className="topology-3d-scene" />
      {(overBudget || displayError || loading) && <div className="topology-3d-message" role={displayError || overBudget ? 'alert' : 'status'}>
        {overBudget ? <><CircleAlert trigger="none" size={22} /><strong>{t('当前关系图超出 3D 显示预算', 'This graph exceeds the 3D display budget')}</strong><p>{t(`当前 ${graph.nodes.length} 位员工、${graph.edges.length} 条关系；上限 ${MAX_3D_NODES} / ${MAX_3D_EDGES}。请用上方搜索或筛选缩小范围，数据未被截断。`, `Current: ${graph.nodes.length} employees, ${graph.edges.length} relationships; limits: ${MAX_3D_NODES} / ${MAX_3D_EDGES}. Narrow the search or filters above. No data was truncated.`)}</p></>
          : displayError ? <><CircleAlert trigger="none" size={22} /><strong>{t('3D 视图不可用', '3D view unavailable')}</strong><p>{displayError}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>{t('重试 3D', 'Retry 3D')}</button></>
          : t('正在加载 3D 视图…', 'Loading 3D view…')}
      </div>}
    </div>
    <div className="topology-3d-controls" role="group" aria-label={t('3D 视角控制', '3D camera controls')}>
      <button type="button" disabled={sceneUnavailable || !activeFloor} onClick={() => {
        if (!selectedFloorId) return
        try { scene.current?.focusFloor(selectedFloorId) }
        catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
      }}><Focus trigger="none" size={15} />{t('聚焦楼层', 'Focus floor')}</button>
      <button type="button" disabled={selectedFloorId === null} onClick={() => selectFloor(null)}>{t('显示全部楼层', 'Show all floors')}</button>
      <button type="button" disabled={sceneUnavailable || !graph.nodes.length} aria-label={t('缩小 3D 视图', 'Zoom out in 3D')} onClick={() => scene.current?.zoom(1.25)}><ZoomOut trigger="none" size={16} /></button>
      <button type="button" disabled={sceneUnavailable || !graph.nodes.length} aria-label={t('放大 3D 视图', 'Zoom in in 3D')} onClick={() => scene.current?.zoom(0.8)}><ZoomIn trigger="none" size={16} /></button>
      <button type="button" disabled={sceneUnavailable || !graph.nodes.length} onClick={() => scene.current?.fit()}><Maximize trigger="none" size={15} />{t('适应全部', 'Fit all')}</button>
      <button type="button" disabled={sceneUnavailable || !graph.nodes.length} onClick={() => scene.current?.fit(true)}><Focus trigger="none" size={15} />{t('正视图', 'Front view')}</button>
      <button type="button" disabled={sceneUnavailable || !graph.nodes.length} onClick={() => scene.current?.reset()}><RotateCcw trigger="none" size={15} />{t('重新布局', 'Reset layout')}</button>
      {selected && <>
        <button type="button" disabled={sceneUnavailable} onClick={() => selectEmployee(selected.agent.id, true)}><Focus trigger="none" size={15} />{t('聚焦选中员工', 'Focus selected employee')}</button>
        {selected.descendantCount > 0 && <button type="button" disabled={filtering} aria-expanded={!selected.collapsed} title={filtering ? t('筛选期间保持展开', 'Branches stay expanded while filtering') : undefined} onClick={() => onToggleCollapse(selected.agent.id)}><ChevronDown trigger="none" size={15} />{selected.collapsed ? t('展开分支', 'Expand branch') : t('收起分支', 'Collapse branch')} ({selected.descendantCount})</button>}
        {selected.agent.runtime === 'OMP' && <button type="button" disabled={navigating} onClick={() => { void navigate(selected.agent.id) }}><ArrowUpRight trigger="none" size={15} />{navigating ? t('正在跳转…', 'Navigating…') : t('前往 Tern', 'Go to Tern')}</button>}
      </>}
    </div>
    <p className="topology-3d-note">{t('一栋楼对应一个项目，一层对应一个主会话任务。主 Agent 使用独立办公室，子 Agent 使用开放工位；父链缺失或异常时标为待归属。选层淡化其他任务；拖动员工调整本层工位，箭头指向子 Agent。完整项目路径可在楼层菜单提示中查看。', 'Each building is a project; each floor is a main-session task. Main agents have private offices and subagents use shared desks. Missing or invalid parent chains are marked unassigned. Selecting a floor dims other tasks; drag employees within their floor. Arrows point to subagents. Floor menu tooltips show full project paths.')}</p>
    {navigationError && <div className="topology-3d-navigation-error" role="alert"><span>{navigationError}</span><button className="button secondary" onClick={() => setNavigationError(null)}>{t('关闭提示', 'Dismiss')}</button></div>}
    {menu && <AgentContextMenu anchor={menu} busy={navigating} onClose={closeMenu} onNavigate={navigate} />}
  </div>
})
