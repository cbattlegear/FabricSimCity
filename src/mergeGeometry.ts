import * as THREE from 'three'

/**
 * Minimal position/normal/uv geometry merge, shared by the database city and the server atlas.
 *
 * three's own `BufferGeometryUtils` is an examples module. Both scenes build every geometry they
 * merge themselves -- always `BoxGeometry`/`ConeGeometry`/`CylinderGeometry` with the same attribute
 * set -- so a merge that handles exactly that keeps the bundle dependent only on the core package.
 *
 * Merging matters for more than bundle size. A city drawn as one mesh is one draw call and one
 * raycast target, which is what makes a hundred database cities in the atlas affordable at all.
 */
export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = parts.map(part => (part.index ? part.toNonIndexed() : part.clone()))
  const names = ['position', 'normal', 'uv'] as const
  const result = new THREE.BufferGeometry()
  for (const name of names) {
    if (!nonIndexed.every(part => part.getAttribute(name))) continue
    const itemSize = nonIndexed[0].getAttribute(name).itemSize
    let total = 0
    for (const part of nonIndexed) total += part.getAttribute(name).count * itemSize
    const array = new Float32Array(total)
    let offset = 0
    for (const part of nonIndexed) {
      const attribute = part.getAttribute(name)
      array.set(attribute.array as Float32Array, offset)
      offset += attribute.count * itemSize
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
  }
  for (const part of nonIndexed) part.dispose()
  result.computeBoundingSphere()
  return result
}

/** Merges and disposes the inputs, returning null for an empty set so callers can skip a mesh. */
export function mergeAndDispose(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  const merged = mergeGeometries(parts)
  for (const part of parts) part.dispose()
  return merged
}
