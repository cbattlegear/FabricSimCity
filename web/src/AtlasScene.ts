import * as THREE from 'three'
import { isFreshLive } from './atlas'
import { cityGeometrySignature, planAtlasCity, type AtlasCityPlan } from './atlasCity'
import { buildAtlasCityGeometry, PAD_HEIGHT, type AtlasCityGeometry } from './atlasCityBuildings'
import { fitDistance, MIN_FRAME_EXTENT, VIEW_DIRECTION } from './atlasFraming'
import { AtlasLayoutReservations, stableHash } from './atlasLayout'
import { createCityLabels, databaseLabelText, labelAnchor, type CityLabels } from './cityLabels'
import type { AtlasSnapshot, DatabaseAtlasItem, EdgeConfidence } from './contracts'

/**
 * The server atlas: one small city per database on a shared grid.
 *
 * A database is a city here and a city again when it is entered, so the two surfaces read as two
 * altitudes over one place rather than as two unrelated diagrams. What a city claims is stated in
 * {@link planAtlasCity}: plot side is allocated bytes, the tallest tower is used bytes, and the block
 * grid follows from the plot because block size is a single constant shared by every city. Skyline
 * shape, setbacks, and masts are decoration seeded from the database's stable id.
 *
 * Every city is named on the ground with the vocabulary the database city already uses. Without names
 * an atlas of a hundred cities can only be read by hovering each one in turn, which is not reading a
 * map.
 */

/**
 * Label height in world units for the atlas. Larger than the database city's, because the atlas frames
 * a 1,000-unit grid rather than a few blocks, and a name that cannot be read at the default framing is
 * worth no more than no name at all.
 */
export const ATLAS_LABEL_WORLD_HEIGHT = 11

/** Gap between a city's plot edge and its label plate. */
const LABEL_KERB = 7

type AtlasSceneCallbacks = {
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
}

type Beacon = { mesh: THREE.Mesh; phase: number }

