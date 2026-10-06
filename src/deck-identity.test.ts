import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { createCollection, DEFAULT_DECK_OPTION_GROUP_ID, type Collection } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiDataImport, prepareAnkiImport } from './anki-import'
import { nativeAnkiProjectionData } from './native-anki-projection'
import { readAnkiExportSnapshot, readCard, readCollectionSetting, readDeck, readNote } from './collection-queries'
import { seedLegacyDeckCollision } from '../tests/helpers/damage-indexeddb-media'

let SQL: SqlJsStatic
const databases: Collection[] = []
function database() { const db = createCollection(crypto.randomUUID()); databases.push(db); return db }
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.removeLocalCollection())) })

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
  const decks = (await readAnkiExportSnapshot(db)).decks
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

test('a collection holding a legacy path identity ends the import with one deck, rekeyed and told', async () => {
  const data = await packageNaming(['JLPT::N5'])
  const db = database()
  // The state a collection is left in by an import made before the identity was
  // derived: the Synthesised Deck under the legacy form, with its child on it.
  const legacy = 'anki-deck-path:JLPT'
  const now = new Date('2026-10-02T12:00:00Z').toISOString()
  await seedLegacyDeckCollision(db.databaseName, { decks: [
    { id: legacy, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
    { id: 'anki-deck:1', name: 'N5', parentId: legacy, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
  ] })

  const prepared = await prepareAnkiDataImport(data, db, { SQL })
  // What the learner is shown before committing is what gets written.
  const previewed = new Map(prepared.projectedEntities().decks.map(({ id, name, parentId }) => [name, { id, parentId }]))
  const shown = previewed.get('JLPT')!
  expect(shown.id).toMatch(/^anki-deck:\d+$/)
  expect(previewed.get('N5')!.parentId).toBe(shown.id)
  expect(prepared.issues.filter((issue) => issue.code === 'deck-identity-normalised'))
    .toEqual([expect.objectContaining({ severity: 'info', subject: 'JLPT', detail: expect.stringContaining(legacy) })])
  expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])

  await prepared.commit()
  expect((await readDeck(db, shown.id))?.parentId).toBeNull()
  expect((await readDeck(db, 'anki-deck:1'))?.parentId).toBe(shown.id)
  expect(await readDeck(db, legacy)).toBeUndefined()
  expect((await readAnkiExportSnapshot(db)).cards.map(({ deckId }) => deckId)).toEqual(['anki-deck:1'])
})

test('a legacy deck is reconciled even when the package defines that Deck Path itself', async () => {
  // The package names JLPT as well as JLPT::N5, so the path resolves from the
  // package rather than from derivation. The legacy deck is still a second deck
  // answering to JLPT, and must not survive the import.
  const db = database()
  const now = new Date('2026-10-02T12:00:00Z').toISOString()
  const legacy = 'anki-deck-path:JLPT'
  await seedLegacyDeckCollision(db.databaseName, { decks: [
    { id: legacy, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
    { id: 'anki-deck:2', name: 'N5', parentId: legacy, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
  ] })

  const prepared = await prepareAnkiDataImport(await packageNaming(['JLPT', 'JLPT::N5']), db, { SQL })
  expect(prepared.issues.filter((issue) => issue.code === 'deck-identity-normalised'))
    .toEqual([expect.objectContaining({ severity: 'info', subject: 'JLPT', detail: `Deck identity ${legacy} was brought into the package scheme as anki-deck:1.` })])
  await prepared.commit()
  expect(await deckPaths(db)).toEqual([['JLPT', 'anki-deck:1'], ['JLPT::N5', 'anki-deck:2']])
  expect(await readDeck(db, legacy)).toBeUndefined()
})

test('a deck the learner made is left alone when the package names the same Deck Path', async () => {
  // Story 19: importing must not disturb a deck the app created for itself, and
  // in particular must not reset the deck options the learner chose for it.
  const db = database()
  const group = await db.createDeckOptionGroup('Deck options the learner chose')
  const mine = await db.createDeck('JLPT', { optionGroupId: group.id })
  await db.createBasicNote(mine.id, { front: '猫', back: 'cat' })

  await (await prepareAnkiDataImport(await packageNaming(['JLPT', 'JLPT::N5']), db, { SQL })).commit()
  const after = await readDeck(db, mine.id)
  expect(after?.optionGroupId).toBe(group.id)
  expect(after?.parentId).toBeNull()
  expect((await readAnkiExportSnapshot(db)).notes[0].deckId).toBe(mine.id)
})

test('a deck holding a duplicate of the same Deck Path is reconciled, not left alongside it', async () => {
  const data = await packageNaming(['JLPT::N5'])
  const db = database()
  const now = new Date('2026-10-02T12:00:00Z').toISOString()
  // The symptom of an import made before the identity was derived: two decks
  // answering to one Deck Path, one of them holding the learner's cards. Import
  // once so the standing identity comes from the real derivation rather than
  // from a literal restating it.
  await (await prepareAnkiDataImport(data, db, { SQL })).commit()
  const standing = (await deckPaths(db)).find(([path]) => path === 'JLPT')![1]
  const older = 'anki-deck-path:JLPT'
  await seedLegacyDeckCollision(db.databaseName, { decks: [{ id: older, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now }] })

  const prepared = await prepareAnkiDataImport(data, db, { SQL })
  expect(prepared.issues.filter((issue) => issue.code === 'deck-identity-normalised'))
    .toEqual([expect.objectContaining({ severity: 'info', subject: 'JLPT', detail: expect.stringContaining(older) })])
  await prepared.commit()
  expect(await deckPaths(db)).toEqual([['JLPT', standing], ['JLPT::N5', 'anki-deck:1']])
  expect(await readDeck(db, older)).toBeUndefined()
})

test('a Deck Path with an empty name segment is still refused', async () => {
  const db = database()
  const prepared = await prepareAnkiDataImport(await packageNaming(['JLPT::N5']), db, { SQL })
  expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])

  const malformed = database()
  const data = await packageNaming(['JLPT::N5'])
  data.decks[0].name = ['JLPT', '', 'N5'].join('\u001f')
  const refused = await prepareAnkiDataImport(data, malformed, { SQL })
  expect(refused.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'deck-hierarchy-malformed', subject: 'JLPT::::N5' }))
  await expect(refused.commit()).rejects.toThrow('Resolve package errors before importing')
  expect((await readAnkiExportSnapshot(malformed)).decks).toHaveLength(0)
})

