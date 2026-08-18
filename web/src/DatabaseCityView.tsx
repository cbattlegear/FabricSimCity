import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDatabaseCity } from './api'
import { accessibleObjectLabel, databaseCityMetricValue, formatKiB } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityPage } from './databaseCityContracts'
import { DatabaseCityViewport } from './DatabaseCityViewport'

const metrics = ['cpu', 'duration', 'reads', 'executions'] as const
type Metric = (typeof metrics)[number]

type Props = {
  databaseId: string
  databaseName: string
  onBack: () => void
  onOpenQuery: (familyId: string) => void
}

export function DatabaseCityView({ databaseId, databaseName, onBack, onOpenQuery }: Props) {
  const [metric, setMetric] = useState<Metric>('cpu')
  const [page, setPage] = useState<DatabaseCityPage | null>(null)
  const [objects, setObjects] = useState<DatabaseCityObject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('object'))
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requests = useRef(new Set<AbortController>())
  const headingRef = useRef<HTMLHeadingElement>(null)

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

  useEffect(() => {
    headingRef.current?.focus()
  }, [databaseId])

  const selectObject = useCallback((objectId: string) => {
    setSelectedId(objectId)
    const url = new URL(window.location.href)
    url.searchParams.set('object', objectId)
    window.history.replaceState(null, '', url)
  }, [])

  const selected = objects.find(object => object.objectId === selectedId) ?? null
  const visibleObjects = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase()
    if (!term) return objects
    return objects.filter(object =>
      `${object.schemaName}.${object.name} ${object.kind} ${object.indexes.map(index => index.name).join(' ')}`
        .toLocaleLowerCase()
        .includes(term))
  }, [filter, objects])
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

  return (
    <section className="database-city" aria-labelledby="database-city-title">
      <nav className="breadcrumbs" aria-label="Atlas level">
        <button type="button" onClick={onBack}>Server atlas</button>
        <span aria-hidden="true">/</span>
        <strong>{databaseName}</strong>
        <span>database overview and object detail</span>
      </nav>

      <div className="city-heading">
        <div>
          <p className="eyebrow">Database city · factual projection</p>
          <h2 id="database-city-title" ref={headingRef} tabIndex={-1}>{databaseName}</h2>
          <p>{page?.totalObjects ?? '—'} objects · {displayedSchemas.length || '—'} schema neighborhoods loaded</p>
        </div>
        <div className="city-controls">
          <label>Rank workload
            <select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
              {metrics.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>Find object or index
            <input type="search" value={filter} onChange={event => setFilter(event.target.value)} />
          </label>
        </div>
      </div>

      {loading && <p className="source-banner" role="status">Loading bounded database evidence…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {page && <>
        <p className={`city-disclosure status-${page.evidence.status.toLowerCase()}`}>
          <strong>{page.evidence.source} · {page.evidence.status}</strong> {page.evidence.reason}
        </p>
        <div className="city-legend" aria-label="Database city legend">
          <span><i className="legend-direct" /> direct cumulative DMV activity</span>
          <span><i className="legend-attributed" /> attributed Query Store aggregate</span>
          <span><i className="legend-unknown">×</i> unknown, nonquantitative size</span>
          <span><i className="legend-route" /> confidence-graded co-reference, never row flow</span>
        </div>
        <div className="city-schema-strip" aria-label="Schema neighborhoods">
          {displayedSchemas.map(schema => <div key={schema.schemaId}>
            <strong>{schema.name}</strong>
            <span>{schema.objectCount} objects · neighborhood {schema.neighborhoodOrdinal + 1}</span>
          </div>)}
        </div>

        <DatabaseCityViewport objects={visibleObjects} routes={page.routes} selectedId={selectedId} onSelect={selectObject} />
        <p className="mapping-note">
          Building footprint maps exact reserved 8-KiB pages logarithmically; height maps exact used pages.
          Unknown size uses fixed wireframe geometry and makes no quantity claim. Known index slab width maps direct operations;
          unavailable index activity uses a fixed wireframe slab.
          amber roof-cap height maps attributed CPU. Indexes remain attached to their parent.
        </p>

        <div className="analysis-grid city-analysis">
          <section className="table-region" aria-labelledby="city-object-table">
            <div className="section-heading">
              <div><h2 id="city-object-table">Objects and attached indexes</h2><p>Text-first equivalent of the viewport</p></div>
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Object</th><th>Size</th><th>Direct activity</th><th>Attributed exposure</th></tr></thead>
                <tbody>{visibleObjects.map(object => <tr key={object.objectId} className={selectedId === object.objectId ? 'is-selected' : undefined}>
                  <th scope="row"><button type="button" aria-label={accessibleObjectLabel(object)}
                    aria-pressed={selectedId === object.objectId} onClick={() => selectObject(object.objectId)}>
                    {object.schemaName}.{object.name}
                  </button><small>{object.kind} · {object.indexes.length} attached indexes</small></th>
                  <td>{object.reservedBytes === null ? <><strong>Unknown ×</strong><small>{object.sizeReason}</small></> :
                    <><strong>{formatKiB(object.reservedBytes)} reserved</strong><small>{formatKiB(object.usedBytes!)} used</small></>}</td>
                  <td><strong>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</strong>
                    <small>{object.directActivity.evidence.source} · {object.directActivity.evidence.reason}</small></td>
                  <td><strong>{databaseCityMetricValue(object, metric) ?? object.attributedExposure.evidence.status}</strong>
                    <small>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}</small></td>
                </tr>)}</tbody>
              </table>
            </div>
            {page.nextPageToken && <button type="button" className="load-more" onClick={loadMore}>
              Load next bounded object page
            </button>}
          </section>
          <ObjectDetail object={selected} metric={metric} />
        </div>

        <section className="city-workload" aria-labelledby="city-workload-title">
          <div className="section-heading">
            <div><h2 id="city-workload-title">Top query-family exposure</h2>
              <p>Backend-ranked top 12; no browser-side 100k layout</p></div>
          </div>
          <div className="table-scroll"><table>
            <thead><tr><th>Family</th><th>Executions</th><th>CPU µs</th><th>Duration µs</th><th>Reads (8-KiB)</th><th>Attribution</th></tr></thead>
            <tbody>{page.topQueryFamilies.map(family => <tr key={family.familyId}>
              <th scope="row">{family.familyId.startsWith('qf:')
                ? <button type="button" onClick={() => onOpenQuery(family.familyId)}>{family.familyId}</button>
                : family.familyId}<small>{family.queryHash} · {family.evidence.source}</small></th>
              <td>{family.executionCount}</td><td>{family.totalCpuMicroseconds}</td>
              <td>{family.totalDurationMicroseconds}</td><td>{family.totalLogicalReads8KiBPages}</td>
              <td>{family.confidence}<small>{family.rationale}</small></td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Other workload ({page.otherWorkload.familyCount ?? 'count unavailable'} families)</th>
              <td>{page.otherWorkload.executionCount ?? 'Unavailable'}</td><td>{page.otherWorkload.totalCpuMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalDurationMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalLogicalReads8KiBPages ?? 'Unavailable'}</td>
              <td>Aggregate only<small>{page.otherWorkload.evidence.reason}</small></td></tr></tfoot>
          </table></div>
        </section>

        <section className="topology city-routes" aria-labelledby="city-routes-title">
          <div className="section-heading"><div><h2 id="city-routes-title">Evidence-labeled routes</h2>
            <p>Confidence is encoded by pattern and text; routes do not claim row flow</p></div></div>
          <ul>{page.routes.map(route => <li key={route.routeId}>
            <span className={`edge-mark edge-${route.confidence.toLowerCase()}`} aria-hidden="true" />
            <strong>{route.kind} · {route.confidence}</strong>
            <span>{route.fromObjectId} ↔ {route.toId}<br />{route.rationale} · {route.evidence.status}</span>
          </li>)}</ul>
        </section>
      </>}
    </section>
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
    </p></div>
  </aside>
}
