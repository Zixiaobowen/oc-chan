import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry,
  LatheGeometry, Quaternion, SphereGeometry, Vector2, Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

type Point = readonly [number, number, number]

const palette = {
  skin: 0xc99576,
  hair: 0x332b29,
  shirt: 0x607d91,
  collar: 0x91a8b5,
  trousers: 0x343e4b,
  shoes: 0x252b32,
  eye: 0xe7ddd2,
  pupil: 0x302d2b,
  mouth: 0x925f4e,
  wood: 0xb89970,
  metal: 0x58646b,
  frame: 0x303b43,
  screen: 0x91bbc9,
  screenDetail: 0xbcd5dc,
  upholstery: 0x526c7c,
}

/** Parts stay indexed; Color converts the sRGB palette to linear vertex colors. */
class GeometryParts {
  private readonly parts: BufferGeometry[] = []
  private readonly color = new Color()
  private readonly up = new Vector3(0, 1, 0)
  private readonly direction = new Vector3()
  private readonly rotation = new Quaternion()

  add(geometry: BufferGeometry, color: number, position: Point): void {
    geometry.translate(...position)
    geometry.deleteAttribute('uv')
    this.color.setHex(color)
    const colors = new Float32Array(geometry.getAttribute('position').count * 3)
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = this.color.r
      colors[i + 1] = this.color.g
      colors[i + 2] = this.color.b
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    this.parts.push(geometry)
  }

  box(size: Point, position: Point, color: number): void {
    this.add(new BoxGeometry(...size), color, position)
  }

  oval(size: Point, position: Point, color: number, segments = 6, rings = 4): void {
    this.add(new SphereGeometry(1, segments, rings).scale(...size), color, position)
  }

  limb(start: Point, end: Point, top: number, bottom: number, color: number): void {
    this.direction.set(end[0] - start[0], end[1] - start[1], end[2] - start[2])
    const geometry = new CylinderGeometry(bottom, top, this.direction.length(), 6)
    this.rotation.setFromUnitVectors(this.up, this.direction.normalize())
    geometry.applyQuaternion(this.rotation)
    this.add(geometry, color, [
      (start[0] + end[0]) / 2,
      (start[1] + end[1]) / 2,
      (start[2] + end[2]) / 2,
    ])
  }

  finish(): BufferGeometry {
    try {
      const geometry = mergeGeometries(this.parts, false)
      if (!geometry) throw new Error('Unable to merge office model geometry')
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      return geometry
    } finally {
      for (const part of this.parts) part.dispose()
      this.parts.length = 0
    }
  }
}

