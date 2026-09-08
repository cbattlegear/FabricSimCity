/// <reference types="vite/client" />

/**
 * The environment the app reads at build time.
 *
 * Everything here is optional on purpose: with none of it set the app runs on fixtures, which is
 * the state a fresh clone is in and the state the whole development loop depends on.
 */
interface ImportMetaEnv {
  /** Which `CapacitySource` to construct. Unset means fixtures when no backend is configured. */
  readonly VITE_FABRIC_SOURCE?: 'fixture' | 'semantic-model' | 'ingested' | 'eventhouse' | 'topology'
  /** Base URL of the deployed Rayfin backend. Its absence is what selects fixture mode. */
  readonly VITE_RAYFIN_API_URL?: string
  readonly VITE_RAYFIN_PUBLISHABLE_KEY?: string
  readonly VITE_RAYFIN_FUNCTIONS_URL?: string
  readonly VITE_FABRIC_WORKSPACE_ID?: string
  readonly VITE_FABRIC_ITEM_ID?: string
  readonly VITE_FABRIC_PORTAL_URL?: string
  /**
   * Object id of the Capacity Metrics semantic model, from the metrics app's dataset URL.
   * Required by `VITE_FABRIC_SOURCE=semantic-model`.
   */
  readonly VITE_FABRIC_METRICS_DATASET_ID?: string
  /**
   * Same-origin path or origin that forwards to the Power BI REST API. Defaults to `/powerbi`,
   * which the dev server proxies. There is deliberately no token variable here: a `VITE_`-prefixed
   * one would be inlined into the bundle and published with the site.
   */
  readonly VITE_FABRIC_METRICS_PROXY_URL?: string
  /** Tenant id reported alongside semantic-model readings. Defaults to the workspace's. */
  readonly VITE_FABRIC_TENANT_ID?: string
  /** Display name for the tenant in the atlas. */
  readonly VITE_FABRIC_TENANT_NAME?: string
  /**
   * How often the ingest notebook is scheduled, in minutes. Used by
   * `VITE_FABRIC_SOURCE=ingested` to report how stale the city may be — set it to the notebook's
   * actual schedule, not to how fresh you would like the data to look.
   */
  readonly VITE_FABRIC_INGEST_INTERVAL_MINUTES?: string
  /** How many days of history the notebook ingests. Reported as the source's retention. */
  readonly VITE_FABRIC_INGEST_WINDOW_DAYS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
