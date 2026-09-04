import { describe, expect, it } from 'vitest'
import type { CapacityTimepoint } from './capacityCityContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import {
  advanceTimepointFeed,
  describeTimepointEvidence,
  emptyTimepointFeed,
  timepointAgeSeconds,
  timepointClockLabel,
  timepointEvidenceState,
  type TimepointFeed,
} from './timepointFeed'

type Caps = Pick<CapacitySourceCapabilities, 'timepoints' | 'latencySeconds'>

const CAPABLE: Caps = { timepoints: true, latencySeconds: 0 }
const LAGGING: Caps = { timepoints: true, latencySeconds: 90 }
const BLIND: Caps = { timepoints: false, latencySeconds: 0 }

const BASE = Date.parse('2024-05-01T00:10:00Z')

/** A timepoint at `secondsFromBase`, everything null but the instant — only the clock is under test. */
function tp(secondsFromBase: number): CapacityTimepoint {
  return {
    timepoint: new Date(BASE + secondsFromBase * 1000).toISOString(),
    cuLimit: null,
    interactiveBillablePercent: null,
    backgroundBillablePercent: null,
    interactiveNonBillablePercent: null,
    backgroundNonBillablePercent: null,
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    carryOverAddPercent: null,
    carryOverBurndownPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
  }
}

/** Wall-clock `now` a number of seconds after `BASE`. */
function now(secondsFromBase: number): number {
  return BASE + secondsFromBase * 1000
}

describe('timepointEvidenceState distinguishes cannot-know from measured-quiet', () => {
  it('is unsupported when the source cannot report timepoints, even if one was somehow returned', () => {
    // The capability decides this, never the payload. A source that violated the contract and
    // returned a timepoint must not thereby masquerade as a measured one — "cannot know" and
    // "measured" are different claims the city must never merge.
    expect(timepointEvidenceState(BLIND, tp(0))).toBe('unsupported')
    expect(timepointEvidenceState(BLIND, null)).toBe('unsupported')
  })

  it('is none when the source can report timepoints and none has landed', () => {
    expect(timepointEvidenceState(CAPABLE, null)).toBe('none')
  })

  it('is measured once a timepoint has landed', () => {
    expect(timepointEvidenceState(CAPABLE, tp(0))).toBe('measured')
  })
})

describe('emptyTimepointFeed', () => {
  it('starts none for a capable source and says nothing has been read', () => {
    const feed = emptyTimepointFeed(CAPABLE)
    expect(feed.state).toBe('none')
    expect(feed.newest).toBeNull()
    expect(feed.ageSeconds).toBeNull()
    expect(feed.polls).toBe(0)
  })

  it('starts unsupported for a source without the capability', () => {
    const feed = emptyTimepointFeed(BLIND)
    expect(feed.state).toBe('unsupported')
    expect(feed.reason).toContain('cannot report timepoints')
  })
})

describe('advanceTimepointFeed advances to the newest landed timepoint', () => {
  it('lands the newest timepoint and measures its age against now, not the present', () => {
    // The newest timepoint is 90s in the past when it is read. The feed reports that age rather than
    // presenting the timepoint as "now".
    const feed = advanceTimepointFeed(emptyTimepointFeed(LAGGING), [tp(0), tp(30), tp(60)], LAGGING, now(150))
    expect(feed.state).toBe('measured')
    expect(feed.newestAt).toBe(tp(60).timepoint)
    expect(feed.ageSeconds).toBe(90)
    expect(feed.behindByTimepoints).toBe(3)
    expect(feed.advanced).toBe(3)
    expect(feed.advancedThisPoll).toBe(3)
    expect(feed.polls).toBe(1)
  })

  it('advances one timepoint at a time as new ones land', () => {
    const first = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(0), tp(30)], CAPABLE, now(30))
    expect(first.advancedThisPoll).toBe(2)
    // A window overlapping the last read re-delivers tp(30) and adds tp(60): only the genuinely new
    // one advances the clock.
    const second = advanceTimepointFeed(first, [tp(30), tp(60)], CAPABLE, now(60))
    expect(second.newestAt).toBe(tp(60).timepoint)
    expect(second.advancedThisPoll).toBe(1)
    expect(second.advanced).toBe(3)
  })

  it('never lands a timepoint from the future, so not-yet-landed data is not drawn as current', () => {
    // tp(120) is ahead of now: it is forward-smoothing data, not observed telemetry.
    const feed = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(60), tp(120)], CAPABLE, now(60))
    expect(feed.newestAt).toBe(tp(60).timepoint)
    expect(feed.ageSeconds).toBe(0)
  })

  it('lets staleness grow when a poll brings nothing, rather than clearing the clock', () => {
    // A quiet channel is not evidence the capacity stopped: the newest timepoint stays put and ages.
    const measured = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(0)], CAPABLE, now(0))
    expect(measured.ageSeconds).toBe(0)
    const later = advanceTimepointFeed(measured, [], CAPABLE, now(240))
    expect(later.state).toBe('measured')
    expect(later.newestAt).toBe(tp(0).timepoint)
    expect(later.ageSeconds).toBe(240)
    expect(later.advancedThisPoll).toBe(0)
    expect(later.behindByTimepoints).toBe(8)
  })

  it('stays none when the source can report timepoints and a poll brings none', () => {
    const feed = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [], CAPABLE, now(0))
    expect(feed.state).toBe('none')
    expect(feed.polls).toBe(1)
    expect(feed.ageSeconds).toBeNull()
  })

  it('stays unsupported even when an out-of-contract source returns timepoints', () => {
    // Mutation guard: deciding state from the array instead of the capability would let this read as
    // measured, which is the "cannot know rendered as measured" failure.
    const feed = advanceTimepointFeed(emptyTimepointFeed(BLIND), [tp(0), tp(30)], BLIND, now(30))
    expect(feed.state).toBe('unsupported')
    expect(feed.newest).toBeNull()
    expect(feed.ageSeconds).toBeNull()
  })
})

