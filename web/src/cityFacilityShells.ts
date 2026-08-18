import * as THREE from 'three'
import type { FacilityKind } from './cityInfrastructure'

/**
 * Decorative architecture for the six civic facilities, so CPU, memory, storage, tempdb, log, and
 * lock read as *places* on the map rather than coloured blocks.
 *
 * **Evidence boundary.** Nothing in this file is measured. Every shell is a fixed function of the
 * facility kind and its plot radius, so it is identical on every render and never changes when the
 * numbers change. The measured values are drawn separately by the scene as unit geometry placed in
 * the {@link facilitySlots} returned here; a slot's *position* is decoration, its *fill* is evidence.
 */

export interface FacilityShell {
  /** Walls, sheds, silos, and plinths. Rendered in the facility body material. */
  readonly body: THREE.BufferGeometry
  /** Roofs, canopies, columns, railings, and signage. Rendered in the trim material. */
  readonly trim: THREE.BufferGeometry | null
  /** Glazing and lit panels. Rendered in the window material. */
  readonly glass: THREE.BufferGeometry | null
}

/** Where one measured unit is drawn, and how it grows as its fill rises. */
export interface FacilitySlot {
  readonly x: number
  readonly y: number
  readonly z: number
  /** Footprint of the unit's geometry. */
  readonly width: number
  readonly depth: number
  /** Height at fill 0 and at fill 1; the scene interpolates with the measured fill. */
  readonly minHeight: number
  readonly maxHeight: number
  /** `column` grows upward from y; `panel` is a flat facade/shutter panel that fills downward. */
  readonly form: 'column' | 'panel' | 'cylinder'
  readonly radius: number
}

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth)
  geometry.translate(x, y, z)
  return geometry
}

function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  x: number,
  y: number,
  z: number,
  segments = 16,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments)
  geometry.translate(x, y, z)
  return geometry
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
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
  for (const part of parts) part.dispose()
  result.computeBoundingSphere()
  return result
}

function assemble(
  body: THREE.BufferGeometry[],
  trim: THREE.BufferGeometry[],
  glass: THREE.BufferGeometry[],
): FacilityShell {
  return {
    body: merge(body),
    trim: trim.length > 0 ? merge(trim) : null,
    glass: glass.length > 0 ? merge(glass) : null,
  }
}

/** Perimeter kerb every facility sits on, so its plot is legible from any angle. */
function apron(radius: number): THREE.BufferGeometry[] {
  const size = radius * 2
  const lip = 0.9
  return [
    box(size, 0.5, size, 0, 0.25, 0),
    box(size, 0.9, lip, 0, 0.45, -radius + lip / 2),
    box(size, 0.9, lip, 0, 0.45, radius - lip / 2),
    box(lip, 0.9, size, -radius + lip / 2, 0.45, 0),
    box(lip, 0.9, size, radius - lip / 2, 0.45, 0),
  ]
}

export function facilityShell(kind: FacilityKind, radius: number): FacilityShell {
  switch (kind) {
    case 'cpu':
      return schedulerYard(radius)
    case 'memory':
      return grantOffice(radius)
    case 'storage':
      return ioDepot(radius)
    case 'tempdb':
      return tempdbWorks(radius)
    case 'log':
      return logYard(radius)
    default:
      return lockAuthority(radius)
  }
}

/**
 * CPU Scheduler Yard: a control block with a stair tower, a gantry spanning the yard, and floodlight
 * masts. Scheduler towers rise between the gantry legs.
 */
function schedulerYard(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  const controlWidth = radius * 0.72
  body.push(box(controlWidth, 7, radius * 0.5, -radius + controlWidth / 2 + 1, 4, -radius * 0.55))
  body.push(box(radius * 0.22, 11, radius * 0.22, -radius + 1.6, 6, -radius * 0.55))
  trim.push(box(controlWidth + 1.2, 0.7, radius * 0.5 + 1.2, -radius + controlWidth / 2 + 1, 7.85, -radius * 0.55))
  glass.push(box(controlWidth * 0.86, 2.4, radius * 0.52, -radius + controlWidth / 2 + 1, 5.4, -radius * 0.55))

  // Gantry: two legs and a beam over the tower row.
  const gantryY = 15
  for (const side of [-1, 1]) {
    body.push(box(1.5, gantryY, 1.5, side * (radius - 2), gantryY / 2, radius * 0.35))
  }
  trim.push(box(radius * 2 - 2, 1.3, 2.2, 0, gantryY + 0.65, radius * 0.35))

  for (const side of [-1, 1]) {
    body.push(cylinder(0.3, 0.42, 13, side * (radius - 2.2), 7, -radius + 2.2, 6))
    trim.push(box(2.4, 0.8, 1.2, side * (radius - 2.2), 13.6, -radius + 2.2))
  }
  return assemble(body, trim, glass)
}

