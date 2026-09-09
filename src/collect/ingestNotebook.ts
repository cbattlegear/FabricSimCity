import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOTEBOOK_PATH = 'fabric/ingest_capacity_metrics.ipynb'

const FABRIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fabric')

interface NotebookCell {
  cell_type: 'code' | 'markdown'
  metadata: Record<string, unknown>
  source: string[]
  outputs?: unknown[]
  execution_count?: null
}

function lines(text: string): string[] {
  // Jupyter stores source as an array of lines that each keep their trailing newline, and the last
  // line does not. Round-tripping any other way produces a diff on every regeneration.
  //
  // CRLF is normalized first because a `\r` inside a cell's source survives as a `\r` *escape*
  // inside a JSON string, which git's autocrlf cannot see and therefore cannot normalize. Without
  // this, a notebook generated on Windows and one generated on Linux differ byte-for-byte and the
  // drift guard fails on CI only.
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return trimmed.split('\n').map((line, index, all) => (index === all.length - 1 ? line : `${line}\n`))
}

function markdown(text: string): NotebookCell {
  return { cell_type: 'markdown', metadata: {}, source: lines(text) }
}

function code(text: string, metadata: Record<string, unknown> = {}): NotebookCell {
  return { cell_type: 'code', metadata, execution_count: null, outputs: [], source: lines(text) }
}

function readFabricFile(name: string): string {
  return readFileSync(join(FABRIC_DIR, name), 'utf8')
}

const INTRO = `# FabricSimCity — capacity metrics ingest

Copies the Capacity Metrics semantic model into the FabricSimCity app's SQL database on a schedule,
because a Fabric App has no timers of its own and the semantic model can only be read with the
signed-in user's own permissions.

**Before the first run**

1. Deploy the app with \`npx rayfin up\` so the \`IngestRun\` and \`IngestRow\` tables exist.
2. Give this notebook's identity access to the app's SQL database, as a user with
   \`INSERT\`, \`UPDATE\`, \`DELETE\` and \`SELECT\` on those two tables.
3. Give it Read and Build access to the Capacity Metrics semantic model, plus permission to
   discover model metadata for the schema probe. Report viewing alone is insufficient.
4. Fill in the parameters cell below.

Then schedule it at the same interval you set \`VITE_FABRIC_INGEST_INTERVAL_MINUTES\` to.
Scheduled runs use the identity of the user who created or last updated the schedule.

**Updating an existing notebook:** this notebook requires manifest version **2**. Update both
the notebook and its Built-in \`dax-queries.generated.json\`, preserving your parameter values,
then restart the session and run all cells. The SQL entity schema has not changed. Confirm the
schedule targets this updated notebook. The matching TypeScript reader is included in this
revision: rebuild/redeploy the app with \`VITE_FABRIC_SOURCE=ingested\` and the matching tenant
and dataset ids. It reads through Rayfin's built-in GraphQL adapter and adopts the Fabric portal
session automatically, without a separate login flow.

**Daily metrics with dimensions:** \`metricsDailyWithDimensions\` reads the daily fact plus
\`Items\` and \`Capacities\`. It supplies CU, durations, operation counts and measured throttling,
not 30-second utilization or per-item OneLake storage. Those unavailable measurements remain
unknown. Autoscale-specific facts are not combined. The first partial day is excluded; freshness
uses the latest daily bucket, not the time this notebook ran.

**If ADOMD reports no permission to call Discover:** check the executing identity's access to
the model in \`METRICS_WORKSPACE_ID\`, not the notebook or app workspace. After running the
parameters cell, try \`evaluate_dax('EVALUATE ROW("AccessCheck", 1)')\` separately from the
ingest. If it also fails, check Read/Build permissions and XMLA access. If it succeeds but the
schema probe fails, ordinary querying works but metadata discovery does not.
[Microsoft documents model-admin permissions for INFO metadata queries](https://learn.microsoft.com/dax/info-functions-dax).
Use an authorized model administrator for that operation; do not grant tenant-wide admin or
change SQL permissions to work around it.

**If no known schema generation matches:** the error distinguishes an absent table from missing
required columns. The notebook saves the complete table/column map to
\`builtin/capacity-metrics-schema.json\`; download it from Resources > Built-in to diagnose the
adapter mismatch. It contains names only, not metric values or credentials. Ingest stops before
any SQL write. Do not rename model tables or skip validation to force a match.

**Everyone signed in to the app can read everything this writes.** The semantic model checks each
user's own capacity permissions; a table does not. Ingest only capacities your app's users are
all entitled to see.`

const LOGIC_HEADING = `## Pure logic

Generated from \`fabric/simcity_ingest.py\`. Edit that file, not this cell, and run
\`npm run fabric:notebook\` — \`ingestNotebook.test.ts\` fails if they disagree.`

const MANIFEST_HEADING = `## The DAX

Generated from the app's own query builder into \`fabric/dax-queries.generated.json\`, so the
notebook and the app can never ask the model different questions. Upload that file to this
notebook's built-in resources, or paste its contents into the cell below.`

const MANIFEST_CELL = `import json
from pathlib import Path

# Fabric mounts a notebook's uploaded resources here.
MANIFEST_PATH = "/lakehouse/default/Files/dax-queries.generated.json"
_local = Path("./builtin/dax-queries.generated.json")

if _local.exists():
    MANIFEST = json.loads(_local.read_text(encoding="utf-8"))
elif Path(MANIFEST_PATH).exists():
    MANIFEST = json.loads(Path(MANIFEST_PATH).read_text(encoding="utf-8"))
else:
    raise IngestError(
        "Upload fabric/dax-queries.generated.json to this notebook's built-in resources, "
        f"or place it at {MANIFEST_PATH}."
    )

print(f"Manifest version {MANIFEST['version']} with "
      f"{len(MANIFEST['generations'])} schema generation(s).")`

const RUN_HEADING = `## Run`

export function buildIngestNotebook(): string {
  const notebook = {
    cells: [
      markdown(INTRO),
      markdown(LOGIC_HEADING),
      code(readFabricFile('simcity_ingest.py')),
      markdown(MANIFEST_HEADING),
      code(MANIFEST_CELL),
      code(readFabricFile('ingest_main.py'), { tags: ['parameters'] }),
      markdown(RUN_HEADING),
      code('run_ingest(MANIFEST)'),
    ],
    metadata: {
      kernelspec: { display_name: 'Synapse PySpark', language: 'Python', name: 'synapse_pyspark' },
      language_info: { name: 'python' },
      microsoft: { language: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }

  return `${JSON.stringify(notebook, null, 2)}\n`
}
