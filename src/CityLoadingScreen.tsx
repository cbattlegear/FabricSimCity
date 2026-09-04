import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { CITY_LOADING_SAYINGS, loadingProgress, sayingReel } from './cityLoadingSayings'

/**
 * The screen the city is built behind.
 *
 * Laying out a large capacity is genuinely slow — a four thousand item city traces tens of
 * thousands of streets before it can draw one building — and the honest answer to slow work is to
 * say what is happening rather than to hold a blank stage. So this borrows the shape of the loading
 * screen every city builder has used since 1993: a bar, a count, and a line of deadpan nonsense
 * about work nobody is doing.
 *
 * The division of labour matters more here than it looks. The bar and the count are **measured** —
 * items actually fetched, against the total the API reported — and the sayings are **invented**,
 * and the screen says which is which. That is the same boundary the map itself draws between a
 * building's footprint and the colour of its roof, applied to the one screen that has the least to
 * report and therefore the most room to bluff.
 *
 * Everything that moves is animated with `transform` and `opacity` only, so it runs on the
 * compositor. That is not a micro-optimisation: the expensive layout pass blocks the main thread
 * outright, and an animation driven by JavaScript or by `width` would freeze solid at exactly the
 * moment the user most needs to see that the app is still alive.
 */
export function CityLoadingScreen({
  title,
  status,
  loaded,
  total,
  sayings = CITY_LOADING_SAYINGS,
  random = Math.random,
  intervalMs = SAYING_INTERVAL_MS,
}: {
  /** What is being built, named. */
  title: string
  /** A truthful sentence about the current stage. Changes rarely, so it is safe to announce. */
  status: string
  /** Items fetched so far, or `null` before the first page lands. */
  loaded: number | null
  /** Items the capacity reports in total, or `null` while that is still unknown. */
  total: number | null
  sayings?: readonly string[]
  random?: () => number
  intervalMs?: number
}) {
  const reel = useMemo(() => sayingReel(sayings, random), [sayings, random])
  const [saying, setSaying] = useState(reel)

  useEffect(() => {
    const timer = setInterval(() => setSaying(reel()), intervalMs)
    return () => clearInterval(timer)
  }, [reel, intervalMs])

  const progress = loadingProgress(loaded, total)
  const percent = progress === null ? null : Math.round(progress * 100)
  const counted =
    loaded !== null && total !== null && total > 0
      ? `${loaded.toLocaleString()} of ${total.toLocaleString()} items surveyed`
      : null

  return (
    <section className="city-loading" aria-busy="true">
      <div className="city-loading-panel">
        <p className="city-loading-eyebrow">
          Building <strong>{title}</strong>
        </p>

        {/*
          * The skyline lights up left to right as the bar fills, so progress is legible from the
          * far side of a room without reading a number. It is the same measurement as the bar, drawn
          * twice, not a second claim.
          */}
        <div
          className="city-loading-skyline"
          style={{ '--lit': `${percent ?? 0}%` } as CSSProperties}
          aria-hidden="true"
        >
          <span className="city-loading-skyline-lit" />
        </div>

        {/*
          * Keyed on the text so React remounts the element rather than patching the text node. The
          * fade is a CSS animation, and a CSS animation only plays on mount — without this the first
          * saying eases in and every one after it hard-cuts. `sayingReel` never returns the same line
          * twice in a row, so the key is guaranteed to change on every tick.
          */}
        <p className="city-loading-saying" key={saying} aria-hidden="true">
          {saying}…
        </p>

        <div
          className="city-loading-bar"
          role="progressbar"
          aria-label={`Building ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { 'aria-valuenow': percent })}
          aria-valuetext={counted ?? status}
        >
          <span
            className={`city-loading-fill ${percent === null ? 'is-unknown' : ''}`}
            style={{ '--filled': `${percent ?? 0}%` } as CSSProperties}
          />
        </div>

        {/* Announced, because it changes twice in a load rather than eighty times. */}
        <p className="city-loading-status" role="status">
          {status}
        </p>

        {/* Already carried by the bar's `aria-valuetext`, so it is not read out twice. */}
        <p className="city-loading-count" aria-hidden="true">
          {counted ?? 'Counting what there is to build…'}
        </p>

        <p className="city-loading-disclosure">
          The bar and the count are measured. The commentary is invented and reports nothing.
        </p>
      </div>
    </section>
  )
}

/**
 * How long a saying stays up.
 *
 * Long enough to read a ten-word line twice without hurrying, short enough that a stalled screen
 * still visibly ticks. Shorter than this and the screen becomes a slot machine; longer and a fast
 * load never shows a second line, which is most of the joke.
 */
const SAYING_INTERVAL_MS = 2600
