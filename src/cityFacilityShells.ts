import * as THREE from 'three'
import type { FacilityKind } from './cityInfrastructure'

/**
 * Decorative architecture for Fabric capacity power-grid facilities.
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
    case 'powerPlant':
      return powerPlant(radius)
    case 'reservoir':
      return smoothingReservoir(radius)
    case 'carryForwardYard':
      return carryForwardYard(radius)
    case 'delayGate':
      return delayGate(radius)
    case 'interactiveRejectionGate':
      return interactiveGate(radius)
    case 'backgroundRejectionGate':
      return backgroundEmbargo(radius)
    case 'surgeSubstation':
      return surgeSubstation(radius)
  }
}

/** Power Plant: turbine hall, cooling stacks and a central chimney. */
function powerPlant(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  body.push(box(radius * 1.25, 13, radius * 0.85, 0, 7, -radius * 0.2))
  body.push(box(radius * 0.55, 21, radius * 0.55, -radius * 0.55, 11, -radius * 0.18))
  body.push(cylinder(radius * 0.18, radius * 0.28, 31, radius * 0.55, 16, -radius * 0.25, 18))
  trim.push(box(radius * 1.34, 1, radius * 0.94, 0, 13.9, -radius * 0.2))
  trim.push(cylinder(radius * 0.28, radius * 0.28, 0.8, radius * 0.55, 31.8, -radius * 0.25, 18))
  glass.push(box(radius * 0.95, 4, radius * 0.88, 0, 8.5, -radius * 0.2))
  return assemble(body, trim, glass)
}

/** Smoothing Reservoir: paired tanks and a gauge house. */
function smoothingReservoir(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  for (const side of [-1, 1]) {
    body.push(cylinder(radius * 0.34, radius * 0.4, 15, side * radius * 0.35, 8, -radius * 0.12, 24))
    trim.push(cylinder(radius * 0.36, radius * 0.36, 0.8, side * radius * 0.35, 15.9, -radius * 0.12, 24))
  }
  body.push(box(radius * 0.72, 6, radius * 0.44, 0, 3.5, radius * 0.54))
  glass.push(box(radius * 0.48, 2.2, radius * 0.46, 0, 4.4, radius * 0.54))
  trim.push(box(radius * 1.25, 0.6, 0.8, 0, 12.2, -radius * 0.12))
  return assemble(body, trim, glass)
}

/** Carry-forward Yard: a fenced debt heap with a small burndown office. */
function carryForwardYard(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  body.push(box(radius * 0.72, 6, radius * 0.52, -radius * 0.55, 3.5, -radius * 0.52))
  glass.push(box(radius * 0.48, 2, radius * 0.54, -radius * 0.55, 4.2, -radius * 0.52))
  for (const z of [-0.1, 0.32, 0.74]) {
    trim.push(box(radius * 1.45, 0.5, 0.5, radius * 0.16, 2.1 + z * 2, radius * z))
  }
  for (const side of [-1, 1]) {
    trim.push(box(0.5, 3, radius * 1.55, side * radius * 0.82, 2, radius * 0.18))
  }
  return assemble(body, trim, glass)
}

/** Delay Gate: an open checkpoint with queue gantries. */
function delayGate(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []

  for (const side of [-1, 1]) {
    body.push(box(radius * 0.2, 13, radius * 0.28, side * radius * 0.42, 7, -radius * 0.12))
  }
  trim.push(box(radius * 1.05, 1.3, radius * 0.26, 0, 13.9, -radius * 0.12))
  for (let lane = 0; lane < 3; lane += 1) {
    trim.push(box(radius * 1.25, 0.35, 0.35, 0, 1.7, radius * (0.18 + lane * 0.23)))
  }
  return assemble(body, trim, [])
}

/** Interactive Rejection Gate: a closed security gate and control booth. */
function interactiveGate(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  body.push(box(radius * 0.55, 8, radius * 0.55, -radius * 0.55, 4.5, -radius * 0.28))
  glass.push(box(radius * 0.4, 3, radius * 0.57, -radius * 0.55, 5.2, -radius * 0.28))
  for (const side of [-1, 1]) {
    body.push(box(radius * 0.16, 12, radius * 0.18, side * radius * 0.38, 6.5, radius * 0.12))
  }
  trim.push(box(radius * 1.05, 1, radius * 0.22, 0, 12.8, radius * 0.12))
  trim.push(box(radius * 0.9, 3.2, 0.6, radius * 0.12, 4.4, radius * 0.12))
  return assemble(body, trim, glass)
}

