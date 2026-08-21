import type { AtlasSnapshot } from './contracts'
import { AtlasScene } from './AtlasScene'
import type { MapViewMode } from './mapStyle'

type AtlasSceneCallbacks = {
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
  onOpen: (databaseId: string) => void
}

export interface AtlasSceneController {
  setSnapshot(snapshot: AtlasSnapshot): void
  setSelected(databaseId: string | null): void
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
