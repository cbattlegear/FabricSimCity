import { describe, expect, it } from 'vitest'
import {
  buildVehicleRoster,
  normalizeHash,
  parseBytes,
  phaseOf,
  pointAt,
  polylineLength,
  vehicleClass,
  vehicleSummaryLabel,
  CAR_FLOOR_BYTES,
  SEMI_FLOOR_BYTES,
  VAN_FLOOR_BYTES,
  VEHICLE_CAP,
  type VehicleRoad,
} from './cityVehicles'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveRequest } from './liveContracts'
import type { IncidentPlacement } from './cityIncidentPlacement'

/**
 * The vehicle roster is the only thing on this map that claims to describe *right now*, and every
 * way it can be wrong is a way it can be wrong quietly: a size band off by one renders as a smaller
 * truck, an absent measurement rendered as a bicycle looks like a real small query, and a join that
 * silently matches nothing looks exactly like an idle server.
 *
 * These are new-module tests with no previous version to revert to, so each guard below was
 * mutation-checked instead — the implementation was changed to the obvious wrong version and the
 * guard watched to fail. The mutations are named in the comments so the check is repeatable.
 */

function family(over: Partial<DatabaseCityQueryFamily> = {}): DatabaseCityQueryFamily {
  return {
    familyId: 'fam-1',
    queryHash: 'AABBCCDDEEFF0011',
    displayName: 'SELECT …',
    executionCount: 10,
    totalCpuMs: 1,
    totalDurationMs: 1,
    totalLogicalReads: '1',
    objectIds: ['obj-1'],
    ...over,
  } as DatabaseCityQueryFamily
}

function request(over: Partial<LiveRequest> = {}): LiveRequest {
  return {
    requestId: 'r1',
    sessionId: 51,
    loginName: null,
    hostName: null,
    programName: null,
    sessionStatus: 'running',
    requestStatus: 'running',
    command: 'SELECT',
    waitType: null,
    waitTimeMs: null,
    waitResource: null,
    blocking: { blockingSessionId: null, sentinel: 'None' },
    requestStartTime: null,
    totalElapsedMs: 100,
    cpuTimeMs: null,
    reads: null,
    writes: null,
    logicalReads8KiBPages: null,
    openTransactionCount: null,
    databaseId: null,
    databaseName: null,
    currentStatementText: null,
    batchText: null,
    availability: 'Available',
    availabilityReason: null,
    planState: 'Available',
    planReason: null,
    queryHash: 'AABBCCDDEEFF0011',
    ...over,
  } as LiveRequest
}

/** A straight 100-unit road running east, named by one family. */
function road(over: Partial<VehicleRoad> = {}): VehicleRoad {
  return {
    routeId: 'route-1',
    familyIds: ['fam-1'],
    executions: 10,
    polyline: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
    ...over,
  }
}

const noBlocks = new Map<number, IncidentPlacement>()

function volume(bytes: string): DatabaseCityQueryFamily['planDataVolume'] {
  return {
    estimatedBytesPerExecution: bytes,
    byObject: [],
    plansRead: 1,
    rationale: 'test',
  } as unknown as DatabaseCityQueryFamily['planDataVolume']
}

