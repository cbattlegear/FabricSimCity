import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchFindings, fetchFindingsStatus } from './api'
import {
  FINDINGS_DISCLOSURE,
  TRUSTED_NETWORK_DISCLOSURE,
  confidenceGlyph,
  confidenceLabel,
  countBySeverity,
  dataStatusLabel,
  formatImpact,
  freshnessGlyph,
  loadPresentation,
  savePresentation,
  severityGlyph,
  severityLabel,
  togglePresentation,
} from './findings'
import type { FindingsPresentation, PresentationStore } from './findings'
import type { Finding, FindingSeverity, FindingsEngineStatus } from './findingsContracts'
import './FindingsPanel.css'

type SortMode = 'severity' | 'impact' | 'confidence'
const SEVERITIES: FindingSeverity[] = ['Serious', 'Notable', 'Advisory', 'Informational']

function presentationStore(): PresentationStore | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function FindingsPanel() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [status, setStatus] = useState<FindingsEngineStatus | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sort, setSort] = useState<SortMode>('severity')
  const [severityFilter, setSeverityFilter] = useState<Set<FindingSeverity>>(new Set())
  const [hideSuppressed, setHideSuppressed] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const store = useRef<PresentationStore | null>(presentationStore())
  const [presentation, setPresentation] = useState<FindingsPresentation>(() =>
    store.current ? loadPresentation(store.current) : { acknowledged: new Set(), suppressed: new Set() },
  )

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    const severity = [...severityFilter]
    const load = () => {
      Promise.all([
        fetchFindings({ sort, severity }, controller.signal),
        fetchFindingsStatus(controller.signal),
      ])
        .then(([page, engineStatus]) => {
          setFindings(page.items)
          setStatus(engineStatus)
          setError(null)
        })
        .catch(reason => {
          if (reason instanceof DOMException && reason.name === 'AbortError') return
          setError(reason instanceof Error ? reason.message : 'Findings could not be loaded')
        })
        .finally(() => {
          setLoading(false)
          if (!controller.signal.aborted) timer = window.setTimeout(load, 30_000)
        })
    }
    setLoading(true)
    load()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sort, severityFilter])

  function toggle(which: 'acknowledged' | 'suppressed', findingId: string) {
    setPresentation(current => {
      const next = togglePresentation(current, which, findingId)
      if (store.current) savePresentation(store.current, next)
      return next
    })
  }

  const visible = useMemo(
    () => (hideSuppressed ? findings.filter(f => !presentation.suppressed.has(f.findingId)) : findings),
    [findings, hideSuppressed, presentation.suppressed],
  )
  const counts = useMemo(() => countBySeverity(visible), [visible])
  const selected = useMemo(() => findings.find(f => f.findingId === selectedId) ?? null, [findings, selectedId])

  function toggleSeverity(severity: FindingSeverity) {
    setSeverityFilter(current => {
      const next = new Set(current)
      if (next.has(severity)) next.delete(severity)
      else next.add(severity)
      return next
    })
  }

  return (
    <section className="findings" aria-labelledby="findings-title">
      <div className="findings-heading">
        <div>
          <h2 id="findings-title">Findings</h2>
          <p>Evidence-backed performance leads from the atlas, Query Store, and live samples</p>
        </div>
        {status && (
          <div className="findings-engine" aria-label="Findings engine status">
            <span>{status.firingRuleCount}/{status.supportedRuleCount} rules firing</span>
            <span>{status.ruleCount - status.supportedRuleCount} unsupported disclosed</span>
          </div>
        )}
      </div>

      <p className="findings-disclosure" role="note">{FINDINGS_DISCLOSURE}</p>
      <p className="findings-disclosure findings-trust" role="note">{TRUSTED_NETWORK_DISCLOSURE}</p>

      <div className="findings-controls">
        <fieldset>
          <legend>Severity</legend>
          {SEVERITIES.map(severity => (
            <label key={severity} className="findings-check">
              <input
                type="checkbox"
                checked={severityFilter.has(severity)}
                onChange={() => toggleSeverity(severity)}
              />
              <span aria-hidden="true" className={`sev sev-${severity.toLowerCase()}`}>{severityGlyph(severity)}</span>
              {severity}
            </label>
          ))}
        </fieldset>
        <label className="findings-sort">
          Sort
          <select value={sort} onChange={event => setSort(event.target.value as SortMode)}>
            <option value="severity">Severity, then impact</option>
            <option value="impact">Measured impact</option>
            <option value="confidence">Confidence</option>
          </select>
        </label>
        <label className="findings-check">
          <input type="checkbox" checked={hideSuppressed} onChange={() => setHideSuppressed(v => !v)} />
          Hide suppressed
        </label>
      </div>

      <div className="findings-summary" aria-label="Severity counts">
        {SEVERITIES.map(severity => (
          <span key={severity} className={`sev-count sev-${severity.toLowerCase()}`}>
            <span aria-hidden="true">{severityGlyph(severity)}</span> {severity}: {counts[severity]}
          </span>
        ))}
      </div>

      {error ? (
        <p className="findings-error" role="alert">{error}. Confirm the API is running, then retry.</p>
      ) : loading && findings.length === 0 ? (
        <p className="findings-loading" aria-live="polite">Evaluating findings…</p>
      ) : (
        <div className="findings-grid">
          <ul className="findings-list" aria-label="Findings inbox">
            {visible.length === 0 && <li className="findings-empty">No findings match the current filters.</li>}
            {visible.map(finding => {
              const acknowledged = presentation.acknowledged.has(finding.findingId)
              const suppressed = presentation.suppressed.has(finding.findingId)
              return (
                <li key={finding.findingId} className={finding.findingId === selectedId ? 'is-selected' : undefined}>
                  <button
                    type="button"
                    className="finding-row"
                    aria-pressed={finding.findingId === selectedId}
                    aria-label={`${finding.title}. ${severityLabel(finding.severity)}, ${confidenceLabel(finding.confidence)}. Impact ${formatImpact(finding.impact)}.${acknowledged ? ' Acknowledged.' : ''}${suppressed ? ' Suppressed.' : ''}`}
                    onClick={() => setSelectedId(finding.findingId)}
                  >
                    <span className={`sev sev-${finding.severity.toLowerCase()}`} aria-hidden="true">{severityGlyph(finding.severity)}</span>
                    <span className="finding-main">
                      <span className="finding-title">{finding.title}</span>
                      <span className="finding-meta">
                        <span aria-hidden="true">{confidenceGlyph(finding.confidence)}</span> {finding.confidence} · {formatImpact(finding.impact)}
                        {acknowledged && <span className="finding-tag">acknowledged</span>}
                        {suppressed && <span className="finding-tag">suppressed</span>}
                      </span>
                    </span>
                  </button>
                  <span className="finding-actions">
                    <button type="button" onClick={() => toggle('acknowledged', finding.findingId)} aria-pressed={acknowledged}>
                      {acknowledged ? 'Unacknowledge' : 'Acknowledge'}
                    </button>
                    <button type="button" onClick={() => toggle('suppressed', finding.findingId)} aria-pressed={suppressed}>
                      {suppressed ? 'Unsuppress' : 'Suppress'}
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>

          <EvidenceDrawer finding={selected} />
        </div>
      )}

      {status && (
        <section className="findings-rules" aria-labelledby="findings-rules-title">
          <h3 id="findings-rules-title">Rule coverage</h3>
          <ul>
            {status.rules.map(rule => (
              <li key={rule.ruleId} className={`rule-${rule.support.toLowerCase()}`}>
                <strong>{rule.title}</strong>
                <span className="rule-outcome">{rule.support === 'Unsupported' ? 'Unsupported' : rule.outcome} · {rule.findingCount}</span>
                <span className="rule-reason">{rule.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}

function EvidenceDrawer({ finding }: { finding: Finding | null }) {
  if (!finding) {
    return <aside className="finding-detail"><p>Select a finding to inspect its evidence, caveats, and next checks.</p></aside>
  }
  return (
    <aside className="finding-detail" aria-labelledby="finding-detail-title">
      <div className="finding-detail-head">
        <h3 id="finding-detail-title">{finding.title}</h3>
        <p className="finding-detail-badges">
          <span className={`sev sev-${finding.severity.toLowerCase()}`}>
            <span aria-hidden="true">{severityGlyph(finding.severity)}</span> {severityLabel(finding.severity)}
          </span>
          <span className="conf">
            <span aria-hidden="true">{confidenceGlyph(finding.confidence)}</span> {confidenceLabel(finding.confidence)}
          </span>
        </p>
      </div>

      <dl>
        <div><dt>Scope</dt><dd>{finding.scope.displayName}{finding.scope.databaseId ? ` · ${finding.scope.databaseId}` : ''}</dd></div>
        <div><dt>Rule</dt><dd>{finding.ruleId} v{finding.ruleVersion}</dd></div>
        <div><dt>Measured impact</dt><dd>{formatImpact(finding.impact)}<small>{finding.impact.basis}</small></dd></div>
        <div><dt>Observed window</dt><dd>
          {finding.observedWindow.start && finding.observedWindow.end
            ? `${new Date(finding.observedWindow.start).toLocaleString()} – ${new Date(finding.observedWindow.end).toLocaleString()}`
            : finding.observedWindow.kind}
          <small>{finding.observedWindow.caveat}</small>
        </dd></div>
        <div><dt>Source</dt><dd>
          <span aria-hidden="true">{freshnessGlyph(finding.sourceFreshness.status)}</span> {finding.sourceFreshness.source} · {dataStatusLabel(finding.sourceFreshness.status)}
          <small>{finding.sourceFreshness.reason}</small>
        </dd></div>
      </dl>

      <section aria-labelledby="finding-evidence-title">
        <h4 id="finding-evidence-title">Evidence</h4>
        <ul className="finding-evidence">
          {finding.evidence.map((ref, index) => (
            <li key={`${ref.kind}-${ref.ref}-${index}`}>
              <strong>{ref.label}</strong> <span className="evidence-kind">{ref.kind}: {ref.ref}</span>
              <span>{ref.observation}</span>
            </li>
          ))}
        </ul>
      </section>

      <FindingList title="Caveats" items={finding.caveats} />
      <FindingList title="Alternate explanations" items={finding.alternateExplanations} />
      <FindingList title="Recommended next checks" items={finding.recommendedNextChecks} />

      <section className="finding-recommendation" aria-labelledby="finding-reco-title">
        <h4 id="finding-reco-title">Read-only recommendation</h4>
        <p>{finding.readOnlyRecommendation}</p>
      </section>
    </aside>
  )
}

function FindingList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <h4>{title}</h4>
      <ul className="finding-notes">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </section>
  )
}

export default FindingsPanel
