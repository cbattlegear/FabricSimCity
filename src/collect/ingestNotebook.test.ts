import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DAX_MANIFEST_VERSION, buildDaxManifest } from './daxManifest'
import { DEFAULT_INGEST_INTERVAL_MINUTES, DEFAULT_INGEST_WINDOW_DAYS } from './ingestedDax'
import { NOTEBOOK_PATH, buildIngestNotebook } from './ingestNotebook'
import { exportedMetricsProbe } from './metricsDailySchema.testkit'

const root = process.cwd()
/**
 * Normalizes CRLF so the byte comparison below is about drift rather than about the checkout.
 * `.gitattributes` pins these artifacts to LF, but a clone made before that, or with different
 * `core.autocrlf`, would otherwise fail here for a reason that has nothing to do with the notebook.
 */
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n')

const logicSource = read('fabric/simcity_ingest.py')
const mainSource = read('fabric/ingest_main.py')

// Exercise real pandas when available, and the same datetime-subclass contract on plain-Python CI.
const missingTimestamp = `
try:
    from pandas import NaT
except ModuleNotFoundError as error:
    if error.name != "pandas":
        raise
    class MissingDatetime(_dt.datetime):
        def __ne__(self, other): return True
        def replace(self, **kwargs): return self
        def astimezone(self, tz=None): raise ValueError("NaTType does not support astimezone")
    NaT = MissingDatetime(2000, 1, 1)
`

const sqlCatalog = `
exec(${JSON.stringify(mainSource)})
class Catalog:
    def __init__(self, tables):
        self.tables = tables
        self.results = []
    def execute(self, sql, *args):
        if "INFORMATION_SCHEMA.TABLES" in sql:
            self.results = ([(schema, table) for schema, table in self.tables
                             if table.lower() in {str(arg).lower() for arg in args}] if args else
                            [(schema + "." + table,) for schema, table in self.tables])
        elif "INFORMATION_SCHEMA.COLUMNS" in sql:
            self.results = [(name,) for name in self.tables[tuple(args)]]
        else:
            raise AssertionError(sql)
    def fetchall(self): return self.results
`

interface NotebookCell {
  cell_type: string
  source: string[]
  metadata: { tags?: string[] }
}

const notebook = JSON.parse(read(NOTEBOOK_PATH)) as { cells: NotebookCell[] }
const cellText = (cell: NotebookCell) => cell.source.join('')

describe('the committed notebook', () => {
  it('matches what the generator produces from the Python sources', () => {
    // The `.ipynb` is the artifact uploaded to Fabric, but the `.py` files are what gets edited and
    // reviewed. Without this the two drift, and the drift is invisible: a `.ipynb` diff is JSON
    // string arrays that nobody reads.
    expect(read(NOTEBOOK_PATH)).toBe(buildIngestNotebook())
  })

  it('carries the logic verbatim, so what is tested here is what Fabric runs', () => {
    expect(notebook.cells.some((cell) => cellText(cell) === logicSource.replace(/\n+$/, ''))).toBe(true)
    expect(notebook.cells.some((cell) => cellText(cell) === mainSource.replace(/\n+$/, ''))).toBe(true)
  })

  it('exposes a parameters cell for a schedule to override', () => {
    const tagged = notebook.cells.filter((cell) => cell.metadata.tags?.includes('parameters'))
    expect(tagged).toHaveLength(1)
    expect(cellText(tagged[0])).toContain('METRICS_DATASET_ID')
  })
})

