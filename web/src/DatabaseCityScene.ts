import * as THREE from 'three'
import { directActivityWidth, shouldRenderRoute } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityRoute } from './databaseCityContracts'

export type DatabaseCitySceneController = {
  setData(objects: readonly DatabaseCityObject[], routes: readonly DatabaseCityRoute[]): void
  setSelected(objectId: string | null): void
  dispose(): void
}

type SceneOptions = {
  onSelect: (objectId: string) => void
}

const knownMaterial = new THREE.MeshStandardMaterial({ color: 0x1b5b64, roughness: 0.72, metalness: 0.12 })
const unknownMaterial = new THREE.MeshBasicMaterial({ color: 0x6e7d88, wireframe: true })
const indexMaterial = new THREE.MeshStandardMaterial({ color: 0x68d6c1, roughness: 0.5 })
const unknownIndexMaterial = new THREE.MeshBasicMaterial({ color: 0x82919d, wireframe: true })
const exposureMaterial = new THREE.MeshStandardMaterial({ color: 0xe2a957, emissive: 0x332000, roughness: 0.58 })
const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x0b151e, roughness: 0.96 })
const confirmedRouteMaterial = new THREE.LineBasicMaterial({ color: 0xc9d5dd })
const probableRouteMaterial = new THREE.LineDashedMaterial({ color: 0xe2a957, dashSize: 8, gapSize: 5 })
const unknownRouteMaterial = new THREE.LineDashedMaterial({ color: 0x82919d, dashSize: 2, gapSize: 7 })

