import { capacityHeight, capacitySide } from './capacityAtlas'
import { stableHash } from './atlasLayout'
import type { CapacityAtlasItem } from './fabricContracts'
import { nearestOnPolyline, pointInPolygon, polygonArea } from './mapRibbon'

/**
 * Plans the small city that stands for one capacity in the server atlas.
 *
 * The atlas used to draw a capacity as a single box. That box carried the allocated size in its
 * footprint and nothing else, so a capacity read as a quantity rather than as a place, and entering
 * one changed metaphor entirely: the level above a city was not a bigger city, it was a bar chart.
 * A capacity is now a city on the atlas and a city again when entered, which is the whole point of
 * the two surfaces sharing one vocabulary.
 *
 * **Evidence boundary.** Exactly two things here are measured, and they are the same two the
 * capacity city measures one level down:
 *
 * | Encoded property | Evidence |
 * | --- | --- |
 * | City plot side | allocated bytes, through {@link capacitySide} |
 * | Tallest tower height | used bytes, through {@link capacityHeight} |
 *
 * Everything else follows from those two or is decoration. The lot grid follows from the plot,
 * because {@link LOT_PITCH} is one constant shared by every city: a larger capacity is a larger
 * city with more blocks in it, and block *size* never varies, so counting blocks and measuring the
 * plot say the same thing rather than two different things. The individual towers below the tallest
 * step down along a fixed profile jittered from the capacity's stable id; they are skyline, not
 * measurement, and a city's shape never changes between renders of the same capacity.
 *
 * Unknown stays unknown in both directions and never degrades into a small number. Unknown allocated
 * size yields no city at all -- {@link AtlasCityPlan.sizeKnown} is false and the scene draws the
 * nonquantitative parcel the legend's × marks. Known allocated size with unknown used size yields
 * the real plot and its real lot grid, but every lot is `vacant`: the ground was measured and the
 * skyline was not.
 */

/**
 * Target world units per lot, including that lot's share of the surrounding street. Constant across
 * every capacity city, which is what lets block count be read as plot area rather than as a separate
 * claim.
 *
 * Sized against the plot mapping rather than picked for looks. {@link capacitySide} spans 12 to 96
 * world units across its whole domain, so a pitch of 12 is what makes a block grid that actually
 * resolves differences over the range real capacities occupy -- a gigabyte is five blocks a side, a
 * terabyte six, a petabyte eight -- instead of rounding most of them to the same city.
 */
export const LOT_PITCH = 12

/**
 * Most blocks a city is divided into per side. The plot side is capped by {@link capacitySide} at 96
 * world units, so at the pitch above this bound is never actually reached; it exists so a future
 * change to either mapping cannot produce a grid of unreadable specks.
 */
export const MAX_COLUMNS = 8

/** Share of a grid cell given over to street. The rest is the building's footprint. */
export const STREET_RATIO = 0.36

/** Plot side used when allocated size is unknown. Nonquantitative: it stands for no measurement. */
export const UNKNOWN_SIDE = 26

/** Height of a fenced lot on a plot whose used size is unknown. Claims no skyline. */
export const VACANT_HEIGHT = 2.4

/** How much shorter the outermost ring of a skyline is than downtown, before jitter. Decoration. */
export const DOWNTOWN_FALLOFF = 0.55

/** Floor of the per-lot decorative jitter, so no tower collapses to nothing next to its neighbours. */
export const JITTER_FLOOR = 0.72

/**
 * Vertices around a town's edge. Enough that the boundary reads as a curve at the framing the atlas
 * actually uses, few enough that a hundred towns is still a trivial amount of geometry.
 */
export const OUTLINE_VERTICES = 48

/**
 * The three harmonics that bend a town's edge, as fractions of its mean radius.
 *
 * Three, not one: a single sine is an oval and reads as a deliberate shape rather than as a place.
 * Their sum is 0.33, comfortably under 1, which is what guarantees the radius stays positive and the
 * outline stays star-shaped — a radial function of a single angle cannot self-intersect, so no town
 * can ever fold through itself however the seed falls.
 */
export const OUTLINE_HARMONICS = [
  { period: 3, amplitude: 0.16 },
  { period: 5, amplitude: 0.1 },
  { period: 7, amplitude: 0.07 },
] as const

/** Where the ring road sits, as a fraction of the town's radius at each angle. */
export const RING_ROAD_FRACTION = 0.62