describe('the notebook constants', () => {
  function constant(name: string): number {
    const match = new RegExp(`^${name} = (\\d+)$`, 'm').exec(mainSource)
    if (!match) throw new Error(`${name} is not declared at module scope in ingest_main.py`)
    return Number(match[1])
  }

  it('schedules at the interval the app reports as its added latency', () => {
    // The app tells the UI the city is at most this old. If the notebook runs less often, the UI
    // says fresh and is wrong — a stale city that looks live is worse than one that admits it.
    expect(constant('INGEST_INTERVAL_MINUTES')).toBe(DEFAULT_INGEST_INTERVAL_MINUTES)
  })

  it('ingests the window the app reports as its retention', () => {
    expect(constant('INGEST_WINDOW_DAYS')).toBe(DEFAULT_INGEST_WINDOW_DAYS)
  })

  it('checks the manifest version the generator writes', () => {
    expect(constant('DAX_MANIFEST_VERSION')).toBe(DAX_MANIFEST_VERSION)
  })
})

/**
 * Run a snippet against the notebook's logic module, in a real Python.
 *
 * Reimplementing `dax_literal` and `bind_dax_parameters` in a second language is the risk this
 * whole design was arranged to avoid, and the two places it could not be avoided are exactly the
 * two that fail as *wrong numbers* rather than as an error. Asserting on the Python source text
 * would not catch either, so it is executed.
 */
function python(snippet: string): { ok: boolean; stdout: string; stderr: string } {
  const program = `${logicSource}\n\n${snippet}\n`
  for (const executable of ['python3', 'python']) {
    // The generated manifest plus notebook exceed Windows' command-line length limit.
    const result = spawnSync(executable, ['-'], { input: program, encoding: 'utf8' })
    if (result.error) continue
    // Windows Python emits CRLF; normalizing here keeps the assertions about content rather than
    // about which machine ran them.
    const clean = (text: string) => text.replace(/\r\n/g, '\n').trim()
    return { ok: result.status === 0, stdout: clean(result.stdout), stderr: clean(result.stderr) }
  }
  throw new Error('No Python interpreter was found on PATH.')
}

const hasPython = (() => {
  for (const executable of ['python3', 'python']) {
    if (!spawnSync(executable, ['-c', 'pass'], { encoding: 'utf8' }).error) return true
  }
  return false
})()

// Skipping is only tolerable on a developer machine. On CI a skip would quietly remove the only
// check that the Python half works at all, which is precisely the guard-that-guards-nothing shape.
if (!hasPython && process.env.CI) {
  throw new Error('CI has no Python interpreter, so the notebook logic cannot be verified.')
}

