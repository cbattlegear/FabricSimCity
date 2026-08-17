import { useEffect, useRef } from 'react'
import { AtlasScene } from './AtlasScene'
import type { AtlasSnapshot } from './contracts'

type AtlasViewportProps = {
  snapshot: AtlasSnapshot
  selectedId: string | null
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
}

export function AtlasViewport({ snapshot, selectedId, onHover, onSelect }: AtlasViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<AtlasScene | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const scene = new AtlasScene(canvasRef.current, { onHover, onSelect })
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [onHover, onSelect])

  useEffect(() => sceneRef.current?.setSnapshot(snapshot), [snapshot])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])

  return <canvas ref={canvasRef} className="atlas-canvas" aria-hidden="true" />
}
