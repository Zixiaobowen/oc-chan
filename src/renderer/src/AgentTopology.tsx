import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { AlertCircle, Bot, ChevronDown, ChevronRight, CornerDownRight, Maximize, Minus, Plus, RotateCcw, X } from 'lucide-react'
import {
  Background,
  BaseEdge,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type AriaLabelConfig,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type XYPosition
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AgentActivity, Badge, bytes } from './components'
import { agentProjectDirectory, layoutAgentTopology, orderedTopologyBranches, type TopologyGraph, type TopologyNode, type TopologyNodeSize } from './agent-topology'
import AgentContextMenu, { type AgentMenuAnchor } from './AgentContextMenu'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import { MAX_SAVED_TOPOLOGY_NODES, saveTopologyPosition, type CanvasViewport, type TopologyMemory } from './view-state'
import './agent-topology.css'

interface AgentTopologyProps {
  graph: TopologyGraph
  pageIndex: number
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleCollapse: (id: string) => void
  filterKey: string
  memory: TopologyMemory
  onNodesReady: () => void
}

type AgentNodeData = TopologyNode & Record<string, unknown> & {
  collapseDisabled: boolean
  onToggleCollapse: (id: string) => void
  onRevealParent: (id: string) => void
}
type AgentFlowNode = Node<AgentNodeData, 'agent'>
type AgentDimensionChange = Extract<NodeChange<AgentFlowNode>, { type: 'dimensions' }>

const UNFILTERED = JSON.stringify(['all', 'all', ''])
const MIN_ZOOM = 0.05
const MAX_ZOOM = 1.8
const fitOptions = { padding: 0.18, minZoom: MIN_ZOOM, maxZoom: 1, duration: 0 }
type Translate = (zh: string, en: string) => string

function topologyIssue(issue: string | undefined, t: Translate): string | undefined {
  switch (issue) {
    case '父子关系存在循环': return t(issue, 'Parent-child relationship contains a cycle')
    case '父 Agent 不在当前快照中': return t(issue, 'Parent agent is not in the current snapshot')
    case '未提供父 Agent 关系': return t(issue, 'No parent agent relationship provided')
    default: return issue
  }
}