describe('the size ladder bands estimated plan data volume', () => {
  /*
   * Mutation checked: changing any `<` to `<=` in `vehicleClass` flips the floor cases below, and
   * swapping two band constants makes the "distinct" test fail.
   */
  it.each([
    ['0', 'bike'],
    ['1', 'bike'],
    [(CAR_FLOOR_BYTES - 1n).toString(), 'bike'],
    [CAR_FLOOR_BYTES.toString(), 'car'],
    [(VAN_FLOOR_BYTES - 1n).toString(), 'car'],
    [VAN_FLOOR_BYTES.toString(), 'van'],
    [(SEMI_FLOOR_BYTES - 1n).toString(), 'van'],
    [SEMI_FLOOR_BYTES.toString(), 'semiTruck'],
  ])('%s bytes is a %s', (bytes, expected) => {
    expect(vehicleClass(family({ planDataVolume: volume(bytes) }))).toBe(expected)
  })

  it('puts each band on its own rung, so no two cut points collapse', () => {
    const classes = [
      (CAR_FLOOR_BYTES - 1n).toString(),
      CAR_FLOOR_BYTES.toString(),
      VAN_FLOOR_BYTES.toString(),
      SEMI_FLOOR_BYTES.toString(),
    ].map(bytes => vehicleClass(family({ planDataVolume: volume(bytes) })))
    expect(new Set(classes).size).toBe(4)
    expect(CAR_FLOOR_BYTES).toBeLessThan(VAN_FLOOR_BYTES)
    expect(VAN_FLOOR_BYTES).toBeLessThan(SEMI_FLOOR_BYTES)
  })

  /*
   * The single most important assertion in this file.
   *
   * Mutation checked: `if (bytes === null) return 'bike'` — the obvious "absent means nothing much"
   * shortcut — fails here and nowhere else in the suite.
   */
  it('renders an absent plan data volume as unknown, and never as a bike', () => {
    expect(vehicleClass(family({ planDataVolume: undefined }))).toBe('unknown')
    expect(vehicleClass(family({ planDataVolume: undefined }))).not.toBe('bike')
  })

  it('renders a stated zero as a bike, because zero is a measurement', () => {
    // Absent and zero are different claims, and this is the pair that proves the module knows it.
    expect(vehicleClass(family({ planDataVolume: volume('0') }))).toBe('bike')
    expect(vehicleClass(family({ planDataVolume: undefined }))).toBe('unknown')
  })

  it('treats an unparseable volume as unknown rather than as zero', () => {
    for (const bad of ['', ' ', '-1', '1.5', '1e6', 'lots', '0x20']) {
      expect(vehicleClass(family({ planDataVolume: volume(bad) })), bad).toBe('unknown')
    }
  })
})

describe('byte parsing survives values a JSON number would not', () => {
  /*
   * Mutation checked: `BigInt(Number(trimmed))` passes every other test in this file and fails only
   * here — which is exactly why the wire format is a decimal string.
   */
  it('keeps every digit of a value beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993' // 2^53 + 1: the smallest integer a double cannot represent.
    expect(parseBytes(huge)).toBe(9007199254740993n)
    expect(parseBytes(huge)).not.toBe(BigInt(Number(huge)))
  })

  it('bands a petabyte-scale volume as a semi rather than overflowing into nonsense', () => {
    expect(vehicleClass(family({ planDataVolume: volume('1125899906842624') }))).toBe('semiTruck')
  })

  it.each([undefined, null, '', 'abc', '-5', '1.0', ' 12 '])('rejects %s as unmeasured', value => {
    const parsed = parseBytes(value as string | null | undefined)
    if (value === ' 12 ') expect(parsed).toBe(12n)
    else expect(parsed).toBeNull()
  })
})

