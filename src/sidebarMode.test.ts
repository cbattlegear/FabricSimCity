import { describe, expect, it } from 'vitest'
import { resolveSidebarMode, ROUTE_TITLE, type SidebarRouteSummary } from './sidebarMode'

const route: SidebarRouteSummary = { planId: '42', placedStops: 3, totalStops: 4, offMapStops: 1 }

describe('resolveSidebarMode with no route open', () => {
  const mode = resolveSidebarMode({ capacityName: 'Fabrikam F64', totalItemsLabel: '1,234', route: null })

  it('titles the header with the capacity name', () => {
    expect(mode.title).toBe('Fabrikam F64')
  })

  it('subtitles with the item count and city label', () => {
    expect(mode.subtitle).toBe('1,234 items · capacity city')
  })

  it('sends the back button to the capacity atlas without touching a route', () => {
    expect(mode.backLabel).toBe('Back to the capacity atlas')
    expect(mode.clearsRoute).toBe(false)
  })

  it('renders the address book', () => {
    expect(mode.showsAddressBook).toBe(true)
  })
})

describe('resolveSidebarMode with a route open', () => {
  const mode = resolveSidebarMode({ capacityName: 'Fabrikam F64', totalItemsLabel: '1,234', route })

  it('renames the header to the route', () => {
    expect(mode.title).toBe(ROUTE_TITLE)
    expect(mode.title).not.toBe('Fabrikam F64')
  })

  it('carries the family id and placed/total stop count in the subtitle', () => {
    expect(mode.subtitle).toBe('Family 42 · 3 of 4 items placed · 1 off-map')
  })

  it('turns the back button into a clear-route control back to the capacity', () => {
    expect(mode.backLabel).toBe('Back to Fabrikam F64')
    expect(mode.clearsRoute).toBe(true)
  })

  it('collapses the address book so the route fills the rail', () => {
    expect(mode.showsAddressBook).toBe(false)
  })
})

describe('resolveSidebarMode subtitle detail', () => {
  it('singularises a one-item route and omits off-map when there is none', () => {
    const mode = resolveSidebarMode({
      capacityName: 'capacity',
      totalItemsLabel: '9',
      route: { planId: '7', placedStops: 1, totalStops: 1, offMapStops: 0 },
    })
    expect(mode.subtitle).toBe('Family 7 · 1 of 1 item placed')
  })

  it('reports every stop off-map when none could be drawn', () => {
    const mode = resolveSidebarMode({
      capacityName: 'capacity',
      totalItemsLabel: '9',
      route: { planId: '7', placedStops: 0, totalStops: 2, offMapStops: 2 },
    })
    expect(mode.subtitle).toBe('Family 7 · 0 of 2 items placed · 2 off-map')
  })
})

