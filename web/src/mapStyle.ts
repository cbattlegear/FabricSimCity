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
  ground: 0xf2f0e8,
  /*
   * Built-up land, and deliberately *darker* than the ground rather than lighter.
   *
   * Every web map you can read at a glance does this: the settled part of the sheet is a warm grey
   * plate and the roads are white lines cut out of it. Drawn lighter than its surroundings — which is
   * what this was — a parcel has nothing for a white road to read against, and the whole drawing goes
   * flat and pastel with no figure and no ground.
   */
  block: 0xe6e3d8,
  /** Park and open space. */
  park: 0xbfdfb0,
  /** Water. */
  water: 0x9fd0ee,
  /** Water's edge — a darker rim is what makes a river read as a river rather than a blue smear. */
  waterEdge: 0x74aacd,
  /** Woodland: denser than park, the way a forest polygon is drawn a shade deeper. */
  woodland: 0xa6cf98,
  /** A linear green — a river bank, a rail cutting, a verge. */
  greenway: 0xcce8c0,
  /** Orchard and allotment: green with a hint of the soil under it. */
  orchard: 0xd4e2a4,
  /** Hard landscaping in front of a civic building. */
  plaza: 0xe9e5d4,
  /** Surface parking. */
  parking: 0xe8e5da,
  /** Service yard and hardstanding. */
  yard: 0xe1ddce,
  /** Road fill, drawn over the casing. */
  roadFill: 0xffffff,
  /** Road casing, drawn wider and beneath the fill. This is what makes roads read as roads. */
  roadCasing: 0xc4c0b2,
  /** Arterial fill — very slightly warm, the way major roads are tinted on real basemaps. */
  /*
   * Arterial fill — very slightly warm, the way major roads are tinted on real basemaps.
   *
   * "Slightly" is the whole of it. An arterial ribbon is nearly half the width of the corridor it
   * runs in, so any real saturation here stops being a road and becomes a yellow lattice laid over
   * the sheet. The hierarchy has to come from the casing and the width, not from the fill shouting.
   */
  arterialFill: 0xfff7de,
  arterialCasing: 0xdfc793,
  /** Building footprint plate and its outline. */
  building: 0xd2cec0,
  buildingEdge: 0xa4a092,
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

/**
 * Ground cover for every land-use class the terrain planner emits, in both drawings.
 *
 * None of this is measured. A block's land use is seeded from the database id, exactly like every
 * other piece of scenery, and says nothing whatsoever about the database. It exists because ~47% of
 * blocks are deliberately empty, and blank white voids are the largest and least useful surface on
 * the map. The legend says so in as many words.
 */
export const LANDUSE_MAP_COLORS = {
  built: MAP_PALETTE.block,
  facility: MAP_PALETTE.facility,
  water: MAP_PALETTE.water,
  park: MAP_PALETTE.park,
  greenway: MAP_PALETTE.greenway,
  woodland: MAP_PALETTE.woodland,
  orchard: MAP_PALETTE.orchard,
  plaza: MAP_PALETTE.plaza,
  parking: MAP_PALETTE.parking,
  yard: MAP_PALETTE.yard,
} as const

/** The same ground cover at golden hour, where it is lit rather than printed. */
export const LANDUSE_CITY_COLORS = {
  /*
   * Built parcels are the lightest large surface on purpose.
   *
   * On a real map the city block is what the eye rests on and everything else — roads, greens,
   * water — is read against it. Pitched warm-brown it collapsed into the terrain underneath and the
   * towers looked like they were standing in a field, so it is a warm dry stone: light enough to
   * hold its own against the carriageways, warm enough to belong to the same afternoon.
   */
  built: 0x99917f,
  facility: 0x7e8a90,
  water: 0x35809f,
  park: 0x7aa85f,
  greenway: 0x80ad66,
  woodland: 0x5f8c4d,
  orchard: 0x94a058,
  /* Paving is a warm grey, not a cool one. A cool plaza reads as another road. */
  plaza: 0x969084,
  parking: 0x8a857c,
  yard: 0x8f8b6c,
} as const

/** Street hierarchy in the flat drawing. A map without a road hierarchy is a diagram. */
export const MAP_STREET = {
  arterial: { fill: MAP_PALETTE.arterialFill, casing: MAP_PALETTE.arterialCasing, width: 1 },
  boulevard: { fill: MAP_PALETTE.arterialFill, casing: MAP_PALETTE.arterialCasing, width: 1 },
  avenue: { fill: MAP_PALETTE.roadFill, casing: MAP_PALETTE.roadCasing, width: 0.94 },
  riverside: { fill: MAP_PALETTE.roadFill, casing: MAP_PALETTE.roadCasing, width: 0.88 },
  collector: { fill: MAP_PALETTE.roadFill, casing: MAP_PALETTE.roadCasing, width: 0.86 },
} as const

/** Heights (y) used to stack the flat drawing without z-fighting. Ordered bottom to top. */
export const MAP_LAYER = {
  ground: 0,
  landuse: 0.005,
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
