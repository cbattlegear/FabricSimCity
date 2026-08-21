import { mulberry32 } from './citySeed'
import { stableHash } from './atlasLayout'
import type { Point } from './cityRoads'

/**
 * Where the city's junctions actually stand.
 *
 * The map used to compute every intersection as `col * pitchX, row * pitchZ`, and then draw curved
 * segments between those points. That is why it read as a wiggly grid no matter how hard the curves
 * were pushed: the *junctions* were still a perfect lattice, and junctions are what the eye reads a
 * street network by. Bending the line between two grid points does not stop them being grid points.
 *
 * This module is the fix. It owns the mapping from lattice coordinates to world coordinates, and it
 * is the only place allowed to know it. Everything downstream — streets, lots, land cover, terrain,
 * routing — asks here rather than multiplying by a pitch. The lattice survives as *topology*, which
 * is what keeps a building's address stable when a page is appended, but it stops being *geometry*.
 *
 * Four things happen to a node, in order:
 *
 * 1. **Spans.** Column and row spacing vary instead of being constant, so blocks are tight in the
 *    middle of town and generous at the edges. This is the one real cities are most consistent about
 *    and the cheapest to state: a downtown block is small because land was expensive when it was
 *    surveyed.
 * 2. **Meander.** A low-frequency displacement field applied to every node, arterials included, so
 *    whole corridors drift together and the skeleton wanders like a road that followed a valley.
 * 3. **District rotation.** Each arterial cell twists its own interior about its centre, faded to
 *    nothing at the cell edge. Neighbouring quarters end up at noticeably different angles, which is
 *    what Boston, San Francisco and half of London do and what no amount of noise imitates.
 * 4. **Plaza pull.** Nodes near a plaza are drawn toward it, opening a square where several streets
 *    converge. A lattice has no convergence points at all; a real city is legible mostly because of
 *    them.
 *
 * None of it is measured, and none of it may move a building into the carriageway — see
 * {@link fitDisplacement}, which is what makes that a guarantee rather than a hope.
 */

/**
 * How much bigger than the strict minimum a block is, before any warping.
 *
 * A block packed exactly to `cell + streetWidth` has no room to deform: any displacement at all puts
 * a corner inside a building. This is the headroom the whole warp is spent out of, so it is the
 * budget for every curve on the map.
 *
 * It is deliberately close to 1. Headroom compounds with {@link MAX_SPAN} into the *average* block,
 * and an average block much larger than the building it holds leaves every plot marooned in its own
 * field — a city that curves nicely but reads as suburbs. 1.3 is the most that could be spent before
 * the sparseness showed.
 */
export const WARP_HEADROOM = 1.3

/**
 * Widest a span may get, as a multiple of the base pitch.
 *
 * Spans only ever widen, never narrow, because a narrow one would pinch a building into the road and
 * there is no headroom to spare for it. So this is a tax on the average block as well as a source of
 * variety, and it is kept modest for the same reason the headroom is.
 */
const MAX_SPAN = 1.34

/** How far a node may drift under the meander, as a fraction of the base pitch. */
const MEANDER_AMPLITUDE = 0.32

/** Strongest twist a district may take, in radians. About 11 degrees. */
const MAX_DISTRICT_TWIST = 0.2

/** How hard a plaza pulls its neighbours in, as a fraction of the base pitch. */
const PLAZA_PULL = 0.55

/** Lattice radius a plaza's pull reaches across. */
const PLAZA_REACH = 2.2

/**
 * Halvings of the displacement field allowed while looking for one that keeps every building out of
 * the road. Eight is far more than enough: the field is tuned to pass at full strength, and a scale
 * of zero is the plain lattice, which passes trivially.
 */
const FIT_ATTEMPTS = 8

/** Which side of a block a kerb is on. `north` is the lattice north, not necessarily world north. */
export type BlockEdge = 'north' | 'south' | 'west' | 'east'

export interface WarpPlaza {
  readonly col: number
  readonly row: number
  readonly x: number
  readonly z: number
}

