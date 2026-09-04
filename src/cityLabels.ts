import * as THREE from 'three'

/**
 * Ground labels that name each building, facility and neighbourhood on the map.
 *
 * A label carries identity and nothing else. It never restates a measurement and never qualifies
 * one: footprint, height, roof cap, road width, lane width, and colour keep their documented
 * meanings, and reading a label tells you only which object you are looking at.
 *
 * A building label is the bare object name. It used to be schema-qualified, because a schema was a
 * tint you could not read and the qualifier was the only way to find out which one a building
 * belonged to. Schemas are neighbourhoods now, so that fact is written once over the neighbourhood
 * instead of repeated on every building inside it — which is both how a map does it and how the
 * building's own name gets the width it needs.
 *
 * Labels are drawn in front of every other object rather than depth-tested against the city. A name
 * hidden behind the building it names is worth nothing, and at the default framing most of them were
 * hidden. The cost is that a label can overlap geometry it does not name, so a label is always
 * anchored at its own building's kerb and the evidence tables below the map remain authoritative.
 *
 * Rasterization lives behind {@link createCityLabels}. The text and geometry decisions above it are
 * pure functions so they can be tested without a DOM or a GPU.
 */

/** Glyph height used when rasterizing. World size is applied separately, so this is quality only. */
const FONT_PX = 56
const PAD_X = 20
const PAD_Y = 12
/**
 * Height of a label in world units. Labels are size-attenuated, so they still shrink with distance;
 * this sets how large they are at a given range.
 *
 * The previous 6.2 was measured and found illegible: at the framing the city opens on, a label
 * projected to about 3.6 screen pixels, of which only ~70% is glyph — roughly two and a half pixels
 * of type. It read as grit under the buildings rather than as a name. At 11 the same label lands
 * near 16 pixels by the time the camera is close enough to be reading streets, which is about 11
 * pixels of cap height and genuinely readable.
 *
 * Making labels bigger only helps if they also stop being drawn once they are too small to read;
 * see {@link LABEL_MIN_LEGIBLE_PX}. Bigger type with no declutter would just make the wide view a
 * denser mat of unreadable plates.
 */
export const LABEL_WORLD_HEIGHT = 11

/**
 * Height of the largest building labels.
 *
 * A basemap does not set every place name at one size: a city is lettered larger than a hamlet, so
 * the reader sees the important names first and the rest as they zoom in. The same idea here, keyed
 * to the height the building was already given from its measured page count.
 *
 * Deliberately a narrow range. Label *width* scales with height, so a name set much larger than this
 * would sprawl across several lots and start naming the wrong ground. The point is a legible
 * hierarchy, not a dramatic one.
 */
export const LABEL_WORLD_HEIGHT_MAX = 16

/**
 * The building heights the label scale is stretched between.
 *
 * `buildingHeight` in `cityPlan` is `log2(1 + usedPages) * 4.8`, so these are about 32 pages (a
 * small table) and about 6,000 pages (a large one). Both ends are clamped: the scale is a coarse
 * three-or-four-step hierarchy for reading order, and clamping keeps one enormous table from
 * flattening every other name into the same size.
 */
const LABEL_SCALE_MIN_BUILDING_HEIGHT = 24
const LABEL_SCALE_MAX_BUILDING_HEIGHT = 60

/**
 * Label height for one building, from the height that building was already given.
 *
 * This is a *decoration derived from a measurement*, not a measurement: it is clamped at both ends
 * and spans well under a factor of two, so no measurement can be read back off a label. Building
 * height and footprint remain the only things that state an item's size. A building whose size was
 * never measured gets the baseline height, so an unmeasured item is never lettered as though it
 * were a small one.
 */
