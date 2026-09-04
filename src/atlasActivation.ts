/**
 * Which city a double-click in the server atlas opens.
 *
 * A single click selects a city and a double-click enters it, so the two gestures share their first
 * click and the second one has to be unambiguous before it moves the reader to another view. The
 * browser fires `dblclick` for any two clicks that land close together in time, including two clicks
 * that landed on two different cities, and clicking one capacity and then its neighbour to compare
 * them is an ordinary thing to do in the atlas. So this records what each click actually hit and
 * names a capacity only when both clicks of the pair agreed on it. A pair that disagreed, or that
 * included the empty ground between cities, opens nothing and leaves the reader in the atlas.
 */
export class CityActivation {
  private previousClick: string | null = null
  private lastClick: string | null = null

  /** Records a click on `capacityId`, or on the ground between cities when it is null. */
  click(capacityId: string | null): void {
    this.previousClick = this.lastClick
    this.lastClick = capacityId
  }

  /**
   * Returns the capacity the double-click should open, or null when its two clicks did not agree on
   * one. Consumes the pair either way, so a third rapid click starts a fresh gesture instead of
   * re-entering the city the first two clicks happened to agree on.
   */
  activate(): string | null {
    const agreed = this.lastClick !== null && this.lastClick === this.previousClick ? this.lastClick : null
    this.previousClick = null
    this.lastClick = null
    return agreed
  }
}
