import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import initSqlJs from 'sql.js'
import { Collection } from './collection'
import { prepareAnkiDataImport } from './anki-import'
import { nativeAnkiProjectionData, nativeAnkiProjectionEntityMap, nativeAnkiProjectionManifest } from './native-anki-projection'

const noteId = 1_700_000_000_100
const firstCardId = 1_700_000_000_101
const secondCardId = 1_700_000_000_102
const reviewId = 1_700_000_000_201
const originalNote = { id: noteId, guid: 'native-日本語-guid', mid: 100, mod: 1_700_000_000, usn: 0, tags: ' jlpt::n5 ', flds: '猫\u001fcat', sfld: '猫', csum: 1, flags: 0, data: '{"unknown":"preserve in source"}' }

async function nativeFixture(schema = 11) {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`CREATE TABLE col(id INTEGER,crt INTEGER,mod INTEGER,scm INTEGER,ver INTEGER,dty INTEGER,usn INTEGER,ls INTEGER,conf TEXT,models TEXT,decks TEXT,dconf TEXT,tags TEXT);
    CREATE TABLE notes(id INTEGER,guid TEXT,mid INTEGER,mod INTEGER,usn INTEGER,tags TEXT,flds TEXT,sfld TEXT,csum INTEGER,flags INTEGER,data TEXT);
    CREATE TABLE cards(id INTEGER,nid INTEGER,did INTEGER,ord INTEGER,mod INTEGER,usn INTEGER,type INTEGER,queue INTEGER,due INTEGER,ivl INTEGER,factor INTEGER,reps INTEGER,lapses INTEGER,left INTEGER,odue INTEGER,odid INTEGER,flags INTEGER,data TEXT);
    CREATE TABLE revlog(id INTEGER,cid INTEGER,usn INTEGER,ease INTEGER,ivl INTEGER,lastIvl INTEGER,factor INTEGER,time INTEGER,type INTEGER);`)
  const model = {
    id: 100, name: 'Japanese two-sided', type: 0, mod: 1_700_000_000, css: '.card { color: green; }',
    flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
    tmpls: [
      { name: 'Reading', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' },
      { name: 'Listening', ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr>{{Front}}' },
    ],
  }
  const decks = {
    '1': { id: 1, name: 'Default', mod: 1_700_000_000, dyn: 0 },
    '10': { id: 10, name: '日本語::語彙::読解', mod: 1_700_000_000, dyn: 0 },
    '11': { id: 11, name: '日本語::語彙::聴解', mod: 1_700_000_000, dyn: 0 },
  }
  const now = Math.floor(Date.parse('2026-10-02T12:00:00Z') / 1000)
  const colCreated = now - 10 * 86_400
  db.run('INSERT INTO col VALUES(1,?,?,?,?,0,0,0,?,?,?,?,?)', [colCreated, now, now, schema, '{}', JSON.stringify({ 100: model }), JSON.stringify(decks), '{}', '{}'])
  db.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)', [originalNote.id, originalNote.guid, originalNote.mid, originalNote.mod, originalNote.usn, originalNote.tags, originalNote.flds, originalNote.sfld, originalNote.csum, originalNote.flags, originalNote.data])
  db.run('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [firstCardId, noteId, 10, 0, now, 0, 2, 2, 15, 5, 2500, 3, 0, 0, 0, 0, 1, '{}'])
  db.run('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [secondCardId, noteId, 11, 1, now, 0, 0, 0, 1, 0, 2500, 0, 0, 0, 0, 0, 0, '{}'])
  db.run('INSERT INTO revlog VALUES(?,?,?,?,?,?,?,?,?)', [reviewId, firstCardId, 0, 4, 5, 0, 2500, 1_000, 1])
  const snapshot = db.export()
  db.close()
  return { SQL, snapshot }
}

let collection: Collection | undefined
afterEach(async () => {
  if (collection) await collection.delete()
  collection = undefined
})

it('projects schema-11 note, card, deck, and review identities without rewriting native rows', async () => {
  const { SQL, snapshot } = await nativeFixture()
  const before = Array.from(snapshot)
  const mediaBytes = new Uint8Array([0, 1, 2, 255])
  const data = nativeAnkiProjectionData(SQL, snapshot, [{ name: '猫.png', data: mediaBytes }])
  expect(data.notes[0]).toMatchObject({ id: noteId, guid: originalNote.guid, flds: originalNote.flds, data: originalNote.data })
  expect(data.cards.map((card) => [card.id, card.did, card.ord])).toEqual([[firstCardId, 10, 0], [secondCardId, 11, 1]])
  expect(data.revlog[0].id).toBe(reviewId)
  expect(data.media[0].data).toBe(mediaBytes)
  expect(Array.from(mediaBytes)).toEqual([0, 1, 2, 255])
  expect(Array.from(snapshot)).toEqual(before)

  collection = new Collection(`native-projection-${crypto.randomUUID()}`)
  const prepared = await prepareAnkiDataImport(data, collection, { SQL, now: new Date('2026-10-02T12:00:00Z') })
  expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  expect(prepared.summary).toMatchObject({ decks: 4, noteTypes: 1, notes: 1, cards: 2, reviews: 1 })
  const projected = prepared.projectedEntities()
  expect(projected.notes[0]).toMatchObject({ id: `anki-note:${originalNote.guid}`, ankiId: noteId, fields: { 'anki-field:100:0': '猫', 'anki-field:100:1': 'cat' } })
  projected.notes[0].fields['anki-field:100:0'] = 'mutated copy'
  expect(prepared.projectedEntities().notes[0].fields['anki-field:100:0']).toBe('猫')
  await prepared.commit()

  const note = await collection.notes.get(`anki-note:${originalNote.guid}`)
  const cards = await collection.cards.where('noteId').equals(`anki-note:${originalNote.guid}`).sortBy('ankiId')
  const review = await collection.reviewEntries.get(`anki-review:${reviewId}`)
  expect(note).toMatchObject({ ankiId: noteId, tags: ['jlpt::n5'], fields: { 'anki-field:100:0': '猫', 'anki-field:100:1': 'cat' } })
  expect(cards).toHaveLength(2)
  expect(cards.map((card) => card.ankiId)).toEqual([firstCardId, secondCardId])
  expect(cards.map((card) => card.deckId)).not.toEqual([note?.deckId, note?.deckId])
  expect(review).toMatchObject({ id: `anki-review:${reviewId}`, cardId: cards[0].id, rating: 4 })

  const manifest = await nativeAnkiProjectionManifest(SQL, snapshot)
  const entities = {
    notes: await collection.notes.toArray(),
    cards: await collection.cards.toArray(),
    reviews: await collection.reviewEntries.toArray(),
    decks: await collection.decks.toArray(),
    notetypes: await collection.noteTypes.toArray(),
  }
  const entityMap = nativeAnkiProjectionEntityMap(manifest, entities)
  expect(entityMap.notes.get(noteId)).toBe(`anki-note:${originalNote.guid}`)
  expect(entityMap.cards.get(firstCardId)).toBe(cards[0].id)
  expect(entityMap.cards.get(secondCardId)).toBe(cards[1].id)
  expect(entityMap.reviews.get(reviewId)).toBe(`anki-review:${reviewId}`)
  expect(entityMap.decks.get(10)).toBe('anki-deck:10')
  expect(entityMap.fields.get('100:0')?.id).toBe('anki-field:100:0')
  expect(entityMap.templates.get('100:1')?.id).toBe('anki-template:100:1')
  expect(entityMap.unmapped.notes).toEqual([])
  expect(entityMap.unmapped.decks).toEqual([1])
  expect(() => nativeAnkiProjectionEntityMap(manifest, {
    ...entities,
    cards: [...entities.cards, { ...cards[0], id: 'duplicate-native-card' }],
  })).toThrow('identity map')
})

it('builds a snapshot-bound base map with native identities and both deck bindings', async () => {
  const { SQL, snapshot } = await nativeFixture()
  const manifest = await nativeAnkiProjectionManifest(SQL, snapshot)
  expect(manifest).toMatchObject({ version: 1, collectionId: 1, schema: 11 })
  expect(manifest.snapshotHash).toMatch(/^[a-f0-9]{64}$/)
  expect(manifest.notes).toEqual([{ id: noteId, guid: originalNote.guid, notetypeId: 100 }])
  expect(manifest.cards).toEqual([
    { id: firstCardId, noteId, ordinal: 0, deckId: 10, originalDeckId: 0 },
    { id: secondCardId, noteId, ordinal: 1, deckId: 11, originalDeckId: 0 },
  ])
  expect(manifest.reviews).toEqual([{ id: reviewId, cardId: firstCardId }])
  expect(manifest.decks.map(({ id }) => id)).toEqual([1, 10, 11])
  expect(manifest.notetypes).toEqual([{ id: 100, fieldOrdinals: [0, 1], templateOrdinals: [0, 1] }])
})

it('rejects ambiguous native card identities before they can be used for writeback', async () => {
  const { SQL, snapshot } = await nativeFixture()
  const db = new SQL.Database(snapshot)
  db.run('UPDATE cards SET ord = 0 WHERE id = ?', [secondCardId])
  const ambiguous = db.export()
  db.close()
  await expect(nativeAnkiProjectionManifest(SQL, ambiguous)).rejects.toThrow('cannot be projected safely')
})

it('rejects duplicate native field ordinals that would alias app fields', async () => {
  const { SQL, snapshot } = await nativeFixture()
  const db = new SQL.Database(snapshot)
  const models = JSON.parse(String(db.exec('SELECT models FROM col')[0].values[0][0]))
  models['100'].flds[1].ord = 0
  db.run('UPDATE col SET models = ?', [JSON.stringify(models)])
  const ambiguous = db.export()
  db.close()
  await expect(nativeAnkiProjectionManifest(SQL, ambiguous)).rejects.toThrow('cannot be projected safely')
})

it('refuses an unsupported native schema before producing an app projection', async () => {
  const { SQL, snapshot } = await nativeFixture(12)
  expect(() => nativeAnkiProjectionData(SQL, snapshot)).toThrow('unsupported Anki collection schema')
})
