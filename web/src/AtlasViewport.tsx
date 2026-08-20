import { useEffect, useRef, useState } from 'react'
import type { AtlasSnapshot } from './contracts'
import { createAtlasScene, tryCreateAtlasScene, type AtlasSceneController } from './atlasSceneFactory'

type AtlasViewportProps = {
  snapshot: AtlasSnapshot
  selectedId: string | null
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
  onOpen: (databaseId: string) => void
}

export function AtlasViewport({ snapshot, selectedId, onHover, onSelect, onOpen }: AtlasViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<AtlasSceneController | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!canvasRef.current) return
    const scene = tryCreateAtlasScene(createAtlasScene, canvasRef.current, { onHover, onSelect, onOpen })
    if (!scene) {
      setUnavailable(true)
      return
    }
    sceneRef.current = scene
    scene.setSnapshot(snapshot)
    scene.setSelected(selectedId)
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [onHover, onSelect, onOpen])

  useEffect(() => sceneRef.current?.setSnapshot(snapshot), [snapshot])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])

  return (
    <div className="atlas-viewport">
      <canvas ref={canvasRef} className="atlas-canvas" aria-hidden="true" hidden={unavailable} />
      {unavailable && (
        <div className="viewport-fallback" role="status">
          <strong>3D atlas unavailable</strong>
          <span>Use the database evidence table below; it contains the complete atlas data.</span>
        </div>
      )}
    </div>
  )
}
