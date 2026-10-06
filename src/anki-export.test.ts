import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection, Deck, Note as AnkiNote, Notetype, Package } from 'ankipack'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { createCollection, Rating, type Collection } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'
import { readAnkiExportSnapshot, readCardsForNote, readSyncMediaReferences } from './collection-queries'

let SQL: SqlJsStatic
const databases: Collection[] = []
function database() { const db = createCollection(crypto.randomUUID()); databases.push(db); return db }
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.removeLocalCollection())) })
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
  await source.updateNoteTags(note.id, ['animal'])
  await source.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  const card = (await readAnkiExportSnapshot(source)).cards[0]
  await source.answer(card.id, Rating.Easy, new Date('2026-10-01T12:00:00Z'))
  await source.rescheduleCard(card.id, new Date('2026-10-05T11:23:45Z'))
  await source.setCardFlag(card.id, 4)
  const scheduledCard = (await readAnkiExportSnapshot(source)).cards[0]
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
  const targetSnapshot = await readAnkiExportSnapshot(target)
  const restored = targetSnapshot.notes[0]
  expect(Object.values(restored.fields)).toEqual(['猫 & <cat>', 'ねこ'])
  expect(restored.tags).toEqual(['animal'])
  const restoredType = targetSnapshot.types.find(({ id }) => id === restored.typeId)
  expect(restoredType?.templates.map(({ front, back }) => ({ front, back }))).toEqual([{ front: '{{front}}', back: '{{FrontSide}}<hr>{{back}}' }])
  expect(targetSnapshot.cards[0]).toMatchObject({
    noteId: restored.id, ankiId: native.data.cards[0].id, due: '2026-10-05T11:23:45.000Z', flag: 4,
    state: scheduledCard.state, stability: scheduledCard.stability, difficulty: scheduledCard.difficulty,
    elapsedDays: scheduledCard.elapsedDays, scheduledDays: scheduledCard.scheduledDays,
    learningSteps: scheduledCard.learningSteps, reps: scheduledCard.reps, lapses: scheduledCard.lapses,
    lastReview: scheduledCard.lastReview,
  })
  expect(targetSnapshot.reviews[0]).toMatchObject({ rating: Rating.Easy, reviewedAt: '2026-10-01T12:00:00.000Z' })
  // Causal replay policy is local sync metadata; Anki revlog preserves review facts.
  const sourceSnapshot = await readAnkiExportSnapshot(source)
  const expectedReview = Object.fromEntries(Object.entries(sourceSnapshot.reviews[0]!).filter(([key]) => !['id', 'cardId', 'deckId', 'scheduling'].includes(key)))
  expect(targetSnapshot.reviews[0]).toMatchObject(expectedReview)
  expect(targetSnapshot.blobs.map((blob) => blob.digest)).toEqual(sourceSnapshot.blobs.map((blob) => blob.digest))
  expect(targetSnapshot.references[0]).toMatchObject({ displayName: 'cat.png', side: 'front', inline: false, playback: 'manual' })
})

test('exports and reimports media whose original filename contains Japanese and spaces', async () => {
  const source = database()
  const displayName = '猫 image.png'
  const type = new Notetype({
    id: 1_700_000_000_060,
    name: 'Japanese image card',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [{ name: 'Card', questionFormat: '{{Front}}', answerFormat: '{{FrontSide}}<hr>{{Back}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_061, name: '日本語' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'unicode-media-guid', fields: [`<img src="${displayName}">`, 'vocabulary'] }))
  const nativePackage = new Package()
  nativePackage.addDeck(deck)
  nativePackage.addMedia(displayName, png)
  const firstPreview = await prepareAnkiImport(new File([(await nativePackage.toUint8Array(SQL)).slice().buffer], 'japanese-source.apkg'), source, { SQL })
  expect(firstPreview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await firstPreview.commit()

  const output = await exportAnkiPackage(source, { ...all, SQL })
  const target = database()
  const preview = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'japanese-media.apkg'), target, { SQL })
  expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  await preview.commit()

  const restored = (await readAnkiExportSnapshot(target)).notes[0]
  expect(restored).toBeDefined()
  expect(Object.values(restored?.fields ?? {}).join(' ')).toContain(`[[kiroku-media:${encodeURIComponent(displayName)}]]`)
  await expect(target.mediaForNote(restored!.id)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ displayName, kind: 'image' })]))
  const secondExport = await exportAnkiPackage(target, { ...all, SQL })
  expect(AnkiCollection.open(secondExport.bytes, SQL).data.media).toHaveLength(1)
})

test('exports packages with thousands of distinct media windows inside the archive decoder budget', async () => {
  const source = database()
  const deck = await source.createDeck('Many audio files')
  const note = await source.createBasicNote(deck.id, { front: '音声', back: 'audio' })
  const count = 2_100
  const now = new Date('2026-10-01T12:00:00.000Z').toISOString()
  const attachments = []
  for (let index = 0; index < count; index += 1) {
    const bytes = new Uint8Array(46)
    bytes.set([0x52, 0x49, 0x46, 0x46, 38, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0, 0x64, 0x61, 0x74, 0x61, 2, 0, 0, 0])
    bytes[44] = index & 0xff
    bytes[45] = index >>> 8
    const payload = bytes.slice().buffer as ArrayBuffer
    attachments.push({ file: new File([payload], `audio-${index}.wav`, { type: 'audio/wav' }), side: 'front' as const })
  }
  await source.attachMediaBatch(note.id, attachments, new Date(now))

  const output = await exportAnkiPackage(source, { ...all, SQL })
  expect(output.media).toBe(count)
  expect(AnkiCollection.open(output.bytes, SQL).data.media).toHaveLength(count)
}, 20_000)

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
  await source.updateNoteTags(note.id, ['animal'])
  await source.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  const reference = (await readAnkiExportSnapshot(source)).references[0]!
  await source.evictCachedMedia(reference.digest)
  await expect(exportAnkiPackage(source, { ...all, SQL })).rejects.toThrow('Missing media')
})