describe.skipIf(!hasPython)('the notebook logic, executed', () => {
  it.each(['IngestRun', 'IngestRow'])('resolves the deployed plural table for %s', (entity) => {
    const result = python(`${sqlCatalog}
print(resolve_table(Catalog({("dbo", "${entity}s"): ["ID", "tenantId"]}), "${entity}", ["id", "tenantId"]))
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(result.stdout).toBe(`[dbo].[${entity}s]`)
  })

  it('retains singular-name support without assuming the dbo schema', () => {
    const result = python(`${sqlCatalog}
print(resolve_table(Catalog({("app", "IngestRun"): ["id"]}), "IngestRun", ["id"]))
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(result.stdout).toBe('[app].[IngestRun]')
  })

  it.each([
    [['dbo', 'IngestRun'], ['dbo', 'IngestRuns']],
    [['dbo', 'IngestRun'], ['archive', 'IngestRun']],
  ])('refuses ambiguous ingest tables rather than writing to the first match: %j', (...tables) => {
    const result = python(`${sqlCatalog}
tables = json.loads(${JSON.stringify(JSON.stringify(tables))})
resolve_table(Catalog({tuple(table): ["id"] for table in tables}), "IngestRun", ["id"])
`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('Multiple tables match entity IngestRun')
  })

  it('still validates required columns on a plural table', () => {
    const result = python(`${sqlCatalog}
resolve_table(Catalog({("dbo", "IngestRows"): ["id"]}), "IngestRow", ["id", "rowJson"])
`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('[dbo].[IngestRows] is missing rowJson')
  })

  it('quotes schema identifiers discovered in the SQL catalog', () => {
    const result = python(`${sqlCatalog}
print(resolve_table(Catalog({("app]data", "IngestRun"): ["id"]}), "IngestRun", ["id"]))
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(result.stdout).toBe('[app]]data].[IngestRun]')
  })

  it('lists the actual catalog when no ingest table exists', () => {
    const result = python(`${sqlCatalog}
resolve_table(Catalog({("dbo", "Users"): ["id"]}), "IngestRun", ["id"])
`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('No table for entity IngestRun')
    expect(result.stderr).toContain('dbo.Users')
  })

  it('substitutes whole parameter names only', () => {
    // The trap: a plain replace of `@Start` also rewrites the front of `@StartOfDay`, and what it
    // leaves behind is still valid DAX. The query runs, and the answer is quietly for the wrong
    // window. Nothing downstream can tell.
    const result = python(
      `print(bind_dax_parameters("FILTER(t, t[a] >= @Start && t[b] < @StartOfDay)", ` +
        `{"Start": 1, "StartOfDay": 2}))`,
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('FILTER(t, t[a] >= 1 && t[b] < 2)')
  })

  it('refuses an unbound placeholder instead of leaving it in the query', () => {
    const result = python(`bind_dax_parameters("t[a] = @Missing", {})`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('@Missing')
  })

  it('doubles quotes so a value cannot break out of its literal', () => {
    const result = python(`print(dax_literal('a" || EVALUATE ROW("x", 1) || "b'))`)
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('"a"" || EVALUATE ROW(""x"", 1) || ""b"')
  })

  it('renders timestamps as DAX date arithmetic in UTC', () => {
    // Quoted text compares as a type error in some models and coerces in others; built with
    // DATE()/TIME() it means the same thing everywhere.
    const result = python(`print(dax_literal("2024-05-01T13:45:30Z"))`)
    expect(result.stdout).toBe('(DATE(2024,5,1) + TIME(13,45,30))')
  })

  it('converts an offset timestamp to UTC rather than binding the local wall clock', () => {
    const result = python(`print(dax_literal("2024-05-01T13:45:30+02:00"))`)
    expect(result.stdout).toBe('(DATE(2024,5,1) + TIME(11,45,30))')
  })

  it('quotes a string that only looks date-ish', () => {
    const result = python(`print(dax_literal("2024-05-01"))`)
    expect(result.stdout).toBe('"2024-05-01"')
  })

  it('renders booleans and blanks as DAX, not as Python', () => {
    const result = python(`print(dax_literal(True), dax_literal(False), dax_literal(None))`)
    expect(result.stdout).toBe('TRUE() FALSE() BLANK()')
  })

  it('picks the generation whose table and required columns are both present', () => {
    const result = python(`
manifest = {"generations": [
    {"name": "old", "table": "Old", "requiredColumns": ["A", "B"]},
    {"name": "new", "table": "New", "requiredColumns": ["A"]},
]}
rows = [
    {"TableName": "Old", "ColumnName": "A"},
    {"TableName": "New", "ColumnName": "A"},
]
print(pick_generation(manifest, rows)["name"])`)
    // "Old" exists but is missing column B, so it must not be chosen. Matching on the table name
    // alone would pick it and then parse every column as blank.
    expect(result.stdout).toBe('new')
  })

  it('falls back to the bare INFO.VIEW.COLUMNS names when the aliases are absent', () => {
    const result = python(`
manifest = {"generations": [{"name": "new", "table": "New", "requiredColumns": ["A"]}]}
print(pick_generation(manifest, [{"Table": "New", "Name": "A"}])["name"])`)
    expect(result.stdout).toBe('new')
  })

  it('fails loudly when no generation matches', () => {
    const result = python(`
manifest = {"generations": [{"name": "new", "table": "New", "requiredColumns": ["A"]}]}
pick_generation(manifest, [{"TableName": "Other", "ColumnName": "A"}])`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('no known schema generation')
  })

  it('distinguishes absent tables from missing columns beyond the table-name preview', () => {
    const result = python(`
manifest = {"generations": [
    {"name": "old", "table": "OldMetrics", "requiredColumns": ["CapacityId"]},
    {"name": "new", "table": "ZMetrics", "requiredColumns": ["CapacityId", "Timepoint", "CuSeconds"]},
]}
rows = [{"TableName": f"Table{i:02}", "ColumnName": "A"} for i in range(12)]
rows.append({"TableName": "ZMetrics", "ColumnName": "CapacityId"})
pick_generation(manifest, rows)`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('OldMetrics: table absent')
    expect(result.stderr).toContain('ZMetrics: missing columns CuSeconds, Timepoint')
    expect(result.stderr).toContain('13 tables (first 10)')
  })

  it('exports the full schema on mismatch without querying telemetry or touching SQL', () => {
    const result = python(`
exec(${JSON.stringify(mainSource)})
import json
import os
import tempfile
from pathlib import Path

METRICS_DATASET_ID = "dataset"
SQL_SERVER = "server"
SQL_DATABASE = "database"
TENANT_ID = "tenant"
manifest = {"version": DAX_MANIFEST_VERSION, "generations": [
    {"name": "known", "table": "KnownMetrics", "requiredColumns": ["CapacityId"],
     "queries": {"schemaProbe": "probe"}}
]}
rows = [{"[TableName]": f"Table{i:02}", "[ColumnName]": "Id", "MetricValue": 123}
        for i in range(12)]
rows.extend([
    {"[TableName]": "ZMetrics", "[ColumnName]": "Workload"},
    {"[TableName]": "ZMetrics", "[ColumnName]": "Cost"},
    {"[TableName]": "ZMetrics", "[ColumnName]": "Cost"},
])
calls = []
def evaluate_dax(query):
    calls.append(query)
    if query != "probe":
        raise AssertionError("Mismatch must not query telemetry")
    return rows
def connect_sql():
    raise AssertionError("Mismatch must not touch SQL")

previous = os.getcwd()
with tempfile.TemporaryDirectory() as directory:
    try:
        os.chdir(directory)
        try:
            run_ingest(manifest)
            raise AssertionError("Mismatch must not complete")
        except IngestError as error:
            message = str(error)
        report = json.loads(Path("builtin/capacity-metrics-schema.json").read_text(encoding="utf-8"))
        print(json.dumps({"report": report, "message": message, "calls": calls}))
    finally:
        os.chdir(previous)
`)
    expect(result.ok, result.stderr).toBe(true)
    const output = JSON.parse(result.stdout.split('\n').at(-1)!)
    expect(output.calls).toEqual(['probe'])
    expect(output.message).toContain('capacity-metrics-schema.json')
    expect(output.message).toContain('Resources > Built-in')
    expect(output.report).toEqual({
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `Table${String(index).padStart(2, '0')}`, ['Id'],
      ])),
      ZMetrics: ['Cost', 'Workload'],
    })
  })

  it('normalizes bracketed keys the same way the TypeScript reader does', () => {
    const result = python(
      `print(normalize_row_key("[CapacityId]"), normalize_row_key("T[C]"), normalize_row_key("a[b]c"))`,
    )
    expect(result.stdout).toBe('CapacityId C a[b]c')
  })

  it('keeps only the probe rows for the chosen table', () => {
    const result = python(`
rows = [{"TableName": "Keep", "ColumnName": "A"}, {"TableName": "Drop", "ColumnName": "B"}]
print(len(probe_rows_for_table(rows, "Keep")))`)
    expect(result.stdout).toBe('1')
  })

  it('selects the exported multi-table schema and retains its dimensions for replay', () => {
    const result = python(`
import json
manifest = json.loads(${JSON.stringify(JSON.stringify(buildDaxManifest()))})
rows = json.loads(${JSON.stringify(JSON.stringify(exportedMetricsProbe))})
generation = pick_generation(manifest, rows)
kept = probe_rows_for_generation(rows + [{"TableName": "Unrelated", "ColumnName": "X"}], generation)
print(json.dumps({"name": generation["name"], "tables": sorted(probe_tables(kept)),
                  "replayed": pick_generation(manifest, kept)["name"]}))
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(JSON.parse(result.stdout)).toEqual({
      name: 'metricsDailyWithDimensions',
      tables: ['Capacities', 'Items', 'Metrics By Item Operation And Day'],
      replayed: 'metricsDailyWithDimensions',
    })
  })

  it('refuses the real fact table without the required item dimension', () => {
    const result = python(`
import json
manifest = json.loads(${JSON.stringify(JSON.stringify(buildDaxManifest()))})
rows = json.loads(${JSON.stringify(JSON.stringify(exportedMetricsProbe.filter((row) => row.TableName !== 'Items')))})
pick_generation(manifest, rows)
`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('Items: table absent')
  })

  it('stages multi-table schema rows, fans out canonical capacity ids and skips unsupported samples', () => {
    const result = python(`${missingTimestamp}
${sqlCatalog}
manifest = json.loads(${JSON.stringify(JSON.stringify(buildDaxManifest()))})
probe = json.loads(${JSON.stringify(JSON.stringify(exportedMetricsProbe))})
generation = pick_generation(manifest, probe)
METRICS_DATASET_ID = "dataset"
SQL_SERVER = "server"
SQL_DATABASE = "database"
TENANT_ID = "tenant"
calls = []
def evaluate_dax(query):
    if query == generation["queries"]["schemaProbe"]:
        calls.append("schemaProbe")
        return probe
    if '"TotalCuSeconds"' in query:
        calls.append("capacitySummary")
        return [{"[CapacityId]": "cap-a", "[ObservedAt]": NaT},
                {"[CapacityId]": "cap-b", "[ObservedAt]": _dt.datetime(2026, 9, 9)}]
    if '"OperationName"' in query:
        calls.append("operationFamilies")
    elif '"ItemKind"' in query:
        calls.append("cityItems")
    else:
        raise AssertionError("Unsupported query must not be executed")
    assert "@" not in query, query
    assert '"cap-a"' in query or '"cap-b"' in query, query
    return [{"[ItemId]": "item", "[CuSeconds]": 5}]

class FakeSql(Catalog):
    def __init__(self):
        super().__init__({
            ("dbo", "IngestRuns"): ["id", "tenantId", "datasetId", "schemaGeneration", "status",
                                   "startedAt", "completedAt", "windowStart", "windowEnd",
                                   "rowCount", "failureMessage"],
            ("dbo", "IngestRows"): ["id", "runId", "tenantId", "queryName", "capacityId",
                                   "rowIndex", "rowTimestamp", "rowJson"],
        })
        self.rows = []
        self.complete = False
        self.closed = False
    def cursor(self): return self
    def execute(self, sql, *args):
        if "INFORMATION_SCHEMA." in sql:
            return super().execute(sql, *args)
        self.results = []
        assert "[dbo].[IngestRuns]" in sql or "[dbo].[IngestRows]" in sql, sql
        if "status = 'Complete'" in sql:
            assert args[1] == len(self.rows)
            self.complete = True
    def executemany(self, sql, rows):
        assert sql.startswith("INSERT INTO [dbo].[IngestRows]"), sql
        self.rows.extend(rows)
    def commit(self): pass
    def close(self): self.closed = True
connection = FakeSql()
def connect_sql(): return connection
run_ingest(manifest)
schema = [json.loads(row[7]) for row in connection.rows if row[3] == "schemaProbe"]
scoped = [row for row in connection.rows if row[3] in ("cityItems", "operationFamilies")]
observations = [json.loads(row[7])["[ObservedAt]"] for row in connection.rows if row[3] == "capacitySummary"]
print(json.dumps({"calls": calls, "complete": connection.complete, "closed": connection.closed,
                  "tables": sorted(probe_tables(schema)), "scopes": sorted({row[4] for row in scoped}),
                  "observations": observations,
                  "replayed": pick_generation(manifest, schema)["name"]}))
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(JSON.parse(result.stdout.split('\n').at(-1)!)).toEqual({
      calls: ['schemaProbe', 'capacitySummary', 'cityItems', 'operationFamilies', 'cityItems', 'operationFamilies'],
      complete: true, closed: true, tables: ['Capacities', 'Items', 'Metrics By Item Operation And Day'],
      scopes: ['cap-a', 'cap-b'], replayed: 'metricsDailyWithDimensions',
      observations: [null, '2026-09-09T00:00:00Z'],
    })
    expect(result.stdout).toContain('timepoints: unavailable')
  })

  it('collects distinct capacity ids in first-seen order', () => {
    const result = python(`
rows = [{"[CapacityId]": "b"}, {"[CapacityId]": "a"}, {"[CapacityId]": "b"}, {"[CapacityId]": None}]
print(",".join(capacity_ids(rows, "CapacityId")))`)
    expect(result.stdout).toBe('b,a')
  })

  it('lifts a row timestamp out for SQL windowing', () => {
    const result = python(`
print(row_timestamp({"[Timepoint]": "2024-05-01T13:45:30Z"}, "Timepoint").isoformat())
print(row_timestamp({"[Timepoint]": "not a date"}, "Timepoint"))`)
    expect(result.stdout.split('\n')).toEqual(['2024-05-01T13:45:30+00:00', 'None'])
  })

  it('emits JSON the TypeScript reader parses back to the same row', () => {
    const result = python(`
import datetime
print(encode_row({"[A]": datetime.datetime(2024, 5, 1, 12, 0, 0), "B": None, "C": 1.5}, "cityItems", 0))`)
    expect(JSON.parse(result.stdout)).toEqual({ '[A]': '2024-05-01T12:00:00Z', B: null, C: 1.5 })
  })

  it('serializes missing datetime cells as null without inventing a timestamp', () => {
    const result = python(`${missingTimestamp}
print(encode_row({
    "[ObservedAt]": NaT, "CuSeconds": 0, "MissingCu": float("nan"), "Label": "NaT",
    "Known": _dt.datetime(2026, 9, 9, 11, 30, tzinfo=_dt.timezone(_dt.timedelta(hours=-5))),
}, "capacitySummary", 1))`)
    expect(result.ok, result.stderr).toBe(true)
    expect(JSON.parse(result.stdout)).toEqual({
      '[ObservedAt]': null, CuSeconds: 0, MissingCu: null, Label: 'NaT', Known: '2026-09-09T16:30:00Z',
    })
  })

  it('keeps missing SQL timepoints null and normalizes known datetime cells to UTC', () => {
    const result = python(`${missingTimestamp}
assert row_timestamp({"[Timepoint]": NaT}, "Timepoint") is None
known = _dt.datetime(2026, 9, 9, 11, 30, tzinfo=_dt.timezone(_dt.timedelta(hours=-5)))
print(row_timestamp({"[Timepoint]": known}, "Timepoint").isoformat())
print(row_timestamp({"[Timepoint]": _dt.datetime(2026, 9, 9, 11, 30)}, "Timepoint").isoformat())
`)
    expect(result.ok, result.stderr).toBe(true)
    expect(result.stdout.split('\n')).toEqual(['2026-09-09T16:30:00+00:00', '2026-09-09T11:30:00+00:00'])
  })

  it('refuses a row too wide for the rowJson column instead of truncating it', () => {
    // A truncated row is unparseable JSON that would surface much later as a corrupt-row error,
    // with nothing pointing back at the ingest that wrote it.
    const result = python(`encode_row({"A": "x" * 4000}, "cityItems", 3)`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('cityItems row 3')
  })
})
