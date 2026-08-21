/**
 * The flat-map look.
 *
 * The 2D mode is not "the 3D city with the camera pointed down". It is a genuinely different
 * drawing: unlit colour, road casings, footprint plates, and pins — the visual language every web
 * map uses, because that is the language people already read fluently.
 *
 * Nothing here encodes evidence. These are the colours and widths of a *style*; every quantity the
 * map claims is still computed in `cityPlan`, `cityTraffic`, and `cityFacilityTraffic` and is
 * identical in both modes. Switching view mode never changes a number.
 */

export type MapViewMode = 'map' | 'city'

export const MAP_PALETTE = {
  /** Land under everything. Warm paper grey, the standard basemap ground. */
  ground: 0xf0efe9,
  /** Block interiors — very slightly lighter than the ground so blocks read as parcels. */
  block: 0xf6f5f0,
  /** Park and open space. */
  park: 0xc8e0c0,
  /** Water. Unused today; reserved so a future water feature has one canonical blue. */
  water: 0xaadaff,
  /** Road fill, drawn over the casing. */
  roadFill: 0xffffff,
  /** Road casing, drawn wider and beneath the fill. This is what makes roads read as roads. */
  roadCasing: 0xd4d2cc,
  /** Arterial fill — very slightly warm, the way major roads are tinted on real basemaps. */
  arterialFill: 0xfff6d8,
  arterialCasing: 0xe6d3a8,
  /** Building footprint plate and its outline. */
  building: 0xe0ded6,
  buildingEdge: 0xc9c6bc,
  /** Selected building plate. */
  buildingSelected: 0xffd27f,
  /** Ranked-workload plate: buildings carrying attributed exposure read warmer. */
  buildingAttributed: 0xefd9b4,
  /** Facility parcel plate — civic buildings are drawn as POIs, so their parcel is tinted. */
  facility: 0xd8e4f2,
  facilityEdge: 0xa8bcd4,
  /** Text label colour and its halo. */
  label: 0x3c3a35,
  labelHalo: 0xffffff,
  /** Pin body and its stem. */
  pin: 0xd23f31,
  pinFacility: 0x2f6fd0,
  pinIncident: 0xd23f31,
} as const

/** Road widths in world units, as a multiplier of the 3D-mode ribbon width. */
export const MAP_ROAD = {
  /** How much wider the casing is than the fill, in world units, total across both sides. */
  casingPad: 0.55,
  /** Minimum drawn fill width, so a one-execution road is still a visible street. */
  minFill: 0.5,
} as const

/** Heights (y) used to stack the flat drawing without z-fighting. Ordered bottom to top. */
export const MAP_LAYER = {
  ground: 0,
  block: 0.01,
  roadCasing: 0.02,
  roadFill: 0.03,
  lane: 0.04,
  buildingPlate: 0.05,
  route: 0.07,
  pinStem: 0.08,
  label: 0.6,
} as const

export const MAP_PIN = {
  /** World-unit radius of the pin head. */
  radius: 0.62,
  /** How far above the plate the pin head floats. */
  height: 2.4,
  facilityRadius: 0.8,
  facilityHeight: 3.1,
} as const

/** Camera framing for the flat mode. Straight down, no tilt, no orbit. */
export const MAP_CAMERA = {
  /** Orthographic half-height at the default zoom, in world units. */
  frustumPad: 1.12,
  /** Y position of the orthographic camera. Well above any 3D massing so nothing clips. */
  height: 400,
  near: 0.1,
  far: 2000,
} as const

export function isMapMode(mode: MapViewMode): boolean {
  return mode === 'map'
}