export interface CityWarpInput {
  readonly blockCols: number
  readonly blockRows: number
  /** Base block pitch, already including {@link WARP_HEADROOM}. */
  readonly pitchX: number
  readonly pitchZ: number
  /** Side of the square a building occupies. The warp may never encroach on it. */
  readonly cell: number
  readonly streetWidth: number
  /**
   * The lattice lines carrying arterials, ascending and spanning the whole city.
   *
   * These are the seams a district twist fades out at, so the twist has to know where they are. A
   * fixed rhythm would put them back on a regular pitch and hand the map its grid straight back.
   */
  readonly arterialCols: readonly number[]
  readonly arterialRows: readonly number[]
  readonly seed: string
  /** Lattice nodes that carry a public square. */
  readonly plazas: readonly { readonly col: number; readonly row: number }[]
}

export interface CityWarp {
  readonly blockCols: number
  readonly blockRows: number
  readonly pitchX: number
  readonly pitchZ: number
  /** World position of the lattice node at the given corner coordinates. */
  node(col: number, row: number): Point
  /** The four corners of a block, clockwise from its north-west. */
  blockCorners(col: number, row: number): readonly [Point, Point, Point, Point]
  /** Centroid of a block, which is where its building stands. */
  blockCenter(col: number, row: number): Point
  /**
   * Midpoint of one of a block's kerbs, which is the frontage a building is entered from.
   *
   * Defaults to the north kerb, which is where a door is hung before the street network has settled.
   * Once it has, a building may be rebound to whichever of its four edges survived.
   */
  blockFrontage(col: number, row: number, edge?: BlockEdge): Point
  /** Lattice node nearest a world point. */
  nearestNode(x: number, z: number): { col: number; row: number }
  /** Block containing a world point, clamped to the city. */
  blockAt(x: number, z: number): { col: number; row: number }
  /** How much of the displacement field survived {@link fitDisplacement}. Diagnostics and tests. */
  readonly strength: number
  readonly plazas: readonly WarpPlaza[]
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

interface Displacement {
  readonly x: number
  readonly z: number
}

export function planWarp(input: CityWarpInput): CityWarp {
  const { blockCols, blockRows, pitchX, pitchZ } = input
  const rng = mulberry32(stableHash(`${input.seed}::warp`))

  const colOffsets = spanOffsets(blockCols, pitchX, rng, `${input.seed}::span:x`)
  const rowOffsets = spanOffsets(blockRows, pitchZ, rng, `${input.seed}::span:z`)
  const base = (col: number, row: number): Point => ({
    x: sampleOffsets(colOffsets, col),
    z: sampleOffsets(rowOffsets, row),
  })

  const meander = meanderField(rng, pitchX, pitchZ)
  const twists = districtTwists(input)
  const plazas = input.plazas.map(plaza => ({ ...plaza, ...base(plaza.col, plaza.row) }))

  const displace = (col: number, row: number): Displacement => {
    const at = base(col, row)
    const drift = meanderAt(meander, at)
    const twist = twistAt(twists, input, col, row, at, base)
    const pull = plazaPullAt(plazas, at, col, row, input)
    return { x: drift.x + twist.x + pull.x, z: drift.z + twist.z + pull.z }
  }

  const strength = fitDisplacement(input, base, displace)
  const cache = new Map<string, Point>()
  const node = (col: number, row: number): Point => {
    const key = `${col}:${row}`
    const cached = cache.get(key)
    if (cached) return cached
    const at = base(col, row)
    const shift = displace(col, row)
    const point = { x: at.x + shift.x * strength, z: at.z + shift.z * strength }
    cache.set(key, point)
    return point
  }

  const blockCorners = (col: number, row: number) =>
    [
      node(col, row),
      node(col + 1, row),
      node(col + 1, row + 1),
      node(col, row + 1),
    ] as const

  const blockCenter = (col: number, row: number) => centroid(blockCorners(col, row))

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col <= blockCols; col += 1) {
      const point = node(col, row)
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.z < minZ) minZ = point.z
      if (point.z > maxZ) maxZ = point.z
    }
  }

  /*
   * The inverse mapping, by search rather than by division.
   *
   * `Math.round(x / pitch)` inverted the old lattice exactly. It cannot invert this one, so a first
   * guess is taken from the base spans and then a small neighbourhood around it is checked properly.
   * The radius only has to cover the displacement budget, which is well under two blocks.
   */
  const guess = (offsets: readonly number[], value: number) => {
    let best = 0
    for (let index = 1; index < offsets.length; index += 1) {
      if (Math.abs(offsets[index] - value) < Math.abs(offsets[best] - value)) best = index
    }
    return best
  }

  const nearestNode = (x: number, z: number) => {
    const startCol = guess(colOffsets, x)
    const startRow = guess(rowOffsets, z)
    let bestCol = startCol
    let bestRow = startRow
    let bestDistance = Infinity
    for (let row = startRow - 3; row <= startRow + 3; row += 1) {
      if (row < 0 || row > blockRows) continue
      for (let col = startCol - 3; col <= startCol + 3; col += 1) {
        if (col < 0 || col > blockCols) continue
        const point = node(col, row)
        const distance = (point.x - x) ** 2 + (point.z - z) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          bestCol = col
          bestRow = row
        }
      }
    }
    return { col: bestCol, row: bestRow }
  }

  const blockAt = (x: number, z: number) => {
    const startCol = clamp(guess(colOffsets, x), 0, Math.max(0, blockCols - 1))
    const startRow = clamp(guess(rowOffsets, z), 0, Math.max(0, blockRows - 1))
    let bestCol = startCol
    let bestRow = startRow
    let bestDistance = Infinity
    for (let row = startRow - 3; row <= startRow + 3; row += 1) {
      if (row < 0 || row >= blockRows) continue
      for (let col = startCol - 3; col <= startCol + 3; col += 1) {
        if (col < 0 || col >= blockCols) continue
        const centre = blockCenter(col, row)
        const distance = (centre.x - x) ** 2 + (centre.z - z) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          bestCol = col
          bestRow = row
        }
      }
    }
    return { col: bestCol, row: bestRow }
  }

  return {
    blockCols,
    blockRows,
    pitchX,
    pitchZ,
    node,
    blockCorners,
    blockCenter,
    blockFrontage: (col, row, edge = 'north') => {
      switch (edge) {
        case 'south':
          return midpoint(node(col, row + 1), node(col + 1, row + 1))
        case 'west':
          return midpoint(node(col, row), node(col, row + 1))
        case 'east':
          return midpoint(node(col + 1, row), node(col + 1, row + 1))
        default:
          return midpoint(node(col, row), node(col + 1, row))
      }
    },
    nearestNode,
    blockAt,
    strength,
    plazas,
    minX,
    maxX,
    minZ,
    maxZ,
  }
}

