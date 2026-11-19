import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, LatheGeometry, Path, PlaneGeometry, Shape, Vector2, Vector3 } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const palette = {
  concrete: new Color('#d8d3c8'),
  limestone: new Color('#eee9de'),
  trim: new Color('#a9a99e'),
  metal: new Color('#57666b'),
  glass: new Color('#a5d0d4'),
  glassShade: new Color('#7aaeb9'),
  roof: new Color('#939e9b'),
  equipment: new Color('#d1d6cf'),
  soil: new Color('#65594b'),
  foliage: new Color('#668361'),
}

// Color parses sRGB swatches into Three's linear working space. RGBA attributes
// let glass stay translucent while the adjoining stone and metal remain solid.
function paint(geometry: BufferGeometry, color: Color, alpha = 1): BufferGeometry {
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 4)
  for (let index = 0; index < count; index++) {
    const offset = index * 4
    colors[offset] = color.r
    colors[offset + 1] = color.g
    colors[offset + 2] = color.b
    colors[offset + 3] = alpha
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 4))
  return geometry
}

function box(
  parts: BufferGeometry[], width: number, height: number, depth: number,
  x: number, y: number, z: number, color: Color,
): void {
  parts.push(paint(new BoxGeometry(width, height, depth).translate(x, y, z), color))
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  try {
    const geometry = mergeGeometries(parts, false)
    if (!geometry) throw new Error('Office building geometry attributes could not be merged')
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  } finally {
    for (const part of parts) part.dispose()
  }
}

/** Floor-local origin: deck centre at y=0; columns end at 220, beams at 240. */
export function createFloorFrameGeometry(width: number, depth: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const halfWidth = width / 2
  const halfDepth = depth / 2
  for (const x of [-halfWidth, halfWidth]) {
    for (const z of [-halfDepth, halfDepth]) {
      box(parts, 14, 220, 14, x, 110, z, palette.limestone)
    }
    box(parts, 16, 20, depth + 14, x, 230, 0, palette.limestone)
    box(parts, 16, 10, depth + 14, x, 5, 0, palette.concrete)
  }
  box(parts, width + 14, 20, 16, 0, 230, -halfDepth, palette.limestone)
  box(parts, width - 14, 42, 10, 0, 21, -halfDepth, palette.concrete)
  box(parts, width - 14, 5, 14, 0, 44.5, -halfDepth, palette.limestone)
  return merge(parts)
}

/** +Z frontage and +X return. Each bay has two panes, a mullion and a stone pier. */
export function createFacadeGeometry(width: number, depth: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  for (const front of [true, false]) {
    const length = front ? width : depth
    const surface = (front ? depth : width) / 2 + 8
    const span = length - 14
    const bays = Math.min(16, Math.max(1, Math.round(span / 115)))
    const bayWidth = span / bays
    const pierWidth = Math.min(10, bayWidth * 0.12)
    const mullionWidth = Math.min(3, bayWidth * 0.04)
    const paneWidth = (bayWidth - pierWidth - mullionWidth) / 2
    const facadeBox = (
      horizontal: number, vertical: number, thickness: number,
      along: number, y: number, color: Color,
    ): void => {
      if (front) box(parts, horizontal, vertical, thickness, along, y, surface, color)
      else box(parts, thickness, vertical, horizontal, surface, y, along, color)
    }

    // Narrow spandrels establish storeys without filling the employee sightline.
    facadeBox(length + 14, 22, 8, 0, 31, palette.concrete)
    facadeBox(length + 14, 28, 8, 0, 226, palette.limestone)
    facadeBox(length + 14, 4, 10, 0, 46, palette.trim)
    facadeBox(length + 14, 3, 5, 0, 170, palette.metal)
    for (let bay = 0; bay <= bays; bay++) {
      const along = -span / 2 + bay * bayWidth
      facadeBox(pierWidth, 164, 8, along, 130, palette.limestone)
      if (bay === bays) continue
      const centre = along + bayWidth / 2
      facadeBox(mullionWidth, 164, 4, centre, 130, palette.metal)
      for (const side of [-1, 1]) {
        const pane = new PlaneGeometry(paneWidth, 164)
        const paneCentre = centre + side * (paneWidth + mullionWidth) / 2
        if (front) pane.translate(paneCentre, 130, surface - 1)
        else pane.rotateY(Math.PI / 2).translate(surface - 1, 130, paneCentre)
        parts.push(paint(pane, bay % 3 === 1 ? palette.glassShade : palette.glass, 0.36))
      }
    }
  }
  return merge(parts)
}

export const LANDMARK_ROOF_HEIGHT = 160

