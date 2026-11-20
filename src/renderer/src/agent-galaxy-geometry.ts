import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, Points, Scene, ShaderMaterial,
} from 'three'
import type { Galaxy } from './agent-topology-3d-layout'
import { MAX_3D_NODES } from './agent-topology-3d-layout'

const DUST_BUDGET = 36_000
const SKY_COUNT = 3_600
const PALETTES = [
  ['#4556ff', '#bc7bff', '#c9e9ff'],
  ['#1563b8', '#38e8cd', '#bdffec'],
  ['#b32d72', '#ff874e', '#ffe2a0'],
  ['#6f40d9', '#fe73bb', '#ffe0f2'],
  ['#14718b', '#62afea', '#e5f1ff'],
  ['#8e452e', '#efc04f', '#fff1b6'],
].map(colors => colors.map(color => new Color(color)))
const UNASSIGNED_PALETTE = ['#59383c', '#d28762', '#ffd0ae'].map(color => new Color(color))

function randomSequence(key: string): () => number {
  let state = 2166136261
  for (let index = 0; index < key.length; index++) state = Math.imul(state ^ key.charCodeAt(index), 16777619)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let bits = Math.imul(state ^ state >>> 15, state | 1)
    bits ^= bits + Math.imul(bits ^ bits >>> 7, bits | 61)
    return ((bits ^ bits >>> 14) >>> 0) / 4294967296
  }
}

export function galaxyColor(slot: number, target: Color): Color {
  const palette = PALETTES[slot % PALETTES.length]
  return target.copy(palette[1]).lerp(palette[2], 0.38)
}

const pointFragment = /* glsl */ `
  varying vec3 vTint;
  varying float vStrength;
  void main() {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    float r = dot(point, point);
    if (r >= 1.0) discard;
    float glow = (exp(-r * 5.5) - 0.004) * (1.0 - smoothstep(0.45, 1.0, r));
    gl_FragColor = vec4(vTint, glow * vStrength);
    #include <colorspace_fragment>
  }
`

/** A single batched point cloud. Particle data never participates in topology or picking. */
function pointCloud(capacity: number, kind: 'sky' | 'dust' | 'glow') {
  const geometry = new BufferGeometry()
  const positions = new BufferAttribute(new Float32Array(capacity * 3), 3)
  const colors = new BufferAttribute(new Float32Array(capacity * 3), 3)
  const details = new BufferAttribute(new Float32Array(capacity * 3), 3)
  geometry.setAttribute('position', positions)
  geometry.setAttribute('tint', colors)
  geometry.setAttribute('details', details)
  geometry.setDrawRange(0, 0)
  const material = new ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 }, viewport: { value: 1 }, activeGalaxy: { value: -1 } },
    defines: { SKY: Number(kind === 'sky'), GLOW: Number(kind === 'glow') },
    vertexShader: /* glsl */ `
      uniform float pixelRatio;
      uniform float viewport;
      uniform float activeGalaxy;
      attribute vec3 tint;
      attribute vec3 details;
      varying vec3 vTint;
      varying float vStrength;
      void main() {
        #if SKY
          vec4 view = vec4(mat3(viewMatrix) * position, 1.0);
          gl_PointSize = details.x * pixelRatio;
          vStrength = details.y;
        #else
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          float radius = details.x * projectionMatrix[1][1] * viewport / max(1.0, -view.z);
          gl_PointSize = clamp(radius, 1.35 * pixelRatio, (GLOW == 1 ? 160.0 : 32.0) * pixelRatio);
          vStrength = details.y * ((activeGalaxy < 0.0 || activeGalaxy == details.z) ? 1.0 : 0.46);
        #endif
        vTint = tint;
        gl_Position = projectionMatrix * view;
        #if SKY
          gl_Position.z = gl_Position.w;
        #endif
      }
    `,
    fragmentShader: pointFragment,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  })
  const points = new Points(geometry, material)
  points.frustumCulled = false
  return { points, positions, colors, details }
}

/** Main stars and the selected planet get an additive halo at their real positions. */
export class AgentGlows {
  private readonly cloud = pointCloud(MAX_3D_NODES, 'glow')

  constructor(scene: Scene) {
    this.cloud.points.renderOrder = 10
    scene.add(this.cloud.points)
  }

  resize(pixelRatio: number, height: number): void {
    this.cloud.points.material.uniforms.pixelRatio.value = pixelRatio
    this.cloud.points.material.uniforms.viewport.value = height * pixelRatio
  }

