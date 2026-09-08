import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DAX_MANIFEST_PATH, DAX_MANIFEST_VERSION, buildDaxManifest } from './daxManifest'
import { SEMANTIC_MODEL_SCHEMA_GENERATIONS } from './semanticModelQueries'

const committed = JSON.parse(readFileSync(resolve(process.cwd(), DAX_MANIFEST_PATH), 'utf8')) as ReturnType<
  typeof buildDaxManifest
>

describe('the committed DAX manifest', () => {
  it('matches what the query builder produces today', () => {
    // The notebook reads the committed file, not this function. Without this the two drift the
    // first time anyone edits `semanticModelQueries.ts` and forgets `npm run dax:manifest`, and the
    // symptom is a city built from stale DAX rather than an error.
    expect(committed).toEqual(buildDaxManifest())
  })

  it('covers every schema generation the app can parse', () => {
    expect(committed.generations.map((generation) => generation.name)).toEqual(
      SEMANTIC_MODEL_SCHEMA_GENERATIONS.map((generation) => generation.name),
    )
  })

  it('carries the version the notebook checks', () => {
    expect(committed.version).toBe(DAX_MANIFEST_VERSION)
  })
})

describe('each generation in the manifest', () => {
  for (const generation of buildDaxManifest().generations) {
    describe(generation.name, () => {
      it('publishes the columns the notebook needs to fan out and window rows', () => {
        // Published rather than reimplemented in Python: these are the only two Capacity Metrics
        // column names the notebook touches, and it looks both of them up here.
        expect(generation.capacityIdColumn).toBeTruthy()
        expect(generation.timestampColumn).toBeTruthy()
        expect(generation.requiredColumns.length).toBeGreaterThan(0)
      })

      it('binds every parameter the notebook supplies, and no others', () => {
        const supplied: Record<string, ReadonlySet<string>> = {
          schemaProbe: new Set(),
          capacitySummary: new Set(['Start', 'End']),
          cityItems: new Set(['CapacityId', 'Start', 'End']),
          operationFamilies: new Set(['CapacityId', 'Start', 'End']),
          timepoints: new Set(['CapacityId', 'Start', 'End']),
        }

        for (const [queryName, allowed] of Object.entries(supplied)) {
          const query = generation.queries[queryName as keyof typeof generation.queries]
          const referenced = new Set(
            [...query.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
          )
          for (const name of referenced) {
            // An unbound placeholder makes the notebook raise at run time, in a tenant, hours after
            // anyone could have noticed. It is cheap to catch here instead.
            expect(allowed.has(name), `${queryName} references @${name}`).toBe(true)
          }
        }
      })
    })
  }
})