export function createDatabaseCityScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): DatabaseCitySceneController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x091018)
  scene.fog = new THREE.Fog(0x091018, 420, 900)
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 1400)
  camera.position.set(185, 205, 285)
  camera.lookAt(150, 0, 30)
  scene.add(new THREE.HemisphereLight(0xb7def1, 0x101820, 1.7))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(180, 260, 120)
  scene.add(key)

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 600), groundMaterial)
  ground.rotation.x = -Math.PI / 2
  ground.position.set(180, -0.5, 80)
  scene.add(ground)

  const objectGeometry = new THREE.BoxGeometry(1, 1, 1)
  const indexGeometry = new THREE.BoxGeometry(1, 1, 1)
  const exposureGeometry = new THREE.BoxGeometry(1, 1, 1)
  const objectPool: THREE.Mesh[] = []
  const indexPool: THREE.Mesh[] = []
  const exposurePool: THREE.Mesh[] = []
  const routePool: THREE.Line[] = []
  const activeObjects: THREE.Mesh[] = []
  const activeIndexes: THREE.Mesh[] = []
  const activeExposure: THREE.Mesh[] = []
  const activeRoutes: THREE.Line[] = []
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let selectedId: string | null = null

  const acquire = (
    pool: THREE.Mesh[],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) => {
    const mesh = pool.pop() ?? new THREE.Mesh(geometry, material)
    mesh.visible = true
    scene.add(mesh)
    return mesh
  }

  const release = (active: THREE.Mesh[], pool: THREE.Mesh[]) => {
    while (active.length > 0) {
      const mesh = active.pop()!
      scene.remove(mesh)
      mesh.visible = false
      mesh.userData.objectId = undefined
      pool.push(mesh)
    }
  }

  const releaseRoutes = () => {
    while (activeRoutes.length > 0) {
      const line = activeRoutes.pop()!
      scene.remove(line)
      routePool.push(line)
    }
  }

  const render = () => {
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    if (canvas.width !== Math.round(width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    renderer.render(scene, camera)
  }

  const selectStyle = () => {
    for (const mesh of activeObjects) {
      const selected = mesh.userData.objectId === selectedId
      mesh.scale.x = mesh.userData.baseScaleX * (selected ? 1.1 : 1)
      mesh.scale.z = mesh.userData.baseScaleZ * (selected ? 1.1 : 1)
    }
    render()
  }

  const setData = (objects: readonly DatabaseCityObject[], routes: readonly DatabaseCityRoute[]) => {
    release(activeObjects, objectPool)
    release(activeIndexes, indexPool)
    release(activeExposure, exposurePool)
    releaseRoutes()
    const positions = new Map(objects.map(object => [
      object.objectId,
      new THREE.Vector3(object.layout.x, 1.2, object.layout.z),
    ]))
    const visibleObjectIds = new Set(positions.keys())

    for (const object of objects) {
      const known = object.reservedPages8KiB !== null && object.usedPages8KiB !== null
      const reservedPages = known ? Number(BigInt(object.reservedPages8KiB!)) : 0
      const usedPages = known ? Number(BigInt(object.usedPages8KiB!)) : 0
      const footprint = known ? 11 + Math.log2(1 + Math.max(0, reservedPages)) * 0.78 : 14
      const height = known ? 4 + Math.log2(1 + Math.max(0, usedPages)) * 1.08 : 8
      const mesh = acquire(objectPool, objectGeometry, known ? knownMaterial : unknownMaterial)
      mesh.material = known ? knownMaterial : unknownMaterial
      mesh.position.set(object.layout.x, height / 2, object.layout.z)
      mesh.scale.set(footprint, height, footprint)
      mesh.userData.objectId = object.objectId
      mesh.userData.baseScaleX = footprint
      mesh.userData.baseScaleZ = footprint
      activeObjects.push(mesh)

      object.indexes.forEach((index, indexOrdinal) => {
        const activityWidth = directActivityWidth(index.directActivity.totalOperations)
        const attached = acquire(indexPool, indexGeometry, activityWidth === null ? unknownIndexMaterial : indexMaterial)
        attached.material = activityWidth === null ? unknownIndexMaterial : indexMaterial
        attached.position.set(
          object.layout.x + footprint / 2 + 2.5,
          1.2 + indexOrdinal * 2,
          object.layout.z,
        )
        attached.scale.set(activityWidth ?? 4, 1.2, Math.max(5, footprint * 0.72))
        attached.userData.objectId = object.objectId
        activeIndexes.push(attached)
      })

      if (object.attributedExposure.totalCpuMicroseconds !== null) {
        const cap = acquire(exposurePool, exposureGeometry, exposureMaterial)
        cap.position.set(object.layout.x, height + 0.7, object.layout.z)
        const cpu = Number(BigInt(object.attributedExposure.totalCpuMicroseconds))
        cap.scale.set(footprint * 0.72, 0.5 + Math.log2(1 + Math.max(0, cpu)) * 0.04, footprint * 0.72)
        cap.userData.objectId = object.objectId
        activeExposure.push(cap)
      }
    }
    routes.forEach((route, routeOrdinal) => {
      if (!shouldRenderRoute(route, visibleObjectIds)) return
      const from = positions.get(route.fromObjectId)
      if (!from) return
      const to = positions.get(route.toId) ?? new THREE.Vector3(
        from.x + 54 + (routeOrdinal % 3) * 18,
        1.2,
        from.z + 62 + Math.floor(routeOrdinal / 3) * 18,
      )
      const geometry = routePool.length > 0
        ? routePool[routePool.length - 1]!.geometry
        : new THREE.BufferGeometry()
      const line = routePool.pop() ?? new THREE.Line(geometry)
      line.geometry.setFromPoints([from, to])
      line.material = route.confidence === 'Confirmed'
        ? confirmedRouteMaterial
        : route.confidence === 'Probable'
          ? probableRouteMaterial
          : unknownRouteMaterial
      line.computeLineDistances()
      scene.add(line)
      activeRoutes.push(line)
    })
    if (activeObjects.length > 0) {
      scene.updateMatrixWorld(true)
      const bounds = new THREE.Box3()
      for (const mesh of activeObjects) bounds.expandByObject(mesh)
      const center = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const span = Math.max(size.x, size.z, 160)
      const fitSpan = Math.max(size.z + 80, (size.x + 80) / Math.max(camera.aspect, 1), size.y * 4, 160)
      camera.position.set(center.x + fitSpan * 0.75, center.y + fitSpan * 0.8, center.z + fitSpan)
      camera.near = Math.max(0.1, fitSpan / 1000)
      camera.far = Math.max(span, fitSpan) * 12
      camera.lookAt(center)
      camera.updateProjectionMatrix()
      ground.position.set(center.x, -0.5, center.z)
      ground.scale.set(Math.max(1, (size.x + 240) / 900), Math.max(1, (size.z + 240) / 600), 1)
      scene.fog = new THREE.Fog(0x091018, fitSpan * 2, Math.max(span, fitSpan) * 8)
    }
    selectStyle()
  }

  const onPointerDown = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect()
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects([...activeObjects, ...activeIndexes, ...activeExposure], false)[0]
    const objectId = hit?.object.userData.objectId
    if (typeof objectId === 'string') options.onSelect(objectId)
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  const resize = new ResizeObserver(render)
  resize.observe(canvas)
  render()

  return {
    setData,
    setSelected(objectId) {
      selectedId = objectId
      selectStyle()
    },
    dispose() {
      resize.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      renderer.dispose()
      objectGeometry.dispose()
      indexGeometry.dispose()
      exposureGeometry.dispose()
      for (const line of [...activeRoutes, ...routePool]) line.geometry.dispose()
    },
  }
}
