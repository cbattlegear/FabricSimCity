# FabricSimCity

**Turn a Microsoft Fabric capacity into a city you can walk through.** FabricSimCity draws your
tenant as an atlas of capacities and each capacity as a city — items are buildings sized by real
OneLake storage and CU consumption, operations are traffic, and throttling is a power grid running
short.

Every shape maps to a measurement you can verify. Nothing is invented, and unavailable evidence is
drawn as a wireframe rather than a guess.

It runs as a **Fabric App** built on [Rayfin](https://rayfin.ai), so it renders the capacity it
lives in — `AppBackend` is itself an item type, which means FabricSimCity appears as a building in
its own city.

Rebuilt from [SQLSimCity](https://github.com/cbattlegear/SQLSimCity), which drew a SQL Server the
same way. Heavily inspired by [PGSimCity](https://github.com/NikolayS/PGSimCity).

## The metaphor

A Fabric capacity is *literally* a power grid, which makes the city read more honestly than it did
over SQL Server:

| Fabric | Drawn as |
|---|---|
| Tenant | The atlas — every capacity as its own city |
| Capacity (F2…F8192) | A city. The real contention boundary. |
| Workspace | A neighbourhood |
| Item (Lakehouse, Notebook, Warehouse, Semantic model…) | A building |
| Operation family | A road, with traffic on it |
| Interactive vs background operations | Cars vs freight |
| SKU CU budget | The power plant, and the size of the ground the city is built on |
| CU smoothing | Reservoirs — 5–64 min interactive, 24 h background |
| Carry-forward | A debt heap that grows and drains, with a burndown ETA |
| Throttle stages | Delay gate → rejection gate → background embargo |
| Overload state | Weather: brownout tinting, then blackout |

**Plot size is the SKU's CU budget; tower height is the CU seconds actually consumed.** The ratio
between them is mean utilization, drawn rather than stated: a capacity comfortably inside its
budget is a low city on wide ground, and a small SKU being hammered is a thin skyscraper on a tiny
plot. In the fixture tenant, `Fabrikam Dev` is an F2 with the tallest towers in the atlas, and it
is rejecting everything.

Footprint within a city comes from OneLake bytes, so a cold Lakehouse is a wide flat warehouse and
a runaway Notebook is a spire on a minimum lot. Compute-only items get a minimum lot, which is
correct rather than a fallback.

## Never draw a guess

A missing measurement renders as **wireframe**, never as zero.

A paused capacity emits no telemetry at all, and an idle one emits zeroes. Those are completely
different things and drawing them the same way would be a lie the picture tells confidently. So
`capacityHeight()` returns `null` rather than `0` for unknown CU, an unrecognised SKU gets no plot
size rather than a default one, and both end up as bare ground.

## Quick start

No Fabric tenant required. The app ships with a deterministic fixture tenant — six capacities
covering every state the city can render — and that is the primary development loop, not a
fallback.

```powershell
npm install
npm run dev
```

Open http://localhost:5173. You get `Contoso Ltd`: two healthy capacities, one at each of the three
throttle stages, and one suspended.

### Against a real tenant

Fabric Apps and the capacity metrics connectors are in **private preview**, and the connectors are
delegated-auth only — every user signs in as themselves and sees only the capacities they already
have access to. There is no service-principal path where the app reads once for everyone.

```powershell
npx rayfin login
npx rayfin up --workspace "<your capacity-backed workspace>"
npx rayfin up status
```

The workspace has to be named on the **first** deploy — `rayfin up` records the binding in
`rayfin/.deployments.json` (gitignored, so it never arrives with a clone) and reuses it afterwards,
at which point a bare `npx rayfin up` is enough. Without it the CLI stops with
`No workspace targeting context`. Add `--dry-run` to validate the configuration and print the
planned operations without making any API calls.

The deploy appends the live hosting URL to `allowedRedirectUris` in `rayfin/rayfin.yml`, so expect
that tracked file to change.

Then set `VITE_RAYFIN_API_URL`, `VITE_RAYFIN_PUBLISHABLE_KEY`, `VITE_FABRIC_WORKSPACE_ID`,
`VITE_FABRIC_ITEM_ID` and `VITE_FABRIC_PORTAL_URL`. Leaving `VITE_RAYFIN_API_URL` unset is what
selects fixture mode. In practice `rayfin env --framework vite` writes all of these into
`.env.local` for you, and `npm run build:fabric` runs it.

### Pointing at the Capacity Metrics app

Real CU numbers come from the Fabric Capacity Metrics app's semantic model, over DAX. Today that
works from `npm run dev` and **not** from the deployed app. Three separate things block the
deployed path, and any one of them is sufficient:

1. Rayfin 1.34.0 ships no semantic-model connector — `discover_packages` returns only the core SDK
   and the docs server.
2. Fabric refuses to deploy `functions`, which is the only server-side seam the app has. That is why
   `services.functions.enabled` is `false`; a deploy with it on fails the whole runtime-settings sync.
3. The Power BI `executeQueries` REST API sends no CORS headers, so a browser cannot call it
   directly whatever token it holds. It needs something server-side to relay the call — and Fabric
   static hosting has nowhere to put one.

The dev server is that relay. It proxies `/powerbi` to `api.powerbi.com` and attaches the token, so
the token stays in Node and never enters the bundle.

```powershell
az login --scope https://analysis.windows.net/powerbi/api/.default
$env:POWERBI_TOKEN = (az account get-access-token `
  --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv)

$env:VITE_FABRIC_SOURCE = "semantic-model"
$env:VITE_FABRIC_METRICS_DATASET_ID = "<semantic model id>"
npm run dev
```

To find the dataset id: open the **Microsoft Fabric Capacity Metrics** app in the Fabric portal, go
to the workspace it installed into, open the semantic model, and take the GUID from the URL
(`/groups/<workspace>/datasets/<dataset>`). It does not live in your app's own workspace, which is
why it cannot be inferred from `rayfin env` output and has to be set explicitly.

The token is short-lived — roughly an hour — and re-exporting it means restarting `npm run dev`,
because the proxy reads it once at startup.

Two things to expect on a first real run. The Capacity Metrics schema has already changed once, so
the source probes it before asking for numbers and reports `Unsupported` rather than crashing if it
has moved again; and the 30-day retention the source declares is an assumption that has not yet been
checked against a live model.

For the **deployed** app, this is what the ingest notebook below is for. It moves the read off the
browser entirely, which is the only thing that clears all three walls at once.

### Getting real numbers into the deployed app

A scheduled Fabric notebook runs the same DAX and writes the rows into the app's own SQL database,
where the deployed app reads them through `client.data`. Nothing new interprets those rows: the
notebook stores them verbatim and the app replays them into the parser it already has.

```powershell
npx rayfin up                 # creates the IngestRun / IngestRow tables
npm run dax:manifest          # only if you changed the DAX
npm run fabric:notebook       # only if you changed the notebook's Python
```

Then, in the Fabric portal:

1. Import `fabric/ingest_capacity_metrics.ipynb` as a notebook.
2. Upload `fabric/dax-queries.generated.json` to that notebook's built-in resources.
3. Fill in the parameters cell: the metrics dataset and workspace ids, and the SQL server and
   database from your app's **SQL Database** child item (Settings → Connection strings).
4. Give the notebook's identity access to the metrics semantic model, and a SQL user on the app's
   database with `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the two ingest tables.
5. Schedule it, then point the app at it:

```
VITE_FABRIC_SOURCE=ingested
VITE_FABRIC_METRICS_DATASET_ID=<same dataset id>
VITE_FABRIC_INGEST_INTERVAL_MINUTES=60      # must match the schedule you set
VITE_FABRIC_INGEST_WINDOW_DAYS=3            # must match INGEST_WINDOW_DAYS
```

The interval is not decoration. The app reports the model's own lag **plus** this interval as its
latency, so a city built from an hourly ingest says it may be an hour old rather than claiming to be
live. Setting it lower than the real schedule makes the app lie about freshness.

> **Everyone signed in to the app can read everything the notebook writes.** The semantic model
> checks each user's own capacity permissions; a table does not. Only ingest capacities all of your
> app's users are entitled to see. The app is granted read only — the notebook writes over direct
> SQL, not the data API, so nothing a user does in the app can forge telemetry.

The notebook is written and unit-tested but **has not been run against a real tenant**. The DAX in
the manifest is generated from the app's own query builder, so the two cannot drift, but neither has
executed against a live Capacity Metrics model yet.

## Where the numbers come from

Topology — capacities, workspaces, items — comes from `api.fabric.microsoft.com/v1`, which is fully
supported and needs no connector.

CU telemetry does not exist on any REST endpoint. It comes from one of three sources behind a single
`CapacitySource` interface:

- **Capacity Metrics semantic model**, over DAX. This is where the real per-item CU breakdown lives.
  Microsoft documents programmatic access to it as unsupported and its schema has already changed
  once, so the implementation probes both generations. Reachable from `npm run dev` only.
- **The same model, ingested** — a scheduled notebook writes its rows into the app's SQL database
  and the app replays them through the identical parser. This is the only path the deployed app has.
- **Eventhouse**, over KQL, reading `Microsoft.Fabric.Capacity.Summary` events on their documented
  30-second cadence. Fully supported, but it carries no per-item breakdown, so the city degrades to
  live infrastructure over static buildings — which the evidence model already knows how to draw.

The semantic-model source and its DAX transport are written; see above for what it takes to reach a
real model. The ingest path is written and unit-tested but unrun against a tenant. The Eventhouse
source is written but has no transport yet.

Refresh is client-side polling: Rayfin has no cron, no timers and no background workers, so there
is no in-app collector and never will be.

## Status

The atlas is on screen and runs on fixtures. The city view is not yet ported — 29 modules sit in
`src/pending-port/` with a README explaining what each one needs. They were kept rather than
deleted because each is a solved *rendering* problem waiting on a Fabric field to read.

Ported and working: capacity atlas, SKU-sized plots, CU-driven massing, throttle and state
rendering, flat-map toggle, kiosk mode, day/night, the sidebar rail and its bottom-sheet form.

## Development

```powershell
npm run dev       # Vite on fixtures
npx tsc -b        # the correct typecheck -- see AGENTS.md on TS6305
npx vitest run    # 610 tests / 31 files
npm run build     # tsc -b + vite build
```

`AGENTS.md` carries the conventions, and they are not decorative — most of them exist because
something passed a green test suite while visibly broken. The short version: **layout changes get
measured in a real browser at both breakpoints**, and a new guard has to be shown failing against
the broken state before it counts.

`tools/measure-browser/` is the workbench for both kinds of measurement — what the city costs the
GPU, and whether the rail beside it can actually be read and clicked.

## Affiliation

Not affiliated with or endorsed by Microsoft. "Microsoft Fabric" and "OneLake" are trademarks of
Microsoft Corporation.

## License

See [LICENSE](LICENSE) and [NOTICE](NOTICE).
