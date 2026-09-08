import { createFixtureSource } from '../collect/fixtureSource'
import { createTopologySource } from '../collect/topology'
import { createSemanticModelSource } from '../collect/semanticModelSource'
import { createSemanticModelDaxClient } from '../collect/semanticModelDaxClient'
import { CapacitySourceError, type CapacitySource } from '../collect/source'
import { isFixtureMode } from './bootstrap'

/**
 * Build the semantic-model source from environment configuration.
 *
 * The transport needs a same-origin place to send `executeQueries`, because the Power BI REST API
 * sends no CORS headers. In development that is the Vite proxy; the deployed Fabric app is static
 * hosting with nowhere to run one, which is why this source is a local capability today rather
 * than the default. See README.
 */
function buildSemanticModelSource(): CapacitySource {
  const datasetId = import.meta.env.VITE_FABRIC_METRICS_DATASET_ID
  if (!datasetId) {
    throw new CapacitySourceError(
      'SemanticModel',
      'NotConfigured',
      'Set VITE_FABRIC_METRICS_DATASET_ID to the Capacity Metrics semantic model id.',
    )
  }

  return createSemanticModelSource({
    client: createSemanticModelDaxClient({
      datasetId,
      baseUrl: import.meta.env.VITE_FABRIC_METRICS_PROXY_URL,
    }),
    tenant: {
      tenantId:
        import.meta.env.VITE_FABRIC_TENANT_ID ?? import.meta.env.VITE_FABRIC_WORKSPACE_ID ?? 'unknown',
      displayName: import.meta.env.VITE_FABRIC_TENANT_NAME ?? 'Fabric tenant',
    },
  })
}

export function createConfiguredCapacitySource(): CapacitySource {
  if (isFixtureMode()) return createFixtureSource()

  switch (import.meta.env.VITE_FABRIC_SOURCE) {
    case 'topology':
      return createTopologySource()
    case 'semantic-model':
      return buildSemanticModelSource()
    case 'eventhouse':
      throw new CapacitySourceError(
        'Eventhouse',
        'NotConfigured',
        'eventhouse source is not configured yet.',
      )
    default:
      return createTopologySource()
  }
}
