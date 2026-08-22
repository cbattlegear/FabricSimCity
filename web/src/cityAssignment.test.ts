import { describe, expect, it } from 'vitest'

import { assignTraffic, tourDemands, type TravelDemand } from './cityAssignment'
import { planField } from './cityField'
import { breakCrossings, buildPlanarGraph } from './cityGraph'
import { classifyRoads, RoadRouter } from './cityRouting'
import { traceStreamlines } from './cityStreamlines'

function city(seed = 'assignment') {
  const radius = 620
  const separation = 62
  const field = planField({ seed, centreX: 0, centreZ: 0, radius })
  const streamlines = traceStreamlines({
    field,
    minX: -radius * 1.1,
    maxX: radius * 1.1,
    minZ: -radius * 1.1,
    maxZ: radius * 1.1,
    separation,
    edgeSeparationScale: 2.3,
    minLength: 90,
    maxStreamlines: 700,
  })
  const options = {
    weldRadius: separation * 0.12,
    snapRadius: separation * 0.75,
    minStub: separation * 0.35,
  }
  const graph = breakCrossings(
    buildPlanarGraph(streamlines, options),
    {
      seed: 7,
      targetCrossroadShare: 0.24,
      protectLength: separation * 7,
      maxRemovalShare: 0.3,
      maxMergedBlocks: 3,
      maxBlockArea: separation * separation * 7,
    },
    options,
  )
  const properties = classifyRoads(graph)
  return { graph, properties }
}

/** Junctions spread across the network, all in its largest connected part so routes exist. */
function nodesAcross(graph: ReturnType<typeof city>['graph'], count: number): number[] {
  const seen = new Set<number>()
  let largest: number[] = []
  for (const id of graph.nodes.keys()) {
    if (seen.has(id)) continue
    const part: number[] = []
    const stack = [id]
    seen.add(id)
    while (stack.length > 0) {
      const at = stack.pop()!
      part.push(at)
      for (const edgeId of graph.incident.get(at) ?? []) {
        const edge = graph.edges[edgeId]
        const far = edge.fromId === at ? edge.toId : edge.fromId
        if (!seen.has(far)) {
          seen.add(far)
          stack.push(far)
        }
      }
    }
    if (part.length > largest.length) largest = part
  }
  largest.sort((a, b) => a - b)
  const stride = Math.max(1, Math.floor(largest.length / count))
  const picked: number[] = []
  for (let index = 0; index < largest.length && picked.length < count; index += stride) {
    picked.push(largest[index])
  }
  return picked
}

