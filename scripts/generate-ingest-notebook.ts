/*
 * Generate `fabric/ingest_capacity_metrics.ipynb` from the Python sources beside it.
 *
 * The notebook has to be a single self-contained artifact to upload to Fabric, but a `.ipynb` is a
 * terrible thing to edit or review: its code is JSON string arrays, so a diff is unreadable and the
 * Python inside it is invisible to every linter and to the tests. So the Python lives in real `.py`
 * files, this stitches them together, and `ingestNotebook.test.ts` fails if the committed notebook
 * has fallen behind them.
 *
 * Run `npm run fabric:notebook` after touching either file.
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildIngestNotebook, NOTEBOOK_PATH } from '../src/collect/ingestNotebook.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

writeFileSync(resolve(root, NOTEBOOK_PATH), buildIngestNotebook(), 'utf8')
process.stdout.write(`wrote ${NOTEBOOK_PATH}\n`)