/** Place above the top task floor. The crown is architectural decoration. */
export function createRoofGeometry(width: number, depth: number, style: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  box(parts, width + 26, 6, depth + 26, 0, 3, 0, palette.roof)
  for (const x of [-width / 2 - 7, width / 2 + 7]) {
    box(parts, 10, 17, depth + 26, x, 14.5, 0, palette.limestone)
  }
  for (const z of [-depth / 2 - 7, depth / 2 + 7]) {
    box(parts, width + 4, 17, 10, 0, 14.5, z, palette.limestone)
  }

  const crownWidth = Math.min(width * 0.82, 440)
  const crownDepth = Math.min(depth * 0.78, 330)
  if (style === 0) {
    // Shanghai World Financial Center: tapered shoulders and an open portal.
    const half = crownWidth / 2
    const outline = new Shape()
    outline.moveTo(-half, 6)
    outline.lineTo(half, 6)
    outline.lineTo(half * 0.74, 146)
    outline.lineTo(-half * 0.74, 146)
    outline.closePath()
    const opening = new Path()
    opening.moveTo(-half * 0.60, 51)
    opening.lineTo(-half * 0.46, 126)
    opening.lineTo(half * 0.46, 126)
    opening.lineTo(half * 0.60, 51)
    opening.closePath()
    outline.holes.push(opening)
    const thickness = crownDepth * 0.22
    const portal = new ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: false }).translate(0, 0, -thickness / 2)
    // ExtrudeGeometry emits non-indexed vertices. Match the shared roof boxes.
    portal.setIndex(Array.from({ length: portal.getAttribute('position').count }, (_, index) => index))
    parts.push(paint(portal, palette.glassShade))
  } else if (style === 1) {
    // Taipei 101: repeated flared sections, edged in pale stone.
    for (const [tier, size] of [1, 0.86, 0.72, 0.58].entries()) {
      const y = 6 + tier * 30
      const stack = new CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2 * 0.76, 25, 4)
        .rotateY(Math.PI / 4).scale(crownWidth * size, 1, crownDepth * size).translate(0, y + 12.5, 0)
      parts.push(paint(stack, palette.glassShade))
      box(parts, crownWidth * size, 5, crownDepth * size, 0, y + 27.5, 0, palette.limestone)
    }
    box(parts, crownWidth * 0.23, 17, crownDepth * 0.25, 0, 134.5, 0, palette.glass)
    box(parts, 6, 17, 6, 0, 151.5, 0, palette.limestone)
  } else if (style === 2) {
    // Chrysler Building: overlapping curved silver tiers and a needle spire.
    const profile = [[0, 6], [1, 6], [1, 19], [0.88, 38], [0.71, 51], [0.79, 51],
      [0.70, 68], [0.53, 80], [0.61, 80], [0.51, 96], [0.36, 108], [0.42, 108],
      [0.32, 120], [0.15, 135], [0.04, 135], [0, LANDMARK_ROOF_HEIGHT]]
    const crown = new LatheGeometry(profile.map(([radius, y]) => new Vector2(radius, y)), 16)
      .scale(crownWidth / 2, 1, crownDepth / 2)
    parts.push(paint(crown, palette.equipment))
  } else if (style === 3) {
    // The Shard: offset glass planes converge toward two uneven tips.
    for (const [side, height, shift] of [[-1, 160, 0.30], [1, 127, -0.12]]) {
      const shard = new CylinderGeometry(0.045, Math.SQRT1_2, height - 6, 4).rotateY(Math.PI / 4)
      const positions = shard.getAttribute('position')
      for (let i = 0; i < positions.count; i++) {
        const rise = positions.getY(i) / (height - 6) + 0.5
        positions.setX(i, positions.getX(i) * 0.48 + side * 0.24 + rise * shift)
        positions.setZ(i, positions.getZ(i) * 0.88 + rise * side * 0.15)
      }
      shard.computeVertexNormals()
      shard.scale(crownWidth, 1, crownDepth).translate(0, (height + 6) / 2, 0)
      parts.push(paint(shard, side < 0 ? palette.glass : palette.glassShade))
    }
  } else if (style === 4) {
    // Burj Khalifa: three wings drop away in staggered setbacks around a slender core.
    const span = Math.min(crownWidth, crownDepth)
    for (const [tier, radius] of [0.27, 0.22, 0.17, 0.12, 0.075].entries()) {
      const core = new CylinderGeometry(span * radius, span * radius, 26, 12).translate(0, 19 + tier * 26, 0)
      parts.push(paint(core, palette.equipment))
      if (tier >= 3) continue
      for (let wing = 0; wing < 3; wing++) {
        const angle = wing * Math.PI * 2 / 3
        const height = 12 + wing * 5
        const wingGeometry = new BoxGeometry(span * (0.22 - tier * 0.035), height, span * (0.43 - tier * 0.08))
          .translate(0, 6 + tier * 26 + height / 2, span * radius * 0.65).rotateY(angle)
        parts.push(paint(wingGeometry, palette.glassShade))
      }
    }
    box(parts, 5, 24, 5, 0, 148, 0, palette.limestone)
  } else {
    // Bank of China Tower: staggered triangular shafts with exposed diagonal bracing.
    const span = Math.min(crownWidth, crownDepth)
    for (const [height, offset] of [[145, -0.17], [106, 0.20]]) {
      const shaft = new CylinderGeometry(span * 0.30, span * 0.30, height - 6, 3)
      const positions = shaft.getAttribute('position')
      for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) > 0) positions.setY(i, positions.getY(i) - 18 + positions.getX(i) / span * 54)
      }
      shaft.computeVertexNormals()
      shaft.translate(offset * span, (height + 6) / 2, 0)
      parts.push(paint(shaft, palette.glassShade))
    }
    const start = new Vector3(-span * 0.43, 9, span * 0.196)
    const end = new Vector3(span * 0.46, 78, span * 0.196)
    for (const [from, to] of [[start, end], [end, new Vector3(-span * 0.43, 130, span * 0.196)]]) {
      const brace = new BoxGeometry(from.distanceTo(to), 6, 6)
        .rotateZ(Math.atan2(to.y - from.y, to.x - from.x))
        .translate((from.x + to.x) / 2, (from.y + to.y) / 2, from.z)
      parts.push(paint(brace, palette.limestone))
    }
  }
  return merge(parts)
}