test('an undo record survives a deck being superseded beneath it', async () => {
  // An undo holds a copy of the note it deleted, and restoring it insists that
  // deck still exists. Pointing at a superseded identity breaks it for good.
  const db = database()
  const now = new Date('2026-10-02T12:00:00Z').toISOString()
  const duplicate = 'anki-deck-path:JLPT'
  const standing = 'anki-deck:1110936686436'
  await (await prepareAnkiDataImport(await packageNaming(['JLPT::N5']), db, { SQL })).commit()
  const note = (await readAnkiExportSnapshot(db)).notes[0]
  await seedLegacyDeckCollision(db.databaseName, { decks: [
    { id: duplicate, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
    { id: standing, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
  ], noteDeletionUndo: { syncEpoch: 0, operationId: 'op-1', occurredAt: now, note: { ...note, deckId: duplicate }, noteType: (await readAnkiExportSnapshot(db)).types.find((type) => type.id === note.typeId)!, cards: [], reviews: [], media: [] } })

  await (await prepareAnkiDataImport(await packageNaming(['JLPT::N5']), db, { SQL })).commit()
  const undo = (await readCollectionSetting(db, 'noteDeletionUndo'))?.value as { note: { deckId: string } }
  expect(undo.note.deckId).toBe(standing)
  expect(await readDeck(db, undo.note.deckId)).toBeDefined()
})

test('a superseded deck hands its notes, cards and reviews to the one that survives', async () => {
  const data = await packageNaming(['JLPT::N5'])
  const db = database()
  const now = new Date('2026-10-02T12:00:00Z').toISOString()
  // A deck reconciled away for duplicating another Deck Path may not be an empty
  // container, so what pointed at it has to follow rather than be orphaned.
  const duplicate = 'anki-deck-path:JLPT'
  const standing = 'anki-deck:1110936686436'
  await (await prepareAnkiDataImport(data, db, { SQL })).commit()
  const initial = await readAnkiExportSnapshot(db)
  const note = initial.notes[0]
  const card = initial.cards[0]
  await seedLegacyDeckCollision(db.databaseName, { decks: [
    { id: duplicate, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
    { id: standing, name: 'JLPT', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
    { id: 'anki-deck:1', name: 'N5', parentId: standing, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: now, updatedAt: now },
  ],
    note: { ...note, deckId: duplicate },
    card: { ...card, deckId: duplicate },
    review: { id: 'anki-review:1700000000900', cardId: card.id, deckId: duplicate, rating: 3, reviewedAt: now, scheduling: { options: 'default', elapsedDays: 0, scheduledDays: 1, stability: 1, difficulty: 5, state: 1 } },
  })

  await (await prepareAnkiDataImport(data, db, { SQL })).commit()
  expect(await readDeck(db, duplicate)).toBeUndefined()
  expect((await readNote(db, note.id))?.deckId).toBe(standing)
  expect((await readCard(db, card.id))?.deckId).toBe(standing)
  expect((await readAnkiExportSnapshot(db)).reviews.find((review) => review.id === 'anki-review:1700000000900')?.deckId).toBe(standing)
})
