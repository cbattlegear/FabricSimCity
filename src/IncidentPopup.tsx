import {
  incidentSummaryLabel,
  incidentSummaryTone,
  SEVERITY_LABELS,
  type IncidentMarker,
  type IncidentProjection,
} from './cityIncidents'
import type { IncidentPlacement } from './cityIncidentPlacement'

/**
 * The throttling incident callout.
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
   * two named items and a pin at one item's kerb are different claims, and a reader who cannot tell
   * them apart is being misled by the more confident one.
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
 * The one-line status the map shows about throttling incidents.
 *
 * This exists so the map can never imply "all clear". When the throttle gauges or operation evidence
 * were not observed, it says so; when overload was measured but could not be pinned to a drawn item,
 * it says how much and why. Only a genuinely readable-and-quiet capacity says "No throttling".
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
  const {
    markers,
    evidence,
    reason,
    offPageRejectionCount,
    unattributedSeconds,
    unclassedRejectionCount,
  } = projection
  return (
    <div className="incident-summary" role="status">
      <span className={incidentSummaryTone(projection)}>{incidentSummaryLabel(projection)}</span>
      {evidence === 'unsupported' && (
        <span className="is-unknown">Throttling not observed</span>
      )}
      {evidence === 'none' && markers.length === 0 && <span>No item is being throttled</span>}
      {markers.length > 0 && (
        <span className="is-alert">{markers.length} item(s) throttled</span>
      )}
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
      {offPageRejectionCount > 0 && (
        <small>{offPageRejectionCount} live rejection(s) name an item outside this bounded page.</small>
      )}
      {unclassedRejectionCount > 0 && (
        <small>
          {unclassedRejectionCount} live rejection(s) named no operation class, so no gate is claimed
          for them.
        </small>
      )}
      {unattributedSeconds > 0 && (
        <small>
          {Math.round(unattributedSeconds).toLocaleString()} throttling second(s) could not be pinned
          to one honest gate, so they are counted here rather than drawn on a building.
        </small>
      )}
    </div>
  )
}
