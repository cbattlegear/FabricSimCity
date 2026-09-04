import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CapacityAtlasItem, Evidence, ThrottleState } from './fabricContracts'
import type {
  CapacityCityItem,
  CapacityCityPage,
} from './capacityCityContracts'
import type { CapacitySource } from './collect/source'
import { CITY_PAGE_SIZE } from './collect/source'
import { CapacityCityViewport, type CityRoute } from './CapacityCityViewport'
import {
  KioskToggle,
  MapShell,
  SidebarHeader,
  ViewModeTile,
  type MapViewMode,
} from './MapShell'
import {
  cityItemMetricValue,
  itemMassing,
  shouldRenderRoute,
  storageSummary,
} from './capacityCity'
import {
  formatCu,
  formatMinutes,
  formatPercent,
  splitPascal,
} from './capacityAtlas'
import { planCity, type CityPlanOptions } from './cityPlan'
import { assignWorkloadTraffic } from './cityWorkloadTraffic'
import {
  CONGESTION_LABELS,
  describeTrafficEvidence,
  describeTrafficWindow,
  gradeRoads,
  type RoadTraffic,
} from './cityTraffic'
import { projectFacilities } from './cityInfrastructure'
import {
  POWER_GRID_FACILITY_LEGEND,
  POWER_GRID_STATE_LEGEND,
  projectFacilityTraffic,
} from './cityFacilityTraffic'
import { projectPowerGrid } from './powerGrid'
import { AddressBook } from './AddressPanel'
import { buildAddressBook, type AddressEntry } from './addressBook'
import { IncidentSummary } from './IncidentPopup'
import {
  incidentDemandsAttention,
  incidentSummaryLabel,
  projectIncidents,
} from './cityIncidents'
import {
  drawersHoldOpenRegion,
  effectiveRegion,
  toggleRegion,
  type SidebarRegion,
} from './sidebarAccordion'
import { resolveSidebarMode } from './sidebarMode'
import { projectCityDisasters } from './cityDisasters'
import { refreshIntervalMs } from './cityRefresh'
import { startTimepointClock } from './timepointClock'
import {
  describeTimepointEvidence,
  emptyTimepointFeed,
  timepointClockLabel,
  type TimepointFeed,
} from './timepointFeed'
import type { OperationSample } from './capacityCityContracts'

type Props = {
  source: CapacitySource
  capacity: CapacityAtlasItem
  onBack: () => void
  viewMode: MapViewMode
  onViewModeChange: (mode: MapViewMode) => void
  kiosk: boolean
  onToggleKiosk: () => void
}

/** How many operation samples the live feed pulls per poll for incident corroboration. */
const SAMPLE_LIMIT = 200

