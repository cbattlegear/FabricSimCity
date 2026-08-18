import { describe, expect, it } from 'vitest'
import { takeInitialFamilyId } from './queryStoreSelection'

describe('Query Store deep-link selection', () => {
  it('consumes a city deep link once and then follows metric ranking', () => {
    const pending = { current: 'family:city' as string | null }

    expect(takeInitialFamilyId(pending, 'family:cpu-top')).toBe('family:city')
    expect(takeInitialFamilyId(pending, 'family:reads-top')).toBe('family:reads-top')
  })
})
