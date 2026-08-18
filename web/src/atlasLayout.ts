export type AtlasPosition = Readonly<{ x: number; z: number }>

const columns = 10
const slots = columns * columns
const spacing = 112

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
      let slot = stableHash(id) % slots
      while (this.occupied.has(slot)) slot = (slot + 1) % slots
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