export function buildingLabelWorldHeight(buildingHeight: number | null): number {
  if (buildingHeight === null || !Number.isFinite(buildingHeight) || buildingHeight <= 0) {
    return LABEL_WORLD_HEIGHT
  }
  const span = LABEL_SCALE_MAX_BUILDING_HEIGHT - LABEL_SCALE_MIN_BUILDING_HEIGHT
  const t = Math.min(1, Math.max(0, (buildingHeight - LABEL_SCALE_MIN_BUILDING_HEIGHT) / span))
  return LABEL_WORLD_HEIGHT + (LABEL_WORLD_HEIGHT_MAX - LABEL_WORLD_HEIGHT) * t
}

/**
 * Projected sprite height, in CSS pixels, below which a building or facility name is not drawn.
 *
 * A label is padded top and bottom ({@link FONT_PX} of glyph inside `FONT_PX + 2 * PAD_Y` of
 * texture), so only about 70% of a sprite's height is actually letterform. 16 pixels of sprite is
 * therefore around 11 pixels of cap height — the point where a name is read rather than guessed at.
 *
 * Below that the label is hidden outright instead of being drawn smaller. This is ordinary
 * cartographic practice: a basemap drops street names as you zoom out rather than shrinking them
 * into illegibility, so what survives at each scale is the tier that can still be read. Here that
 * leaves neighbourhood names — drawn several times larger — holding the wide view on their own,
 * with building and facility names arriving as you come down to street level.
 */
export const LABEL_MIN_LEGIBLE_PX = 16

/**
 * Height, in CSS pixels, that a sprite of `worldHeight` projects to under a perspective camera.
 *
 * Pure so the legibility threshold can be tested without a GPU: `three` applies exactly this
 * relation for a size-attenuated sprite, since the sprite is scaled in world units and the vertical
 * frustum span at `distance` is `2 * distance * tan(fov / 2)`.
 *
 * Returns 0 for degenerate input rather than `NaN`/`Infinity`, so a caller comparing against a
 * threshold treats "cannot say" as "not legible" instead of drawing something it never measured.
 */
export function labelPixelHeight(
  worldHeight: number,
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
): number {
  if (!(worldHeight > 0) || !(distance > 0) || !(fovDegrees > 0) || !(viewportHeightPx > 0)) return 0
  if (fovDegrees >= 180) return 0
  const span = 2 * distance * Math.tan((fovDegrees * Math.PI) / 360)
  if (!(span > 0)) return 0
  return (worldHeight / span) * viewportHeightPx
}

/**
 * The smallest world height that still projects to {@link LABEL_MIN_LEGIBLE_PX} at this range.
 *
 * The inverse of {@link labelPixelHeight}, so a caller with many labels and one camera can compute
 * a single threshold and compare each label's own height against it, instead of projecting every
 * label separately. Returns `Infinity` for degenerate input, which hides every label rather than
 * showing labels whose size was never established.
 */
export function minimumLegibleWorldHeight(
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  minimumPx: number = LABEL_MIN_LEGIBLE_PX,
): number {
  if (!(distance > 0) || !(fovDegrees > 0) || fovDegrees >= 180 || !(viewportHeightPx > 0)) {
    return Number.POSITIVE_INFINITY
  }
  const span = 2 * distance * Math.tan((fovDegrees * Math.PI) / 360)
  if (!(span > 0)) return Number.POSITIVE_INFINITY
  return (minimumPx / viewportHeightPx) * span
}

/**
 * Whether a label at this range is large enough to be worth drawing.
 *
 * Expressed in projected pixels rather than in world distance so it holds across both lenses the
 * city is viewed through: map mode fakes a parallel projection with a 13° lens and a proportionally
 * larger orbit distance, so a raw distance cutoff would fire at completely different apparent sizes
 * in the two modes while this fires at the same one.
 */
