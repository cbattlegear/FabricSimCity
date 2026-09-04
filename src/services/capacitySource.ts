import { createFixtureSource } from '../collect/fixtureSource'
import { createTopologySource } from '../collect/topology'
import { CapacitySourceError, type CapacitySource } from '../collect/source'
import { isFixtureMode } from './bootstrap'

export function createConfiguredCapacitySource(): CapacitySource {
  if (isFixtureMode()) return createFixtureSource()

  switch (import.meta.env.VITE_FABRIC_SOURCE) {
    case 'topology':
      return createTopologySource()
    case 'semantic-model':
    case 'eventhouse':
      throw new CapacitySourceError(
        'Eventhouse',
        'NotConfigured',
        `${import.meta.env.VITE_FABRIC_SOURCE} source is not configured yet.`,
      )
    default:
      return createTopologySource()
  }
}
