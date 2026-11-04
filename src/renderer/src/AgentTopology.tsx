import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
import { AGENT_NODE_HEIGHT, AGENT_NODE_WIDTH, layoutAgentTopology, type TopologyGraph, type TopologyNode } from './agent-topology'
import AgentContextMenu, { type AgentMenuAnchor } from './AgentContextMenu'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './agent-topology.css'

interface AgentTopologyProps {
  graph: TopologyGraph
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleCollapse: (id: string) => void
  filterKey: string
}

type AgentNodeData = TopologyNode & Record<string, unknown> & {
  collapseDisabled: boolean
  onToggleCollapse: (id: string) => void
}
type AgentFlowNode = Node<AgentNodeData, 'agent'>

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

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useI18n()
  const { agent, contextOnly, childCount, descendantCount, collapsed, issue, collapseDisabled, onToggleCollapse } = data
  const project = agent.cwd || t('工作目录不可见', 'Working directory unavailable')
  const heading = agent.summary || agent.name
  const cpu = agent.cpuPercent !== undefined && Number.isFinite(agent.cpuPercent) ? `${agent.cpuPercent.toFixed(1)}%` : '—'
  const memory = bytes(agent.memoryBytes)
  const note = [contextOnly ? t('关联上下文', 'Related context') : '', topologyIssue(issue, t)].filter(Boolean).join(' · ')
  const collapseLabel = collapsed ? t(`展开 ${descendantCount} 个后代节点`, `Expand ${descendantCount} descendants`) : t(`收起 ${descendantCount} 个后代节点`, `Collapse ${descendantCount} descendants`)

  return <div className={`topology-node${selected ? ' is-selected' : ''}${contextOnly ? ' is-context' : ''}${agent.state === 'working' || agent.activity ? ' is-active' : ''}`}>
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
  if (!graph.edges.length) return graph.nodes.slice(0, 6).map(node => ({ id: node.agent.id }))
  const neighbors = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const source = neighbors.get(edge.source) ?? []
    const target = neighbors.get(edge.target) ?? []
    source.push(edge.target)
    target.push(edge.source)
    neighbors.set(edge.source, source)
    neighbors.set(edge.target, target)
  }
  const visited = new Set<string>()
  const pending = [graph.edges[0].source]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const neighbor of neighbors.get(id) ?? []) {
      if (!visited.has(neighbor)) pending.push(neighbor)
    }
  }
  return Array.from(visited, id => ({ id }))
}