/** Background Embargo: freight depot with a shuttered bay. */
function backgroundEmbargo(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []

  const width = radius * 1.55
  const depth = radius * 0.8
  body.push(box(width, 10, depth, 0, 5.5, -radius * 0.25))
  body.push(box(width * 0.86, 1.4, radius * 0.55, 0, 1.2, radius * 0.45))
  trim.push(box(width + 1.1, 0.8, depth + 1.1, 0, 10.9, -radius * 0.25))
  trim.push(box(width * 0.68, 0.5, 0.5, 0, 5.8, radius * 0.16))
  glass.push(box(width * 0.74, 1.8, 0.4, 0, 8.2, -radius * 0.67))
  return assemble(body, trim, glass)
}

/** Surge Substation: transformers, bus bars and lightning masts. */
function surgeSubstation(radius: number): FacilityShell {
  const body: THREE.BufferGeometry[] = apron(radius)
  const trim: THREE.BufferGeometry[] = []

  for (const side of [-1, 1]) {
    body.push(box(radius * 0.34, 7, radius * 0.42, side * radius * 0.32, 4, -radius * 0.1))
    trim.push(cylinder(radius * 0.14, radius * 0.14, 9, side * radius * 0.32, 8.8, -radius * 0.1, 12))
  }
  trim.push(box(radius * 1.3, 0.5, 0.5, 0, 12.2, -radius * 0.1))
  for (const x of [-0.62, 0, 0.62]) {
    trim.push(cylinder(0.18, 0.24, 15, radius * x, 8, radius * 0.55, 6))
  }
  return assemble(body, trim, [])
}

/**
 * Positions for the measured unit geometry. Slot layout is fixed per kind so a unit never wanders,
 * and the scene only varies each unit's height/fill from the measurement.
 */
export function facilitySlots(kind: FacilityKind, radius: number, count: number): FacilitySlot[] {
  const slots: FacilitySlot[] = []
  if (count <= 0) return slots

  switch (kind) {
    case 'powerPlant':
      slots.push({
        x: radius * 0.55,
        y: 0.5,
        z: -radius * 0.25,
        width: radius * 0.32,
        depth: radius * 0.32,
        minHeight: 4,
        maxHeight: 30,
        form: 'cylinder',
        radius: radius * 0.16,
      })
      return slots
    case 'reservoir':
      slots.push({
        x: 0,
        y: 0.5,
        z: -radius * 0.12,
        width: radius * 0.9,
        depth: radius * 0.9,
        minHeight: 2.5,
        maxHeight: 14,
        form: 'cylinder',
        radius: radius * 0.43,
      })
      return slots
    case 'carryForwardYard':
      slots.push({
        x: radius * 0.22,
        y: 0.5,
        z: radius * 0.22,
        width: radius * 1.05,
        depth: radius * 0.82,
        minHeight: 1.2,
        maxHeight: 12,
        form: 'column',
        radius: radius * 0.26,
      })
      return slots
    case 'delayGate':
    case 'interactiveRejectionGate':
      slots.push({
        x: 0,
        y: 1,
        z: radius * 0.13,
        width: radius * 0.9,
        depth: 0.7,
        minHeight: 0.8,
        maxHeight: 8,
        form: 'panel',
        radius: radius * 0.34,
      })
      return slots
    case 'backgroundRejectionGate':
      slots.push({
        x: 0,
        y: 1.6,
        z: radius * 0.16,
        width: radius * 1.05,
        depth: 0.8,
        minHeight: 1.2,
        maxHeight: 8.5,
        form: 'panel',
        radius: radius * 0.38,
      })
      return slots
    case 'surgeSubstation':
      slots.push({
        x: 0,
        y: 0.5,
        z: radius * 0.55,
        width: radius * 0.32,
        depth: radius * 0.32,
        minHeight: 3,
        maxHeight: 16,
        form: 'cylinder',
        radius: radius * 0.16,
      })
      return slots
  }
}
