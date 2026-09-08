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
3. Give it read access to the Capacity Metrics semantic model.
4. Fill in the parameters cell below.

Then schedule it at the same interval you set \`VITE_FABRIC_INGEST_INTERVAL_MINUTES\` to.

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
