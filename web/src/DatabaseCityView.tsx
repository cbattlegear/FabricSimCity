import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  fetchDatabaseCity,
  fetchPlan,
  fetchQueryFamilies,
  fetchQueryFamily,
  subscribeToLiveIncidents,
} from './api'
import { accessibleObjectLabel, attributedAbsenceLabel, databaseCityMetricValue, databaseCitySharedMetricValue, formatKiB, shouldRenderRoute } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityPage, DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveIncidentResponse } from './liveContracts'
import type { LiveFeedConnectionState } from './liveIncidents'
import type { NormalizedShowplan, QueryFamilySummary } from './contracts'
import { DatabaseCityViewport } from './DatabaseCityViewport'
import { liveBlockingEdges, type LiveBlockingSummary } from './cityBlocking'
import { neighborhoodSwatch, planCity, type CityPlanOptions } from './cityPlan'
import { buildCityRoute, type CityRoute } from './cityRoute'
import { CONGESTION_LABELS, gradeRoads, type RoadTraffic } from './cityTraffic'
import { FACILITY_LABELS, projectFacilities, type Facility } from './cityInfrastructure'
import { projectFacilityTraffic, type FacilityTraffic } from './cityFacilityTraffic'
import { AddressBook } from './AddressPanel'
import { buildAddressBook, type AddressEntry } from './addressBook'
import { MapShell, SidebarHeader, StatusChip, ViewModeTile, type MapViewMode } from './MapShell'
import { projectIncidents } from './cityIncidents'

const metrics = ['cpu', 'duration', 'reads', 'executions'] as const
type Metric = (typeof metrics)[number]

type Props = {
  databaseId: string
  databaseName: string
  onBack: () => void
  /** Flat map or 3D city. Owned by the shell so the whole app shares one look. */
  viewMode: MapViewMode
  onViewModeChange: (mode: MapViewMode) => void
  /** Deployment and provenance cards, floated over the map by the shell. */
  banners: ReactNode
}

type PlanChoice = {
  planId: string
  familyId: string
  queryHash: string
  text: string | null
  textReason: string
  executionCount: string
}