export class AtlasScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 1, 3600)
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly interactive: THREE.Object3D[] = []
  private readonly beacons: Beacon[] = []
  private readonly layout = new AtlasLayoutReservations()
  private readonly resizeObserver: ResizeObserver
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private frame: number | null = null
  private hoveredId: string | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly callbacks: AtlasSceneCallbacks
  private readonly labels: CityLabels = createCityLabels(ATLAS_LABEL_WORLD_HEIGHT)
  /**
   * Merged city geometry keyed by everything that can change its shape. The atlas refreshes on a
   * thirty-second timer and a database's size has usually not moved, so rebuilding several thousand
   * boxes every refresh would be pure churn.
   */
  private readonly geometryCache = new Map<string, AtlasCityGeometry>()
  /** Materials carrying the selection highlight for one database. */
  private readonly cityMaterials = new Map<string, THREE.MeshStandardMaterial[]>()
  /** Everything owned by the current snapshot. Cached city geometry is deliberately not in here. */
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = []
  /** Extent of the cities in the current snapshot, including their label plates. */
  private readonly contentBounds = new THREE.Box3()
  private readonly frameCenter = new THREE.Vector3()
  private readonly frameExtents = new THREE.Vector3(MIN_FRAME_EXTENT, MIN_FRAME_EXTENT, MIN_FRAME_EXTENT)

  constructor(canvas: HTMLCanvasElement, callbacks: AtlasSceneCallbacks) {
    this.canvas = canvas
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x080c12, 1)
    this.frameCenter.set(0, 0, 0)

    this.scene.add(new THREE.HemisphereLight(0xc9e9ff, 0x17202a, 1.7))
    const key = new THREE.DirectionalLight(0xfff4d4, 2.8)
    key.position.set(-80, 160, 100)
    this.scene.add(key)

    const grid = new THREE.GridHelper(1240, 62, 0x38516a, 0x1a2735)
    grid.position.y = -0.2
    this.scene.add(grid)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerleave', this.handlePointerLeave)
    canvas.addEventListener('click', this.handleClick)
    this.reducedMotion.addEventListener('change', this.handleMotionPreference)
    this.resize()
  }

  setSnapshot(snapshot: AtlasSnapshot): void {
    this.clearAtlasObjects()
    this.contentBounds.makeEmpty()
    const centers = new Map<string, THREE.Vector3>()
    const liveSignatures = new Set<string>()

    const layout = this.layout.place(snapshot.databases.map(database => database.databaseId))
    for (const database of snapshot.databases) {
      const position = layout.get(database.databaseId)
      if (!position) continue
      const center = new THREE.Vector3(position.x, 0, position.z)
      centers.set(database.databaseId, center)
      liveSignatures.add(this.addDatabase(database, center, snapshot.generatedAt))
    }

    for (const [signature, geometry] of this.geometryCache) {
      if (liveSignatures.has(signature)) continue
      this.geometryCache.delete(signature)
      disposeCityGeometry(geometry)
    }

    for (const edge of snapshot.edges) {
      const from = centers.get(edge.fromDatabaseId)
      const to = centers.get(edge.toDatabaseId)
      if (from && to) this.addEdge(from, to, edge.confidence)
    }

    this.frameContent()
    this.render()
    this.syncAnimation()
  }

  setSelected(databaseId: string | null): void {
    for (const [id, materials] of this.cityMaterials) {
      for (const material of materials) material.emissiveIntensity = id === databaseId ? 0.75 : 0.08
    }
    this.render()
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.removeEventListener('click', this.handleClick)
    this.reducedMotion.removeEventListener('change', this.handleMotionPreference)
    this.clearAtlasObjects()
    for (const geometry of this.geometryCache.values()) disposeCityGeometry(geometry)
    this.geometryCache.clear()
    this.labels.dispose()
    this.renderer.dispose()
  }

  /** Places one database's city and returns the cache signature its geometry was built under. */
  private addDatabase(database: DatabaseAtlasItem, center: THREE.Vector3, generatedAt: string): string {
    const plan = planAtlasCity(database)
    const signature = cityGeometrySignature(plan)
    let geometry = this.geometryCache.get(signature)
    if (!geometry) {
      geometry = buildAtlasCityGeometry(plan)
      this.geometryCache.set(signature, geometry)
    }

    const tint = plan.sizeKnown ? colorFor(database.databaseId) : 0x637080
    const materials: THREE.MeshStandardMaterial[] = []

    // The pad is always present, so it is what a pointer finds over a city with no massing at all.
    const padMaterial = new THREE.MeshStandardMaterial({
      color: plan.sizeKnown ? 0x1d2a36 : 0x2a323b,
      roughness: 0.95,
      metalness: 0.02,
      transparent: !plan.sizeKnown,
      opacity: plan.sizeKnown ? 1 : 0.55,
      emissive: tint,
      emissiveIntensity: 0.08,
    })
    materials.push(padMaterial)
    this.addCityMesh(geometry.pad, padMaterial, center, database.databaseId, true)

    if (geometry.massing) {
      const massingMaterial = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.72,
        metalness: 0.08,
        emissive: tint,
        emissiveIntensity: 0.08,
      })
      materials.push(massingMaterial)
      this.addCityMesh(geometry.massing, massingMaterial, center, database.databaseId, true)
    }

    if (geometry.trim) {
      const trimMaterial = new THREE.MeshStandardMaterial({
        color: 0xdbe7f2,
        roughness: 0.5,
        metalness: 0.05,
        emissive: tint,
        emissiveIntensity: 0.08,
      })
      materials.push(trimMaterial)
      this.addCityMesh(geometry.trim, trimMaterial, center, database.databaseId, false)
    }

    if (geometry.streets) {
      const streetMaterial = new THREE.LineBasicMaterial({ color: 0x8fb4d4, transparent: true, opacity: 0.42 })
      const streets = new THREE.LineSegments(geometry.streets, streetMaterial)
      streets.position.copy(center)
      streets.userData.atlasObject = true
      this.disposables.push(streetMaterial)
      this.scene.add(streets)
    }

    this.cityMaterials.set(database.databaseId, materials)
    this.addLabel(database, plan, center)
    this.expandContentBounds(center, plan)

    if (!plan.sizeKnown) this.addUnknownMark(center)
    if (isFreshLive(database, generatedAt)) {
      this.addBeacon(center, PAD_HEIGHT + (plan.towerHeight ?? 0), database.databaseId)
    }
    return signature
  }

  private addCityMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    center: THREE.Vector3,
    databaseId: string,
    pickable: boolean,
  ): void {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(center)
    mesh.userData.databaseId = databaseId
    mesh.userData.atlasObject = true
    this.disposables.push(material)
    this.scene.add(mesh)
    if (pickable) this.interactive.push(mesh)
  }

  /**
   * Names a city on the pavement at the edge of its plot, in world space so it never leans with the
   * camera. The anchor is the south kerb, which is the side the default framing looks in from.
   */
  private addLabel(database: DatabaseAtlasItem, plan: AtlasCityPlan, center: THREE.Vector3): void {
    const sprite = this.labels.make(databaseLabelText(database.name))
    if (!sprite) return
    const anchor = labelAnchor(center.x, center.z, center.x, center.z + 1, plan.side / 2 + LABEL_KERB)
    sprite.position.set(anchor.x, PAD_HEIGHT + ATLAS_LABEL_WORLD_HEIGHT / 2, anchor.z)
    sprite.userData.atlasObject = true
    this.scene.add(sprite)

    // The rasterised sprite's own scale is the only honest source for how wide a name ended up.
    const halfWidth = sprite.scale.x / 2
    const halfHeight = sprite.scale.y / 2
    this.contentBounds.expandByPoint(new THREE.Vector3(anchor.x - halfWidth, 0, anchor.z - halfHeight))
    this.contentBounds.expandByPoint(
      new THREE.Vector3(anchor.x + halfWidth, sprite.position.y + halfHeight, anchor.z + halfHeight),
    )
  }

  private addUnknownMark(center: THREE.Vector3): void {
    const material = new THREE.MeshBasicMaterial({ color: 0xf2f5f7 })
    this.disposables.push(material)
    for (const rotation of [Math.PI / 4, -Math.PI / 4]) {
      const geometry = new THREE.BoxGeometry(28, 1.4, 2.2)
      const bar = new THREE.Mesh(geometry, material)
      bar.position.set(center.x, PAD_HEIGHT + 4, center.z)
      bar.rotation.y = rotation
      bar.userData.atlasObject = true
      this.disposables.push(geometry)
      this.scene.add(bar)
    }
  }

  private addBeacon(center: THREE.Vector3, height: number, databaseId: string): void {
    const geometry = new THREE.SphereGeometry(3.4, 16, 10)
    const material = new THREE.MeshBasicMaterial({ color: 0x72f4c4 })
    const beacon = new THREE.Mesh(geometry, material)
    beacon.position.set(center.x, height + 9, center.z)
    beacon.userData.atlasObject = true
    this.disposables.push(geometry, material)
    this.scene.add(beacon)
    this.beacons.push({ mesh: beacon, phase: (stableHash(databaseId) % 1000) / 100 })
  }

  private addEdge(from: THREE.Vector3, to: THREE.Vector3, confidence: EdgeConfidence): void {
    const points = [from.clone().setY(PAD_HEIGHT + 0.4), to.clone().setY(PAD_HEIGHT + 0.4)]
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = confidence === 'Confirmed'
      ? new THREE.LineBasicMaterial({ color: 0xe8edf2, transparent: true, opacity: 0.8 })
      : new THREE.LineDashedMaterial({
          color: confidence === 'Probable' ? 0xffc96b : 0x9aa7b4,
          dashSize: confidence === 'Probable' ? 8 : 1.5,
          gapSize: confidence === 'Probable' ? 5 : 7,
          transparent: true,
          opacity: 0.9,
        })
    const line = new THREE.Line(geometry, material)
    line.computeLineDistances()
    line.userData.atlasObject = true
    this.disposables.push(geometry, material)
    this.scene.add(line)
  }

  private clearAtlasObjects(): void {
    const removable = this.scene.children.filter(child => child.userData.atlasObject === true)
    for (const child of removable) this.scene.remove(child)
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
    this.interactive.length = 0
    this.beacons.length = 0
    this.cityMaterials.clear()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const bounds = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObjects(this.interactive, false)[0]
    const nextId = hit?.object.userData.databaseId as string | undefined
    const normalized = nextId ?? null
    if (normalized !== this.hoveredId) {
      this.hoveredId = normalized
      this.canvas.style.cursor = normalized ? 'pointer' : 'default'
      this.callbacks.onHover(normalized)
    }
  }

  private readonly handlePointerLeave = (): void => {
    this.hoveredId = null
    this.canvas.style.cursor = 'default'
    this.callbacks.onHover(null)
  }

  private readonly handleClick = (): void => {
    if (this.hoveredId) this.callbacks.onSelect(this.hoveredId)
  }

  private readonly handleMotionPreference = (): void => this.syncAnimation()

  private syncAnimation(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (this.beacons.length > 0 && !this.reducedMotion.matches) this.frame = requestAnimationFrame(this.animate)
    else this.render()
  }

  private readonly animate = (time: number): void => {
    for (const beacon of this.beacons) {
      beacon.mesh.scale.setScalar(0.85 + Math.sin(time * 0.004 + beacon.phase) * 0.18)
    }
    this.render()
    this.frame = requestAnimationFrame(this.animate)
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.placeCamera()
    this.render()
  }

  /**
   * Records how much room a city's plot needs. The label is accounted for separately in
   * {@link addLabel}, because it stands on one side only and its width is whatever the rasterised name
   * turned out to be — padding all four sides by a guess would claim ground no city occupies and push
   * the camera back for nothing.
   */
  private expandContentBounds(center: THREE.Vector3, plan: AtlasCityPlan): void {
    const reach = plan.side / 2
    const top = PAD_HEIGHT + (plan.towerHeight ?? 0)
    this.contentBounds.expandByPoint(new THREE.Vector3(center.x - reach, 0, center.z - reach))
    this.contentBounds.expandByPoint(new THREE.Vector3(center.x + reach, top, center.z + reach))
  }

  /** Re-centres the framing on the current snapshot's cities. */
  private frameContent(): void {
    if (this.contentBounds.isEmpty()) {
      this.frameCenter.set(0, 0, 0)
      this.frameExtents.set(MIN_FRAME_EXTENT, MIN_FRAME_EXTENT, MIN_FRAME_EXTENT)
    } else {
      this.contentBounds.getCenter(this.frameCenter)
      this.contentBounds.getSize(this.frameExtents).multiplyScalar(0.5)
      this.frameExtents.x = Math.max(this.frameExtents.x, MIN_FRAME_EXTENT)
      this.frameExtents.z = Math.max(this.frameExtents.z, MIN_FRAME_EXTENT)
    }
    this.placeCamera()
  }

  /**
   * Solves the camera distance for the current framing and viewport shape. Called on resize as well as
   * on snapshot, because a narrower panel needs to stand further back to hold the same cities.
   */
  private placeCamera(): void {
    const distance = fitDistance(this.frameExtents, this.camera.fov, this.camera.aspect)
    const reach = this.frameExtents.length()
    this.camera.position.set(
      this.frameCenter.x + VIEW_DIRECTION.x * distance,
      this.frameCenter.y + VIEW_DIRECTION.y * distance,
      this.frameCenter.z + VIEW_DIRECTION.z * distance,
    )
    this.camera.lookAt(this.frameCenter)
    this.camera.near = Math.max(1, distance - reach * 2)
    this.camera.far = distance + reach * 3
    this.camera.updateProjectionMatrix()
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}

function disposeCityGeometry(geometry: AtlasCityGeometry): void {
  geometry.pad.dispose()
  geometry.massing?.dispose()
  geometry.trim?.dispose()
  geometry.streets?.dispose()
}

function colorFor(databaseId: string): number {
  const palette = [0x39c6a3, 0x45a7e6, 0xe9a84c, 0xb48be8, 0x57bd70, 0xde6f73, 0x7bb7b2, 0xd58cb7]
  return palette[stableHash(databaseId) % palette.length] ?? 0x45a7e6
}