function swatch(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function isStale(evidence: Evidence): boolean {
  return evidence.status === 'Stale'
}

/**
 * The city over one Fabric capacity.
 *
 * A capacity is the city, its workspaces the neighbourhoods, its items the buildings. This mounts the
 * 3D scene through {@link CapacityCityViewport} and feeds it a single measured pipeline: the plan, the
 * graded roads, the workload streets, the throttling incidents, the capacity weather, and a timepoint
 * clock that never claims to be live. Every layer holds the one rule the whole app rests on — a
 * missing measurement is drawn as wireframe or announced as "not observed", never as a zero.
 */
export function CapacityCityView({
  source,
  capacity,
  onBack,
  viewMode,
  onViewModeChange,
  kiosk,
  onToggleKiosk,
}: Props) {
  const [page, setPage] = useState<CapacityCityPage | null>(null)
  const [samples, setSamples] = useState<readonly OperationSample[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null)
  const [openIncidentId, setOpenIncidentId] = useState<string | null>(null)
  const [incidentFocus, setIncidentFocus] = useState<{ itemId: string; nonce: number } | null>(null)
  const [finderTerm, setFinderTerm] = useState('')
  /*
   * One region open at a time. `chosenRegion` is what the reader clicked; `openRegion` folds in a
   * live search term, which pins the directory open (see `sidebarAccordion.ts`). The whole rail is
   * one fixed-height column, so letting each `<details>` own its state starved every region but the
   * tallest — the defect the accordion module documents.
   */
  const [chosenRegion, setChosenRegion] = useState<SidebarRegion | null>(null)
  const wasAlerting = useRef(false)
  const [feed, setFeed] = useState<TimepointFeed>(() => emptyTimepointFeed(source.capabilities))

  const capacityId = capacity.capacityId

  // Reset per-capacity state when the city changes so nothing from the last capacity leaks in.
  useEffect(() => {
    setPage(null)
    setSamples(null)
    setSelectedId(null)
    setSelectedRoadId(null)
    setOpenIncidentId(null)
    setChosenRegion(null)
    setFeed(emptyTimepointFeed(source.capabilities))
  }, [capacityId, source])

  // Read the city page (and refresh it on the source's declared cadence). The whole app runs on
  // fixtures here, but the seam is the real CapacitySource so a live source drops straight in.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await source.readCityPage({
          capacityId,
          metric: 'Cu',
          pageSize: CITY_PAGE_SIZE,
        })
        if (!cancelled) {
          setPage(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const interval = Math.max(5_000, refreshIntervalMs(source.capabilities))
    const handle = window.setInterval(() => void load(), interval)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [capacityId, source])

  // Pull operation samples for live rejection corroboration. Empty (not an error) when the source
  // cannot supply them; the incident projection treats that as "unsupported", not "quiet".
  useEffect(() => {
    if (!source.capabilities.operationSamples) {
      setSamples(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const next = await source.readOperationSamples({ capacityId, limit: SAMPLE_LIMIT })
        if (!cancelled) setSamples(next)
      } catch {
        if (!cancelled) setSamples(null)
      }
    }
    void load()
    const handle = window.setInterval(() => void load(), Math.max(5_000, refreshIntervalMs(source.capabilities)))
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [capacityId, source])

  /*
   * The timepoint clock. `startTimepointClock` is the cancellable client-side poller over the
   * `CapacitySource` seam (a Fabric App on Rayfin has no push hub): it schedules no loop at all for a
   * source without the `timepoints` capability, folds each read through `advanceTimepointFeed`, and
   * its disposer clears the interval + aborts in flight — so mounting it here and returning the
   * disposer disposes the clock on unmount or a capacity change. Never labels anything "live".
   */
  useEffect(() => {
    setFeed(emptyTimepointFeed(source.capabilities))
    const dispose = startTimepointClock({ source, capacityId, onFeed: setFeed })
    return () => dispose()
  }, [capacityId, source])

  const items = useMemo(() => page?.items ?? [], [page])
  const families = useMemo(() => page?.topOperationFamilies ?? [], [page])

  const planOptions: CityPlanOptions = useMemo(
    () => ({ seed: capacityId, totalItems: page?.totalItems ?? null, workspaces: page?.workspaces ?? [] }),
    [capacityId, page],
  )
  const cityPlan = useMemo(() => planCity(items, planOptions), [items, planOptions])

  const facilities = useMemo(() => projectFacilities(null), [])

  const trafficEvidence = useMemo(
    () => describeTrafficEvidence(source.capabilities, families),
    [source, families],
  )

  const incidents = useMemo(
    () =>
      projectIncidents({
        families,
        items,
        samples,
        throttle: page?.throttle ?? emptyThrottle(),
        capabilities: source.capabilities,
        observedAt: page?.window.end ?? new Date().toISOString(),
      }),
    [page, families, items, samples, source],
  )

  const roads = useMemo<readonly RoadTraffic[]>(() => {
    if (!page || !trafficEvidence.drawRoads) return []
    const visible = new Set(items.map(item => item.itemId))
    const routes = page.routes.filter(route => shouldRenderRoute(route, visible))
    return gradeRoads(routes, families, incidents.liveRejections.edges)
  }, [page, trafficEvidence, items, families, incidents])

  const roadLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const road of roads) {
      const ops = road.operations === null ? 'unmeasured operations' : `${road.operations.toLocaleString()} operations`
      labels.set(road.routeId, `${CONGESTION_LABELS[road.grade]} · ${ops}`)
    }
    return labels
  }, [roads])

  const workloadTraffic = useMemo(() => assignWorkloadTraffic(cityPlan, families), [cityPlan, families])

  const facilityTraffic = useMemo(
    () => projectFacilityTraffic(families, items, page?.throttle ?? emptyThrottle(), source.capabilities),
    [families, items, page, source],
  )

  const disasters = useMemo(() => {
    if (!page) return null
    return projectCityDisasters({ throttle: page.throttle, items, capabilities: source.capabilities })
  }, [page, items, source])

  const fireObjectIds = useMemo(() => disasters?.blackedOutItemIds ?? [], [disasters])
  const staleStatsObjectIds = useMemo(
    () => items.filter(item => isStale(item.evidence)).map(item => item.itemId),
    [items],
  )

  const addressEntries = useMemo(
    () => buildAddressBook(items, families, facilities, cityPlan),
    [items, families, facilities, cityPlan],
  )

  const powerGrid = useMemo(() => projectPowerGrid(capacity), [capacity])

  const trafficWindow = useMemo(
    () => describeTrafficWindow(families, page?.evidence.observedAt ?? null, refreshIntervalMs(source.capabilities)),
    [families, page, source],
  )

  const timepointEvidence = useMemo(
    () => describeTimepointEvidence(source.capabilities, feed),
    [source, feed],
  )

  const selectedItem = useMemo(
    () => items.find(item => item.itemId === selectedId) ?? null,
    [items, selectedId],
  )
  const selectedRoad = useMemo(
    () => roads.find(road => road.routeId === selectedRoadId) ?? null,
    [roads, selectedRoadId],
  )

  const onAddressSelect = (entry: AddressEntry) => {
    if (entry.kind === 'item') {
      setSelectedId(entry.targetId)
      setSelectedRoadId(null)
      setIncidentFocus({ itemId: entry.targetId, nonce: Date.now() })
    }
  }

  const onOpenIncident = (id: string | null) => {
    setOpenIncidentId(id)
    if (id) {
      const marker = incidents.markers.find(m => m.id === id)
      if (marker) setIncidentFocus({ itemId: marker.itemId, nonce: Date.now() })
    }
  }

  const placeCard = selectedItem !== null || selectedRoad !== null
  const openRegion = effectiveRegion(chosenRegion, finderTerm)
  const alerting = incidentDemandsAttention(incidents)

  /*
   * Live throttling opens the activity drawer on its own — but only on the transition into that
   * state. The old markup bound `open={incidentDemandsAttention(incidents)}` straight to the
   * element and got away with it because React writes a DOM property only when the prop changes.
   * One shared piece of accordion state has no such prop, so a standing warning would reopen the
   * drawer on every render and pin the other regions shut; the ref is what makes it fire once.
   */
  useEffect(() => {
    if (alerting && !wasAlerting.current) setChosenRegion('activity')
    wasAlerting.current = alerting
  }, [alerting])

  const onRegionToggle = (region: SidebarRegion) => (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    // Read the flag before scheduling state: React nullifies `currentTarget` after the handler
    // returns, and the updater below runs later, so reading it there throws.
    const open = event.currentTarget.open
    setChosenRegion(current => toggleRegion(current, region, open))
  }

  const sidebarMode = resolveSidebarMode({
    databaseName: capacity.displayName,
    totalObjectsLabel: page?.totalItems ?? String(items.length),
    route: null,
  })

  const panel: ReactNode = selectedRoad ? (
    <RoadDetailPanel road={selectedRoad} label={roadLabels.get(selectedRoad.routeId) ?? ''} />
  ) : selectedItem ? (
    <ItemDetailPanel item={selectedItem} />
  ) : null

  /*
   * The rail's live region. On Fabric the SQL "live query feed" is gone — there are no sessions
   * running "right now" to poll — so this holds the timepoint clock (which never says "live" or
   * "now") over the most recent operation samples the source could supply. It is a scrolling rail
   * region of its own (`.sidebar-feed`) rather than a fourth drawer, because starved to a share of
   * the drawer budget it collapses to a couple of rows.
   */
  const liveOperationFeed = (
    <section className="sidebar-feed" aria-label="Timepoint clock and recent operations">
      <div className="sidebar-feed-head">
        <strong>{timepointClockLabel(feed)}</strong>
        <span>{timepointEvidence.headline}</span>
      </div>
      <div className="sidebar-feed-body">
        {samples && samples.length > 0 ? (
          <ul className="address-list">
            {samples.slice(0, 40).map(sample => (
              <li key={sample.operationId}>
                <span className={`feed-row is-${sample.status.toLowerCase()}`}>
                  <strong>{sample.operationName}</strong>
                  <span>{sample.status}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">{timepointEvidence.detail}</p>
        )}
      </div>
    </section>
  )

  const liveActivityDrawer = (
    <details className="sidebar-drawer" open={openRegion === 'activity'} onToggle={onRegionToggle('activity')}>
      <summary>
        Throttling activity
        <span className="drawer-badge">{incidentSummaryLabel(incidents)}</span>
      </summary>
      <div className="sidebar-drawer-body">
        {disasters && <WeatherLine weather={disasters.weather} headline={disasters.survey.headline} />}
        <IncidentSummary projection={incidents} openId={openIncidentId} onOpen={onOpenIncident} />
      </div>
    </details>
  )

  const planFinder = (
    <details className="sidebar-drawer" open={openRegion === 'plans'} onToggle={onRegionToggle('plans')}>
      <summary>
        Operation families
        <span className="drawer-badge">{families.length}</span>
      </summary>
      <div className="sidebar-drawer-body">
        {families.length === 0 ? (
          <p className="sidebar-empty">{trafficEvidence.headline}</p>
        ) : (
          <ul className="address-list">
            {families.map(family => (
              <li key={family.familyId}>
                <span className="address-text">
                  <strong>{family.operationName}</strong>
                  <span className="address-facts">
                    <span>{splitPascal(family.operationClass)}</span>
                    <span>{Number(family.operationCount).toLocaleString()} ops</span>
                    <span>{Number(family.cuSeconds).toLocaleString()} CU·s</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )

  const subtitle = page ? (
    <span className="atlas-subtitle">
      <span>{capacity.sku ?? 'Unknown SKU'}</span>
      <span>{page.totalItems ?? items.length} items</span>
    </span>
  ) : error ? (
    'Unavailable'
  ) : (
    'Loading…'
  )

  const sidebar = (
    <>
      <SidebarHeader
        title={sidebarMode.title}
        subtitle={subtitle}
        onBack={onBack}
        backLabel={sidebarMode.backLabel}
      />

      <div className={`sidebar-place-card`}>
        {selectedRoad ? (
          <RoadDetailPanel road={selectedRoad} label={roadLabels.get(selectedRoad.routeId) ?? ''} />
        ) : selectedItem ? (
          <ItemDetailPanel item={selectedItem} />
        ) : (
          <p className="sidebar-empty">Select a building on the map, or an address below.</p>
        )}
      </div>

      {sidebarMode.showsAddressBook && liveOperationFeed}

      <AddressBook
        entries={addressEntries}
        term={finderTerm}
        onTermChange={setFinderTerm}
        open={openRegion === 'directory'}
        onOpenChange={next => setChosenRegion(next ? 'directory' : null)}
        selectedId={selectedId}
        onSelect={onAddressSelect}
      />

      <div className={`sidebar-drawers${placeCard ? ' is-yielding' : ''}${drawersHoldOpenRegion(openRegion) ? ' is-open' : ''}`}>
        {liveActivityDrawer}
        {planFinder}
        <LegendDrawer
          openRegion={openRegion}
          onToggle={onRegionToggle('legend')}
          trafficEvidence={trafficEvidence}
          trafficWindow={trafficWindow}
          powerGrid={powerGrid}
          facilityTraffic={facilityTraffic}
        />
      </div>
    </>
  )

  const route: CityRoute | null = null

  return (
    <MapShell sidebar={sidebar} kiosk={kiosk}>
      {page && (
        <CapacityCityViewport
          objects={items}
          cityPlan={cityPlan}
          cityName={capacity.displayName}
          viewMode={viewMode}
          roads={roads}
          traffic={workloadTraffic}
          facilities={facilities}
          facilityTraffic={facilityTraffic}
          route={route}
          selectedId={selectedId}
          selectedRoadId={selectedRoadId}
          onSelect={id => {
            setSelectedId(id)
            setSelectedRoadId(null)
          }}
          onSelectRoad={setSelectedRoadId}
          roadLabels={roadLabels}
          panel={panel}
          incidents={incidents}
          staleStatsObjectIds={staleStatsObjectIds}
          fireObjectIds={fireObjectIds}
          openIncidentId={openIncidentId}
          onOpenIncident={onOpenIncident}
          incidentFocus={incidentFocus}
        />
      )}

      <ViewModeTile mode={viewMode} onChange={onViewModeChange} />
      <KioskToggle active={kiosk} onToggle={onToggleKiosk} />
    </MapShell>
  )
}

type Tone = 'known' | 'unknown' | 'stale'

function toneFor(value: string | number | null, evidence?: Evidence): Tone {
  if (value === null || value === undefined) return 'unknown'
  if (evidence && evidence.status === 'Stale') return 'stale'
  return 'known'
}

function DetailValue({ value, tone = 'known' }: { value: string; tone?: Tone }) {
  return (
    <dd>
      <span className={`measurement-value${tone === 'known' ? '' : ` is-${tone}`}`}>{value}</span>
    </dd>
  )
}

function LegendDrawer({
  openRegion,
  onToggle,
  trafficEvidence,
  trafficWindow,
  powerGrid,
  facilityTraffic,
}: {
  openRegion: SidebarRegion | null
  onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => void
  trafficEvidence: ReturnType<typeof describeTrafficEvidence>
  trafficWindow: ReturnType<typeof describeTrafficWindow>
  powerGrid: ReturnType<typeof projectPowerGrid>
  facilityTraffic: ReturnType<typeof projectFacilityTraffic>
}) {
  return (
    <details className="sidebar-drawer" open={openRegion === 'legend'} onToggle={onToggle}>
      <summary>
        Legend &amp; power grid
        <span className="drawer-badge">{trafficEvidence.state}</span>
      </summary>
      <div className="sidebar-drawer-body">
        <p className="legend-caveat">{trafficEvidence.headline}</p>
        {!trafficEvidence.drawRoads && <p className="legend-caveat">{trafficEvidence.detail}</p>}
        <p className="legend-caveat">{trafficWindow.headline}</p>
        <ul className="legend-list">
          <li><span className="legend-swatch is-plot" aria-hidden="true" /> Footprint — OneLake storage bytes</li>
          <li><span className="legend-swatch is-tower" aria-hidden="true" /> Height — CU-seconds consumed</li>
          <li><span className="legend-swatch is-wireframe" aria-hidden="true" /> Wireframe — not measured</li>
          <li><span className="legend-swatch is-value-unknown" aria-hidden="true" /> Dashed value — not measured</li>
          <li><span className="legend-swatch is-stale" aria-hidden="true" /> Dim — stale</li>
          <li><span className="legend-swatch is-brownout" aria-hidden="true" /> Amber — throttled</li>
          <li><span className="legend-swatch is-blackout" aria-hidden="true" /> Red — rejecting</li>
        </ul>
        <dl className="detail-grid">
          {powerGrid.map(facility => (
            <PowerGridRow
              key={facility.kind}
              label={facility.label}
              state={facility.state}
              detail={facility.measurement.detail}
            />
          ))}
        </dl>
        <ul className="legend-list">
          {POWER_GRID_STATE_LEGEND.map(entry => (
            <li key={entry.state}>
              <span className="legend-swatch" style={{ background: swatch(entry.color) }} aria-hidden="true" /> {entry.label} — {entry.meaning}
            </li>
          ))}
        </ul>
        <ul className="legend-list">
          {POWER_GRID_FACILITY_LEGEND.map(entry => (
            <li key={entry.kind}>
              <strong>{entry.label}</strong>
              {entry.gateOutcome ? ` (${entry.gateOutcome})` : ''} — {entry.meaning}
            </li>
          ))}
        </ul>
        <p className="legend-caveat">
          {facilityTraffic.note}
          {facilityTraffic.unattributedSeconds > 0 &&
            ` ${Math.round(facilityTraffic.unattributedSeconds)} measured throttling second(s) identified no honest gate and carry no lane.`}
        </p>
      </div>
    </details>
  )
}

function ItemDetailPanel({ item }: { item: CapacityCityItem }) {
  const massing = itemMassing(item)
  const cu = cityItemMetricValue(item, 'Cu')
  return (
    <div className="object-detail">
      <header className="object-detail-head">
        <strong>{item.name}</strong>
        <span>{item.workspaceName} · {splitPascal(item.kind)}</span>
      </header>
      <dl className="detail-grid">
        <dt>Massing</dt>
        <DetailValue value={massing.kind === 'built' ? 'Built' : 'Vacant — not fully measured'} tone={massing.kind === 'built' ? 'known' : 'unknown'} />
        <dt>OneLake storage</dt>
        <DetailValue value={storageSummary(item)} tone={toneFor(item.storage.bytes, item.storage.evidence)} />
        <dt>CU consumed</dt>
        <DetailValue value={formatCu(item.cuConsumed)} tone={toneFor(cu, item.cuConsumed.evidence)} />
        <dt>Operations</dt>
        <DetailValue value={item.operations.total ?? '—'} tone={toneFor(item.operations.total)} />
        <dt>Rejected</dt>
        <DetailValue value={item.operations.rejected ?? '—'} tone={item.operations.rejected === null ? 'unknown' : 'known'} />
        <dt>Duration</dt>
        <DetailValue value={item.durationSeconds === null ? '—' : `${item.durationSeconds.toLocaleString()} s`} tone={toneFor(item.durationSeconds)} />
        <dt>Throttled</dt>
        <DetailValue value={item.throttlingMinutes === null ? '—' : formatMinutes(item.throttlingMinutes)} tone={toneFor(item.throttlingMinutes)} />
        <dt>CU vs. 7 days ago</dt>
        <DetailValue
          value={item.performanceDeltaPercent === null ? '—' : formatPercent(item.performanceDeltaPercent)}
          tone={item.performanceDeltaPercent === null ? 'unknown' : 'known'}
        />
      </dl>
    </div>
  )
}

function RoadDetailPanel({ road, label }: { road: RoadTraffic; label: string }) {
  return (
    <div className="object-detail">
      <header className="object-detail-head">
        <strong>Road</strong>
        <span>{label}</span>
      </header>
      <dl className="detail-grid">
        <dt>Dependency</dt>
        <DetailValue value={`${splitPascal(road.kind)} · ${road.confidence}`} />
        <dt>Congestion</dt>
        <DetailValue value={CONGESTION_LABELS[road.grade]} tone={road.grade === 'unknown' ? 'unknown' : 'known'} />
        <dt>Operations</dt>
        <DetailValue value={road.operations === null ? '—' : road.operations.toLocaleString()} tone={road.operations === null ? 'unknown' : 'known'} />
        <dt>Cars (interactive)</dt>
        <DetailValue value={road.carOperations === null ? '—' : road.carOperations.toLocaleString()} tone={road.carOperations === null ? 'unknown' : 'known'} />
        <dt>Freight (background)</dt>
        <DetailValue value={road.freightOperations === null ? '—' : road.freightOperations.toLocaleString()} tone={road.freightOperations === null ? 'unknown' : 'known'} />
      </dl>
    </div>
  )
}

function WeatherLine({ weather, headline }: { weather: string; headline: string }) {
  const tone =
    weather === 'blackout' || weather === 'rolling-blackout'
      ? 'is-blackout'
      : weather === 'overcast'
        ? 'is-brownout'
        : weather === 'unknown'
          ? 'is-value-unknown'
          : ''
  const label =
    weather === 'unknown' ? 'Weather: unknown — not observed' : `Weather: ${splitPascal(weather.replace('-', ' '))}`
  return (
    <p className={`city-weather-line ${tone}`}>
      <strong>{label}</strong>
      <span>{headline}</span>
    </p>
  )
}

function PowerGridRow({
  label,
  state,
  detail,
}: {
  label: string
  state: string | null
  detail: string
}) {
  const tone = state === null ? 'unknown' : state === 'blackout' || state === 'brownout' ? 'stale' : 'known'
  return (
    <>
      <dt>{label}</dt>
      <DetailValue value={state === null ? 'Unbuilt — not measured' : `${splitPascal(state)} · ${detail}`} tone={tone} />
    </>
  )
}

/** A stand-in throttle for the brief moment before the first page lands. Everything is unmeasured. */
function emptyThrottle(): ThrottleState {
  const evidence: Evidence = { source: 'CapacityEvent', status: 'Unknown', observedAt: null, freshUntil: null }
  return {
    stage: 'None',
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
    surgeProtectionActive: false,
    evidence,
  }
}