/** Where a radial road runs out to, as a fraction of the town's radius. */
export const RADIAL_ROAD_FRACTION = 0.99

/**
 * How far the centre of a lot may drift inside its own cell, as a fraction of the cell.
 *
 * Small on purpose. Enough that a block of buildings stops reading as extruded graph paper, not so
 * much that the constant block pitch -- the thing that lets block count be read as ground area --
 * stops being visible in the spacing.
 */
export const LOT_JITTER = 0.3

/** Half-width of the corridor kept clear of buildings along every street centreline. */
export const STREET_CLEARANCE = 1.9

export type AtlasCityLotKind = 'tower' | 'vacant'

export interface AtlasCityLot {
  /** Lot centre relative to the city centre, in world units. */
  readonly x: number
  readonly z: number
  readonly footprint: number
  readonly height: number
  readonly kind: AtlasCityLotKind
  /** Stable per-lot seed. Decoration only; never gates a measurement. */
  readonly seed: number
}

/** A point relative to a town's centre, in world units. */
export interface AtlasPoint {
  readonly x: number
  readonly z: number
}

/** How a street is drawn. Hierarchy is decoration here; nothing about a town's roads is measured. */
export type AtlasStreetKind = 'ring' | 'radial'

/** A street centreline, relative to the city centre. Drawn as a line, never as a claim. */
export interface AtlasCityStreet {
  readonly points: readonly AtlasPoint[]
  readonly kind: AtlasStreetKind
}

export interface AtlasCityPlan {
  readonly capacityId: string
  /** Plot side in world units: the encoded allocated size, or {@link UNKNOWN_SIDE} when unknown. */
  readonly side: number
  /** False when allocated size is unknown, in which case there are no lots and no streets. */
  readonly sizeKnown: boolean
  /** Encoded used size: the height of the tallest tower. Null when used size is unknown. */
  readonly towerHeight: number | null
  readonly columns: number
  /**
   * The town's edge: a closed, irregular polygon whose **area is exactly `side * side`**.
   *
   * The plot used to be that square, drawn as a square, and a hundred squares on a sheet is a
   * spreadsheet rather than an atlas. What the allocated size actually buys is ground, and ground is
   * an area; the square was only ever one of infinitely many shapes with that area, and the least
   * map-like of them. So the measurement is unchanged and the shape is free, which is the same trade
   * the capacity city already makes when it draws a block.
   */
  readonly outline: readonly AtlasPoint[]
  /** Largest and smallest radius of {@link outline}, for framing and for fitting lots inside it. */
  readonly radius: { readonly min: number; readonly max: number }
  readonly lots: readonly AtlasCityLot[]
  readonly streets: readonly AtlasCityStreet[]
  /**
   * Where a town's radial roads meet its edge.
   *
   * Regional roads aim at these rather than at the town centre, so a highway arrives on a street
   * instead of ending in the middle of a built-up area -- which is how a road joins a town on any
   * printed map, and the detail that stops the sheet reading as a node-and-edge diagram.
   */
  readonly gateways: readonly AtlasPoint[]
}

/**
 * Blocks per side for a plot. Rounds rather than floors so a plot just under a whole block still
 * gains it, and never returns zero, so the smallest measured capacity is a one-block hamlet rather
 * than bare ground -- bare ground already means "unknown".
 */
export function cityColumns(side: number): number {
  if (!Number.isFinite(side) || side <= 0) return 1
  return Math.min(MAX_COLUMNS, Math.max(1, Math.round(side / LOT_PITCH)))
}

/**
 * Relative tower heights across a city, normalized so the tallest is exactly 1.
 *
 * Normalizing is what keeps the skyline honest: whatever the town's shape and whatever the jitter,
 * one tower reaches the full encoded height, so the tallest roofline of two cities can be compared
 * directly and answers "which capacity has more used bytes".
 *
 * Takes each lot's normalized distance from the centre rather than a grid size, because towns are no
 * longer grids. Downtown is still the middle and the edges still fall away, which is the shape almost
 * every real skyline has, but it now follows an irregular boundary instead of a square one.
 */