describe('the newest timepoint is never presented as live or now', () => {
  it('reports its age in the reason and says it is not the present moment', () => {
    const feed = advanceTimepointFeed(emptyTimepointFeed(LAGGING), [tp(0)], LAGGING, now(240))
    expect(feed.ageSeconds).toBe(240)
    expect(feed.reason).toContain('4m')
    expect(feed.reason).toContain('not from now')
    expect(feed.reason.toLowerCase()).not.toContain('live')
  })

  it('labels the closed drawer with the age, never "live" or "now"', () => {
    const feed = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(0)], CAPABLE, now(240))
    const label = timepointClockLabel(feed)
    expect(label).toBe('As of 4m ago')
    expect(label.toLowerCase()).not.toContain('live')
    expect(label.toLowerCase()).not.toContain('now')
  })

  it('labels a clock that has not ticked as awaiting rather than idle', () => {
    expect(timepointClockLabel(emptyTimepointFeed(CAPABLE))).toBe('Awaiting first timepoint')
    const polled = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [], CAPABLE, now(0))
    expect(timepointClockLabel(polled)).toBe('No timepoint yet')
  })

  it('labels an incapable source as unavailable, distinct from a quiet one', () => {
    expect(timepointClockLabel(emptyTimepointFeed(BLIND))).toBe('Timepoints unavailable')
  })
})

describe('describeTimepointEvidence announces a withheld clock', () => {
  it('withholds the clock and says the age cannot be known when unsupported', () => {
    const disclosure = describeTimepointEvidence(BLIND, emptyTimepointFeed(BLIND))
    expect(disclosure.state).toBe('unsupported')
    expect(disclosure.runClock).toBe(false)
    expect(disclosure.headline).toContain('cannot report timepoints')
  })

  it('runs the clock and calls a quiet source a measured absence, not a fault', () => {
    const disclosure = describeTimepointEvidence(CAPABLE, emptyTimepointFeed(CAPABLE))
    expect(disclosure.state).toBe('none')
    expect(disclosure.runClock).toBe(true)
    // Must not read the same as the unsupported case: a quiet clock and an absent one are different.
    expect(disclosure.headline).not.toBe(
      describeTimepointEvidence(BLIND, emptyTimepointFeed(BLIND)).headline,
    )
  })

  it('runs the clock once a timepoint has landed', () => {
    const feed = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(0)], CAPABLE, now(0))
    const disclosure = describeTimepointEvidence(CAPABLE, feed)
    expect(disclosure.state).toBe('measured')
    expect(disclosure.runClock).toBe(true)
  })
})

describe('timepointAgeSeconds re-ages a held feed between polls', () => {
  it('grows the age with wall-clock time without a re-fold', () => {
    const feed: TimepointFeed = advanceTimepointFeed(emptyTimepointFeed(CAPABLE), [tp(0)], CAPABLE, now(0))
    expect(timepointAgeSeconds(feed.newestAt, now(0))).toBe(0)
    expect(timepointAgeSeconds(feed.newestAt, now(75))).toBe(75)
  })

  it('floors at zero rather than reporting a timepoint from the future', () => {
    expect(timepointAgeSeconds(tp(60).timepoint, now(0))).toBe(0)
  })

  it('is null when nothing has landed', () => {
    expect(timepointAgeSeconds(null, now(0))).toBeNull()
  })
})
