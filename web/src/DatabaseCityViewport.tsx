import { useEffect, useRef, useState } from 'react'
import type { DatabaseCityObject, DatabaseCityRoute } from './databaseCityContracts'
import { createDatabaseCityScene, type DatabaseCitySceneController } from './DatabaseCityScene'

type Props = {
  objects: readonly DatabaseCityObject[]
  routes: readonly DatabaseCityRoute[]
  selectedId: string | null
  onSelect: (objectId: string) => void
}

export function DatabaseCityViewport({ objects, routes, selectedId, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<DatabaseCitySceneController | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      sceneRef.current = createDatabaseCityScene(canvasRef.current, { onSelect })
      sceneRef.current.setData(objects, routes)
      sceneRef.current.setSelected(selectedId)
    } catch {
      setUnavailable(true)
    }
    return () => {
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [onSelect])

  useEffect(() => sceneRef.current?.setData(objects, routes), [objects, routes])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])

  return (
    <div className="city-viewport">
      <canvas ref={canvasRef} className="city-canvas" aria-hidden="true" hidden={unavailable} />
      {unavailable && <div className="viewport-fallback" role="status">
        <strong>Database city viewport unavailable</strong>
        <span>The complete object and evidence table remains available below.</span>
      </div>}
    </div>
  )
}
