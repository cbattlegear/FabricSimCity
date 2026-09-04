import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { CapacityCityItem } from './capacityCityContracts'
import {
  createDatabaseCityScene,
  type CameraNudge,
  type CityLayerToggles,
  type DatabaseCitySceneController,
} from './CapacityCityScene'
import { CONGESTION_COLORS, CONGESTION_GRADES, CONGESTION_LABELS, type RoadTraffic } from './cityTraffic'
import type { FacilityTraffic } from './cityFacilityTraffic'
import { type Facility } from './cityInfrastructure'
import type { WorkloadTraffic } from './cityWorkloadTraffic'
import type { CityPlan } from './cityPlan'
import type { MapViewMode } from './mapStyle'
import type { IncidentProjection } from './cityIncidents'
import type { IncidentPlacement } from './cityIncidentPlacement'
import type { LiveFeedConnectionState } from './liveIncidents'
import type { VehicleRoster } from './cityVehicles'
import type { TourStop, TourStopKind } from './cityTour'
import { IncidentPopup } from './IncidentPopup'
import { MapTray, useNarrowViewport, type TrayItem } from './MapTray'

/**
 * The selected-route highlight is retired on Fabric — its SQL builder parsed showplan XML to infer a
 * path between items, and Capacity Metrics attributes each operation to an item directly, so there
 * is no lineage path to reconstruct. The scene keeps the drawing plumbing behind this minimal shape
 * (mirrored from `CapacityCityScene.ts`) so a future Fabric lineage-route source can feed it.
 */
export type CityRoute = {
  readonly polyline: readonly { readonly x: number; readonly z: number }[]
  readonly stops: readonly { readonly x: number | null; readonly z: number | null }[]
}

type Props = {
  objects: readonly CapacityCityItem[]
  /**
   * The plan the view has already computed. Passed in rather than recomputed so the scene, the
   * address book, the route, and the traffic map all read one layout produced once.
   */
  cityPlan: CityPlan
  /**
   * The capacity this city is of, used only as the opening caption of a guided tour.
   *
   * Optional because a tour is optional: a viewport rendered without it still tours, and the
   * establishing shot simply leaves the capacity unnamed rather than inventing one.
   */
  cityName?: string
  /** Flat basemap or oblique 3D city. Both draw the same plan and the same measurements. */
  viewMode: MapViewMode
  roads: readonly RoadTraffic[]
  /** Aggregate street load built from the workload's executions and apportioned waits. */
  traffic: WorkloadTraffic
  facilities: readonly Facility[]
  facilityTraffic: FacilityTraffic
  route: CityRoute | null
  selectedId: string | null
  selectedRoadId: string | null
  onSelect: (itemId: string) => void
  onSelectRoad: (routeId: string | null) => void
  /** One-line description per road id, shown when a road is hovered. */
  roadLabels: ReadonlyMap<string, string>
  /** Rendered into the top-left HUD slot: the item and operation finder. */
  finder?: ReactNode
  /** Rendered into the right HUD slot: item detail or turn-by-turn directions. */
  panel?: ReactNode
  liveStatus?: ReactNode
  /**
   * The live feed's own connection state, so the folded tray chip can say it.
   *
   * `liveStatus` is an opaque node, and a chip that reads "Feed" whether the feed is connected or
   * dead would hide the qualifier on every live number the map draws. This is the one fact the chip
   * needs in order not to do that.
   */
  feedState?: LiveFeedConnectionState
  /** Live blocking pins projected from the snapshot. Drawn in both view modes. */
  incidents?: IncidentProjection
  /** Items whose telemetry evidence is stale enough to weather their building facades. */
  staleStatsObjectIds?: readonly string[]
  /**
   * Items whose work was refused by a measured rejection count. Drawn as a roof fire.
   */
  fireObjectIds?: readonly string[]
  /**
   * Items carrying source-reported degrading warnings, which the city draws as a burst water main at
   * the kerb rather than on the building, because the damage is to the street the traffic uses.
   */
  waterMainObjectIds?: readonly string[]
  /** What the scene actually drew, so the legend can disclose it honestly. */
  onVehicleRoster?: (roster: VehicleRoster) => void
  /**
   * The incident whose popup is open, owned by the view rather than by this component.
   *
   * The list that opens these pins is a sidebar drawer now, outside this viewport entirely, so the
   * selection has to live where both can see it. Pin clicks report upwards through
   * {@link onOpenIncident} exactly as the list does.
   */
  openIncidentId?: string | null
  onOpenIncident?: (id: string | null) => void
  /**
   * A request to centre the camera on one item before its popup opens.
   *
   * A marker behind the camera projects to nothing, so a sidebar entry that only set the id would
   * open a popup nobody sees. The nonce is what makes asking twice for the same item work.
   */
  incidentFocus?: { itemId: string; nonce: number } | null
}

