import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DRAWER_REGIONS,
  SIDEBAR_REGIONS,
  drawersHoldOpenRegion,
  effectiveRegion,
  toggleRegion,
  type SidebarRegion,
} from './sidebarAccordion'

const city = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')
const panel = readFileSync(new URL('./AddressPanel.tsx', import.meta.url), 'utf8')

/**
 * Source with comments stripped, for the negative assertions.
 *
 * The same trap `shadowInvalidation.test.ts` documents: a doc comment *explaining* why a construct
 * was removed contains the construct, so a negative assertion over raw source reads the explanation
 * as the violation. Removing the explanation to satisfy the guard is exactly the wrong repair.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the rail accordion', () => {
  /*
   * The whole point of the change, and the one thing four independent booleans cannot express.
   *
   * Measured at 1440x900 with all four regions open, three of them held 18px of body against 134px,
   * 81px and 84,953px of content. The rail reported zero unreachable pixels the whole time, because
   * an 18px `overflow: auto` scroller clips nothing -- it just cannot be read.
   */
  it('closes every other region when one opens', () => {
    for (const opening of SIDEBAR_REGIONS) {
      for (const current of SIDEBAR_REGIONS) {
        expect(toggleRegion(current, opening, true), `${current} survived ${opening} opening`)
          .toBe(opening)
      }
    }
  })

  it('opens nothing by default and closes the open region on its own toggle', () => {
    expect(toggleRegion(null, 'legend', false)).toBeNull()
    expect(toggleRegion('legend', 'legend', false)).toBeNull()
  })

  /*
   * The async-toggle trap, and the reason `toggleRegion` checks `current` before clearing.
   *
   * Assigning `open` to a `<details>` fires `toggle` asynchronously, so closing A by opening B
   * delivers A's *close* after B's *open*. Handled naively that close lands on the accordion and
   * shuts B, and the rail visibly opens the region you clicked and then closes it again.
   */
  it('ignores a stale close from a region the accordion has already moved past', () => {
    const afterOpeningPlans = toggleRegion('legend', 'plans', true)
    expect(afterOpeningPlans).toBe('plans')
    expect(toggleRegion(afterOpeningPlans, 'legend', false), 'a stale close shut the new region')
      .toBe('plans')
  })

  /*
   * The search field lives inside the directory, so a term that did not force it open would leave
   * the reader typing into a box whose results are collapsed.
   *
   * It returns a single region rather than adding one to a set, which is what makes pinning the
   * directory open also close the other three -- the invariant holds with no second rule.
   */
  it('pins the directory open for a live search term, closing the rest', () => {
    for (const chosen of [...SIDEBAR_REGIONS, null] as (SidebarRegion | null)[]) {
      expect(effectiveRegion(chosen, 'orders')).toBe('directory')
    }
    expect(effectiveRegion('legend', '   '), 'whitespace counted as a search term').toBe('legend')
    expect(effectiveRegion(null, '')).toBeNull()
  })

  it('knows which regions the drawer wrapper holds', () => {
    expect(DRAWER_REGIONS).toEqual(['activity', 'plans', 'legend'])
    expect(drawersHoldOpenRegion('directory'), 'the directory is a sibling of the wrapper').toBe(false)
    expect(drawersHoldOpenRegion(null)).toBe(false)
    for (const region of DRAWER_REGIONS) expect(drawersHoldOpenRegion(region)).toBe(true)
  })
})

describe('the accordion is actually wired to the markup', () => {
  /*
   * A pure reducer nobody calls enforces nothing. These pin the four call sites, because the defect
   * being fixed is that each `<details>` owned its own open state.
   */
  it('drives all four regions from one piece of state', () => {
    expect(city, 'the rail still has more than one source of open state')
      .toMatch(/const \[chosenRegion, setChosenRegion\] = useState<SidebarRegion \| null>\(null\)/)
    expect(city).toMatch(/open=\{openRegion === 'activity'\}/)
    expect(city).toMatch(/open=\{openRegion === 'plans'\}/)
    expect(city, 'the legend is not driven by the accordion').toMatch(/open=\{openRegion === 'legend'\}/)
    expect(city, 'the directory is not driven by the accordion')
      .toMatch(/open=\{openRegion === 'directory'\}/)
  })

  /*
   * The directory used to own `userOpen` itself. Left there, the accordion could not close it,
   * because that state is invisible to the component that knows what else is open.
   */
  it('leaves the directory no open state of its own', () => {
    expect(code(panel), 'AddressBook still owns its open state').not.toMatch(/useState/)
    expect(panel).toMatch(/open: boolean/)
    expect(panel).toMatch(/onOpenChange: \(open: boolean\) => void/)
  })

  /*
   * Live activity still opens itself when something is wrong, but only on the transition into that
   * state. The old markup got away with `open={incidentDemandsAttention(incidents)}` because React
   * writes the DOM property only when the prop changes; one shared state has no such prop, so a
   * standing warning would reopen live activity on every render and pin the other three shut.
   */
  it('opens live activity on the alert transition, not on every render', () => {
    expect(city).toMatch(/const wasAlerting = useRef\(false\)/)
    expect(city, 'a standing alert reopens live activity every render')
      .toMatch(/if \(alerting && !wasAlerting\.current\) setChosenRegion\('activity'\)/)
    expect(code(city), 'incidentDemandsAttention is still bound straight to the element')
      .not.toMatch(/open=\{incidentDemandsAttention/)
  })

  /*
   * The wrapper's budget caps the drawers inside it, so an open drawer can only ever divide 34vh
   * unless the wrapper itself is told to take the column. This class is what tells it.
   */
  it('marks the drawer wrapper when it holds the open region', () => {
    expect(city).toMatch(/drawersHoldOpenRegion\(openRegion\) \? ' is-open' : ''/)
  })
})
