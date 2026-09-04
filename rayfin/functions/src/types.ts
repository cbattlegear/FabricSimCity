/**
 * Function schema types for RayfinClient.
 *
 * Regenerate this file with `rayfin dev functions apply` when that command is
 * available in the environment.
 */
export type AppFunctionsSchema = {
  readFabricTopology: {
    input: void
    output: FabricTopologySnapshot
  }
}

export interface FabricTopologyCapacity {
  capacityId: string
  displayName: string
  sku: string | null
  region: string | null
  state: string | null
  stateReason: string | null
}

export interface FabricTopologyWorkspace {
  workspaceId: string
  capacityId: string | null
  name: string
}

export interface FabricTopologyItem {
  itemId: string
  workspaceId: string
  capacityId: string | null
  name: string
  itemType: string | null
}

export interface FabricTopologyFailure {
  scope: 'Capacities' | 'Workspaces' | 'WorkspaceItems'
  endpoint: string
  status: number | null
  failure:
    | 'Unauthenticated'
    | 'PermissionDenied'
    | 'NotConfigured'
    | 'Unsupported'
    | 'Network'
    | 'Unknown'
  message: string
  capacityId?: string | null
  workspaceId?: string
}

export interface FabricTopologySnapshot {
  schemaVersion: '1.0'
  generatedAt: string
  capacities: FabricTopologyCapacity[]
  workspaces: FabricTopologyWorkspace[]
  items: FabricTopologyItem[]
  failures: FabricTopologyFailure[]
  partial: boolean
}
