/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'

/**
 * The vehicle kit is fetched separately from the scenery kit, and this is the contract for why.
 *
 * `loadCityAssets` resolves one `Promise.all` behind one `.catch`, so *any* rejection in it resolves
 * the whole thing to null. That is right for what is in it: landmarks and scenery are decoration, and
 * a city that loses its trees is still a correct city drawn with procedural shells.
 *
 * Vehicles are not decoration. A vehicle is a statement that a particular query was running when the
 * collector last looked, and an empty street is itself a finding — it says nothing was sampled there.
 * So if a failed fetch of a *bush* could delete the vehicles, a network hiccup would silently turn a
 * busy instance into one that looks idle. That is a decorative failure being laundered into a false
 * claim about the database, and it is the one coupling this file exists to prevent.
 */

const loadAsync = vi.fn<(url: string) => Promise<{ scene: THREE.Object3D }>>()

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync(url: string) {
      return loadAsync(url)
    }
  },
}))

/** A scene graph shaped the way the exporter writes one: `asset__role` mesh names. */
function kitScene(names: readonly string[]): THREE.Object3D {
  const root = new THREE.Object3D()
  for (const name of names) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mesh.name = name
    root.add(mesh)
  }
  return root
}

const VEHICLE_MESHES = [
  'vehicle_bike__body', 'vehicle_bike__metal', 'vehicle_bike__trim',
  'vehicle_car__body', 'vehicle_car__glass', 'vehicle_car__metal',
  'vehicle_van__body', 'vehicle_van__glass', 'vehicle_van__metal', 'vehicle_van__trim',
  'vehicle_semi_truck__body', 'vehicle_semi_truck__glass',
  'vehicle_semi_truck__metal', 'vehicle_semi_truck__trim',
]

async function assets() {
  return await import('./cityAssets')
}

beforeEach(async () => {
  vi.resetModules()
  loadAsync.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a scenery failure cannot erase the vehicles', () => {
  /*
   * Mutation checked: folding `loadKit(vehiclesUrl)` into `loadCityAssets`'s `Promise.all` — the
   * obvious tidier version — makes this test return null for the vehicle kit and fail.
   */
  it('still loads the vehicle kit when the scenery kit rejects', async () => {
    loadAsync.mockImplementation(url =>
      url.includes('vehicles')
        ? Promise.resolve({ scene: kitScene(VEHICLE_MESHES) })
        : Promise.reject(new Error('404 scenery.glb')))

    const { loadCityAssets, loadVehicleAssets, VEHICLE_ASSETS } = await assets()
    expect(await loadCityAssets()).toBeNull()

    const vehicles = await loadVehicleAssets()
    expect(vehicles).not.toBeNull()
    for (const asset of VEHICLE_ASSETS) expect(vehicles?.has(asset), asset).toBe(true)
  })

  it('still loads the scenery kit when the vehicle kit rejects', async () => {
    loadAsync.mockImplementation(url =>
      url.includes('vehicles')
        ? Promise.reject(new Error('404 vehicles.glb'))
        : Promise.resolve({ scene: kitScene(['tree_round__trunk', 'tree_round__leaf']) }))

    const { loadCityAssets, loadVehicleAssets } = await assets()
    expect(await loadVehicleAssets()).toBeNull()
    expect(await loadCityAssets()).not.toBeNull()
  })

  it('resolves null rather than rejecting, so a caller cannot forget to handle the failure', async () => {
    loadAsync.mockRejectedValue(new Error('offline'))
    const { loadVehicleAssets } = await assets()
    await expect(loadVehicleAssets()).resolves.toBeNull()
  })

  it('fetches each kit once, however many scenes ask for it', async () => {
    loadAsync.mockResolvedValue({ scene: kitScene(VEHICLE_MESHES) })
    const { loadVehicleAssets } = await assets()
    const [first, second] = await Promise.all([loadVehicleAssets(), loadVehicleAssets()])
    expect(first).toBe(second)
    expect(loadAsync).toHaveBeenCalledTimes(1)
  })

  /*
   * Mutation checked: leaving `pendingVehicles` out of `resetCityAssets` makes this return the
   * previous test's cached failure, so a suite that reset between cases would silently keep it.
   */
  it('clears both caches on reset, not just the scenery one', async () => {
    loadAsync.mockRejectedValueOnce(new Error('first attempt fails'))
    const { loadVehicleAssets, resetCityAssets } = await assets()
    expect(await loadVehicleAssets()).toBeNull()

    resetCityAssets()
    loadAsync.mockResolvedValue({ scene: kitScene(VEHICLE_MESHES) })
    expect(await loadVehicleAssets()).not.toBeNull()
  })
})

