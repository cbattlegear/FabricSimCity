import { useEffect, useMemo, useState } from 'react'
import { fetchLiveIncidents, subscribeToLiveIncidents } from './api'
import {
  POLLING_DISCLOSURE,
  blockingGraphSummaryLabel,
  collectorStatusLabel,
  counterDeltaLabel,
  dataStatusLabel,
  groupRequestsByAvailability,
  isSnapshotFresh,
  liveFeedConnectionGlyph,
  liveFeedConnectionLabel,
  memoryGrantLabel,
  requestGroupSummaryLabel,
  requestLabel,
  waitingTaskLabel,
} from './liveIncidents'
import type { LiveFeedConnectionState, RequestAvailabilityGroups } from './liveIncidents'
import type { LiveIncidentResponse, LiveIncidentSnapshot, LiveRequest } from './liveContracts'
import './LiveIncidentsPanel.css'

export default function LiveIncidents() {
  const [response, setResponse] = useState<LiveIncidentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())
  const [feedState, setFeedState] = useState<LiveFeedConnectionState>('reconnecting')

  useEffect(() => {
    const controller = new AbortController()
    fetchLiveIncidents(controller.signal)
      .then(setResponse)
      .catch(reason => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : 'The live incident feed could not be loaded')
      })
    const unsubscribe = subscribeToLiveIncidents(
      update => {
        setResponse(update)
        setError(null)
      },
      setFeedState,
    )
    return () => {
      controller.abort()
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    // A one-second clock is purely for the staleness label text below; it never drives motion or
    // animation, and it is not what makes the reduced-motion contract true or false.
    const interval = window.setInterval(() => setNow(new Date().toISOString()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const snapshot = response?.snapshot ?? null
  const fresh = useMemo(() => (snapshot ? isSnapshotFresh(snapshot, now) : false), [snapshot, now])

  if (error) {
    return (
      <section className="live-incidents error" role="alert">
        <h2>Live incidents unavailable</h2>
        <p>{error}. Confirm the ASP.NET API is running, then reload this page.</p>
      </section>
    )
  }

  if (!response) {
    return (
      <section className="live-incidents loading" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" /> Loading live incident sample…
        <FeedConnectionNotice state={feedState} />
      </section>
    )
  }

  return (
    <section className="live-incidents" aria-labelledby="live-incidents-title">
      <header className="live-header">
        <div>
          <h2 id="live-incidents-title">Live incidents</h2>
          <p>{POLLING_DISCLOSURE}</p>
        </div>
        <StatusBadge fresh={fresh} snapshot={snapshot} />
      </header>

      <FeedConnectionNotice state={feedState} />

      <p className="collector-status" aria-live="polite">{collectorStatusLabel(response.collector)}</p>

      {!snapshot ? (
        <p className="no-snapshot">No sample has completed yet.</p>
      ) : (
        <LiveSnapshotBody snapshot={snapshot} fresh={fresh} />
      )}
    </section>
  )
}

function StatusBadge({ fresh, snapshot }: { fresh: boolean; snapshot: LiveIncidentSnapshot | null }) {
  if (!snapshot) return null
  const label = fresh ? 'fresh' : 'stale'
  return (
    <div className={`live-badge live-badge-${label}`} role="status">
      <span className="live-badge-mark" aria-hidden="true">{fresh ? '●' : '◐'}</span>
      <span>
        {dataStatusLabel(snapshot.status)} — {label}. Source timestamp:{' '}
        {snapshot.sourceTimestamp ? new Date(snapshot.sourceTimestamp).toLocaleTimeString() : 'unavailable'}
      </span>
    </div>
  )
}

function FeedConnectionNotice({ state }: { state: LiveFeedConnectionState }) {
  return (
    <p className={`feed-connection feed-connection-${state}`} role="status">
      <span className="feed-connection-mark" aria-hidden="true">{liveFeedConnectionGlyph(state)}</span>
      <span>{liveFeedConnectionLabel(state)}</span>
    </p>
  )
}

function LiveSnapshotBody({ snapshot, fresh }: { snapshot: LiveIncidentSnapshot; fresh: boolean }) {
  const groups = groupRequestsByAvailability(snapshot.requests)
  return (
    <>
      {!fresh && (
        <p className="stale-banner" role="alert">
          This sample is stale or the collector is disconnected. {snapshot.reason}
        </p>
      )}

      <div className="live-grid">
        <section aria-labelledby="requests-title">
          <h3 id="requests-title">Active requests ({groups.available.length})</h3>
          <p className="section-note">{requestGroupSummaryLabel(groups)}</p>
          <ul className="record-list">
            {groups.available.map(request => (
              <li key={request.requestId}>
                <span className="request-mark" aria-hidden="true">▶</span>
                <span className="request-state">Active:</span> {requestLabel(request)}
              </li>
            ))}
            {groups.available.length === 0 && <li>No active requests in this sample.</li>}
          </ul>
        </section>

        <InactiveRequests groups={groups} />

        <section aria-labelledby="waits-title">
          <h3 id="waits-title">Waiting tasks — all parallel waits ({snapshot.waitingTasks.length})</h3>
          <p className="section-note">Every worker's wait is listed individually; none are collapsed into a single coordinator wait.</p>
          <ul className="record-list">
            {snapshot.waitingTasks.map(task => (
              <li key={task.taskId}>{waitingTaskLabel(task)}</li>
            ))}
            {snapshot.waitingTasks.length === 0 && <li>No waiting tasks in this sample.</li>}
          </ul>
        </section>

        <section aria-labelledby="blocking-title">
          <h3 id="blocking-title">Blocking graph</h3>
          <p>{blockingGraphSummaryLabel(snapshot)}</p>
          <ul className="record-list">
            {snapshot.blockingGraph.nodes.map(node => (
              <li key={node.nodeId}>
                {node.kind === 'Sentinel'
                  ? `Sentinel node ${node.nodeId}${node.isRoot ? ' (root)' : ''}${node.inCycle ? ' (in cycle)' : ''}`
                  : `Session ${node.sessionId}${node.isRoot ? ' (root blocker)' : ''}` +
                    `${node.isIdleWithOpenTransaction ? ' — idle with an open transaction' : ''}` +
                    `${node.inCycle ? ' (in cycle)' : ''}, directly blocking ${node.directlyBlockedCount}`}
              </li>
            ))}
            {snapshot.blockingGraph.nodes.length === 0 && <li>No blocking observed in this sample.</li>}
          </ul>
        </section>

        <section aria-labelledby="grants-title">
          <h3 id="grants-title">Memory grants ({snapshot.memoryGrants.length})</h3>
          <ul className="record-list">
            {snapshot.memoryGrants.map(grant => (
              <li key={`${grant.sessionId}-${grant.requestId ?? 0}`}>{memoryGrantLabel(grant)}</li>
            ))}
            {snapshot.memoryGrants.length === 0 && <li>No memory grants outstanding in this sample.</li>}
          </ul>
        </section>

        <TempdbSummary snapshot={snapshot} />
        <FileIoSummary snapshot={snapshot} />
        <SchedulerSummary snapshot={snapshot} />
        <LogSpaceSummary snapshot={snapshot} />
      </div>

      <UnavailableList snapshot={snapshot} />
    </>
  )
}

function InactiveRequests({ groups }: { groups: RequestAvailabilityGroups }) {
  const total = groups.disappeared.length + groups.stale.length + groups.unavailable.length
  if (total === 0) return null
  return (
    <section aria-labelledby="inactive-requests-title" className="inactive-requests">
      <h3 id="inactive-requests-title">Not counted as active ({total})</h3>
      <p className="section-note">
        These rows are excluded from the active count above. A carried-forward row is not evidence
        that its request ended; it only means this cycle could not observe it.
      </p>
      <RequestGroup
        headingId="disappeared-requests-title"
        heading={`Disappeared since the last cycle (${groups.disappeared.length})`}
        glyph="✕"
        stateLabel="Disappeared"
        note="Observed in an earlier cycle and confirmed absent in this one."
        requests={groups.disappeared}
      />
      <RequestGroup
        headingId="stale-requests-title"
        heading={`Carried forward after a failed probe (${groups.stale.length})`}
        glyph="◐"
        stateLabel="Stale"
        note="This cycle's own probe failed, so these values come from an earlier cycle. They are neither current nor known to be gone."
        requests={groups.stale}
      />
      <RequestGroup
        headingId="unavailable-requests-title"
        heading={`Unavailable (${groups.unavailable.length})`}
        glyph="?"
        stateLabel="Unavailable"
        note="No availability could be determined for these rows."
        requests={groups.unavailable}
      />
    </section>
  )
}

function RequestGroup({
  headingId,
  heading,
  glyph,
  stateLabel,
  note,
  requests,
}: {
  headingId: string
  heading: string
  glyph: string
  stateLabel: string
  note: string
  requests: LiveRequest[]
}) {
  if (requests.length === 0) return null
  return (
    <section aria-labelledby={headingId} className={`request-group request-group-${stateLabel.toLowerCase()}`}>
      <h4 id={headingId}>
        <span className="request-mark" aria-hidden="true">{glyph}</span> {heading}
      </h4>
      <p className="section-note">{note}</p>
      <ul className="record-list">
        {requests.map(request => (
          <li key={request.requestId}>
            <span className="request-mark" aria-hidden="true">{glyph}</span>
            <span className="request-state">{stateLabel}:</span> {requestLabel(request)}
          </li>
        ))}
      </ul>
    </section>
  )
}

function TempdbSummary({ snapshot }: { snapshot: LiveIncidentSnapshot }) {
  const tempdb = snapshot.tempdb
  return (
    <section aria-labelledby="tempdb-title">
      <h3 id="tempdb-title">tempdb</h3>
      <p>{dataStatusLabel(tempdb.status)}. {tempdb.reason}</p>
      <ul className="record-list">
        {tempdb.files.map(file => (
          <li key={file.fileId}>File {file.fileId}: {file.allocatedMb.toFixed(1)} MiB allocated of {file.totalMb.toFixed(1)} MiB, {file.freeMb.toFixed(1)} MiB free.</li>
        ))}
        {tempdb.files.length === 0 && <li>No tempdb file usage rows in this sample.</li>}
      </ul>
    </section>
  )
}

function FileIoSummary({ snapshot }: { snapshot: LiveIncidentSnapshot }) {
  const fileIo = snapshot.fileIo
  return (
    <section aria-labelledby="fileio-title">
      <h3 id="fileio-title">File I/O</h3>
      <p>{dataStatusLabel(fileIo.status)}. {fileIo.reason}</p>
      <ul className="record-list">
        {fileIo.files.map(file => (
          <li key={`${file.databaseId}-${file.fileId}`}>
            {file.databaseName ?? file.databaseId} file {file.fileId} (epoch {file.epochId}): reads{' '}
            {counterDeltaLabel(file.readsDelta, 'reads')}, writes {counterDeltaLabel(file.writesDelta, 'writes')}.
          </li>
        ))}
        {fileIo.files.length === 0 && <li>No file I/O rows in this sample.</li>}
      </ul>
    </section>
  )
}

function SchedulerSummary({ snapshot }: { snapshot: LiveIncidentSnapshot }) {
  const scheduler = snapshot.scheduler
  return (
    <section aria-labelledby="scheduler-title">
      <h3 id="scheduler-title">Scheduler pressure</h3>
      <p>{dataStatusLabel(scheduler.status)}. {scheduler.reason}</p>
      <ul className="record-list">
        {scheduler.schedulers.map(sched => (
          <li key={sched.schedulerId}>
            Scheduler {sched.schedulerId} (CPU {sched.cpuId}): {sched.runnableTasksCount} runnable, {sched.currentTasksCount} current tasks,
            CPU usage {counterDeltaLabel(sched.cpuUsageMsDelta, 'ms')}.
          </li>
        ))}
        {scheduler.schedulers.length === 0 && <li>No scheduler rows in this sample.</li>}
      </ul>
    </section>
  )
}

function LogSpaceSummary({ snapshot }: { snapshot: LiveIncidentSnapshot }) {
  const logSpace = snapshot.logSpace
  return (
    <section aria-labelledby="logspace-title">
      <h3 id="logspace-title">Write-ahead log space</h3>
      <p>{dataStatusLabel(logSpace.status)}. {logSpace.reason}</p>
      {logSpace.totalLogSizeMb !== null && (
        <p>
          {logSpace.usedLogSpaceMb?.toFixed(1) ?? 'unavailable'} MiB used of {logSpace.totalLogSizeMb.toFixed(1)} MiB
          {logSpace.usedLogSpacePercent !== null ? ` (${logSpace.usedLogSpacePercent.toFixed(1)}%)` : ''}.
        </p>
      )}
    </section>
  )
}

function UnavailableList({ snapshot }: { snapshot: LiveIncidentSnapshot }) {
  if (snapshot.diagnostics.unavailableFields.length === 0) return null
  return (
    <section aria-labelledby="unavailable-title" className="unavailable-fields">
      <h3 id="unavailable-title">Explicitly unavailable this cycle</h3>
      <ul className="record-list">
        {snapshot.diagnostics.unavailableFields.map(field => (
          <li key={field.field}>{field.field}: {dataStatusLabel(field.status)} — {field.reason}</li>
        ))}
      </ul>
    </section>
  )
}
