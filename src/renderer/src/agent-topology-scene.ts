import {
  Box3, BufferAttribute, BufferGeometry, Color, ConeGeometry, DirectionalLight, DynamicDrawUsage,
  HemisphereLight, InstancedMesh, LineBasicMaterial, LineSegments, MeshBasicMaterial, MeshPhongMaterial,
  Object3D, PerspectiveCamera, Plane, Raycaster, Scene, SphereGeometry, TorusGeometry, Vector2, Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { TopologyGraph, TopologyNode } from './agent-topology'
import {
  agentOrbitLimits, agentPositionsOverlap, MAX_3D_EDGES, MAX_3D_NODES, pickAgentOnRay,
  PLANET_RADIUS, planGalaxyPlacement, restoreTaskPositions, saveManualGalaxyPosition, STAR_RADIUS,
  type Galaxy, type GalaxyLayout, type GalaxyPlacement, type Point3D, type TaskOrbit,
} from './agent-topology-3d-layout'
import { AgentGlows, GalaxyBackdrop, galaxyColor } from './agent-galaxy-geometry'
import { isDesktopDocumentVisible, isHeadlessDesktop, scheduleDesktopUpdate, type DesktopUpdate } from './desktop-visibility'

export interface Topology3DSession {
  // Manual positions are relative to the task center, so project repacking preserves them.
  positions: Map<string, Point3D>
  taskByAgent: Map<string, string>
  taskId: string | null
  placements?: Map<string, GalaxyPlacement>
  camera?: { position: [number, number, number]; target: [number, number, number] }
  cameraGalaxyId?: string
}
interface Callbacks {
  select(id: string): void
  task(id: string): void
  error(message: string): void
  placementConflict(message: string | null): void
  notice(message: string | null): void
  ready(): void
}
type Translate = (zh: string, en: string) => string
type LabelBox = { x: number; y: number; w: number; h: number }
type LabelPoint = { x: number; y: number; depth: number; pixelsPerUnit: number }
interface LineBuffer {
  mesh: LineSegments<BufferGeometry, LineBasicMaterial>
  positions: BufferAttribute
  colors: BufferAttribute
}

const LABEL_LIMIT = 32
const GROUP_LABEL_LIMIT = 16
const PIXEL_BUDGET = 4_000_000
const SYSTEM_Y = 28
const ORBIT_SEGMENTS = 48
const EDGE_SEGMENTS = 8
const TAU = Math.PI * 2
const NIGHT = new Color('#040712')
const WARM = new Color('#fff1d6')
const ACTIVE = new Color('#a3fff0')
const UNKNOWN = new Color('#f6a878')
const SELECTED = new Color('#ffffff')
const RING_POINTS = Array.from({ length: ORBIT_SEGMENTS + 1 }, (_, index) => {
  const angle = index / ORBIT_SEGMENTS * TAU
  return [Math.cos(angle), Math.sin(angle)] as const
})

function lineBuffer(vertices: number, opacity: number): LineBuffer {
  const geometry = new BufferGeometry()
  const positions = new BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(DynamicDrawUsage)
  const colors = new BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(DynamicDrawUsage)
  geometry.setAttribute('position', positions)
  geometry.setAttribute('color', colors)
  geometry.setDrawRange(0, 0)
  const mesh = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }))
  mesh.frustumCulled = false
  return { mesh, positions, colors }
}

function syncLines(lines: LineBuffer, count: number): void {
  lines.mesh.geometry.setDrawRange(0, count)
  lines.positions.needsUpdate = true
  lines.colors.needsUpdate = true
}

