import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  accessibleCapacityLabel,
  collectorDisplayState,
  collectorSummary,
  evidenceText,
  formatBytes,
  formatCu,
  formatMinutes,
  formatPercent,
  isRejecting,
  isReporting,
  splitPascal,
} from './capacityAtlas'
import { ChunkErrorBoundary } from './ChunkErrorBoundary'
import { createFixtureSource } from './collect/fixtureSource'
import {
  FloatingCard,
  KioskToggle,
  MapShell,
  SearchField,
  SidebarHeader,
  StatusChip,
  ViewModeTile,
  useKioskMode,
  type MapViewMode,
} from './MapShell'
import type { AtlasSnapshot, CapacityAtlasItem } from './fabricContracts'
import './App.css'

const AtlasViewport = lazy(() => import('./AtlasViewport').then((m) => ({ default: m.AtlasViewport })))

/**
 * How often the atlas re-reads its source.
 *
 * Rayfin has no cron, no timers and no background workers, so nothing refreshes server-side. The
 * only clock the app has is this one, running while the tab is open.
 */
const REFRESH_INTERVAL_MS = 30_000

/** The one source the app reads. Swapped for the semantic-model or Eventhouse source once live. */
const source = createFixtureSource()

export default function App() {
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<MapViewMode>('city')
  const { kiosk, toggleKiosk } = useKioskMode()

  const load = useCallback(async (initial: boolean) => {
    try {
      const next = await source.readAtlas()
      setSnapshot(next)
      setRefreshError(null)
      setError(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      /*
       * A failed *refresh* keeps the city on screen and dims it; a failed *first* load has nothing
       * to keep. Collapsing the two would blank a working city on one transient error.
       */
      if (initial) setError(message)
      else setRefreshError(message)
    }
  }, [])

  useEffect(() => {
    void load(true)
    const handle = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [load])

  return (
    <AtlasLevel
      snapshot={snapshot}
      error={error}
      refreshError={refreshError}
      selectedId={selectedId}
      hoveredId={hoveredId}
      viewMode={viewMode}
      kiosk={kiosk}
      onToggleKiosk={toggleKiosk}
      onViewModeChange={setViewMode}
      onSelect={setSelectedId}
      onHover={setHoveredId}
    />
  )
}

function AtlasLevel({
  snapshot,
  error,
  refreshError,
  selectedId,
  hoveredId,
  viewMode,
  kiosk,
  onToggleKiosk,
  onViewModeChange,
  onSelect,
  onHover,
}: {
  snapshot: AtlasSnapshot | null
  error: string | null
  refreshError: string | null
  selectedId: string | null
  hoveredId: string | null
  viewMode: MapViewMode
  kiosk: boolean
  onToggleKiosk: () => void
  onViewModeChange: (mode: MapViewMode) => void
  onSelect: (capacityId: string) => void
  onHover: (capacityId: string | null) => void
}) {
  const [term, setTerm] = useState('')
  const capacities = snapshot?.capacities ?? []
  const selected = capacities.find((capacity) => capacity.capacityId === selectedId) ?? null
  const hovered = capacities.find((capacity) => capacity.capacityId === hoveredId) ?? null
  const sourceState = collectorDisplayState(snapshot?.collection ?? null, refreshError !== null)

  const matches = useMemo(() => {
    const needle = term.trim().toLocaleLowerCase()
    if (needle === '') return capacities
    return capacities.filter(
      (capacity) =>
        capacity.displayName.toLocaleLowerCase().includes(needle) ||
        (capacity.sku ?? '').toLocaleLowerCase().includes(needle),
    )
  }, [capacities, term])

  const sidebar = (
    <>
      <SidebarHeader
        brand={
          <div className="sidebar-brand">
            <span className="sidebar-mark" aria-hidden="true" />
            <span className="sidebar-brand-name">FabricSimCity</span>
            <a
              className="sidebar-brand-link"
              href="https://github.com/cbattlegear/SQLSimCity"
              target="_blank"
              rel="noreferrer noopener"
              title="FabricSimCity on GitHub"
            >
              <span aria-hidden="true">↗</span>
              <span className="visually-hidden">FabricSimCity on GitHub (opens in a new tab)</span>
            </a>
          </div>
        }
        title={snapshot?.tenant.displayName ?? 'Tenant atlas'}
        subtitle={
          snapshot
            ? `${capacities.length} capacities · ${sourceState.state}`
            : 'Loading…'
        }
      />
      <div className="sidebar-search">
        <SearchField
          value={term}
          onChange={setTerm}
          label="Search capacities"
          placeholder="Search capacities"
        />
      </div>

      <div className="sidebar-scroll">
        {selected ? (
          <DetailPanel capacity={selected} />
        ) : (
          <p className="sidebar-empty">Select a capacity.</p>
        )}
      </div>

      <div className="sidebar-scroll">
        <ul className="address-list">
          {matches.map((capacity) => (
            <li key={capacity.capacityId}>
              <button
                type="button"
                className={`address-entry ${capacity.capacityId === selectedId ? 'is-selected' : ''}`}
                aria-label={accessibleCapacityLabel(capacity)}
                aria-pressed={capacity.capacityId === selectedId}
                onClick={() => onSelect(capacity.capacityId)}
                onMouseEnter={() => onHover(capacity.capacityId)}
                onMouseLeave={() => onHover(null)}
              >
                <span className="address-icon" aria-hidden="true">
                  ▦
                </span>
                <span className="address-text">
                  <strong>{capacity.displayName}</strong>
                  <span>
                    {capacity.sku ?? 'Unknown SKU'} · {formatCu(capacity.cuConsumed)}
                  </span>
                  <small>{stateBadge(capacity)}</small>
                </span>
              </button>
            </li>
          ))}
          {snapshot && matches.length === 0 && (
            <li className="address-empty">No capacity matches “{term}”.</li>
          )}
        </ul>
      </div>

      <div className="sidebar-drawers">
        <details className="sidebar-drawer">
          <summary>Legend</summary>
          <div className="sidebar-drawer-body">
            <ul className="legend-list">
              <li>
                <span className="legend-swatch is-plot" aria-hidden="true" /> Plot size — SKU budget
              </li>
              <li>
                <span className="legend-swatch is-tower" aria-hidden="true" /> Tower height — CU
                consumed
              </li>
              <li>
                <span className="legend-swatch is-wireframe" aria-hidden="true" /> Wireframe — not
                measured
              </li>
              <li>
                <span className="legend-swatch is-brownout" aria-hidden="true" /> Amber — throttled
              </li>
              <li>
                <span className="legend-swatch is-blackout" aria-hidden="true" /> Red — rejecting
              </li>
            </ul>
          </div>
        </details>

        <details className="sidebar-drawer">
          <summary>Source</summary>
          <div className="sidebar-drawer-body">
            <dl className="detail-grid">
              <dt>Source</dt>
              <dd>{splitPascal(source.kind)}</dd>
              <dt>State</dt>
              <dd>{sourceState.state}</dd>
              {snapshot?.collection && (
                <>
                  <dt>Last read</dt>
                  <dd>{collectorSummary(snapshot.collection)}</dd>
                </>
              )}
              <dt>Per-item CU</dt>
              <dd>{source.capabilities.perItemBreakdown ? 'Yes' : 'No'}</dd>
              <dt>Retention</dt>
              <dd>{source.capabilities.retentionDays} days</dd>
            </dl>
          </div>
        </details>
      </div>
    </>
  )

  return (
    <MapShell sidebar={sidebar} kiosk={kiosk}>
      {snapshot && (
        <ChunkErrorBoundary label="atlas">
          <LazySurface label="atlas" fallback={<ShellFallback label="Loading atlas…" />}>
            <AtlasViewport
              snapshot={snapshot}
              selectedId={selectedId}
              viewMode={viewMode}
              onSelect={onSelect}
              onHover={onHover}
              onOpen={onSelect}
            />
          </LazySurface>
        </ChunkErrorBoundary>
      )}

      <ViewModeTile mode={viewMode} onChange={onViewModeChange} />
      <KioskToggle active={kiosk} onToggle={onToggleKiosk} />

      {error && (
        <FloatingCard tone="warning" title="Atlas unavailable">
          <span>{error}</span>
        </FloatingCard>
      )}
      {!error && refreshError && (
        <FloatingCard tone="warning" title="Refresh failed">
          <span>Showing the last good read.</span>
        </FloatingCard>
      )}
      {hovered && !error && (
        <FloatingCard tone="info" title={hovered.displayName}>
          <span>
            {hovered.sku ?? 'Unknown SKU'} · {formatCu(hovered.cuConsumed)}
          </span>
        </FloatingCard>
      )}
    </MapShell>
  )
}

/** The shortest true description of a capacity's state, for a list row. */
function stateBadge(capacity: CapacityAtlasItem): string {
  if (!isReporting(capacity)) return splitPascal(capacity.stateReason)
  if (isRejecting(capacity)) return `rejecting · ${splitPascal(capacity.throttle.stage)}`
  if (capacity.throttle.stage !== 'None') return splitPascal(capacity.throttle.stage)
  return formatPercent(capacity.meanUtilizationPercent) + ' mean'
}

function DetailPanel({ capacity }: { capacity: CapacityAtlasItem }) {
  const { throttle } = capacity
  return (
    <section className="detail-panel">
      <header className="detail-header">
        <h2>{capacity.displayName}</h2>
        <StatusChip degraded={isDegraded(capacity)} title={accessibleCapacityLabel(capacity)}>
          {splitPascal(capacity.state)}
        </StatusChip>
      </header>

      <dl className="detail-grid">
        <dt>SKU</dt>
        <dd title={`${capacity.capacityUnits ?? '?'} CU`}>{capacity.sku ?? 'Unknown'}</dd>
        <dt>Region</dt>
        <dd>{capacity.region ?? 'Unknown'}</dd>
        <dt>Workspaces</dt>
        <dd>{capacity.workspaceCount ?? '—'}</dd>
        <dt>Items</dt>
        <dd>{capacity.itemCount ?? '—'}</dd>
        <dt>CU consumed</dt>
        <dd title={evidenceText(capacity.cuConsumed.evidence)}>{formatCu(capacity.cuConsumed)}</dd>
        <dt>Storage</dt>
        <dd title={evidenceText(capacity.storage.evidence)}>{formatBytes(capacity.storage)}</dd>
        <dt>Mean</dt>
        <dd>{formatPercent(capacity.meanUtilizationPercent)}</dd>
        <dt>Peak</dt>
        <dd>{formatPercent(capacity.peakUtilizationPercent)}</dd>
      </dl>

      <h3 className="detail-subhead">Throttling</h3>
      <dl className="detail-grid">
        <dt>Stage</dt>
        <dd>{splitPascal(throttle.stage)}</dd>
        <dt>Delay (10 min)</dt>
        <dd>{formatPercent(throttle.interactiveDelayPercent, 0)}</dd>
        <dt>Rejection (60 min)</dt>
        <dd>{formatPercent(throttle.interactiveRejectionPercent, 0)}</dd>
        <dt>Background (24 h)</dt>
        <dd>{formatPercent(throttle.backgroundRejectionPercent, 0)}</dd>
        <dt>Carry-forward</dt>
        <dd>{formatPercent(throttle.cumulativeCarryOverPercent, 0)}</dd>
        <dt>Burndown</dt>
        <dd>{formatMinutes(throttle.expectedBurndownMinutes)}</dd>
      </dl>
    </section>
  )
}

/** Whether the chip should read as trouble: throttled, rejecting, or not reporting at all. */
function isDegraded(capacity: CapacityAtlasItem): boolean {
  return !isReporting(capacity) || capacity.throttle.stage !== 'None'
}

function ShellFallback({ label }: { label: string }) {
  return (
    <div className="shell-fallback" role="status">
      {label}
    </div>
  )
}

function LazySurface({
  label,
  fallback,
  children,
}: {
  label: string
  fallback: ReactNode
  children: ReactNode
}) {
  return (
    <Suspense fallback={fallback}>
      <div className="lazy-surface" data-surface={label}>
        {children}
      </div>
    </Suspense>
  )
}