  write(index: number, point: { x: number; y: number; z: number }, color: Color, size: number, strength: number): void {
    this.cloud.positions.setXYZ(index, point.x, point.y, point.z)
    this.cloud.colors.setXYZ(index, color.r, color.g, color.b)
    this.cloud.details.setXYZ(index, size, strength, 0)
  }

  finish(count: number): void {
    this.cloud.points.geometry.setDrawRange(0, count)
    this.cloud.positions.needsUpdate = this.cloud.colors.needsUpdate = this.cloud.details.needsUpdate = true
  }

  dispose(): void {
    this.cloud.points.removeFromParent()
    this.cloud.points.geometry.dispose()
    this.cloud.points.material.dispose()
  }
}

function galaxyNebula() {
  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0, 1]), 3))
  geometry.setIndex([0, 1, 2, 2, 1, 3])
  const centers = new InstancedBufferAttribute(new Float32Array(MAX_3D_NODES * 4), 4)
  const colors = new InstancedBufferAttribute(new Float32Array(MAX_3D_NODES * 3), 3)
  const accents = new InstancedBufferAttribute(new Float32Array(MAX_3D_NODES * 4), 4)
  geometry.setAttribute('centerRadius', centers)
  geometry.setAttribute('tint', colors)
  geometry.setAttribute('accent', accents)
  geometry.instanceCount = 0
  const material = new ShaderMaterial({
    uniforms: { activeGalaxy: { value: -1 } },
    vertexShader: /* glsl */ `
      attribute vec4 centerRadius;
      attribute vec3 tint;
      attribute vec4 accent;
      varying vec2 vPosition;
      varying vec3 vTint;
      varying vec4 vAccent;
      varying float vAngle;
      varying float vIndex;
      void main() {
        vPosition = position.xz;
        vTint = tint;
        vAccent = accent;
        vAngle = centerRadius.w;
        vIndex = float(gl_InstanceID);
        vec3 world = vec3(centerRadius.x, -28.0, centerRadius.y) + position * centerRadius.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float activeGalaxy;
      varying vec2 vPosition;
      varying vec3 vTint;
      varying vec4 vAccent;
      varying float vAngle;
      varying float vIndex;
      void main() {
        float r = length(vPosition);
        if (r >= 1.0) discard;
        float angle = atan(vPosition.y, vPosition.x + 0.000001);
        float spiral = angle - vAngle + r * 5.8;
        float turbulence = sin(spiral * 3.0 + sin(r * 38.0) * 0.19 + cos(angle * 7.0) * 0.32);
        float arms = pow(max(0.0, turbulence * 0.5 + 0.5), 2.6);
        float clouds = sin(vPosition.x * 56.0 + cos(vPosition.y * 34.0)) * sin(vPosition.y * 47.0 - angle * 3.0);
        float dust = arms * (0.32 + 0.12 * clouds) + 0.15;
        float outer = (1.0 - smoothstep(0.28, 1.0, r)) * dust;
        float core = 0.34 * exp(-r * 10.0) + vAccent.a * 0.38 * exp(-r * r * 128.0);
        vec3 color = mix(vTint, vAccent.rgb, clamp(core + arms * 0.28, 0.0, 1.0));
        float focus = (activeGalaxy < 0.0 || activeGalaxy == vIndex) ? 1.0 : 0.45;
        gl_FragColor = vec4(color, (outer + core) * focus);
        #include <colorspace_fragment>
      }
    `,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
  })
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  return { mesh, centers, colors, accents }
}

export class GalaxyBackdrop {
  private readonly sky = pointCloud(SKY_COUNT, 'sky')
  private readonly dust = pointCloud(DUST_BUDGET, 'dust')
  private readonly nebula = galaxyNebula()
  private layout: { id: string; x: number; z: number; radius: number; slot: number }[] = []

  constructor(scene: Scene) {
    this.sky.points.renderOrder = -30
    this.nebula.mesh.renderOrder = -20
    this.dust.points.renderOrder = -10
    const random = randomSequence('sky')
    for (let index = 0; index < SKY_COUNT; index++) {
      const y = random() * 2 - 1
      const angle = random() * Math.PI * 2
      const radial = Math.sqrt(1 - y * y)
      const warm = random()
      this.sky.positions.setXYZ(index, Math.cos(angle) * radial * 6000, y * 6000, Math.sin(angle) * radial * 6000)
      this.sky.colors.setXYZ(index, 0.42 + warm * 0.5, 0.61 + warm * 0.18, 1 - warm * 0.37)
      this.sky.details.setXYZ(index, 1.15 + 3.4 * random() ** 6, 0.2 + 0.55 * random() ** 3, 0)
    }
    this.sky.points.geometry.setDrawRange(0, SKY_COUNT)
    scene.add(this.sky.points, this.nebula.mesh, this.dust.points)
  }