function CanvasControls({ onRelayout }: { onRelayout: () => void }) {
  const { t } = useI18n()
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()
  return <Panel position="bottom-left" className="topology-controls nodrag nopan" role="group" aria-label={t('画布控制', 'Canvas controls')}>
    <button type="button" aria-label={t('缩小画布', 'Zoom out')} title={t('缩小画布', 'Zoom out')} disabled={zoom <= MIN_ZOOM} onClick={() => { void zoomOut({ duration: 0 }) }}><Minus size={16} aria-hidden="true" /></button>
    <output className="topology-zoom" aria-label={t('当前缩放比例', 'Current zoom')}>{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label={t('放大画布', 'Zoom in')} title={t('放大画布', 'Zoom in')} disabled={zoom >= MAX_ZOOM} onClick={() => { void zoomIn({ duration: 0 }) }}><Plus size={16} aria-hidden="true" /></button>
    <span className="topology-controls-divider" aria-hidden="true" />
    <button type="button" title={t('显示当前筛选中的全部节点', 'Show all nodes in the current filter')} onClick={() => { void fitView(fitOptions) }}><Maximize size={15} aria-hidden="true" /><span>{t('适应全部', 'Fit all')}</span></button>
    <button type="button" title={t('清除手动位置，重新排列当前节点', 'Clear manual positions and rearrange current nodes')} onClick={onRelayout}><RotateCcw size={15} aria-hidden="true" /><span>{t('重新布局', 'Reset layout')}</span></button>
  </Panel>
}

function TopologyCanvas({ graph, selectedId, onSelect, onToggleCollapse, filterKey }: AgentTopologyProps) {
  const { t } = useI18n()
  const { snapshot: { resolvedTheme } } = useSettings()
  const ariaLabelConfig = useMemo(() => topologyAriaLabels(t), [t])
  const [nodes, setNodes] = useState<AgentFlowNode[]>([])
  const [fitRequest, setFitRequest] = useState(0)
  const [menu, setMenu] = useState<AgentMenuAnchor | null>(null)
  const [navigating, setNavigating] = useState(false)
  const [navigationError, setNavigationError] = useState<{ kind: 'connection' } | { kind: 'external'; message: string } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, XYPosition>())
  const manualPositions = useRef(new Map<string, XYPosition>())
  const automaticPositions = useRef(new Map<string, XYPosition>())
  const lastLayoutKey = useRef<string | null>(null)
  const lastFilterKey = useRef(filterKey)
  const lastVisibleCollapsed = useRef(new Map<string, boolean>())
  const hadNodes = useRef(false)
  const fittedRequest = useRef(0)
  const fitTarget = useRef<{ nodes?: { id: string }[]; minZoom?: number }>({})
  const initialized = useNodesInitialized()
  const { fitView, getNode, getViewport, setViewport } = useReactFlow<AgentFlowNode>()

  useLayoutEffect(() => {
    const filterChanged = filterKey !== lastFilterKey.current
    const structureChanged = graph.layoutKey !== lastLayoutKey.current
    const collapseChanged = graph.nodes.some(node => {
      const previous = lastVisibleCollapsed.current.get(node.agent.id)
      return previous !== undefined && previous !== node.collapsed
    })
    const preservePositions = !structureChanged || filterChanged || collapseChanged
    lastVisibleCollapsed.current = new Map(graph.nodes.map(node => [node.agent.id, node.collapsed]))
    if (structureChanged) automaticPositions.current = layoutAgentTopology(graph)
    lastLayoutKey.current = graph.layoutKey
    lastFilterKey.current = filterKey

    setNodes(current => {
      const previous = new Map(current.map(node => [node.id, node]))
      return graph.nodes.map(topologyNode => {
        const id = topologyNode.agent.id
        const existing = previous.get(id)
        const position = manualPositions.current.get(id)
          ?? (preservePositions ? positions.current.get(id) : undefined)
          ?? automaticPositions.current.get(id)!
        positions.current.set(id, position)
        return {
          ...existing,
          id,
          type: 'agent',
          position,
          width: AGENT_NODE_WIDTH,
          height: AGENT_NODE_HEIGHT,
          selected: id === selectedId,
          deletable: false,
          connectable: false,
          data: { ...topologyNode, collapseDisabled: filterKey !== UNFILTERED, onToggleCollapse }
        }
      })
    })
    if (filterChanged || (!hadNodes.current && graph.nodes.length > 0)) {
      fitTarget.current = !hadNodes.current && filterKey === UNFILTERED
        ? { nodes: initialFocusNodes(graph), minZoom: 0.65 }
        : {}
      setFitRequest(request => request + 1)
    }
    if (graph.nodes.length > 0) hadNodes.current = true
  }, [graph, selectedId, filterKey, onToggleCollapse])

  const localizedNodes = useMemo(() => nodes.map(node => {
    const { agent, contextOnly, issue } = node.data
    return {
      ...node,
      ariaLabel: `${agent.summary || agent.name}, ${agent.kind === 'main' ? t('主 Agent', 'Main agent') : t('子代理', 'Subagent')}, PID ${agent.pid}${contextOnly ? t('，关联上下文', ', related context') : ''}${issue ? `, ${topologyIssue(issue, t)}` : ''}`,
      domAttributes: { 'aria-roledescription': t('Agent 节点', 'Agent node') }
    }
  }), [nodes, t])

  useEffect(() => {
    if (!initialized || fitRequest === fittedRequest.current) return
    fittedRequest.current = fitRequest
    void fitView({ ...fitOptions, ...fitTarget.current })
  }, [initialized, fitRequest, fitView])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selectedId) return

    function revealSelection() {
      const node = getNode(selectedId!)
      if (!node || !canvas) return
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
      const dx = displacement(left, AGENT_NODE_WIDTH * viewport.zoom, width)
      const dy = displacement(top, AGENT_NODE_HEIGHT * viewport.zoom, height)
      if (dx || dy) void setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, { duration: 0 })
    }

    revealSelection()
    const observer = new ResizeObserver(revealSelection)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [selectedId, getNode, getViewport, setViewport])

  const onNodesChange = useCallback((changes: NodeChange<AgentFlowNode>[]) => {
    const localChanges = changes.filter(change => change.type === 'position' || change.type === 'dimensions')
    for (const change of localChanges) {
      if (change.type === 'position' && change.position) {
        positions.current.set(change.id, change.position)
        manualPositions.current.set(change.id, change.position)
      }
    }
    if (localChanges.length) setNodes(current => applyNodeChanges(localChanges, current))
  }, [])

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

  function relayout() {
    manualPositions.current.clear()
    positions.current.clear()
    automaticPositions.current = layoutAgentTopology(graph)
    setNodes(current => current.map(node => {
      const position = automaticPositions.current.get(node.id)!
      positions.current.set(node.id, position)
      return { ...node, position }
    }))
    fitTarget.current = {}
    setFitRequest(request => request + 1)
  }

  function closeMenu(restoreFocus = true) {
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
      if (error) setNavigationError({ kind: 'external', message: error })
    } catch (error) {
      setNavigationError({ kind: 'external', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setNavigating(false)
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

  return <div ref={canvasRef} className="topology-canvas" role="region" aria-label={t('Agent 拓扑画布', 'Agent topology canvas')} onKeyDownCapture={openWithKeyboard}>
    <ReactFlow<AgentFlowNode>
      nodes={localizedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onlyRenderVisibleElements
      onNodesChange={onNodesChange}
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
      {graph.nodes.length > 0 && <Panel position="top-left" className="topology-pan-hint">{t('拖动空白平移，查看其他分支', 'Drag empty space to pan and see other branches')}</Panel>}
      {graph.nodes.length > 0 && <CanvasControls onRelayout={relayout} />}
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
