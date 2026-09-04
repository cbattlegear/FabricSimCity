/// <reference types="vite/client" />

/**
 * The environment the app reads at build time.
 *
 * Everything here is optional on purpose: with none of it set the app runs on fixtures, which is
 * the state a fresh clone is in and the state the whole development loop depends on.
 */
interface ImportMetaEnv {
  /** Which `CapacitySource` to construct. Unset means fixtures when no backend is configured. */
  readonly VITE_FABRIC_SOURCE?: 'fixture' | 'semantic-model' | 'eventhouse' | 'topology'
  /** Base URL of the deployed Rayfin backend. Its absence is what selects fixture mode. */
  readonly VITE_RAYFIN_API_URL?: string
  readonly VITE_RAYFIN_PUBLISHABLE_KEY?: string
  readonly VITE_RAYFIN_FUNCTIONS_URL?: string
  readonly VITE_FABRIC_WORKSPACE_ID?: string
  readonly VITE_FABRIC_ITEM_ID?: string
  readonly VITE_FABRIC_PORTAL_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
