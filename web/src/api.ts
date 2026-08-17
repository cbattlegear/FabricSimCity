import * as signalR from '@microsoft/signalr'
import type { AtlasSnapshot } from './contracts'
import type { LiveIncidentResponse } from './liveContracts'
import { assertAtlasSnapshot } from './atlas'
import { assertLiveIncidentResponse } from './liveIncidents'

export async function fetchAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
  const response = await fetch('/api/v1/atlas', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`Atlas request failed with status ${response.status}`)
  return assertAtlasSnapshot(await response.json())
}

export async function fetchLiveIncidents(signal?: AbortSignal): Promise<LiveIncidentResponse> {
  const response = await fetch('/api/v1/live', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`Live incident request failed with status ${response.status}`)
  return assertLiveIncidentResponse(await response.json())
}

/**
 * Subscribes to the single-latest live-incident push over SignalR (requirement 7): every
 * invocation of `onUpdate` replaces the caller's view of "current", never appends to a history the
 * caller must manage. Returns a disposer that stops the connection.
 */
export function subscribeToLiveIncidents(onUpdate: (response: LiveIncidentResponse) => void): () => void {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl('/hubs/current-snapshot')
    .withAutomaticReconnect()
    .build()

  connection.on('liveIncidentUpdated', (payload: unknown) => {
    onUpdate(assertLiveIncidentResponse(payload))
  })

  connection.start()
    .then(() => connection.invoke<LiveIncidentResponse>('GetCurrentLiveSnapshot'))
    .then(current => onUpdate(assertLiveIncidentResponse(current)))
    .catch(() => {
      // A failed initial connection/pull is not fatal: the REST fallback already has the latest
      // response, and withAutomaticReconnect keeps retrying the push channel in the background.
    })

  return () => {
    connection.stop().catch(() => {
      // Best-effort: the connection may already be closed (e.g. component unmounted after an error).
    })
  }
}
