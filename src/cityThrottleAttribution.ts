import type { OperationFamily } from './capacityCityContracts'
import type { ThrottleState } from './fabricContracts'
import {
  facilityForThrottleStage,
  isThrottleStageActive,
  type PowerGridFacilityKind,
  type PowerGridThrottleStage,
} from './powerGrid'

/*
 * Throttle attribution.
 *
 * SQLSimCity spread Query Store wait categories over buildings. Fabric does not report SQL wait
 * categories; it reports operation families, rejected counts and the capacity-wide throttle gauges.
 * This module keeps the same refusal that made the old layer safe: it only places measured
 * throttling seconds when the operation class and throttle stage identify one honest gate.
 */

export interface FamilyThrottleAttribution {
  readonly familyId: string
  readonly itemId: string
  readonly stage: PowerGridThrottleStage
  readonly facility: PowerGridFacilityKind
  /** Measured throttling seconds for the family. */
  readonly seconds: number
}

export interface ItemThrottleAttribution {
  readonly itemId: string
  readonly stage: PowerGridThrottleStage
  readonly facility: PowerGridFacilityKind
  readonly seconds: number
  readonly familyIds: readonly string[]
}

export interface ThrottleStageTotal {
  readonly stage: PowerGridThrottleStage
  readonly facility: PowerGridFacilityKind
  readonly seconds: number
  readonly familyIds: readonly string[]
}

export interface ThrottleAttributionTotals {
  readonly byItemStage: ReadonlyMap<string, ItemThrottleAttribution>
  readonly byStage: ReadonlyMap<PowerGridThrottleStage, ThrottleStageTotal>
  readonly measuredSeconds: number
  readonly unattributedSeconds: number
  readonly measuredFamilyCount: number
  readonly unmeasuredFamilyCount: number
  readonly familyCount: number
  readonly note: string
}

export function familyThrottleAttribution(
  family: OperationFamily,
  throttle: ThrottleState,
): FamilyThrottleAttribution | null {
  const seconds = measuredSeconds(family.throttlingSeconds)
  if (seconds === null || seconds <= 0) return null

  const stage = familyThrottleStage(family, throttle)
  if (stage === null) return null
  return {
    familyId: family.familyId,
    itemId: family.itemId,
    stage,
    facility: facilityForThrottleStage(stage),
    seconds,
  }
}

export function familyThrottleStage(
  family: OperationFamily,
  throttle: ThrottleState,
): PowerGridThrottleStage | null {
  const delayActive = isThrottleStageActive(throttle, 'InteractiveDelay')
  const interactiveRejecting = isThrottleStageActive(throttle, 'InteractiveRejection')
  const backgroundRejecting = isThrottleStageActive(throttle, 'BackgroundRejection')
  const rejected = rejectedOperations(family)

  switch (family.operationClass) {
    case 'Interactive':
      if (interactiveRejecting === true) {
        if (rejected === null) return null
        if (rejected > 0) return 'InteractiveRejection'
      }
      return delayActive === true ? 'InteractiveDelay' : null
    case 'Background':
      return rejected !== null && rejected > 0 && backgroundRejecting === true
        ? 'BackgroundRejection'
        : null
    case 'Unknown':
      return null
  }
}

