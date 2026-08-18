# Operations

SQLSimCity's supported production host is a Linux container host on `linux/amd64`
or `linux/arm64`. The operational scripts require Bash, GNU tar, GNU coreutils,
gzip, and findutils. Run the service on loopback or behind an authenticating
reverse proxy on a trusted network; the application has no authentication and
must not be exposed directly to the internet.

The shipped `appsettings.json` pins `AllowedHosts` to `localhost;127.0.0.1;[::1]`;
this is a `Host` header check, not an exposure control, and loopback binding
remains the actual network boundary. When using a reverse proxy, terminate
TLS and enforce authentication there, restrict the backend network path, and set
`AllowedHosts` to the externally accepted host names (semicolon-separated in
ASP.NET Core configuration). SQLSimCity does not enable forwarded-header
processing, so a proxy must not depend on the app to interpret forwarded scheme
or client-address headers.

## Health and readiness

`GET /healthz` reports that the process is running. `GET /readyz` reports that
startup initialization, including protected-storage initialization when enabled,
completed. Both responses are deliberately generic. Container smoke coverage is:

```bash
tools/container-smoke.sh ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
```

The script binds an ephemeral loopback port, validates health, readiness, atlas,
live, Query Store status/query, and findings status/export contracts, then
removes only the exact containers it created. It also proves that connected
Query Store history without protected storage exits nonzero.

## Backup and tested restore

Stop the application before a backup, or stop/quiesce the container so SQLite
has no writer. `--quiesced` is an explicit operator assertion; the script cannot
prove another process is not writing.

```bash
tools/backup-data.sh --quiesced \
  /var/lib/sqlsimcity/data /backups/sqlsimcity-data-v1.tar.gz
```

The backup is written atomically to a new filename (existing archives are never
overwritten), contains a versioned manifest and checksummed payload, and rejects
symlinks and unsafe paths. There is no key to exclude or store separately: a
backup of the data directory is everything needed to restore. That also makes the
backup itself sensitive — it holds captured query text and plan XML in the clear,
so protect it like the data volume.

Restore only while the application is stopped and only into an existing, empty
directory:

```bash
tools/restore-data.sh \
  --quiesced \
  /backups/sqlsimcity-data-v1.tar.gz /var/lib/sqlsimcity/data
```

The restore validates wrapper paths, manifest version, checksum, payload paths,
and file types before writing to the still-empty target. Run it as the target
owner/group or as root; root restores assign the target's existing owner/group
to the restored tree. After restoring, start the exact image version that created
the data. Confirm `/readyz`, then exercise Query Store status and findings export.
The CI operations test performs a deterministic backup/restore round trip and
negative tests for symlinks, traversal, non-empty targets, and tampering. Paths
that the restore format cannot represent safely are rejected at backup time.

## Starting the store over

Query Store history is a cache the collector rebuilds from SQL Server, not a
system of record, so discarding it costs one collection interval. Stop the app
and delete the database and its sidecars from the data directory:

```bash
rm -f /var/lib/sqlsimcity/data/protected-storage.db \
      /var/lib/sqlsimcity/data/protected-storage.db-wal \
      /var/lib/sqlsimcity/data/protected-storage.db-shm
```

Delete all three. A `-wal` or `-shm` left beside a deleted database yields a
store that fails its canary check on the next start. A store written by a version
that encrypted payloads must be discarded this way — this version has no key and
cannot open it, and says so at startup rather than serving nothing.

## Upgrade and rollback

1. Back up `/data` and test the restore.
2. Resolve the release image to a digest and record the current digest.
3. Review release notes and deploy the new digest with the existing read-only,
   capability-drop, and no-new-privileges settings.
4. Wait for `/readyz`; then check atlas, Query Store, and findings status.
5. Keep the previous image digest and pre-upgrade backup until acceptance.

Protected-storage schema migrations run fail-closed at startup. No backward
migration is promised. Rolling back may require restoring a data backup that is
compatible with the older image; do not point an older image at data already
migrated by a newer version unless that compatibility is explicitly documented.

## Verify a release

Pin deployments by the published manifest digest, never a mutable tag:

```bash
docker pull ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
gh attestation verify \
  oci://ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --repo cbattlegear/SQLSimCity
cosign verify \
  --certificate-identity \
  'https://github.com/cbattlegear/SQLSimCity/.github/workflows/release.yml@refs/tags/<tag>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
docker buildx imagetools inspect \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --format '{{ json .Provenance }}'
docker buildx imagetools inspect \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --format '{{ json .SBOM }}'
cosign download sbom \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> > sqlsimcity.spdx.json
```

The release workflow publishes only owner-created `v*` tags through the
`release` environment. Repository administrators must configure that environment
with required independent reviewers, prevent self-review, and protect `v*` tag
creation before enabling releases. BuildKit emits maximum provenance and an SPDX
SBOM, GitHub records an artifact attestation, and cosign signs by digest with
GitHub OIDC. Release tags are attached only after those steps succeed, and there
is no long-lived signing key. A manual run defaults to a local, non-publishing
smoke build; manually publishing still requires a selected `v*` tag, the
repository owner, and environment approval.

Dependabot updates GitHub Actions, NuGet, web npm, and Docker references weekly.
Action references remain pinned to immutable commits; review the version comment
and upstream release notes when accepting an update.