export function skylineProfile(
  rings: readonly number[],
  seedFor: (index: number) => number,
): number[] {
  const raw = rings.map((ring, index) => {
    const clamped = Math.min(1, Math.max(0, ring))
    const jitter = JITTER_FLOOR + ((seedFor(index) % 1000) / 1000) * (1 - JITTER_FLOOR)
    return (1 - clamped * DOWNTOWN_FALLOFF) * jitter
  })
  const peak = raw.length > 0 ? Math.max(...raw) : 0
  return peak > 0 ? raw.map(value => value / peak) : raw.map(() => 1)
}

/**
 * The irregular edge of a town whose plot is `side` on a side.
 *
 * A radius that wobbles with three harmonics of the angle, then scaled so the enclosed area is
 * exactly `side * side`. The measurement survives the change of shape intact -- allocated size is
 * still the ground the town covers, and area is what a reader actually perceives on a map, more
 * reliably than they read the edge length of a square.
 */
export function townOutline(side: number, capacityId: string): AtlasPoint[] {
  const phases = OUTLINE_HARMONICS.map(
    (_, index) => ((stableHash(`${capacityId}:outline:${index}`) % 3600) / 3600) * Math.PI * 2,
  )
  const unit: AtlasPoint[] = []
  for (let index = 0; index < OUTLINE_VERTICES; index += 1) {
    const angle = (index / OUTLINE_VERTICES) * Math.PI * 2
    let radius = 1
    for (let harmonic = 0; harmonic < OUTLINE_HARMONICS.length; harmonic += 1) {
      const { period, amplitude } = OUTLINE_HARMONICS[harmonic]
      radius += amplitude * Math.sin(angle * period + phases[harmonic])
    }
    unit.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius })
  }
  const area = polygonArea(unit)
  const scale = area > 0 ? Math.sqrt((side * side) / area) : 1
  return unit.map(point => ({ x: point.x * scale, z: point.z * scale }))
}

/**
 * Distance from the centre to the town's edge at an arbitrary angle.
 *
 * The outline samples evenly in angle, so this is a lookup and a lerp rather than a ray cast.
 */
export function outlineRadiusAt(outline: readonly AtlasPoint[], angle: number): number {
  if (outline.length === 0) return 0
  const turns = angle / (Math.PI * 2)
  const position = (turns - Math.floor(turns)) * outline.length
  const low = Math.floor(position) % outline.length
  const high = (low + 1) % outline.length
  const blend = position - Math.floor(position)
  const a = Math.hypot(outline[low].x, outline[low].z)
  const b = Math.hypot(outline[high].x, outline[high].z)
  return a + (b - a) * blend
}

