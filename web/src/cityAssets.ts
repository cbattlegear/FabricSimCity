import * as THREE from 'three'
import type { FacilityKind } from './cityInfrastructure'
import landmarksUrl from './assets/landmarks.glb?url'
import sceneryUrl from './assets/scenery.glb?url'

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
 * Scenery a block can be dressed with. Vehicles are parked only and confined to parking areas —
 * a moving vehicle would imply flow, and flow is evidence.
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

async function loadKit(url: string): Promise<AssetKit> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
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

/** Test seam: forgets the cached kits so a failure can be retried. */
export function resetCityAssets(): void {
  pending = null
}
