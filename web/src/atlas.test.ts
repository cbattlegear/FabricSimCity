import { describe, expect, it } from 'vitest'
import { accessibleDatabaseLabel, collectorSummary, databaseSide, evidenceText, formatBytes, formatDecimalCount, formatFill, isFreshLive, sizeToSide } from './atlas'
import type { DatabaseAtlasItem, Evidence } from './contracts'

const observed = '2026-08-17T16:59:52Z'
const generated = '2026-08-17T17:00:00Z'

function evidence(status: Evidence['status'] = 'Available'): Evidence {
  return {
    source: 'LiveDmvSample',
    status,
    observedAt: observed,
    freshUntil: '2026-08-17T17:00:22Z',
    reason: status === 'Available' ? 'Sample is current.' : 'Sample is unavailable.',
  }
}

function database(bytes: string | null, status: 'Known' | 'Unknown' = 'Known'): DatabaseAtlasItem {
  const sizeEvidence: Evidence = {
    source: 'Fixture',
    status: status === 'Known' ? 'Available' : 'Unknown',
    observedAt: generated,
    freshUntil: '2026-08-17T18:00:00Z',
    reason: status === 'Known' ? 'Fixture bytes.' : 'Metadata not visible.',
  }
  return {
    databaseId: 'target/database/test',
    name: 'test <database>',
    allocated: { bytes, status, reason: status === 'Unknown' ? 'Metadata not visible.' : null, evidence: sizeEvidence },
    used: { bytes, status, reason: status === 'Unknown' ? 'Metadata not visible.' : null, evidence: sizeEvidence },
    liveActivity: {
      activeSessions: 0,
      runningRequests: 0,
      blockedSessions: 0,
      batchRequestsPerSecond: 0,
      evidence: evidence(),
    },
    queryStore: {
      executionCount: '0',
      logicalReads8KiBPages: '0',
      averageDurationMicroseconds: 0,
      windowStart: observed,
      windowEnd: generated,
      capability: 'Available',
      health: 'Healthy',
      reason: 'Collecting.',
      evidence: { ...evidence(), source: 'QueryStoreAggregate' },
    },
  }
}

describe('allocated size mapping', () => {
  it('implements the exact formula and cap', () => {
    expect(sizeToSide(0)).toBe(12)
    const allocatedKiB = 1024 * 1024
    const expected = Math.sqrt(144 + 9072 * Math.min(1, Math.log2(1 + allocatedKiB) / 50))
    expect(sizeToSide(allocatedKiB)).toBe(expected)
    expect(sizeToSide(2 ** 52)).toBe(96)
  })

  it('preserves order and equality', () => {
    expect(sizeToSide(10)).toBeLessThan(sizeToSide(10_000))
    expect(databaseSide(database('262144'))).toBe(databaseSide(database('262144')))
  })

  it('keeps unknown separate from known zero', () => {
    expect(databaseSide(database(null, 'Unknown'))).toBeNull()
    expect(databaseSide(database('0'))).toBe(12)
    expect(formatBytes(database('0').allocated)).toBe('0 bytes')
    expect(() => sizeToSide(-1)).toThrow(RangeError)
  })

  it('retains exact labels above Number.MAX_SAFE_INTEGER', () => {
    const value = '9007199254740993'
    const label = formatBytes(database(value).allocated)

    expect(label).toContain('9,007,199,254,740,993 bytes')
    expect(BigInt(value)).toBe(9007199254740993n)
  })

  it('computes used fill from exact integer bytes', () => {
    const allocated = database('18014398509481986')
    allocated.used.bytes = '9007199254740993'
    expect(formatFill(allocated.used, allocated.allocated)).toBe('50.0%')
  })
})

describe('evidence semantics and accessible text', () => {
  it('reports connected source staleness and partial failures', () => {
    const summary = collectorSummary({
      mode: 'Connected',
      state: 'Degraded',
      sequence: 7,
      collectedAt: generated,
      sourceTimestamp: observed,
      staleAfter: observed,
      isStale: true,
      databaseCount: 99,
      failureCount: 1,
      skipCount: 0,
      durationMilliseconds: 1250,
      rowCount: 450,
      reason: 'One database failed.',
    })
    expect(summary).toBe('sequence 7 · 99 databases · 450 rows · 1250 ms · stale · 1 partial failure(s)')
  })

  it('permits motion only for a fresh available live sample', () => {
    const item = database('1024')
    expect(isFreshLive(item, generated)).toBe(true)
    item.liveActivity.evidence.status = 'Stale'
    expect(isFreshLive(item, generated)).toBe(false)
    item.liveActivity.evidence.status = 'Available'
    item.liveActivity.evidence.freshUntil = '2026-08-17T16:59:59Z'
    expect(isFreshLive(item, generated)).toBe(false)
  })

  it('retains Query Store counts and capability storage bytes above Number.MAX_SAFE_INTEGER', () => {
    expect(formatDecimalCount('9007199254740993')).toBe('9,007,199,254,740,993')
    expect(formatDecimalCount('9007199255789568')).toBe('9,007,199,255,789,568')
    expect(formatDecimalCount(null)).toBe('Unavailable')
  })

  it('names the source, status, exact bytes, and untrusted-looking name as text', () => {
    const item = database('1024')
    const label = accessibleDatabaseLabel(item)
    expect(label).toContain('test <database>')
    expect(label).toContain('1,024 bytes (1 KiB)')
    expect(label).toContain('Live DMV sample')
    expect(label).toContain('Query Store')
    expect(evidenceText({ ...evidence('PermissionDenied'), source: 'QueryStoreAggregate' }))
      .toContain('Query Store aggregate history — permission denied')
  })
})