describe('the exported vehicle kit contains what the scene asks for', () => {
  const glb = readFileSync(new URL('./assets/vehicles.glb', import.meta.url))

  /** Mesh node names, read out of the GLB's JSON chunk without a GL context. */
  function meshNames(): string[] {
    const jsonLength = glb.readUInt32LE(12)
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as {
      meshes?: { name?: string }[]
      accessors?: { min?: number[]; max?: number[] }[]
      nodes?: { name?: string; mesh?: number }[]
    }
    return (json.nodes ?? []).filter(node => node.mesh !== undefined).map(node => node.name ?? '')
  }

  it('is a glTF 2.0 binary the loader will accept', () => {
    expect(glb.subarray(0, 4).toString('ascii')).toBe('glTF')
    expect(glb.readUInt32LE(4)).toBe(2)
    expect(glb.readUInt32LE(8)).toBe(glb.length)
  })

  /*
   * The check the exporter log cannot make.
   *
   * `parseName` drops any mesh whose name is not `asset__role`, silently — a renamed part would
   * simply stop being drawn, and a vehicle missing its wheels looks like a styling choice rather
   * than a broken build.
   */
  it('names every mesh so that none is dropped on load', () => {
    const names = meshNames()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name, name).toMatch(/^vehicle_[a-z_]+__(body|trim|glass|metal)$/)
    }
  })

  it('carries all four classes, since a missing one would silently drop a whole size band', () => {
    const names = meshNames()
    for (const asset of ['vehicle_bike', 'vehicle_car', 'vehicle_van', 'vehicle_semi_truck']) {
      expect(names.some(name => name.startsWith(`${asset}__`)), asset).toBe(true)
    }
  })

  /*
   * The ladder, measured off the artefact rather than asserted about it.
   *
   * Size is the only channel these four carry, so if the export ever produced a van shorter than a
   * car the map would state the wrong ordering with complete confidence. The scene's `VEHICLE_SIZE`
   * table is a copy of these numbers for the procedural fallback, so this also pins the two together.
   */
  it('keeps the four shells in strictly increasing length', () => {
    const lengths = classLengths()
    expect(lengths.vehicle_bike).toBeLessThan(lengths.vehicle_car)
    expect(lengths.vehicle_car).toBeLessThan(lengths.vehicle_van)
    expect(lengths.vehicle_van).toBeLessThan(lengths.vehicle_semi_truck)
    // Roughly a doubling per rung, which is what survives being a few pixels long on a map.
    expect(lengths.vehicle_semi_truck / lengths.vehicle_bike).toBeGreaterThan(5)
  })

  it('matches the dimensions the scene falls back to when the kit does not load', () => {
    const lengths = classLengths()
    // Kept in step with VEHICLE_SIZE in DatabaseCityScene.ts, so a fallback box is the same size as
    // the shell it replaces and the ladder does not change when the network does.
    const scene = readFileSync(new URL('./DatabaseCityScene.ts', import.meta.url), 'utf8')
    const table = scene.slice(scene.indexOf('const VEHICLE_SIZE'), scene.indexOf('const VEHICLE_SPEED'))
    for (const [asset, key] of [
      ['vehicle_bike', 'bike'], ['vehicle_car', 'car'],
      ['vehicle_van', 'van'], ['vehicle_semi_truck', 'semiTruck'],
    ] as const) {
      const declared = new RegExp(`${key}: \\{[^}]*length: ([\\d.]+)`).exec(table)
      expect(declared, key).not.toBeNull()
      expect(Number(declared![1]), key).toBeCloseTo(lengths[asset], 1)
    }
  })

  /*
   * Which way the shells face, verified rather than assumed.
   *
   * Blender authors these nose-first along +Y and the exporter's y-up conversion turns that into
   * +Z, so the scene yaws with `atan2(dx, dz)`. Get the convention wrong and every vehicle drives
   * backwards down its road — visible immediately in a browser, invisible to every other test here.
   * Each shell's glass sits ahead of its body's centre, which is the asymmetry that pins it.
   */
  it('points every shell nose-first along +Z', () => {
    const boxes = assetBoxes()
    for (const asset of ['vehicle_car', 'vehicle_van', 'vehicle_semi_truck']) {
      const glass = boxes.get(`${asset}__glass`)
      const body = boxes.get(`${asset}__body`)
      expect(glass, asset).toBeDefined()
      expect(body, asset).toBeDefined()
      const bodyCentre = (body!.min[2] + body!.max[2]) / 2
      const glassCentre = (glass!.min[2] + glass!.max[2]) / 2
      expect(glassCentre, `${asset} windscreen should sit ahead of the body centre`)
        .toBeGreaterThan(bodyCentre)
    }
  })

  it('rests every shell on the ground plane rather than floating or sinking', () => {
    for (const [name, box] of assetBoxes()) {
      expect(box.min[1], name).toBeGreaterThan(-0.01)
    }
  })

  type Box = { min: number[]; max: number[] }

  /** Per-mesh POSITION bounds, read from the accessor min/max the exporter already wrote. */
  function assetBoxes(): Map<string, Box> {
    const jsonLength = glb.readUInt32LE(12)
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as {
      meshes: { primitives: { attributes: { POSITION: number } }[] }[]
      accessors: { min: number[]; max: number[] }[]
      nodes: { name?: string; mesh?: number }[]
    }
    const boxes = new Map<string, Box>()
    for (const node of json.nodes) {
      if (node.mesh === undefined) continue
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (const primitive of json.meshes[node.mesh].primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION]
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], accessor.min[axis])
          max[axis] = Math.max(max[axis], accessor.max[axis])
        }
      }
      boxes.set(node.name ?? '', { min, max })
    }
    return boxes
  }

  function classLengths(): Record<string, number> {
    // The union across a class's meshes, not the longest single one: a semi's trailer bed and its
    // cab are separate meshes, and the ladder is about the vehicle, not about its longest part.
    const spans = new Map<string, { min: number; max: number }>()
    for (const [name, box] of assetBoxes()) {
      const asset = name.slice(0, name.lastIndexOf('__'))
      const span = spans.get(asset)
      if (span) {
        span.min = Math.min(span.min, box.min[2])
        span.max = Math.max(span.max, box.max[2])
      } else spans.set(asset, { min: box.min[2], max: box.max[2] })
    }
    const lengths: Record<string, number> = {}
    for (const [asset, span] of spans) lengths[asset] = span.max - span.min
    return lengths
  }
})