/**
 * Cumulative offsets for a run of lattice lines whose spacing varies.
 *
 * Spans only ever widen, never narrow. A block that shrank below the base pitch would put a building
 * through its own kerb, and no amount of downstream clamping fixes that as cleanly as never doing it.
 * The shape is a radial term — tight in the middle, loose at the edge, which is how towns actually
 * grew — plus a seeded wave so the widening is not a smooth ramp anyone could read as a gradient.
 */
function spanOffsets(
  count: number,
  pitch: number,
  rng: () => number,
  seed: string,
): number[] {
  const wave = mulberry32(stableHash(seed))
  const frequency = 0.6 + wave() * 0.9
  const phase = wave() * Math.PI * 2
  const swell = 0.35 + rng() * 0.3
  const centre = (count - 1) / 2
  const reach = Math.max(1, centre)

  const offsets = [0]
  for (let index = 0; index < count; index += 1) {
    const radius = Math.min(1, Math.abs(index - centre) / reach)
    const outward = radius ** 1.6
    const ripple = (Math.sin(index * frequency + phase) + 1) / 2
    const span = 1 + (MAX_SPAN - 1) * (outward * (1 - swell) + ripple * swell)
    offsets.push(offsets[index] + pitch * span)
  }
  return offsets
}

interface MeanderField {
  readonly amplitudeX: number
  readonly amplitudeZ: number
  readonly terms: readonly {
    readonly frequency: number
    readonly phase: number
    readonly cross: number
    readonly weight: number
  }[]
}

/**
 * The field that makes whole corridors drift together.
 *
 * Displacing each node independently produces gravel. Sampling a smooth field means a street and the
 * street beside it lean the same way, so what the eye picks up is a bend in the city rather than
 * noise in the data. Two octaves: one long enough to move a whole quarter, one short enough to stop
 * the first reading as a single arc.
 */
