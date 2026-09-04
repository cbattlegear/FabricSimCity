/**
 * What the city says while it is being built.
 *
 * A loading screen in the spirit of the one *SimCity* shipped: a progress bar and a deadpan line of
 * technical nonsense, changing every few seconds, reporting work no program has ever done.
 *
 * The lines here are written for this app rather than copied from that one. SimCity's list is
 * Maxis' writing and belongs to them, and most of it — barbers, llamas, rhinoceros breeding — would
 * be nonsense in a tool that reads `sys.dm_db_partition_stats`. These say the same kind of thing
 * about the work *this* city actually does: pages counted, streets traced, waits attributed. The one
 * borrowed line is the famous one, kept deliberately, because a city builder that does not
 * reticulate its splines is not a city builder.
 *
 * These are decoration, and the loading screen says so. Nothing here reports a real stage of
 * loading: the truthful part of that screen is the object count beside the bar, which is measured.
 * A saying that sounded like status would be a lie told by the one component with nothing to
 * measure, which is exactly the line this codebase does not cross.
 */
export const CITY_LOADING_SAYINGS: readonly string[] = [
  'Reticulating splines',
  'Surveying the tablespace',
  'Zoning the dbo district',
  'Pouring foundations for wide tables',
  'Negotiating with the query optimiser',
  'Issuing building permits to new tables',
  'Painting crosswalks between foreign keys',
  'Persuading the cardinality estimator',
  'Timing traffic lights to the checkpoint interval',
  'Draining the transaction log',
  'Sweeping up orphaned pages',
  'Widening arterials for parallel scans',
  'Rehousing displaced row versions',
  'Assessing property tax on heap tables',
  'Naming streets after their busiest column',
  'Installing streetlights along the critical path',
  'Filing a variance for a missing index',
  'Escalating a residential lock to the whole block',
  'Convincing the plan cache to stay warm',
  'Counting 8-KiB pages by hand',
  'Grading terrain to the fill factor',
  'Dispatching inspectors to the fragmentation site',
  'Towing abandoned temp tables',
  'Posting speed limits by estimated row count',
  'Consulting the statistics histogram',
  'Auditing the buffer pool for vacancies',
  'Composting expired statistics',
  'Bribing the lazy writer',
  'Laying kerbstones along the covering index',
  'Simulating rush hour on the primary key',
  'Rebuilding the bridge over the join',
  'Distributing waits proportionally to cost',
  'Chalking parking spaces for row locks',
  'Interviewing the wait statistics',
  'Repainting lane markings on the hot path',
  'Petitioning the planner for a wider road',
  'Enumerating civic facilities',
  'Extrapolating commuter patterns from Query Store',
  'Waking the checkpoint crew',
  'Aligning the skyline to reserved pages',
  'Handing out addresses to unnamed objects',
  'Cordoning off a blocked intersection',
  'Approving the annexation of a new schema',
  'Calibrating the traffic cameras',
  'Ageing facades to match their first write',
  'Rounding up stray cursors',
  'Filing the tempdb spill report',
  'Dredging the log reuse channel',
  'Planting street trees at ninety percent fill factor',
  'Synchronising the town clock with UTC',
  'Evicting squatters from the buffer cache',
  'Counting cars at the nested loop',
  'Surveying the floodplain for tempdb',
  'Lobbying for a covering index',
  'Recycling condemned execution plans',
  'Snapping buildings to their block frontage',
  'Warming the pavement for the first query',
  'Numbering lots in catalogue order',
  'Reconciling the census with sys.objects',
  'Teaching drivers to avoid the table scan',
  'Testing the fire hydrants near the log',
  'Sorting residents by CPU consumed',
  'Inflating property values on hot tables',
  'Scheduling maintenance on the clustered index',
  'Unrolling the ribbon between two districts',
  'Measuring the queue at the lock office',
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
