import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection } from 'ankipack'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { createCollection, Rating, State, type Collection } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'

let SQL: SqlJsStatic
const databases: Collection[] = []
function database() { const db = createCollection(crypto.randomUUID()); databases.push(db); return db }
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.delete())) })
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0))
const all = { scheduling: true, history: true, media: true }
async function nativeFixture(bytes: Uint8Array, name: string) {
  if (!(globalThis as unknown as { process?: { env: Record<string, string> } }).process?.env.KIROKU_NATIVE_EXPORT_FIXTURE) return
  const nodeModule = 'node:fs/promises'
  const { mkdir, writeFile } = await import(nodeModule) as { mkdir(path: string, options: { recursive: boolean }): Promise<void>; writeFile(path: string, bytes: Uint8Array | string): Promise<void> }
  await mkdir('runtime/export-interop', { recursive: true })
  const native = AnkiCollection.open(bytes, SQL)
  const media = await Promise.all(native.data.media.map(async (item) => ({ name: item.name, digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', item.data.slice().buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('') })))
  await writeFile(`runtime/export-interop/${name}.apkg`, bytes)
  await writeFile(`runtime/export-interop/${name}.json`, JSON.stringify({ notes: native.data.notes, cards: native.data.cards, decks: native.data.decks.map(({ id, name }) => ({ id, name: name.replaceAll('\u001f', '::') })), reviews: native.data.revlog, fields: native.data.fields.map(({ ntid, ord, name }) => ({ ntid, ord, name })), media }))
}
test('Japanese native package preserves field meaning, tags, decks, templates, schedule, history, and media hashes in clean storage', async () => {
  const source = database()
  const deck = await source.createDeck('日本語')
  const note = await source.createBasicNote(deck.id, { front: '猫 & <cat>', back: 'ねこ' })
  await source.notes.update(note.id, { tags: ['animal'] })
  await source.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  const card = (await source.cards.toArray())[0]
  await source.answer(card.id, Rating.Easy, new Date('2026-10-01T12:00:00Z'))
  await source.cards.update(card.id, { due: '2026-10-05T11:23:45Z', state: State.Review, stability: 4.25, difficulty: 6.2, elapsedDays: 2, scheduledDays: 4, reps: 3, lapses: 1, flag: 4 })
  const output = await exportAnkiPackage(source, { ...all, SQL })
  await nativeFixture(output.bytes, 'native-export')
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.media).toHaveLength(1)
  expect(native.data.cards[0].flags).toBe(4)
  expect(native.data.revlog).toHaveLength(1)
  const target = database()
  const preview = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'backup.apkg'), target, { SQL })
  expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await preview.commit()
  const restored = (await target.notes.toArray())[0]
  expect(Object.values(restored.fields)).toEqual(['猫 & <cat>', 'ねこ'])
  expect(restored.tags).toEqual(['animal'])
  const restoredType = await target.noteTypes.get(restored.typeId)
  expect(restoredType?.templates.map(({ front, back }) => ({ front, back }))).toEqual([{ front: '{{front}}', back: '{{FrontSide}}<hr>{{back}}' }])
  expect((await target.cards.toArray())[0]).toMatchObject({ noteId: restored.id, due: '2026-10-05T11:23:45.000Z', stability: 4.25, difficulty: 6.2, elapsedDays: 2, scheduledDays: 4, reps: 3, lapses: 1, flag: 4 })
  expect((await target.reviewEntries.toArray())[0]).toMatchObject({ rating: Rating.Easy, reviewedAt: '2026-10-01T12:00:00.000Z' })
  // Causal replay policy is local sync metadata; Anki revlog preserves review facts.
  const expectedReview = Object.fromEntries(Object.entries((await source.reviewEntries.toArray())[0]).filter(([key]) => !['id', 'cardId', 'deckId', 'scheduling'].includes(key)))
  expect((await target.reviewEntries.toArray())[0]).toMatchObject(expectedReview)
  expect((await target.mediaBlobs.toArray()).map((blob) => blob.digest)).toEqual((await source.mediaBlobs.toArray()).map((blob) => blob.digest))
  expect((await target.noteMedia.toArray())[0]).toMatchObject({ displayName: 'cat.png', side: 'front', inline: false, playback: 'manual' })
})
test('selected deck includes descendants and options reset cards and omit media and history', async () => {
  const source = database()
  const parent = await source.createDeck('Japanese')
  const child = await source.createDeck('Core', { parentId: parent.id })
  const other = await source.createDeck('Other')
  await source.createBasicNote(child.id, { front: '猫', back: 'cat' })
  await source.createBasicNote(other.id, { front: 'other', back: 'other' })
  const output = await exportAnkiPackage(source, { deckId: parent.id, scheduling: false, history: false, media: false, SQL })
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.notes).toHaveLength(1)
  expect(native.deckNames()).toContain('Japanese::Core')
  expect(native.data.cards[0]).toMatchObject({ type: 0, reps: 0 })
  expect(native.data.revlog).toEqual([])
  expect(native.data.media).toEqual([])
})
test('missing media blocks export before success', async () => {
  const source = database()
  const deck = await source.createDeck('Media')
  const note = await source.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await source.notes.update(note.id, { tags: ['animal'] })
  await source.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  await source.mediaBlobs.clear()
  await expect(exportAnkiPackage(source, { ...all, SQL })).rejects.toThrow('Missing media')
})