/** One bounded GPU scene. Camera, labels and geometry redraw only on demand. */
export class TopologyScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(45, 1, 1, 1_000_000)
  private readonly controls: OrbitControls
  private readonly backdrop: GalaxyBackdrop
  private readonly glows: AgentGlows
  private readonly sphere = new SphereGeometry(1, 16, 10)
  private readonly stars = new InstancedMesh(this.sphere, new MeshPhongMaterial({ emissive: '#ff913c', emissiveIntensity: 0.55, shininess: 8 }), MAX_3D_NODES)
  private readonly planets = new InstancedMesh(this.sphere, new MeshPhongMaterial({ shininess: 12, specular: '#435472' }), MAX_3D_NODES)
  private readonly arrows = new InstancedMesh(new ConeGeometry(5.5, 18, 7), new MeshBasicMaterial(), MAX_3D_EDGES)
  private readonly markers = new InstancedMesh(new TorusGeometry(1, 0.022, 5, 32).rotateX(Math.PI / 2), new MeshBasicMaterial(), 2)
  private readonly meshes = [this.stars, this.planets, this.arrows, this.markers]
  private readonly lines = lineBuffer(MAX_3D_EDGES * EDGE_SEGMENTS * 2, 0.84)
  private readonly orbits = lineBuffer(MAX_3D_NODES * ORBIT_SEGMENTS * 2, 0.58)
  private readonly transform = new Object3D()
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly point = new Vector3()
  private readonly edgeStart = new Vector3()
  private readonly edgeEnd = new Vector3()
  private readonly direction = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly dragPlane = new Plane()
  private readonly orbitPlane = new Plane(this.up, -1)
  private readonly dragOffset = new Vector3()
  private readonly tint = new Color()
  private readonly labels: HTMLButtonElement[] = []
  private readonly groupLabels: HTMLButtonElement[] = []
  private galaxies: Galaxy[] = []
  private galaxyById = new Map<string, Galaxy>()
  private taskById = new Map<string, TaskOrbit>()
  private taskForNode = new Map<string, TaskOrbit>()
  private positions = new Map<string, Point3D>()
  private tasks: TaskOrbit[] = []
  private readonly observer: ResizeObserver
  private readonly intersection: IntersectionObserver
  private graph: TopologyGraph | null = null
  private byId = new Map<string, TopologyNode>()
  private lastUpdate?: Parameters<TopologyScene['update']>
  private collisionTasks = new Map<string, TaskOrbit>()
  private selected: string | null = null
  private hovered: string | null = null
  private evidenceCurrent = true
  private t: Translate = zh => zh
  private pendingUpdate: DesktopUpdate | null = null
  private visible = true
  private disposed = false
  private failed = false
  private width = 1
  private height = 1
  private pixelRatio = 0
  private pointerStart: { x: number; y: number; id: string | null; taskId: string | null; pointerId: number } | null = null
  private dragged = false

  constructor(private readonly host: HTMLElement, private readonly session: Topology3DSession, private readonly callbacks: Callbacks) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' })
    this.renderer.setClearColor(NIGHT)
    this.renderer.debug.onShaderError = (context, program, vertex, fragment) => {
      const detail = [context.getProgramInfoLog(program), context.getShaderInfoLog(vertex), context.getShaderInfoLog(fragment)].filter(Boolean).join('\n')
      throw new Error(this.t('无法初始化 3D 星系。', 'Could not initialize the 3D galaxies.') + (detail ? `\n${detail}` : ''))
    }
    const canvas = this.renderer.domElement
    canvas.className = 'topology-3d-webgl'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'group')
    host.append(canvas)
    this.backdrop = new GalaxyBackdrop(this.scene)
    this.glows = new AgentGlows(this.scene)
    for (const mesh of this.meshes) {
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      this.scene.add(mesh)
    }
    const light = new DirectionalLight(0xf5edff, 2.2)
    light.position.set(-2, 4, 3)
    this.scene.add(this.lines.mesh, this.orbits.mesh, light, new HemisphereLight(0xb6d8ff, 0x523967, 1.15))
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = false
    this.controls.minDistance = 60
    this.controls.maxDistance = 600_000
    this.controls.maxPolarAngle = Math.PI - 0.05
    this.controls.minPolarAngle = 0.05
    this.controls.listenToKeyEvents(canvas)
    this.controls.addEventListener('change', this.invalidate)
    if (session.camera) {
      this.camera.position.fromArray(session.camera.position)
      this.controls.target.fromArray(session.camera.target)
    } else {
      this.camera.position.set(280, 560, 460)
    }
    this.controls.update()
    for (let index = 0; index < LABEL_LIMIT; index++) {
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'topology-3d-label'
      label.hidden = true
      label.append(document.createElement('strong'), document.createElement('small'))
      label.addEventListener('click', () => { if (label.dataset.id) this.selectAgent(label.dataset.id) })
      host.append(label)
      this.labels.push(label)
    }
    for (let index = 0; index < GROUP_LABEL_LIMIT; index++) {
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'topology-3d-task-label'
      label.hidden = true
      label.addEventListener('click', () => {
        const galaxy = this.galaxyById.get(label.dataset.galaxyId ?? '')
        if (galaxy) this.fitBounds(this.galaxyBounds(galaxy), false, galaxy.id)
        else if (label.dataset.taskId) this.callbacks.task(label.dataset.taskId)
      })
      host.append(label)
      this.groupLabels.push(label)
    }
    // Capture runs before OrbitControls so dragging an agent cannot orbit the camera.
    canvas.addEventListener('pointerdown', this.pointerDown, true)
    canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp)
    canvas.addEventListener('pointercancel', this.pointerCancel)
    canvas.addEventListener('lostpointercapture', this.pointerCancel)
    canvas.addEventListener('pointerleave', this.pointerLeave)
    canvas.addEventListener('keydown', this.keyDown)
    canvas.addEventListener('webglcontextlost', this.contextLost)
    document.addEventListener('visibilitychange', this.visibilityChange)
    window.addEventListener('resize', this.resize)
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(host)
    this.intersection = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting
      if (!this.visible && !isHeadlessDesktop()) this.cancelUpdate()
      else this.invalidate()
    })
    this.intersection.observe(host)
    this.resize()
  }

  update(graph: TopologyGraph, selected: string | null, liveIds: ReadonlySet<string>, t: Translate, evidenceCurrent: boolean,
    layout: GalaxyLayout, full: GalaxyLayout | null): boolean {
    this.lastUpdate = [graph, selected, liveIds, t, evidenceCurrent, layout, full]
    const priorPlacements = this.session.placements
    const plan = planGalaxyPlacement(layout.galaxies, full?.galaxies ?? null, priorPlacements ?? new Map())
    if ('conflict' in plan) {
      this.pointerCancel()
      this.callbacks.placementConflict(t(`项目「${plan.conflict.name}」需要的空间与已保留的位置重叠。请缩小筛选范围或重新布局。`,
        `Project “${plan.conflict.name}” needs space reserved by another project. Narrow the filters or reset the layout.`))
      return false
    }
    this.callbacks.placementConflict(null)
    this.session.placements = plan.placements
    if (plan.evicted) this.callbacks.notice(t('项目位置缓存已满，最久未显示的项目将在下次显示时重新排列。',
      'The project position cache is full. The least recently shown projects will be placed again when displayed.'))
    if (plan.relocated) {
      this.callbacks.notice(t('需要更多任务空间的星系已调整位置。', 'Galaxies that need more room for tasks have moved.'))
      const id = this.session.cameraGalaxyId
      const before = id && priorPlacements?.get(id)
      const after = id && plan.placements.get(id)
      if (before && after && (before.x !== after.x || before.z !== after.z)) {
        this.point.set(after.x - before.x, 0, after.z - before.z)
        this.camera.position.add(this.point)
        this.controls.target.add(this.point)
        this.controls.update()
        this.session.camera = { position: this.camera.position.toArray(), target: this.controls.target.toArray() }
      }
    }
    const grabbedId = this.pointerStart?.id
    const previousTask = grabbedId ? this.taskForNode.get(grabbedId) : undefined
    this.graph = graph
    this.byId = new Map(graph.nodes.map(node => [node.agent.id, node]))
    this.galaxies = layout.galaxies.map(galaxy => {
      const { x, z } = plan.placements.get(galaxy.id)!
      return { ...galaxy, x, z }
    })
    this.galaxyById = new Map(this.galaxies.map(galaxy => [galaxy.id, galaxy]))
    this.tasks = layout.tasks
    this.taskById = new Map(this.tasks.map(task => [task.id, task]))
    this.taskForNode = new Map([...layout.taskByAgent].map(([id, taskId]) => [id, this.taskById.get(taskId)!]))
    const source = full ?? layout
    this.collisionTasks = new Map(source.tasks.map(task => [task.id, task]))
    this.positions = new Map(source.positions)
    if (grabbedId && previousTask) {
      const currentTask = this.taskForNode.get(grabbedId)
      const before = priorPlacements?.get(previousTask.galaxyId)
      const after = currentTask && plan.placements.get(currentTask.galaxyId)
      if (currentTask?.id !== previousTask.id || !before || !after ||
        before.x + previousTask.x !== after.x + currentTask.x || before.z + previousTask.z !== after.z + currentTask.z) this.pointerCancel()
    }
    if (this.hovered && !this.byId.has(this.hovered)) {
      this.hovered = null
      this.renderer.domElement.style.cursor = ''
    }
    this.selected = selected
    this.t = t
    this.evidenceCurrent = evidenceCurrent

    for (const [id, priorTask] of this.session.taskByAgent) {
      const taskId = source.taskByAgent.get(id)
      if (!liveIds.has(id) || (full && taskId !== undefined && taskId !== priorTask)) {
        this.session.taskByAgent.delete(id)
        this.session.positions.delete(id)
      }
    }
    if (this.session.positions.size) {
      for (const task of source.tasks) restoreTaskPositions(task, this.positions, this.session.positions, this.session.taskByAgent)
    }
    const slots = new Map(this.galaxies.map(galaxy => [galaxy.id, plan.placements.get(galaxy.id)!.slot]))
    this.backdrop.update(this.galaxies, slots)
    this.backdrop.select(this.activeTask()?.galaxyId)
    this.renderer.domElement.setAttribute('aria-label', t(
      '项目星系图。星系包含任务系统，恒星代表主 Agent，行星代表其他 Agent。方向键平移，Shift 加方向键旋转，F 显示全部项目，加号或减号缩放。',
      'Project galaxies contain task systems. A sun represents a main agent and planets represent other agents. Arrow keys pan, Shift plus arrows orbits, F fits all projects, and plus or minus zooms.'
    ))
    this.syncGeometry()
    this.syncOrbits()
    if (!this.session.camera && graph.nodes.length) this.fit()
    this.invalidate()
    return true
  }

  private taskPosition(task: TaskOrbit, target: Vector3): Vector3 {
    const galaxy = this.galaxyById.get(task.galaxyId)!
    return target.set(galaxy.x + task.x, SYSTEM_Y, galaxy.z + task.z)
  }

  private positionOverlaps(id: string, task: TaskOrbit, point: Point3D): boolean {
    for (const neighbor of this.collisionTasks.get(task.id)!.nodeIds) {
      if (neighbor !== id && agentPositionsOverlap(task, id, point, neighbor, this.positions.get(neighbor)!)) return true
    }
    // An oversized source supplies only this projection. Preserve hidden agents' known manual seats too.
    for (const [neighbor, other] of this.session.positions) {
      if (!this.positions.has(neighbor) && this.session.taskByAgent.get(neighbor) === task.id
        && agentPositionsOverlap(task, id, point, neighbor, other)) return true
    }
    return false
  }

  private worldPosition(id: string, target: Vector3): Vector3 {
    const task = this.taskForNode.get(id)!
    const p = this.positions.get(id)!
    this.taskPosition(task, target)
    return target.set(target.x + p.x, target.y + p.y, target.z + p.z)
  }

  private activeTask(): TaskOrbit | undefined {
    return this.taskById.get(this.session.taskId ?? '')
  }

  selectTask(id: string | null): void {
    if (this.session.taskId === id) return
    this.session.taskId = id
    this.backdrop.select(this.activeTask()?.galaxyId)
    this.syncGeometry()
    this.syncOrbits()
    this.invalidate()
  }

  focusTask(id: string): void {
    const task = this.taskById.get(id)
    if (task) this.fitBounds(this.taskBounds(task), false, task.galaxyId)
  }

  private selectAgent(id: string): void {
    const task = this.taskForNode.get(id)
    if (!task) return
    this.callbacks.task(task.id)
    this.callbacks.select(id)
  }

  private agentRadius(id: string): number {
    return this.taskForNode.get(id)?.mainAgentId === id ? STAR_RADIUS : PLANET_RADIUS
  }

  private taskColor(task: TaskOrbit, target: Color): Color {
    return task.unresolved ? target.copy(UNKNOWN) : galaxyColor(this.session.placements!.get(task.galaxyId)!.slot, target)
  }

  private syncGeometry(): void {
    if (!this.graph) return
    const active = this.activeTask()
    let starCount = 0, planetCount = 0, glowCount = 0
    for (const node of this.graph.nodes) {
      const id = node.agent.id
      const task = this.taskForNode.get(id)!
      const main = task.mainAgentId === id
      const muted = !!active && active !== task
      const selected = id === this.selected
      const radius = this.agentRadius(id)
      const color = this.taskColor(task, this.tint)
      if (main) color.lerp(WARM, 0.77)
      if (this.evidenceCurrent && node.agent.state === 'working') color.lerp(ACTIVE, main ? 0.16 : 0.28)
      if (selected) color.lerp(SELECTED, 0.6)
      if (muted || node.contextOnly || !this.evidenceCurrent) color.multiplyScalar(muted ? 0.22 : 0.58)
      const mesh = main ? this.stars : this.planets
      const instance = main ? starCount++ : planetCount++
      const p = this.worldPosition(id, this.point)
      this.transform.position.copy(p)
      this.transform.scale.setScalar(radius)
      this.transform.quaternion.identity()
      this.transform.updateMatrix()
      mesh.setMatrixAt(instance, this.transform.matrix)
      mesh.setColorAt(instance, color)
      if (main || selected) this.glows.write(glowCount++, p, color, radius * (main ? 4.8 : 4.4), muted ? 0.19 : 0.86)
    }
    this.stars.count = starCount
    this.planets.count = planetCount
    this.syncMarkers()
    this.glows.finish(glowCount)
    this.syncEdges(active)
    for (const mesh of [this.stars, this.planets, this.arrows]) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  private syncMarkers(): void {
    let count = 0
    for (const id of [this.selected, this.hovered]) {
      if (!id || (count > 0 && id === this.selected)) continue
      const task = this.taskForNode.get(id)
      if (!task) continue
      this.worldPosition(id, this.transform.position)
      this.transform.scale.setScalar(this.agentRadius(id) * 1.44)
      this.transform.quaternion.identity()
      this.transform.updateMatrix()
      this.markers.setMatrixAt(count, this.transform.matrix)
      this.markers.setColorAt(count++, id === this.selected ? SELECTED : this.taskColor(task, this.tint))
    }
    this.markers.count = count
    this.markers.instanceMatrix.needsUpdate = true
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true
  }

  private syncEdges(active: TaskOrbit | undefined): void {
    let vertex = 0, arrow = 0
    const { positions, colors } = this.lines
    for (const { source, target } of this.graph!.edges) {
      const task = this.taskForNode.get(source)!
      const muted = !!active && active !== task
      const highlighted = this.selected === source || this.selected === target
      const color = this.taskColor(task, this.tint).lerp(SELECTED, highlighted ? 0.5 : 0.02)
      color.multiplyScalar(muted ? 0.12 : this.evidenceCurrent ? 0.66 : 0.29)
      const start = this.worldPosition(source, this.edgeStart)
      const end = this.worldPosition(target, this.edgeEnd)
      const unit = this.direction.subVectors(end, start)
      const length = unit.length()
      const loop = source === target
      const loopRadius = this.agentRadius(source) + 25
      if (!loop) {
        unit.divideScalar(length)
        const sourceInset = this.agentRadius(source) + 3
        const targetInset = this.agentRadius(target) + 7
        const scale = Math.min(1, length / (sourceInset + targetInset + 14))
        start.addScaledVector(unit, sourceInset * scale)
        end.addScaledVector(unit, -targetInset * scale)
      }
      const height = Math.min(72, length * 0.24)
      let x = 0, y = 0, z = 0
      for (let index = 0; index <= EDGE_SEGMENTS; index++) {
        const progress = index / EDGE_SEGMENTS
        const angle = 0.48 + progress * (TAU - 0.96)
        const nextX = loop ? start.x + loopRadius * (Math.cos(angle) - 1) : start.x + (end.x - start.x) * progress
        const nextY = loop ? start.y + loopRadius * Math.sin(angle) : start.y + (end.y - start.y) * progress + height * Math.sin(Math.PI * progress)
        const nextZ = loop ? start.z + (end.z - start.z) * progress + loopRadius * 0.4 : start.z + (end.z - start.z) * progress
        if (index > 0) {
          positions.setXYZ(vertex, x, y, z)
          colors.setXYZ(vertex++, color.r, color.g, color.b)
          positions.setXYZ(vertex, nextX, nextY, nextZ)
          colors.setXYZ(vertex++, color.r, color.g, color.b)
        }
        if (index === EDGE_SEGMENTS) unit.set(nextX - x, nextY - y, nextZ - z).normalize()
        x = nextX
        y = nextY
        z = nextZ
      }
      this.transform.position.set(x, y, z).addScaledVector(unit, -9)
      this.transform.scale.setScalar(1)
      this.transform.quaternion.setFromUnitVectors(this.up, unit)
      this.transform.updateMatrix()
      this.arrows.setMatrixAt(arrow, this.transform.matrix)
      this.arrows.setColorAt(arrow++, color)
    }
    this.arrows.count = arrow
    syncLines(this.lines, vertex)
  }

  private syncOrbits(): void {
    const active = this.activeTask()
    const { positions, colors } = this.orbits
    let vertex = 0
    for (const task of this.tasks) {
      const center = this.taskPosition(task, this.point)
      const color = this.taskColor(task, this.tint).multiplyScalar(active === task ? 0.83 : active ? 0.08 : 0.28)
      for (let index = 0; index < ORBIT_SEGMENTS; index++) {
        if (task.unresolved && index % 2 === 1) continue
        for (let endpoint = index; endpoint <= index + 1; endpoint++) {
          const [x, z] = RING_POINTS[endpoint]
          positions.setXYZ(vertex, center.x + x * task.radius, 1, center.z + z * task.radius)
          colors.setXYZ(vertex++, color.r, color.g, color.b)
        }
      }
    }
    syncLines(this.orbits, vertex)
  }

  private readonly resize = (): void => {
    if (this.disposed || this.failed) return
    if (!this.host.isConnected || this.host.clientWidth <= 0 || this.host.clientHeight <= 0) {
      this.cancelUpdate()
      return
    }
    this.syncSize()
    this.invalidate()
  }

  private syncSize(): void {
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (width * height)))
    if (width === this.width && height === this.height && ratio === this.pixelRatio) return
    this.width = width
    this.height = height
    this.pixelRatio = ratio
    this.renderer.setDrawingBufferSize(width, height, ratio)
    this.backdrop.resize(ratio, height)
    this.glows.resize(ratio, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private canDraw(): boolean {
    return !this.disposed && !this.failed && isDesktopDocumentVisible() && this.host.isConnected
      && this.host.clientWidth > 0 && this.host.clientHeight > 0
      && (isHeadlessDesktop() || this.visible)
  }

  private readonly invalidate = (): void => {
    if (this.pendingUpdate || !this.canDraw()) return
    this.pendingUpdate = scheduleDesktopUpdate(() => {
      this.pendingUpdate = null
      if (!this.canDraw()) return
      try {
        this.syncSize()
        this.renderer.render(this.scene, this.camera)
        this.projectLabels()
        if (this.graph?.nodes.length) this.session.camera = { position: this.camera.position.toArray(), target: this.controls.target.toArray() }
        this.callbacks.ready()
      } catch (error) {
        this.failed = true
        this.callbacks.error(error instanceof Error ? error.message : String(error))
      }
    })
  }

  private labelPoint(point: Vector3): LabelPoint {
    const viewDepth = -this.direction.copy(point).applyMatrix4(this.camera.matrixWorldInverse).z
    point.project(this.camera)
    return {
      x: (point.x + 1) * this.width / 2,
      y: (1 - point.y) * this.height / 2,
      depth: point.z,
      pixelsPerUnit: this.height * this.camera.projectionMatrix.elements[5] / (2 * Math.max(1, viewDepth)),
    }
  }

  private labelBox(boxes: LabelBox[], anchor: LabelPoint, w: number, h: number, offset: number): LabelBox | undefined {
    if (this.width < 60 || this.height < h + 8) return undefined
    const clamp = (value: number, limit: number) => Math.max(4, Math.min(limit - 4, value))
    const x = clamp(anchor.x - w / 2, this.width - w)
    for (const candidateY of [anchor.y - offset - h, anchor.y + offset]) {
      const y = clamp(candidateY, this.height - h)
      const overlaps = boxes.some(box => x < box.x + box.w + 6 && x + w + 6 > box.x && y < box.y + box.h + 5 && y + h + 5 > box.y)
      if (!overlaps) return { x, y, w, h }
    }
    return undefined
  }

  private hideLabels(pool: HTMLButtonElement[], used: ReadonlySet<HTMLButtonElement>): void {
    for (const label of pool) {
      if (used.has(label)) continue
      if (document.activeElement === label) this.renderer.domElement.focus({ preventScroll: true })
      label.hidden = true
    }
  }

  private projectLabels(): void {
    if (!this.graph) return
    const scale = Number(getComputedStyle(this.host).getPropertyValue('--font-scale')) || 1
    const active = this.activeTask()
    const boxes: LabelBox[] = []
    const candidates: { node: TopologyNode; task: TaskOrbit; anchor: LabelPoint; radius: number; priority: number }[] = []
    for (const node of this.graph.nodes) {
      const id = node.agent.id
      const task = this.taskForNode.get(id)!
      const anchor = this.labelPoint(this.worldPosition(id, this.point))
      if (anchor.depth <= -1 || anchor.depth >= 1 || anchor.x < 0 || anchor.x > this.width || anchor.y < 0 || anchor.y > this.height) continue
      const radius = this.agentRadius(id) * anchor.pixelsPerUnit
      const main = task.mainAgentId === id
      const selected = id === this.selected
      const hovered = id === this.hovered
      if (!selected && !hovered && radius < (main ? 17 : 12)) continue
      const priority = (active && active !== task ? 10 : 0) + (selected ? 0 : hovered ? 1 : main ? 2 : 3)
      candidates.push({ node, task, anchor, radius, priority })
    }
    candidates.sort((left, right) => left.priority - right.priority || left.anchor.depth - right.anchor.depth)
    const placed: { candidate: typeof candidates[number]; box: LabelBox }[] = []
    for (const candidate of candidates) {
      if (placed.length >= LABEL_LIMIT) break
      const box = this.labelBox(boxes, candidate.anchor, Math.min(200, this.width - 8), 34.5 * scale + 14, candidate.radius + 8)
      if (!box) continue
      boxes.push(box)
      placed.push({ candidate, box })
    }
    const wanted = new Set(placed.map(({ candidate }) => candidate.node.agent.id))
    const used = new Set<HTMLButtonElement>()
    for (const { candidate: { node, task }, box } of placed) {
      const id = node.agent.id
      const label = this.labels.find(item => item.dataset.id === id)
        ?? this.labels.find(item => !used.has(item) && !wanted.has(item.dataset.id ?? ''))!
      if (document.activeElement === label && label.dataset.id !== id) this.renderer.domElement.focus({ preventScroll: true })
      used.add(label)
      const title = (node.agent.summary || node.agent.name).slice(0, 240)
      const role = task.mainAgentId === id ? this.t('恒星 · 主 Agent', 'Sun · Main agent')
        : task.unresolved ? this.t('行星 · 待归属', 'Planet · Unassigned') : this.t('行星 · 子 Agent', 'Planet · Subagent')
      const state = node.agent.state === 'working' ? this.t('工作中', 'Working') : node.agent.state === 'idle' ? this.t('空闲', 'Idle')
        : node.agent.state === 'running' ? this.t('进程存活', 'Process alive') : this.t('状态未知', 'Unknown')
      const subtitle = `${role} · ${state}${node.contextOnly ? this.t(' · 关联', ' · Context') : ''}${node.issue ? this.t(' · 关系待确认', ' · Unconfirmed relation') : ''}`
      if (label.firstElementChild!.textContent !== title) label.firstElementChild!.textContent = title
      if (label.lastElementChild!.textContent !== subtitle) label.lastElementChild!.textContent = subtitle
      label.dataset.id = id
      label.classList.toggle('is-selected', id === this.selected)
      label.classList.toggle('is-dimmed', !!active && active !== task)
      label.title = `${title}\n${node.agent.cwd ?? ''}`.slice(0, 4096)
      label.setAttribute('aria-label', `${title}, ${subtitle}, PID ${node.agent.pid}`)
      label.setAttribute('aria-pressed', String(id === this.selected))
      label.style.transform = `translate(${box.x}px, ${box.y}px)`
      label.hidden = false
    }
    this.hideLabels(this.labels, used)
    this.projectGroupLabels(boxes, scale, active)
  }

  private projectGroupLabels(boxes: LabelBox[], scale: number, active: TaskOrbit | undefined): void {
    const candidates: { group: Galaxy | TaskOrbit; anchor: LabelPoint; offset: number; priority: number }[] = []
    for (const galaxy of this.galaxies) {
      const anchor = this.labelPoint(this.point.set(galaxy.x, SYSTEM_Y, galaxy.z))
      candidates.push({ group: galaxy, anchor, offset: Math.min(galaxy.radius * anchor.pixelsPerUnit * 0.52, this.height * 0.18), priority: galaxy.id === 'unresolved' ? 1 : 2 })
    }
    for (const task of this.tasks) {
      const anchor = this.labelPoint(this.taskPosition(task, this.point))
      const radius = task.radius * anchor.pixelsPerUnit
      if (task !== active && radius < (task.unresolved ? 100 : 144)) continue
      candidates.push({ group: task, anchor, offset: Math.min(radius * 0.52, this.height * 0.19), priority: task === active ? 0 : 3 })
    }
    candidates.sort((left, right) => left.priority - right.priority || left.anchor.depth - right.anchor.depth)
    const placed: { group: Galaxy | TaskOrbit; box: LabelBox }[] = []
    for (const { group, anchor, offset } of candidates) {
      if (placed.length >= GROUP_LABEL_LIMIT) break
      if (anchor.depth <= -1 || anchor.depth >= 1 || anchor.x < -30 || anchor.x > this.width + 30 || anchor.y < -40 || anchor.y > this.height + 40) continue
      const box = this.labelBox(boxes, anchor, Math.min(210, this.width - 8), 30 * scale + 8, offset)
      if (!box) continue
      boxes.push(box)
      placed.push({ group, box })
    }
    const wanted = new Set(placed.map(({ group }) => group.id))
    const used = new Set<HTMLButtonElement>()
    for (const { group, box } of placed) {
      const label = this.groupLabels.find(item => (item.dataset.galaxyId ?? item.dataset.taskId) === group.id)
        ?? this.groupLabels.find(item => !used.has(item) && !wanted.has(item.dataset.galaxyId ?? item.dataset.taskId ?? ''))!
      if (document.activeElement === label && (label.dataset.galaxyId ?? label.dataset.taskId) !== group.id) {
        this.renderer.domElement.focus({ preventScroll: true })
      }
      used.add(label)
      const selected = active === group
      if ('tasks' in group) {
        const name = group.id === 'unresolved' ? this.t('待归属星系', 'Unassigned galaxy')
          : group.cwd ? group.name : this.t('未识别项目星系', 'Unidentified project galaxy')
        const count = this.t(`${group.tasks.length} 个任务`, `${group.tasks.length} ${group.tasks.length === 1 ? 'task' : 'tasks'}`)
        const text = `${name} · ${count}`
        if (label.textContent !== text) label.textContent = text
        label.title = group.cwd ?? this.t('没有工作目录证据', 'No working-directory evidence')
        label.setAttribute('aria-label', this.t(`聚焦星系 ${text}`, `Focus galaxy ${text}`))
        label.removeAttribute('aria-pressed')
        label.classList.add('topology-3d-galaxy-label')
        label.classList.toggle('is-dimmed', !!active && active.galaxyId !== group.id)
        delete label.dataset.taskId
        label.dataset.galaxyId = group.id
      } else {
        const text = group.unresolved ? `${this.t('待归属', 'Unassigned')} · ${group.name}` : group.name
        if (label.textContent !== text) label.textContent = text
        label.title = `${text}\n${group.cwd ?? this.t('没有工作目录证据', 'No working-directory evidence')}`.slice(0, 4096)
        label.setAttribute('aria-label', this.t(`选择任务系统 ${text}`, `Select task system ${text}`))
        label.setAttribute('aria-pressed', String(selected))
        label.classList.remove('topology-3d-galaxy-label')
        label.classList.toggle('is-dimmed', !!active && !selected)
        delete label.dataset.galaxyId
        label.dataset.taskId = group.id
      }
      label.classList.toggle('is-selected', selected)
      label.style.transform = `translate(${box.x}px, ${box.y}px)`
      label.hidden = false
    }
    this.hideLabels(this.groupLabels, used)
  }

  private galaxyBounds(galaxy: Galaxy): Box3 {
    const radius = galaxy.radius * 1.09
    const height = Math.max(108, radius * 0.15)
    return new Box3(new Vector3(galaxy.x - radius, -height, galaxy.z - radius), new Vector3(galaxy.x + radius, height, galaxy.z + radius))
  }

  private taskBounds(task: TaskOrbit): Box3 {
    const center = this.taskPosition(task, this.point)
    const radius = task.radius + 16
    return new Box3(new Vector3(center.x - radius, -26, center.z - radius), new Vector3(center.x + radius, 110, center.z + radius))
  }

  fit(front = false, ids?: ReadonlySet<string>): void {
    if (!this.graph?.nodes.length) return
    const bounds = new Box3()
    if (ids) {
      for (const task of this.tasks) if (task.nodeIds.some(id => ids.has(id))) bounds.union(this.taskBounds(task))
    } else {
      for (const galaxy of this.galaxies) bounds.union(this.galaxyBounds(galaxy))
    }
    this.fitBounds(bounds, front)
  }

  private fitBounds(bounds: Box3, front: boolean, galaxyId?: string): void {
    if (bounds.isEmpty()) return
    this.session.cameraGalaxyId = galaxyId
    bounds.getCenter(this.controls.target)
    this.direction.set(front ? 0 : 0.32, front ? 0.12 : 1.2, 1).normalize()
    const right = new Vector3().crossVectors(this.up, this.direction).normalize()
    const viewUp = new Vector3().crossVectors(this.direction, right)
    const vertical = Math.tan(this.camera.fov * Math.PI / 360) * 0.92
    const horizontal = vertical * this.camera.aspect
    let distance = 240
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      this.point.set(x, y, z).sub(this.controls.target)
      const depth = this.point.dot(this.direction)
      distance = Math.max(distance, depth + (Math.abs(this.point.dot(right)) + 32) / horizontal, depth + (Math.abs(this.point.dot(viewUp)) + 25) / vertical)
    }
    this.camera.position.copy(this.controls.target).addScaledVector(this.direction, distance)
    this.controls.update()
    this.invalidate()
  }

  focus(id: string): void {
    const task = this.taskForNode.get(id)
    if (!task) return
    this.session.cameraGalaxyId = task.galaxyId
    this.selectTask(task.id)
    const point = this.worldPosition(id, this.point)
    this.direction.subVectors(this.camera.position, this.controls.target).normalize()
    this.controls.target.copy(point)
    this.camera.position.copy(point).addScaledVector(this.direction, 330)
    this.controls.update()
    this.invalidate()
  }

  zoom(factor: number): void {
    this.direction.subVectors(this.camera.position, this.controls.target)
    this.direction.setLength(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, this.direction.length() * factor)))
    this.camera.position.copy(this.controls.target).add(this.direction)
    this.controls.update()
    this.invalidate()
  }

  reset(): void {
    if (!this.lastUpdate) return
    this.session.positions.clear()
    this.session.taskByAgent.clear()
    this.session.placements?.clear()
    this.callbacks.notice(null)
    if (this.update(...this.lastUpdate)) this.fit()
  }

  private updateRay(event: PointerEvent): void {
    const bounds = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1)
    this.camera.updateMatrixWorld()
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  private hitAgent(): string | null {
    return pickAgentOnRay(this.raycaster.ray, this.byId.keys(), id => this.worldPosition(id, this.point),
      id => this.agentRadius(id), 8 / (this.height * this.camera.projectionMatrix.elements[5]))
  }

  private hitTask(): string | null {
    const hit = this.raycaster.ray.intersectPlane(this.orbitPlane, this.point)
    if (!hit) return null
    for (const task of this.tasks) {
      const center = this.taskPosition(task, this.edgeStart)
      if (Math.hypot(hit.x - center.x, hit.z - center.z) <= task.radius) return task.id
    }
    return null
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || event.shiftKey || event.ctrlKey || event.metaKey) return
    this.updateRay(event)
    const id = this.hitAgent()
    this.pointerStart = { x: event.clientX, y: event.clientY, id, taskId: id ? null : this.hitTask(), pointerId: event.pointerId }
    this.dragged = false
    if (!id) return
    const point = this.worldPosition(id, this.edgeStart)
    this.camera.getWorldDirection(this.direction)
    // A horizontal drag plane becomes unstable near the edge of the disk.
    if (Math.abs(this.direction.y) < 0.25) this.direction.set(this.direction.x, 0, this.direction.z).normalize()
    else this.direction.copy(this.up)
    this.dragPlane.setFromNormalAndCoplanarPoint(this.direction, point)
    const intersect = this.raycaster.ray.intersectPlane(this.dragPlane, this.point)
    if (!intersect) return
    this.dragOffset.copy(point).sub(intersect)
    this.controls.enabled = false
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.focus({ preventScroll: true })
  }

  private readonly pointerMove = (event: PointerEvent): void => {
    const start = this.pointerStart
    if (start) {
      if (start.pointerId !== event.pointerId) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) this.dragged = true
      if (start.id && this.dragged && !this.controls.enabled) this.dragAgent(start.id, event)
      return
    }
    this.updateRay(event)
    this.setHovered(this.hitAgent())
  }

  private dragAgent(id: string, event: PointerEvent): void {
    this.updateRay(event)
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.point)) return
    const task = this.taskForNode.get(id)!
    const center = this.taskPosition(task, this.edgeStart)
    this.point.add(this.dragOffset).sub(center)
    const { inner, outer } = agentOrbitLimits(id, task)
    let { x, z } = this.point
    const length = Math.hypot(x, z)
    if (length > 0) {
      const scale = Math.max(inner, Math.min(outer, length)) / length
      x *= scale
      z *= scale
    } else if (inner > 0) {
      return
    }
    const position = { x, y: this.positions.get(id)!.y, z }
    if (this.positionOverlaps(id, task, position)) return
    if (!saveManualGalaxyPosition(this.session.positions, this.session.taskByAgent, id, task.id, position)) {
      this.callbacks.notice(this.t('已保存 1200 个手动位置。重新布局后可重新移动 Agent。',
        'All 1200 manual positions are in use. Reset the layout to move another agent.'))
      return
    }
    this.positions.set(id, position)
    this.syncGeometry()
    this.invalidate()
  }

  private setHovered(id: string | null): void {
    if (id === this.hovered) return
    this.hovered = id
    this.renderer.domElement.style.cursor = id ? 'grab' : ''
    this.syncMarkers()
    this.invalidate()
  }

  private readonly pointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    if (!start || start.pointerId !== event.pointerId) return
    this.pointerCancel()
    if (this.dragged) return
    if (start.id) this.selectAgent(start.id)
    else if (start.taskId) this.callbacks.task(start.taskId)
  }

  private readonly pointerCancel = (): void => {
    const start = this.pointerStart
    this.pointerStart = null
    this.controls.enabled = true
    const canvas = this.renderer.domElement
    if (start && canvas.hasPointerCapture(start.pointerId)) canvas.releasePointerCapture(start.pointerId)
  }

  private readonly pointerLeave = (): void => {
    if (!this.pointerStart) this.setHovered(null)
  }
  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.fit() }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(0.8) }
    if (event.key === '-') { event.preventDefault(); this.zoom(1.25) }
  }
  private readonly contextLost = (event: Event): void => {
    event.preventDefault()
    this.failed = true
    this.cancelUpdate()
    this.callbacks.error(this.t('3D 图形上下文已丢失，请重试 3D 视图。', 'The 3D graphics context was lost. Retry the 3D view.'))
  }
  private readonly visibilityChange = (): void => { if (!isDesktopDocumentVisible()) this.cancelUpdate(); else this.invalidate() }
  private cancelUpdate(): void { this.pendingUpdate?.cancel(); this.pendingUpdate = null }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelUpdate()
    this.observer.disconnect()
    this.intersection.disconnect()
    document.removeEventListener('visibilitychange', this.visibilityChange)
    window.removeEventListener('resize', this.resize)
    const canvas = this.renderer.domElement
    this.pointerCancel()
    canvas.removeEventListener('pointerdown', this.pointerDown, true)
    canvas.removeEventListener('pointermove', this.pointerMove)
    canvas.removeEventListener('pointerup', this.pointerUp)
    canvas.removeEventListener('pointercancel', this.pointerCancel)
    canvas.removeEventListener('lostpointercapture', this.pointerCancel)
    canvas.removeEventListener('pointerleave', this.pointerLeave)
    canvas.removeEventListener('keydown', this.keyDown)
    canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.controls.removeEventListener('change', this.invalidate)
    this.controls.dispose()
    const geometries = new Set(this.meshes.map(mesh => mesh.geometry))
    for (const mesh of this.meshes) {
      mesh.dispose()
      mesh.material.dispose()
    }
    for (const geometry of geometries) geometry.dispose()
    for (const { mesh } of [this.lines, this.orbits]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    this.backdrop.dispose()
    this.glows.dispose()
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
    for (const label of this.labels) label.remove()
    for (const label of this.groupLabels) label.remove()
    this.galaxies = []
    this.tasks = []
    this.galaxyById.clear()
    this.taskById.clear()
    this.taskForNode.clear()
    this.positions.clear()
    this.collisionTasks.clear()
    this.lastUpdate = undefined
    this.byId.clear()
    this.graph = null
  }
}
