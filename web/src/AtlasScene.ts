import * as THREE from 'three'
import { databaseSide, isFreshLive } from './atlas'
import { layoutStableIds, stableHash } from './atlasLayout'
import type { AtlasSnapshot, DatabaseAtlasItem, EdgeConfidence } from './contracts'

type AtlasSceneCallbacks = {
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
}

type Beacon = { mesh: THREE.Mesh; phase: number }

export class AtlasScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 1, 2200)
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly interactive: THREE.Object3D[] = []
  private readonly beacons: Beacon[] = []
  private readonly resizeObserver: ResizeObserver
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private frame: number | null = null
  private hoveredId: string | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly callbacks: AtlasSceneCallbacks

  constructor(canvas: HTMLCanvasElement, callbacks: AtlasSceneCallbacks) {
    this.canvas = canvas
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x080c12, 1)
    this.camera.position.set(560, 680, 820)
    this.camera.lookAt(0, 0, 0)

    this.scene.add(new THREE.HemisphereLight(0xc9e9ff, 0x17202a, 1.7))
    const key = new THREE.DirectionalLight(0xfff4d4, 2.8)
    key.position.set(-80, 160, 100)
    this.scene.add(key)

    const grid = new THREE.GridHelper(1040, 52, 0x38516a, 0x1a2735)
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
    const centers = new Map<string, THREE.Vector3>()

    const layout = layoutStableIds(snapshot.databases.map(database => database.databaseId))
    for (const database of snapshot.databases) {
      const position = layout.get(database.databaseId)
      if (!position) continue
      const center = new THREE.Vector3(position.x, 0, position.z)
      centers.set(database.databaseId, center)
      this.addDatabase(database, center, snapshot.generatedAt)
    }

    for (const edge of snapshot.edges) {
      const from = centers.get(edge.fromDatabaseId)
      const to = centers.get(edge.toDatabaseId)
      if (from && to) this.addEdge(from, to, edge.confidence)
    }

    this.render()
    this.syncAnimation()
  }

  setSelected(databaseId: string | null): void {
    for (const object of this.interactive) {
      const material = (object as THREE.Mesh).material
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissiveIntensity = object.userData.databaseId === databaseId ? 0.75 : 0.08
      }
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
    this.renderer.dispose()
  }

  private addDatabase(database: DatabaseAtlasItem, center: THREE.Vector3, generatedAt: string): void {
    const side = databaseSide(database)
    const isUnknown = side === null
    const footprint = side ?? 24
    const height = isUnknown ? 3 : 18
    const geometry = new THREE.BoxGeometry(footprint, height, footprint)
    const material = new THREE.MeshStandardMaterial({
      color: isUnknown ? 0x637080 : colorFor(database.databaseId),
      roughness: 0.72,
      metalness: 0.08,
      transparent: isUnknown,
      opacity: isUnknown ? 0.48 : 1,
      emissive: isUnknown ? 0x000000 : colorFor(database.databaseId),
      emissiveIntensity: 0.08,
    })
    const block = new THREE.Mesh(geometry, material)
    block.position.set(center.x, height / 2, center.z)
    block.userData.databaseId = database.databaseId
    block.userData.atlasObject = true
    this.scene.add(block)
    this.interactive.push(block)

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: isUnknown ? 0xd3dce5 : 0xe4f2ff, transparent: true, opacity: 0.45 }),
    )
    outline.position.copy(block.position)
    outline.userData.atlasObject = true
    this.scene.add(outline)

    if (isUnknown) this.addUnknownMark(center)
    if (isFreshLive(database, generatedAt)) this.addBeacon(center, height, database.databaseId)
  }

  private addUnknownMark(center: THREE.Vector3): void {
    for (const rotation of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(28, 1.4, 2.2),
        new THREE.MeshBasicMaterial({ color: 0xf2f5f7 }),
      )
      bar.position.set(center.x, 5.2, center.z)
      bar.rotation.y = rotation
      bar.userData.atlasObject = true
      this.scene.add(bar)
    }
  }

  private addBeacon(center: THREE.Vector3, height: number, databaseId: string): void {
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0x72f4c4 }),
    )
    beacon.position.set(center.x, height + 5, center.z)
    beacon.userData.atlasObject = true
    this.scene.add(beacon)
    this.beacons.push({ mesh: beacon, phase: (stableHash(databaseId) % 1000) / 100 })
  }

  private addEdge(from: THREE.Vector3, to: THREE.Vector3, confidence: EdgeConfidence): void {
    const points = [from.clone().setY(1), to.clone().setY(1)]
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
    this.scene.add(line)
  }

  private clearAtlasObjects(): void {
    const removable = this.scene.children.filter(child => child.userData.atlasObject === true)
    for (const child of removable) {
      this.scene.remove(child)
      child.traverse(object => {
        if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) object.geometry.dispose()
        if ('material' in object) {
          const material = object.material as THREE.Material | THREE.Material[]
          const materials = Array.isArray(material) ? material : [material]
          materials.forEach(item => item.dispose())
        }
      })
    }
    this.interactive.length = 0
    this.beacons.length = 0
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
    this.camera.updateProjectionMatrix()
    this.render()
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}

function colorFor(databaseId: string): number {
  const palette = [0x39c6a3, 0x45a7e6, 0xe9a84c, 0xb48be8, 0x57bd70, 0xde6f73, 0x7bb7b2, 0xd58cb7]
  return palette[stableHash(databaseId) % palette.length] ?? 0x45a7e6
}
