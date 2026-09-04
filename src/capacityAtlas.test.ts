import { describe, expect, it } from 'vitest'
import {
  HEIGHT_UNITS_PER_DOUBLING,
  accessibleCapacityLabel,
  assertAtlasSnapshot,
  capacityHeight,
  capacitySide,
  collectorSummary,
  cuToHeight,
  evidenceText,
  formatBytes,
  formatCu,
  formatMinutes,
  formatPercent,
  isFresh,
  isRejecting,
  isReporting,
  skuToSide,
  skuUnits,
} from './capacityAtlas'
import { createFixtureSource } from './collect/fixtureSource'
import { SKU_CAPACITY_UNITS } from './fabricContracts'
import type { ByteMeasurement, CapacityAtlasItem, CuMeasurement, Evidence } from './fabricContracts'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

async function capacities(): Promise<CapacityAtlasItem[]> {
  return (await createFixtureSource({ now: () => NOW }).readAtlas()).capacities
}

function named(list: CapacityAtlasItem[], name: string): CapacityAtlasItem {
  const found = list.find((entry) => entry.displayName === name)
  if (!found) throw new Error(`No capacity named ${name}`)
  return found
}

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: NOW.toISOString(),
  freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
}

function knownBytes(value: string): ByteMeasurement {
  return { bytes: value, status: 'Known', evidence }
}

function knownCu(value: string): CuMeasurement {
  return { cuSeconds: value, status: 'Known', evidence }
}

describe('plot geometry', () => {
  it('is strictly monotonic across every SKU', () => {
    const skus = Object.values(SKU_CAPACITY_UNITS).sort((left, right) => left - right)
    const sides = skus.map(skuToSide)

    for (let index = 1; index < sides.length; index += 1) {
      /*
       * Equal sides for unequal SKUs would make two capacities read as the same size when their
       * budgets differ, which is the one thing the mapping must never do. Trial and F64 are the
       * same 64 CUs and legitimately tie.
       */
      if (skus[index] === skus[index - 1]) expect(sides[index]).toBe(sides[index - 1])
      else expect(sides[index]).toBeGreaterThan(sides[index - 1])
    }
  })

  it('spans the intended range', () => {
    expect(skuToSide(0)).toBeCloseTo(12, 6)
    expect(skuToSide(SKU_CAPACITY_UNITS.F8192)).toBeCloseTo(96, 6)
  })

  it('rejects impossible inputs rather than drawing a guess', () => {
    expect(() => skuToSide(-1)).toThrow(RangeError)
    expect(() => skuToSide(Number.NaN)).toThrow(RangeError)
    expect(() => cuToHeight(-1)).toThrow(RangeError)
  })

  it('adds a fixed height per doubling of consumed CU', () => {
    expect(cuToHeight(1)).toBeCloseTo(HEIGHT_UNITS_PER_DOUBLING, 10)
    expect(cuToHeight(3)).toBeCloseTo(2 * HEIGHT_UNITS_PER_DOUBLING, 10)
    expect(cuToHeight(7)).toBeCloseTo(3 * HEIGHT_UNITS_PER_DOUBLING, 10)
    expect(cuToHeight(0)).toBe(0)
  })
})

describe('measurements that are missing rather than zero', () => {
  it('claims no height for a capacity whose consumption is unknown', async () => {
    const tailspin = named(await capacities(), 'Tailspin Archive')

    /*
     * The paused case. A capacity that emits no telemetry must produce no height at all — a zero
     * would draw a flat, healthy, idle city over one nobody has any information about.
     */
    expect(tailspin.cuConsumed.status).toBe('Unknown')
    expect(capacityHeight(tailspin)).toBeNull()
  })

  it('still gives it a plot, because the SKU is known even while it is paused', async () => {
    const tailspin = named(await capacities(), 'Tailspin Archive')
    expect(capacitySide(tailspin)).toBeCloseTo(skuToSide(SKU_CAPACITY_UNITS.F4), 10)
  })

  it('claims no plot when the SKU is unrecognised', () => {
    const unknown = { capacityUnits: null } as CapacityAtlasItem
    expect(capacitySide(unknown)).toBeNull()
  })

  it('formats unknown measurements as unknown, not as zero', () => {
    expect(formatBytes({ bytes: null, status: 'Unknown', evidence })).toBe('Unknown')
    expect(formatCu({ cuSeconds: null, status: 'Unknown', evidence })).toBe('Unknown')
    expect(formatPercent(null)).toBe('Unavailable')
    expect(formatMinutes(null)).toBe('Unavailable')
  })
})