export function isLabelLegible(
  worldHeight: number,
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  minimumPx: number = LABEL_MIN_LEGIBLE_PX,
): boolean {
  return labelPixelHeight(worldHeight, distance, fovDegrees, viewportHeightPx) >= minimumPx
}
/**
 * Longest label drawn before the middle is elided. A wide texture costs both memory and legibility,
 * and the full name is always available in the evidence tables and the detail panel.
 *
 * Width scales with {@link LABEL_WORLD_HEIGHT}, so a long name at the current height spans several
 * lots. This limit is what keeps that in hand; the elision is from the middle, so both ends of a
 * name survive.
 */
export const LABEL_MAX_CHARS = 24

const ELLIPSIS = '…'

/**
 * Names one building. The bare object name: the schema it belongs to is written over the
 * neighbourhood it stands in, so repeating it here would spend width saying the same thing twice.
 */
export function buildingLabelText(name: string): string {
  return elideMiddle(name, LABEL_MAX_CHARS)
}

/**
 * Names one schema's neighbourhood.
 *
 * Set in capitals with the letters spaced apart, which is how a basemap distinguishes the name of an
 * *area* from the name of a thing standing in it. Nothing is added to it — no count, no size — because
 * a place name that carries a number invites the number to be read off the map.
 */
export function neighborhoodLabelText(workspaceName: string): string {
  const trimmed = workspaceName.trim()
  if (trimmed.length === 0) return ''
  return [...elideMiddle(trimmed.toLocaleUpperCase(), NEIGHBORHOOD_LABEL_MAX_CHARS)].join('\u2009')
}

/**
 * Longest neighbourhood name drawn before elision.
 *
 * Shorter than {@link LABEL_MAX_CHARS} because the letter spacing roughly doubles the width a name
 * takes, and a neighbourhood label spans several blocks already.
 */
export const NEIGHBORHOOD_LABEL_MAX_CHARS = 16

/**
 * Projected height, in CSS pixels, that a neighbourhood name is grown to when it would otherwise
 * project smaller.
 *
 * Below {@link LABEL_MIN_LEGIBLE_PX} a building name is dropped, because a building name has a
 * neighbourhood name above it to fall back on. A neighbourhood name has nothing above it: it is the
 * tier that holds the wide view, so if it goes illegible the map has no readable text left at all.
 * Measured on a 390-point phone, the whole-city view projected these at about five pixels — the map
 * still looked like a map and could not be read as one.
 *
 * Slightly under the building threshold on purpose. These are set in spaced capitals with a halo
 * rather than on a plate, and spaced capitals hold together a size smaller than mixed case does.
 */
export const NEIGHBORHOOD_LABEL_MIN_PX = 13

/**
 * Largest multiple of its authored size a neighbourhood name may be grown to.
 *
 * Growing a name keeps it readable but does not give it any more ground to sit on, so past some
 * point names start writing over each other. The cap bounds that, and {@link declutterLabels}
 * handles whatever still collides. 3 is what a whole-city view on a phone asks for; past that the
 * camera is far enough out that dropping the name is the more honest answer.
 */
export const NEIGHBORHOOD_LABEL_MAX_GROWTH = 3

/**
 * Multiplier that keeps a label at or above `minimumPx` on screen, within {@link
 * NEIGHBORHOOD_LABEL_MAX_GROWTH}.
 *
 * Returns 1 whenever the label is already large enough, so zooming in never shrinks a name — this
 * only ever adds size at the wide end. Returns 1 for degenerate input too, leaving the label at its
 * authored size rather than scaling it by a number that was never established.
 */
export function labelScreenScale(
  worldHeight: number,
  distance: number,
  fovDegrees: number,
  viewportHeightPx: number,
  minimumPx: number = NEIGHBORHOOD_LABEL_MIN_PX,
  maxGrowth: number = NEIGHBORHOOD_LABEL_MAX_GROWTH,
): number {
  const projected = labelPixelHeight(worldHeight, distance, fovDegrees, viewportHeightPx)
  if (!(projected > 0) || !(minimumPx > 0)) return 1
  if (projected >= minimumPx) return 1
  return Math.min(Math.max(1, maxGrowth), minimumPx / projected)
}