test('large note, card, and media relationship sets retain exported identities and media metadata', async () => {
  const source = database()
  const deck = await source.createDeck('Large relationship set')
  const notes = []
  for (let index = 0; index < 128; index++) {
    const note = await source.createBasicNote(deck.id, { front: `front-${index}`, back: `back-${index}` }, new Date(1_700_000_000_000 + index))
    notes.push(note)
    const card = (await readCardsForNote(source, note.id))[0]!
    await source.assignAnkiCardIdentity(card.id, 10_000 + index)
    await source.attachMedia(note.id, { file: new File([png], `image-${index}.png`, { type: 'image/png' }), side: 'front' }, new Date(1_700_000_000_000 + index))
  }

  const native = AnkiCollection.open((await exportAnkiPackage(source, { ...all, SQL })).bytes, SQL)
  expect(native.data.notes).toHaveLength(notes.length)
  expect(native.data.cards).toHaveLength(notes.length)
  expect(native.data.media).toHaveLength(1) // one digest is shared by all references
  const exportedNotes = new Map(native.data.notes.map((note) => [note.guid, note]))
  const storedReferences = await readSyncMediaReferences(source)
  expect(new Set(exportedNotes.keys())).toEqual(new Set(notes.map((note) => note.id)))
  expect(new Set(native.data.cards.map((card) => card.id)).size).toBe(notes.length)
  for (const [index, note] of notes.entries()) {
    const row = exportedNotes.get(note.id)!
    const matchingCards = native.data.cards.filter((card) => card.nid === row.id)
    expect(matchingCards).toHaveLength(1)
    expect(matchingCards[0]!.id).toBe(10_000 + index)
    const mediaReference = storedReferences.find((reference) => reference.noteId === note.id)!
    expect(JSON.parse(row.data).kirokuMedia).toMatchObject([{ name: `${mediaReference.digest}.png`, displayName: `image-${index}.png`, side: 'front' }])
  }
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
  const targetSnapshot = await readAnkiExportSnapshot(target)
  expect(targetSnapshot.notes).toHaveLength(2)
  expect(targetSnapshot.cards).toHaveLength(4)
  expect(targetSnapshot.cards.filter((card) => card.clozeOrdinal).map((card) => card.clozeOrdinal).sort()).toEqual([1, 3])
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
  const targetSnapshot = await readAnkiExportSnapshot(target)
  const restored = targetSnapshot.notes[0]
  expect(restored.imageOcclusion?.masks[0]).toMatchObject({ x: .1, y: .2, width: .3, height: .2 })
  expect(restored.fields).toEqual(note.fields)
  expect(targetSnapshot.blobs[0].digest).toBe((await readAnkiExportSnapshot(source)).blobs[0].digest)
  expect(targetSnapshot.types.every((type) => type.templates.every((template) => !template.front.includes('<script') && !template.back.includes('<script')))).toBe(true)
})

test('a first Good learning answer remains a native intraday learning review', async () => {
  const source = database()
  const deck = await source.createDeck('Learning')
  await source.createBasicNote(deck.id, { front: '学ぶ', back: 'learn' }, new Date('2026-10-01T11:00:00Z'))
  await source.answer((await readAnkiExportSnapshot(source)).cards[0]!.id, Rating.Good, new Date('2026-10-01T12:00:00Z'), 1234)
  const output = await exportAnkiPackage(source, { ...all, SQL })
  await nativeFixture(output.bytes, 'native-good-learning')
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.revlog[0]).toMatchObject({ ease: 3, type: 0, ivl: -600, time: 1234 })
})

test('review transitions keep Anki pre-answer revlog fields while exporting the resulting interval', async () => {
  const source = database()
  const deck = await source.createDeck('Review transition')
  const note = await source.createBasicNote(deck.id, { front: '復習', back: 'review' })
  const now = new Date('2026-10-01T12:00:00Z')
  const card = (await readCardsForNote(source, note.id))[0]!
  const introduced = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  await source.answer(card.id, Rating.Easy, introduced)
  await source.rescheduleCard(card.id, now, introduced)
  const scheduledCard = (await readCardsForNote(source, note.id))[0]!
  const review = await source.answer(card.id, Rating.Again, now)
  const native = AnkiCollection.open((await exportAnkiPackage(source, { ...all, SQL })).bytes, SQL)
  expect(review).toMatchObject({ state: scheduledCard.state, scheduledDays: scheduledCard.scheduledDays, afterScheduledDays: 0 })
  expect(native.data.revlog.at(-1)).toMatchObject({ lastIvl: scheduledCard.scheduledDays, ivl: -600 })
})
