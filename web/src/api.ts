import type { AtlasSnapshot } from './contracts'
import { assertAtlasSnapshot } from './atlas'

export async function fetchAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
  const response = await fetch('/api/v1/atlas', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`Atlas request failed with status ${response.status}`)
  return assertAtlasSnapshot(await response.json())
}