function meanderField(rng: () => number, pitchX: number, pitchZ: number): MeanderField {
  const terms = []
  for (let index = 0; index < 3; index += 1) {
    terms.push({
      frequency: (0.0016 + rng() * 0.0022) * (index + 1),
      phase: rng() * Math.PI * 2,
      cross: (rng() - 0.5) * 0.0016,
      weight: 1 / (index + 1),
    })
  }
  return {
    amplitudeX: pitchX * MEANDER_AMPLITUDE,
    amplitudeZ: pitchZ * MEANDER_AMPLITUDE,
    terms,
  }
}

function meanderAt(field: MeanderField, at: Point): Displacement {
  let x = 0
  let z = 0
  let total = 0
  for (const term of field.terms) {
    x += Math.sin(at.z * term.frequency + at.x * term.cross + term.phase) * term.weight
    z += Math.cos(at.x * term.frequency + at.z * term.cross + term.phase * 1.7) * term.weight
    total += term.weight
  }
  return { x: (x / total) * field.amplitudeX, z: (z / total) * field.amplitudeZ }
}

interface DistrictTwist {
  readonly angle: number
}

/**
 * A rotation per arterial cell.
 *
 * This is the layer that stops the map reading as one surveyed plan. Real cities are collages: a
 * quarter laid out in one decade sits at a stubborn angle to the one next to it, and the seam between
 * them is one of the most recognisable things on any city map. The twist is faded to nothing at the
 * cell boundary so the arterial skeleton stays continuous and every street still meets its junction.
 */
function districtTwists(input: CityWarpInput): Map<string, DistrictTwist> {
  const twists = new Map<string, DistrictTwist>()
  for (let row = 0; row < Math.max(1, input.arterialRows.length - 1); row += 1) {
    for (let col = 0; col < Math.max(1, input.arterialCols.length - 1); col += 1) {
      const rng = mulberry32(stableHash(`${input.seed}::twist::${col}:${row}`))
      twists.set(`${col}:${row}`, { angle: (rng() * 2 - 1) * MAX_DISTRICT_TWIST })
    }
  }
  return twists
}

/** Index of the arterial cell a lattice line falls in, plus how far across that cell it sits. */
function cellPosition(lines: readonly number[], at: number): { index: number; local: number } {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const from = lines[index]
    const to = lines[index + 1]
    if (at >= from && at <= to) {
      return { index, local: to === from ? 0 : (at - from) / (to - from) }
    }
  }
  const last = Math.max(0, lines.length - 2)
  return { index: last, local: at <= lines[0] ? 0 : 1 }
}

function twistAt(
  twists: Map<string, DistrictTwist>,
  input: CityWarpInput,
  col: number,
  row: number,
  at: Point,
  base: (col: number, row: number) => Point,
): Displacement {
  const across = cellPosition(input.arterialCols, col)
  const down = cellPosition(input.arterialRows, row)
  const twist = twists.get(`${across.index}:${down.index}`)
  if (!twist) return { x: 0, z: 0 }

  // Zero on the cell boundary, one in the middle: a raised cosine in each axis.
  const fade = bump(across.local) * bump(down.local)
  if (fade <= 0) return { x: 0, z: 0 }

  const pivot = base(
    (input.arterialCols[across.index] + input.arterialCols[across.index + 1]) / 2,
    (input.arterialRows[down.index] + input.arterialRows[down.index + 1]) / 2,
  )
  const dx = at.x - pivot.x
  const dz = at.z - pivot.z
  const angle = twist.angle * fade
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: dx * cos - dz * sin - dx, z: dx * sin + dz * cos - dz }
}

/** Raised cosine on [0,1], zero at both ends. */
function bump(t: number): number {
  if (t <= 0 || t >= 1) return 0
  return (1 - Math.cos(t * Math.PI * 2)) / 2
}

/**
 * The pull that opens a square.
 *
 * A lattice has no convergence points: every junction is the same crossing of two lines. A real city
 * is navigated by its squares — the place several streets arrive at together, which is why they get
 * names and why directions are given in terms of them. Drawing the surrounding nodes toward one point
 * widens the ground around it and leaves the streets fanning in, which is the whole effect.
 */
