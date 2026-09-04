import type { AtlasSnapshot } from './fabricContracts'
import { AtlasScene } from './AtlasScene'
import type { MapViewMode } from './mapStyle'

type AtlasSceneCallbacks = {
  onHover: (capacityId: string | null) => void
  onSelect: (capacityId: string) => void
  onOpen: (capacityId: string) => void
}

export interface AtlasSceneController {
  setSnapshot(snapshot: AtlasSnapshot): void
  setSelected(capacityId: string | null): void
  /** Flat basemap or oblique 3D. Both draw the same parcels and the same measurements. */
  setViewMode(mode: MapViewMode): void
  dispose(): void
}

export type AtlasSceneFactory = (
  canvas: HTMLCanvasElement,
  callbacks: AtlasSceneCallbacks,
) => AtlasSceneController

export const createAtlasScene: AtlasSceneFactory = (canvas, callbacks) => new AtlasScene(canvas, callbacks)

export function tryCreateAtlasScene(
  factory: AtlasSceneFactory,
  canvas: HTMLCanvasElement,
  callbacks: AtlasSceneCallbacks,
): AtlasSceneController | null {
  try {
    return factory(canvas, callbacks)
  } catch (error: unknown) {
    console.warn('The 3D atlas could not initialize.', error)
    return null
  }
}
