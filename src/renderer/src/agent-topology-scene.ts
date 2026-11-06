import {
  Box3, BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, DirectionalLight, DoubleSide,
  HemisphereLight, InstancedMesh, LineBasicMaterial, LineSegments, MeshLambertMaterial,
  Object3D, PerspectiveCamera, Plane, Raycaster, Scene, TorusGeometry, Vector2, Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { TopologyGraph, TopologyNode } from './agent-topology'
import { buildOfficeLayout, getAgentFloorId, MAX_3D_EDGES, MAX_3D_NODES, type OfficeFloor, type Point3D } from './agent-topology-3d-layout'
import { createEmployeeGeometry, createWorkstationGeometry } from './agent-office-employee'
import { createEntranceGeometry, createFacadeGeometry, createFloorFrameGeometry, createRoofGeometry } from './agent-office-building'

export interface Topology3DSession {
  positions: Map<string, Point3D>
  floorByAgent: Map<string, string>
  floorId: string | null
  camera?: { position: [number, number, number]; target: [number, number, number] }
}
interface Callbacks {
  select(id: string): void
  floor(id: string): void
  menu(id: string, x: number, y: number, trigger: HTMLElement): void
  error(message: string): void
}
type Translate = (zh: string, en: string) => string
const LABEL_LIMIT = 32
const FLOOR_LABEL_LIMIT = 16
const PIXEL_BUDGET = 4_000_000
const NODE_RADIUS = 32

function mutedMesh(source: InstancedMesh): InstancedMesh {
  const material = (source.material as MeshLambertMaterial).clone()
  material.transparent = true
  material.opacity *= 0.12
  material.depthWrite = false
  return new InstancedMesh(source.geometry, material, source.instanceMatrix.count)
}

/** One bounded GPU scene; no simulation, interval or perpetual animation loop. */
export class TopologyScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(45, 1, 1, 1_000_000)
  private readonly controls: OrbitControls
  private readonly nodes = new InstancedMesh(createEmployeeGeometry(), new MeshLambertMaterial({ vertexColors: true }), MAX_3D_NODES)
  private readonly markers = new InstancedMesh(new TorusGeometry(29, 2, 4, 20), new MeshLambertMaterial(), MAX_3D_NODES)
  private readonly desks = new InstancedMesh(createWorkstationGeometry(), new MeshLambertMaterial({ vertexColors: true }), MAX_3D_NODES)
  private readonly decks = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial(), MAX_3D_NODES)
  private readonly frames = new InstancedMesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true }), MAX_3D_NODES)
  private readonly facades = new InstancedMesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.65, depthWrite: false, side: DoubleSide }), MAX_3D_NODES)
  private readonly roof = new InstancedMesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, transparent: true }), 1)
  private readonly entrance = new InstancedMesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, transparent: true, side: DoubleSide }), 1)
  private buildingWidth = 0
  private buildingDepth = 0
  private readonly floorPaint = new Color('#d9d6cc')
  private readonly white = new Color(0xffffff)
  private readonly arrows = new InstancedMesh(new ConeGeometry(7, 20, 8), new MeshLambertMaterial(), MAX_3D_EDGES)
  private readonly mutedNodes = mutedMesh(this.nodes)
  private readonly mutedMarkers = mutedMesh(this.markers)
  private readonly mutedDesks = mutedMesh(this.desks)
  private readonly mutedDecks = mutedMesh(this.decks)
  private readonly mutedFrames = mutedMesh(this.frames)
  private readonly mutedFacades = mutedMesh(this.facades)
  private readonly mutedArrows = mutedMesh(this.arrows)
  private readonly meshes = [this.nodes, this.markers, this.desks, this.decks, this.frames, this.facades, this.roof, this.entrance, this.arrows, this.mutedNodes, this.mutedMarkers, this.mutedDesks, this.mutedDecks, this.mutedFrames, this.mutedFacades, this.mutedArrows]
  private readonly nodeSlots: string[] = []
  private readonly mutedNodeSlots: string[] = []
  private readonly floorSlots: string[] = []
  private readonly mutedFloorSlots: string[] = []
  private readonly edgePositions = new BufferAttribute(new Float32Array(MAX_3D_EDGES * 12 * 6), 3)
  private readonly edgeColors = new BufferAttribute(new Float32Array(MAX_3D_EDGES * 12 * 6), 3)
  private readonly lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true }))
  private readonly mutedLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.12, depthWrite: false }))
  private readonly transform = new Object3D()
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly point = new Vector3()
  private readonly direction = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly dragPlane = new Plane()
  private readonly dragOffset = new Vector3()
  private readonly labels: HTMLButtonElement[] = []
  private readonly floorLabels: HTMLButtonElement[] = []
  private floors: OfficeFloor[] = []
  private readonly tint = new Color()
  private readonly observer: ResizeObserver
  private readonly intersection: IntersectionObserver
  private graph: TopologyGraph | null = null
  private byId = new Map<string, TopologyNode>()
  private selected: string | null = null
  private hovered: string | null = null
  private evidenceCurrent = true
  private t: Translate = zh => zh
  private frame = 0
  private visible = true
  private disposed = false
  private failed = false
  private width = 1
  private height = 1
  private pointerStart: { x: number; y: number; id: string | null; floorId: string | null; pointerId: number } | null = null
  private dragged = false
  private colors = { node: new Color(), active: new Color(), edge: new Color(), warning: new Color(), context: new Color(), ground: new Color(), surface: new Color() }

  constructor(private readonly host: HTMLElement, private readonly session: Topology3DSession, private readonly callbacks: Callbacks) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' })
    const canvas = this.renderer.domElement
    canvas.className = 'topology-3d-webgl'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'group')
    host.append(canvas)
    for (const mesh of this.meshes) { mesh.count = 0; mesh.frustumCulled = false; this.scene.add(mesh) }
    for (const lines of [this.lines, this.mutedLines]) {
      lines.frustumCulled = false
      lines.geometry.setAttribute('position', this.edgePositions)
      lines.geometry.setAttribute('color', this.edgeColors)
      lines.geometry.setDrawRange(0, 0)
    }
    const light = new DirectionalLight(0xffffff, 1.6)
    light.position.set(1, 2, 3)
    this.scene.add(this.lines, this.mutedLines, light, new HemisphereLight(0xffffff, 0x53677d, 1.5))
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
      this.controls.update()
    }
    for (let i = 0; i < LABEL_LIMIT; i++) {
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'topology-3d-label'
      label.hidden = true
      label.append(document.createElement('strong'), document.createElement('small'))
      label.addEventListener('click', () => {
        if (label.dataset.id) this.selectAgent(label.dataset.id)
      })
      label.addEventListener('contextmenu', event => {
        if (!label.dataset.id || this.byId.get(label.dataset.id)?.agent.runtime !== 'OMP') return
        event.preventDefault()
        label.focus({ preventScroll: true })
        this.callbacks.menu(label.dataset.id, event.clientX, event.clientY, label)
      })
      label.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        if (!label.dataset.id || this.byId.get(label.dataset.id)?.agent.runtime !== 'OMP') return
        event.preventDefault()
        const box = label.getBoundingClientRect()
        this.callbacks.menu(label.dataset.id, box.left, box.bottom, label)
      })
      host.append(label)
      this.labels.push(label)
    }
    for (let i = 0; i < FLOOR_LABEL_LIMIT; i++) {
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'topology-3d-floor-label'
      label.hidden = true
      label.addEventListener('click', () => { if (label.dataset.floorId) this.callbacks.floor(label.dataset.floorId) })
      host.append(label)
      this.floorLabels.push(label)
    }
    // Capture runs before OrbitControls: dragging a node must not also orbit the camera.
    canvas.addEventListener('pointerdown', this.pointerDown, true)
    canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp)
    canvas.addEventListener('pointercancel', this.pointerCancel)
    canvas.addEventListener('lostpointercapture', this.pointerCancel)
    canvas.addEventListener('contextmenu', this.contextMenu)
    canvas.addEventListener('keydown', this.keyDown)
    canvas.addEventListener('webglcontextlost', this.contextLost)
    document.addEventListener('visibilitychange', this.visibilityChange)
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(host)
    this.intersection = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting
      if (!this.visible) this.cancelFrame()
      else this.invalidate()
    })
    this.intersection.observe(host)
    this.resize()
  }

  update(graph: TopologyGraph, selected: string | null, liveIds: ReadonlySet<string>, t: Translate, evidenceCurrent: boolean): void {
    const layout = buildOfficeLayout(graph)
    this.graph = graph
    this.byId = new Map(graph.nodes.map(node => [node.agent.id, node]))
    if (this.pointerStart?.id && !this.byId.has(this.pointerStart.id)) this.pointerCancel()
    this.floors = layout.floors
    this.selected = selected
    this.t = t
    this.evidenceCurrent = evidenceCurrent
    for (const id of this.session.positions.keys()) {
      const node = this.byId.get(id)
      if (!liveIds.has(id) || (node && this.session.floorByAgent.get(id) !== getAgentFloorId(node.agent))) {
        this.session.positions.delete(id)
        this.session.floorByAgent.delete(id)
      }
    }
    const occupied = new Set<string>()
    const cell = (id: string, p: Point3D) => `${id}:${Math.round(p.x / 140)}:${Math.round(p.z / 140)}`
    for (const floor of this.floors) for (const id of floor.nodeIds) {
      const p = this.session.positions.get(id)
      if (p) { p.y = floor.y + 40; occupied.add(cell(floor.id, p)) }
    }
    for (const floor of this.floors) for (const id of floor.nodeIds) {
      if (this.session.positions.has(id)) continue
      if (this.session.positions.size >= MAX_3D_NODES) {
        for (const cached of this.session.positions.keys()) if (!this.byId.has(cached)) {
          this.session.positions.delete(cached)
          this.session.floorByAgent.delete(cached)
          break
        }
      }
      const p = layout.positions.get(id)!
      while (occupied.has(cell(floor.id, p))) p.x += 140
      occupied.add(cell(floor.id, p))
      this.session.positions.set(id, p)
      this.session.floorByAgent.set(id, floor.id)
    }
    // Retained workstations remain on their floor, including after filters and new arrivals.
    let width = this.floors[0]?.width ?? 0
    let depth = this.floors[0]?.depth ?? 0
    for (const node of graph.nodes) {
      const p = this.session.positions.get(node.agent.id)!
      width = Math.max(width, (Math.abs(p.x) + 110) * 2)
      depth = Math.max(depth, (Math.abs(p.z) + 90) * 2)
    }
    for (const floor of this.floors) { floor.width = width; floor.depth = depth }
    const style = getComputedStyle(this.host)
    this.colors.ground.set(style.getPropertyValue('--ground').trim())
    this.colors.surface.set(style.getPropertyValue('--surface').trim())
    this.renderer.setClearColor(this.colors.ground)
    this.colors.node.set(style.getPropertyValue('--blue').trim())
    this.colors.active.set(style.getPropertyValue('--accent').trim())
    this.colors.edge.set(style.getPropertyValue('--edge').trim())
    this.colors.warning.set(style.getPropertyValue('--warning').trim())
    this.colors.context.set(style.getPropertyValue('--muted').trim())
    this.renderer.domElement.setAttribute('aria-label', t('工程办公楼。选择楼层淡化其他层；方向键平移，Shift 加方向键旋转，F 显示全楼。上方菜单可定位任意员工。', 'Project office. Select a floor to dim other floors. Arrow keys pan, Shift plus arrows orbit, F fits the building. Use the picker above to locate any employee.'))
    this.syncGeometry()
    if (!this.session.camera && graph.nodes.length) this.fit()
    this.invalidate()
  }

  private isMuted(floorId: string): boolean {
    return this.session.floorId !== null && this.session.floorId !== floorId
  }

  selectFloor(id: string | null): void {
    if (this.session.floorId === id) return
    this.session.floorId = id
    this.syncGeometry()
    this.invalidate()
  }

  focusFloor(id: string): void {
    const floor = this.floors.find(floor => floor.id === id)
    if (floor) this.fit(false, new Set(floor.nodeIds))
  }

  private selectAgent(id: string): void {
    const node = this.byId.get(id)
    if (!node) return
    this.callbacks.floor(getAgentFloorId(node.agent))
    this.callbacks.select(id)
  }

  private updateBuildingGeometry(width: number, depth: number): void {
    if (width === this.buildingWidth && depth === this.buildingDepth) return
    const replacements: [InstancedMesh, InstancedMesh | null, BufferGeometry][] = [
      [this.frames, this.mutedFrames, createFloorFrameGeometry(width, depth)],
      [this.facades, this.mutedFacades, createFacadeGeometry(width, depth)],
      [this.roof, null, createRoofGeometry(width, depth)],
      [this.entrance, null, createEntranceGeometry(width, depth)],
    ]
    for (const [mesh, muted, geometry] of replacements) {
      mesh.geometry.dispose()
      mesh.geometry = geometry
      if (muted) muted.geometry = geometry
    }
    this.buildingWidth = width
    this.buildingDepth = depth
  }

  private syncGeometry(): void {
    if (!this.graph) return
    for (const mesh of this.meshes) mesh.count = 0
    this.nodeSlots.length = this.mutedNodeSlots.length = this.floorSlots.length = this.mutedFloorSlots.length = 0
    this.transform.quaternion.identity()
    if (this.floors.length) this.updateBuildingGeometry(this.floors[0].width, this.floors[0].depth)
    this.facades.material.opacity = this.session.floorId === null ? 0.65 : 0.08
    for (const floor of this.floors) {
      const muted = this.isMuted(floor.id)
      const mesh = muted ? this.mutedDecks : this.decks
      const slots = muted ? this.mutedFloorSlots : this.floorSlots
      const index = mesh.count++
      slots.push(floor.id)
      this.transform.position.set(0, floor.y - 4, 0)
      this.transform.scale.set(floor.width, 8, floor.depth)
      this.transform.updateMatrix()
      mesh.setMatrixAt(index, this.transform.matrix)
      mesh.setColorAt(index, this.session.floorId === floor.id ? this.tint.copy(this.floorPaint).lerp(this.colors.active, 0.1) : this.floorPaint)
      this.transform.position.set(0, floor.y, 0)
      this.transform.scale.setScalar(1)
      this.transform.updateMatrix()
      for (const part of muted ? [this.mutedFrames, this.mutedFacades] : [this.frames, this.facades]) {
        part.setMatrixAt(index, this.transform.matrix)
        part.count++
      }
    }
    if (this.floors.length) {
      const first = this.floors[0], last = this.floors[this.floors.length - 1]
      this.roof.count = this.entrance.count = 1
      this.transform.position.set(0, last.y + 240, 0)
      this.transform.scale.setScalar(1)
      this.transform.updateMatrix()
      this.roof.setMatrixAt(0, this.transform.matrix)
      this.roof.material.opacity = this.session.floorId === null ? 1 : 0.05
      this.roof.material.depthWrite = this.session.floorId === null
      this.transform.position.set(0, first.y, 0)
      this.transform.updateMatrix()
      this.entrance.setMatrixAt(0, this.transform.matrix)
      this.entrance.material.opacity = this.isMuted(first.id) ? 0.12 : 1
      this.entrance.material.depthWrite = !this.isMuted(first.id)
    }
    for (const node of this.graph.nodes) {
      const muted = this.isMuted(getAgentFloorId(node.agent))
      const body = muted ? this.mutedNodes : this.nodes
      const markers = muted ? this.mutedMarkers : this.markers
      const desks = muted ? this.mutedDesks : this.desks
      const slots = muted ? this.mutedNodeSlots : this.nodeSlots
      const index = body.count++
      markers.count = desks.count = body.count
      slots.push(node.agent.id)
      const p = this.session.positions.get(node.agent.id)!
      const size = node.agent.id === this.selected ? 1.08 : 1
      const facing = node.agent.id.charCodeAt(node.agent.id.length - 1) % 2 === 0 ? Math.PI : 0
      const color = node.agent.id === this.selected ? this.colors.active : node.issue ? this.colors.warning
        : node.contextOnly ? this.colors.context : this.evidenceCurrent && (node.agent.state === 'working' || node.agent.activity) ? this.colors.active : this.colors.node
      this.transform.rotation.set(0, facing, 0)
      this.transform.position.set(p.x, p.y + 40 * (size - 1), p.z)
      this.transform.scale.setScalar(size)
      this.transform.updateMatrix()
      body.setMatrixAt(index, this.transform.matrix)
      body.setColorAt(index, this.white)
      this.transform.position.set(p.x, p.y, p.z)
      this.transform.scale.setScalar(1)
      this.transform.updateMatrix()
      desks.setMatrixAt(index, this.transform.matrix)
      desks.setColorAt(index, this.white)
      this.transform.rotation.set(-Math.PI / 2, 0, 0)
      this.transform.position.set(p.x, p.y - 38, p.z)
      this.transform.scale.setScalar(size)
      this.transform.updateMatrix()
      markers.setMatrixAt(index, this.transform.matrix)
      markers.setColorAt(index, color)
    }
    let vertex = 0
    // Partition shared edge buffers; relationships touching the selected floor stay legible.
    for (const muted of [false, true]) {
      const startVertex = vertex
      const arrows = muted ? this.mutedArrows : this.arrows
      for (const edge of this.graph.edges) {
        const edgeMuted = this.isMuted(this.session.floorByAgent.get(edge.source)!) && this.isMuted(this.session.floorByAgent.get(edge.target)!)
        if (edgeMuted !== muted) continue
        const start = this.session.positions.get(edge.source)!
        const end = this.session.positions.get(edge.target)!
        this.direction.set(end.x - start.x, end.y - start.y, end.z - start.z)
        const length = this.direction.length()
        this.direction.normalize()
        const color = edge.source === this.selected || edge.target === this.selected || this.session.floorId !== null && !muted ? this.colors.active : this.colors.edge
        if (edge.source === edge.target) {
          for (let segment = 0; segment < 12; segment++) {
            for (const angle of [segment * Math.PI / 6, (segment + 1) * Math.PI / 6]) {
              this.edgePositions.setXYZ(vertex, start.x + 46 + Math.cos(angle) * 46, start.y + Math.sin(angle) * 46, start.z)
              this.edgeColors.setXYZ(vertex++, color.r, color.g, color.b)
            }
          }
          this.transform.position.set(start.x + 46, start.y + 46, start.z)
          this.direction.set(-1, 0, 0)
        } else {
          const offset = Math.min(length / 2, NODE_RADIUS + 8)
          this.transform.position.set(end.x, end.y, end.z).addScaledVector(this.direction, -offset)
          this.edgePositions.setXYZ(vertex, start.x, start.y, start.z)
          this.edgeColors.setXYZ(vertex++, color.r, color.g, color.b)
          this.edgePositions.setXYZ(vertex, end.x, end.y, end.z)
          this.edgeColors.setXYZ(vertex++, color.r, color.g, color.b)
        }
        this.transform.quaternion.setFromUnitVectors(this.up, this.direction.lengthSq() ? this.direction : this.up)
        this.transform.scale.setScalar(1)
        this.transform.updateMatrix()
        arrows.setMatrixAt(arrows.count, this.transform.matrix)
        arrows.setColorAt(arrows.count++, color)
      }
      ;(muted ? this.mutedLines : this.lines).geometry.setDrawRange(startVertex, vertex - startVertex)
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    this.edgePositions.needsUpdate = this.edgeColors.needsUpdate = true
  }

  private readonly resize = (): void => {
    this.width = Math.max(1, this.host.clientWidth)
    this.height = Math.max(1, this.host.clientHeight)
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (this.width * this.height)))
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(this.width, this.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  private readonly invalidate = (): void => {
    if (this.disposed || this.failed || this.frame || document.hidden || !this.visible) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.disposed || this.failed || document.hidden || !this.visible) return
      try {
        this.renderer.render(this.scene, this.camera)
        this.projectLabels()
        if (this.graph?.nodes.length) this.session.camera = { position: this.camera.position.toArray(), target: this.controls.target.toArray() }
      } catch (error) {
        this.failed = true
        this.callbacks.error(error instanceof Error ? error.message : String(error))
      }
    })
  }

  private projectLabels(): void {
    if (!this.graph) return
    const scale = Number(getComputedStyle(this.host).getPropertyValue('--font-scale')) || 1
    const boxes: { x: number; y: number; w: number; h: number }[] = []
    const intersects = (x: number, y: number, w: number, h: number) => boxes.some(b => x < b.x + b.w + 6 && x + w + 6 > b.x && y < b.y + b.h + 5 && y + h + 5 > b.y)
    const floorCandidates = this.floors.map(floor => {
      this.point.set(-floor.width / 2, floor.y, floor.depth / 2).project(this.camera)
      return { floor, x: (this.point.x + 1) * this.width / 2, y: (1 - this.point.y) * this.height / 2, depth: this.point.z }
    }).filter(p => p.depth > -1 && p.depth < 1 && p.x > -100 && p.x < this.width && p.y > 0 && p.y < this.height)
    floorCandidates.sort((a, b) => Number(b.floor.id === this.session.floorId) - Number(a.floor.id === this.session.floorId) || b.floor.level - a.floor.level)
    const visibleFloors: typeof floorCandidates = []
    const fw = Math.min(210, this.width - 8), fh = 30 * scale + 8
    for (const item of floorCandidates) {
      if (visibleFloors.length === FLOOR_LABEL_LIMIT) break
      item.x = Math.max(4, Math.min(this.width - fw - 4, item.x - fw - 10))
      item.y = Math.max(4, Math.min(this.height - fh - 4, item.y))
      if (intersects(item.x, item.y, fw, fh)) continue
      visibleFloors.push(item)
      boxes.push({ x: item.x, y: item.y, w: fw, h: fh })
    }
    const wantedFloors = new Set(visibleFloors.map(item => item.floor.id))
    const usedFloors = new Set<HTMLButtonElement>()
    for (const { floor, x, y } of visibleFloors) {
      const label = this.floorLabels.find(label => label.dataset.floorId === floor.id)
        ?? this.floorLabels.find(label => !usedFloors.has(label) && !wantedFloors.has(label.dataset.floorId ?? ''))!
      usedFloors.add(label)
      const name = floor.cwd ? floor.name : this.t('工程未识别', 'Unidentified project')
      const text = `${floor.level}F · ${name} · ${floor.nodeIds.length}`
      if (label.textContent !== text) label.textContent = text
      label.dataset.floorId = floor.id
      label.title = `${name}\n${floor.cwd ?? this.t('没有工作目录证据', 'No working-directory evidence')}`.slice(0, 4096)
      label.setAttribute('aria-pressed', String(floor.id === this.session.floorId))
      label.classList.toggle('is-selected', floor.id === this.session.floorId)
      label.classList.toggle('is-dimmed', this.isMuted(floor.id))
      label.style.transform = `translate(${x}px, ${y}px)`
      label.hidden = false
    }
    for (const label of this.floorLabels) if (!usedFloors.has(label)) label.hidden = true
    const candidates = this.graph.nodes.map(node => {
      const p = this.session.positions.get(node.agent.id)!
      this.point.set(p.x, p.y - 40, p.z).project(this.camera)
      const footY = this.point.y
      this.point.set(p.x, p.y + 70, p.z).project(this.camera)
      return { node, x: (this.point.x + 1) * this.width / 2, y: (1 - this.point.y) * this.height / 2, depth: this.point.z, size: Math.abs(this.point.y - footY) * this.height / 2 }
    }).filter(p => p.depth > -1 && p.depth < 1 && p.x > 0 && p.x < this.width && p.y > 0 && p.y < this.height
      && (p.size >= 42 || p.node.agent.id === this.selected || p.node.agent.id === this.hovered))
    const priority = (node: TopologyNode) => (this.isMuted(getAgentFloorId(node.agent)) ? 10 : 0) + (node.agent.id === this.selected ? 0 : node.agent.id === this.hovered ? 1 : node.agent.kind === 'main' ? 2 : 3)
    candidates.sort((a, b) => priority(a.node) - priority(b.node) || a.depth - b.depth)
    const w = Math.min(200, this.width - 8), h = 34.5 * scale + 14
    const placed: { item: typeof candidates[number]; x: number; y: number }[] = []
    for (const item of candidates) {
      if (placed.length === LABEL_LIMIT) break
      const x = Math.max(4, Math.min(this.width - w - 4, item.x - w / 2))
      const y = Math.max(4, Math.min(this.height - h - 4, item.y - h - 6))
      if (intersects(x, y, w, h)) continue
      placed.push({ item, x, y })
      boxes.push({ x, y, w, h })
    }
    const wanted = new Set(placed.map(({ item }) => item.node.agent.id))
    const used = new Set<HTMLButtonElement>()
    for (const { item, x, y } of placed) {
      const label = this.labels.find(label => label.dataset.id === item.node.agent.id)
        ?? this.labels.find(label => !used.has(label) && !wanted.has(label.dataset.id ?? ''))!
      used.add(label)
      const title = (item.node.agent.summary || item.node.agent.name).slice(0, 240)
      label.hidden = false
      if (label.firstElementChild!.textContent !== title) label.firstElementChild!.textContent = title
      const state = item.node.agent.state === 'working' ? this.t('工作中', 'Working') : item.node.agent.state === 'idle' ? this.t('空闲', 'Idle') : item.node.agent.state === 'running' ? this.t('进程存活', 'Process alive') : this.t('状态未知', 'Unknown')
      const subtitle = `${item.node.agent.runtime} · ${state}${item.node.contextOnly ? this.t(' · 关联', ' · Context') : ''}${item.node.issue ? this.t(' · 关系待确认', ' · Unconfirmed relation') : ''}`
      if (label.lastElementChild!.textContent !== subtitle) label.lastElementChild!.textContent = subtitle
      label.dataset.id = item.node.agent.id
      label.classList.toggle('is-selected', item.node.agent.id === this.selected)
      label.classList.toggle('is-dimmed', this.isMuted(getAgentFloorId(item.node.agent)))
      label.title = `${title}\n${item.node.agent.cwd ?? ''}`.slice(0, 4096)
      label.setAttribute('aria-label', `${title}, ${state}, PID ${item.node.agent.pid}`)
      label.style.transform = `translate(${x}px, ${y}px)`
    }
    for (const label of this.labels) if (!used.has(label)) label.hidden = true
  }

  fit(front = false, ids?: ReadonlySet<string>): void {
    if (!this.graph?.nodes.length) return
    const bounds = new Box3()
    for (const floor of this.floors) {
      if (ids && !floor.nodeIds.some(id => ids.has(id))) continue
      bounds.expandByPoint(this.point.set(-floor.width / 2 - 20, floor.y - 8, -floor.depth / 2 - 20))
      bounds.expandByPoint(this.point.set(floor.width / 2 + 20, floor.y + (ids ? 135 : 300), floor.depth / 2 + 90))
    }
    if (bounds.isEmpty()) return
    bounds.getCenter(this.controls.target)
    this.direction.set(front ? 0 : 0.6, front ? 0 : 0.45, 1).normalize()
    const right = new Vector3().crossVectors(this.up, this.direction).normalize()
    const viewUp = new Vector3().crossVectors(this.direction, right)
    const vertical = Math.tan(this.camera.fov * Math.PI / 360) * 0.94
    const horizontal = vertical * this.camera.aspect
    let distance = 520
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      this.point.set(x, y, z).sub(this.controls.target)
      const depth = this.point.dot(this.direction)
      distance = Math.max(distance, depth + (Math.abs(this.point.dot(right)) + 60) / horizontal, depth + (Math.abs(this.point.dot(viewUp)) + 30) / vertical)
    }
    this.camera.position.copy(this.controls.target).addScaledVector(this.direction, distance)
    this.controls.update()
    this.invalidate()
  }

  focus(id: string): void {
    const p = this.session.positions.get(id)
    if (!p || !this.byId.has(id)) return
    this.direction.subVectors(this.camera.position, this.controls.target).normalize()
    this.controls.target.set(p.x, p.y + 10, p.z)
    this.camera.position.copy(this.controls.target).addScaledVector(this.direction, 340)
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
    if (!this.graph) return
    const layout = buildOfficeLayout(this.graph)
    this.floors = layout.floors
    this.session.positions.clear()
    this.session.floorByAgent.clear()
    for (const [id, p] of layout.positions) this.session.positions.set(id, p)
    for (const floor of this.floors) for (const id of floor.nodeIds) this.session.floorByAgent.set(id, floor.id)
    this.syncGeometry()
    this.fit()
  }

  private hit(event: PointerEvent | MouseEvent): string | null {
    const bounds = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObjects([this.nodes, this.markers, this.desks, this.mutedNodes, this.mutedMarkers, this.mutedDesks], false)[0]
    if (hit?.instanceId === undefined) return null
    return (hit.object === this.nodes || hit.object === this.markers || hit.object === this.desks ? this.nodeSlots : this.mutedNodeSlots)[hit.instanceId] ?? null
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return
    const id = this.hit(event)
    const floorHit = id ? undefined : this.raycaster.intersectObjects([this.decks, this.mutedDecks], false)[0]
    const floorId = floorHit?.instanceId === undefined ? null : (floorHit.object === this.decks ? this.floorSlots : this.mutedFloorSlots)[floorHit.instanceId]
    this.pointerStart = { x: event.clientX, y: event.clientY, id, floorId, pointerId: event.pointerId }
    this.dragged = false
    if (!id || event.shiftKey || event.ctrlKey || event.metaKey) { this.pointerStart.id = null; return }
    this.controls.enabled = false
    const p = this.session.positions.get(id)!
    this.dragPlane.setFromNormalAndCoplanarPoint(this.up, this.point.set(p.x, p.y, p.z))
    const intersect = this.raycaster.ray.intersectPlane(this.dragPlane, this.point)
    if (intersect) this.dragOffset.set(p.x, p.y, p.z).sub(intersect)
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.focus({ preventScroll: true })
  }

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.pointerStart) {
      if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 4) this.dragged = true
      if (this.pointerStart.id && this.dragged) {
        this.hit(event)
        if (this.raycaster.ray.intersectPlane(this.dragPlane, this.point)) {
          const floorId = this.session.floorByAgent.get(this.pointerStart.id)
          const floor = this.floors.find(floor => floor.id === floorId)!
          this.point.add(this.dragOffset)
          this.point.x = Math.max(-floor.width / 2 + 100, Math.min(floor.width / 2 - 100, this.point.x))
          this.point.z = Math.max(-floor.depth / 2 + 80, Math.min(floor.depth / 2 - 80, this.point.z))
          this.session.positions.set(this.pointerStart.id, { x: this.point.x, y: floor.y + 40, z: this.point.z })
          this.syncGeometry()
          this.invalidate()
        }
      }
      return
    }
    const id = this.hit(event)
    if (id !== this.hovered) { this.hovered = id; this.renderer.domElement.style.cursor = id ? 'grab' : ''; this.invalidate() }
  }
  private readonly pointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    if (!start || start.pointerId !== event.pointerId) return
    this.pointerStart = null
    this.controls.enabled = true
    if (!this.dragged) {
      if (start.id) this.selectAgent(start.id)
      else if (start.floorId) this.callbacks.floor(start.floorId)
    }
  }
  private readonly pointerCancel = (): void => { this.pointerStart = null; this.controls.enabled = true }
  private readonly contextMenu = (event: MouseEvent): void => {
    const id = this.hit(event)
    if (id && this.byId.get(id)?.agent.runtime === 'OMP') {
      event.preventDefault()
      this.renderer.domElement.focus({ preventScroll: true })
      this.callbacks.menu(id, event.clientX, event.clientY, this.renderer.domElement)
    }
  }
  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.fit() }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(0.8) }
    if (event.key === '-') { event.preventDefault(); this.zoom(1.25) }
  }
  private readonly contextLost = (event: Event): void => {
    event.preventDefault()
    this.failed = true
    this.cancelFrame()
    this.callbacks.error(this.t('3D 图形上下文已丢失，请重试 3D 视图。', 'The 3D graphics context was lost. Retry the 3D view.'))
  }
  private readonly visibilityChange = (): void => { if (document.hidden) this.cancelFrame(); else this.invalidate() }
  private cancelFrame(): void { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0 }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    this.observer.disconnect()
    this.intersection.disconnect()
    document.removeEventListener('visibilitychange', this.visibilityChange)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.pointerDown, true)
    canvas.removeEventListener('pointermove', this.pointerMove)
    canvas.removeEventListener('pointerup', this.pointerUp)
    canvas.removeEventListener('pointercancel', this.pointerCancel)
    canvas.removeEventListener('lostpointercapture', this.pointerCancel)
    canvas.removeEventListener('contextmenu', this.contextMenu)
    canvas.removeEventListener('keydown', this.keyDown)
    canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.controls.removeEventListener('change', this.invalidate)
    this.controls.dispose()
    const geometries = new Set(this.meshes.map(mesh => mesh.geometry))
    for (const mesh of this.meshes) {
      mesh.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
    }
    for (const geometry of geometries) geometry.dispose()
    for (const lines of [this.lines, this.mutedLines]) { lines.geometry.dispose(); lines.material.dispose() }
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
    for (const label of this.labels) label.remove()
    for (const label of this.floorLabels) label.remove()
    this.floors = []
    this.byId.clear()
    this.graph = null
  }
}
