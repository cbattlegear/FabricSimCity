import { describe, expect, it } from 'vitest'
import { accessibleDatabaseLabel, databaseSide, evidenceText, isFreshLive, sizeToSide } from './atlas'
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

function database(bytes: number | null, status: 'Known' | 'Unknown' = 'Known'): DatabaseAtlasItem {
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
      executionCount: 0,
      logicalReads: 0,
      averageDurationMilliseconds: 0,
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
    expect(databaseSide(database(256 * 1024))).toBe(databaseSide(database(256 * 1024)))
  })

  it('keeps unknown separate from known zero', () => {
    expect(databaseSide(database(null, 'Unknown'))).toBeNull()
    expect(databaseSide(database(0))).toBe(12)
    expect(() => sizeToSide(-1)).toThrow(RangeError)
  })
})

describe('evidence semantics and accessible text', () => {
  it('permits motion only for a fresh available live sample', () => {
    const item = database(1024)
    expect(isFreshLive(item, generated)).toBe(true)
    item.liveActivity.evidence.status = 'Stale'
    expect(isFreshLive(item, generated)).toBe(false)
    item.liveActivity.evidence.status = 'Available'
    item.liveActivity.evidence.freshUntil = '2026-08-17T16:59:59Z'
    expect(isFreshLive(item, generated)).toBe(false)
  })

  it('names the source, status, exact bytes, and untrusted-looking name as text', () => {
    const item = database(1024)
    const label = accessibleDatabaseLabel(item)
    expect(label).toContain('test <database>')
    expect(label).toContain('1,024 bytes (1 KiB)')
    expect(label).toContain('Live DMV sample')
    expect(label).toContain('Query Store')
    expect(evidenceText({ ...evidence('PermissionDenied'), source: 'QueryStoreAggregate' }))
      .toContain('Query Store aggregate history — permission denied')
  })
})