function topologyAriaLabels(t: Translate): Partial<AriaLabelConfig> {
  const directions: Record<string, string> = { left: t('左', 'left'), right: t('右', 'right'), up: t('上', 'up'), down: t('下', 'down') }
  return {
    'node.a11yDescription.default': t('按回车或空格查看 Agent 详情。OMP 节点按 Shift+F10 打开操作菜单。可以拖动调整位置。', 'Press Enter or Space to view agent details. Press Shift+F10 on OMP nodes to open actions. Drag to reposition.'),
    'node.a11yDescription.keyboardDisabled': t('按回车或空格查看 Agent 详情。OMP 节点按 Shift+F10 打开操作菜单。选中后可用方向键移动节点，按 Shift 加快移动。', 'Press Enter or Space to view agent details. Press Shift+F10 on OMP nodes to open actions. Use arrow keys to move a selected node; hold Shift to move faster.'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t(`节点向${directions[direction] ?? direction}移动，当前位置：横坐标 ${x}，纵坐标 ${y}。`, `Node moved ${direction}. Current position: x ${x}, y ${y}.`),
    'edge.a11yDescription.default': t('已确认的父 Agent 到子代理关系，只读。', 'Confirmed parent-to-subagent relationship, read only.'),
    'controls.ariaLabel': t('画布控制', 'Canvas controls'),
    'controls.zoomIn.ariaLabel': t('放大画布', 'Zoom in'),
    'controls.zoomOut.ariaLabel': t('缩小画布', 'Zoom out'),
    'controls.fitView.ariaLabel': t('适应视图', 'Fit view'),
    'controls.interactive.ariaLabel': t('切换画布交互', 'Toggle canvas interaction'),
    'minimap.ariaLabel': t('拓扑缩略图', 'Topology minimap'),
    'handle.ariaLabel': t('父子关系连接点，只读', 'Parent-child connection point, read only')
  }
}

function projectColor(cwd: string | undefined): CSSProperties | undefined {
  const directory = agentProjectDirectory(cwd)
  if (!directory) return undefined
  let hash = 2166136261
  for (let index = 0; index < directory.length; index++) {
    hash = Math.imul(hash ^ directory.charCodeAt(index), 16777619)
  }
  return { '--topology-project-color': `hsl(${(hash >>> 0) % 360} 55% 54%)` } as CSSProperties
}

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useI18n()
  const { agent, contextOnly, childCount, descendantCount, collapsed, issue, parentOutsidePage, collapseDisabled, onToggleCollapse, onRevealParent } = data
  const project = agent.cwd || t('工作目录不可见', 'Working directory unavailable')
  const projectStyle = useMemo(() => projectColor(agent.cwd), [agent.cwd])
  const heading = agent.summary || agent.name
  const cpu = agent.cpuPercent !== undefined && Number.isFinite(agent.cpuPercent) ? `${agent.cpuPercent.toFixed(1)}%` : '—'
  const memory = bytes(agent.memoryBytes)
  const note = [contextOnly ? t('关联上下文', 'Related context') : '', topologyIssue(issue, t)].filter(Boolean).join(' · ')
  const collapseLabel = collapsed ? t(`展开 ${descendantCount} 个后代节点`, `Expand ${descendantCount} descendants`) : t(`收起 ${descendantCount} 个后代节点`, `Collapse ${descendantCount} descendants`)

  return <div style={projectStyle} className={`topology-node${selected ? ' is-selected' : ''}${contextOnly ? ' is-context' : ''}`}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <div className="topology-node-heading">
      {agent.kind === 'main' ? <Bot size={16} aria-hidden="true" /> : <CornerDownRight size={16} aria-hidden="true" />}
      <strong title={heading}>{heading}</strong>
    </div>
    <div className="topology-node-project" title={project}>{project}</div>
    <div className="topology-node-badges">
      <span className="badge topology-runtime" title={agent.runtime}>{agent.runtime}</span>
      <span className="badge topology-kind">{agent.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')}</span>
      <Badge state={agent.state} />
    </div>
    <dl className="topology-node-metrics">
      <div><dt>PID</dt><dd title={String(agent.pid)}>{agent.pid}</dd></div>
      <div><dt>CPU</dt><dd title={cpu}>{cpu}</dd></div>
      <div><dt>{t('内存', 'Memory')}</dt><dd title={memory}>{memory}</dd></div>
    </dl>
    <div className={`topology-node-note${issue ? ' has-issue' : ''}`} title={note || undefined}>
      {issue && <AlertCircle size={12} aria-hidden="true" />}
      {agent.activity && !issue ? <AgentActivity agent={agent} /> : <span>{note}</span>}
    </div>
    <div className="topology-node-footer">
      <span>{childCount > 0 ? t(`${childCount} 个直属子代理`, `${childCount} direct subagents`) : t('无已知子代理', 'No known subagents')}</span>
      {descendantCount > 0 && <button
        type="button"
        className="topology-collapse nodrag nopan"
        disabled={collapseDisabled}
        aria-label={collapseLabel}
        aria-expanded={!collapsed}
        title={collapseDisabled ? t('筛选期间保持分支展开，清除筛选后可收起', 'Branches stay expanded while filtering. Clear filters to collapse.') : collapseLabel}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onToggleCollapse(agent.id) }}
      >
        {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        {collapsed ? t('展开', 'Expand') : t('收起', 'Collapse')} {descendantCount}
      </button>}
    </div>
    {parentOutsidePage && <button type="button" className="text-button topology-parent-link nodrag nopan" title={agent.parentId}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onRevealParent(agent.parentId!) }}>{t('父节点在其它页 · 查看', 'Locate parent on another page')}</button>}
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>
})

const nodeTypes = { agent: AgentNode }

