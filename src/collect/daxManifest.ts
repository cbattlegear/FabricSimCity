/*
 * The manifest the ingest notebook reads.
 *
 * One entry per Capacity Metrics schema generation, holding the table name, the columns that
 * identify the generation, and the five DAX queries built for it. The notebook probes the model,
 * picks the entry whose table and required columns are present — the same rule
 * `createSemanticModelSource` applies — and runs the queries verbatim.
 */

import {
  SEMANTIC_MODEL_SCHEMA_GENERATIONS,
  buildSemanticModelQueries,
  requiredSchemaTables,
  type SemanticModelQueries,
  type SemanticModelQueryName,
  type SemanticModelSchemaGenerationName,
  // Explicit extension so `scripts/generate-dax-manifest.ts` runs under plain Node type stripping,
  // which does no extensionless resolution. `allowImportingTsExtensions` is on, and Vite resolves
  // it the same either way.
} from './semanticModelQueries.ts'

/** Repo-relative location of the committed manifest. */
export const DAX_MANIFEST_PATH = 'fabric/dax-queries.generated.json'

/**
 * Bumped whenever the manifest's *shape* changes, not its contents.
 *
 * The notebook checks it, so an old notebook against a new manifest says what is wrong instead of
 * reading a field that has moved and silently ingesting nothing.
 */
export const DAX_MANIFEST_VERSION = 2

export interface DaxManifestGeneration {
  name: SemanticModelSchemaGenerationName
  table: string
  /** Column names whose presence selects this generation. */
  requiredColumns: readonly string[]
  /** All physical tables referenced by this generation, retained in replayed schema rows. */
  requiredTables: Readonly<Record<string, readonly string[]>>
  unavailableQueries: readonly SemanticModelQueryName[]
  /**
   * The column holding a row's own timepoint.
   *
   * Published so the notebook can lift it into `IngestRow.rowTimestamp` without knowing anything
   * about the Capacity Metrics schema, which is what lets `readTimepoints` narrow its window in SQL.
   */
  timestampColumn: string
  /** The column holding the capacity id, used to fan the per-capacity queries out. */
  capacityIdColumn: string
  queries: SemanticModelQueries
}

export interface DaxManifest {
  version: number
  generations: readonly DaxManifestGeneration[]
}

export function buildDaxManifest(): DaxManifest {
  return {
    version: DAX_MANIFEST_VERSION,
    generations: SEMANTIC_MODEL_SCHEMA_GENERATIONS.map((generation) => ({
      name: generation.name,
      table: generation.metricsByItemOperationAndDayTable,
      requiredColumns: generation.requiredColumns.map((key) => generation.columns[key]),
      requiredTables: requiredSchemaTables(generation),
      unavailableQueries: generation.unavailableQueries ?? [],
      timestampColumn: generation.outputColumns?.timestamp ?? generation.columns.observedAt,
      capacityIdColumn: generation.outputColumns?.capacityId ?? generation.columns.capacityId,
      // Built against the generation's full column map. `buildSemanticModelQueries` drops optional
      // columns a tenant is missing, but precomputing every subset is combinatorial, so a model
      // missing an optional column fails that query and therefore the run. Multi-table generations
      // explicitly require every column their generated queries reference.
      queries: buildSemanticModelQueries(generation, new Set(Object.values(generation.columns))),
    })),
  }
}
