export type AtlasPosition = Readonly<{ x: number; z: number }>

const columns = 8
const slots = columns * columns
const spacing = 112

export function layoutStableIds(databaseIds: readonly string[]): ReadonlyMap<string, AtlasPosition> {
  const ids = [...new Set(databaseIds)].sort((left, right) => {
    const hashDifference = stableHash(left) - stableHash(right)
    return hashDifference || left.localeCompare(right)
  })
  if (ids.length > slots) throw new RangeError(`Atlas layout supports at most ${slots} database IDs`)

  const occupied = new Set<number>()
  const positions = new Map<string, AtlasPosition>()
  for (const id of ids) {
    const initialSlot = stableHash(id) % slots
    let slot = initialSlot
    while (occupied.has(slot)) slot = (slot + 1) % slots
    occupied.add(slot)
    positions.set(id, {
      x: ((slot % columns) - (columns - 1) / 2) * spacing,
      z: (Math.floor(slot / columns) - (columns - 1) / 2) * spacing,
    })
  }
  return positions
}

export function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
