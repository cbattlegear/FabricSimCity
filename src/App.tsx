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
import type { AtlasSnapshot, CapacityAtlasItem, Evidence } from './fabricContracts'
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
  const sourceStateTitle =
    refreshError ?? (snapshot?.collection?.isStale ? 'Last read is past its freshness window.' : undefined)
  const sidebarSubtitle = snapshot ? (
    <span
      className={`atlas-subtitle${sourceState.degraded ? ' is-degraded' : ''}`}
      title={sourceStateTitle}
    >
      <span className="atlas-subtitle-dot" aria-hidden="true" />
      <span>{capacities.length} capacities</span>
      <span>{sourceState.state}</span>
    </span>
  ) : (
    'Loading…'
  )

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
        subtitle={sidebarSubtitle}
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
          {matches.map((capacity) => {
            const selectedCapacity = capacity.capacityId === selectedId
            return (
              <li key={capacity.capacityId}>
                <button
                  type="button"
                  className={capacityEntryClass(capacity, selectedCapacity)}
                  aria-label={accessibleCapacityLabel(capacity)}
                  aria-pressed={selectedCapacity}
                  aria-current={selectedCapacity ? 'true' : undefined}
                  onClick={() => onSelect(capacity.capacityId)}
                  onMouseEnter={() => onHover(capacity.capacityId)}
                  onMouseLeave={() => onHover(null)}
                >
                  <span className="address-icon" aria-hidden="true">
                    ▦
                  </span>
                  <span className="address-text">
                    <strong>{capacity.displayName}</strong>
                    <span className="address-facts">
                      <span>{capacity.sku ?? 'Unknown SKU'}</span>
                      <span>{formatCu(capacity.cuConsumed)}</span>
                      {capacity.meanUtilizationPercent !== null && (
                        <span>{formatPercent(capacity.meanUtilizationPercent)} mean</span>
                      )}
                    </span>
                    <CapacityBadges capacity={capacity} />
                  </span>
                </button>
              </li>
            )
          })}
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
                <span className="legend-swatch is-value-unknown" aria-hidden="true" /> Dashed value —
                not measured
              </li>
              <li>
                <span className="legend-swatch is-stale" aria-hidden="true" /> Dim — stale
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
              <dd>
                <SourceStatePill state={sourceState.state} degraded={sourceState.degraded} title={sourceStateTitle} />
              </dd>
              {snapshot?.collection && (
                <>
                  <dt>Last read</dt>
                  <dd>{collectorSummary(snapshot.collection)}</dd>
                </>
              )}
              <dt>Per-item CU</dt>
              <dd>
                <SourceCapability
                  enabled={source.capabilities.perItemBreakdown}
                  title="Per-item CU breakdown"
                />
              </dd>
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
          <LazySurface
            label="atlas"
            dimmed={sourceState.degraded}
            fallback={<ShellFallback label="Loading atlas…" />}
          >
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
          <span className="stale-badge" title={refreshError}>last good read</span>
        </FloatingCard>
      )}
      {hovered && !error && (
        <FloatingCard tone="info" title={hovered.displayName}>
          <span>
            {hovered.sku ?? 'Unknown SKU'} · {formatCu(hovered.cuConsumed)}
          </span>
          <CapacityBadges capacity={hovered} compact />
        </FloatingCard>
      )}
    </MapShell>
  )
}

function capacityEntryClass(capacity: CapacityAtlasItem, selected: boolean): string {
  const classes = ['address-entry']
  if (selected) classes.push('is-selected')
  if (!isReporting(capacity)) classes.push('is-unmeasured')
  else if (isRejecting(capacity)) classes.push('is-rejecting')
  else if (capacity.throttle.stage !== 'None') classes.push('is-throttled')
  if (hasStaleEvidence(capacity)) classes.push('is-stale')
  return classes.join(' ')
}

