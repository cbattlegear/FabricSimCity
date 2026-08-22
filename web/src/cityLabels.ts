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
 * this sets how large they are at a given range. Sized so a name stays readable from the default
 * framing, where a label competes with towers several times its height for attention.
 */
export const LABEL_WORLD_HEIGHT = 6.2
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
export function neighborhoodLabelText(schemaName: string): string {
  const trimmed = schemaName.trim()
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
export function databaseLabelText(name: string): string {
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