  resize(pixelRatio: number, height: number): void {
    this.sky.points.material.uniforms.pixelRatio.value = pixelRatio
    this.dust.points.material.uniforms.pixelRatio.value = pixelRatio
    this.dust.points.material.uniforms.viewport.value = height * pixelRatio
  }

  select(galaxyId: string | undefined): void {
    const index = this.layout.findIndex(galaxy => galaxy.id === galaxyId)
    this.dust.points.material.uniforms.activeGalaxy.value = index
    this.nebula.mesh.material.uniforms.activeGalaxy.value = index
  }

  update(galaxies: readonly Galaxy[], slots: ReadonlyMap<string, number>): void {
    if (galaxies.length === this.layout.length && galaxies.every((galaxy, index) => {
      const cached = this.layout[index]
      return cached.id === galaxy.id && cached.x === galaxy.x && cached.z === galaxy.z && cached.radius === galaxy.radius && cached.slot === slots.get(galaxy.id)
    })) return
    this.layout = galaxies.map(galaxy => ({ id: galaxy.id, x: galaxy.x, z: galaxy.z, radius: galaxy.radius, slot: slots.get(galaxy.id)! }))
    const perGalaxy = Math.min(7_800, Math.floor(DUST_BUDGET / Math.max(galaxies.length, 1)))
    const color = new Color()
    for (let index = 0; index < this.layout.length; index++) {
      const galaxy = this.layout[index]
      const random = randomSequence(galaxy.id)
      const phase = random() * Math.PI * 2
      const radius = galaxy.radius * 1.06
      const unresolved = galaxy.id === 'unresolved'
      const [shadow, dust, light] = unresolved ? UNASSIGNED_PALETTE : PALETTES[galaxy.slot % PALETTES.length]
      this.nebula.centers.setXYZW(index, galaxy.x, galaxy.z, radius, phase)
      this.nebula.colors.setXYZ(index, shadow.r, shadow.g, shadow.b)
      this.nebula.accents.setXYZW(index, dust.r, dust.g, dust.b, unresolved ? 0 : 1)
      for (let local = 0; local < perGalaxy; local++) {
        const particle = index * perGalaxy + local
        const bulge = random() < (unresolved ? 0.04 : 0.17)
        const rim = random() < 0.07
        const r = bulge ? 0.035 + 0.24 * random() ** 1.7 : 0.14 + 0.85 * random() ** 0.82
        const scatter = (random() + random() + random() - 1.5) * (0.2 + 0.27 * r)
        const angle = rim ? random() * Math.PI * 2 : phase - r * 5.8 + (Math.PI / 6) + (local % 3) * Math.PI * 2 / 3 + scatter
        const height = (random() + random() - 1) * radius * (bulge ? 0.13 : 0.046) - 26
        this.dust.positions.setXYZ(particle, galaxy.x + Math.cos(angle) * r * radius, height, galaxy.z + Math.sin(angle) * r * radius)
        const highlight = random()
        color.copy(shadow).lerp(dust, 0.4 + highlight * 0.6).lerp(light, bulge ? 0.75 : highlight ** 6 * 0.74)
        this.dust.colors.setXYZ(particle, color.r, color.g, color.b)
        const size = Math.min(22, Math.max(3.8, radius * 0.014)) * (0.38 + 2.7 * random() ** 5)
        const density = Math.min(1, Math.sqrt(1500 / perGalaxy))
        this.dust.details.setXYZ(particle, size, density * (0.21 + (bulge ? 0.5 : 0.62) * highlight), index)
      }
    }
    this.nebula.mesh.geometry.instanceCount = galaxies.length
    this.nebula.centers.needsUpdate = this.nebula.colors.needsUpdate = this.nebula.accents.needsUpdate = true
    this.dust.points.geometry.setDrawRange(0, galaxies.length * perGalaxy)
    this.dust.positions.needsUpdate = this.dust.colors.needsUpdate = this.dust.details.needsUpdate = true
  }

  dispose(): void {
    for (const object of [this.sky.points, this.nebula.mesh, this.dust.points]) {
      object.removeFromParent()
      object.geometry.dispose()
      object.material.dispose()
    }
  }
}
