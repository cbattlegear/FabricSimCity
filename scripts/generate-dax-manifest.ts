/*
 * Generate the DAX the ingest notebook runs.
 *
 * The queries are built in TypeScript, from the same column maps the parser reads back, and the
 * notebook only ever looks them up. Porting `buildSemanticModelQueries` to Python would put the
 * Capacity Metrics schema in two languages, and the two would drift the first time the model moved
 * — which it has already done once, and which is the whole reason the generation probe exists.
 *
 * Run `npm run dax:manifest` after touching `semanticModelQueries.ts`. `daxManifest.test.ts`
 * regenerates it in memory and fails if the committed file has fallen behind.
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDaxManifest, DAX_MANIFEST_PATH } from '../src/collect/daxManifest.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, DAX_MANIFEST_PATH)

writeFileSync(target, `${JSON.stringify(buildDaxManifest(), null, 2)}\n`, 'utf8')
process.stdout.write(`wrote ${DAX_MANIFEST_PATH}\n`)
