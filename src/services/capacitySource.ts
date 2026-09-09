import { createFixtureSource } from '../collect/fixtureSource'
import { createTopologySource } from '../collect/topology'
import { createSemanticModelSource } from '../collect/semanticModelSource'
import { createSemanticModelDaxClient } from '../collect/semanticModelDaxClient'
import { createIngestedCapacitySource, DEFAULT_INGEST_INTERVAL_MINUTES, DEFAULT_INGEST_WINDOW_DAYS } from '../collect/ingestedDax'
import { createRayfinIngestStore } from '../collect/rayfinIngestStore'
import { CapacitySourceError, type CapacitySource } from '../collect/source'
import { bootstrapAuth, isFixtureMode } from './bootstrap'
import { getRayfinClient } from './rayfinClient'

function tenantIdentity(): { tenantId: string; displayName: string } {
  return {
    tenantId:
      import.meta.env.VITE_FABRIC_TENANT_ID ?? import.meta.env.VITE_FABRIC_WORKSPACE_ID ?? 'unknown',
    displayName: import.meta.env.VITE_FABRIC_TENANT_NAME ?? 'Fabric tenant',
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  // Empty counts as unset: Vite substitutes '' for a variable declared but not given a value, and
  // `Number('')` is 0 — which would silently claim the notebook runs continuously.
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  // A typo in an env var must not quietly become NaN latency, which renders as an unknown age
  // rather than as a misconfiguration anyone would go and fix.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

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
    tenant: tenantIdentity(),
  })
}

/**
 * Build the source the *deployed* app uses.
 *
 * Unlike `semantic-model`, this needs no proxy and no connector: a scheduled Fabric notebook has
 * already run the DAX and written the rows into the app's own database. See `ingestedDax.ts`.
 */
function buildIngestedSource(): CapacitySource {
  const tenant = tenantIdentity()
  return createIngestedCapacitySource({
    store: createRayfinIngestStore(getRayfinClient(), {
      tenantId: tenant.tenantId,
      datasetId: import.meta.env.VITE_FABRIC_METRICS_DATASET_ID,
    }),
    tenant,
    intervalMinutes: positiveNumber(
      import.meta.env.VITE_FABRIC_INGEST_INTERVAL_MINUTES,
      DEFAULT_INGEST_INTERVAL_MINUTES,
    ),
    windowDays: positiveNumber(
      import.meta.env.VITE_FABRIC_INGEST_WINDOW_DAYS,
      DEFAULT_INGEST_WINDOW_DAYS,
    ),
  })
}

export function createConfiguredCapacitySource(): CapacitySource {
  if (isFixtureMode()) return createFixtureSource()

  switch (import.meta.env.VITE_FABRIC_SOURCE) {
    case 'topology':
      return createTopologySource()
    case 'semantic-model':
      return buildSemanticModelSource()
    case 'ingested':
      return buildIngestedSource()
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

let authService: ReturnType<typeof bootstrapAuth> | null = null
let sessionReady: Promise<void> | null = null
let stableSource: CapacitySource | null = null

/**
 * Adopt Fabric's session before querying client.data, without a login page or popup.
 * Each ingest refresh gets its own source so SQL replay can pin the newest completed run.
 */
export async function loadConfiguredCapacitySource(): Promise<CapacitySource> {
  const configured = import.meta.env.VITE_FABRIC_SOURCE
  if (isFixtureMode() || configured === 'semantic-model' || configured === 'eventhouse') {
    return stableSource ??= createConfiguredCapacitySource()
  }

  if (!sessionReady) {
    authService ??= bootstrapAuth()
    const auth = authService
    sessionReady = auth.initEmbeddedAuth()
      .then(async (embedded) => {
        if (!(embedded ?? await auth.getCurrentUser())) {
          throw new CapacitySourceError(
            'SemanticModel',
            'Unauthenticated',
            'Open this app inside the Fabric portal to use its built-in session, then reload.',
          )
        }
      })
      .catch((error) => {
        sessionReady = null
        throw error
      })
  }
  await sessionReady
  if (configured === 'ingested') return createConfiguredCapacitySource()
  return stableSource ??= createConfiguredCapacitySource()
}
