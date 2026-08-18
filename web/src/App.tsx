import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchAtlas } from './api'
import { accessibleDatabaseLabel, collectorDisplayState, collectorSummary, evidenceText, formatBytes, formatDecimalCount, formatFill, metric } from './atlas'
import { AtlasViewport } from './AtlasViewport'
import LiveIncidents from './LiveIncidentsPanel'
import { QueryStoreView } from './QueryStoreView'
import FindingsPanel from './FindingsPanel'
import type { AtlasSnapshot, DatabaseAtlasItem } from './contracts'
import './App.css'

type Tab = 'atlas' | 'queries' | 'live' | 'findings'

export default function App() {
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('atlas')

  useEffect(() => {
    const controller = new AbortController()
    let refreshTimer: number | undefined
    let loaded = false
    const load = () => fetchAtlas(controller.signal)
      .then(atlas => {
        setSnapshot(atlas)
        loaded = true
        setSelectedId(current => current && atlas.databases.some(database => database.databaseId === current)
          ? current
          : atlas.databases[0]?.databaseId ?? null)
        setError(null)
        setRefreshError(null)
      })
      .catch(reason => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        const message = reason instanceof Error ? reason.message : 'The atlas could not be loaded'
        if (!loaded) setError(message)
        else setRefreshError(message)
      })
      .finally(() => {
        if (!controller.signal.aborted) refreshTimer = window.setTimeout(load, 30_000)
      })
    void load()
    return () => {
      controller.abort()
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    }
  }, [])

  const selectDatabase = useCallback((databaseId: string) => setSelectedId(databaseId), [])
  const hoverDatabase = useCallback((databaseId: string | null) => setHoveredId(databaseId), [])
  const selected = useMemo(
    () => snapshot?.databases.find(database => database.databaseId === selectedId) ?? null,
    [snapshot, selectedId],
  )
  const hovered = snapshot?.databases.find(database => database.databaseId === hoveredId) ?? null
  const sourceState = collectorDisplayState(snapshot?.collection, refreshError !== null)

  return (
    <main>
      <header className="masthead">
        <div>
          <h1>SQLSimCity</h1>
          <p className="subtitle">A truthful atlas of SQL Server evidence</p>
        </div>
        {snapshot && (
          <div className="capture" aria-label={`Snapshot generated ${new Date(snapshot.generatedAt).toLocaleString()}`}>
            <span className={`capture-dot ${sourceState.degraded ? 'is-degraded' : ''}`} aria-hidden="true" />
            {snapshot.collection?.mode ?? 'Fixture'} · {sourceState.state} · {new Date(snapshot.generatedAt).toLocaleTimeString()}
          </div>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label="Analysis views">
        <button
          type="button"
          role="tab"
          id="tab-atlas"
          aria-selected={tab === 'atlas'}
          aria-controls="panel-atlas"
          onClick={() => setTab('atlas')}
        >Server atlas</button>
        <button
          type="button"
          role="tab"
          id="tab-queries"
          aria-selected={tab === 'queries'}
          aria-controls="panel-queries"
          onClick={() => setTab('queries')}
        >Query Store history</button>
        <button
          type="button"
          role="tab"
          id="tab-live"
          aria-selected={tab === 'live'}
          aria-controls="panel-live"
          onClick={() => setTab('live')}
        >Live incidents</button>
        <button
          type="button"
          role="tab"
          id="tab-findings"
          aria-selected={tab === 'findings'}
          aria-controls="panel-findings"
          onClick={() => setTab('findings')}
        >Findings</button>
      </div>

      <div id="panel-findings" role="tabpanel" aria-labelledby="tab-findings" hidden={tab !== 'findings'}>
        {tab === 'findings' && <FindingsPanel />}
      </div>

      <div id="panel-queries" role="tabpanel" aria-labelledby="tab-queries" hidden={tab !== 'queries'}>
        {tab === 'queries' && <QueryStoreView />}
      </div>

      <div id="panel-live" role="tabpanel" aria-labelledby="tab-live" hidden={tab !== 'live'}>
        {tab === 'live' && <LiveIncidents />}
      </div>

      <div id="panel-atlas" role="tabpanel" aria-labelledby="tab-atlas" hidden={tab !== 'atlas'}>
      {error ? (
        <section className="error" role="alert">
          <h2>Atlas unavailable</h2>
          <p>{error}. Confirm the ASP.NET API is running, then reload this page.</p>
        </section>
      ) : !snapshot ? (
        <section className="loading" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" /> Loading atlas from the API…
        </section>
      ) : (
        <>
          {refreshError && (
            <section className="collector-status is-degraded" role="alert" aria-label="Atlas refresh status">
              <strong>Atlas refresh failed</strong>
              <span>The API could not refresh this page. The last successful snapshot is retained and may be stale.</span>
              <small>{refreshError}</small>
            </section>
          )}
          {snapshot.collection && (
            <section className={`collector-status ${snapshot.collection.failureCount > 0 || snapshot.collection.isStale ? 'is-degraded' : ''}`} aria-label="Atlas collector status">
              <strong>{snapshot.collection.mode} source · {snapshot.collection.state}</strong>
              <span>{collectorSummary(snapshot.collection)}</span>
              <small>{snapshot.collection.reason}</small>
            </section>
          )}
          <section className="atlas-shell" aria-labelledby="atlas-title">
            <div className="atlas-heading">
              <div>
                <h2 id="atlas-title">{snapshot.target.displayName}</h2>
                <p>{snapshot.target.platform} · {snapshot.databases.length} databases</p>
              </div>
              <div className="legend" aria-label="Atlas legend">
                <span><i className="legend-live" /> fresh live sample</span>
                <span><i className="legend-unknown">×</i> unknown size</span>
              </div>
            </div>
            <div className="viewport-wrap">
              <AtlasViewport
                snapshot={snapshot}
                selectedId={selectedId}
                onHover={hoverDatabase}
                onSelect={selectDatabase}
              />
              <p className="hover-readout" aria-live="polite">
                {hovered ? `${hovered.name} — select to inspect exact evidence` : 'Move across a block or use the table below'}
              </p>
            </div>
            <p className="mapping-note">
              Footprint uses allocated KiB: t = min(1, log₂(1 + A) / 50), area = 144 + 9072t. An × block has unknown size and carries no quantity.
            </p>
          </section>

          <section className="evidence-strip" aria-label="Evidence boundaries">
            <div><strong>Query Store</strong><span>aggregate history</span></div>
            <div><strong>Live activity</strong><span>point-in-time DMV sample</span></div>
            <div><strong>Topology</strong><span>inferred evidence, not a dependency graph</span></div>
          </section>

          <div className="analysis-grid">
            <section className="table-region" aria-labelledby="database-table-title">
              <div className="section-heading">
                <h2 id="database-table-title">Database evidence</h2>
                <p>Keyboard-accessible equivalent to the 3D atlas</p>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Database</th><th>Allocated</th><th>Live activity</th><th>Query Store</th></tr>
                  </thead>
                  <tbody>
                    {snapshot.databases.map(database => (
                      <tr key={database.databaseId} className={database.databaseId === selectedId ? 'is-selected' : undefined}>
                        <th scope="row">
                          <button
                            type="button"
                            aria-label={accessibleDatabaseLabel(database)}
                            aria-pressed={database.databaseId === selectedId}
                            onClick={() => selectDatabase(database.databaseId)}
                          >{database.name}</button>
                        </th>
                        <td>{formatBytes(database.allocated)}</td>
                        <td><StatusCell database={database} kind="live" /></td>
                        <td><StatusCell database={database} kind="query" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <DetailPanel database={selected} />
          </div>

          <section className="topology" aria-labelledby="topology-title">
            <div className="section-heading">
              <h2 id="topology-title">Cross-database evidence</h2>
              <p>Line pattern and text both communicate confidence</p>
            </div>
            <ul>
              {snapshot.edges.map(edge => (
                <li key={edge.edgeId}>
                  <span className={`edge-mark edge-${edge.confidence.toLowerCase()}`} aria-hidden="true" />
                  <strong>{nameFor(snapshot, edge.fromDatabaseId)} → {nameFor(snapshot, edge.toDatabaseId)}</strong>
                  <span>{edge.confidence}: {edge.rationale}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      </div>
    </main>
  )
}

function StatusCell({ database, kind }: { database: DatabaseAtlasItem; kind: 'live' | 'query' }) {
  if (kind === 'query') {
    return <><strong>{database.queryStore.capability}</strong><small>{database.queryStore.reason}</small></>
  }
  return <><strong>{database.liveActivity.evidence.status}</strong><small>{database.liveActivity.evidence.reason}</small></>
}

function DetailPanel({ database }: { database: DatabaseAtlasItem | null }) {
  if (!database) return <aside className="detail"><p>Select a database to inspect exact evidence.</p></aside>
  return (
    <aside className="detail" aria-labelledby="detail-title">
      <div className="detail-title"><h2 id="detail-title">{database.name}</h2><span>exact record</span></div>
      <dl>
        <div><dt>Stable ID</dt><dd>{database.databaseId}</dd></div>
        <div><dt>Allocated</dt><dd>{formatBytes(database.allocated)}</dd></div>
        <div><dt>Used</dt><dd>{formatBytes(database.used)}</dd></div>
        <div><dt>Data fill</dt><dd>{formatFill(database.used, database.allocated)}</dd></div>
        {database.logAllocated && <div><dt>Log allocated</dt><dd>{formatBytes(database.logAllocated)}</dd></div>}
        {database.logUsed && <div><dt>Log used</dt><dd>{formatBytes(database.logUsed)}</dd></div>}
        <div><dt>State / compatibility</dt><dd>{database.state ?? 'Unavailable'} / {database.compatibilityLevel ?? 'Unavailable'}</dd></div>
        <div><dt>Active sessions</dt><dd>{metric(database.liveActivity.activeSessions)}</dd></div>
        <div><dt>Running requests</dt><dd>{metric(database.liveActivity.runningRequests)}</dd></div>
        <div><dt>Blocked sessions</dt><dd>{metric(database.liveActivity.blockedSessions)}</dd></div>
        <div><dt>Batch requests/sec</dt><dd>{metric(database.liveActivity.batchRequestsPerSecond)}</dd></div>
        <div><dt>Query executions</dt><dd>{formatDecimalCount(database.queryStore.executionCount)}</dd></div>
        <div><dt>Aborted executions</dt><dd>{formatDecimalCount(database.queryStore.abortedExecutionCount ?? null)}</dd></div>
        <div><dt>Exception executions</dt><dd>{formatDecimalCount(database.queryStore.exceptionExecutionCount ?? null)}</dd></div>
        <div><dt>Logical reads (8-KiB pages)</dt><dd>{formatDecimalCount(database.queryStore.logicalReads8KiBPages)}</dd></div>
        <div><dt>Average duration</dt><dd>{metric(database.queryStore.averageDurationMicroseconds, ' µs')}</dd></div>
        <div><dt>Total duration</dt><dd>{formatDecimalCount(database.queryStore.totalDurationMicroseconds ?? null)} µs</dd></div>
        <div><dt>Total CPU</dt><dd>{formatDecimalCount(database.queryStore.totalCpuMicroseconds ?? null)} µs</dd></div>
        <div><dt>Query Store state</dt><dd>{database.queryStore.desiredState ?? 'Unavailable'} → {database.queryStore.health}</dd></div>
        <div><dt>Capture mode</dt><dd>{database.queryStore.captureMode ?? 'Unavailable'}</dd></div>
        {database.queryStore.currentStorageBytes && <div><dt>Query Store storage</dt><dd>
          {formatBytes({ bytes: database.queryStore.currentStorageBytes, status: 'Known', reason: null, evidence: database.queryStore.evidence })}
        </dd></div>}
        <div><dt>Query Store window</dt><dd>{database.queryStore.windowStart && database.queryStore.windowEnd
          ? `${new Date(database.queryStore.windowStart).toLocaleString()} – ${new Date(database.queryStore.windowEnd).toLocaleString()}`
          : 'Unavailable'}</dd></div>
        <div><dt>I/O read rate</dt><dd>{formatDecimalCount(database.fileIo?.readBytesPerSecond ?? null)} bytes/s</dd></div>
        <div><dt>I/O write rate</dt><dd>{formatDecimalCount(database.fileIo?.writeBytesPerSecond ?? null)} bytes/s</dd></div>
      </dl>
      <div className="source-note"><strong>Live source</strong><p>{evidenceText(database.liveActivity.evidence)}</p></div>
      <div className="source-note"><strong>Historical source</strong><p>{evidenceText(database.queryStore.evidence)}</p></div>
    </aside>
  )
}

function nameFor(snapshot: AtlasSnapshot, id: string): string {
  return snapshot.databases.find(database => database.databaseId === id)?.name ?? id
}