// The same path stays mounted as activity changes, keeping its CSS motion phase.
// Direction is always visible; activity only changes the stream's emphasis.
const RelationshipEdge = memo(function RelationshipEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps) {
  const streamRef = useRef<SVGPathElement>(null)
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 16 })
  useEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    const observer = new IntersectionObserver(([entry]) => {
      stream.dataset.motionVisible = String(entry.isIntersecting)
    })
    observer.observe(stream)
    return () => observer.disconnect()
  }, [])
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={0} />
    <path ref={streamRef} d={path} className="topology-flow" fill="none" aria-hidden="true" />
  </>
})
const edgeTypes = { relationship: RelationshipEdge }

function initialFocusNodes(graph: TopologyGraph): { id: string }[] {
  const branches = orderedTopologyBranches(graph)
  const firstProject = branches[0]?.project
  const nodes: { id: string }[] = []
  for (const branch of branches) {
    if (branch.project !== firstProject) break
    for (const id of branch.ids) nodes.push({ id })
  }
  return nodes
}

function CanvasControls({ onFit, onRelayout, onViewportAction }: { onFit: () => void; onRelayout: () => void; onViewportAction: () => void }) {
  const { t } = useI18n()
  const { zoomIn, zoomOut } = useReactFlow()
  const { zoom } = useViewport()
  return <Panel position="bottom-left" className="topology-controls nodrag nopan" role="group" aria-label={t('画布控制', 'Canvas controls')} onClickCapture={onViewportAction}>
    <button type="button" aria-label={t('缩小画布', 'Zoom out')} title={t('缩小画布', 'Zoom out')} disabled={zoom <= MIN_ZOOM} onClick={() => { void zoomOut({ duration: 0 }) }}><Minus size={16} aria-hidden="true" /></button>
    <output className="topology-zoom" aria-label={t('当前缩放比例', 'Current zoom')}>{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label={t('放大画布', 'Zoom in')} title={t('放大画布', 'Zoom in')} disabled={zoom >= MAX_ZOOM} onClick={() => { void zoomIn({ duration: 0 }) }}><Plus size={16} aria-hidden="true" /></button>
    <span className="topology-controls-divider" aria-hidden="true" />
    <button type="button" title={t('显示当前画布中的全部节点', 'Show all nodes on the current canvas')} onClick={onFit}><Maximize size={15} aria-hidden="true" /><span>{t('适应视图', 'Fit view')}</span></button>
    <button type="button" title={t('清除手动位置，重新排列当前节点', 'Clear manual positions and rearrange current nodes')} onClick={onRelayout}><RotateCcw size={15} aria-hidden="true" /><span>{t('重新布局', 'Reset layout')}</span></button>
  </Panel>
}

function TopologyCanvas({ graph, pageIndex, selectedId, onSelect, onToggleCollapse, filterKey, memory, onNodesReady }: AgentTopologyProps) {
  const { t } = useI18n()
  const { snapshot: { resolvedTheme, resolvedLanguage, settings } } = useSettings()
  const typographyKey = `${resolvedLanguage}:${settings.textSize}:${settings.uiFont}:${settings.codeFont}`
  const lastTypographyKey = useRef(typographyKey)
  const ariaLabelConfig = useMemo(() => topologyAriaLabels(t), [t])
  const [nodes, setNodes] = useState<AgentFlowNode[]>([])
  const nodesRef = useRef<AgentFlowNode[]>([])
  const [memoryLimited, setMemoryLimited] = useState(false)
  const [fitRequest, setFitRequest] = useState(0)
  const [layoutRequest, setLayoutRequest] = useState(0)
  const [menu, setMenu] = useState<AgentMenuAnchor | null>(null)
  const [navigating, setNavigating] = useState(false)
  const [navigationError, setNavigationError] = useState<{ kind: 'connection' } | { kind: 'external'; message: string } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const initialViewport = useRef(memory.viewport ?? undefined)
  const automaticPositions = useRef(new Map<string, XYPosition>())
  const appliedDimensions = useRef(new Map<string, TopologyNodeSize>())
  const measuredWidth = useRef<number | null>(null)
  const pendingDimensions = useRef(new Map<string, AgentDimensionChange>())
  const measurementFrame = useRef<number | null>(null)
  const layoutKey = useRef<string | null>(null)
  const hadNodes = useRef(memory.viewport !== null)
  const lastSelectedId = useRef(selectedId)
  const revealAllowed = useRef(false)
  const fittedRequest = useRef(0)
  const fitTarget = useRef<{ nodes?: { id: string }[]; minZoom?: number }>({})
  const initialized = useNodesInitialized()
  const { fitView, getNode, getViewport, setViewport } = useReactFlow<AgentFlowNode>()

  const scheduleMeasurements = useCallback(() => {
    if (measurementFrame.current !== null || document.hidden || !pendingDimensions.current.size) return
    measurementFrame.current = requestAnimationFrame(() => {
      measurementFrame.current = null
      if (!mounted.current || document.hidden) return
      const changes = [...pendingDimensions.current.values()]
      pendingDimensions.current.clear()
      let next = applyNodeChanges(changes, nodesRef.current)
      const width = changes.find(change => change.dimensions?.width)?.dimensions?.width
      if (width && width !== measuredWidth.current) {
        measuredWidth.current = width
        // Typography changes affect offscreen cards too; measure them once.
        next = next.map(node => node.measured?.width && node.measured.width !== width
          ? { ...node, measured: undefined } : node)
      }
      nodesRef.current = next
      setNodes(next)
    })
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (measurementFrame.current !== null) cancelAnimationFrame(measurementFrame.current)
      measurementFrame.current = null
      pendingDimensions.current.clear()
    }
  }, [])

  const saveViewport = useCallback((viewport: CanvasViewport) => {
    if (mounted.current) memory.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  }, [memory])

  useEffect(() => {
    function saveWhenHidden() {
      if (!document.hidden) { scheduleMeasurements(); return }
      if (measurementFrame.current !== null) cancelAnimationFrame(measurementFrame.current)
      measurementFrame.current = null
      saveViewport(getViewport())
      setMenu(null)
    }
    function saveBeforePageHide() { saveViewport(getViewport()) }
    document.addEventListener('visibilitychange', saveWhenHidden)
    window.addEventListener('pagehide', saveBeforePageHide)
    return () => {
      document.removeEventListener('visibilitychange', saveWhenHidden)
      window.removeEventListener('pagehide', saveBeforePageHide)
    }
  }, [getViewport, saveViewport, scheduleMeasurements])

  useLayoutEffect(() => {
    const filterChanged = memory.filterKey !== null && filterKey !== memory.filterKey
    const pageChanged = memory.pageIndex !== null && pageIndex !== memory.pageIndex
    memory.pageIndex = pageIndex
    const typographyChanged = typographyKey !== lastTypographyKey.current
    lastTypographyKey.current = typographyKey
    // Only explicit filter/reset actions discard manual positions.
    if (filterChanged) {
      memory.manualPositions.clear()
      memory.positions.clear()
      memory.dimensions.clear()
      revealAllowed.current = false
    }
    if (filterChanged || pageChanged) {
      layoutKey.current = null
      pendingDimensions.current.clear()
    }
    memory.filterKey = filterKey

    const previous = new Map(nodesRef.current.map(node => [node.id, node]))
    const next = graph.nodes.map(topologyNode => {
      const id = topologyNode.agent.id
      const existing = previous.get(id)
      const position = memory.manualPositions.get(id)
        ?? memory.positions.get(id)
        ?? (!filterChanged ? existing?.position : undefined)
        ?? { x: 0, y: 0 }
      return {
        ...existing,
        id,
        type: 'agent' as const,
        position,
        measured: typographyChanged ? undefined : existing?.measured,
        selected: id === selectedId,
        deletable: false,
        connectable: false,
        data: { ...topologyNode, collapseDisabled: filterKey !== UNFILTERED, onToggleCollapse, onRevealParent: onSelect }
      }
    })
    nodesRef.current = next
    setNodes(next)
    if (filterChanged || pageChanged || (!hadNodes.current && graph.nodes.length > 0)) {
      const firstMatch = filterKey === UNFILTERED ? undefined : graph.nodes.find(node => !node.contextOnly)
      fitTarget.current = (pageChanged || !hadNodes.current) && selectedId && graph.nodes.some(node => node.agent.id === selectedId)
        ? { nodes: [{ id: selectedId }], minZoom: 0.65 }
        : firstMatch
          ? { nodes: [{ id: firstMatch.agent.id }], minZoom: 0.65 }
          : { nodes: initialFocusNodes(graph), minZoom: 0.65 }
      setFitRequest(request => request + 1)
    } else if (selectedId && selectedId !== lastSelectedId.current && fitRequest !== fittedRequest.current && fitTarget.current.nodes) {
      // A late initial fit must follow object navigation, even if details close before measurement finishes.
      fitTarget.current = { nodes: [{ id: selectedId }], minZoom: 0.65 }
    }
    if (graph.nodes.length > 0) hadNodes.current = true
  }, [graph, pageIndex, selectedId, filterKey, onSelect, onToggleCollapse, memory, typographyKey])

  useLayoutEffect(() => {
    if (nodes.length !== graph.nodes.length || nodes.some((node, index) => node.id !== graph.nodes[index].agent.id)) return
    let geometryChanged = false
    for (const node of nodes) {
      const { width, height } = node.measured ?? {}
      if (!width || !height) return
      const previous = appliedDimensions.current.get(node.id) ?? memory.dimensions.get(node.id)
      if (previous && (previous.width !== width || previous.height !== height)) geometryChanged = true
    }
    const structureChanged = layoutKey.current !== graph.layoutKey
    if (!structureChanged && !geometryChanged) return
    const reflow = geometryChanged || (structureChanged && layoutKey.current !== null)
    const sizes = new Map(nodes.map(node => [node.id, { width: node.measured!.width!, height: node.measured!.height! }]))
    automaticPositions.current = layoutAgentTopology(graph, sizes)
    appliedDimensions.current = sizes
    layoutKey.current = graph.layoutKey
    let limited = false
    const next = nodes.map(node => {
      const position = memory.manualPositions.get(node.id)
        ?? (!reflow ? memory.positions.get(node.id) : undefined)
        ?? automaticPositions.current.get(node.id)!
      if (saveTopologyPosition(memory, node.id, position, false)) memory.dimensions.set(node.id, sizes.get(node.id)!)
      else limited = true
      return { ...node, position }
    })
    nodesRef.current = next
    setNodes(next)
    setMemoryLimited(limited)
  }, [nodes, graph, memory, layoutRequest])

  const localizedNodes = useMemo(() => nodes.map(node => {
    const { agent, contextOnly, issue } = node.data
    return {
      ...node,
      ariaLabel: `${agent.summary || agent.name}, ${agent.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')}, PID ${agent.pid}${contextOnly ? t('，关联上下文', ', related context') : ''}${issue ? `, ${topologyIssue(issue, t)}` : ''}`,
      domAttributes: { 'aria-roledescription': t('Agent 节点', 'Agent node'), 'aria-current': Boolean(node.selected) }
    }
  }), [nodes, t])

  useEffect(() => {
    if (nodes !== nodesRef.current || !initialized || layoutKey.current !== graph.layoutKey || fitRequest === fittedRequest.current ||
      pendingDimensions.current.size || nodes.some(node => !node.measured?.width || !node.measured.height)) return
    fittedRequest.current = fitRequest
    void fitView({ ...fitOptions, ...fitTarget.current })
  }, [initialized, fitRequest, fitView, nodes, graph.layoutKey])

  useLayoutEffect(() => {
    if (initialized && nodes === nodesRef.current && !pendingDimensions.current.size) onNodesReady()
  }, [initialized, nodes, onNodesReady])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !initialized || nodes !== nodesRef.current || pendingDimensions.current.size ||
      nodes.some(node => !node.measured?.width || !node.measured.height) || selectedId === lastSelectedId.current) return
    lastSelectedId.current = selectedId
    revealAllowed.current = Boolean(selectedId)
    if (!selectedId) return

    function revealSelection() {
      const node = getNode(selectedId!)
      if (!node?.measured?.width || !node.measured.height || !canvas || !mounted.current || !revealAllowed.current) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!width || !height) return
      const viewport = getViewport()
      const left = node.position.x * viewport.zoom + viewport.x
      const top = node.position.y * viewport.zoom + viewport.y
      // If the zoomed card exceeds the available space, retain the nearest
      // position exposing as much of it as possible without changing zoom.
      function displacement(start: number, size: number, extent: number) {
        const far = extent - 16 - size
        return Math.min(Math.max(16, far), Math.max(Math.min(16, far), start)) - start
      }
      const dx = displacement(left, node.measured.width * viewport.zoom, width)
      const dy = displacement(top, node.measured.height * viewport.zoom, height)
      if (dx || dy) void setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, { duration: 0 })
    }

    revealSelection()
  }, [selectedId, initialized, nodes, getNode, getViewport, setViewport])

  const onNodesChange = useCallback((changes: NodeChange<AgentFlowNode>[]) => {
    if (!mounted.current) return
    const positions = changes.filter(change => change.type === 'position')
    for (const change of positions) {
      if (change.position && !saveTopologyPosition(memory, change.id, change.position, true)) setMemoryLimited(true)
    }
    if (positions.length) {
      const next = applyNodeChanges(positions, nodesRef.current)
      nodesRef.current = next
      setNodes(next)
    }
    const dimensions = changes.filter(change => change.type === 'dimensions')
    if (!dimensions.length) return
    const ids = new Set(nodesRef.current.map(node => node.id))
    for (const id of pendingDimensions.current.keys()) if (!ids.has(id)) pendingDimensions.current.delete(id)
    for (const change of dimensions) if (ids.has(change.id)) pendingDimensions.current.set(change.id, change)
    scheduleMeasurements()
  }, [memory, scheduleMeasurements])

  const edges = useMemo<Edge[]>(() => {
    const agents = new Map(graph.nodes.map(node => [node.agent.id, node.agent]))
    return graph.edges.map(edge => {
      const emphasized = edge.source === selectedId || edge.target === selectedId
      const child = agents.get(edge.target)
      const active = child?.parentId === edge.source && (child.state === 'working' || Boolean(child.activity))
      return {
        ...edge,
        type: 'relationship',
        selectable: false,
        deletable: false,
        reconnectable: false,
        focusable: false,
        className: `topology-edge${emphasized ? ' is-selected' : ''}${active ? ' is-active' : ''}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge)', width: 18, height: 18 },
        zIndex: emphasized ? 1 : 0
      }
    })
  }, [graph.edges, graph.nodes, selectedId])

  function fitAll() {
    fitTarget.current = {}
    setFitRequest(request => request + 1)
  }

  function relayout() {
    memory.manualPositions.clear()
    memory.positions.clear()
    memory.dimensions.clear()
    revealAllowed.current = false
    layoutKey.current = null
    setLayoutRequest(request => request + 1)
    fitAll()
  }

  function closeMenu(restoreFocus = true) {
    if (!mounted.current) return
    if (restoreFocus) menu?.trigger?.focus({ preventScroll: true })
    setMenu(null)
  }

  async function navigateToTern(agentId: string) {
    if (navigating) return
    closeMenu()
    setNavigationError(null)
    setNavigating(true)
    try {
      if (!window.monitor) {
        setNavigationError({ kind: 'connection' })
        return
      }
      const { error } = await window.monitor.focusAgentInTern(agentId)
      if (mounted.current && error) setNavigationError({ kind: 'external', message: error })
    } catch (error) {
      if (mounted.current) setNavigationError({ kind: 'external', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (mounted.current) setNavigating(false)
    }
  }

  function openWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const contextMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
    if (!contextMenuKey && event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.classList.contains('react-flow__node')) return
    const id = target.dataset.id
    if (!id) return
    if (contextMenuKey) {
      if (getNode(id)?.data.agent.runtime !== 'OMP') return
      event.preventDefault()
      event.stopPropagation()
      const bounds = target.getBoundingClientRect()
      setMenu({ agentId: id, x: bounds.left + 24, y: bounds.top + 24, trigger: target })
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onSelect(id)
  }

  function chooseViewport() {
    revealAllowed.current = false
    fittedRequest.current = fitRequest
  }

  return <div ref={canvasRef} className="topology-canvas" role="region" aria-label={t('协作拓扑画布', 'Agent topology canvas')} onKeyDownCapture={openWithKeyboard}>
    <ReactFlow<AgentFlowNode>
      nodes={localizedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onlyRenderVisibleElements
      onNodesChange={onNodesChange}
      defaultViewport={initialViewport.current}
      onViewportChange={saveViewport}
      onMoveStart={event => { if (event) chooseViewport() }}
      onNodeClick={(event, node) => {
        if (event.target instanceof Element) event.target.closest<HTMLElement>('.react-flow__node')?.focus({ preventScroll: true })
        onSelect(node.id)
      }}
      onNodeContextMenu={(event, node) => {
        if (node.data.agent.runtime !== 'OMP') return
        event.preventDefault()
        const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node') : null
        trigger?.focus({ preventScroll: true })
        setMenu({ agentId: node.id, x: event.clientX, y: event.clientY, trigger })
      }}
      elementsSelectable={false}
      nodesConnectable={false}
      edgesReconnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      selectNodesOnDrag={false}
      panOnDrag={[0, 1]}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      nodeDragThreshold={4}
      ariaLabelConfig={ariaLabelConfig}
      colorMode={resolvedTheme}
      attributionPosition="top-right"
    >
      <Background gap={24} size={1} color="var(--border-strong)" />
      {graph.nodes.length > 0 && <Panel position="top-left" className="topology-pan-hint">
        <div>{t('拖动空白平移，查看其他分支', 'Drag empty space to pan and see other branches')}</div>
        <div>{t('按项目目录排序 · 同项目主 Agent 并列 · 未知项目置后', 'Sorted by project path · Same-project roots side by side · Unknown projects last')}</div>
        {memoryLimited && <div role="status">{t(`最多保留 ${MAX_SAVED_TOPOLOGY_NODES} 个节点的位置；标识超过 512 个字符的节点不保留。部分位置在切页后无法恢复。`, `Positions are kept for up to ${MAX_SAVED_TOPOLOGY_NODES} nodes; IDs longer than 512 characters are excluded. Some positions cannot be restored after switching pages.`)}</div>}
      </Panel>}
      {graph.nodes.length > 0 && <CanvasControls onFit={fitAll} onRelayout={relayout} onViewportAction={chooseViewport} />}
      {navigationError && <Panel position="top-right" className="topology-navigation-error" role="alert">
        <AlertCircle size={16} aria-hidden="true" />
        <span>{navigationError.kind === 'connection' ? t('桌面连接不可用，请重新打开应用。', 'Desktop connection unavailable. Please reopen the app.') : navigationError.message}</span>
        <button type="button" aria-label={t('关闭跳转提示', 'Dismiss navigation message')} onClick={() => setNavigationError(null)}><X size={14} /></button>
      </Panel>}
    </ReactFlow>
    {menu && <AgentContextMenu anchor={menu} busy={navigating} onClose={closeMenu} onNavigate={navigateToTern} />}
  </div>
}

export default function AgentTopology(props: AgentTopologyProps) {
  return <ReactFlowProvider><TopologyCanvas {...props} /></ReactFlowProvider>
}