function CapacityBadges({ capacity, compact = false }: { capacity: CapacityAtlasItem; compact?: boolean }) {
  const badges: Array<{ label: string; tone: string; title: string }> = []

  if (!isReporting(capacity)) {
    badges.push({
      label: 'unmeasured',
      tone: 'unknown',
      title: `${splitPascal(capacity.stateReason)} · CU telemetry unavailable`,
    })
  } else if (isRejecting(capacity)) {
    badges.push({
      label: 'rejecting',
      tone: 'rejecting',
      title: `${splitPascal(capacity.throttle.stage)} · ${splitPascal(capacity.stateReason)}`,
    })
  } else if (capacity.throttle.stage !== 'None') {
    badges.push({
      label: 'delay',
      tone: 'throttled',
      title: splitPascal(capacity.throttle.stage),
    })
  }

  if (capacity.throttle.surgeProtectionActive) {
    badges.push({
      label: 'surge',
      tone: 'throttled',
      title: splitPascal(capacity.stateReason),
    })
  }

  if (hasStaleEvidence(capacity)) {
    badges.push({ label: 'stale', tone: 'stale', title: 'Measurement is stale' })
  }

  if (badges.length === 0) return null

  return (
    <span className={`capacity-badges${compact ? ' is-compact' : ''}`}>
      {badges.map((badge) => (
        <span key={`${badge.tone}:${badge.label}`} className={`capacity-badge is-${badge.tone}`} title={badge.title}>
          {badge.label}
        </span>
      ))}
    </span>
  )
}

function hasStaleEvidence(capacity: CapacityAtlasItem): boolean {
  return [capacity.cuConsumed.evidence, capacity.storage.evidence, capacity.throttle.evidence].some(
    (evidence) => evidence.status === 'Stale',
  )
}

type MeasurementTone = 'known' | 'unknown' | 'stale'

function evidenceTone(evidence: Evidence): MeasurementTone {
  if (evidence.status === 'Stale') return 'stale'
  return evidence.status === 'Available' ? 'known' : 'unknown'
}

function nullableTone(value: unknown, evidence?: Evidence): MeasurementTone {
  if (value === null || value === undefined) return 'unknown'
  return evidence ? evidenceTone(evidence) : 'known'
}

function DetailValue({
  value,
  title,
  tone = 'known',
}: {
  value: string | number
  title?: string
  tone?: MeasurementTone
}) {
  const className = `measurement-value${tone === 'known' ? '' : ` is-${tone}`}`
  const ariaLabel = title ? `${value}; ${title}` : undefined
  return (
    <span className={className} title={title} aria-label={ariaLabel}>
      {value}
    </span>
  )
}

function SourceStatePill({
  state,
  degraded,
  title,
}: {
  state: string
  degraded: boolean
  title?: string
}) {
  return (
    <span className={`source-state-pill${degraded ? ' is-degraded' : ''}`} title={title}>
      <span aria-hidden="true" />
      {state}
    </span>
  )
}

