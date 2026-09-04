import * as THREE from 'three'
import type { FacilityKind } from './cityInfrastructure'
import landmarksUrl from './assets/landmarks.glb?url'
import sceneryUrl from './assets/scenery.glb?url'
import vehiclesUrl from './assets/vehicles.glb?url'

/**
 * Loads the authored `.glb` kits that dress the city.
 *
 * Nothing in these kits is a measurement. They are the civic *shells* and the street furniture that
 * fills the ground the plan deliberately leaves empty. Every measured quantity — footprints, heights,
 * road widths, facility fill — is drawn as separate geometry by the scene, so a kit that fails to load
 * costs the map some scenery and costs the reader no evidence. That is why every entry point here
 * resolves to `null` rather than rejecting: the caller falls back to the procedural shells in
 * `cityFacilityShells.ts` and the city still draws.
 *
 * The **vehicle** kit is the one place that argument stops short, which is why it is loaded
 * separately by {@link loadVehicleAssets}. Its meshes are no more a measurement than a tree is, but
 * *whether one is drawn at all* is: a vehicle on a road is a live sampled request. Falling back to a
 * procedural shell is therefore fine and drawing nothing is not, and the two kits must not be able
 * to fail for each other.
 *
 * The geometry is authored by `blender/simcity_kit.py`, which is checked in so every byte of the
 * binaries is reproducible from source. See that file for the naming and orientation contract.
 *
 * Two properties of the exported meshes matter to callers:
 *
 * - **They carry no normals.** The kit is flat-shaded hard surface, so the exporter welds vertices and
 *   omits the normal attribute, which is worth about 4x on the wire. Materials drawing kit geometry
 *   must therefore set `flatShading: true`; three.js then derives face normals in the fragment shader.
 *   Running `computeVertexNormals()` instead would smooth every hard edge into a blob.
 * - **Landmarks are normalised to a plot radius of 1.** Scale the group, not the geometry, so one
 *   shared buffer serves every facility whatever plot it lands on. Scenery is at world scale, where
 *   one unit is roughly one metre.
 */

/** Material group of a mesh, encoded as the suffix of its name: `tree_conifer__leaf`. */
export type AssetRole = 'body' | 'trim' | 'glass' | 'metal' | 'trunk' | 'leaf' | 'water'

const ROLES: readonly AssetRole[] = ['body', 'trim', 'glass', 'metal', 'trunk', 'leaf', 'water']

export interface AssetKit {
  /** The geometry for one role of one asset, or null when the kit does not carry it. */
  geometry(asset: string, role: AssetRole): THREE.BufferGeometry | null
  /** Every role the asset was authored with, in a stable order. */
  roles(asset: string): readonly AssetRole[]
  has(asset: string): boolean
}

export interface CityAssets {
  readonly landmarks: AssetKit
  readonly scenery: AssetKit
}

/** Which landmark stands on which facility's plot. */
export const LANDMARK_ASSETS: Record<FacilityKind, string> = {
  cpu: 'cpu',
  memory: 'memory',
  storage: 'storage',
  tempdb: 'tempdb',
  log: 'log',
  lock: 'lock',
}

/**
 * Scenery a block can be dressed with.
 *
 * Parked cars are parked and confined to parking areas because they are *decoration*: they are
 * scattered by a block's own seed and measure nothing. A **moving** vehicle is a different claim
 * entirely — it is a live sampled request — and it comes from {@link VEHICLE_ASSETS} below, which is
 * a separate kit for exactly that reason.
 */
export const SCENERY_ASSETS = [
  'tree_broadleaf',
  'tree_conifer',
  'tree_ornamental',
  'shrub',
  'hedge',
  'streetlight',
  'bench',
  'kiosk',
  'bus_shelter',
  'fountain',
  'pavilion',
  'parked_car',
  'rooftop',
  'signal',
  'bridge_deck',
] as const

export type SceneryAsset = (typeof SCENERY_ASSETS)[number]

/**
 * The four vehicle shells, one per class of the data-volume ladder in `cityVehicles.ts`.
 *
 * These are the one part of the authored geometry that is not decoration. Which of the four is drawn
 * is chosen from `planDataVolume.estimatedBytesPerExecution` — so the *choice* is evidence even
 * though the mesh is not, and that is why they are a kit of their own rather than fifteen more
 * entries in {@link SCENERY_ASSETS}.
 *
 * There is deliberately no asset for the *unknown* class. A family whose retained plans stated no
 * row size gets a grey featureless shell drawn procedurally, because every length in this kit sits
 * somewhere on the ladder and a reader would size an unknown by whichever one it borrowed.
 */
export const VEHICLE_ASSETS = ['vehicle_bike', 'vehicle_car', 'vehicle_van', 'vehicle_semi_truck'] as const

export type VehicleAsset = (typeof VEHICLE_ASSETS)[number]

