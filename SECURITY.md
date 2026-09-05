# Security policy

## Scope

FabricSimCity is a static React/Vite Fabric App built on Rayfin. It draws Microsoft Fabric capacity
topology and capacity-metrics telemetry as an atlas and city view inside the customer's own Fabric
workspace.

The SQLSimCity server threat model no longer applies. This repository no longer has a .NET API,
SQL Server connection profile, edge connector, protected-record store, observation archive, Query
Store reader, demo warning banner, or host-binding story to secure.

## Verification status

Be explicit about what is proven. The current React entry point constructs the fixture source
directly, so the locally exercised app reads only deterministic synthetic evidence and does not
authenticate to Fabric.

The Fabric paths are written but unproven here. There is no Fabric tenant available for this branch,
so Rayfin deployment, Fabric brokered sign-in, the Fabric REST topology function, the semantic-model
source, the Eventhouse source, and Rayfin row-level-security policies have not been run end-to-end.
Treat the sections below as the designed posture, not as tenant-verified evidence.

## Identity and authentication

FabricSimCity does not implement its own identity provider. The Rayfin app definition enables Rayfin
auth with Fabric auth, and the production auth service wraps Rayfin's Fabric brokered sign-in. The
backend function that reads topology asks Rayfin for a Fabric audience token from the current
function context before calling Fabric REST.

There is also a password auth service enabled in `rayfin/rayfin.yml`, and the local-dev auth service
contains a fixed fixture email and password for a localhost Rayfin backend. That is not a production
credential path in the React bootstrap code, but it is still configuration that must be reviewed
before claiming a tenant deployment is hardened.

The SPA does not write its own cookies, `localStorage`, or `sessionStorage` entries. If the Rayfin
client is initialized, it is initialized with `authStorage: true`, so browser auth-state storage is
delegated to the Rayfin SDK rather than to application code.

## Authorization and row isolation

The Rayfin data schema defines four entities: cached snapshots, cached snapshot chunks, saved views,
and user preferences. Each entity is decorated with `@authenticated('*', ownedBySignedInUser)`.
That policy matches both `claims.sub` and `claims.email` against `ownerSub` and `ownerEmail` on the
row. There are no `@anonymous` entities in the schema.

Application writes fill those owner fields before upserting Rayfin data. The intended effect is that
a signed-in user can read and mutate only their own cached telemetry and view state. This is an
important design property, but it is not tenant-proven until `rayfin up` has deployed the schema and
the policy has been exercised against a real Fabric identity.

## Fabric permissions

The intended live model is delegated auth. Repository guidance states that Fabric Apps and the
capacity-metrics connectors are private preview and delegated-auth only: each user signs in as
themselves and must already have access to the capacities they view. There is no implemented service
principal path where FabricSimCity reads capacity telemetry once and republishes it to every user.

That means missing Fabric permissions should appear as missing, degraded, or denied telemetry for
that user, not as an application-wide collector failure. It also means deployment credentials for
Rayfin are not runtime credentials for reading customer capacity metrics.

## Data read and storage

The proven local path reads fixture data only.

The written Fabric topology function calls `api.fabric.microsoft.com/v1` for capacities, workspaces,
and workspace items, then returns those values plus per-scope failure records to the browser. It does
not write data.

Two live telemetry sources are present behind the `CapacitySource` interface:

- the Capacity Metrics semantic-model source builds DAX for capacity summaries, item metrics,
  operation families, and timepoints. Its own comments mark the access path as unsupported by
  Microsoft and schema-sensitive.
- the Eventhouse source builds KQL over an assumed capacity-events table for summaries and
  timepoints, with optional topology. Its own comments say the table and column names have not been
  verified against a tenant.

When `createCachedCapacitySource` and `RayfinAppStateStore` are wired in, snapshots are serialized to
JSON, split into text chunks, and persisted in Rayfin-managed data tables. Saved views and user
preferences are also persisted there. The application code does not add its own encryption,
retention policy, or tamper-detection layer over that storage, so treat Rayfin-managed data as
containing tenant topology, capacity telemetry, and view state.

## Secrets and deployment

The Fabric deployment workflow runs on published releases and manual dispatch. It requires
`RAYFIN_WORKSPACE_ID`, `RAYFIN_TENANT_ID`, and either `RAYFIN_TOKEN` or the
`RAYFIN_CLIENT_ID`/`RAYFIN_CLIENT_SECRET` service-principal pair. The workflow reads those values
from GitHub secrets or variables, logs notices when they are missing, and skips `rayfin up` rather
than attempting a partial deployment.

The frontend `VITE_RAYFIN_PUBLISHABLE_KEY` is a publishable client key, not a secret. Do not put
tenant credentials, Fabric tokens, or connector credentials into Vite environment variables: Vite
values are compiled into the static bundle.

## Residual risks and non-goals

- Live Fabric behavior is unverified in this branch. Do not remove that warning until the app has
  been deployed and exercised against a real tenant.
- The current React entry point is still fixture-only. The live auth, data-store, and configurable
  source services exist, but the main app does not call them.
- FabricSimCity relies on Rayfin, Fabric, and the browser for identity/session security. It does not
  add an application-specific MFA, session policy, or authorization layer.
- Persisted Rayfin app data is scoped by the schema policy above, but the app does not implement its
  own at-rest encryption or retention pruning.

## Reporting

Report suspected vulnerabilities privately through the repository owner's GitHub security advisory
channel. Do not include real credentials, customer tenant names, Fabric tokens, or production
telemetry in a report; use synthetic data where possible.
