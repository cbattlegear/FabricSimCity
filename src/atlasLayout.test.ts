import { describe, expect, it } from 'vitest'
import { AtlasLayoutReservations, stableHash } from './atlasLayout'

const ids = [
  'target/capacity/master',
  'target/capacity/sales',
  'target/capacity/ledger',
  'target/capacity/warehouse',
  'target/capacity/telemetry',
  'target/capacity/archive',
  'target/capacity/scratch',
  'target/capacity/crm',
]

describe('stable atlas layout reservations', () => {
  it('places reordered initial input identically', () => {
    const forward = new AtlasLayoutReservations().place(ids)
    const reversed = new AtlasLayoutReservations().place([...ids].reverse())

    for (const id of ids) expect(reversed.get(id)).toEqual(forward.get(id))
  })

  it('supports 100 unique reserved IDs without overlap', () => {
    const databaseIds = Array.from({ length: 100 }, (_, index) => `target/capacity/${index}`)
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

  it('keeps a small server compact instead of scattering it over the reservation grid', () => {
    const positions = [...new AtlasLayoutReservations().place(ids).values()]
    const spread = Math.max(
      ...positions.map(position => Math.max(Math.abs(position.x), Math.abs(position.z))),
    )
    // Eight capacities must not need more than a couple of grid steps of ground, or nothing is legible.
    expect(spread).toBeLessThanOrEqual(112 * 1.5)
  })

  it('gives an existing ID the same position whether or not later capacities exist', () => {
    const layout = new AtlasLayoutReservations()
    const alone = layout.place([ids[0]!]).get(ids[0]!)
    expect(layout.place(ids).get(ids[0]!)).toEqual(alone)
  })

  it('does not move an existing ID when an earlier colliding ID arrives', () => {    const existingId = 'target/capacity/existing'
    const initialSlot = stableHash(existingId) % 100
    const existingHash = stableHash(existingId)
    let earlierCollision: string | undefined
    for (let index = 0; index < 100_000; index += 1) {
      const candidate = `target/capacity/earlier-${index}`
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