const EMPTY_ROLES: readonly AssetRole[] = []

function makeKit(meshes: Map<string, Map<AssetRole, THREE.BufferGeometry>>): AssetKit {
  return {
    geometry: (asset, role) => meshes.get(asset)?.get(role) ?? null,
    roles: asset => {
      const entry = meshes.get(asset)
      if (!entry) return EMPTY_ROLES
      return ROLES.filter(role => entry.has(role))
    },
    has: asset => meshes.has(asset),
  }
}

/**
 * Splits `asset__role` and keeps only the roles the material contract knows about. A mesh named
 * anything else is dropped rather than guessed at, so a typo in the generator fails visibly as
 * missing geometry instead of silently rendering in the wrong material.
 */
function parseName(name: string): { asset: string; role: AssetRole } | null {
  const split = name.lastIndexOf('__')
  if (split <= 0) return null
  const role = name.slice(split + 2) as AssetRole
  if (!ROLES.includes(role)) return null
  return { asset: name.slice(0, split), role }
}

/**
 * The loader chunk, imported once for the whole page.
 *
 * Three kits are fetched, two of them concurrently, and each used to `await import()` the loader for
 * itself. The bundler serves the same chunk to all three, so this is not a saving of bytes — it is a
 * saving of two redundant module-resolution round trips, and it removes a race in which two
 * concurrent dynamic imports of the same specifier are resolved independently.
 */
let loaderModule: Promise<typeof import('three/examples/jsm/loaders/GLTFLoader.js')> | null = null

function gltfLoader() {
  loaderModule ??= import('three/examples/jsm/loaders/GLTFLoader.js')
  return loaderModule
}

async function loadKit(url: string): Promise<AssetKit> {
  const { GLTFLoader } = await gltfLoader()
  const gltf = await new GLTFLoader().loadAsync(url)
  const meshes = new Map<string, Map<AssetRole, THREE.BufferGeometry>>()
  gltf.scene.updateWorldMatrix(true, true)
  gltf.scene.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return
    const parsed = parseName(node.name)
    if (!parsed) return
    // Bake the node transform so callers can drop the geometry straight into a mesh of their own,
    // whatever axis conversion the exporter chose to express as a parent rotation.
    const geometry = (node.geometry as THREE.BufferGeometry).clone()
    geometry.applyMatrix4(node.matrixWorld)
    geometry.computeBoundingSphere()
    let entry = meshes.get(parsed.asset)
    if (!entry) {
      entry = new Map<AssetRole, THREE.BufferGeometry>()
      meshes.set(parsed.asset, entry)
    }
    entry.set(parsed.role, geometry)
  })
  // The loaded scene graph is scaffolding; only the cloned buffers outlive this call.
  gltf.scene.traverse(node => {
    if (node instanceof THREE.Mesh) node.geometry.dispose()
  })
  return makeKit(meshes)
}

let pending: Promise<CityAssets | null> | null = null
let pendingVehicles: Promise<AssetKit | null> | null = null

/**
 * Fetches both kits once per page and caches the result, including the failure. Callers may call this
 * freely from every scene instance; the second caller shares the first one's request.
 */
export function loadCityAssets(): Promise<CityAssets | null> {
  if (!pending) {
    pending = Promise.all([loadKit(landmarksUrl), loadKit(sceneryUrl)])
      .then(([landmarks, scenery]) => ({ landmarks, scenery }))
      .catch((error: unknown) => {
        // Scenery is decoration. Losing it is worth one console line and nothing else.
        console.warn('[SQLSimCity] asset kits unavailable, drawing procedural shells instead', error)
        return null
      })
  }
  return pending
}

/**
 * Fetches the vehicle kit, on **its own promise and its own `.catch`**.
 *
 * Deliberately not a third entry in {@link loadCityAssets}'s `Promise.all`. That array sits behind a
 * single catch that returns `null` for everything, so folding vehicles into it would couple two
 * failures that must stay independent — and one direction of that coupling is a correctness bug: a
 * failed fetch of decorative scenery would silently erase the vehicles, and a city with no vehicles
 * is indistinguishable from an instance on which nothing ran. That turns a missing decoration into a
 * false statement about the database.
 *
 * Null here therefore means "draw the procedural shells", never "draw nothing". The caller falls
 * back the way `buildFacilityArchitecture` already does for missing landmark geometry.
 */
export function loadVehicleAssets(): Promise<AssetKit | null> {
  if (!pendingVehicles) {
    pendingVehicles = loadKit(vehiclesUrl).catch((error: unknown) => {
      console.warn('[SQLSimCity] vehicle kit unavailable, drawing procedural shells instead', error)
      return null
    })
  }
  return pendingVehicles
}

/** Test seam: forgets the cached kits so a failure can be retried. Clears *both* caches. */
export function resetCityAssets(): void {
  pending = null
  pendingVehicles = null
}