/** Ground-floor entrance centred on +Z; x extent ±90, forward projection 86. */
export function createEntranceGeometry(width: number, depth: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const frontage = depth / 2
  const scale = Math.min(1, width / 180)
  const entranceBox = (
    w: number, h: number, d: number, x: number, y: number, z: number, color: Color,
  ): void => box(parts, w * scale, h, d, x * scale, y, frontage + z, color)

  entranceBox(180, 4, 84, 0, 2, 44, palette.concrete)
  entranceBox(148, 4, 62, 0, 6, 33, palette.limestone)
  entranceBox(112, 4, 38, 0, 10, 21, palette.limestone)
  for (const x of [-46, 0, 46]) {
    entranceBox(x === 0 ? 3 : 6, 103, 6, x, 63.5, 12, palette.metal)
  }
  entranceBox(98, 6, 6, 0, 118, 12, palette.metal)
  entranceBox(98, 4, 6, 0, 14, 12, palette.metal)
  for (const x of [-23, 23]) {
    const pane = new PlaneGeometry(41 * scale, 98)
    pane.translate(x * scale, 65, frontage + 11)
    parts.push(paint(pane, palette.glassShade, 0.48))
    entranceBox(2, 22, 4, x < 0 ? -7 : 7, 63, 16, palette.limestone)
  }
  entranceBox(148, 7, 70, 0, 130.5, 37, palette.limestone)
  entranceBox(142, 2, 66, 0, 135, 37, palette.roof)
  for (const x of [-62, 62]) {
    entranceBox(4, 22, 4, x, 116, 12, palette.metal)
    entranceBox(24, 24, 32, x > 0 ? 76 : -76, 16, 29, palette.concrete)
    entranceBox(20, 2, 28, x > 0 ? 76 : -76, 29, 29, palette.soil)
    entranceBox(20, 14, 26, x > 0 ? 76 : -76, 36, 29, palette.foliage)
    entranceBox(16, 6, 20, x > 0 ? 76 : -76, 46, 29, palette.foliage)
  }
  return merge(parts)
}

/** Open-roof private office, centred on its main agent; footprint 260 × 300. */
export function createMainOfficeGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  box(parts, 260, 2, 300, 0, 1, 0, palette.trim)
  for (const x of [-130, 130]) {
    for (const z of [-150, 150]) box(parts, 5, 146, 5, x, 75, z, palette.metal)
    box(parts, 5, 5, 300, x, 147, 0, palette.metal)
    box(parts, 5, 18, 300, x, 11, 0, palette.limestone)
    const pane = new PlaneGeometry(295, 124).rotateY(Math.PI / 2).translate(x, 81, 0)
    parts.push(paint(pane, palette.glass, 0.24))
  }
  box(parts, 260, 5, 5, 0, 147, -150, palette.metal)
  box(parts, 260, 18, 5, 0, 11, -150, palette.limestone)
  parts.push(paint(new PlaneGeometry(255, 124).translate(0, 81, -150), palette.glassShade, 0.28))
  // A real opening in the front partition keeps the office entrance legible.
  box(parts, 170, 5, 5, -45, 147, 150, palette.metal)
  box(parts, 170, 18, 5, -45, 11, 150, palette.limestone)
  box(parts, 5, 146, 5, 40, 75, 150, palette.metal)
  parts.push(paint(new PlaneGeometry(165, 124).translate(-45, 81, 150), palette.glass, 0.24))
  box(parts, 104, 52, 4, 0, 98, -146, palette.limestone)
  box(parts, 62, 3, 2, -10, 108, -143, palette.trim)
  box(parts, 42, 3, 2, -20, 97, -143, palette.trim)
  return merge(parts)
}
