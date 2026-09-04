import { deadlockSummaryLabel, SEVERITY_LABELS, type IncidentMarker, type IncidentProjection } from './cityIncidents'
import type { IncidentPlacement } from '../cityIncidentPlacement'

/**
 * The incident callout.
 *
 * Rendered as HTML over the canvas rather than as scene geometry, so the text is real text:
 * selectable, screen-reader reachable, and legible at any zoom. Positioning is handed in already
 * projected to screen space by the viewport.
 */
export function IncidentPopup({
  marker,
  placement,
  x,
  y,
  onClose,
}: {
  marker: IncidentMarker
  /**
   * Where the pin ended up and why. Stated rather than assumed: a pin on the measured road between
   * two named objects and a pin at one object's kerb are different claims, and a reader who cannot
   * tell them apart is being misled by the more confident one.
   */
  placement?: IncidentPlacement | null
  x: number
  y: number
  onClose: () => void
}) {
  return (
    <div
      className={`incident-popup is-${marker.severity}`}
      style={{ left: `${x}px`, top: `${y}px` }}
      role="dialog"
      aria-label={`${SEVERITY_LABELS[marker.severity]}: ${marker.headline}`}
    >
      <div className="incident-popup-head">
        <span className="incident-chip">{SEVERITY_LABELS[marker.severity]}</span>
        <button type="button" onClick={onClose} aria-label="Close incident detail">✕</button>
      </div>
      <strong>{marker.headline}</strong>
      <ul>
        {marker.details.map(detail => <li key={detail}>{detail}</li>)}
      </ul>
      {placement && <p className="incident-placement">{placement.rationale}</p>}
      <p className="incident-source">
        {marker.source} · observed {new Date(marker.observedAt).toLocaleTimeString()}
      </p>
    </div>
  )
}

/**
 * The one-line status the map shows about incidents.
 *
 * This exists so the map can never imply "all clear". When the probe did not report, it says so;
 * when waits resolved off this page or to no object at all, it says how many and why.
 *
 * The marker list is also the keyboard route to the popups. A pin is a sphere in a 3D scene, so
 * pointer-picking it is the only way in for a mouse; that would leave keyboard and screen-reader
 * users with no way to read an incident at all. Every marker is therefore a real button here.
 */
export function IncidentSummary({
  projection,
  openId,
  onOpen,
}: {
  projection: IncidentProjection
  openId?: string | null
  onOpen?: (markerId: string) => void
}) {
  const { markers, offPageCount, unresolved, probeReported, reason, deadlocks } = projection
  return (
    <div className="incident-summary" role="status">
      {!probeReported && <span className="is-unknown">Blocking not observed</span>}
      {probeReported && markers.length === 0 && <span>No blocked waiter named a loaded object</span>}
      {probeReported && markers.length > 0 && (
        <span className="is-alert">{markers.length} object(s) with a blocked waiter</span>
      )}
      <span className={deadlocks.observed && deadlocks.retainedCount > 0 ? 'is-alert' : deadlocks.observed ? '' : 'is-unknown'}>
        Deadlocks · {deadlockSummaryLabel(projection)}
      </span>
      {onOpen && markers.length > 0 && (
        <ul className="incident-list">
          {markers.map(marker => (
            <li key={marker.id}>
              <button
                type="button"
                className={`incident-jump is-${marker.severity}`}
                aria-expanded={openId === marker.id}
                onClick={() => onOpen(marker.id)}
              >
                <i className="incident-jump-dot" aria-hidden="true" />
                <span>{marker.headline}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <small>{reason}</small>
      <small>{deadlocks.reason}</small>
      {offPageCount > 0 && (
        <small>{offPageCount} resolved lock wait(s) name an object outside this bounded page.</small>
      )}
      {unresolved.length > 0 && (
        <small>{unresolved.length} lock wait(s) name no object: {unresolved[0].reason}</small>
      )}
      {deadlocks.observed && deadlocks.retainedCount > deadlocks.pinnedCount && (
        <small>
          {deadlocks.retainedCount - deadlocks.pinnedCount} recorded deadlock(s) name no object on
          this bounded page, so they are counted here rather than pinned anywhere.
        </small>
      )}
    </div>
  )
}