function plazaPullAt(
  plazas: readonly WarpPlaza[],
  at: Point,
  col: number,
  row: number,
  input: CityWarpInput,
): Displacement {
  let x = 0
  let z = 0
  for (const plaza of plazas) {
    const lattice = Math.hypot(col - plaza.col, row - plaza.row)
    if (lattice > PLAZA_REACH || lattice < 1e-9) continue
    // Strongest on the ring right beside the square, fading to nothing at the edge of its reach.
    const weight = (1 - lattice / PLAZA_REACH) ** 2
    const dx = plaza.x - at.x
    const dz = plaza.z - at.z
    const distance = Math.hypot(dx, dz)
    if (distance < 1e-9) continue
    x += (dx / distance) * input.pitchX * PLAZA_PULL * weight
    z += (dz / distance) * input.pitchZ * PLAZA_PULL * weight
  }
  return { x, z }
}

/**
 * How much of the displacement field the city can actually afford.
 *
 * Every block has to keep a `cell x cell` square clear at its centroid with half a carriageway of
 * kerb around it, because that is where its building goes and the road runs along its edge. The warp
 * is tuned to leave that room, but "tuned to" is not "guaranteed to" — a seed is free to line three
 * layers up and pinch one block somewhere in a city of a thousand.
 *
 * So the field is measured rather than trusted. Take the whole displacement at full strength, check
 * every block, and if any one of them is pinched, halve the strength and check again. Zero strength
 * is the plain lattice with {@link WARP_HEADROOM} of slack in it, which cannot fail, so this
 * terminates. In practice it returns 1 on the first pass; when it does not, the city bends slightly
 * less rather than putting a building in the road.
 */
function fitDisplacement(
  input: CityWarpInput,
  base: (col: number, row: number) => Point,
  displace: (col: number, row: number) => Displacement,
): number {
  const required = input.cell / 2 + input.streetWidth / 2
  let strength = 1

  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt += 1) {
    let worst = Infinity
    for (let row = 0; row < input.blockRows; row += 1) {
      for (let col = 0; col < input.blockCols; col += 1) {
        const corners = [
          [col, row],
          [col + 1, row],
          [col + 1, row + 1],
          [col, row + 1],
        ].map(([c, r]) => {
          const at = base(c, r)
          const shift = displace(c, r)
          return { x: at.x + shift.x * strength, z: at.z + shift.z * strength }
        }) as [Point, Point, Point, Point]
        const room = inradius(corners)
        if (room < worst) worst = room
        if (worst < required) break
      }
      if (worst < required) break
    }
    if (worst >= required) return strength
    strength /= 2
  }
  return 0
}

/** Distance from a quadrilateral's centroid to its nearest edge. */
export function inradius(corners: readonly [Point, Point, Point, Point]): number {
  const middle = centroid(corners)
  let smallest = Infinity
  for (let index = 0; index < 4; index += 1) {
    const from = corners[index]
    const to = corners[(index + 1) % 4]
    const distance = distanceToSegment(middle, from, to)
    if (distance < smallest) smallest = distance
  }
  return smallest
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared < 1e-12) return Math.hypot(point.x - from.x, point.z - from.z)
  const t = clamp(((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared, 0, 1)
  return Math.hypot(point.x - (from.x + dx * t), point.z - (from.z + dz * t))
}

export function centroid(points: readonly Point[]): Point {
  let x = 0
  let z = 0
  for (const point of points) {
    x += point.x
    z += point.z
  }
  return { x: x / points.length, z: z / points.length }
}

function midpoint(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
}

/**
 * The base offset of a lattice line, interpolating between lines for fractional coordinates.
 *
 * District pivots sit at the middle of an arterial cell, which lands on a half-line whenever the cell
 * is an odd number of blocks across, so this cannot be a plain array lookup.
 */
function sampleOffsets(offsets: readonly number[], index: number): number {
  const limit = offsets.length - 1
  const at = clamp(index, 0, limit)
  const low = Math.floor(at)
  const high = Math.min(limit, low + 1)
  return offsets[low] + (offsets[high] - offsets[low]) * (at - low)
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