describe('formatting', () => {
  it('keeps byte precision past what a double survives', () => {
    // 2^63 bytes: a Number would round this; the formatter works on the bigint.
    expect(formatBytes(knownBytes('9223372036854775808'))).toBe('8 EiB')
    expect(formatBytes(knownBytes('0'))).toBe('0 bytes')
    expect(formatBytes(knownBytes('1536'))).toBe('1.5 KiB')
  })

  it('compacts CU-seconds into something readable', () => {
    expect(formatCu(knownCu('900'))).toBe('900 CU-s')
    expect(formatCu(knownCu('77414400'))).toBe('77.4M CU-s')
    expect(formatCu(knownCu('1500'))).toBe('1.5K CU-s')
  })

  it('rejects malformed exact values instead of coercing them', () => {
    expect(formatBytes(knownBytes('12.5'))).toBe('Invalid')
    expect(formatCu(knownCu('-4'))).toBe('Invalid')
  })

  it('formats durations at the scale they are read at', () => {
    expect(formatMinutes(0.4)).toBe('<1 min')
    expect(formatMinutes(42)).toBe('42 min')
    expect(formatMinutes(150)).toBe('2.5 h')
    expect(formatMinutes(2880)).toBe('2.0 d')
  })

  it('states provenance without a paragraph', () => {
    const text = evidenceText(evidence)
    expect(text).toContain('Fixture')
    expect(text).toContain('available')
    expect(text.split('·')).toHaveLength(3)
  })
})

describe('freshness', () => {
  it('is fresh inside its own window and stale outside it', () => {
    expect(isFresh(evidence, NOW.toISOString())).toBe(true)
    expect(isFresh(evidence, new Date(NOW.getTime() + 600_000).toISOString())).toBe(false)
  })

  it('is never fresh without a window, rather than defaulting to fresh', () => {
    expect(isFresh({ ...evidence, freshUntil: null }, NOW.toISOString())).toBe(false)
    expect(isFresh({ ...evidence, status: 'Disconnected' }, NOW.toISOString())).toBe(false)
  })
})

describe('capacity state predicates', () => {
  it('separates a busy capacity from one turning work away', async () => {
    const list = await capacities()

    const northwind = named(list, 'Northwind Reporting')
    expect(northwind.throttle.stage).toBe('InteractiveDelay')
    /*
     * Interactive delay adds 20 seconds to a request. That is a busy city, not a broken one, and
     * drawing it as a blackout would cry wolf on the state that matters.
     */
    expect(isRejecting(northwind)).toBe(false)

    expect(isRejecting(named(list, 'Litware Trading'))).toBe(true)
    expect(isRejecting(named(list, 'Fabrikam Dev'))).toBe(true)
    expect(isRejecting(named(list, 'Contoso Analytics'))).toBe(false)
  })

  it('separates a paused capacity from an idle one', async () => {
    const list = await capacities()
    expect(isReporting(named(list, 'Tailspin Archive'))).toBe(false)
    expect(isReporting(named(list, 'Contoso Analytics'))).toBe(true)
  })
})

describe('accessible label', () => {
  it('names the capacity, its SKU and its state without prose', async () => {
    const label = accessibleCapacityLabel(named(await capacities(), 'Fabrikam Dev'))

    expect(label).toContain('Fabrikam Dev')
    expect(label).toContain('F2')
    expect(label).toContain('overloaded')
    expect(label).toContain('background rejection')
  })

  it('omits a throttle clause for a healthy capacity', async () => {
    const label = accessibleCapacityLabel(named(await capacities(), 'Contoso Analytics'))
    expect(label).not.toContain('rejection')
    expect(label).not.toContain('delay')
  })
})

describe('snapshot validation', () => {
  it('accepts what the source produces', async () => {
    const snapshot = await createFixtureSource({ now: () => NOW }).readAtlas()
    expect(assertAtlasSnapshot(snapshot)).toBe(snapshot)
  })

  it('rejects a payload that is not this schema', () => {
    expect(() => assertAtlasSnapshot(null)).toThrow()
    expect(() => assertAtlasSnapshot({ schemaVersion: '0.9', capacities: [], links: [] })).toThrow()
    expect(() => assertAtlasSnapshot({ schemaVersion: '1.0', capacities: [] })).toThrow()
  })
})

describe('collector summary', () => {
  it('reports counts and flags degradation', async () => {
    const snapshot = await createFixtureSource({ now: () => NOW }).readAtlas()
    expect(collectorSummary(snapshot.collection!)).toContain('6 capacities')

    expect(
      collectorSummary({ ...snapshot.collection!, isStale: true, failureCount: 2 }),
    ).toContain('stale')
  })
})

describe('sku lookup', () => {
  it('resolves known SKUs and refuses unknown ones', () => {
    expect(skuUnits('F64')).toBe(64)
    expect(skuUnits('Trial')).toBe(64)
    expect(skuUnits('P1')).toBeNull()
    expect(skuUnits(null)).toBeNull()
  })
})