const KEY_ACTIONS: Record<string, CameraNudge> = {
  ArrowLeft: 'panLeft',
  ArrowRight: 'panRight',
  ArrowUp: 'panUp',
  ArrowDown: 'panDown',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
  '[': 'rotateLeft',
  ']': 'rotateRight',
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/**
 * What each kind of stop is called on screen.
 *
 * "Blocked" rather than "disaster", and "Busy street" rather than "problem street", because the
 * caption beside it states a measurement and the label must not add a verdict the measurement does
 * not support. A blocked request is a fact; whether it is a disaster is the reader's call.
 */
const TOUR_KINDS: Record<TourStopKind, string> = {
  skyline: 'Skyline',
  landmark: 'Landmark',
  street: 'Busy street',
  incident: 'Blocked',
  neighbourhood: 'Neighbourhood',
}

// A module-level constant so the default prop is referentially stable. A fresh `[]` literal would
// be a new array on every render, re-running the effect and rebuilding every building each time.
const EMPTY_STALE_STATS: readonly string[] = Object.freeze([])
const EMPTY_FIRES: readonly string[] = Object.freeze([])
const EMPTY_WATER_MAINS: readonly string[] = Object.freeze([])

/**
 * The folded incident chip. Its wording lives in {@link incidentSummaryLabel} beside the projection
 * it describes, because on a phone this chip may be the whole blocking probe a reader sees, and what
 * it is allowed to claim is a property of the evidence rather than of the layout.
 */
/**
 * The layer checkboxes, with the hint each one carries on hover. Only layers whose behaviour is not
 * fully described by their own name need one.
 */
const LAYER_LABELS: ReadonlyArray<readonly [keyof CityLayerToggles, string, string?]> = [
  ['traffic', 'Traffic'],
  ['paths', 'Query paths'],
  ['infrastructure', 'Infrastructure'],
  ['route', 'Query route'],
  [
    'labels',
    'Labels',
    'Neighbourhood names are grown as you zoom out so they stay readable; where two would be written over each other, the smaller neighbourhood’s name is dropped. Building and facility names appear as you zoom in — largest items first — rather than being drawn too small to read.',
  ],
]

function swatch(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function CapacityCityViewport({
  objects,
  cityPlan,
  cityName = '',
  viewMode,
  roads,
  traffic,
  facilities,
  facilityTraffic,
  route,
  selectedId,
  selectedRoadId,
  onSelect,
  onSelectRoad,
  roadLabels,
  finder,
  panel,
  liveStatus,
  feedState,
  incidents,
  staleStatsObjectIds = EMPTY_STALE_STATS,
  fireObjectIds = EMPTY_FIRES,
  waterMainObjectIds = EMPTY_WATER_MAINS,
  onVehicleRoster,
  openIncidentId = null,
  onOpenIncident,
  incidentFocus = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<DatabaseCitySceneController | null>(null)
  const layersTitleId = useId()
  const [unavailable, setUnavailable] = useState(false)
  const [heading, setHeading] = useState(0)
  const [hoveredRoadId, setHoveredRoadId] = useState<string | null>(null)
  /*
   * The tour's two pieces of state, deliberately separate.
   *
   * `touring` is what the viewer asked for and drives the toggle; `tourStop` is what the scene is
   * actually looking at and drives the caption. They come apart at exactly the moment that matters:
   * grabbing the camera ends the tour from inside the scene, which reports `active: false` back up
   * here, so the button un-presses itself without the viewer having touched it.
   */
  const [touring, setTouring] = useState(false)
  const [tourStop, setTourStop] = useState<TourStop | null>(null)
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null)
  const [popupPlacement, setPopupPlacement] = useState<IncidentPlacement | null>(null)
  const [layers, setLayers] = useState<CityLayerToggles>({
    traffic: true,
    paths: false,
    infrastructure: true,
    route: true,
    labels: true,
  })

  const openIncident = useCallback(
    (id: string | null) => onOpenIncident?.(id),
    [onOpenIncident],
  )

  /*
   * The roster callback is held in a ref rather than passed straight into the scene options.
   *
   * The scene is created once and torn down only when its own inputs change; putting a caller's
   * callback in that effect's dependencies would rebuild the entire city — assets, plan, roads and
   * all — whenever the parent happened to re-render with a fresh closure.
   */
  const vehicleRosterRef = useRef(onVehicleRoster)
  vehicleRosterRef.current = onVehicleRoster

  useEffect(() => {
    if (!canvasRef.current) return
    let controller: DatabaseCitySceneController
    try {
      controller = createDatabaseCityScene(canvasRef.current, {
        onSelect,
        onSelectRoad,
        onHoverRoad: setHoveredRoadId,
        onSelectIncident: openIncident,
        onCameraChange: () => setHeading(sceneRef.current?.heading() ?? 0),
        onVehicleRoster: roster => vehicleRosterRef.current?.(roster),
        onTour: ({ active, stop }) => {
          setTouring(active)
          setTourStop(stop)
        },
      })
    } catch {
      setUnavailable(true)
      return
    }
    sceneRef.current = controller
    return () => {
      controller.dispose()
      sceneRef.current = null
    }
  }, [onSelect, onSelectRoad, openIncident])

  useEffect(() => sceneRef.current?.setObjects(objects, cityPlan), [objects, cityPlan])
  useEffect(() => sceneRef.current?.setRoads(roads), [roads])
  useEffect(() => sceneRef.current?.setTraffic(traffic), [traffic])
  useEffect(() => sceneRef.current?.setFacilities(facilities), [facilities])
  useEffect(() => sceneRef.current?.setFacilityTraffic(facilityTraffic), [facilityTraffic])
  useEffect(() => sceneRef.current?.setRoute(route), [route])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])
  useEffect(() => sceneRef.current?.setSelectedRoad(selectedRoadId), [selectedRoadId])
  useEffect(
    () => sceneRef.current?.setStaleStatsObjects(staleStatsObjectIds),
    [staleStatsObjectIds],
  )
  useEffect(() => sceneRef.current?.setFireObjects(fireObjectIds), [fireObjectIds])
  useEffect(
    () => sceneRef.current?.setWaterMainBreaks(waterMainObjectIds),
    [waterMainObjectIds],
  )
  useEffect(() => sceneRef.current?.setLayers(layers), [layers])
  useEffect(() => sceneRef.current?.setViewMode(viewMode), [viewMode])
  useEffect(() => sceneRef.current?.setIncidents(incidents?.markers ?? []), [incidents])
  useEffect(() => sceneRef.current?.setTour(touring, cityName), [touring, cityName])

  // Opening a pin from the sidebar centres its item first, because a marker outside the frustum
  // projects to nothing and would open a popup the reader never sees.
  useEffect(() => {
    if (incidentFocus) sceneRef.current?.focusObject(incidentFocus.itemId)
  }, [incidentFocus])

  /**
   * The popup is HTML over a canvas, so it has to follow the pin as the camera moves. Projecting on
   * an animation frame is what keeps it glued; the loop only runs while a popup is actually open.
   *
   * The pin's placement rides along the same loop, because the popup has to state which rung of the
   * placement ladder put the pin where it is, and only the scene knows which road it landed on.
   */
  useEffect(() => {
    if (!openIncidentId) {
      setPopupAt(null)
      setPopupPlacement(null)
      return
    }
    let handle = 0
    const track = () => {
      const next = sceneRef.current?.incidentScreenPosition(openIncidentId) ?? null
      setPopupAt(current =>
        current && next && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5
          ? current
          : next)
      const placement = sceneRef.current?.incidentPlacement(openIncidentId) ?? null
      setPopupPlacement(current => (current?.basis === placement?.basis && current?.routeId === placement?.routeId
        ? current
        : placement))
      handle = requestAnimationFrame(track)
    }
    handle = requestAnimationFrame(track)
    return () => cancelAnimationFrame(handle)
  }, [openIncidentId])

  // A marker that disappears from the snapshot must take its popup with it.
  useEffect(() => {
    if (openIncidentId && !incidents?.markers.some(marker => marker.id === openIncidentId)) {
      openIncident(null)
    }
  }, [incidents, openIncidentId, openIncident])

  const nudge = useCallback((action: CameraNudge) => {
    sceneRef.current?.nudge(action)
    setHeading(sceneRef.current?.heading() ?? 0)
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (event.key === 'Home') {
        event.preventDefault()
        sceneRef.current?.resetView()
        setHeading(sceneRef.current?.heading() ?? 0)
        return
      }
      const action = KEY_ACTIONS[event.key]
      if (!action) return
      event.preventDefault()
      nudge(action)
    },
    [nudge],
  )

  const toggle = (key: keyof CityLayerToggles) =>
    setLayers(current => ({ ...current, [key]: !current[key] }))

  const narrow = useNarrowViewport()

  const hoverLabel = hoveredRoadId === null ? null : roadLabels.get(hoveredRoadId) ?? null
  const openMarker = incidents?.markers.find(marker => marker.id === openIncidentId) ?? null

  /*
   * One legend, two homes. Wide, it lives bottom-left where a map legend belongs, folded behind its
   * own summary. Narrow, there is no bottom-left worth the name, so it moves into the tray -- and
   * the tray chip is already the disclosure, so the legend opens with it rather than asking for a
   * second tap. It used to be `display: none` under 900px, which meant the phone drawing disclosed
   * nothing about what its own colours and widths meant.
   *
   * `.legend-scroll` exists because the wide home had no cap. The tray has bounded the narrow one
   * since it was built, but bottom-left simply grew upward: opened at 1440x900 the legend measured
   * 1128px against a 900px viewport and, being anchored to its bottom edge, put its own summary at
   * y = -240 -- off the top of the window, so it could not be closed again. That is invisible to the
   * usual overflow check, because `scrollHeight === clientHeight` when a box is clipped by the
   * viewport rather than by its own overflow. Adding the disaster rows made it certain rather than
   * merely likely, at every viewport height worth testing.
   */
  const legend = (
    <details className="hud-legend" open={narrow || undefined}>
      <summary>Legend · what encodes evidence</summary>
      <div className="legend-scroll">
      <ul className="legend-encoded">
        <li>
          <i className="legend-swatch legend-footprint" /> Footprint — log₂ of OneLake storage bytes
        </li>
        <li>
          <i className="legend-swatch legend-height" /> Height — log₂ of CU-seconds consumed
        </li>
        <li>
          <i className="legend-swatch legend-attributed" /> Red roof cap — CU regressed week-over-week; taller cap is a larger regression
        </li>
        <li>
          <i className="legend-swatch legend-route" /> Road width — one constant. Every road is drawn
          the same width, so colour is the only thing saying how a road is doing. Measured operations
          are still reported in the hover readout and the evidence tables.
        </li>
        {CONGESTION_GRADES.map(grade => (
          <li key={grade}>
            <i className="legend-swatch" style={{ background: swatch(CONGESTION_COLORS[grade]) }} />
            Road colour — {CONGESTION_LABELS[grade].toLowerCase()}
          </li>
        ))}
        <li>
          <i className="legend-swatch legend-solid" /> Unbroken road — confirmed dependency
        </li>
        <li>
          <i className="legend-swatch legend-dashed" /> Long dashes — probable dependency
        </li>
        <li>
          <i className="legend-swatch legend-sparse" /> Short dashes — shared-operation reference
        </li>
        <li>
          <i className="legend-swatch legend-incident-block">⚠</i> Yellow pin — an interactive delay
          right now, placed on the road rather than on a building
        </li>
        <li>
          <i className="legend-swatch legend-incident-deadlock">✖</i> Red pin — an operation the
          capacity is rejecting at a throttle gate
        </li>
        <li>
          <i className="legend-swatch legend-disaster-fire" /> Flame and smoke on a roof — this
          item had operations rejected at a throttle gate (measured rejected count above zero)
        </li>
        <li>
          <i className="legend-swatch legend-disaster-wreck" /> Wreckage on a road — an item on that
          road had operations rejected at a throttle gate
        </li>
        <li>
          <i className="legend-swatch legend-disaster-weathered" /> Grimy facade, boarded windows —
          this item&apos;s measurement is stale
        </li>
        <li>
          <i className="legend-swatch legend-unknown">×</i> Wireframe — unavailable evidence, no quantity claimed
        </li>
      </ul>
      <p className="legend-caveat">
        Incidents and weathering are drawn far larger than true scale, for the same reason vehicles
        are: at true scale a marker is a few pixels and nothing that cannot be seen is evidence of
        anything. Their sizes are a legibility floor and encode no quantity — a bigger pin is not a
        worse one, and two are not comparable by eye. What is being claimed is only <em>which</em>
        item the evidence named.
      </p>
      <p className="legend-caveat">
        Road colour is graded from one measured ratio: throttling seconds per operation. A road with
        no colour is grey, not green: grey means no measured family named both of its endpoints, which
        is not a claim that the road is quiet. {facilityTraffic.note}
        {facilityTraffic.unattributedSeconds > 0 &&
          ` ${Math.round(facilityTraffic.unattributedSeconds)} measured throttling second(s)` +
          ' identified no honest gate on this map and carry no lane rather than being folded into one.'}
      </p>
      <p className="legend-decoration">
        Roofs, windows, doors, chimneys, setbacks, crowns, and sidewalks are decoration. They are
        seeded from each item&apos;s stable id and encode nothing. A neighbourhood&apos;s hue
        says which workspace owns it and nothing more: hues are handed out in catalogue order, so
        one is never warmer, larger or busier than another.
      </p>
      </div>
    </details>
  )

  const trayItems: TrayItem[] = [
    // Search leads on a phone: it is the fastest way to reach an item when the map is small.
    ...(narrow && finder ? [{ id: 'find', label: 'Find', glyph: '⌕', content: finder }] : []),
    {
      id: 'layers',
      label: 'Layers',
      glyph: '≣',
      content: (
        <div className="hud-layers" role="group" aria-labelledby={layersTitleId}>
          <span className="hud-layers-title" id={layersTitleId}>Layers</span>
          {LAYER_LABELS.map(([key, label, hint]) => (
            <label key={key} title={hint}>
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
              {label}
            </label>
          ))}
        </div>
      ),
    },
    ...(liveStatus
      ? [{
        id: 'live',
        // A degraded feed is a qualifier on every live number the map draws, so the chip states the
        // connection rather than just naming the panel, and a feed that is not connected opens
        // itself the way a blocked waiter does. Ordered after incidents so that when both are
        // saying something, the one that opens itself is the blocking probe.
        label: feedState ? `Feed · ${feedState}` : 'Feed',
        glyph: '◉',
        tone: feedState && feedState !== 'connected' ? 'is-unknown' : '',
        alert: feedState !== undefined && feedState !== 'connected',
        content: liveStatus,
      }]
      : []),
    // Only narrow: wide viewports keep the legend bottom-left where a map legend belongs.
    ...(narrow ? [{ id: 'legend', label: 'Legend', glyph: '☰', content: legend }] : []),
  ]

  if (unavailable) {
    return (
      <div className="city-viewport is-unavailable">
        <div className="viewport-fallback" role="status">
          <strong>Capacity city viewport unavailable</strong>
          <span>
            WebGL could not start. The complete item, route, and evidence tables remain available
            below and carry exactly the same facts as the map.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="city-viewport">
      <canvas
        ref={canvasRef}
        className="city-canvas"
        tabIndex={0}
        role="application"
        aria-label="Capacity city map. Drag to orbit, right-drag to pan, scroll to zoom."
        aria-describedby="city-map-help"
        onKeyDown={onKeyDown}
      />
      <p id="city-map-help" className="visually-hidden">
        Interactive three-dimensional map. Arrow keys pan, plus and minus zoom, left and right square
        brackets rotate, Home resets the view. Every fact drawn here is also listed in the evidence
        tables below this map.
      </p>

      {!narrow && finder && <div className="hud hud-top-left">{finder}</div>}

      <div className="hud hud-top-right">
        <MapTray label="Map overlays" items={trayItems} />
      </div>

      {openMarker && popupAt && (
        <IncidentPopup
          marker={openMarker}
          placement={popupPlacement}
          x={popupAt.x}
          y={popupAt.y}
          onClose={() => openIncident(null)}
        />
      )}

      {!narrow && <div className="hud hud-bottom-left">{legend}</div>}

      <div className="hud hud-bottom-right">
        <div className="hud-compass">
          <span className="compass-needle" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden="true">
            ▲
          </span>
          <span>
            {COMPASS_POINTS[Math.round(heading / 45) % 8]} · {Math.round(heading)}°
          </span>
        </div>
        <div className="hud-camera" role="group" aria-label="Camera controls">
          <button type="button" onClick={() => nudge('rotateLeft')} aria-label="Rotate left">⟲</button>
          <button type="button" onClick={() => nudge('zoomIn')} aria-label="Zoom in">＋</button>
          <button type="button" onClick={() => nudge('zoomOut')} aria-label="Zoom out">－</button>
          <button type="button" onClick={() => nudge('rotateRight')} aria-label="Rotate right">⟳</button>
          <button type="button" onClick={() => sceneRef.current?.resetView()}>Reset view</button>
          <button
            type="button"
            className="hud-tour-toggle"
            aria-pressed={touring}
            onClick={() => setTouring(current => !current)}
          >
            {touring ? 'Stop tour' : 'Take a tour'}
          </button>
          {route && <button type="button" onClick={() => sceneRef.current?.frameRoute()}>Frame route</button>}
          {selectedRoadId && (
            <button type="button" onClick={() => sceneRef.current?.frameRoad(selectedRoadId)}>Frame road</button>
          )}
        </div>
      </div>

      {/*
        The caption and the hover readout share the bottom-centre slot, so only one is ever mounted.
        The tour wins while it is running: a road label that follows the pointer is answering a
        question nobody asked during a hands-off display, and stacking the two would put the tour's
        own street captions next to a stale label for whatever the pointer was last left over.
      */}
      {tourStop ? (
        <div className="hud hud-tour">
          <span className={`hud-tour-kind hud-tour-kind-${tourStop.kind}`}>{TOUR_KINDS[tourStop.kind]}</span>
          <strong>{tourStop.caption}</strong>
          <span className="hud-tour-detail">{tourStop.detail}</span>
        </div>
      ) : (
        hoverLabel && (
          <div className="hud hud-road-readout" aria-hidden="true">
            <strong>Road</strong>
            <span>{hoverLabel}</span>
          </div>
        )
      )}
      <p className="visually-hidden" role="status">
        {tourStop
          ? `Tour: ${TOUR_KINDS[tourStop.kind]}. ${tourStop.caption}. ${tourStop.detail}`
          : hoverLabel
            ? `Road under pointer: ${hoverLabel}`
            : ''}
      </p>

      {panel && <div className="hud hud-panel">{panel}</div>}
    </div>
  )
}
