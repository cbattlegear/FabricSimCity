import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapacityCityViewport } from './CapacityCityViewport'
import { createDatabaseCityScene, type DatabaseCitySceneController } from './CapacityCityScene'
import { createFixtureSource } from './collect/fixtureSource'
import { planCity } from './cityPlan'
import { assignWorkloadTraffic } from './cityWorkloadTraffic'
import { projectFacilityTraffic } from './cityFacilityTraffic'

vi.mock('./CapacityCityScene', () => ({ createDatabaseCityScene: vi.fn() }))

function makeController() {
  return {
    setObjects: vi.fn(), setRoads: vi.fn(), setTraffic: vi.fn(), setFacilities: vi.fn(),
    setFacilityTraffic: vi.fn(), setRoute: vi.fn(), setSelected: vi.fn(), setSelectedRoad: vi.fn(),
    setStaleStatsObjects: vi.fn(), setFireObjects: vi.fn(), setWaterMainBreaks: vi.fn(),
    setLayers: vi.fn(), setIncidents: vi.fn(), refreshVehicles: vi.fn(),
    incidentPlacement: vi.fn(() => null), incidentScreenPosition: vi.fn(() => null),
    setViewMode: vi.fn(), resetView: vi.fn(), frameRoute: vi.fn(), frameRoad: vi.fn(),
    focusObject: vi.fn(), nudge: vi.fn(), setTour: vi.fn(), heading: vi.fn(() => 37),
    getPlan: vi.fn(() => null), dispose: vi.fn(),
  } satisfies DatabaseCitySceneController
}

let container: HTMLDivElement
let root: Root | null
let controller: ReturnType<typeof makeController>
let props: ComponentProps<typeof CapacityCityViewport>

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  controller = makeController()
  vi.mocked(createDatabaseCityScene).mockReturnValue(controller)
  const source = createFixtureSource()
  const atlas = await source.readAtlas()
  const page = await source.readCityPage({
    capacityId: atlas.capacities[0].capacityId, metric: 'Cu', pageSize: 1,
  })
  const cityPlan = planCity(page.items, { seed: page.capacityId })
  props = {
    objects: page.items, cityPlan, viewMode: 'city', roads: [], facilities: [],
    traffic: assignWorkloadTraffic(cityPlan, []),
    facilityTraffic: projectFacilityTraffic([], [], page.throttle, source.capabilities),
    route: null, selectedId: null, selectedRoadId: null, roadLabels: new Map(),
    onSelect: vi.fn(), onSelectRoad: vi.fn(), onOpenIncident: vi.fn(),
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(next = props) {
  await act(async () => { root!.render(<CapacityCityViewport {...next} />) })
}

describe('city renderer lifetime', () => {
  it('retains the populated scene when a refresh only replaces parent callbacks', async () => {
    await render()
    const canvas = container.querySelector('canvas')
    const next = { ...props, onSelect: vi.fn(), onSelectRoad: vi.fn(), onOpenIncident: vi.fn() }
    await render(next)
    expect(createDatabaseCityScene).toHaveBeenCalledTimes(1)
    expect(controller.dispose).not.toHaveBeenCalled()
    expect(controller.setObjects).toHaveBeenCalledExactlyOnceWith(props.objects, props.cityPlan)
    expect(container.querySelector('canvas')).toBe(canvas)
  })

  it('delivers events from the original scene to the latest callbacks', async () => {
    await render()
    const options = vi.mocked(createDatabaseCityScene).mock.calls[0][1]
    const next = { ...props, onSelect: vi.fn(), onSelectRoad: vi.fn(), onOpenIncident: vi.fn() }
    await render(next)
    await act(async () => {
      options.onSelect('item-new')
      options.onSelectRoad?.('road-new')
      options.onSelectIncident?.('incident-new')
    })
    expect(next.onSelect).toHaveBeenCalledExactlyOnceWith('item-new')
    expect(next.onSelectRoad).toHaveBeenCalledExactlyOnceWith('road-new')
    expect(next.onOpenIncident).toHaveBeenCalledExactlyOnceWith('incident-new')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onSelectRoad).not.toHaveBeenCalled()
    expect(props.onOpenIncident).not.toHaveBeenCalled()
  })

  it('applies refreshed data and selection without resetting the renderer and disposes on unmount', async () => {
    await render()
    const next = {
      ...props, objects: [...props.objects], cityPlan: { ...props.cityPlan },
      selectedId: props.objects[0].itemId, viewMode: 'map' as const,
      onSelect: vi.fn(), onSelectRoad: vi.fn(), onOpenIncident: vi.fn(),
    }
    await render(next)
    expect(createDatabaseCityScene).toHaveBeenCalledTimes(1)
    expect(controller.setObjects).toHaveBeenLastCalledWith(next.objects, next.cityPlan)
    expect(controller.setSelected).toHaveBeenLastCalledWith(next.selectedId)
    expect(controller.setViewMode).toHaveBeenLastCalledWith('map')
    expect(controller.dispose).not.toHaveBeenCalled()
    await act(async () => { root!.unmount(); root = null })
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })
})
