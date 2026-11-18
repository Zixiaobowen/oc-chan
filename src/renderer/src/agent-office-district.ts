import { BoxGeometry, Color, IcosahedronGeometry, InstancedMesh, MeshLambertMaterial, Object3D } from 'three'
import { MAX_3D_NODES, officeStreetGrid, STREET_SETBACK, STREET_WIDTH, type OfficeBuilding } from './agent-topology-3d-layout'

/** Two draw calls, fixed capacities and shared geometry for the entire district. */
export class OfficeDistrict {
  readonly paving = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshLambertMaterial(), MAX_3D_NODES * 12 + 150)
  readonly crowns = new InstancedMesh(new IcosahedronGeometry(1, 1), new MeshLambertMaterial({ flatShading: true }), MAX_3D_NODES * 2)
  readonly meshes = [this.paving, this.crowns]
  private readonly transform = new Object3D()
  private readonly lawn = new Color('#a7ad91')
  private readonly road = new Color('#777e79')
  private readonly stone = new Color('#d6d2c3')
  private readonly shadow = new Color('#9d9e8e')
  private readonly wood = new Color('#796950')
  private readonly metal = new Color('#566761')
  private readonly lamp = new Color('#eee2bd')
  private readonly leaf = new Color('#7f9972')
  private readonly tint = new Color()

  update(buildings: OfficeBuilding[], ground: Color): void {
    this.paving.count = this.crowns.count = 0
    if (!buildings.length) return
    const { width, depth } = buildings[0]
    const grid = officeStreetGrid(width, depth)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const building of buildings) {
      minX = Math.min(minX, building.x)
      maxX = Math.max(maxX, building.x)
      minZ = Math.min(minZ, building.z)
      maxZ = Math.max(maxZ, building.z)
    }
    const columns = Math.round((maxX - minX) / grid.pitchX) + 1
    const rows = Math.round((maxZ - minZ) / grid.pitchZ) + 1
    const centreX = (minX + maxX) / 2, centreZ = (minZ + maxZ) / 2
    const spanX = columns * grid.pitchX + STREET_WIDTH
    const spanZ = rows * grid.pitchZ + STREET_WIDTH
    const dark = ground.r + ground.g + ground.b < 0.5
    const put = (mesh: InstancedMesh, x: number, y: number, z: number, w: number, h: number, d: number, color: Color) => {
      if (mesh.count >= mesh.instanceMatrix.count) throw new RangeError('Office district instance budget exceeded')
      this.transform.position.set(x, y, z)
      this.transform.scale.set(w, h, d)
      this.transform.updateMatrix()
      mesh.setMatrixAt(mesh.count, this.transform.matrix)
      mesh.setColorAt(mesh.count++, dark ? this.tint.copy(color).lerp(ground, 0.45) : color)
    }
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: Color) => put(this.paving, x, y, z, w, h, d, color)
    box(centreX, -32, centreZ, spanX + 100, 32, spanZ + 100, this.lawn)
    // Continuous orthogonal carriageways sit only at parcel boundaries.
    for (let column = 0; column <= columns; column++) {
      box(minX + (column - 0.5) * grid.pitchX, -14, centreZ, STREET_WIDTH, 4, spanZ, this.road)
    }
    for (let row = 0; row <= rows; row++) {
      box(centreX, -14, minZ + (row - 0.5) * grid.pitchZ, spanX, 4, STREET_WIDTH, this.road)
    }
    for (let index = 0; index < buildings.length; index++) {
      const building = buildings[index]
      const { x, z } = building
      const facing = Math.round(z / grid.pitchZ) % 2 === 0 ? 1 : -1
      box(x, -10, z, width + STREET_SETBACK * 2, 8, depth + STREET_SETBACK * 2, this.stone)
      // Two nested contact bands ground the model without a shadow map.
      box(x + 9, -5.5, z - 7, width + 44, 1, depth + 46, this.shadow)
      box(x, -5, z, width + 18, 2, depth + 18, this.shadow)
      const sidewalkZ = z + facing * (depth / 2 + 87)
      const lampX = x + width / 2 + 64
      box(lampX, 36, sidewalkZ, 5, 84, 5, this.metal)
      box(lampX - 8, 78, sidewalkZ, 20, 5, 12, this.metal)
      box(lampX - 8, 74, sidewalkZ, 15, 3, 9, this.lamp)
      if (index % 3 === 0) {
        const treeX = x - width / 2 - 64
        box(treeX, -3, sidewalkZ, 60, 4, 60, this.lawn)
        box(treeX, 29, sidewalkZ, 10, 64, 10, this.wood)
        put(this.crowns, treeX, 78, sidewalkZ, 37, 49, 34, this.leaf)
        put(this.crowns, treeX + 17, 64, sidewalkZ + 9, 25, 30, 27, this.leaf)
      }
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }
  }
}