function SourceCapability({ enabled, title }: { enabled: boolean; title: string }) {
  return (
    <span className={`source-capability${enabled ? '' : ' is-missing'}`} title={title}>
      {enabled ? '✓' : '—'}
    </span>
  )
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
        <dd>
          <DetailValue
            value={capacity.sku ?? 'Unknown'}
            title={`${capacity.capacityUnits ?? '?'} CU`}
            tone={nullableTone(capacity.capacityUnits)}
          />
        </dd>
        <dt>Region</dt>
        <dd>
          <DetailValue
            value={capacity.region ?? 'Unknown'}
            title={capacity.region === null ? 'Region not reported' : undefined}
            tone={nullableTone(capacity.region)}
          />
        </dd>
        <dt>Workspaces</dt>
        <dd>
          <DetailValue
            value={capacity.workspaceCount ?? '—'}
            title={capacity.workspaceCount === null ? 'Workspace count not measured' : undefined}
            tone={nullableTone(capacity.workspaceCount)}
          />
        </dd>
        <dt>Items</dt>
        <dd>
          <DetailValue
            value={capacity.itemCount ?? '—'}
            title={capacity.itemCount === null ? 'Item count not measured' : undefined}
            tone={nullableTone(capacity.itemCount)}
          />
        </dd>
        <dt>CU consumed</dt>
        <dd>
          <DetailValue
            value={formatCu(capacity.cuConsumed)}
            title={evidenceText(capacity.cuConsumed.evidence)}
            tone={evidenceTone(capacity.cuConsumed.evidence)}
          />
        </dd>
        <dt>Storage</dt>
        <dd>
          <DetailValue
            value={formatBytes(capacity.storage)}
            title={evidenceText(capacity.storage.evidence)}
            tone={evidenceTone(capacity.storage.evidence)}
          />
        </dd>
        <dt>Mean</dt>
        <dd>
          <DetailValue
            value={formatPercent(capacity.meanUtilizationPercent)}
            title={evidenceText(capacity.cuConsumed.evidence)}
            tone={nullableTone(capacity.meanUtilizationPercent, capacity.cuConsumed.evidence)}
          />
        </dd>
        <dt>Peak</dt>
        <dd>
          <DetailValue
            value={formatPercent(capacity.peakUtilizationPercent)}
            title={evidenceText(capacity.cuConsumed.evidence)}
            tone={nullableTone(capacity.peakUtilizationPercent, capacity.cuConsumed.evidence)}
          />
        </dd>
      </dl>

      <h3 className="detail-subhead">Throttling</h3>
      <dl className="detail-grid">
        <dt>Stage</dt>
        <dd>
          <DetailValue
            value={isReporting(capacity) ? splitPascal(throttle.stage) : 'unmeasured'}
            title={isReporting(capacity) ? evidenceText(throttle.evidence) : splitPascal(capacity.stateReason)}
            tone={isReporting(capacity) ? evidenceTone(throttle.evidence) : 'unknown'}
          />
        </dd>
        <dt>Delay (10 min)</dt>
        <dd>
          <DetailValue
            value={formatPercent(throttle.interactiveDelayPercent, 0)}
            title={evidenceText(throttle.evidence)}
            tone={nullableTone(throttle.interactiveDelayPercent, throttle.evidence)}
          />
        </dd>
        <dt>Rejection (60 min)</dt>
        <dd>
          <DetailValue
            value={formatPercent(throttle.interactiveRejectionPercent, 0)}
            title={evidenceText(throttle.evidence)}
            tone={nullableTone(throttle.interactiveRejectionPercent, throttle.evidence)}
          />
        </dd>
        <dt>Background (24 h)</dt>
        <dd>
          <DetailValue
            value={formatPercent(throttle.backgroundRejectionPercent, 0)}
            title={evidenceText(throttle.evidence)}
            tone={nullableTone(throttle.backgroundRejectionPercent, throttle.evidence)}
          />
        </dd>
        <dt>Carry-forward</dt>
        <dd>
          <DetailValue
            value={formatPercent(throttle.cumulativeCarryOverPercent, 0)}
            title={evidenceText(throttle.evidence)}
            tone={nullableTone(throttle.cumulativeCarryOverPercent, throttle.evidence)}
          />
        </dd>
        <dt>Burndown</dt>
        <dd>
          <DetailValue
            value={formatMinutes(throttle.expectedBurndownMinutes)}
            title={evidenceText(throttle.evidence)}
            tone={nullableTone(throttle.expectedBurndownMinutes, throttle.evidence)}
          />
        </dd>
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
  dimmed = false,
  fallback,
  children,
}: {
  label: string
  dimmed?: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  return (
    <Suspense fallback={fallback}>
      <div className={`lazy-surface${dimmed ? ' is-dimmed' : ''}`} data-surface={label}>
        {children}
      </div>
    </Suspense>
  )
}
