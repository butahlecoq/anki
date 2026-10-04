import 'fake-indexeddb/auto'
import initSqlJs from 'sql.js'
import { afterAll, beforeAll, test } from 'vitest'
import { createCollection } from './collection'
import { exportAnkiPackage } from './anki-export'

const count = Number(process.env.EXPORT_PROFILE_NOTES ?? 2000)
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
let sql: Awaited<ReturnType<typeof initSqlJs>>
const db = createCollection(crypto.randomUUID())
beforeAll(async () => { sql = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterAll(async () => { await db.delete() })

test.skipIf(!process.env.EXPORT_PROFILE_NOTES)('profile synthetic package export', async () => {
  const deck = await db.createDeck('Profile')
  for (let i = 0; i < count; i++) {
    const note = await db.createBasicNote(deck.id, { front: `front-${i} <img src="{{Media}}">`, back: `back-${i}` }, new Date(1_700_000_000_000 + i))
    await db.attachMedia(note.id, { file: new File([png], `image-${i}.png`, { type: 'image/png' }), side: 'front' }, new Date(1_700_000_000_000 + i))
  }
  const options = { scheduling: true, history: true, media: true, SQL: sql }
  await exportAnkiPackage(db, options) // warm module, WASM and browser storage paths
  const samples: number[] = []
  let result: Awaited<ReturnType<typeof exportAnkiPackage>>
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    result = await exportAnkiPackage(db, options)
    samples.push(performance.now() - start)
  }
  const medianMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  console.log(JSON.stringify({ count, medianMs: +medianMs.toFixed(1), samplesMs: samples.map((sample) => +sample.toFixed(1)), bytes: result!.bytes.length, notes: result!.notes, cards: result!.cards, media: result!.media, reviews: result!.reviews }))
}, 120_000)