/**
 * Memory Grant Office: a setback office block with a glazed facade, an entrance canopy on columns,
 * and a queue rail outside the door where waiting grants line up.
 */
function grantOffice(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  const width = radius * 1.5
  const depth = radius * 0.85
  const z = -radius * 0.35
  body.push(box(width, 16, depth, 0, 8.5, z))
  body.push(box(width * 0.7, 6, depth * 0.75, 0, 19.5, z))
  trim.push(box(width + 1.4, 0.9, depth + 1.4, 0, 16.9, z))
  trim.push(box(width * 0.7 + 1.2, 0.8, depth * 0.75 + 1.2, 0, 22.8, z))
  glass.push(box(width * 0.92, 11, depth + 0.5, 0, 9.5, z))

  // Entrance canopy on two columns.
  const canopyZ = z + depth / 2 + radius * 0.3
  trim.push(box(width * 0.55, 0.7, radius * 0.62, 0, 6.2, canopyZ))
  for (const side of [-1, 1]) {
    body.push(cylinder(0.4, 0.4, 5.8, side * width * 0.22, 3.4, canopyZ + radius * 0.24, 10))
  }
  // Queue rail: posts the waiting-grant markers stand beside.
  for (let post = 0; post < 4; post += 1) {
    trim.push(cylinder(0.16, 0.16, 1.6, -radius * 0.55 + post * radius * 0.36, 1.3, radius * 0.72, 6))
  }
  return assemble(body, trim, glass)
}

/**
 * Storage & I/O Depot: a long warehouse with a barrel roof, a stepped loading dock, and bay openings
 * along the front. Each file's shutter fills its bay.
 */
function ioDepot(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  const width = radius * 1.8
  const depth = radius * 0.9
  const z = -radius * 0.3
  body.push(box(width, 11, depth, 0, 6, z))
  // Barrel roof, approximated with a half cylinder laid along x.
  const roof = new THREE.CylinderGeometry(depth * 0.52, depth * 0.52, width, 14, 1, false, 0, Math.PI)
  roof.rotateZ(Math.PI / 2)
  roof.translate(0, 11.5, z)
  trim.push(roof)
  // Loading dock apron in front of the bays.
  body.push(box(width, 1.6, radius * 0.5, 0, 1.3, z + depth / 2 + radius * 0.25))
  trim.push(box(width, 0.4, 0.5, 0, 2.15, z + depth / 2 + radius * 0.5))
  glass.push(box(width * 0.8, 1.6, 0.4, 0, 9.4, z - depth / 2 - 0.1))
  return assemble(body, trim, glass)
}

/** tempdb Works: three silos linked by pipe bridges, with a chimney and a plant shed. */
function tempdbWorks(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  body.push(box(radius * 0.8, 6, radius * 0.6, -radius * 0.5, 3.5, radius * 0.55))
  trim.push(box(radius * 0.86, 0.6, radius * 0.66, -radius * 0.5, 6.8, radius * 0.55))
  glass.push(box(radius * 0.6, 1.8, radius * 0.62, -radius * 0.5, 4.2, radius * 0.55))

  body.push(cylinder(1.0, 1.3, 20, radius * 0.62, 10.5, radius * 0.6, 10))
  trim.push(cylinder(1.25, 1.25, 0.7, radius * 0.62, 20.8, radius * 0.6, 10))

  // Pipe bridge linking the silo row.
  trim.push(box(radius * 1.5, 0.5, 0.5, 0, 13.5, -radius * 0.35))
  return assemble(body, trim, glass)
}

/** Log Yard: one large tank with a catwalk ring, an access ladder, and a bund wall. */
function logYard(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []

  const tankRadius = radius * 0.52
  // Bund wall around the tank.
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    body.push(
      box(
        dx === 0 ? tankRadius * 2.9 : 0.8,
        2.2,
        dz === 0 ? tankRadius * 2.9 : 0.8,
        dx * tankRadius * 1.45,
        1.6,
        dz * tankRadius * 1.45,
      ),
    )
  }
  trim.push(cylinder(tankRadius + 0.55, tankRadius + 0.55, 0.5, 0, 15.5, 0, 20))
  trim.push(cylinder(tankRadius * 0.98, tankRadius * 0.98, 0.8, 0, 16.6, 0, 20))
  // Ladder.
  for (let rung = 0; rung < 7; rung += 1) {
    trim.push(box(1.5, 0.16, 0.16, tankRadius + 0.9, 2 + rung * 2.1, 0))
  }
  return assemble(body, trim, [])
}

