import { describe, expect, it } from 'vitest'
import {
  buildVehicleRoster,
  normalizeHash,
  parseBytes,
  phaseOf,
  pointAt,
  polylineLength,
  travelledFraction,
  vehicleClass,
  vehicleSummaryLabel,
  CAR_FLOOR_BYTES,
  SEMI_FLOOR_BYTES,
  VAN_FLOOR_BYTES,
  VEHICLE_CAP,
  VEHICLE_LAUNCH_STAGGER_SECONDS,
  VEHICLE_RETIRE_SECONDS,
  VEHICLE_SPEED,
  type VehicleRoad,
} from './cityVehicles'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveQueryEvent } from './liveQueryFeed'
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

/** A fixed observation instant, so every age in this file is arithmetic rather than a real clock. */
const NOW = 1_700_000_000_000

/**
 * One observed execution, as the live feed would hand it over.
 *
 * `queryHash` arrives already normalized, because the feed normalizes it — the roster looks the
 * event's hash up verbatim and normalizes only the *family* side. Hash-format drift on the request
 * side is therefore the feed's test, not this one.
 */
function event(over: Partial<LiveQueryEvent> = {}): LiveQueryEvent {
  return {
    id: '51|req:51:0|2024-01-01T00:00:00Z',
    source: 'sampled-request',
    executions: 1,
    executionsEstimated: false,
    ordinal: 1,
    sessionId: 51,
    requestId: 'req:51:0',
    startedAt: '2024-01-01T00:00:00Z',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    endedAt: null,
    databaseName: null,
    command: 'SELECT',
    text: null,
    textReason: 'The sample returned no statement text.',
    queryHash: 'AABBCCDDEEFF0011',
    familyId: null,
    hashReported: true,
    blocked: false,
    waitType: null,
    elapsedMs: 100,
    cpuMs: null,
    ...over,
  }
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
      events: [event()],
      families: [family({ planDataVolume: volume('1000') })],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(1)
    expect(roster.vehicles[0].routeId).toBe('route-1')
    expect(roster.vehicles[0].class).toBe('bike')
    expect(roster.observedExecutions).toBe(1)
    expect(roster.unmatchedHash).toBe(0)
  })

  /*
   * Mutation checked: falling back to `families[0]` when the hash misses draws a vehicle here and
   * drops `unmatchedHash` to 0 — the exact "invent a family" failure the module forbids.
   */
  it('counts an unmatched hash instead of inventing a family for it', () => {
    const roster = buildVehicleRoster({
      events: [event({ queryHash: '00FF00FF00FF00FF' })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.unmatchedHash).toBe(1)
    expect(roster.observedExecutions).toBe(1)
    expect(roster.reason).toMatch(/matched no query family/i)
  })

  it('counts a matched family that names no drawn road, separately from an unmatched hash', () => {
    const roster = buildVehicleRoster({
      events: [event()],
      families: [family()],
      roads: [road({ familyIds: ['fam-other'] })],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.noRoad).toBe(1)
    expect(roster.unmatchedHash).toBe(0)
  })

  it('normalizes the family side of the join, so a rendering difference cannot empty the roads', () => {
    const roster = buildVehicleRoster({
      events: [event()],
      families: [family({ queryHash: '0xaabbccddeeff0011' })],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(1)
    expect(normalizeHash('0xaabb')).toBe(normalizeHash('AABB'))
    expect(normalizeHash('AABB')).not.toBe(normalizeHash('AABC'))
  })

  it('rejects the all-zero sentinel rather than making it a family everyone shares', () => {
    expect(normalizeHash('0000000000000000')).toBeNull()
    const roster = buildVehicleRoster({
      // The feed normalizes the sentinel to null before the roster ever sees it; a family that
      // rendered it verbatim must still not become the family every unhashed request matches.
      events: [event({ queryHash: null })],
      families: [family({ queryHash: '0000000000000000' })],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.unmatchedHash).toBe(1)
  })

  /*
   * The feed resolves a family once, and the roster honours that answer.
   *
   * Mutation checked: re-deriving the family from the hash and ignoring `familyId` puts the vehicle
   * on the *other* family's road, so the scrolling list and the map would name different queries for
   * one execution — the caption disagreeing with the picture.
   */
  it('uses the family the feed already resolved rather than re-deriving one', () => {
    const roster = buildVehicleRoster({
      events: [event({ familyId: 'fam-2', queryHash: 'AABBCCDDEEFF0011' })],
      families: [family(), family({ familyId: 'fam-2', queryHash: 'BBBB000000000001' })],
      roads: [road({ routeId: 'one' }), road({ routeId: 'two', familyIds: ['fam-2'] })],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(1)
    expect(roster.vehicles[0].familyId).toBe('fam-2')
    expect(roster.vehicles[0].routeId).toBe('two')
  })
})

describe('a vehicle is released when its execution arrives in the feed', () => {
  function rosterAt(ageMs: number, over: Partial<LiveQueryEvent> = {}) {
    return buildVehicleRoster({
      events: [event({ firstSeenAt: NOW - ageMs, ...over })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
  }

  /*
   * The whole point of the rewrite, and the thing a hashed phase offset used to get wrong.
   *
   * Mutation checked: restoring `elapsedSeconds = phaseOf(...) * something` — a position that does
   * not depend on the arrival time at all — passes every other test in this file and fails these
   * two, which is the difference between "a car sets off when its query turns up" and "a car is
   * standing somewhere arbitrary on a road for reasons nobody can see".
   */
  it('starts a just-arrived execution at the kerb rather than part way down the road', () => {
    const vehicle = rosterAt(0).vehicles[0]
    expect(vehicle.elapsedSeconds).toBe(0)
    const at = pointAt(vehicle.points, travelledFraction(vehicle.points, vehicle.elapsedSeconds, null))
    expect(at.x).toBeCloseTo(0)
  })

  it('advances a vehicle in proportion to how long its execution has been in the feed', () => {
    const early = rosterAt(2_000).vehicles[0]
    const later = rosterAt(4_000).vehicles[0]
    expect(later.elapsedSeconds).toBeGreaterThan(early.elapsedSeconds)
    expect(later.elapsedSeconds - early.elapsedSeconds).toBeCloseTo(2, 5)
  })

  /*
   * Mutation checked: dropping the stagger puts two executions that arrived in the same sample at
   * exactly the same point of the same road, where they draw as one vehicle and the reader is shown
   * one query instead of two.
   */
  it('staggers two executions that arrived in the same sample, by a bounded invented delay', () => {
    const roster = buildVehicleRoster({
      events: [
        event({ id: 'a', ordinal: 1, sessionId: 51, firstSeenAt: NOW - 5_000 }),
        event({ id: 'b', ordinal: 2, sessionId: 52, firstSeenAt: NOW - 5_000 }),
      ],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    const [first, second] = roster.vehicles
    expect(first.elapsedSeconds).not.toBe(second.elapsedSeconds)
    expect(Math.abs(first.elapsedSeconds - second.elapsedSeconds))
      .toBeLessThanOrEqual(VEHICLE_LAUNCH_STAGGER_SECONDS)
  })

  it('never gives a vehicle a negative head start, however the stagger falls', () => {
    for (let session = 50; session < 200; session += 1) {
      const vehicle = rosterAt(0, { id: `s${session}`, sessionId: session }).vehicles[0]
      expect(vehicle.elapsedSeconds, `session ${session}`).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('a vehicle whose execution has gone finishes its road and leaves', () => {
  /**
   * How long this road takes to drive end to end, at whatever `VEHICLE_SPEED` currently is.
   *
   * Derived rather than a fixed 1,000 units, because every scenario below is really about *when* a
   * car is on its road and not about how long the road is. A literal length silently couples them:
   * doubling the speed once already turned "20 seconds in, query left 10 seconds ago" from a car two
   * thirds of the way round its first lap into a car that had finished and retired, so
   * `vehicles[0]` was `undefined` and the guard failed on a property of nothing.
   */
  const LONG_ROAD_SECONDS = 30
  /** A road long enough that a car takes a while to cross it, so laps are observable. */
  const longRoad = road({ polyline: [{ x: 0, z: 0 }, { x: VEHICLE_SPEED * LONG_ROAD_SECONDS, z: 0 }] })

  function rosterAt(firstSeenAgoMs: number, endedAgoMs: number | null) {
    return buildVehicleRoster({
      events: [event({
        firstSeenAt: NOW - firstSeenAgoMs,
        endedAt: endedAgoMs === null ? null : NOW - endedAgoMs,
      })],
      families: [family()],
      roads: [longRoad],
      blocked: noBlocks,
      now: NOW,
    })
  }

  it('keeps driving a still-sampled execution', () => {
    const vehicle = rosterAt(5_000, null).vehicles[0]
    expect(vehicle.finishedAfterSeconds).toBeNull()
  })

  it('records where a departed execution was when it left, rather than a bare flag', () => {
    // 20s in, gone at 10s. Both numbers survive so the car can carry on from where it was.
    const vehicle = rosterAt(20_000, 10_000).vehicles[0]
    expect(vehicle.finishedAfterSeconds).not.toBeNull()
    expect(vehicle.finishedAfterSeconds!).toBeLessThan(vehicle.elapsedSeconds)
    expect(vehicle.elapsedSeconds - vehicle.finishedAfterSeconds!).toBeCloseTo(10, 5)
  })

  /*
   * Mutation checked: clamping a departed car with `Math.min(1, travelled)` instead of subtracting
   * the laps it had already done teleports a car that was half way round its third lap to the end of
   * the road at the instant its query left the sample.
   */
  it('finishes the lap it was on instead of jumping to the end of the road', () => {
    const length = polylineLength(longRoad.polyline)
    // Long enough to be part way through a later lap when it ends.
    const ranFor = (length * 2.5) / VEHICLE_SPEED
    const vehicle = buildVehicleRoster({
      events: [event({ firstSeenAt: NOW - ranFor * 1_000, endedAt: NOW })],
      families: [family()],
      roads: [longRoad],
      blocked: noBlocks,
      now: NOW,
    }).vehicles[0]
    const stillRunning = travelledFraction(vehicle.points, vehicle.elapsedSeconds, null)
    const departed = travelledFraction(vehicle.points, vehicle.elapsedSeconds, vehicle.finishedAfterSeconds)
    expect(departed).toBeCloseTo(stillRunning, 5)
    expect(departed).toBeLessThan(1)
  })

  /*
   * Mutation checked: never retiring a finished car leaves it parked at the end of its road forever,
   * so a page left open overnight fills the city with traffic that stopped hours ago.
   */
  it('retires a car once it has reached the end of its road', () => {
    const length = polylineLength(longRoad.polyline)
    const wellPast = ((length / VEHICLE_SPEED) + 30) * 1_000
    const roster = buildVehicleRoster({
      events: [event({ firstSeenAt: NOW - wellPast, endedAt: NOW - wellPast + 1 })],
      families: [family()],
      roads: [longRoad],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.retired).toBe(1)
    expect(roster.reason).toMatch(/not that it succeeded/i)
  })

  /*
   * The backstop, for the case where no further sample will ever arrive to retire it.
   *
   * Mutation checked: dropping the deadline leaves a car crawling a very long road indefinitely
   * after the live channel has dropped, which reads as current traffic on a connection that is dead.
   */
  it('retires a long-overdue car even if it has not reached the end', () => {
    const endless = road({ polyline: [{ x: 0, z: 0 }, { x: 1_000_000, z: 0 }] })
    const roster = buildVehicleRoster({
      events: [event({
        firstSeenAt: NOW - (VEHICLE_RETIRE_SECONDS + 5) * 1_000,
        endedAt: NOW - (VEHICLE_RETIRE_SECONDS + 1) * 1_000,
      })],
      families: [family()],
      roads: [endless],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.retired).toBe(1)
  })
})

describe('a completed execution drives one trip, not laps forever', () => {
  const LONG_ROAD_SECONDS = 30
  const longRoad = road({ polyline: [{ x: 0, z: 0 }, { x: VEHICLE_SPEED * LONG_ROAD_SECONDS, z: 0 }] })

  function planCacheRoster(firstSeenAgoMs: number) {
    return buildVehicleRoster({
      // `endedAt` stays null on purpose: nothing was observed leaving, so the *list* has no departure
      // to show. The car still has a finite trip, which is what these guards are about.
      events: [event({ source: 'plan-cache', sessionId: null, requestId: null, firstSeenAt: NOW - firstSeenAgoMs, endedAt: null })],
      families: [family()],
      roads: [longRoad],
      blocked: noBlocks,
      now: NOW,
    })
  }

  /*
   * Mutation checked: reading `endedAt === null` literally for a plan-cache row gives
   * `finishedAfterSeconds === null`, which is the "still running" case -- so this reports null and
   * the car laps its road forever.
   */
  it('treats a row that was already finished on arrival as finished at zero', () => {
    const vehicle = planCacheRoster(5_000).vehicles[0]
    expect(vehicle.finishedAfterSeconds).toBe(0)
  })

  /*
   * The visible symptom of the same mutation. `travelledFraction` wraps an unfinished car with
   * `travelled % 1`, so a completed execution would re-cross its road indefinitely and read as a
   * query that is still going long after it finished.
   */
  it('does not lap the road once it has crossed it', () => {
    const vehicle = planCacheRoster((LONG_ROAD_SECONDS + 5) * 1_000).vehicles[0]
    expect(vehicle).toBeUndefined()
  })

  /*
   * Mutation checked: without a finite trip these never retire, because the feed deliberately never
   * marks a plan-cache row as departed. A page left open then accumulates every execution it has
   * ever heard about, up to the roster cap, all of them driving.
   */
  it('retires once it reaches the end of its road', () => {
    const roster = planCacheRoster((LONG_ROAD_SECONDS + 5) * 1_000)
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.retired).toBe(1)
  })

  /** Still driving part way along, so the retirement above is a finite trip and not a car that never launched. */
  it('is on the road before it gets there', () => {
    const roster = planCacheRoster((LONG_ROAD_SECONDS / 2) * 1_000)
    expect(roster.vehicles).toHaveLength(1)
    const vehicle = roster.vehicles[0]
    const fraction = travelledFraction(vehicle.points, vehicle.elapsedSeconds, vehicle.finishedAfterSeconds)
    expect(fraction).toBeGreaterThan(0)
    expect(fraction).toBeLessThan(1)
  })

  /*
   * The backstop must not key off `endedAt`, which is null here forever.
   *
   * Mutation checked: `event.endedAt !== null && ...` makes `overdue` unreachable for a plan-cache
   * row, so a car on a road too long to finish sits there after the live channel has dropped.
   */
  it('retires a long-overdue car on a road it could never finish', () => {
    const endless = road({ polyline: [{ x: 0, z: 0 }, { x: 1_000_000_000, z: 0 }] })
    const roster = buildVehicleRoster({
      events: [event({
        source: 'plan-cache',
        sessionId: null,
        requestId: null,
        firstSeenAt: NOW - (VEHICLE_RETIRE_SECONDS + 5) * 1_000,
        endedAt: null,
      })],
      families: [family()],
      roads: [endless],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.retired).toBe(1)
  })

  /** A sampled request that is genuinely still running keeps lapping; the change above is not global. */
  it('leaves a still-running sampled request lapping', () => {
    const vehicle = buildVehicleRoster({
      events: [event({ source: 'sampled-request', firstSeenAt: NOW - 5_000, endedAt: null })],
      families: [family()],
      roads: [longRoad],
      blocked: noBlocks,
      now: NOW,
    }).vehicles[0]
    expect(vehicle.finishedAfterSeconds).toBeNull()
  })
})

describe('every observed execution gets its own vehicle', () => {
  /*
   * The old roster collapsed a session's concurrent requests into one vehicle, because they all sat
   * at the same hashed phase and would have overlapped. Arrival time separates them instead, so each
   * execution is drawn — which is what a feed of executions has to mean.
   */
  it('draws two executions of the same family on one session as two vehicles', () => {
    const roster = buildVehicleRoster({
      events: [
        event({ id: 'a', ordinal: 1, firstSeenAt: NOW - 6_000 }),
        event({ id: 'b', ordinal: 2, firstSeenAt: NOW - 2_000 }),
      ],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(2)
    expect(new Set(roster.vehicles.map(vehicle => vehicle.id)).size).toBe(2)
    // Different arrivals, so they are at different points of the road rather than stacked.
    expect(roster.vehicles[0].elapsedSeconds).not.toBe(roster.vehicles[1].elapsedSeconds)
  })

  it('keeps one vehicle per family when a session runs two different queries', () => {
    const roster = buildVehicleRoster({
      events: [
        event({ id: 'a', ordinal: 1 }),
        event({ id: 'b', ordinal: 2, queryHash: 'BBBB000000000001' }),
      ],
      families: [family(), family({ familyId: 'fam-2', queryHash: 'BBBB000000000001' })],
      roads: [road({ familyIds: ['fam-1', 'fam-2'] })],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(2)
    expect(new Set(roster.vehicles.map(vehicle => vehicle.familyId)).size).toBe(2)
  })

  it('says so when no observed execution carried a query hash at all', () => {
    // An API build older than the field. Indistinguishable from a quiet server unless disclosed.
    const roster = buildVehicleRoster({
      events: [event({ hashReported: false, queryHash: null })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.hashReported).toBe(false)
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.reason).toMatch(/predates the field/i)
    expect(vehicleSummaryLabel(roster)).toBe('Not matchable')
  })

  it('distinguishes an old API from an engine that reported no hash', () => {
    const roster = buildVehicleRoster({
      events: [event({ hashReported: true, queryHash: null })],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    // The field was present and null, so the API is current — the engine simply did not hash it.
    expect(roster.hashReported).toBe(true)
    expect(roster.unmatchedHash).toBe(1)
    expect(roster.reason).not.toMatch(/predates the field/i)
  })

  it('returns the empty roster when no snapshot has arrived, which is not the same as an idle one', () => {
    const roster = buildVehicleRoster({
      events: null,
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.observedExecutions).toBe(0)
    expect(roster.reason).toMatch(/no live snapshot/i)
  })
})

describe('the roster is capped, and says what the cap dropped', () => {
  const many = Array.from({ length: VEHICLE_CAP + 25 }, (_, index) =>
    event({ id: `e${index}`, ordinal: index + 1, sessionId: 100 + index, firstSeenAt: NOW - index * 10 }))

  /*
   * Mutation checked: dropping the `.slice(0, VEHICLE_CAP)` draws all 145 and leaves `capped` at 0,
   * so a capped roster would read as a complete one.
   */
  it('draws no more than the cap and counts the remainder', () => {
    const roster = buildVehicleRoster({
      events: many,
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(VEHICLE_CAP)
    expect(roster.capped).toBe(25)
    expect(roster.cap).toBe(VEHICLE_CAP)
    expect(roster.observedExecutions).toBe(VEHICLE_CAP + 25)
    expect(roster.reason).toMatch(/25 beyond the 120-vehicle cap/)
  })

  /*
   * Mutation checked: sorting by ordinal *ascending* drops the newest arrivals, which are precisely
   * the ones the reader just watched appear in the list beside the map.
   */
  it('drops the oldest arrivals rather than the newest', () => {
    const roster = buildVehicleRoster({
      events: many,
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    const ordinals = roster.vehicles.map(vehicle => vehicle.ordinal)
    expect(Math.max(...ordinals)).toBe(VEHICLE_CAP + 25)
    expect(Math.min(...ordinals)).toBe(26)
  })

  /*
   * Mutation checked: removing the blocked-first term from the comparator drops the blocked vehicle
   * off the end, hiding the one thing on this map worth interrupting a reader for.
   */
  it('keeps a blocked execution ahead of the cap however recently it arrived', () => {
    const blockedEvent = event({
      id: 'blocked',
      ordinal: 0,
      sessionId: 9_999,
      firstSeenAt: NOW - 60_000,
      blocked: true,
    })
    const roster = buildVehicleRoster({
      events: [...many, blockedEvent],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(VEHICLE_CAP)
    expect(roster.vehicles[0].sessionId).toBe(9_999)
    expect(roster.vehicles[0].blockedAt).not.toBeNull()
  })

  it('truncates the same tail for the same sample, so a redraw is not a reshuffle', () => {
    const input = { events: many, families: [family()], roads: [road()], blocked: noBlocks, now: NOW }
    const first = buildVehicleRoster(input)
    const second = buildVehicleRoster({ ...input, events: [...many].reverse() })
    expect(second.vehicles.map(v => v.id)).toEqual(first.vehicles.map(v => v.id))
  })
})

describe('a blocked vehicle stops, and only on evidence it is entitled to', () => {
  // Aged, so "where it would have been standing" is a real point down the road rather than the kerb.
  const blockedEvent = event({ blocked: true, firstSeenAt: NOW - 3_000 })

  function rosterWith(placement: IncidentPlacement | null) {
    return buildVehicleRoster({
      events: [blockedEvent],
      families: [family()],
      roads: [road()],
      blocked: placement ? new Map([[51, placement]]) : noBlocks,
      now: NOW,
    })
  }

  /** Where a vehicle would be if nothing had stopped it — the roster's own arithmetic, replayed. */
  function standingPoint(vehicle: { points: readonly { x: number; z: number }[]; elapsedSeconds: number; finishedAfterSeconds: number | null }) {
    return pointAt(
      vehicle.points,
      travelledFraction(vehicle.points, vehicle.elapsedSeconds, vehicle.finishedAfterSeconds),
    )
  }

  it('does not stop an execution that is merely running', () => {
    const roster = buildVehicleRoster({
      events: [event()],
      families: [family()],
      roads: [road()],
      blocked: noBlocks,
      now: NOW,
    })
    // Holding a lock nobody is waiting behind is just work, and work moves.
    expect(roster.vehicles[0].blockedAt).toBeNull()
  })

  /*
   * Mutation checked: keeping a departed execution frozen at its block leaves a car parked at a
   * contention that is over, and it never reaches the end of its road to be retired — so the map
   * accumulates permanent monuments to blocks that finished.
   */
  it('releases a vehicle whose blocked execution has left the sample', () => {
    const roster = buildVehicleRoster({
      events: [event({ blocked: true, firstSeenAt: NOW - 3_000, endedAt: NOW - 1_000 })],
      families: [family()],
      // Long enough that three seconds of travel is under one lap at any speed, so this stays a test
      // about releasing a block rather than an accident of how fast the default 100-unit road is
      // lapped. At 82 units/second a car covers that road two and a half times in three seconds and
      // retires, which is why the assertion below started reading a property of `undefined`.
      roads: [road({ polyline: [{ x: 0, z: 0 }, { x: VEHICLE_SPEED * 4, z: 0 }] })],
      blocked: new Map([[51, { x: 30, z: 40, basis: 'sharedRoad', routeId: 'route-1', rationale: 'pinned' }]]),
      now: NOW,
    })
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
    const standing = standingPoint(vehicle)
    expect(standing.x).toBeGreaterThan(0)
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
    const standing = standingPoint(vehicle)
    expect(vehicle.blockedAt?.x).toBeCloseTo(standing.x)
    expect(vehicle.blockedAt?.z).toBeCloseTo(standing.z)
  })
})

describe('a vehicle takes the busiest road its family named', () => {
  it('prefers more captured executions', () => {
    const roster = buildVehicleRoster({
      events: [event()],
      families: [family()],
      roads: [
        road({ routeId: 'quiet', executions: 2 }),
        road({ routeId: 'busy', executions: 900 }),
      ],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles[0].routeId).toBe('busy')
  })

  it('breaks a tie by route id rather than by input order', () => {
    const roads = [road({ routeId: 'b', executions: 5 }), road({ routeId: 'a', executions: 5 })]
    const forward = buildVehicleRoster({
      events: [event()], families: [family()], roads, blocked: noBlocks, now: NOW,
    })
    const backward = buildVehicleRoster({
      events: [event()], families: [family()], roads: [...roads].reverse(), blocked: noBlocks, now: NOW,
    })
    expect(forward.vehicles[0].routeId).toBe('a')
    expect(backward.vehicles[0].routeId).toBe('a')
  })

  it('ignores a degenerate road with nothing to drive along', () => {
    const roster = buildVehicleRoster({
      events: [event()],
      families: [family()],
      roads: [road({ routeId: 'stub', executions: 900, polyline: [{ x: 1, z: 1 }] })],
      blocked: noBlocks,
      now: NOW,
    })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.noRoad).toBe(1)
  })
})

describe('the launch stagger is stable, invented, and encodes nothing', () => {
  /*
   * Mutation checked: `Math.random()` for the stagger passes every other test here and fails this
   * one, which is the difference between a vehicle keeping its place between samples and jittering
   * back and forth along its road every few seconds.
   */
  it('gives the same execution the same delay on every rebuild', () => {
    expect(phaseOf(51, 'fam-1')).toBe(phaseOf(51, 'fam-1'))
    expect(phaseOf(51, 'fam-1')).not.toBe(phaseOf(52, 'fam-1'))
    expect(phaseOf(51, 'fam-1')).not.toBe(phaseOf(51, 'fam-2'))
  })

  it('stays inside its bound, so a departure is never delayed noticeably', () => {
    for (let sessionId = 50; sessionId < 400; sessionId += 1) {
      const phase = phaseOf(sessionId, 'fam-1')
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
    expect(VEHICLE_LAUNCH_STAGGER_SECONDS).toBeLessThan(3)
  })

  it('spreads neighbouring session ids instead of clustering them', () => {
    // Consecutive spids are the common case; a stagger that tracked them would release every vehicle
    // in one burst and undo the separation it exists to provide.
    const phases = Array.from({ length: 40 }, (_, i) => phaseOf(50 + i, 'fam-1'))
    const halves = phases.filter(phase => phase < 0.5).length
    expect(halves).toBeGreaterThan(8)
    expect(halves).toBeLessThan(32)
  })
})

describe('how far along the road a vehicle is', () => {
  /*
   * A road exactly ten seconds long at whatever `VEHICLE_SPEED` happens to be.
   *
   * Derived rather than hard-coded, because none of the assertions below are about how fast a car
   * travels -- they are about lapping, and about a departed car finishing the lap it was on. A
   * literal length made every one of them a second copy of the constant, so raising the speed failed
   * four assertions that had not changed their meaning at all.
   */
  const LAP_SECONDS = 10
  const straight = [{ x: 0, z: 0 }, { x: VEHICLE_SPEED * LAP_SECONDS, z: 0 }]

  it('is elapsed distance over route length while the execution is still sampled', () => {
    expect(travelledFraction(straight, 0, null)).toBeCloseTo(0)
    expect(travelledFraction(straight, LAP_SECONDS / 2, null)).toBeCloseTo(0.5)
    // A car still executing laps rather than stopping, so a whole lap is back at the start.
    expect(travelledFraction(straight, LAP_SECONDS, null)).toBeCloseTo(0)
    expect(travelledFraction(straight, LAP_SECONDS * 1.25, null)).toBeCloseTo(0.25)
  })

  it('completes at most one more lap once the execution has gone', () => {
    // Departed two and a half laps in, so it runs on to the end of that third lap and stops.
    const gone = LAP_SECONDS * 2.5
    expect(travelledFraction(straight, gone, gone)).toBeCloseTo(0.5)
    expect(travelledFraction(straight, gone + LAP_SECONDS * 0.25, gone)).toBeCloseTo(0.75)
    expect(travelledFraction(straight, gone + LAP_SECONDS * 0.5, gone)).toBeCloseTo(1)
    expect(travelledFraction(straight, gone * 12, gone)).toBe(1)
  })

  it('survives a degenerate road and a negative clock without producing NaN', () => {
    expect(travelledFraction([], 5, null)).toBe(0)
    expect(travelledFraction([{ x: 1, z: 1 }], 5, null)).toBe(0)
    expect(travelledFraction(straight, -5, null)).toBe(0)
    expect(Number.isFinite(travelledFraction(straight, 5, -5))).toBe(true)
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

describe('the roster says why it is empty, since six causes look identical on the map', () => {
  it.each([
    ['No request has been running', { events: [] as LiveQueryEvent[], families: [family()], roads: [road()] }],
    ['predates the field', {
      events: [event({ hashReported: false, queryHash: null })],
      families: [family()], roads: [road()],
    }],
    ['matched no query family', {
      events: [event({ queryHash: 'FFFF000000000001' })], families: [family()], roads: [road()],
    }],
    ['names no road drawn', {
      events: [event()], families: [family()], roads: [road({ familyIds: ['other'] })],
    }],
  ])('distinguishes "%s"', (fragment, input) => {
    const roster = buildVehicleRoster({ ...input, blocked: noBlocks, now: NOW })
    expect(roster.vehicles).toHaveLength(0)
    expect(roster.reason).toMatch(new RegExp(fragment, 'i'))
  })

  /*
   * The distinction the feed made necessary. "Nothing running" and "everything that was running has
   * since finished its road" are the same empty map, and only one of them means a quiet instance.
   */
  it('distinguishes an idle instance from one whose traffic has all arrived and left', () => {
    const idle = buildVehicleRoster({
      events: [], families: [family()], roads: [road()], blocked: noBlocks, now: NOW,
    })
    const finished = buildVehicleRoster({
      events: [event({ firstSeenAt: NOW - 120_000, endedAt: NOW - 119_000 })],
      families: [family()], roads: [road()], blocked: noBlocks, now: NOW,
    })
    expect(idle.vehicles).toHaveLength(0)
    expect(finished.vehicles).toHaveLength(0)
    expect(idle.reason).not.toBe(finished.reason)
    expect(finished.reason).toMatch(/left the map/i)
  })

  it('never leaves the reason blank', () => {
    const roster = buildVehicleRoster({
      events: [event()], families: [family()], roads: [road()], blocked: noBlocks, now: NOW,
    })
    expect(roster.reason.length).toBeGreaterThan(0)
  })
})