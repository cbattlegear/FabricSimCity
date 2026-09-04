import type {
  ByteMeasurement,
  CapacityAtlasItem,
  CuMeasurement,
  Evidence,
  FabricSku,
} from '../fabricContracts'
import { SKU_CAPACITY_UNITS } from '../fabricContracts'

/*
 * A minimal `CapacityAtlasItem` factory for tests that care about geometry rather than telemetry.
 *
 * Tests that need realistic load should use `createFixtureSource`; this exists for the ones that
 * need to pin one specific pair of measurements — usually an unknown one — and would otherwise
 * hand-roll a whole contract object and drift from it.
 */

export const TEST_EVIDENCE: Evidence = Object.freeze({
  source: 'Fixture',
  status: 'Available',
  observedAt: '2026-08-17T16:59:52Z',
  freshUntil: '2026-08-17T18:00:00Z',
})

const UNKNOWN_EVIDENCE: Evidence = Object.freeze({
  ...TEST_EVIDENCE,
  status: 'Unknown',
  freshUntil: null,
})

export function testBytes(value: string | null): ByteMeasurement {
  return value === null
    ? { bytes: null, status: 'Unknown', evidence: UNKNOWN_EVIDENCE }
    : { bytes: value, status: 'Known', evidence: TEST_EVIDENCE }
}

export function testCu(value: string | null): CuMeasurement {
  return value === null
    ? { cuSeconds: null, status: 'Unknown', evidence: UNKNOWN_EVIDENCE }
    : { cuSeconds: value, status: 'Known', evidence: TEST_EVIDENCE }
}

export interface TestCapacityOptions {
  /** Null models an unrecognised SKU, which is what leaves a city with no measured plot. */
  sku?: FabricSku | null
  cuSeconds?: string | null
  storageBytes?: string | null
  displayName?: string
  capacityId?: string
}

export function testCapacity(options: TestCapacityOptions = {}): CapacityAtlasItem {
  const {
    sku = 'F64',
    cuSeconds = String(64 * 30 * 2880),
    storageBytes = String(1024 ** 3),
    displayName = 'sales',
    capacityId = 'target/capacity/sales',
  } = options

  return {
    capacityId,
    displayName,
    sku,
    capacityUnits: sku === null ? null : SKU_CAPACITY_UNITS[sku],
    region: 'westus2',
    state: 'Active',
    stateReason: 'NotOverloaded',
    workspaceCount: 3,
    itemCount: 12,
    storage: testBytes(storageBytes),
    cuConsumed: testCu(cuSeconds),
    meanUtilizationPercent: cuSeconds === null ? null : 42,
    peakUtilizationPercent: cuSeconds === null ? null : 71,
    throttle: {
      stage: 'None',
      interactiveDelayPercent: 12,
      interactiveRejectionPercent: 8,
      backgroundRejectionPercent: 4,
      cumulativeCarryOverPercent: 0,
      expectedBurndownMinutes: null,
      surgeProtectionActive: false,
      evidence: TEST_EVIDENCE,
    },
  }
}
