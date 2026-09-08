import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DAX_MANIFEST_VERSION } from './daxManifest'
import { DEFAULT_INGEST_INTERVAL_MINUTES, DEFAULT_INGEST_WINDOW_DAYS } from './ingestedDax'
import { NOTEBOOK_PATH, buildIngestNotebook } from './ingestNotebook'

const root = process.cwd()
/**
 * Normalizes CRLF so the byte comparison below is about drift rather than about the checkout.
 * `.gitattributes` pins these artifacts to LF, but a clone made before that, or with different
 * `core.autocrlf`, would otherwise fail here for a reason that has nothing to do with the notebook.
 */
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n')

const logicSource = read('fabric/simcity_ingest.py')
const mainSource = read('fabric/ingest_main.py')

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
    const result = spawnSync(executable, ['-c', program], { encoding: 'utf8' })
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

  it('falls back to the bare INFO.COLUMNS names when the aliases are absent', () => {
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

  it('refuses a row too wide for the rowJson column instead of truncating it', () => {
    // A truncated row is unparseable JSON that would surface much later as a corrupt-row error,
    // with nothing pointing back at the ingest that wrote it.
    const result = python(`encode_row({"A": "x" * 4000}, "cityItems", 3)`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('cityItems row 3')
  })
})
