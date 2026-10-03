import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { createCollection, type Collection } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiDataImport, prepareAnkiImport } from './anki-import'
import { nativeAnkiProjectionData } from './native-anki-projection'

let SQL: SqlJsStatic
const databases: Collection[] = []
function database() { const db = createCollection(crypto.randomUUID()); databases.push(db); return db }
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.delete())) })

const exchange = { scheduling: true, history: true, media: true }

/**
 * A native collection whose decks are exactly the Deck Paths given, by id. Naming
 * `JLPT::N5` without naming `JLPT` is the case this file is about: the package
 * refers to a deck it never defines.
 */
async function packageNaming(deckNames: readonly string[]) {
  const db = new SQL.Database()
  db.run(`CREATE TABLE col(id INTEGER,crt INTEGER,mod INTEGER,scm INTEGER,ver INTEGER,dty INTEGER,usn INTEGER,ls INTEGER,conf TEXT,models TEXT,decks TEXT,dconf TEXT,tags TEXT);
    CREATE TABLE notes(id INTEGER,guid TEXT,mid INTEGER,mod INTEGER,usn INTEGER,tags TEXT,flds TEXT,sfld TEXT,csum INTEGER,flags INTEGER,data TEXT);
    CREATE TABLE cards(id INTEGER,nid INTEGER,did INTEGER,ord INTEGER,mod INTEGER,usn INTEGER,type INTEGER,queue INTEGER,due INTEGER,ivl INTEGER,factor INTEGER,reps INTEGER,lapses INTEGER,left INTEGER,odue INTEGER,odid INTEGER,flags INTEGER,data TEXT);
    CREATE TABLE revlog(id INTEGER,cid INTEGER,usn INTEGER,ease INTEGER,ivl INTEGER,lastIvl INTEGER,factor INTEGER,time INTEGER,type INTEGER);`)
  const model = { id: 100, name: 'Basic', type: 0, mod: 1_700_000_000, css: '.card { color: green; }', flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }] }
  const decks = Object.fromEntries(deckNames.map((name, index) => [String(index + 1), { id: index + 1, name: name.replaceAll('::', '\u001f'), mod: 1_700_000_000, dyn: 0 }]))
  const now = Math.floor(Date.parse('2026-10-02T12:00:00Z') / 1000)
  db.run('INSERT INTO col VALUES(1,?,?,?,?,0,0,0,?,?,?,?,?)', [now, now, now, 11, '{}', JSON.stringify({ 100: model }), JSON.stringify(decks), '{}', '{}'])
  db.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)', [1_700_000_000_100, 'native-guid', 100, 1_700_000_000, 0, ' ', '猫\u001fcat', '猫', 1, 0, '{}'])
  deckNames.forEach((_, index) => db.run('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [1_700_000_000_200 + index, 1_700_000_000_100, index + 1, 0, now, 0, 0, 0, index + 1, 0, 0, 0, 0, 0, 0, 0, 0, '{}']))
  const snapshot = db.export()
  db.close()
  return nativeAnkiProjectionData(SQL, snapshot)
}

/** Every Deck Path present in the collection, with the identity holding it. */
async function deckPaths(db: Collection) {
  const decks = await db.decks.toArray()
  const byId = new Map(decks.map((deck) => [deck.id, deck]))
  const pathOf = (deck: { name: string; parentId: string | null }, seen = new Set<string>()): string => {
    if (seen.has(deck.name)) return deck.name
    const parent = deck.parentId ? byId.get(deck.parentId) : undefined
    return parent ? `${pathOf(parent, seen)}::${deck.name}` : deck.name
  }
  return decks.map((deck) => [pathOf(deck), deck.id] as const).sort(([left], [right]) => left.localeCompare(right))
}

async function exportFile(db: Collection) {
  const output = await exportAnkiPackage(db, { ...exchange, SQL })
  return new File([output.bytes.slice().buffer], 'backup.apkg')
}

test('a deck a package names only inside a Deck Path keeps its identity across an export and a re-import', async () => {
  const data = await packageNaming(['JLPT::N5'])
  const source = database()
  const first = await prepareAnkiDataImport(data, source, { SQL })
  expect(first.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await first.commit()
  const before = await deckPaths(source)
  expect(before.map(([path]) => path)).toEqual(['JLPT', 'JLPT::N5'])

  const restored = database()
  const second = await prepareAnkiImport(await exportFile(source), restored, { SQL })
  expect(second.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await second.commit()
  expect(await deckPaths(restored)).toEqual(before)
})

test('a deck a package names at every level keeps the Native Identity it arrived with', async () => {
  const data = await packageNaming(['JLPT', 'JLPT::N5', 'JLPT::N5::Verbs'])
  const db = database()
  const prepared = await prepareAnkiDataImport(data, db, { SQL })
  await prepared.commit()
  expect(await deckPaths(db)).toEqual([['JLPT', 'anki-deck:1'], ['JLPT::N5', 'anki-deck:2'], ['JLPT::N5::Verbs', 'anki-deck:3']])
})

test('re-importing the same package leaves one deck per Deck Path', async () => {
  const data = await packageNaming(['JLPT::N5', 'JLPT::N5::Verbs'])
  const db = database()
  await (await prepareAnkiDataImport(data, db, { SQL })).commit()
  const first = await deckPaths(db)
  await (await prepareAnkiImport(await exportFile(db), db, { SQL })).commit()
  expect(await deckPaths(db)).toEqual(first)
})

test('a Deck Path with non-ASCII names survives an export and a re-import', async () => {
  const data = await packageNaming(['日本語::語彙'])
  const source = database()
  await (await prepareAnkiDataImport(data, source, { SQL })).commit()
  const before = await deckPaths(source)
  const restored = database()
  await (await prepareAnkiImport(await exportFile(source), restored, { SQL })).commit()
  expect(before.map(([path]) => path)).toEqual(['日本語', '日本語::語彙'])
  expect(await deckPaths(restored)).toEqual(before)
})