export function attributedThrottling(
  families: readonly OperationFamily[],
  throttle: ThrottleState,
  drawnItemIds?: ReadonlySet<string>,
): ThrottleAttributionTotals {
  const byItemStage = new Map<string, MutableItemThrottle>()
  const byStage = new Map<PowerGridThrottleStage, MutableStageThrottle>()
  let measuredSecondsTotal = 0
  let unattributedSeconds = 0
  let measuredFamilyCount = 0
  let unmeasuredFamilyCount = 0

  for (const family of families) {
    const seconds = measuredSeconds(family.throttlingSeconds)
    if (seconds === null) {
      unmeasuredFamilyCount += 1
      continue
    }
    measuredFamilyCount += 1
    measuredSecondsTotal += seconds
    if (seconds <= 0) continue

    const attribution = familyThrottleAttribution(family, throttle)
    if (attribution === null) {
      unattributedSeconds += seconds
      continue
    }
    if (drawnItemIds && !drawnItemIds.has(attribution.itemId)) {
      unattributedSeconds += seconds
      continue
    }

    const itemKey = `${attribution.itemId}:${attribution.stage}`
    const item = byItemStage.get(itemKey) ?? {
      itemId: attribution.itemId,
      stage: attribution.stage,
      facility: attribution.facility,
      seconds: 0,
      familyIds: new Set<string>(),
    }
    item.seconds += attribution.seconds
    item.familyIds.add(attribution.familyId)
    byItemStage.set(itemKey, item)

    const stage = byStage.get(attribution.stage) ?? {
      stage: attribution.stage,
      facility: attribution.facility,
      seconds: 0,
      familyIds: new Set<string>(),
    }
    stage.seconds += attribution.seconds
    stage.familyIds.add(attribution.familyId)
    byStage.set(attribution.stage, stage)
  }

  return {
    byItemStage: finishItems(byItemStage),
    byStage: finishStages(byStage),
    measuredSeconds: measuredSecondsTotal,
    unattributedSeconds,
    measuredFamilyCount,
    unmeasuredFamilyCount,
    familyCount: families.length,
    note: describe(families.length, measuredFamilyCount, unmeasuredFamilyCount, unattributedSeconds),
  }
}

interface MutableItemThrottle {
  itemId: string
  stage: PowerGridThrottleStage
  facility: PowerGridFacilityKind
  seconds: number
  familyIds: Set<string>
}

interface MutableStageThrottle {
  stage: PowerGridThrottleStage
  facility: PowerGridFacilityKind
  seconds: number
  familyIds: Set<string>
}

function finishItems(
  entries: ReadonlyMap<string, MutableItemThrottle>,
): ReadonlyMap<string, ItemThrottleAttribution> {
  const out = new Map<string, ItemThrottleAttribution>()
  for (const [key, entry] of entries) {
    out.set(key, {
      itemId: entry.itemId,
      stage: entry.stage,
      facility: entry.facility,
      seconds: entry.seconds,
      familyIds: [...entry.familyIds].sort(),
    })
  }
  return out
}

function finishStages(
  entries: ReadonlyMap<PowerGridThrottleStage, MutableStageThrottle>,
): ReadonlyMap<PowerGridThrottleStage, ThrottleStageTotal> {
  const out = new Map<PowerGridThrottleStage, ThrottleStageTotal>()
  for (const [stage, entry] of entries) {
    out.set(stage, {
      stage,
      facility: entry.facility,
      seconds: entry.seconds,
      familyIds: [...entry.familyIds].sort(),
    })
  }
  return out
}

function measuredSeconds(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value < 0 ? null : value
}

function rejectedOperations(family: OperationFamily): number | null {
  const value = family.counts.rejected
  if (value === null || value.trim() === '' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function describe(
  familyCount: number,
  measuredFamilyCount: number,
  unmeasuredFamilyCount: number,
  unattributedSeconds: number,
): string {
  if (familyCount === 0) {
    return 'No operation family was returned for this page, so no throttle attribution is claimed.'
  }
  if (measuredFamilyCount === 0) {
    return 'No operation family carried measured throttling seconds; absent seconds are not drawn as zero-load gates.'
  }
  return (
    `${measuredFamilyCount.toLocaleString()} of ${familyCount.toLocaleString()} operation families ` +
    'reported measured throttling seconds. Interactive delay is attributed to the delay gate as load, ' +
    'while only rejected interactive or background work is attributed to rejection gates. ' +
    `${unattributedSeconds.toLocaleString()} second(s) stayed unattributed because the item, ` +
    'operation class, rejected count or throttle gauge did not identify one honest gate.' +
    (unmeasuredFamilyCount > 0
      ? ` ${unmeasuredFamilyCount.toLocaleString()} family/families had no throttling measurement at all.`
      : '')
  )
}