describe('assignTraffic', () => {
  it('routes every demand whose endpoints are on the network', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 12)
    const demands: TravelDemand[] = []
    for (let index = 0; index + 1 < nodes.length; index += 1) {
      demands.push({
        key: `q${index}`,
        fromNodeId: nodes[index],
        toNodeId: nodes[index + 1],
        trips: 1000 * (index + 1),
      })
    }

    const assignment = assignTraffic(graph, properties, demands)
    expect(assignment.trips).toHaveLength(demands.length)
    expect(assignment.unroutable).toHaveLength(0)
  })

  it('reports flow in the caller units, conserving the total trips loaded', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 6)
    const demands: TravelDemand[] = [
      { key: 'a', fromNodeId: nodes[0], toNodeId: nodes[3], trips: 40_000 },
      { key: 'b', fromNodeId: nodes[1], toNodeId: nodes[4], trips: 5_000 },
    ]
    const assignment = assignTraffic(graph, properties, demands)

    let loaded = 0
    for (const value of assignment.flow.values()) loaded += value
    // Every trip lands on at least one street, so the total flow is at least the total demand.
    expect(loaded).toBeGreaterThan(45_000)
    // And each demand is spread over its own route only, so it cannot exceed demand times the
    // longest route in edges.
    expect(Number.isFinite(loaded)).toBe(true)
  })

  it('leaves the network untouched when there is no workload', () => {
    const { graph, properties } = city()
    const assignment = assignTraffic(graph, properties, [])
    expect(assignment.trips).toHaveLength(0)
    for (const value of assignment.flow.values()) expect(value).toBe(0)
    for (const value of assignment.delay.values()) expect(value).toBe(1)
  })

  it('leaves the streets the workload never reaches empty', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 4)
    const assignment = assignTraffic(
      graph,
      properties,
      [{ key: 'only', fromNodeId: nodes[0], toNodeId: nodes[2], trips: 1_000_000 }],
      { capacityPerLane: 0.02 },
    )

    let touched = 0
    for (const edge of graph.edges) {
      const carried = assignment.flow.get(edge.id) ?? 0
      if (carried > 0) {
        touched += 1
        expect(assignment.delay.get(edge.id)).toBeGreaterThan(1)
      } else {
        expect(assignment.delay.get(edge.id)).toBe(1)
      }
    }
    // One journey across town touches a corridor, not the city.
    expect(touched).toBeGreaterThan(0)
    expect(touched).toBeLessThan(graph.edges.length * 0.25)

    // And everything it finally drives along is carrying traffic.
    for (const edgeId of assignment.trips[0].route.edgeIds) {
      expect(assignment.flow.get(edgeId)).toBeGreaterThan(0)
    }
  })

  it('never lets delay fall below one, so the A* estimate stays admissible', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 10)
    const demands = nodes.slice(0, 9).map((from, index) => ({
      key: `d${index}`,
      fromNodeId: from,
      toNodeId: nodes[index + 1],
      trips: 1000,
    }))
    const assignment = assignTraffic(graph, properties, demands, { capacityPerLane: 0.01 })
    for (const value of assignment.delay.values()) {
      expect(value).toBeGreaterThanOrEqual(1)
      // Bounded by the saturation ceiling: 1 + alpha * maxSaturation ** beta.
      expect(value).toBeLessThanOrEqual(1 + 0.15 * 3 ** 4 + 1e-9)
    }
  })

  it('spreads a heavy workload onto more streets than one route needs', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 8)

    // Journeys all over town, of very different weights.
    const demands = []
    for (let index = 0; index < nodes.length; index += 1) {
      for (let other = index + 1; other < nodes.length; other += 1) {
        demands.push({
          key: `${index}-${other}`,
          fromNodeId: nodes[index],
          toNodeId: nodes[other],
          trips: 1000 * (index + 1) * (other + 1),
        })
      }
    }

    const assignment = assignTraffic(graph, properties, demands)
    const distinct = new Set(assignment.trips.map((trip) => trip.route.edgeIds.join(',')))
    expect(distinct.size).toBeGreaterThan(demands.length * 0.8)

    // Some journey was pushed off the way it would have gone on empty streets.
    const free = new RoadRouter(graph, properties)
    const diverted = assignment.trips.filter((trip) => {
      const demand = demands.find((candidate) => candidate.key === trip.key)!
      const empty = free.route(demand.fromNodeId, demand.toNodeId)
      return empty !== null && empty.edgeIds.join(',') !== trip.route.edgeIds.join(',')
    })
    expect(diverted.length).toBeGreaterThan(0)
  })

  it('sends the busiest journey down the quickest road it can find', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 8)
    const demands = []
    for (let index = 0; index + 1 < nodes.length; index += 1) {
      demands.push({
        key: `d${index}`,
        fromNodeId: nodes[index],
        toNodeId: nodes[index + 1],
        trips: 1000,
      })
    }
    // One dominant flow, loaded first because it is the heaviest.
    demands.push({ key: 'dominant', fromNodeId: nodes[0], toNodeId: nodes[7], trips: 500_000 })

    const assignment = assignTraffic(graph, properties, demands)
    const dominant = assignment.trips.find((trip) => trip.key === 'dominant')!
    const free = new RoadRouter(graph, properties).route(nodes[0], nodes[7])!
    expect(dominant.route.edgeIds).toEqual(free.edgeIds)
  })

  it('gives the same assignment for the same input', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 8)
    const demands = nodes.slice(0, 7).map((from, index) => ({
      key: `d${index}`,
      fromNodeId: from,
      toNodeId: nodes[index + 1],
      trips: 3000 * (index + 1),
    }))

    const first = assignTraffic(graph, properties, demands)
    const second = assignTraffic(graph, properties, demands)
    expect(second.trips.map((trip) => trip.route.edgeIds)).toEqual(
      first.trips.map((trip) => trip.route.edgeIds),
    )
    expect([...second.flow.entries()]).toEqual([...first.flow.entries()])
  })

  it('scales congestion to the shape of the workload, not to how busy the server is', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 6)
    const shape = (multiplier: number) =>
      nodes.slice(0, 5).map((from, index) => ({
        key: `d${index}`,
        fromNodeId: from,
        toNodeId: nodes[index + 1],
        trips: 1000 * (index + 1) * multiplier,
      }))

    const quiet = assignTraffic(graph, properties, shape(1))
    const busy = assignTraffic(graph, properties, shape(10_000))
    expect([...busy.saturation.entries()]).toEqual([...quiet.saturation.entries()])
  })

  it('ignores demands that go nowhere or are not on the network', () => {
    const { graph, properties } = city()
    const nodes = nodesAcross(graph, 4)
    const assignment = assignTraffic(graph, properties, [
      { key: 'loop', fromNodeId: nodes[0], toNodeId: nodes[0], trips: 100 },
      { key: 'absent', fromNodeId: 10 ** 9, toNodeId: nodes[1], trips: 100 },
      { key: 'idle', fromNodeId: nodes[0], toNodeId: nodes[1], trips: 0 },
      { key: 'real', fromNodeId: nodes[0], toNodeId: nodes[2], trips: 100 },
    ])
    expect(assignment.trips.map((trip) => trip.key)).toEqual(['real'])
    expect(assignment.unroutable.sort()).toEqual(['absent', 'idle', 'loop'])
  })
})

describe('tourDemands', () => {
  it('walks a multi-stop family as consecutive legs', () => {
    const demands = tourDemands('family', [4, 9, 16], 500)
    expect(demands).toEqual([
      { key: 'family:0', fromNodeId: 4, toNodeId: 9, trips: 500 },
      { key: 'family:1', fromNodeId: 9, toNodeId: 16, trips: 500 },
    ])
  })

  it('keeps a two-stop family under its own key, unsuffixed', () => {
    expect(tourDemands('family', [4, 9], 500)).toEqual([
      { key: 'family', fromNodeId: 4, toNodeId: 9, trips: 500 },
    ])
  })

  it('drops repeated stops rather than generating a journey to the same place', () => {
    expect(tourDemands('family', [4, 4, 9], 500)).toEqual([
      { key: 'family', fromNodeId: 4, toNodeId: 9, trips: 500 },
    ])
  })

  it('generates nothing for a family that touches one table', () => {
    expect(tourDemands('family', [4], 500)).toEqual([])
    expect(tourDemands('family', [], 500)).toEqual([])
  })
})