export function planAtlasCity(capacity: CapacityAtlasItem): AtlasCityPlan {
  const side = capacitySide(capacity)
  if (side === null) {
    return {
      capacityId: capacity.capacityId,
      side: UNKNOWN_SIDE,
      sizeKnown: false,
      towerHeight: null,
      columns: 0,
      outline: townOutline(UNKNOWN_SIDE, capacity.capacityId),
      radius: { min: 0, max: 0 },
      lots: [],
      streets: [],
      gateways: [],
    }
  }

  const towerHeight = capacityHeight(capacity)
  const columns = cityColumns(side)
  const cell = side / columns
  const footprint = cell * (1 - STREET_RATIO)
  const outline = townOutline(side, capacity.capacityId)
  const radii = outline.map(point => Math.hypot(point.x, point.z))
  const radius = { min: Math.min(...radii), max: Math.max(...radii) }
  const streets = townStreets(outline, capacity.capacityId)

  /*
   * Lay the same constant-pitch grid the square plot used, then keep only the cells the town's
   * outline contains and its streets do not run through. Block pitch is what makes block count
   * readable as area across every city, so it stays fixed; all that changes is which cells survive.
   *
   * Two things stop the survivors reading as a lattice with a blob cropped out of it. The grid is
   * rotated by a seeded angle, so no two towns share an axis and none of them share the viewer's;
   * and every lot is nudged inside its own cell. Both are decoration, and neither can move a lot out
   * of the ground its capacity paid for -- a lot counts as placed only when all four of its corners
   * are still inside the outline.
   */
  const spin = ((stableHash(`${capacity.capacityId}:spin`) % 900) / 900) * (Math.PI / 2)
  const cos = Math.cos(spin)
  const sin = Math.sin(spin)
  const span = Math.ceil((radius.max * 2) / cell) + 2
  const half = footprint / 2
  const clearance = STREET_CLEARANCE + half * 0.35
  const placed: Array<{ x: number; z: number; ring: number }> = []
  for (let row = 0; row < span; row += 1) {
    for (let column = 0; column < span; column += 1) {
      const localX = (column - (span - 1) / 2) * cell
      const localZ = (row - (span - 1) / 2) * cell
      const key = `${capacity.capacityId}:jitter:${row}:${column}`
      const jitterX = ((stableHash(`${key}:x`) % 1000) / 1000 - 0.5) * cell * LOT_JITTER
      const jitterZ = ((stableHash(`${key}:z`) % 1000) / 1000 - 0.5) * cell * LOT_JITTER
      let x = (localX + jitterX) * cos - (localZ + jitterZ) * sin
      let z = (localX + jitterX) * sin + (localZ + jitterZ) * cos

      /*
       * A lot that lands on a street is moved to the kerb rather than deleted.
       *
       * Deleting was the obvious thing and it was wrong twice over: it emptied small towns entirely,
       * and it broke the one claim lot count makes -- that a town's buildings fill the ground its
       * allocated size paid for. Nudging keeps the count, and buildings that crowd up to a street
       * front is what a town actually looks like from above.
       */
      for (const street of streets) {
        const near = nearestOnPolyline(street.points, x, z)
        if (near.distance >= clearance) continue
        const dx = x - near.x
        const dz = z - near.z
        const length = Math.hypot(dx, dz)
        const ux = length > 1e-6 ? dx / length : Math.cos(spin)
        const uz = length > 1e-6 ? dz / length : Math.sin(spin)
        x = near.x + ux * clearance
        z = near.z + uz * clearance
      }

      const inside =
        pointInPolygon(outline, x - half, z - half) &&
        pointInPolygon(outline, x + half, z - half) &&
        pointInPolygon(outline, x - half, z + half) &&
        pointInPolygon(outline, x + half, z + half)
      if (!inside) continue

      const reach = outlineRadiusAt(outline, Math.atan2(z, x))
      placed.push({ x, z, ring: reach > 0 ? Math.min(1, Math.hypot(x, z) / reach) : 0 })
    }
  }

  /*
   * A town small enough that no whole lot fits inside its own outline still has to be a town. Shrink
   * one central building until it fits rather than drawing bare ground, because bare ground is
   * already spoken for: it means the size is unknown.
   */
  if (placed.length === 0) placed.push({ x: 0, z: 0, ring: 0 })
  const fitted = Math.min(footprint, (radius.min * 2) / Math.SQRT2)

  const seeds = placed.map((_, index) => stableHash(`${capacity.capacityId}:${index}`))
  const profile = skylineProfile(
    placed.map(lot => lot.ring),
    index => seeds[index] ?? 0,
  )

  const lots: AtlasCityLot[] = placed.map((lot, index) => ({
    x: lot.x,
    z: lot.z,
    footprint: fitted,
    height: towerHeight === null ? VACANT_HEIGHT : towerHeight * (profile[index] ?? 1),
    kind: towerHeight === null ? 'vacant' : 'tower',
    seed: seeds[index] ?? 0,
  }))

  return {
    capacityId: capacity.capacityId,
    side,
    sizeKnown: true,
    towerHeight,
    columns,
    outline,
    radius,
    lots,
    streets,
    gateways: streets
      .filter(street => street.kind === 'radial')
      .map(street => street.points[street.points.length - 1]),
  }
}

/**
 * A town's streets: one ring road, and three to six roads radiating out from the centre to the edge.
 *
 * This replaces a literal lattice of every block edge in both directions. At the scale the atlas
 * draws a town -- a couple of centimetres across -- a lattice is a hatch pattern, indistinguishable
 * from every other town's, and it was the same graph-paper look already removed from the capacity
 * city. A ring and its radials is the oldest legible plan there is, resolves at any size, and gives
 * every town a different signature because the count, the angles and the bow all come from its seed.
 *
 * Nothing here is measured. The roads inside a town are drawn because towns have roads.
 */