/** Floor is y=-40, crown y=65. The face and shoes point toward -Z. */
export function createEmployeeGeometry(): BufferGeometry {
  const parts = new GeometryParts()

  // A shaped shirt: narrow hem, broad shoulders and a visible collar/neck.
  const shirtProfile = [
    new Vector2(0, 1), new Vector2(12, 1), new Vector2(13, 10),
    new Vector2(16, 29), new Vector2(13, 34), new Vector2(6, 37),
    new Vector2(0, 37),
  ]
  parts.add(new LatheGeometry(shirtProfile, 8).scale(1, 1, 0.58), palette.shirt, [0, 0, 0])
  parts.add(new CylinderGeometry(5.5, 6.5, 3, 8).scale(1, 1, 0.8), palette.collar, [0, 37, 0])
  parts.add(new CylinderGeometry(4.3, 4.8, 8, 8), palette.skin, [0, 41, 0])
  parts.oval([9.6, 11, 8.2], [0, 53, 0], palette.skin, 8, 6)
  parts.oval([1.8, 3.2, 2.1], [-9.3, 53, 0], palette.skin, 6, 3)
  parts.oval([1.8, 3.2, 2.1], [9.3, 53, 0], palette.skin, 6, 3)

  // Cropped hair exposes the forehead and face; the rear volume is separate.
  parts.add(new SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, 1.15)
    .scale(10, 10.2, 8.6), palette.hair, [0, 54.8, 0])
  parts.oval([8.5, 7, 4], [0, 56, 5], palette.hair)
  parts.box([1.8, 7, 4], [-8.7, 56, 1], palette.hair)
  parts.box([1.8, 7, 4], [8.7, 56, 1], palette.hair)
  for (const x of [-3.4, 3.4]) {
    parts.box([2.6, 1.5, 0.8], [x, 55, -7.7], palette.eye)
    parts.box([1.1, 1.3, 0.5], [x, 55, -8.2], palette.pupil)
    parts.box([3, 0.7, 0.7], [x, 57, -7.5], palette.hair)
  }
  parts.oval([1.5, 2.2, 2.1], [0, 52.5, -8], palette.skin, 6, 3)
  parts.box([3.2, 0.6, 0.6], [0, 49, -7.6], palette.mouth)

  // Seated posture: forearms reach the keyboard, thighs turn toward the desk.
  parts.oval([5.6, 6.2, 5.3], [-15, 29, 0], palette.shirt)
  parts.oval([5.6, 6.2, 5.3], [15, 29, 0], palette.shirt)
  parts.limb([-16, 29, 0], [-20, 12, -10], 4.8, 4, palette.shirt)
  parts.limb([16, 29, 0], [20, 12, -10], 4.8, 4, palette.shirt)
  parts.limb([-20, 12, -10], [-12, 5, -32], 3.5, 2.7, palette.skin)
  parts.limb([20, 12, -10], [12, 5, -32], 3.5, 2.7, palette.skin)
  parts.oval([3.2, 2.5, 5], [-12, 5, -34], palette.skin)
  parts.oval([3.2, 2.5, 5], [12, 5, -34], palette.skin)

  parts.box([23, 8, 14], [0, 0, 0], palette.trousers)
  for (const x of [-7, 7]) {
    parts.limb([x, 0, 0], [x, -3, -22], 5.5, 4.5, palette.trousers)
    parts.limb([x, -3, -22], [x, -34, -24], 4.5, 3.6, palette.trousers)
    parts.box([9, 6, 16], [x, -37, -29], palette.shoes)
  }

  return parts.finish()
}

/** Desk segments meet at the 140-unit seat pitch to form open shared benches. */
export function createWorkstationGeometry(): BufferGeometry {
  const parts = new GeometryParts()
  parts.box([140, 4, 52], [0, 2, -48], palette.wood)
  for (const x of [-62, 62]) {
    for (const z of [-68, -28]) {
      parts.box([4, 40, 4], [x, -20, z], palette.metal)
    }
  }
  parts.box([132, 6, 3], [0, -5, -68], palette.metal)

  parts.box([20, 2, 12], [0, 5, -62], palette.frame)
  parts.box([4, 13, 4], [0, 11.5, -62], palette.metal)
  parts.box([48, 32, 3], [0, 29, -62], palette.frame)
  // The inset screen is on the +Z face, toward the standing employee.
  parts.box([44, 28, 0.6], [0, 29.5, -60.2], palette.screen)
  parts.box([34, 2, 0.3], [0, 38, -59.75], palette.screenDetail)
  parts.box([21, 1.5, 0.3], [-6.5, 33, -59.75], palette.screenDetail)
  parts.box([27, 1.5, 0.3], [-3.5, 29, -59.75], palette.screenDetail)
  parts.box([27, 1.5, 9], [-3, 4.75, -36], palette.frame)
  for (const z of [-38.5, -36, -33.5]) {
    parts.box([23, 0.6, 1.1], [-3, 5.8, z], palette.metal)
  }
  parts.oval([3, 1.3, 4], [17, 5.3, -36], palette.frame)

  // The seat supports the employee's hips; the backrest stays behind the torso.
  parts.box([28, 5, 26], [0, -4, 0], palette.upholstery)
  parts.box([27, 25, 4], [0, 8, 14], palette.upholstery)
  parts.box([4, 22, 4], [0, -10, 12], palette.frame)
  parts.add(new CylinderGeometry(2.3, 2.3, 27, 6), palette.metal, [0, -20, 0])
  for (const [x, z] of [[-16, 0], [16, 0], [0, -16], [0, 16]]) {
    parts.limb([0, -33, 0], [x, -36, z], 1.8, 1.8, palette.frame)
    parts.box([5, 5, 5], [x, -37.5, z], palette.frame)
  }

  return parts.finish()
}
