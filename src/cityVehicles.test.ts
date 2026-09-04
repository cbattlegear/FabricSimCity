import { describe, expect, it } from 'vitest'
import {
  buildVehicleRoster,
  vehicleCount,
  vehicleSpeedScale,
  vehiclePaintHue,
  pointAt,
  polylineLength,
  travelledFraction,
  vehicleSummaryLabel,
  EMPTY_ROSTER,
  VEHICLE_CAP,
  VEHICLES_PER_ROAD_CAP,
  type VehicleRoad,
  type VehicleRoster,
} from './cityVehicles'
import type { IncidentPlacement, IncidentPlacementBasis } from './cityIncidentPlacement'

/**
 * The vehicles are aggregate traffic on Fabric, not live executions, and every rule below exists
 * because the alternative makes the map claim something nobody measured — most of all the first
 * one: an unmeasured road drawn with traffic on it is motion a reader reads as evidence.
 */

const STRAIGHT = [{ x: 0, z: 0 }, { x: 1000, z: 0 }]

function road(over: Partial<VehicleRoad> = {}): VehicleRoad {
  return {
    routeId: 'r1',
    fromItemId: 'a',
    toItemId: 'b',
    familyIds: ['fam-1'],
    operations: 1000,
    carOperations: 1000,
    freightOperations: 0,
    delayPerOperation: 0.1,
    polyline: STRAIGHT,
    ...over,
  }
}

const NO_BLOCKS: ReadonlyMap<string, IncidentPlacement> = new Map()

function placement(over: Partial<IncidentPlacement> = {}): IncidentPlacement {
  return {
    x: 500,
    z: 0,
    basis: 'sharedRoad' as IncidentPlacementBasis,
    routeId: 'r1',
    rationale: 'test',
    ...over,
  }
}

function roster(roads: VehicleRoad[], blocked: ReadonlyMap<string, IncidentPlacement> = NO_BLOCKS): VehicleRoster {
  return buildVehicleRoster({ roads, blocked })
}

describe('never draw a guess: an unmeasured road gets no vehicles', () => {
  it('draws nothing on a road with no measured operations', () => {
    const built = roster([road({ operations: null, carOperations: null, freightOperations: null })])
    expect(built.vehicles).toHaveLength(0)
    expect(built.unmeasuredRoads).toBe(1)
    expect(built.measuredRoads).toBe(0)
  })

  it('draws nothing on a null-operations road even if a class count leaked through', () => {
    // `operations === null` is the gate, full stop: a road the map measured nothing about gets no
    // vehicles no matter what a stray class field says. This is the case that binds the guard —
    // removing the null check would emit cars here.
    const built = roster([road({ operations: null, carOperations: 100, freightOperations: 100 })])
    expect(built.vehicles).toHaveLength(0)
    expect(built.unmeasuredRoads).toBe(1)
  })

  it('distinguishes an unmeasured road from a measured-quiet one', () => {
    const quiet = roster([road({ operations: 0, carOperations: 0, freightOperations: 0 })])
    expect(quiet.vehicles).toHaveLength(0)
    // A measured zero is a genuinely quiet street — counted apart from an unmeasured one.
    expect(quiet.measuredRoads).toBe(1)
    expect(quiet.quietRoads).toBe(1)
    expect(quiet.unmeasuredRoads).toBe(0)
  })

  it('says so in the reason rather than reading as an idle capacity', () => {
    const unmeasured = roster([road({ operations: null, carOperations: null, freightOperations: null })])
    expect(unmeasured.reason).toMatch(/measured operation count|gap in evidence/i)
    const quiet = roster([road({ operations: 0, carOperations: 0, freightOperations: 0 })])
    expect(quiet.reason).toMatch(/quiet/i)
  })
})

describe('class is the operation class, never an invented size', () => {
  it('draws interactive operations as cars and background as freight', () => {
    const built = roster([road({ operations: 200, carOperations: 100, freightOperations: 100 })])
    const classes = new Set(built.vehicles.map(v => v.class))
    expect(classes.has('car')).toBe(true)
    expect(classes.has('semiTruck')).toBe(true)
    expect(built.cars).toBeGreaterThan(0)
    expect(built.freight).toBeGreaterThan(0)
  })

  it('draws operations of an unnamed class as the unknown shell, never rounded onto car or freight', () => {
    const built = roster([road({ operations: 1000, carOperations: null, freightOperations: null })])
    expect(built.vehicles.length).toBeGreaterThan(0)
    expect(built.vehicles.every(v => v.class === 'unknown')).toBe(true)
    expect(built.unknown).toBeGreaterThan(0)
  })

  it('never produces a bicycle or a van, because Fabric publishes no per-operation size', () => {
    const built = roster([road({ operations: 1000, carOperations: 500, freightOperations: 500 })])
    for (const vehicle of built.vehicles) {
      expect(['car', 'semiTruck', 'unknown']).toContain(vehicle.class)
    }
  })
})

describe('how many vehicles a road contributes', () => {
  it('is zero for a measured zero and grows with the logarithm otherwise', () => {
    expect(vehicleCount(0)).toBe(0)
    expect(vehicleCount(null)).toBe(0)
    expect(vehicleCount(1)).toBe(1)
    expect(vehicleCount(100)).toBe(2)
    expect(vehicleCount(1000)).toBe(3)
  })

  it('is capped so one hot road cannot spend the whole city budget', () => {
    expect(vehicleCount(1e12)).toBeLessThanOrEqual(VEHICLES_PER_ROAD_CAP)
  })
})