export function townStreets(
  outline: readonly AtlasPoint[],
  capacityId: string,
): AtlasCityStreet[] {
  if (outline.length < 3) return []
  const streets: AtlasCityStreet[] = []

  streets.push({
    kind: 'ring',
    points: [
      ...outline.map(point => ({
        x: point.x * RING_ROAD_FRACTION,
        z: point.z * RING_ROAD_FRACTION,
      })),
      { x: outline[0].x * RING_ROAD_FRACTION, z: outline[0].z * RING_ROAD_FRACTION },
    ],
  })

  const count = 3 + (stableHash(`${capacityId}:radials`) % 4)
  const start = ((stableHash(`${capacityId}:radial-start`) % 3600) / 3600) * Math.PI * 2
  for (let index = 0; index < count; index += 1) {
    const skew = ((stableHash(`${capacityId}:radial:${index}`) % 1000) / 1000 - 0.5) * 0.55
    const angle = start + (index / count) * Math.PI * 2 + skew
    const reach = outlineRadiusAt(outline, angle) * RADIAL_ROAD_FRACTION
    const bow = (((stableHash(`${capacityId}:bow:${index}`) % 1000) / 1000) - 0.5) * 0.34
    const dirX = Math.cos(angle)
    const dirZ = Math.sin(angle)
    const points: AtlasPoint[] = []
    const steps = 7
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const lateral = Math.sin(t * Math.PI) * bow * reach
      points.push({
        x: dirX * reach * t - dirZ * lateral,
        z: dirZ * reach * t + dirX * lateral,
      })
    }
    streets.push({ kind: 'radial', points })
  }
  return streets
}

/**
 * The centreline of the road between two towns that reference each other.
 *
 * Was a straight line between two town centres, which is a node-and-edge diagram: it ran *through*
 * both towns and arrived nowhere in particular. It now leaves one town at a gateway -- the outer end
 * of one of its own radial streets -- and arrives at the other's, bowing gently in between, so a road
 * joins a town on a street the way it does on any printed map.
 *
 * Pure and seeded, so a given reference draws the same road every session. Nothing it returns is
 * measured; the reference's confidence is what the drawn road encodes, and that is decided elsewhere.
 */
export function regionalRoadPath(
  from: AtlasPoint,
  fromPlan: AtlasCityPlan | undefined,
  to: AtlasPoint,
  toPlan: AtlasCityPlan | undefined,
  seedKey: string,
  steps = 16,
): AtlasPoint[] {
  const start = gatewayToward(from, fromPlan, to)
  const end = gatewayToward(to, toPlan, from)
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-3) return []

  // A dead-straight road between every pair reads as a wire diagram. A small seeded bow, capped in
  // world units so a long road does not swing wildly, makes them read as routes.
  const bow = (((stableHash(seedKey) % 1000) / 1000) - 0.5) * Math.min(length * 0.16, 46)
  const points: AtlasPoint[] = []
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const lateral = Math.sin(t * Math.PI) * bow
    points.push({
      x: start.x + dx * t - (dz / length) * lateral,
      z: start.z + dz * t + (dx / length) * lateral,
    })
  }
  return points
}

/**
 * The point on a town's edge a road toward `target` should arrive at.
 *
 * Picks the gateway whose direction from the centre best matches the direction of travel. A town with
 * no streets -- which means a capacity whose allocated size is unknown -- keeps its centre, because
 * it has no edge worth arriving at.
 */
export function gatewayToward(
  center: AtlasPoint,
  plan: AtlasCityPlan | undefined,
  target: AtlasPoint,
): AtlasPoint {
  if (!plan || plan.gateways.length === 0) return { x: center.x, z: center.z }
  const dx = target.x - center.x
  const dz = target.z - center.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) return { x: center.x, z: center.z }
  let best = plan.gateways[0]
  let bestScore = -Infinity
  for (const gateway of plan.gateways) {
    const reach = Math.hypot(gateway.x, gateway.z)
    if (reach < 1e-6) continue
    const score = (gateway.x * dx + gateway.z * dz) / (reach * length)
    if (score > bestScore) {
      bestScore = score
      best = gateway
    }
  }
  return { x: center.x + best.x, z: center.z + best.z }
}

/**
 * Signature of everything that changes a city's geometry. The atlas refreshes on a timer, and a
 * refresh that moved no bytes must not churn the GPU, so the scene caches merged geometry by this.
 */
export function cityGeometrySignature(plan: AtlasCityPlan): string {
  return `${plan.capacityId}|${plan.sizeKnown ? plan.side.toFixed(4) : 'unknown'}|${plan.towerHeight?.toFixed(4) ?? 'unknown'}`
}