/** A label's projected footprint on screen, in CSS pixels, for {@link declutterLabels}. */
export type LabelBox = {
  /** Identifies the label to the caller. Nothing here interprets it. */
  id: string
  /** Screen centre, in CSS pixels from the top-left of the canvas. */
  x: number
  y: number
  width: number
  height: number
  /**
   * Which label wins a collision. Higher survives; ties break on `id` so the same city always drops
   * the same names. Neighbourhood names use their authored world height, so the name of the larger
   * territory is the one that stays.
   */
  priority: number
  /** False for a label that is off-screen or already below its legibility floor. */
  visible?: boolean
}

/**
 * Keeps the labels that fit and drops the ones that would be written over.
 *
 * Two names on top of each other are worse than one name, because the reader cannot tell which
 * letters belong to which place. So this is a greedy pass in priority order — the standard approach
 * for area labels — where each name is kept only if its box is clear of every name already kept.
 *
 * Boxes are inset before testing, so names are allowed to *approach* each other; only real overlap
 * of the letterforms drops one. Pure and deterministic: the same camera over the same city always
 * drops the same names, which matters because a name that flickers as you nudge the view is worse
 * than one that is simply absent.
 */
export function declutterLabels(boxes: readonly LabelBox[], padding = -0.12): Set<string> {
  const kept: LabelBox[] = []
  const keptIds = new Set<string>()
  const ordered = [...boxes]
    .filter((box) => box.visible !== false && box.width > 0 && box.height > 0)
    .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const box of ordered) {
    const insetX = box.width * padding
    const insetY = box.height * padding
    const halfW = box.width / 2 + insetX
    const halfH = box.height / 2 + insetY
    const clash = kept.some((other) => {
      const otherHalfW = other.width / 2 + other.width * padding
      const otherHalfH = other.height / 2 + other.height * padding
      return Math.abs(other.x - box.x) < halfW + otherHalfW
        && Math.abs(other.y - box.y) < halfH + otherHalfH
    })
    if (clash) continue
    kept.push(box)
    keptIds.add(box.id)
  }
  return keptIds
}

/**
 * Height of a neighbourhood name in world units, before it is scaled to the territory.
 *
 * A place name has to outrank the labels of the things standing in it, or it is just one more tag in
 * the pile. At three times a building label it reads as a different order of thing — the way a
 * basemap sets a district name far larger than the streets inside it.
 */
export const NEIGHBORHOOD_LABEL_WORLD_HEIGHT = 34

/**
 * Scales a neighbourhood name to the ground it covers.
 *
 * A ten-table schema and a five-hundred-table schema get very different amounts of city, and one
 * fixed type size either shouts over the small one or disappears on the large one. Sizing by the
 * square root of the claimed area tracks the territory's *width* rather than its area, so the name
 * grows the way the place does. Clamped at both ends so a two-block schema still gets a readable
 * name and a dominant one does not write across the entire map.
 */
export function neighborhoodLabelHeight(blockCount: number, blockPitch: number): number {
  const width = Math.sqrt(Math.max(1, blockCount)) * blockPitch
  return Math.min(NEIGHBORHOOD_LABEL_WORLD_HEIGHT * 2.2, Math.max(NEIGHBORHOOD_LABEL_WORLD_HEIGHT, width * 0.16))
}

/**
 * Longest database label drawn on the server atlas before elision.
 *
 * Shorter than {@link LABEL_MAX_CHARS} because atlas labels are drawn larger, and a city's plot and
 * its neighbours' plots sit on a fixed grid pitch: a name wide enough to cross into the next city
 * would say the wrong thing about which city it names.
 */
export const ATLAS_LABEL_MAX_CHARS = 18

/** Names a database city on the server atlas. Database names are not qualified by anything. */
export function capacityLabelText(name: string): string {
  return elideMiddle(name, ATLAS_LABEL_MAX_CHARS)
}

