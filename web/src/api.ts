import * as signalR from '@microsoft/signalr'
import type { AtlasSnapshot } from './contracts'
import type { LiveIncidentResponse } from './liveContracts'
import { assertAtlasSnapshot } from './atlas'
import { assertLiveIncidentResponse, computeReconnectDelayMs } from './liveIncidents'
import type { LiveFeedConnectionState } from './liveIncidents'

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

/** Cadence of the REST fallback used whenever the push channel is not connected. */
export const LIVE_FALLBACK_POLL_INTERVAL_MS = 4000

/**
 * Subscribes to the single-latest live-incident push over SignalR (requirement 7): every
 * invocation of `onUpdate` replaces the caller's view of "current", never appends to a history the
 * caller must manage. Returns a disposer that stops the connection and every pending timer.
 *
 * `withAutomaticReconnect()` retries only a connection that was established and then dropped, and
 * it gives up permanently after its last configured attempt. This function therefore owns its own
 * bounded-backoff retry loop for the initial `start()` and for a permanently closed connection, and
 * polls `fetchLiveIncidents()` while no push channel is connected so the caller never goes quiet
 * without saying so. `onConnectionStateChange` reports that channel state, which is deliberately
 * distinct from the freshness of the snapshot the channel carries.
 */
export function subscribeToLiveIncidents(
  onUpdate: (response: LiveIncidentResponse) => void,
  onConnectionStateChange?: (state: LiveFeedConnectionState) => void,
): () => void {
  let disposed = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let reportedState: LiveFeedConnectionState | null = null

  const connection = new signalR.HubConnectionBuilder()
    .withUrl('/hubs/current-snapshot')
    .withAutomaticReconnect()
    .build()

  const report = (state: LiveFeedConnectionState) => {
    if (disposed || reportedState === state) return
    reportedState = state
    onConnectionStateChange?.(state)
  }

  const publish = (payload: unknown) => {
    if (disposed) return
    let response: LiveIncidentResponse
    try {
      response = assertLiveIncidentResponse(payload)
    } catch (error) {
      // A malformed payload must not kill the subscription: keep the channel and the poll running.
      console.error('Discarded a malformed live incident payload', error)
      return
    }
    onUpdate(response)
  }

  const stopPolling = () => {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  const pollOnce = async () => {
    if (disposed) return
    try {
      const response = await fetchLiveIncidents()
      if (disposed) return
      onUpdate(response)
    } catch (error) {
      if (disposed) return
      console.error('REST fallback poll for live incidents failed', error)
    }
  }

  const startPolling = () => {
    if (disposed || pollTimer !== null) return
    void pollOnce()
    pollTimer = setInterval(() => void pollOnce(), LIVE_FALLBACK_POLL_INTERVAL_MS)
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return
    const delay = computeReconnectDelayMs(reconnectAttempt)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (disposed) return
    report('reconnecting')
    try {
      await connection.start()
    } catch (error) {
      if (disposed) return
      console.error('Live incident push channel could not be started; polling over REST instead', error)
      report('polling-fallback')
      startPolling()
      scheduleReconnect()
      return
    }
    if (disposed) {
      connection.stop().catch(() => {})
      return
    }
    reconnectAttempt = 0
    stopPolling()
    report('connected')
    await pullCurrent()
  }

  const pullCurrent = async () => {
    if (disposed) return
    try {
      publish(await connection.invoke<LiveIncidentResponse>('GetCurrentLiveSnapshot'))
    } catch (error) {
      if (disposed) return
      // The channel is up; only this pull failed. Pushes still arrive, so do not tear anything down.
      console.error('Initial live incident pull failed; waiting for the next push', error)
    }
  }

  connection.on('liveIncidentUpdated', publish)

  connection.onreconnecting(() => {
    if (disposed) return
    report('reconnecting')
    startPolling()
  })

  connection.onreconnected(() => {
    if (disposed) return
    reconnectAttempt = 0
    stopPolling()
    report('connected')
    void pullCurrent()
  })

  connection.onclose(() => {
    if (disposed) return
    // SignalR has given up for good here; our own bounded retry loop takes over from this point.
    report('disconnected')
    startPolling()
    scheduleReconnect()
  })

  void connect()

  return () => {
    disposed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopPolling()
    connection.stop().catch(() => {
      // Best-effort: the connection may already be closed (e.g. component unmounted after an error).
    })
  }
}