/** Lock Authority: a civic hall with a columned portico, a pediment, and a rooftop beacon plinth. */
function lockAuthority(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  const width = radius * 1.4
  const depth = radius * 0.8
  const z = -radius * 0.25
  body.push(box(width, 12, depth, 0, 6.5, z))
  trim.push(box(width + 1.6, 1.1, depth + 1.6, 0, 13.05, z))
  glass.push(box(width * 0.86, 6, depth + 0.4, 0, 7.5, z))

  // Portico: six columns under a pediment slab.
  const porticoZ = z + depth / 2 + radius * 0.28
  for (let column = 0; column < 6; column += 1) {
    body.push(cylinder(0.5, 0.55, 9, -width * 0.42 + column * (width * 0.84 / 5), 5, porticoZ, 10))
  }
  trim.push(box(width, 1.2, radius * 0.62, 0, 10.1, porticoZ))
  trim.push(box(width * 0.72, 1.6, radius * 0.5, 0, 11.5, porticoZ))
  // Beacon plinth on the roof; the scene puts the alert beacon on top of it.
  body.push(box(radius * 0.3, 3, radius * 0.3, 0, 15.1, z))
  return assemble(body, trim, glass)
}

/**
 * Positions for the measured unit geometry. Slot layout is fixed per kind so a unit never wanders,
 * and the scene only varies each unit's height/fill from the measurement.
 */
export function facilitySlots(kind: FacilityKind, radius: number, count: number): FacilitySlot[] {
  const slots: FacilitySlot[] = []
  if (count <= 0) return slots

  switch (kind) {
    case 'cpu': {
      // Scheduler towers in a row under the gantry.
      const columns = Math.min(count, 8)
      const rows = Math.ceil(count / columns)
      const pitch = (radius * 1.7) / columns
      for (let index = 0; index < count; index += 1) {
        const col = index % columns
        const row = Math.floor(index / columns)
        slots.push({
          x: (col - (columns - 1) / 2) * pitch,
          y: 0.5,
          z: radius * 0.35 + (row - (rows - 1) / 2) * pitch * 0.9,
          width: pitch * 0.5,
          depth: pitch * 0.5,
          minHeight: 2.5,
          maxHeight: 13,
          form: 'column',
          radius: pitch * 0.25,
        })
      }
      return slots
    }
    case 'memory': {
      // Waiting grants queue along the rail in front of the office.
      const pitch = (radius * 1.5) / Math.max(count, 4)
      for (let index = 0; index < count; index += 1) {
        slots.push({
          x: -radius * 0.6 + index * pitch,
          y: 0.5,
          z: radius * 0.55,
          width: Math.min(pitch * 0.62, 2.2),
          depth: Math.min(pitch * 0.62, 2.2),
          minHeight: 1.6,
          maxHeight: 7,
          form: 'column',
          radius: Math.min(pitch * 0.3, 1.1),
        })
      }
      return slots
    }
    case 'storage': {
      // One roller shutter per loading bay along the depot front.
      const bays = Math.min(count, 10)
      const pitch = (radius * 1.7) / bays
      for (let index = 0; index < count; index += 1) {
        const bay = index % bays
        slots.push({
          x: (bay - (bays - 1) / 2) * pitch,
          y: 2.1,
          z: -radius * 0.3 + radius * 0.45 + 0.35,
          width: pitch * 0.72,
          depth: 0.6,
          minHeight: 0.9,
          maxHeight: 7,
          form: 'panel',
          radius: pitch * 0.36,
        })
      }
      return slots
    }
    case 'tempdb': {
      // Silo contents.
      const pitch = (radius * 1.5) / Math.max(count, 3)
      for (let index = 0; index < count; index += 1) {
        slots.push({
          x: -radius * 0.55 + index * pitch,
          y: 0.5,
          z: -radius * 0.35,
          width: pitch * 0.7,
          depth: pitch * 0.7,
          minHeight: 3,
          maxHeight: 17,
          form: 'cylinder',
          radius: Math.min(pitch * 0.36, radius * 0.26),
        })
      }
      return slots
    }
    case 'log': {
      for (let index = 0; index < count; index += 1) {
        slots.push({
          x: 0,
          y: 0.5,
          z: 0,
          width: radius,
          depth: radius,
          minHeight: 1.5,
          maxHeight: 15,
          form: 'cylinder',
          radius: radius * 0.5,
        })
      }
      return slots
    }
    default: {
      // Lock Authority incident board: beacons on the roof parapet.
      const columns = Math.min(count, 6)
      const pitch = (radius * 1.2) / columns
      for (let index = 0; index < count; index += 1) {
        const col = index % columns
        const row = Math.floor(index / columns)
        slots.push({
          x: (col - (columns - 1) / 2) * pitch,
          y: 13.6,
          z: -radius * 0.25 + row * pitch * 0.8,
          width: pitch * 0.45,
          depth: pitch * 0.45,
          minHeight: 1.2,
          maxHeight: 5.5,
          form: 'column',
          radius: pitch * 0.22,
        })
      }
      return slots
    }
  }
}
