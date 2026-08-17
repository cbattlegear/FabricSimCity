import { describe, expect, it } from 'vitest'
import { layoutStableIds } from './atlasLayout'

const ids = [
  'target/database/master',
  'target/database/sales',
  'target/database/ledger',
  'target/database/warehouse',
  'target/database/telemetry',
  'target/database/archive',
  'target/database/scratch',
  'target/database/crm',
]

describe('stable atlas layout', () => {
  it('does not move IDs when the API array is reordered', () => {
    const forward = layoutStableIds(ids)
    const reversed = layoutStableIds([...ids].reverse())

    for (const id of ids) expect(reversed.get(id)).toEqual(forward.get(id))
  })

  it('does not move existing IDs when a later stable ID is added', () => {
    const before = layoutStableIds(ids)
    const after = layoutStableIds([...ids, 'zzzz/new-database'])

    for (const id of ids) expect(after.get(id)).toEqual(before.get(id))
  })

  it('resolves hash-slot collisions without overlapping blocks', () => {
    const manyIds = Array.from({ length: 40 }, (_, index) => `target/database/${index}`)
    const positions = [...layoutStableIds(manyIds).values()]
    const unique = new Set(positions.map(position => `${position.x}:${position.z}`))

    expect(unique.size).toBe(manyIds.length)
  })
})