/**
 * Shortens from the middle rather than the end. A name's tail is often what distinguishes it
 * (`orders_2024_archive` against `orders_2024_current`), so a trailing elision would merge labels
 * that name different buildings.
 */
export function elideMiddle(text: string, maxChars: number): string {
  const characters = [...text]
  if (maxChars <= 0) return ''
  if (characters.length <= maxChars) return text
  if (maxChars === 1) return ELLIPSIS
  const keep = maxChars - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${characters.slice(0, head).join('')}${ELLIPSIS}${tail === 0 ? '' : characters.slice(-tail).join('')}`
}

/** Sprite width in world units that preserves the rasterized aspect ratio at {@link LABEL_WORLD_HEIGHT}. */
export function labelWorldWidth(pixelWidth: number, pixelHeight: number, worldHeight = LABEL_WORLD_HEIGHT): number {
  if (!(pixelHeight > 0) || !(pixelWidth > 0)) return 0
  return worldHeight * (pixelWidth / pixelHeight)
}

/**
 * Places a label on the street side of its building.
 *
 * A label sits at the kerb the building is entered from, so it lands on open pavement instead of
 * inside the footprint it names. `accessX`/`accessZ` is the same frontage point the GPS route stops
 * at, which keeps the label and the route agreeing about where a building's front is. When the two
 * points coincide there is no direction to push toward, so the centre is used unchanged.
 */
export function labelAnchor(
  centerX: number,
  centerZ: number,
  accessX: number,
  accessZ: number,
  distance: number,
): { x: number; z: number } {
  const dx = accessX - centerX
  const dz = accessZ - centerZ
  const length = Math.hypot(dx, dz)
  if (length === 0) return { x: centerX, z: centerZ }
  return { x: centerX + (dx / length) * distance, z: centerZ + (dz / length) * distance }
}

export type CityLabels = {
  /** Returns null when the browser refuses a 2D context, so the caller simply draws no label. */
  make(text: string, style?: LabelStyle): THREE.Sprite | null
  dispose(): void
}

/**
 * How a label is drawn.
 *
 * `building` is a dark plate with light text: a tag pinned to one object, which has to stay legible
 * over ground, asphalt and roof alike. `neighborhood` is plate-less text with a dark halo and a
 * coloured cast, which is how a map writes the name of an area — it belongs to the ground it sits
 * over rather than sitting on top of it.
 */
export type LabelStyle = {
  readonly variant: 'building' | 'neighborhood'
  /** Neighbourhood hue, so the name and the ground it names agree. Ignored by `building`. */
  readonly tint?: number
  readonly worldHeight?: number
}

const BUILDING_STYLE: LabelStyle = { variant: 'building' }

/** A rasterized label: the shared material plus the pixel size the sprite scale is derived from. */
type RasterizedLabel = {
  material: THREE.SpriteMaterial
  pixelWidth: number
  pixelHeight: number
}

/**
 * Builds label sprites, caching one texture per distinct string.
 *
 * The cache is what makes labels affordable: the scene rebuilds its buildings on every live tick
 * and on every appended page, and rasterizing a fresh canvas per building per tick would churn GPU
 * textures for text that never changed. Sprites are cheap wrappers over the shared material, so
 * only {@link CityLabels.dispose} frees GPU memory.
 *
 * `worldHeight` sets how large a sprite is in the scene that asked for it. The database city and the
 * server atlas are drawn at very different world scales -- a city block against a hundred cities on
 * one grid -- so a single fixed height would leave one of them unreadable. The rasterization is
 * identical either way; only the sprite scale differs.
 */
export function createCityLabels(worldHeight: number = LABEL_WORLD_HEIGHT): CityLabels {
  const cache = new Map<string, RasterizedLabel | null>()

  function rasterize(text: string, style: LabelStyle): RasterizedLabel | null {
    // The tint is baked into the texture, so it has to be part of what identifies one.
    const cacheKey = `${style.variant}|${style.tint ?? ''}|${text}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      cache.set(cacheKey, null)
      return null
    }

    const neighborhood = style.variant === 'neighborhood'
    const font = neighborhood
      ? `700 ${FONT_PX}px "Segoe UI", system-ui, sans-serif`
      : `600 ${FONT_PX}px "Segoe UI", system-ui, sans-serif`
    context.font = font
    const measured = Math.ceil(context.measureText(text).width)
    const padX = neighborhood ? PAD_X * 1.6 : PAD_X
    const padY = neighborhood ? PAD_Y * 1.6 : PAD_Y
    canvas.width = measured + padX * 2
    canvas.height = FONT_PX + padY * 2

    // Resizing a canvas resets its 2D state, so the font has to be set again before drawing.
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'

    if (neighborhood) {
      // No plate. A halo instead, so the name reads over parkland, roofs and water without cutting a
      // hole in the map underneath it. Heavy enough to survive being drawn over a lit white facade.
      context.lineJoin = 'round'
      context.strokeStyle = 'rgba(9, 13, 20, 0.85)'
      context.lineWidth = 14
      context.strokeText(text, canvas.width / 2, canvas.height / 2 + 1)
      context.fillStyle = style.tint === undefined ? '#f4ece0' : lighten(style.tint)
      context.fillText(text, canvas.width / 2, canvas.height / 2 + 1)
    } else {
      // A dark plate keeps the text legible over ground, asphalt, and neighbourhood tint alike.
      context.fillStyle = 'rgba(7, 11, 17, 0.82)'
      roundedRect(context, 0, 0, canvas.width, canvas.height, padY + 2)
      context.fill()
      context.strokeStyle = 'rgba(159, 198, 232, 0.35)'
      context.lineWidth = 2
      context.stroke()

      context.fillStyle = '#e8f1f8'
      context.fillText(text, canvas.width / 2, canvas.height / 2 + 1)
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // The canvas is not power-of-two, so mipmapping would need a resize; labels are read up close.
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = 4

    const entry: RasterizedLabel = {
      material: new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        // Labels ignore the depth buffer so a building can never hide the name of the building
        // behind it. Identity is the one thing that must survive any camera angle: a name you
        // cannot read is no more useful than no name at all.
        depthTest: false,
        opacity: neighborhood ? 0.9 : 1,
      }),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
    }
    cache.set(cacheKey, entry)
    return entry
  }

  return {
    make(text, style = BUILDING_STYLE) {
      const entry = rasterize(text, style)
      if (!entry) return null
      const height = style.worldHeight ?? worldHeight
      const sprite = new THREE.Sprite(entry.material)
      sprite.scale.set(labelWorldWidth(entry.pixelWidth, entry.pixelHeight, height), height, 1)
      // Above every other render order in the scene, so labels resolve last and against each other
      // by camera distance rather than by the order buildings happened to be added. A neighbourhood
      // name sits a rank below a building name: it is the larger, less urgent of the two.
      sprite.renderOrder = style.variant === 'neighborhood' ? 9 : 10
      return sprite
    },
    dispose() {
      for (const entry of cache.values()) {
        entry?.material.map?.dispose()
        entry?.material.dispose()
      }
      cache.clear()
    },
  }
}

/** Lifts a neighbourhood hue to something that reads as text against a dark halo. */
function lighten(color: number): string {
  const to = (channel: number) => Math.round(channel + (255 - channel) * 0.52)
  const r = to((color >> 16) & 0xff)
  const g = to((color >> 8) & 0xff)
  const b = to(color & 0xff)
  return `rgb(${r}, ${g}, ${b})`
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const limit = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + limit, y)
  context.arcTo(x + width, y, x + width, y + height, limit)
  context.arcTo(x + width, y + height, x, y + height, limit)
  context.arcTo(x, y + height, x, y, limit)
  context.arcTo(x, y, x + width, y, limit)
  context.closePath()
}
