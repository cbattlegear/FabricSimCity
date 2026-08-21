import { SEVERITY_LABELS, type IncidentMarker, type IncidentProjection } from './cityIncidents'

/**
 * The incident callout.
 *
 * Rendered as HTML over the canvas rather than as scene geometry, so the text is real text:
 * selectable, screen-reader reachable, and legible at any zoom. Positioning is handed in already
 * projected to screen space by the viewport.
 */
export function IncidentPopup({
  marker,
  x,
  y,
  onClose,
}: {
  marker: IncidentMarker
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
 */
export function IncidentSummary({ projection }: { projection: IncidentProjection }) {
  const { markers, offPageCount, unresolved, probeReported, reason } = projection
  return (
    <div className="incident-summary" role="status">
      {!probeReported && <span className="is-unknown">Blocking not observed</span>}
      {probeReported && markers.length === 0 && <span>No blocked waiter named a loaded object</span>}
      {probeReported && markers.length > 0 && (
        <span className="is-alert">{markers.length} object(s) with a blocked waiter</span>
      )}
      <small>{reason}</small>
      {offPageCount > 0 && (
        <small>{offPageCount} resolved lock wait(s) name an object outside this bounded page.</small>
      )}
      {unresolved.length > 0 && (
        <small>{unresolved.length} lock wait(s) could not name an object: {unresolved[0].reason}</small>
      )}
    </div>
  )
}
