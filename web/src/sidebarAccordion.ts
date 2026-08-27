/**
 * Which of the rail's four disclosure regions is open, and the rule that only one ever is.
 *
 * The city rail carries four collapsible regions -- the city directory, live activity, the plan
 * finder and the legend -- and until now each one opened independently. That is what produced the
 * defect this module exists to remove. The four share one fixed-height column, so every region
 * opened is a region the others pay for, and the payment was taken from whichever region could give
 * way rather than from the one the reader had just asked for.
 *
 * Measured at 1440x900 against `AdventureWorks`, with all four open:
 *
 * | region                      | body height | body content |
 * |-----------------------------|-------------|--------------|
 * | City directory              | 178px       | 11,712px     |
 * | Live activity               | 18px        | 134px        |
 * | Route a captured query plan | 18px        | 81px         |
 * | Legend & evidence           | 18px        | 84,953px     |
 *
 * Three of the four held eighteen pixels. The rail reported zero unreachable pixels throughout,
 * because every one of those regions is an `overflow: auto` scroller and a scroller that is 18px
 * tall clips nothing -- it simply cannot be read. That is the failure AGENTS.md warns about twice:
 * zero unreachable pixels is necessary and not sufficient.
 *
 * An accordion fixes it at the source rather than by re-tuning shares. If only one region can be
 * open, there is nothing to divide: the open one takes the column and the other three cost their
 * summary. No budget, no per-open-count share, and no arithmetic that has to be re-derived every
 * time a region is added.
 *
 * The state lives here as a pure module so the invariant can be tested without a DOM. The rule that
 * matters -- opening one closes the others -- is a property of this reducer, not of the markup.
 */

/** The rail's four collapsible regions, in the order they appear in the column. */
export type SidebarRegion = 'directory' | 'activity' | 'plans' | 'legend'

export const SIDEBAR_REGIONS: readonly SidebarRegion[] = ['directory', 'activity', 'plans', 'legend']

/**
 * The three that live inside `.sidebar-drawers`.
 *
 * The directory is a sibling of that wrapper rather than a child of it, so the wrapper only claims
 * the column's spare height when the open region is one of these. Naming the split here keeps the
 * component from re-deriving it and keeps the CSS class it drives honest.
 */
export const DRAWER_REGIONS: readonly SidebarRegion[] = ['activity', 'plans', 'legend']

/**
 * What a `<details>` toggle means for the accordion.
 *
 * Opening a region makes it *the* open region, which is what closes the other three -- they are
 * closed by not being named, so no second pass over them is needed and no ordering can go wrong.
 * Closing one clears the selection only if it is the one that was open: a stale close event from a
 * region the accordion has already moved past must not shut the region that replaced it.
 *
 * That last clause is not hypothetical. Assigning `open` to a `<details>` fires `toggle`
 * asynchronously, so closing A by opening B delivers A's close *after* B's open. Handled naively
 * the rail flickers open and shuts itself.
 */
export function toggleRegion(
  current: SidebarRegion | null,
  region: SidebarRegion,
  open: boolean,
): SidebarRegion | null {
  if (open) return region
  return current === region ? null : current
}

/** Whether the open region is one the `.sidebar-drawers` wrapper holds. */
export function drawersHoldOpenRegion(open: SidebarRegion | null): boolean {
  return open !== null && DRAWER_REGIONS.includes(open)
}

/**
 * The region that is actually open, once a live search term has had its say.
 *
 * The directory's search field is *inside* the directory, so a term that did not force it open
 * would leave the reader typing into a box whose results are collapsed. The term therefore pins the
 * directory open, and because this returns a single region rather than a set, pinning it open still
 * closes the other three -- the accordion invariant holds without a second rule to enforce it.
 */
export function effectiveRegion(
  chosen: SidebarRegion | null,
  searchTerm: string,
): SidebarRegion | null {
  return searchTerm.trim().length > 0 ? 'directory' : chosen
}
