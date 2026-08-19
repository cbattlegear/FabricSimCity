export type AtlasPosition = Readonly<{ x: number; z: number }>

const columns = 10
const slots = columns * columns
const spacing = 112

/**
 * Squared distance of a slot from the centre of the grid. Squared is enough because it is only ever
 * compared, and it keeps the ordering in exact integer-and-quarter arithmetic.
 */
const distanceFromCenter = (slot: number): number => {
  const offsetX = (slot % columns) - (columns - 1) / 2
  const offsetZ = Math.floor(slot / columns) - (columns - 1) / 2
  return offsetX * offsetX + offsetZ * offsetZ
}

/**
 * Slot indices ordered by distance from the centre of the grid.
 *
 * A database keeps whichever slot it is first given, but which slots get handed out first is a choice,
 * and scattering them over the full hundred is the wrong one: a server with eight databases would spread
 * them across a thousand units of mostly empty ground, and the camera would have to stand far enough
 * back that no city could be told from any other and no name could be read. Handing out the central
 * slots first keeps a small server compact and a large one no worse off, without any database ever
 * moving once it is placed.
 *
 * Ties are broken by slot index so the order is fully determined.
 */
const slotsByDistance = Array.from({ length: slots }, (_, slot) => slot).sort((left, right) => {
  const difference = distanceFromCenter(left) - distanceFromCenter(right)
  return difference || left - right
})

export class AtlasLayoutReservations {
  private readonly slotsById = new Map<string, number>()
  private readonly occupied = new Set<number>()

  place(databaseIds: readonly string[]): ReadonlyMap<string, AtlasPosition> {
    const requestedIds = [...new Set(databaseIds)]
    const unseenIds = requestedIds
      .filter(id => !this.slotsById.has(id))
      .sort(compareStableIds)

    if (this.slotsById.size + unseenIds.length > slots) {
      throw new RangeError(`Atlas layout supports at most ${slots} reserved database IDs`)
    }

    for (const id of unseenIds) {
      const slot = slotsByDistance.find(candidate => !this.occupied.has(candidate))
      if (slot === undefined) throw new RangeError(`Atlas layout supports at most ${slots} reserved database IDs`)
      this.slotsById.set(id, slot)
      this.occupied.add(slot)
    }

    const positions = new Map<string, AtlasPosition>()
    for (const id of requestedIds) {
      const slot = this.slotsById.get(id)
      if (slot !== undefined) positions.set(id, positionForSlot(slot))
    }
    return positions
  }
}

export function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function compareStableIds(left: string, right: string): number {
  const hashDifference = stableHash(left) - stableHash(right)
  return hashDifference || left.localeCompare(right)
}

function positionForSlot(slot: number): AtlasPosition {
  return {
    x: ((slot % columns) - (columns - 1) / 2) * spacing,
    z: (Math.floor(slot / columns) - (columns - 1) / 2) * spacing,
  }
}