test('multiple templates and cloze ordinals keep their note relationships and native IDs across two exports', async () => {
  const source = database()
  const deck = await source.createDeck('Japanese')
  const type = await source.createNoteType({ name: 'Recognition and production', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', front: '{{Expression}}', back: '{{Meaning}}', css: '.card{color:red}' }, { name: 'Production', front: '{{Meaning}}', back: '{{Expression}}', css: '.card{color:red}' }] })
  await source.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
  const cloze = await source.createNoteType({ name: 'Japanese cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
  await source.createNote(deck.id, cloze.id, { [cloze.fields[0].id]: '{{c1::東京}}へ{{c3::行く}}' })
  const output = await exportAnkiPackage(source, { ...all, SQL })
  const native = AnkiCollection.open(output.bytes, SQL)
  const target = database()
  const preview = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'backup.apkg'), target, { SQL })
  expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await preview.commit()
  expect(await target.notes.count()).toBe(2)
  expect(await target.cards.count()).toBe(4)
  expect((await target.cards.toArray()).filter((card) => card.clozeOrdinal).map((card) => card.clozeOrdinal).sort()).toEqual([1, 3])
  const second = AnkiCollection.open((await exportAnkiPackage(target, { ...all, SQL })).bytes, SQL)
  await nativeFixture(output.bytes, 'native-multiple-cloze')
  expect(second.data.notes.map((note) => [note.id, note.guid, note.mid]).sort()).toEqual(native.data.notes.map((note) => [note.id, note.guid, note.mid]).sort())
  expect(second.data.cards.map((card) => [card.id, card.nid, card.did, card.ord]).sort()).toEqual(native.data.cards.map((card) => [card.id, card.nid, card.did, card.ord]).sort())
})

test('rectangular image occlusion restores its masks and image hash', async () => {
  const source = database()
  const deck = await source.createDeck('Occlusion')
  const note = await source.createImageOcclusionNote(deck.id, { image: new File([png], 'diagram.png', { type: 'image/png' }), imageWidth: 1, imageHeight: 1, header: '骨', backExtra: 'bone', tags: ['diagram'], masks: [{ x: .1, y: .2, width: .3, height: .2 }] })
  const output = await exportAnkiPackage(source, { ...all, SQL })
  await nativeFixture(output.bytes, 'native-occlusion')
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.templates[0].config.length).toBeGreaterThan(0)
  expect(new TextDecoder().decode(native.data.templates[0].config)).toContain('anki.imageOcclusion.setup()')
  const target = database()
  const preview = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'backup.apkg'), target, { SQL })
  expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await preview.commit()
  const restored = (await target.notes.toArray())[0]
  expect(restored.imageOcclusion?.masks[0]).toMatchObject({ x: .1, y: .2, width: .3, height: .2 })
  expect(restored.fields).toEqual(note.fields)
  expect((await target.mediaBlobs.toArray())[0].digest).toBe((await source.mediaBlobs.toArray())[0].digest)
  expect((await target.noteTypes.toArray()).every((type) => type.templates.every((template) => !template.front.includes('<script') && !template.back.includes('<script')))).toBe(true)
})

test('a first Good learning answer remains a native intraday learning review', async () => {
  const source = database()
  const deck = await source.createDeck('Learning')
  await source.createBasicNote(deck.id, { front: '学ぶ', back: 'learn' }, new Date('2026-10-01T11:00:00Z'))
  await source.answer((await source.cards.toArray())[0].id, Rating.Good, new Date('2026-10-01T12:00:00Z'), 1234)
  const output = await exportAnkiPackage(source, { ...all, SQL })
  await nativeFixture(output.bytes, 'native-good-learning')
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.revlog[0]).toMatchObject({ ease: 3, type: 0, ivl: -600, time: 1234 })
})