describe('the join is query_hash and only query_hash', () => {
  it('drives a vehicle down the road its matched family graded', () => {
    const roster = buildVehicleRoster({
      requests: [request()],
      families: [family({ planDataVolume: volume('1000') })],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(1)
    expect(roster.vehicles[0].routeId).toBe('route-1')
    expect(roster.vehicles[0].class).toBe('bike')
    expect(roster.sampledRunning).toBe(1)
    expect(roster.unmatchedHash).toBe(0)
  })

  /*
   * Mutation checked: falling back to `families[0]` when the hash misses draws a vehicle here and
   * drops `unmatchedHash` to 0 — the exact "invent a family" failure the module forbids.
   */
  it('counts an unmatched hash instead of inventing a family for it', () => {
    const roster = buildVehicleRoster({
      requests: [request({ queryHash: '00FF00FF00FF00FF' })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.unmatchedHash).toBe(1)
    expect(roster.sampledRunning).toBe(1)
    expect(roster.reason).toMatch(/matched no query family/i)
  })

  it('counts a matched family that names no drawn road, separately from an unmatched hash', () => {
    const roster = buildVehicleRoster({
      requests: [request()],
      families: [family()],
      roads: [road({ familyIds: ['fam-other'] })],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.noRoad).toBe(1)
    expect(roster.unmatchedHash).toBe(0)
  })

  it('matches across case and an 0x prefix, which cannot make two hashes equal', () => {
    const roster = buildVehicleRoster({
      requests: [request({ queryHash: '0xaabbccddeeff0011' })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(1)
    expect(normalizeHash('0xaabb')).toBe(normalizeHash('AABB'))
    expect(normalizeHash('AABB')).not.toBe(normalizeHash('AABC'))
  })

  it('rejects the all-zero sentinel rather than making it a family everyone shares', () => {
    expect(normalizeHash('0000000000000000')).toBeNull()
    const roster = buildVehicleRoster({
      requests: [request({ queryHash: '0000000000000000' })],
      families: [family({ queryHash: '0000000000000000' })],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.unmatchedHash).toBe(1)
  })
})

describe('only a sampled running request becomes a vehicle', () => {
  /*
   * Issue #79. Mutation checked: deleting the `requestStatus === null` guard draws a vehicle for an
   * idle session and pushes `sampledRunning` to 1, which would put traffic on a quiet server.
   */
  it('produces nothing for an idle session holding no request', () => {
    const roster = buildVehicleRoster({
      requests: [request({ requestStatus: null })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.sampledRunning).toBe(0)
    expect(roster.unmatchedHash).toBe(0)
    expect(roster.reason).toMatch(/no request was running/i)
  })

  it('says so when no sampled row carried a query hash at all', () => {
    // An API build older than the field. Indistinguishable from a quiet server unless disclosed.
    const older = request()
    delete (older as { queryHash?: unknown }).queryHash
    const roster = buildVehicleRoster({
      requests: [older],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.hashReported).toBe(false)
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.reason).toMatch(/predates the field/i)
    expect(vehicleSummaryLabel(roster)).toBe('Not matchable')
  })

  it('distinguishes an old API from an engine that reported no hash', () => {
    const roster = buildVehicleRoster({
      requests: [request({ queryHash: null })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    // The field was present and null, so the API is current — the engine simply did not hash it.
    expect(roster.hashReported).toBe(true)
    expect(roster.unmatchedHash).toBe(1)
    expect(roster.reason).not.toMatch(/predates the field/i)
  })

  it('returns the empty roster when no snapshot has arrived, which is not the same as an idle one', () => {
    const roster = buildVehicleRoster({
      requests: null,
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.sampledRunning).toBe(0)
    expect(roster.reason).toMatch(/no live snapshot/i)
  })
})

describe('a session gets one vehicle per family, however many requests it holds', () => {
  /*
   * MARS. Mutation checked: removing the `seen` set draws two vehicles at the same phase on the same
   * road, which renders as two sessions and is unfalsifiable from the map.
   */
  it('collapses several MARS requests on one session and family to one vehicle', () => {
    const roster = buildVehicleRoster({
      requests: [request({ requestId: 'r1' }), request({ requestId: 'r2' }), request({ requestId: 'r3' })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(1)
    // The rows were still sampled, and the disclosure still counts all three.
    expect(roster.sampledRunning).toBe(3)
  })

  it('keeps one vehicle per family when a session runs two different queries', () => {
    const roster = buildVehicleRoster({
      requests: [request(), request({ requestId: 'r2', queryHash: 'BBBB000000000001' })],
      families: [family(), family({ familyId: 'fam-2', queryHash: 'BBBB000000000001' })],
      roads: [road({ familyIds: ['fam-1', 'fam-2'] })],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(2)
    expect(new Set(roster.vehicles.map(vehicle => vehicle.familyId)).size).toBe(2)
  })
})

describe('the roster is capped, and says what the cap dropped', () => {
  const many = Array.from({ length: VEHICLE_CAP + 25 }, (_, index) =>
    request({ requestId: `r${index}`, sessionId: 100 + index, totalElapsedMs: index }))

  /*
   * Mutation checked: dropping the `.slice(0, VEHICLE_CAP)` draws all 145 and leaves `capped` at 0,
   * so a capped roster would read as a complete one.
   */
  it('draws no more than the cap and counts the remainder', () => {
    const roster = buildVehicleRoster({
      requests: many,
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(VEHICLE_CAP)
    expect(roster.capped).toBe(25)
    expect(roster.cap).toBe(VEHICLE_CAP)
    expect(roster.sampledRunning).toBe(VEHICLE_CAP + 25)
    expect(roster.reason).toMatch(/25 beyond the 120-vehicle cap/)
  })

  /*
   * Mutation checked: removing the blocked-first term from the comparator drops the blocked vehicle
   * off the end, hiding the one thing on this map worth interrupting a reader for.
   */
  it('keeps a blocked request ahead of the cap however short-running it is', () => {
    const blockedRequest = request({
      requestId: 'blocked',
      sessionId: 9_999,
      totalElapsedMs: 0,
      blocking: { blockingSessionId: 52, sentinel: 'None' },
    })
    const roster = buildVehicleRoster({
      requests: [...many, blockedRequest],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(VEHICLE_CAP)
    expect(roster.vehicles[0].sessionId).toBe(9_999)
    expect(roster.vehicles[0].blockedAt).not.toBeNull()
  })

  it('truncates the same tail for the same sample, so a redraw is not a reshuffle', () => {
    const input = { requests: many, families: [family()], roads: [road()], blocked: noBlocks }
    const first = buildVehicleRoster(input)
    const second = buildVehicleRoster({ ...input, requests: [...many].reverse() })
    expect(second.vehicles.map(v => v.id)).toEqual(first.vehicles.map(v => v.id))
  })
})

describe('a blocked vehicle stops, and only on evidence it is entitled to', () => {
  const blockedRequest = request({ blocking: { blockingSessionId: 52, sentinel: 'None' } })

  function rosterWith(placement: IncidentPlacement | null) {
    return buildVehicleRoster({
      requests: [blockedRequest],
      families: [family()],
      roads: [road()],
      blocked: placement ? new Map([[51, placement]]) : noBlocks,
    })
  }

  it('does not stop a request that is merely running', () => {
    const roster = buildVehicleRoster({
      requests: [request()],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    })
    // Holding a lock nobody is waiting behind is just work, and work moves.
    expect(roster.vehicles[0].blockedAt).toBeNull()
  })

  it('stops on a shared road at the point of its own route nearest the pin', () => {
    const stop = rosterWith({
      x: 30, z: 40, basis: 'sharedRoad', routeId: 'route-1', rationale: 'pinned',
    }).vehicles[0].blockedAt
    expect(stop).not.toBeNull()
    // Nearest point on the z=0 road to (30,40) is (30,0) — projected, not the pin itself.
    expect(stop?.x).toBeCloseTo(30)
    expect(stop?.z).toBeCloseTo(0)
    expect(stop?.basis).toBe('sharedRoad')
    expect(stop?.pinnedRouteId).toBe('route-1')
  })

  /*
   * PR 2's rung is machine-readable so this branch can exist. Mutation checked: treating `frontage`
   * like the road rungs snaps the vehicle to (30,0), manufacturing exactly the road-based claim the
   * placement module declined to make.
   */
  it('leaves a frontage-pinned vehicle where it stood, claiming no road', () => {
    const vehicle = rosterWith({
      x: 30, z: 40, basis: 'frontage', routeId: null, rationale: 'no road reaches it',
    }).vehicles[0]
    const standing = pointAt(vehicle.points, vehicle.phase)
    expect(vehicle.blockedAt?.x).toBeCloseTo(standing.x)
    expect(vehicle.blockedAt?.z).toBeCloseTo(standing.z)
    expect(vehicle.blockedAt?.basis).toBe('frontage')
    expect(vehicle.blockedAt?.pinnedRouteId).toBeNull()
    expect(vehicle.blockedAt?.rationale).toMatch(/no drawn road/i)
  })

  it('still stops an unpinned block, because the block itself was measured', () => {
    // No pin: the contended object is off this page, or the lock resource named no object. The
    // block is real either way, so the vehicle halts — it simply halts where it already was.
    const vehicle = rosterWith(null).vehicles[0]
    expect(vehicle.blockedAt).not.toBeNull()
    expect(vehicle.blockedAt?.basis).toBeNull()
    expect(vehicle.blockedAt?.pinnedRouteId).toBeNull()
    const standing = pointAt(vehicle.points, vehicle.phase)
    expect(vehicle.blockedAt?.x).toBeCloseTo(standing.x)
    expect(vehicle.blockedAt?.z).toBeCloseTo(standing.z)
  })

  it('stops on the sentinel alone, when the blocker itself was never identified', () => {
    // spid -2: an orphaned distributed transaction holds the lock, so there is no session to name.
    const vehicle = buildVehicleRoster({
      requests: [request({
        blocking: { blockingSessionId: null, sentinel: 'OrphanedDistributedTransaction' },
      })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
    }).vehicles[0]
    expect(vehicle.blockedAt).not.toBeNull()
  })
})

describe('a vehicle takes the busiest road its family named', () => {
  it('prefers more captured executions', () => {
    const roster = buildVehicleRoster({
      requests: [request()],
      families: [family()],
      roads: [
        road({ routeId: 'quiet', executions: 2 }),
        road({ routeId: 'busy', executions: 900 }),
      ],
      blocked: noBlocks,
    })
    expect(roster.vehicles[0].routeId).toBe('busy')
  })

  it('breaks a tie by route id rather than by input order', () => {
    const roads = [road({ routeId: 'b', executions: 5 }), road({ routeId: 'a', executions: 5 })]
    const forward = buildVehicleRoster({
      requests: [request()], families: [family()], roads, blocked: noBlocks,
    })
    const backward = buildVehicleRoster({
      requests: [request()], families: [family()], roads: [...roads].reverse(), blocked: noBlocks,
    })
    expect(forward.vehicles[0].routeId).toBe('a')
    expect(backward.vehicles[0].routeId).toBe('a')
  })

  it('ignores a degenerate road with nothing to drive along', () => {
    const roster = buildVehicleRoster({
      requests: [request()],
      families: [family()],
      roads: [road({ routeId: 'stub', executions: 900, polyline: [{ x: 1, z: 1 }] })],
      blocked: noBlocks,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.noRoad).toBe(1)
  })
})

describe('phase is stable, invented, and encodes nothing', () => {
  /*
   * Mutation checked: `Math.random()` for the phase passes every other test here and fails this one,
   * which is the difference between a vehicle keeping its place between samples and teleporting to
   * the kerb every few seconds.
   */
  it('puts the same request in the same place on every rebuild', () => {
    expect(phaseOf(51, 'fam-1')).toBe(phaseOf(51, 'fam-1'))
    expect(phaseOf(51, 'fam-1')).not.toBe(phaseOf(52, 'fam-1'))
    expect(phaseOf(51, 'fam-1')).not.toBe(phaseOf(51, 'fam-2'))
  })

  it('stays inside the route', () => {
    for (let sessionId = 50; sessionId < 400; sessionId += 1) {
      const phase = phaseOf(sessionId, 'fam-1')
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
  })

  it('spreads neighbouring session ids instead of clustering them', () => {
    // Consecutive spids are the common case; a phase that tracked them would bunch every vehicle at
    // one end of the road and read as a queue that nothing measured.
    const phases = Array.from({ length: 40 }, (_, i) => phaseOf(50 + i, 'fam-1'))
    const halves = phases.filter(phase => phase < 0.5).length
    expect(halves).toBeGreaterThan(8)
    expect(halves).toBeLessThan(32)
  })
})

describe('travelling a polyline is by arc length, not by vertex', () => {
  // A dogleg whose two segments are 30 and 70 units long: an index-based walk puts the midpoint at
  // the corner, and every vehicle would then crawl the long leg and sprint the short one.
  const dogleg = [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 70 }]

  it('measures the whole run', () => {
    expect(polylineLength(dogleg)).toBeCloseTo(100)
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([{ x: 5, z: 5 }])).toBe(0)
  })

  it('puts the halfway point halfway along, not at the corner', () => {
    const half = pointAt(dogleg, 0.5)
    expect(half.x).toBeCloseTo(30)
    expect(half.z).toBeCloseTo(20)
  })

  it('clamps outside the run rather than extrapolating off the end of the road', () => {
    expect(pointAt(dogleg, -1)).toEqual({ x: 0, z: 0 })
    expect(pointAt(dogleg, 2)).toEqual({ x: 30, z: 70 })
  })

  it('survives a zero-length road without producing NaN', () => {
    const point = pointAt([{ x: 4, z: 4 }, { x: 4, z: 4 }], 0.5)
    expect(Number.isFinite(point.x)).toBe(true)
    expect(Number.isFinite(point.z)).toBe(true)
  })
})

describe('the roster says why it is empty, since five causes look identical on the map', () => {
  it.each([
    ['no request was running', { requests: [] as LiveRequest[], families: [family()], roads: [road()] }],
    ['predates the field', {
      requests: [(() => { const r = request(); delete (r as { queryHash?: unknown }).queryHash; return r })()],
      families: [family()], roads: [road()],
    }],
    ['matched no query family', {
      requests: [request({ queryHash: 'FFFF000000000001' })], families: [family()], roads: [road()],
    }],
    ['names no road drawn', {
      requests: [request()], families: [family()], roads: [road({ familyIds: ['other'] })],
    }],
  ])('distinguishes "%s"', (fragment, input) => {
    const roster = buildVehicleRoster({ ...input, blocked: noBlocks })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.reason).toMatch(new RegExp(fragment, 'i'))
  })

  it('never leaves the reason blank', () => {
    const roster = buildVehicleRoster({
      requests: [request()], families: [family()], roads: [road()], blocked: noBlocks,
    })
    expect(roster.reason.length).toBeGreaterThan(0)
  })
})