describe('speed is graded off the same throttling ratio the road colour is', () => {
  it('drives a congested road slower than a free one, and an unmeasured one at the base', () => {
    const congested = roster([road({ routeId: 'c', delayPerOperation: 10 })]).vehicles[0]
    const free = roster([road({ routeId: 'f', delayPerOperation: 0.01 })]).vehicles[0]
    const unmeasured = roster([road({ routeId: 'u', delayPerOperation: null })]).vehicles[0]
    expect(free.speedScale).toBeGreaterThan(congested.speedScale)
    expect(unmeasured.speedScale).toBe(1)
  })

  it('makes no speed claim for a missing ratio', () => {
    expect(vehicleSpeedScale(null)).toBe(1)
    expect(vehicleSpeedScale(Number.NaN)).toBe(1)
  })
})

describe('rejections stop traffic where the pin is', () => {
  it('halts vehicles on a road a rejection pinned, at the point nearest the pin', () => {
    const blocked = new Map([['b', placement({ basis: 'sharedRoad', routeId: 'r1' })]])
    const built = roster([road({ operations: 100, carOperations: 100, freightOperations: 0 })], blocked)
    expect(built.vehicles.length).toBeGreaterThan(0)
    expect(built.vehicles.every(v => v.blockedAt !== null)).toBe(true)
    expect(built.blocked).toBe(built.vehicles.length)
    // The pin sits at x=500 on the straight road, so the halt lands there.
    expect(built.vehicles[0].blockedAt!.x).toBeCloseTo(500, 3)
  })

  it('leaves traffic flowing on a road no rejection pinned', () => {
    const blocked = new Map([['other', placement({ routeId: 'someOtherRoute' })]])
    const built = roster([road()], blocked)
    expect(built.vehicles.every(v => v.blockedAt === null)).toBe(true)
    expect(built.blocked).toBe(0)
  })

  it('does not move a vehicle for a frontage placement, which claims no road', () => {
    const blocked = new Map([['front', placement({ basis: 'frontage', routeId: null })]])
    const built = roster([road()], blocked)
    // A frontage pin has a null routeId, so it pins no road and halts nothing here.
    expect(built.vehicles.every(v => v.blockedAt === null)).toBe(true)
  })
})

describe('an empty roster is honest about why', () => {
  it('is empty for no roads at all', () => {
    const built = roster([])
    expect(built.vehicles).toHaveLength(0)
    expect(built.reason.length).toBeGreaterThan(0)
  })

  it('exposes EMPTY_ROSTER for a caller with nothing yet', () => {
    expect(EMPTY_ROSTER.vehicles).toHaveLength(0)
    expect(EMPTY_ROSTER.cap).toBe(VEHICLE_CAP)
  })
})

describe('the cap is disclosed, never silent', () => {
  it('drops the overflow and counts it, keeping blocked vehicles ahead of the cap', () => {
    const roads: VehicleRoad[] = []
    for (let i = 0; i < 200; i += 1) {
      roads.push(road({ routeId: `r${i}`, operations: 1000, carOperations: 1000, freightOperations: 0 }))
    }
    const built = roster(roads)
    expect(built.vehicles.length).toBe(VEHICLE_CAP)
    expect(built.capped).toBeGreaterThan(0)
  })
})

describe('paint is identity, hashed from the id', () => {
  it('is deterministic and in range', () => {
    const hue = vehiclePaintHue('r1:car:0')
    expect(hue).toBe(vehiclePaintHue('r1:car:0'))
    expect(hue).toBeGreaterThanOrEqual(0)
    expect(hue).toBeLessThan(1)
  })

  it('gives two vehicles on one road distinct ids so they read apart', () => {
    const built = roster([road({ operations: 1000, carOperations: 1000, freightOperations: 0 })])
    const ids = new Set(built.vehicles.map(v => v.id))
    expect(ids.size).toBe(built.vehicles.length)
  })

  it('keeps an id stable across rebuilds so its colour does not flicker', () => {
    const a = roster([road()]).vehicles.map(v => v.id)
    const b = roster([road()]).vehicles.map(v => v.id)
    expect(a).toEqual(b)
  })
})

describe('geometry helpers', () => {
  it('measures a polyline by arc length', () => {
    expect(polylineLength(STRAIGHT)).toBeCloseTo(1000, 6)
    expect(polylineLength([{ x: 0, z: 0 }])).toBe(0)
  })

  it('walks a fraction along by arc length', () => {
    expect(pointAt(STRAIGHT, 0.5).x).toBeCloseTo(500, 6)
    expect(pointAt(STRAIGHT, 0).x).toBeCloseTo(0, 6)
    expect(pointAt(STRAIGHT, 1).x).toBeCloseTo(1000, 6)
  })

  it('laps a perpetual vehicle rather than stopping it at the end', () => {
    // finishedAfterSeconds null => never finishes, always wraps within [0,1).
    const far = travelledFraction(STRAIGHT, 1000, null, 1)
    expect(far).toBeGreaterThanOrEqual(0)
    expect(far).toBeLessThan(1)
  })
})

describe('the folded summary', () => {
  it('reports driving vehicles, then evidence gaps, then idleness', () => {
    expect(vehicleSummaryLabel(roster([road()]))).toMatch(/driving/)
    expect(vehicleSummaryLabel(roster([road({ operations: null, carOperations: null, freightOperations: null })])))
      .toMatch(/Not measured/)
    expect(vehicleSummaryLabel(roster([road({ operations: 0, carOperations: 0, freightOperations: 0 })])))
      .toMatch(/None running/)
  })
})
