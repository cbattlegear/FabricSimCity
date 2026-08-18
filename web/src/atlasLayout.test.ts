import { describe, expect, it } from 'vitest'
import { AtlasLayoutReservations, stableHash } from './atlasLayout'

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

describe('stable atlas layout reservations', () => {
  it('places reordered initial input identically', () => {
    const forward = new AtlasLayoutReservations().place(ids)
    const reversed = new AtlasLayoutReservations().place([...ids].reverse())

    for (const id of ids) expect(reversed.get(id)).toEqual(forward.get(id))
  })

  it('supports 100 unique reserved IDs without overlap', () => {
    const databaseIds = Array.from({ length: 100 }, (_, index) => `target/database/${index}`)
    const positions = [...new AtlasLayoutReservations().place(databaseIds).values()]
    const unique = new Set(positions.map(position => `${position.x}:${position.z}`))

    expect(positions).toHaveLength(100)
    expect(unique.size).toBe(100)
  })

  it('retains a reservation through disappearance and reappearance', () => {
    const layout = new AtlasLayoutReservations()
    const original = layout.place(ids).get(ids[0]!)

    expect(layout.place(ids.slice(1)).has(ids[0]!)).toBe(false)
    expect(layout.place(ids).get(ids[0]!)).toEqual(original)
  })

  it('does not move an existing ID when an earlier colliding ID arrives', () => {
    const existingId = 'target/database/existing'
    const initialSlot = stableHash(existingId) % 100
    const existingHash = stableHash(existingId)
    let earlierCollision: string | undefined
    for (let index = 0; index < 100_000; index += 1) {
      const candidate = `target/database/earlier-${index}`
      const candidateHash = stableHash(candidate)
      if (candidateHash % 100 === initialSlot && candidateHash < existingHash) {
        earlierCollision = candidate
        break
      }
    }
    expect(earlierCollision).toBeDefined()

    const layout = new AtlasLayoutReservations()
    const before = layout.place([existingId]).get(existingId)
    const after = layout.place([earlierCollision!, existingId])

    expect(after.get(existingId)).toEqual(before)
    expect(after.get(earlierCollision!)).not.toEqual(before)
  })
})
