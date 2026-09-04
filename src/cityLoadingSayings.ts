/**
 * What the city says while it is being built.
 *
 * A loading screen in the spirit of the one *SimCity* shipped: a progress bar and a deadpan line of
 * technical nonsense, changing every few seconds, reporting work no program has ever done.
 *
 * The lines here are written for this app rather than copied from that one. SimCity's list is
 * Maxis' writing and belongs to them, and most of it — barbers, llamas, rhinoceros breeding — would
 * be nonsense in a tool that reads a capacity metrics model. These say the same kind of thing about
 * the work *this* city actually does: CU seconds totted up, streets traced, throttling attributed.
 * The one borrowed line is the famous one, kept deliberately, because a city builder that does not
 * reticulate its splines is not a city builder.
 *
 * Several lean on the power grid the city actually draws — reservoirs, the delay gate, the
 * carry-forward yard — because that metaphor is load-bearing here rather than decorative: a Fabric
 * capacity really does smooth, queue, ration and black out.
 *
 * These are decoration, and the loading screen says so. Nothing here reports a real stage of
 * loading: the truthful part of that screen is the item count beside the bar, which is measured.
 * A saying that sounded like status would be a lie told by the one component with nothing to
 * measure, which is exactly the line this codebase does not cross.
 */
export const CITY_LOADING_SAYINGS: readonly string[] = [
  'Reticulating splines',
  'Surveying the OneLake shoreline',
  'Zoning the default workspace',
  'Pouring foundations for a wide lakehouse',
  'Negotiating with the capacity scheduler',
  'Issuing building permits to new items',
  'Painting crosswalks between shortcuts',
  'Persuading the query engine to fold',
  'Timing traffic lights to the smoothing window',
  'Draining the interactive reservoir',
  'Sweeping up orphaned Parquet files',
  'Widening arterials for a Spark pool',
  'Rehousing displaced Delta versions',
  'Assessing property tax on cold lakehouses',
  'Naming streets after their busiest operation',
  'Installing streetlights along the critical path',
  'Filing a variance for an unassigned workspace',
  'Escalating a brownout to the whole district',
  'Convincing the Direct Lake cache to stay warm',
  'Counting capacity units by hand',
  'Grading terrain to the V-Order',
  'Dispatching inspectors to the throttling site',
  'Towing abandoned notebook sessions',
  'Posting speed limits by CU consumed',
  'Consulting the capacity metrics model',
  'Auditing the starter pool for vacancies',
  'Composting stale framing',
  'Bribing the background scheduler',
  'Laying kerbstones along the silver layer',
  'Simulating rush hour on the gold layer',
  'Rebuilding the bridge over the shortcut',
  'Distributing compute proportionally to cost',
  'Chalking parking spaces for Spark executors',
  'Interviewing the throttling gauges',
  'Repainting lane markings on the hot path',
  'Petitioning the planner for a wider SKU',
  'Enumerating civic facilities',
  'Extrapolating commuter patterns from the metrics model',
  'Waking the Spark starter pool',
  'Aligning the skyline to CU seconds',
  'Handing out addresses to unnamed items',
  'Cordoning off a rejected operation',
  'Approving the annexation of a new workspace',
  'Calibrating the traffic cameras',
  'Ageing facades to match their last refresh',
  'Rounding up stray dataflows',
  'Filing the carry-forward report',
  'Dredging the eventstream channel',
  'Planting street trees at ninety percent utilisation',
  'Synchronising the town clock with the timepoint',
  'Evicting squatters from the Direct Lake cache',
  'Counting cars at the pipeline junction',
  'Surveying the floodplain for burst traffic',
  'Lobbying for a larger capacity',
  'Recycling condemned Spark sessions',
  'Snapping buildings to their block frontage',
  'Warming the pavement for the first query',
  'Numbering lots in item order',
  'Reconciling the census with the workspace list',
  'Teaching drivers to avoid the full scan',
  'Testing the fire hydrants near the reservoir',
  'Sorting residents by compute consumed',
  'Inflating property values on hot lakehouses',
  'Scheduling maintenance on the semantic model',
  'Unrolling the ribbon between two workspaces',
  'Measuring the queue at the delay gate',
  'Reading the meter at the power plant',
  'Balancing the load across the reservoirs',
  'Posting the burndown notice on the yard gate',
  'Metering the substation for surge protection',
]

/** Fisher–Yates, on a copy, so the source list is never reordered. */
function shuffle(values: readonly string[], random: () => number): string[] {
  const order = [...values]
  for (let at = order.length - 1; at > 0; at -= 1) {
    // Clamped because an injected `random` is allowed to return exactly 1, which would index past
    // the end and drop a saying on the floor.
    const swap = Math.min(at, Math.floor(random() * (at + 1)))
    const held = order[at]
    order[at] = order[swap]
    order[swap] = held
  }
  return order
}

/**
 * An endless run of sayings in random order.
 *
 * Shuffled rather than picked at random each time, which is the difference between "random" and
 * "feels random": drawing independently would show the same line twice in a row about once every
 * sixty-six changes, and on a screen with one moving part that reads as a bug. Dealing from a
 * shuffled deck shows every saying once before any repeats, and the seam between decks is swapped
 * so a reshuffle cannot repeat the line still on screen either.
 *
 * @param random Injectable so tests can deal a known deck. Defaults to `Math.random`.
 */
export function sayingReel(
  sayings: readonly string[] = CITY_LOADING_SAYINGS,
  random: () => number = Math.random,
): () => string {
  let queue: string[] = []
  let shown: string | null = null
  return () => {
    if (sayings.length === 0) return ''
    if (queue.length === 0) {
      queue = shuffle(sayings, random)
      if (queue.length > 1 && queue[0] === shown) {
        const swap = Math.min(queue.length - 1, 1 + Math.floor(random() * (queue.length - 1)))
        const held = queue[0]
        queue[0] = queue[swap]
        queue[swap] = held
      }
    }
    shown = queue.shift() ?? ''
    return shown
  }
}

/**
 * How far along the load is, as a fraction, or `null` when that is not yet known.
 *
 * `null` is a real answer and not a zero: until the first page lands the total is unknown, and a bar
 * sitting at 0% claims a measurement nobody has taken. The caller draws an indeterminate bar for
 * `null` instead.
 */
export function loadingProgress(
  loaded: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (loaded == null || total == null) return null
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return null
  return Math.min(1, Math.max(0, loaded / total))
}
