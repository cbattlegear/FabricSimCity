import { useEffect, useState } from 'react'
import { fetchPlan, fetchPlanComparison, fetchQueryFamilies, fetchQueryFamily } from './api'
import type { NormalizedShowplan, PlanComparison, QueryFamilyDetail, QueryFamilySummary } from './contracts'

const metrics = ['execution', 'cpu', 'duration', 'reads', 'waits'] as const

export function QueryStoreView() {
  const [metric, setMetric] = useState<(typeof metrics)[number]>('cpu')
  const [families, setFamilies] = useState<QueryFamilySummary[]>([])
  const [detail, setDetail] = useState<QueryFamilyDetail | null>(null)
  const [plan, setPlan] = useState<NormalizedShowplan | null>(null)
  const [comparePlanId, setComparePlanId] = useState('')
  const [comparison, setComparison] = useState<PlanComparison | null>(null)
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [pageEvidence, setPageEvidence] = useState<QueryFamilySummary['evidence'] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetchQueryFamilies(metric, null, controller.signal)
      .then(page => {
        setFamilies(page.items)
        setNextPageToken(page.nextPageToken)
        setPageEvidence(page.evidence)
        if (page.items[0]) return fetchQueryFamily(page.items[0].familyId, controller.signal)
        return null
      })
      .then(value => { if (value) setDetail(value) })
      .catch(reason => { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason)) })
    return () => controller.abort()
  }, [metric])

  useEffect(() => {
    if (!detail?.plans[0]) { setPlan(null); return }
    const controller = new AbortController()
    void fetchPlan(detail.plans[0].planId, controller.signal).then(setPlan)
    setComparePlanId(detail.plans[1]?.planId ?? '')
    setComparison(null)
    return () => controller.abort()
  }, [detail])

  const selectFamily = (familyId: string) => {
    void fetchQueryFamily(familyId).then(setDetail).catch(reason => setError(String(reason)))
  }
  const loadMore = () => {
    if (!nextPageToken) return
    void fetchQueryFamilies(metric, nextPageToken).then(page => {
      setFamilies(current => [...current, ...page.items])
      setNextPageToken(page.nextPageToken)
    }).catch(reason => setError(String(reason)))
  }
  const selectPlan = (planId: string) => {
    void fetchPlan(planId).then(setPlan).catch(reason => setError(String(reason)))
  }
  const compare = () => {
    if (plan && comparePlanId) {
      void fetchPlanComparison(plan.planId, comparePlanId).then(setComparison).catch(reason => setError(String(reason)))
    }
  }

  return (
    <section className="query-store" aria-labelledby="query-store-title">
      <div className="section-heading">
        <div><h2 id="query-store-title">Query Store history</h2><p>Read-only factual history · fixture source by default</p></div>
        <label>Rank by <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>
          {metrics.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="source-banner"><strong>{detail?.family.evidence.source ?? pageEvidence?.source ?? 'Query Store'} source</strong> · {detail?.family.evidence.reason ?? pageEvidence?.reason ?? 'Loading…'}</p>
      <div className="query-grid">
        <div className="table-scroll">
          <table aria-label="Top query families">
            <thead><tr><th>Query family</th><th>Executions</th><th>CPU µs</th><th>Duration µs</th><th>Reads (8-KiB pages)</th><th>Wait ms</th></tr></thead>
            <tbody>{families.map(family => <tr key={family.familyId}>
              <th scope="row"><button type="button" onClick={() => selectFamily(family.familyId)}>
                {family.text.normalizedText ?? `${family.text.availability} text · physical ${family.physicalQueries[0]?.queryId}`}
              </button><small>{family.databaseId} · hash {family.queryHash}</small></th>
              <td>{family.executionCount}</td><td>{family.totalCpuMicroseconds}</td>
              <td>{family.totalDurationMicroseconds}</td><td>{family.totalLogicalReads8KiBPages}</td>
              <td>{family.totalWaitMilliseconds}</td>
            </tr>)}</tbody>
          </table>
          {nextPageToken && <button className="load-more" type="button" onClick={loadMore}>Load next 100 query families</button>}
        </div>
        {detail && <article className="query-detail">
          <h3>Physical identities and context</h3>
          <ul>{detail.family.physicalQueries.map(query => <li key={`${query.queryId}:${query.context.contextSettingsId}`}>
            query_id {query.queryId} · context {query.context.contextSettingsId} · {query.context.setOptions ?? 'SET options unavailable'}
          </li>)}</ul>
          <h3>Runtime timeline</h3>
          <div className="table-scroll"><table>
            <thead><tr><th>Interval / plan</th><th>Execution type</th><th>Replica</th><th>Executions</th><th>Average duration µs</th></tr></thead>
            <tbody>{detail.runtime.map(bucket => <tr key={`${bucket.planId}:${bucket.intervalId}:${bucket.executionType}:${bucket.replicaGroupId}`}>
              <td>{new Date(bucket.intervalStart).toLocaleString()} · {bucket.planId}</td><td>{bucket.executionType}</td>
              <td>{bucket.replicaGroupId}</td><td>{bucket.executionCount}</td><td>{bucket.averageDurationMicroseconds}</td>
            </tr>)}</tbody>
          </table></div>
          <h3>Plan history</h3>
          <ul className="plan-list">{detail.plans.map(item => <li key={item.planId}>
            <button type="button" onClick={() => selectPlan(item.planId)}>{item.planId}</button>
            {' '}{item.planType} · {item.optimization} · {new Date(item.lastExecutionAt).toLocaleString()}
            {!item.runtimeCounted && ' · dispatcher runtime excluded'}
            {item.isForced && ` · forced${item.lastForceFailureReason ? `; failure ${item.lastForceFailureReason}` : ''}`}
          </li>)}</ul>
          {plan && <section aria-labelledby="plan-tree-title">
            <h3 id="plan-tree-title">Compiled plan tree</h3>
            <p className="caveat">{plan.runtimeOverlayCaveat}</p>
            <ol className="plan-tree">{plan.nodes.map(node => <li key={node.nodeId}>
              Node {node.nodeId} · {node.physicalOperation} / {node.logicalOperation}
              {node.estimatedRows !== null && ` · estimated rows ${node.estimatedRows}`}
            </li>)}</ol>
            <div className="compare-controls">
              <label>Compare with <select value={comparePlanId} onChange={event => setComparePlanId(event.target.value)}>
                <option value="">Choose a plan</option>
                {detail.plans.filter(item => item.planId !== plan.planId).map(item => <option key={item.planId}>{item.planId}</option>)}
              </select></label>
              <button type="button" onClick={compare} disabled={!comparePlanId}>Compare structure</button>
            </div>
            {comparison && <div aria-live="polite"><p>{comparison.source}: {comparison.structurallyEqual ? 'same structure' : `${comparison.changes.length} structural changes`}</p><p className="caveat">{comparison.caveat}</p></div>}
          </section>}
        </article>}
      </div>
    </section>
  )
}