export function DatabaseCityView({ databaseId, databaseName, onBack, viewMode, onViewModeChange, banners }: Props) {
  const [metric, setMetric] = useState<Metric>('cpu')
  const [page, setPage] = useState<DatabaseCityPage | null>(null)
  const [objects, setObjects] = useState<DatabaseCityObject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('object'))
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null)
  const [addressTerm, setAddressTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<LiveIncidentResponse | null>(null)
  const [feedState, setFeedState] = useState<LiveFeedConnectionState>('disconnected')
  const [planQuery, setPlanQuery] = useState('')
  const [planChoices, setPlanChoices] = useState<PlanChoice[]>([])
  const [planSearchState, setPlanSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [planSearchError, setPlanSearchError] = useState<string | null>(null)
  const [activePlan, setActivePlan] = useState<{ choice: PlanChoice; showplan: NormalizedShowplan } | null>(null)
  const [mappingFamilyId, setMappingFamilyId] = useState<string | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const requests = useRef(new Set<AbortController>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const roadInvokerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    for (const request of requests.current) request.abort()
    requests.current.clear()
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    setError(null)
    setPage(null)
    setObjects([])
    void fetchDatabaseCity(databaseId, metric, null, controller.signal)
      .then(value => {
        setPage(value)
        setObjects(value.objects)
        setSelectedId(current =>
          current && value.objects.some(object => object.objectId === current)
            ? current
            : value.objects[0]?.objectId ?? null)
      })
      .catch(reason => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason))
      })
      .finally(() => {
        requests.current.delete(controller)
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      requests.current.delete(controller)
    }
  }, [databaseId, metric])

  useEffect(() => () => {
    for (const request of requests.current) request.abort()
    requests.current.clear()
  }, [])

  useEffect(() => subscribeToLiveIncidents(setSnapshot, setFeedState), [])

  useEffect(() => {
    headingRef.current?.focus()
  }, [databaseId])

  const selectObject = useCallback((objectId: string) => {
    setSelectedId(objectId)
    // A building click answers a different question than a road click, so it takes over the panel.
    setSelectedRoadId(null)
    const url = new URL(window.location.href)
    url.searchParams.set('object', objectId)
    window.history.replaceState(null, '', url)
  }, [])

  const selectRoad = useCallback((routeId: string | null) => {
    // Remember what opened the panel. Its own controls unmount it, so closing has to hand focus
    // back deliberately instead of dropping the reader on document.body, where Tab restarts at
    // the top of the page.
    if (routeId) {
      const active = document.activeElement
      roadInvokerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    setSelectedRoadId(routeId)
  }, [])

  const restoreRoadFocus = useCallback(() => {
    const invoker = roadInvokerRef.current
    roadInvokerRef.current = null
    if (invoker?.isConnected) invoker.focus()
    else headingRef.current?.focus()
  }, [])

  const closeRoad = useCallback(() => {
    setSelectedRoadId(null)
    restoreRoadFocus()
  }, [restoreRoadFocus])

  const selectRoadEndpoint = useCallback((objectId: string) => {
    selectObject(objectId)
    restoreRoadFocus()
  }, [selectObject, restoreRoadFocus])

  // Escape closes the road panel from anywhere, because selecting a road on the map leaves focus
  // outside the panel entirely.
  useEffect(() => {
    if (!selectedRoadId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRoad()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedRoadId, closeRoad])

  const selected = objects.find(object => object.objectId === selectedId) ?? null
  /**
   * The map always draws every object that has loaded.
   *
   * Searching used to remove buildings from the city. On a map that is the wrong behaviour — you
   * search to find a place, not to delete the places you did not search for. The address book
   * narrows the *list* instead, and selecting an entry flies the camera to it.
   */
  const visibleObjects = objects
  const displayedSchemas = useMemo(() => {
    const byId = new Map<string, { schemaId: string; name: string; neighborhoodOrdinal: number; objectCount: number }>()
    for (const object of objects) {
      const existing = byId.get(object.schemaId)
      if (existing) existing.objectCount += 1
      else byId.set(object.schemaId, {
        schemaId: object.schemaId,
        name: object.schemaName,
        neighborhoodOrdinal: object.layout.neighborhoodOrdinal,
        objectCount: 1,
      })
    }
    return [...byId.values()].sort((left, right) =>
      left.neighborhoodOrdinal - right.neighborhoodOrdinal || left.schemaId.localeCompare(right.schemaId))
  }, [objects])

  const facilities = useMemo(() => projectFacilities(snapshot?.snapshot ?? null), [snapshot])
  const blocking = useMemo(
    () => liveBlockingEdges(snapshot?.snapshot ?? null, visibleObjects),
    [snapshot, visibleObjects])
  const incidents = useMemo(
    () => projectIncidents(snapshot?.snapshot ?? null, visibleObjects),
    [snapshot, visibleObjects])
  const families = page?.topQueryFamilies ?? []
  const facilityTraffic = useMemo(
    () => projectFacilityTraffic(families, visibleObjects),
    [families, visibleObjects])

  // Roads are graded here rather than inside the scene so the map, the hover readout, the road
  // panel, and the evidence table are all reading one set of numbers.
  const roads = useMemo(() => {
    if (!page) return [] as RoadTraffic[]
    const visible = new Set(visibleObjects.map(object => object.objectId))
    return gradeRoads(
      page.routes.filter(candidate => shouldRenderRoute(candidate, visible)),
      page.topQueryFamilies,
      blocking.edges,
    )
  }, [page, visibleObjects, blocking.edges])

  /** Schema-qualified name for an endpoint, falling back to the raw id for anything off this map. */
  const endpointName = useCallback((objectId: string) => {
    const object = objects.find(candidate => candidate.objectId === objectId)
    return object ? `${object.schemaName}.${object.name}` : objectId
  }, [objects])

  const roadLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const road of roads) {
      const volume = road.executions === null
        ? 'volume unavailable'
        : `${road.executions.toLocaleString()} executions`
      labels.set(
        road.routeId,
        `${endpointName(road.fromObjectId)} ↔ ${endpointName(road.toId)} · ${volume} · ${CONGESTION_LABELS[road.grade]}`,
      )
    }
    return labels
  }, [roads, endpointName])

  const selectedRoad = roads.find(road => road.routeId === selectedRoadId) ?? null
  useEffect(() => {
    // A road that filtering or a refresh removed must not leave a stale panel behind.
    if (selectedRoadId !== null && !roads.some(road => road.routeId === selectedRoadId)) setSelectedRoadId(null)
  }, [roads, selectedRoadId])

  /**
   * Everything `planCity` needs to lay the city out the same way every time: the database id as the
   * scatter seed, and the full totals so the grid is sized for the whole database rather than for
   * whichever pages happen to have arrived.
   */
  const planOptions: CityPlanOptions = useMemo(
    () => ({ seed: databaseId, totalObjects: page?.totalObjects ?? null, schemas: page?.schemas }),
    [databaseId, page?.totalObjects, page?.schemas],
  )

  const cityPlan = useMemo(
    () => planCity(visibleObjects, planOptions),
    [visibleObjects, planOptions],
  )

  const route: CityRoute | null = useMemo(() => {
    if (!activePlan) return null
    return buildCityRoute(activePlan.showplan, {
      plan: cityPlan,
      objects: visibleObjects,
      facilities: cityPlan.facilities,
      databaseName,
    })
  }, [activePlan, cityPlan, visibleObjects, databaseName])

  const loadMore = () => {
    if (!page?.nextPageToken) return
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    void fetchDatabaseCity(databaseId, metric, page.nextPageToken, controller.signal)
      .then(next => {
        setObjects(current => {
          const byId = new Map(current.map(object => [object.objectId, object]))
          for (const object of next.objects) byId.set(object.objectId, object)
          return [...byId.values()]
        })
        setPage(next)
      })
      .catch(reason => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason))
      })
      .finally(() => {
        requests.current.delete(controller)
        if (!controller.signal.aborted) setLoading(false)
      })
  }

  const searchPlans = useCallback(async () => {
    const term = planQuery.trim().toLocaleLowerCase()
    setPlanSearchState('loading')
    setPlanSearchError(null)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const familyPage = await fetchQueryFamilies(metric, null, controller.signal)
      const matches = familyPage.items
        .filter(family => !term || familyMatches(family, term))
        .slice(0, 8)
      const details = await Promise.all(
        matches.map(family =>
          fetchQueryFamily(family.familyId, controller.signal)
            .then(detail => ({ family, detail }))
            .catch(() => null)))
      const choices: PlanChoice[] = []
      for (const entry of details) {
        if (!entry) continue
        for (const plan of entry.detail.plans) {
          choices.push({
            planId: plan.planId,
            familyId: entry.family.familyId,
            queryHash: entry.family.queryHash,
            text: entry.family.text.normalizedText,
            textReason: entry.family.text.reason,
            executionCount: entry.family.executionCount,
          })
        }
      }
      const planTermMatches = term
        ? choices.filter(choice =>
          choice.planId.toLocaleLowerCase().includes(term) ||
          choice.familyId.toLocaleLowerCase().includes(term) ||
          choice.queryHash.toLocaleLowerCase().includes(term) ||
          (choice.text ?? '').toLocaleLowerCase().includes(term))
        : []
      setPlanChoices(planTermMatches.length > 0 ? planTermMatches : choices)
      setPlanSearchState('ready')
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setPlanSearchError(String(reason))
      setPlanSearchState('error')
    } finally {
      requests.current.delete(controller)
    }
  }, [metric, planQuery])

  const choosePlan = useCallback(async (choice: PlanChoice) => {
    setRouteError(null)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const showplan = await fetchPlan(choice.planId, controller.signal)
      setActivePlan({ choice, showplan })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setRouteError(String(reason))
    } finally {
      requests.current.delete(controller)
    }
  }, [])

  /**
   * Draws a ranked family's own plan on the map. The family row already carries the workload
   * evidence; this reads the one plan behind it so the same evidence becomes a route through the
   * buildings it named, instead of requiring the operator to rediscover it in the plan finder.
   */
  const showFamilyOnMap = useCallback(async (family: DatabaseCityQueryFamily) => {
    setRouteError(null)
    setMappingFamilyId(family.familyId)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const detail = await fetchQueryFamily(family.familyId, controller.signal)
      // Prefer a plan whose runtime is counted; a dispatcher plan carries no operator tree to walk.
      const plan = detail.plans.find(candidate => candidate.runtimeCounted) ?? detail.plans[0]
      if (!plan) {
        setRouteError(
          `Query Store retains no compiled plan for ${family.familyId}, so this family cannot be drawn as a route.`)
        return
      }
      const showplan = await fetchPlan(plan.planId, controller.signal)
      setActivePlan({
        choice: {
          planId: plan.planId,
          familyId: family.familyId,
          queryHash: family.queryHash,
          text: detail.family.text.normalizedText,
          textReason: detail.family.text.reason,
          executionCount: family.executionCount,
        },
        showplan,
      })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setRouteError(String(reason))
    } finally {
      requests.current.delete(controller)
      setMappingFamilyId(current => (current === family.familyId ? null : current))
    }
  }, [])

  const addressEntries = useMemo(
    () => buildAddressBook(visibleObjects, page?.topQueryFamilies ?? [], facilities, cityPlan),
    [visibleObjects, page?.topQueryFamilies, facilities, cityPlan],
  )

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null)

  /**
   * One click on an address does what that kind of address means: a table selects its building, a
   * query draws its plan across the city, and a facility selects the facility. All three then show
   * their place card over the list, which is the pattern every web map uses.
   */
  const openAddress = useCallback((entry: AddressEntry) => {
    setSelectedAddressId(entry.id)
    if (entry.kind === 'table') {
      selectObject(entry.targetId)
      return
    }
    if (entry.kind === 'query') {
      const family = page?.topQueryFamilies.find(candidate => candidate.familyId === entry.targetId)
      if (family) void showFamilyOnMap(family)
    }
  }, [page?.topQueryFamilies, selectObject, showFamilyOnMap])

  const selectedFacility = selectedAddressId?.startsWith('facility:')
    ? facilities.find(facility => `facility:${facility.kind}` === selectedAddressId) ?? null
    : null

  const planFinder = (
    <details className="sidebar-drawer">
      <summary>Route a captured query plan</summary>
      <div className="sidebar-drawer-body">
        <form
          className="hud-field"
          onSubmit={event => {
            event.preventDefault()
            void searchPlans()
          }}
        >
          <label>
            <span>Find a query plan</span>
            <input
              type="search"
              value={planQuery}
              onChange={event => setPlanQuery(event.target.value)}
              placeholder="plan id, family id, query hash, or text"
            />
          </label>
          <button type="submit">Route it</button>
        </form>
        {planSearchState === 'loading' && <p className="hud-note" role="status">Searching captured plans…</p>}
        {planSearchState === 'error' && <p className="hud-note is-error" role="alert">{planSearchError}</p>}
        {planSearchState === 'ready' && planChoices.length === 0 && (
          <p className="hud-note">No captured plan matches. Query Store only returns plans it captured.</p>
        )}
        {planChoices.length > 0 && (
          <ul className="hud-results">
            {planChoices.slice(0, 12).map(choice => (
              <li key={`${choice.familyId}:${choice.planId}`}>
                <button
                  type="button"
                  aria-pressed={activePlan?.choice.planId === choice.planId}
                  onClick={() => void choosePlan(choice)}
                >
                  <strong>{choice.planId}</strong>
                  <small>{choice.text ?? choice.textReason}</small>
                  <small>{choice.familyId} · {choice.executionCount} executions</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {routeError && <p className="hud-note is-error" role="alert">{routeError}</p>}
      </div>
    </details>
  )

  const liveStatus = (
    <div className={`hud-live feed-${feedState}`}>
      <span className="live-dot" aria-hidden="true" />
      <span>Live feed {feedState}</span>
      {blocking.probeReported
        ? <small>{blocking.edges.length} object(s) with blocked waiters</small>
        : <small>No lock-resource evidence reported</small>}
    </div>
  )

  /** The place card: whatever the map is currently pointing at, rendered over the address list. */
  const placeCard = route
    ? <RoutePanel route={route} plan={activePlan!} onClear={() => setActivePlan(null)} />
    : selectedRoad
      ? <RoadPanel
        road={selectedRoad}
        fromName={endpointName(selectedRoad.fromObjectId)}
        toName={endpointName(selectedRoad.toId)}
        onSelectEndpoint={selectRoadEndpoint}
        hasEndpoint={objectId => objects.some(object => object.objectId === objectId)}
        onClose={closeRoad}
      />
      : selectedFacility
        ? <FacilityPanel facility={selectedFacility} onClose={() => setSelectedAddressId(null)} />
        : selected
          ? <BuildingPanel object={selected} metric={metric} facilityCount={facilities.length} />
          : null

  const sidebar = (
    <>
      <SidebarHeader
        brand={<div className="sidebar-brand"><span className="sidebar-mark" aria-hidden="true" />SQLSimCity</div>}
        title={databaseName}
        subtitle={`${page?.totalObjects ?? '—'} objects · database city`}
        onBack={onBack}
        backLabel="Back to the server atlas"
      />

      {placeCard && <div className="sidebar-place-card">{placeCard}</div>}

      <AddressBook
        entries={addressEntries}
        term={addressTerm}
        onTermChange={setAddressTerm}
        selectedId={selectedAddressId}
        onSelect={openAddress}
        footer={
          <>
            <div className="sidebar-metric">
              <label>Rank workload
                <select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
                  {metrics.map(value => <option key={value}>{value}</option>)}
                </select>
              </label>
              {page?.nextPageToken && (
                <button type="button" className="load-more" onClick={loadMore}>
                  Load next bounded object page
                </button>
              )}
            </div>
            {planFinder}
            {page && <LegendDrawer
              page={page}
              objects={visibleObjects}
              metric={metric}
              selectedId={selectedId}
              selectedRoadId={selectedRoadId}
              onSelectObject={selectObject}
              onSelectRoad={selectRoad}
              endpointName={endpointName}
              roads={roads}
              facilities={facilities}
              facilityTraffic={facilityTraffic}
              blocking={blocking}
              displayedSchemas={displayedSchemas}
              activePlanFamilyId={activePlan?.choice.familyId ?? null}
              mappingFamilyId={mappingFamilyId}
              onShowFamily={showFamilyOnMap}
              selectedObject={selected}
            />}
          </>
        }
      />
    </>
  )

  return (
    <MapShell sidebar={sidebar}>
      {loading && !page && (
        <section className="stage-message loading" role="status">
          <span className="loading-mark" aria-hidden="true" /> Loading bounded database evidence…
        </section>
      )}
      {error && <section className="stage-message error" role="alert">{error}</section>}

      {page && (
        <DatabaseCityViewport
          objects={visibleObjects}
          planOptions={planOptions}
          viewMode={viewMode}
          roads={roads}
          facilities={facilities}
          facilityTraffic={facilityTraffic}
          route={route}
          selectedId={selectedId}
          selectedRoadId={selectedRoadId}
          onSelect={selectObject}
          onSelectRoad={selectRoad}
          roadLabels={roadLabels}
          liveStatus={liveStatus}
          incidents={incidents}
        />
      )}

      {page && (
        <StatusChip degraded={page.evidence.status !== 'Available'} title={page.evidence.reason}>
          {page.evidence.source} · {page.evidence.status}
        </StatusChip>
      )}

      <ViewModeTile mode={viewMode} onChange={onViewModeChange} />
      {banners}
    </MapShell>
  )
}

/**
 * Everything the map draws, written out as text.
 *
 * This is not an appendix. It is the accessible and auditable equivalent of the city, and the only
 * place some facts can appear at all — wait time with no facility to queue at, workload naming no
 * loaded object, lock waits that resolved to nothing. It lives behind a disclosure because the map
 * is the page now, not because any of it is optional.
 */
function LegendDrawer({
  page,
  objects,
  metric,
  selectedId,
  selectedRoadId,
  onSelectObject,
  onSelectRoad,
  endpointName,
  roads,
  facilities,
  facilityTraffic,
  blocking,
  displayedSchemas,
  activePlanFamilyId,
  mappingFamilyId,
  onShowFamily,
  selectedObject,
}: {
  page: DatabaseCityPage
  objects: readonly DatabaseCityObject[]
  metric: Metric
  selectedId: string | null
  selectedRoadId: string | null
  onSelectObject: (objectId: string) => void
  onSelectRoad: (routeId: string) => void
  endpointName: (objectId: string) => string
  roads: readonly RoadTraffic[]
  facilities: readonly Facility[]
  facilityTraffic: FacilityTraffic
  blocking: LiveBlockingSummary
  displayedSchemas: ReadonlyArray<{ schemaId: string; name: string; neighborhoodOrdinal: number; objectCount: number }>
  activePlanFamilyId: string | null
  mappingFamilyId: string | null
  onShowFamily: (family: DatabaseCityQueryFamily) => void | Promise<void>
  selectedObject: DatabaseCityObject | null
}) {
  return (
    <details className="sidebar-drawer">
      <summary>Legend &amp; evidence</summary>
      <div className="sidebar-drawer-body">
        <div className="city-legend" aria-label="Database city legend">
          <span><i className="legend-direct" /> direct cumulative DMV activity</span>
          <span><i className="legend-attributed" /> attributed Query Store aggregate</span>
          <span><i className="legend-unknown">×</i> unknown, nonquantitative size</span>
          <span><i className="legend-route" /> confidence-graded co-reference, never row flow</span>
        </div>

        <p className="mapping-note">
          <strong>What encodes evidence.</strong> Building footprint maps exact reserved 8-KiB pages
          logarithmically and height maps exact used pages, so a one-page table is a house and a
          multi-gigabyte table is a skyscraper for a measured reason. Amber roof-cap height maps
          attributed Query Store CPU; index annex width maps direct DMV operations, and indexes stay
          attached to their parent. Road width maps the executions of query families naming both
          endpoints; road colour maps captured wait share, upgraded to red only where a resolved live
          lock names that object; route line pattern maps co-reference confidence, never row flow.
          Wait-lane width maps the captured Query Store wait milliseconds a building&apos;s workload
          spent queued at one infrastructure facility, and lane colour names that destination; a
          category with no facility here is listed, never folded into one. A query family naming
          several objects draws one shared lane threaded through each of them before reaching the
          facility: that lane carries the family&apos;s whole captured wait, drawn once, so it is
          neither divided between those buildings nor counted inside any of their own totals.
          Unknown size or unavailable activity uses fixed wireframe geometry and makes no quantity
          claim. Ground labels name each building and facility and carry identity only — a label
          never restates or qualifies a measurement.
        </p>

        <p className="mapping-note">
          <strong>Neighbourhoods are real; addresses are not.</strong> Each schema holds one
          contiguous quarter of the city, so two tables in the same schema are always near each
          other and a building&apos;s neighbourhood is a catalogue fact you can check. Inside that
          quarter nothing is sorted: which block a building gets is drawn from a generator seeded
          with the database id, so neighbouring buildings are <em>not</em> related by being
          neighbours, and how far apart two schemas sit is an accident of the seed rather than a
          measure of how related they are. The same database always produces the same city on every
          machine while two databases of identical shape produce different ones. A
          neighbourhood&apos;s hue and the label across its ground name the schema and nothing more;
          hues are handed out in catalogue order, so none is warmer, larger or busier than another.
          A larger schema does claim more ground, but only roughly — borders land wherever two
          neighbourhoods happen to meet, so read the counts beside each name rather than the area.
          Infrastructure facilities are scattered at least two blocks apart so they act as landmarks
          rather than one civic corner. Street class, roof shapes, windows, setbacks, crowns and
          sidewalks are decoration and encode nothing.
        </p>

        <p className="mapping-note">
          <strong>The scenery is not evidence.</strong> The landscape this city sits in is drawn, not
          measured. The river and its banks, the ground relief, every land-use area — parks,
          woodland, orchards, plazas, parking, yards and open water — the trees, hedges, streetlights,
          benches, parked cars and other street furniture, the architecture of the six infrastructure
          facilities, the road <em>shape</em> including curves, the ring boulevard, diagonal avenues
          and which pattern of streets fills each district, and the whole golden-hour palette, sky and
          shadows are all generated from the same database-id seed as the block layout. None of them
          is derived from any measurement, so none of them can be read as one: a park is not idle
          space, a curving street is not a slow query, a wooded edge is not a cold table, and a
          district with few streets is not a sparse schema. Everything that does carry a quantity is
          listed above.
        </p>

        <div className="city-schema-strip" aria-label="Neighbourhoods">
          {displayedSchemas.map(schema => <div key={schema.schemaId}>
            <strong>
              <i className="legend-swatch" style={{ background: neighborhoodSwatch(schema.neighborhoodOrdinal) }} aria-hidden="true" />
              {schema.name}
            </strong>
            <span>{schema.objectCount} objects</span>
          </div>)}
        </div>

        <section className="table-region" aria-labelledby="city-object-table">
          <div className="section-heading">
            <div><h2 id="city-object-table">Objects and attached indexes</h2><p>Text-first equivalent of the viewport</p></div>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Object</th><th>Size</th><th>Direct activity</th><th>Attributed exposure</th></tr></thead>
              <tbody>{objects.map(object => <tr key={object.objectId} className={selectedId === object.objectId ? 'is-selected' : undefined}>
                <th scope="row"><button type="button" aria-label={accessibleObjectLabel(object)}
                  aria-pressed={selectedId === object.objectId} onClick={() => onSelectObject(object.objectId)}>
                  {object.schemaName}.{object.name}
                </button><small>{object.kind} · {object.indexes.length} attached indexes</small></th>
                <td>{object.reservedBytes === null ? <><strong>Unknown ×</strong><small>{object.sizeReason}</small></> :
                  <><strong>{formatKiB(object.reservedBytes)} reserved</strong><small>{formatKiB(object.usedBytes!)} used</small></>}</td>
                <td><strong>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</strong>
                  <small>{object.directActivity.evidence.source} · {object.directActivity.evidence.reason}</small></td>
                <td><strong>{databaseCityMetricValue(object, metric) ?? attributedAbsenceLabel(object)}</strong>
                  {object.attributedExposure.shared &&
                    <span>shared {databaseCitySharedMetricValue(object, metric)} across {object.attributedExposure.shared.familyCount} joined quer{object.attributedExposure.shared.familyCount === '1' ? 'y' : 'ies'}</span>}
                  <small>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}
                    {object.attributedExposure.shared ? ` ${object.attributedExposure.shared.rationale}` : ''}</small></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <ObjectDetail object={selectedObject} metric={metric} />

        <section className="city-infrastructure-table" aria-labelledby="city-infrastructure-title">
          <div className="section-heading">
            <div><h2 id="city-infrastructure-title">Civic infrastructure</h2>
              <p>CPU, memory, storage, tempdb, log, and lock facilities from the live snapshot</p></div>
          </div>
          <ul className="facility-list">
            {facilities.map(facility => <li key={facility.kind} className={facility.known ? undefined : 'is-unknown'}>
              <strong>{FACILITY_LABELS[facility.kind]}</strong>
              <span>{facility.headline}</span>
              <small>{facility.status} · {facility.reason}</small>
              {facility.units.length > 0 && <ul>
                {facility.units.slice(0, 8).map(unit => <li key={unit.id}>
                  {unit.label}: {unit.detail}{unit.alert ? ' ⚠' : ''}
                </li>)}
              </ul>}
            </li>)}
          </ul>
          {blocking.unresolved.length > 0 && <p className="hud-note">
            {blocking.unresolved.length} live lock wait(s) could not be resolved to an object:
            {' '}{blocking.unresolved[0].reason}
          </p>}
          {blocking.offPageCount > 0 && <p className="hud-note">
            {blocking.offPageCount} resolved lock wait(s) name an object outside this bounded page.
          </p>}
        </section>

        <FacilityTrafficTable traffic={facilityTraffic} objects={objects} />

        <section className="city-workload" aria-labelledby="city-workload-title">
          <div className="section-heading">
            <div><h2 id="city-workload-title">Top query-family exposure</h2>
              <p>Backend-ranked top 12; no browser-side 100k layout</p></div>
          </div>
          <div className="table-scroll"><table>
            <thead><tr><th>Family</th><th>Executions</th><th>CPU µs</th><th>Duration µs</th><th>Reads (8-KiB)</th><th>Attribution</th><th>Map</th></tr></thead>
            <tbody>{page.topQueryFamilies.map(family => <tr key={family.familyId}>
              <th scope="row">{family.familyId}<small>{family.queryHash} · {family.evidence.source}</small></th>
              <td>{family.executionCount}</td><td>{family.totalCpuMicroseconds}</td>
              <td>{family.totalDurationMicroseconds}</td><td>{family.totalLogicalReads8KiBPages}</td>
              <td>{family.confidence}<small>{family.rationale}</small></td>
              <td className="map-cell"><button
                type="button"
                disabled={mappingFamilyId === family.familyId}
                aria-label={`Draw the plan for ${family.familyId} on the map`}
                onClick={() => void onShowFamily(family)}
              >{mappingFamilyId === family.familyId ? 'Reading plan…' : 'Show on map'}</button>
                {activePlanFamilyId === family.familyId && <small>Drawn on the map</small>}</td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Other workload ({page.otherWorkload.familyCount ?? 'count unavailable'} families)</th>
              <td>{page.otherWorkload.executionCount ?? 'Unavailable'}</td><td>{page.otherWorkload.totalCpuMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalDurationMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalLogicalReads8KiBPages ?? 'Unavailable'}</td>
              <td>Aggregate only<small>{page.otherWorkload.evidence.reason}</small></td>
              <td>Not a single query<small>An aggregate has no one plan to draw.</small></td></tr></tfoot>
          </table></div>
        </section>

        <section className="topology city-routes" aria-labelledby="city-routes-title">
          <div className="section-heading"><div><h2 id="city-routes-title">Evidence-labeled routes</h2>
            <p>Confidence is encoded by pattern and text; routes do not claim row flow</p></div></div>
          <ul>{page.routes.map(route => {
            const graded = roads.find(road => road.routeId === route.routeId) ?? null
            return <li key={route.routeId} className={route.routeId === selectedRoadId ? 'is-selected' : undefined}>
              <span className={`edge-mark edge-${route.confidence.toLowerCase()}`} aria-hidden="true" />
              <strong>{route.kind} · {route.confidence}</strong>
              <span>
                {graded
                  ? <button
                    type="button"
                    className="route-endpoints"
                    aria-pressed={route.routeId === selectedRoadId}
                    onClick={() => onSelectRoad(route.routeId)}
                  >
                    {endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}
                  </button>
                  : <>{endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}</>}
                <br />
                {graded
                  ? `${CONGESTION_LABELS[graded.grade]} · ${graded.rationale} `
                  : 'Not drawn on the map: an endpoint is outside the loaded page. '}
                {route.rationale} · {route.evidence.status}
              </span>
            </li>
          })}</ul>
        </section>
      </div>
    </details>
  )
}

/** Place card for one infrastructure facility, opened from the address book. */
function FacilityPanel({ facility, onClose }: { facility: Facility; onClose: () => void }) {
  return (
    <aside className="detail place-card" aria-labelledby="facility-panel-title">
      <div className="detail-title">
        <h2 id="facility-panel-title">{FACILITY_LABELS[facility.kind]}</h2>
        <button type="button" onClick={onClose} aria-label="Close facility detail">✕</button>
      </div>
      <p className={facility.known ? undefined : 'is-unknown'}>{facility.headline}</p>
      {facility.units.length > 0 && (
        <dl>
          {facility.units.slice(0, 10).map(unit => (
            <div key={unit.id}><dt>{unit.label}</dt><dd>{unit.detail}{unit.alert ? ' ⚠' : ''}</dd></div>
          ))}
        </dl>
      )}
      <div className="source-note">
        <strong>{facility.status}</strong>
        <p>{facility.reason}</p>
      </div>
    </aside>
  )
}

function familyMatches(family: QueryFamilySummary, term: string): boolean {
  return (
    family.familyId.toLocaleLowerCase().includes(term) ||
    family.queryHash.toLocaleLowerCase().includes(term) ||
    (family.text.normalizedText ?? '').toLocaleLowerCase().includes(term)
  )
}

/**
 * Text-first equivalent of the wait-lane layer. Everything the map draws is listed here, plus the
 * three things the map deliberately cannot draw: categories with no facility, wait time shared by
 * families naming several objects, and wait time from families naming no loaded object.
 */
function FacilityTrafficTable({
  traffic,
  objects,
}: {
  traffic: FacilityTraffic
  objects: readonly DatabaseCityObject[]
}) {
  const nameOf = (objectId: string) => {
    const object = objects.find(item => item.objectId === objectId)
    return object ? `${object.schemaName}.${object.name}` : objectId
  }
  // Captured milliseconds are lossless base-10 strings, so they are grouped as BigInt: rendering an
  // exact counter through a double would round it, and the saturation note promises exactness.
  const exact = (milliseconds: string) => BigInt(milliseconds).toLocaleString()
  return (
    <section className="city-wait-lanes" aria-labelledby="city-wait-lanes-title">
      <div className="section-heading">
        <div>
          <h2 id="city-wait-lanes-title">Waits as traffic to infrastructure</h2>
          <p>Captured Query Store wait categories routed to the facility that owns the resource</p>
        </div>
      </div>
      <p className="hud-note">{traffic.note}</p>
      {traffic.lanes.length > 0 && <div className="table-scroll"><table>
        <thead><tr>
          <th>Building</th><th>Facility</th><th>Captured wait (ms)</th>
          <th>Categories</th><th>Attribution</th>
        </tr></thead>
        <tbody>{traffic.lanes.map(lane => <tr key={lane.laneId}>
          <th scope="row">{nameOf(lane.objectId)}<small>{lane.familyIds.join(' · ')}</small></th>
          <td>{lane.facilityLabel}</td>
          <td>{exact(lane.waitMilliseconds)}
            {lane.saturated && <small>Wider than the map can draw; this figure is exact, the lane
              width is a floor.</small>}</td>
          <td>{lane.categories
            .map(total => `${total.category} ${exact(total.waitMilliseconds)}`)
            .join(' · ')}</td>
          <td>{lane.confidence}<small>{lane.rationale}</small></td>
        </tr>)}</tbody>
      </table></div>}
      {traffic.sharedLanes.length > 0 && <div className="table-scroll"><table>
        <caption>
          Shared lanes — one multi-object query family each, drawn once through every object it
          names. Each figure is the family&apos;s whole captured wait: it is not divided between these
          buildings, is not part of any building&apos;s total above, and must not be summed with them.
        </caption>
        <thead><tr>
          <th>Query family</th><th>Buildings it threads</th><th>Facility</th>
          <th>Captured wait (ms)</th><th>Categories</th><th>Attribution</th>
        </tr></thead>
        <tbody>{traffic.sharedLanes.map(lane => <tr key={lane.laneId}>
          <th scope="row">{lane.familyId}</th>
          <td>{lane.objectIds.map(nameOf).join(' · ')}
            {lane.offPageObjectCount > 0 && <small>{lane.offPageObjectCount} further named
              object/objects are not on this page, so the drawn path is shorter than the
              relationship.</small>}</td>
          <td>{lane.facilityLabel}</td>
          <td>{exact(lane.waitMilliseconds)}
            {lane.saturated && <small>Wider than the map can draw; this figure is exact, the lane
              width is a floor.</small>}</td>
          <td>{lane.categories
            .map(total => `${total.category} ${exact(total.waitMilliseconds)}`)
            .join(' · ')}</td>
          <td>{lane.confidence}<small>{lane.rationale}</small></td>
        </tr>)}</tbody>
      </table></div>}
      {traffic.unmapped.length > 0 && <div className="source-note">
        <strong>Captured waits with no facility on this map</strong>
        <ul>{traffic.unmapped.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms — {entry.reason}
        </li>)}</ul>
      </div>}
      {traffic.shared.length > 0 && <div className="source-note">
        <strong>Wait time from multi-object families with nothing on this page</strong>
        <p>
          Query Store reports one wait total per query, not per object. These families name only
          objects absent from this page, so there is no honest path to thread a shared lane through;
          the time is reported whole here rather than divided or handed to a building that the
          family never named.
        </p>
        <ul>{traffic.shared.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms
        </li>)}</ul>
      </div>}
      {traffic.unattributed.length > 0 && <div className="source-note">
        <strong>Wait time from families naming no object on this page</strong>
        <ul>{traffic.unattributed.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms
        </li>)}</ul>
      </div>}
    </section>
  )
}

function RoutePanel({
  route,
  plan,
  onClear,
}: {
  route: CityRoute
  plan: { choice: PlanChoice; showplan: NormalizedShowplan }
  onClear: () => void
}) {
  return (
    <aside className="hud-slideover" aria-labelledby="city-route-title">
      <div className="detail-title">
        <h2 id="city-route-title">Route through the city</h2>
        <button type="button" onClick={onClear}>Clear</button>
      </div>
      <p className="hud-note">
        Plan {plan.choice.planId} · {route.stops.length - route.offMapStops.length} of {route.stops.length} stops
        placed on this map
        {route.offMapStops.length > 0 ? ` · ${route.offMapStops.length} off-map` : ''}
      </p>
      <ol className="route-directions">
        {route.stops.map(stop => (
          <li key={stop.ordinal} className={`stop-${stop.kind}`}>
            <strong>{stop.physicalOperation}</strong>
            <span>{stop.label}</span>
            <small>{stop.instruction}</small>
            {stop.warnings.length > 0 && <small className="is-warning">⚠ {stop.warnings.join(' · ')}</small>}
          </li>
        ))}
      </ol>
      {route.offMapStops.length > 0 && (
        <div className="source-note">
          <strong>Off-map stops</strong>
          <ul>
            {route.offMapStops.map(stop => (
              <li key={stop.ordinal}>
                {stop.physicalOperation} — {stop.unresolvedReason ?? stop.instruction}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="source-note">
        <strong>Compiled plan shape only</strong>
        <p>{route.runtimeOverlayCaveat}</p>
      </div>
    </aside>
  )
}

function RoadPanel({
  road,
  fromName,
  toName,
  onSelectEndpoint,
  hasEndpoint,
  onClose,
}: {
  road: RoadTraffic
  fromName: string
  toName: string
  onSelectEndpoint: (objectId: string) => void
  hasEndpoint: (objectId: string) => boolean
  onClose: () => void
}) {
  const endpoint = (objectId: string, name: string) =>
    hasEndpoint(objectId)
      ? <button type="button" className="link-button" onClick={() => onSelectEndpoint(objectId)}>{name}</button>
      : <span>{name} <small>(not on this map)</small></span>

  return (
    <aside className="hud-slideover" aria-labelledby="city-road-title">
      <div className="detail-title">
        <h2 id="city-road-title">Road</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p className="road-endpoints">
        {endpoint(road.fromObjectId, fromName)}
        <span aria-hidden="true"> ↔ </span>
        <span className="visually-hidden">is referenced together with</span>
        {endpoint(road.toId, toName)}
      </p>
      <dl>
        <div><dt>Reference</dt><dd>{road.kind} · {road.confidence}</dd></div>
        <div><dt>Executions</dt><dd>{road.executions?.toLocaleString() ?? 'Unavailable'}</dd></div>
        <div><dt>Query families</dt><dd>{road.familyIds.length}</dd></div>
        <div><dt>Wait share</dt><dd>
          {road.waitShare === null ? 'Unavailable' : `${(road.waitShare * 100).toFixed(1)}%`}
        </dd></div>
        <div><dt>Congestion</dt><dd>{CONGESTION_LABELS[road.grade]}</dd></div>
      </dl>
      <div className="source-note">
        <strong>Why this road looks like this</strong>
        <p>{road.rationale}</p>
      </div>
      <p className="hud-note">
        Width maps captured executions naming both endpoints; colour maps captured wait share. The
        road follows the street grid and claims a reference between these two objects, never row flow.
      </p>
    </aside>
  )
}

function BuildingPanel({
  object,
  metric,
  facilityCount,
}: {
  object: DatabaseCityObject
  metric: Metric
  facilityCount: number
}) {
  // Shared totals are query-level and repeat on every object the query named, so they are shown on
  // their own row and never substituted for the attributed figure above them.
  const shared = databaseCitySharedMetricValue(object, metric)
  return (
    <aside className="hud-slideover" aria-labelledby="city-building-title">
      <div className="detail-title">
        <h2 id="city-building-title">{object.schemaName}.{object.name}</h2>
        <span>{object.kind}</span>
      </div>
      <dl>
        <div><dt>Reserved pages</dt><dd>{object.reservedPages8KiB ?? object.sizeReason}</dd></div>
        <div><dt>Used pages</dt><dd>{object.usedPages8KiB ?? object.sizeReason}</dd></div>
        <div><dt>Direct operations</dt><dd>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</dd></div>
        <div><dt>{metric} attributed</dt><dd>{databaseCityMetricValue(object, metric) ?? attributedAbsenceLabel(object)}</dd></div>
        {shared && <div className="is-shared">
          <dt>{metric} shared</dt>
          <dd>{shared} <small>across {object.attributedExposure.shared!.familyCount} joined quer{object.attributedExposure.shared!.familyCount === '1' ? 'y' : 'ies'}</small></dd>
        </div>}
        <div><dt>Attached indexes</dt><dd>{object.indexes.length}</dd></div>
      </dl>
      <p className="hud-note">{facilityCount} infrastructure facilities are scattered across the block grid.</p>
      <div className="source-note">
        <strong>Attributed evidence</strong>
        <p>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}</p>
        {object.attributedExposure.shared && <p>{object.attributedExposure.shared.rationale}</p>}
      </div>
    </aside>
  )
}

function ObjectDetail({ object, metric }: { object: DatabaseCityObject | null; metric: Metric }) {
  if (!object) return <aside className="detail"><p>No object matches this page and filter.</p></aside>
  return <aside className="detail city-object-detail" aria-labelledby="city-object-detail-title">
    <div className="detail-title"><h2 id="city-object-detail-title">{object.schemaName}.{object.name}</h2><span>{object.kind}</span></div>
    <dl>
      <div><dt>Stable ID</dt><dd>{object.objectId}</dd></div>
      <div><dt>Reserved pages / bytes</dt><dd>{object.reservedPages8KiB ?? 'Unavailable'} / {object.reservedBytes ?? 'Unavailable'}</dd></div>
      <div><dt>Used pages / bytes</dt><dd>{object.usedPages8KiB ?? 'Unavailable'} / {object.usedBytes ?? 'Unavailable'}</dd></div>
      <div><dt>Direct operations</dt><dd>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</dd></div>
      <div><dt>Reset epoch</dt><dd>{object.directActivity.resetEpochToken ?? 'Unavailable'}</dd></div>
      <div><dt>{metric} attributed</dt><dd>{databaseCityMetricValue(object, metric) ?? 'Unavailable'}</dd></div>
      {object.attributedExposure.shared && <div className="is-shared">
        <dt>{metric} shared</dt>
        <dd>{databaseCitySharedMetricValue(object, metric)} across {object.attributedExposure.shared.familyCount} joined quer{object.attributedExposure.shared.familyCount === '1' ? 'y' : 'ies'}</dd>
      </div>}
    </dl>
    <h3>Attached indexes</h3>
    {object.indexes.length === 0 ? <p>None reported.</p> : <ul className="attached-indexes">
      {object.indexes.map(index => <li key={index.indexId}><strong>{index.name}</strong>
        <span>{index.kind} · direct operations {index.directActivity.totalOperations ?? index.directActivity.evidence.status}</span>
        <small>{index.directActivity.evidence.source}: {index.directActivity.evidence.reason}</small></li>)}
    </ul>}
    <div className="source-note"><strong>Direct evidence</strong><p>
      {object.directActivity.evidence.source} · {object.directActivity.evidence.status} · {object.directActivity.evidence.reason}
    </p></div>
    <div className="source-note"><strong>Attributed evidence</strong><p>
      {object.attributedExposure.evidence.source} · {object.attributedExposure.confidence} · {object.attributedExposure.rationale}
    </p>
    {object.attributedExposure.shared && <p>{object.attributedExposure.shared.rationale}</p>}
    </div>
  </aside>
}
