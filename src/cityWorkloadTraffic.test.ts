import { describe, expect, it } from 'vitest'
import { assignWorkloadTraffic, congestionFromDelay as fromWorkload } from './cityWorkloadTraffic'
import { congestionFromDelay } from './cityTraffic'
import { buildPlan, family } from './operationTraffic.testkit'

const plan = buildPlan()

describe('assignWorkloadTraffic', () => {
  it('draws nothing when there are no families', () => {
    const traffic = assignWorkloadTraffic(plan, [])
    expect(traffic.streets.size).toBe(0)
    expect(traffic.trips.size).toBe(0)
  })

  it('drives a two-item family through the streets as its class vehicle', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family({ itemIds: ['item:a:0', 'item:b:0'], operationCount: '20', operationClass: 'Background', throttlingSeconds: 0 }),
    ])
    expect(traffic.trips.size).toBe(1)
    const trip = [...traffic.trips.values()][0]
    expect(trip.mode).toBe('freight')
    expect(trip.operationClass).toBe('Background')
    expect(traffic.streets.size).toBeGreaterThan(0)
  })

  it('splits interactive and background operations into cars and freight on the streets', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family({ familyId: 'car', itemIds: ['item:a:0', 'item:b:0'], operationCount: '20', operationClass: 'Interactive', throttlingSeconds: 0 }),
      family({ familyId: 'freight', itemIds: ['item:a:0', 'item:b:0'], operationCount: '12', operationClass: 'Background', throttlingSeconds: 0 }),
    ])
    let car = 0
    let freight = 0
    for (const street of traffic.streets.values()) {
      car += street.carOperations
      freight += street.freightOperations
    }
    // Both streams must be present. Collapsing operation class to one vehicle zeroes one of these.
    expect(car).toBeGreaterThan(0)
    expect(freight).toBeGreaterThan(0)
  })

  it('grades a street with no measured throttling as unknown, never free', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family({ itemIds: ['item:a:0', 'item:b:0'], operationCount: '20', throttlingSeconds: null }),
    ])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) {
      expect(street.grade).toBe('unknown')
      expect(street.delayPerOperation).toBeNull()
    }
  })

  it('grades a heavily-throttled street by throttling seconds per operation', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family({ itemIds: ['item:a:0', 'item:b:0'], operationCount: '20', throttlingSeconds: 200 }),
    ])
    // 200 s over 20 operations = 10 s/op → heavy.
    const grades = [...traffic.streets.values()].map(s => s.grade)
    expect(grades.every(g => g === 'heavy')).toBe(true)
  })

  it('keeps a family that reaches only one item as resident, not routed', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family({ itemIds: ['item:a:0'], operationCount: '20' }),
    ])
    expect(traffic.trips.size).toBe(0)
    expect(traffic.resident).toContain('fam:item:a:0')
  })
})

describe('congestion ladder identity', () => {
  it('re-exports the exact same grading function as cityTraffic', () => {
    // A street and the co-reference road running along it must be graded by one rule, not two that
    // agree by coincidence.
    expect(fromWorkload).toBe(congestionFromDelay)
  })
})
