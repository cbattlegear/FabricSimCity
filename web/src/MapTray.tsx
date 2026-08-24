import { useEffect, useState, type ReactNode } from 'react'

/**
 * The map overlay tray.
 *
 * On a desktop there is room beside the map for the layer switches, the feed status and the blocking
 * summary to all stand open at once, and that is the right thing: they are read at a glance and never
 * asked for. On a phone there is not. Measured on a 390-point viewport, those three panels covered
 * **60% of the map** -- the map being the one thing the page exists to show.
 *
 * So on a narrow viewport the same panels become a row of chips and at most one opens at a time. The
 * map is clear until the reader asks for something.
 *
 * The one rule this must not break is the app's own: *a warning that a narrow screen hides is a
 * warning that was not given*. A chip is therefore not a hiding place. An item that marks itself
 * {@link TrayItem.alert} opens itself and stays open, so a real blocking incident still arrives
 * unasked; only the quiet states -- no blocked waiter, feed connected, layers all on -- fold away.
 * Every chip also carries its own state in its label, so even folded, nothing reads as "all clear"
 * that is not.
 */

export interface TrayItem {
  id: string
  /** Chip text. Short: this sits three-across on a phone. */
  label: string
  /** Leading glyph, decorative only. */
  glyph?: string
  /**
   * True when this item is currently saying something the reader must not have to ask for. Such an
   * item opens on its own and cannot be the one that closes when another is opened.
   */
  alert?: boolean
  /** Extra class on the chip, for tone. */
  tone?: string
  content: ReactNode
}

/** Media query for "the map is too narrow to carry panels in its corners". Shared with App.css. */
export const NARROW_QUERY = '(max-width: 900px)'

export function useNarrowViewport(query: string = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia(query)
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return narrow
}

export function MapTray({ items, label }: { items: readonly TrayItem[]; label: string }) {
  const narrow = useNarrowViewport()
  const [openId, setOpenId] = useState<string | null>(null)

  const alerting = items.find(item => item.alert)?.id ?? null

  // An alert opens its own panel the moment it appears. The reader can close it again -- the finding
  // is still on the chip -- and it reopens if the alert state changes.
  useEffect(() => {
    if (alerting) setOpenId(alerting)
  }, [alerting])

  useEffect(() => {
    if (!narrow || !openId) return
    const onKey = (event: KeyboardEvent) => {
      // Escape closes the tray outright. Returning to the alerting item instead would make Escape a
      // no-op whenever an alert is showing -- which is most of the time -- and leave a keyboard
      // reader with no way to uncover the map short of finding the chip again. The finding stays on
      // the chip, and the effect above reopens the panel if the alert state changes again.
      if (event.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow, openId])

  if (!narrow) {
    return <>{items.map(item => <div key={item.id} className="tray-open">{item.content}</div>)}</>
  }

  const open = items.find(item => item.id === openId) ?? null

  return (
    <div className="map-tray">
      <div className="map-tray-chips" role="group" aria-label={label}>
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            className={`map-tray-chip ${item.tone ?? ''} ${openId === item.id ? 'is-open' : ''}`}
            aria-expanded={openId === item.id}
            aria-controls={`tray-${item.id}`}
            onClick={() => setOpenId(current => (current === item.id ? null : item.id))}
          >
            {item.glyph && <span aria-hidden="true">{item.glyph}</span>}
            {item.label}
          </button>
        ))}
      </div>
      {open && (
        <div className="map-tray-panel" id={`tray-${open.id}`}>
          {open.content}
        </div>
      )}
    </div>
  )
}
