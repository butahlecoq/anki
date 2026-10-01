import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection, Deck, Note as AnkiNote, Notetype, Package } from 'ankipack'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createCollection, State, type Collection } from './collection'
import { prepareAnkiImport } from './anki-import'

let SQL: SqlJsStatic
let collection: Collection | undefined

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
})

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

afterAll(() => {
  SQL = undefined as unknown as SqlJsStatic
})

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0))
function wavFixture() {
  const samples = 800
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => [...value].forEach((character, index) => { bytes[offset + index] = character.charCodeAt(0) })
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true)
  view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, samples, true)
  bytes.fill(128, 44)
  return bytes
}
const wav = wavFixture()

async function fileBytes(file: File) {
  return new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(file)
  }))
}

async function japanesePackage() {
  const vocabulary = new Notetype({
    id: 1_700_000_000_001,
    name: 'Japanese vocabulary',
    fields: [{ name: 'Expression' }, { name: 'Reading' }, { name: 'Meaning' }, { name: 'Media' }],
    templates: [
      { name: 'Recognition', questionFormat: '<b>{{Expression}}</b><br>{{furigana:Reading}}{{Media}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' },
      { name: 'Production', questionFormat: '{{Meaning}}', answerFormat: '{{Expression}}<br>{{kana:Reading}}' },
    ],
    css: '.card { color: rgb(30, 40, 50); }',
  })
  const cloze = new Notetype({
    id: 1_700_000_000_002,
    name: 'Japanese cloze',
    type: 'cloze',
    fields: [{ name: 'Text' }, { name: 'Extra' }],
    templates: [{ name: 'Cloze', questionFormat: '{{cloze:Text}}', answerFormat: '{{cloze:Text}}<hr>{{Extra}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_010, name: 'Japanese::Core' })
  deck.addNote(new AnkiNote({
    notetype: vocabulary,
    guid: 'stable-vocabulary-guid',
    fields: ['猫', '猫[ねこ]', 'cat', '<img src="cat.png"><br>[sound:cat.wav]'],
    tags: ['jlpt::n5', 'animal'],
  }))
  deck.addNote(new AnkiNote({ notetype: cloze, guid: 'stable-cloze-guid', fields: ['{{c1::東京}}へ{{c2::行く}}', 'Tokyo'], tags: ['sentence'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('cat.png', png)
  pkg.addMedia('cat.wav', wav)
  const opened = AnkiCollection.open(await pkg.toUint8Array(SQL), SQL)
  const firstCard = opened.data.cards.find((card) => card.nid === opened.data.notes.find((note) => note.guid === 'stable-vocabulary-guid')?.id)
  if (!firstCard) throw new Error('fixture card missing')
  firstCard.type = 2
  firstCard.queue = 2
  firstCard.ivl = 12
  firstCard.due = 20
  firstCard.factor = 425
  firstCard.reps = 5
  firstCard.lapses = 1
  firstCard.data = '{"s":12.5,"d":4.25}'
  opened.data.revlog.push({ id: 1_725_192_000_000, cid: firstCard.id, usn: -1, ease: 3, ivl: 12, lastIvl: 5, factor: 425, time: 1200, type: 1 })
  return new File([(await opened.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'japanese.apkg', { type: 'application/octet-stream' })
}

async function imageOcclusionPackage() {
  const type = new Notetype({
    id: 1_700_000_000_020,
    name: 'Image Occlusion',
    type: 'cloze',
    fields: [{ name: 'Occlusion' }, { name: 'Image' }, { name: 'Header' }, { name: 'Back Extra' }, { name: 'Comments' }],
    templates: [{ name: 'Hide one, reveal one', questionFormat: '{{cloze:Occlusion}}<br>{{Image}}', answerFormat: '{{cloze:Occlusion}}<br>{{Image}}<hr>{{Back Extra}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_021, name: 'Anatomy' })
  deck.addNote(new AnkiNote({
    notetype: type,
    guid: 'stable-occlusion-guid',
    fields: [
      '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.2}}<br>{{c2::image-occlusion:rect:left=.6:top=.5:width=.2:height=.3}}<br>',
      '<img src="diagram.png">',
      'Skull bones',
      'Name the hidden bone.',
      'Imported fixture',
    ],
  }))
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('diagram.png', png)
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'occlusion.colpkg', { type: 'application/octet-stream' })
}

async function unsupportedPackage() {
  const type = new Notetype({
    id: 1_700_000_000_030,
    name: 'Unsupported hints',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [{ name: 'Hint card', questionFormat: '{{hint:Front}}', answerFormat: '{{Back}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_031, name: 'Unsupported' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'unsupported-guid', fields: ['question', 'answer'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'unsupported.apkg', { type: 'application/octet-stream' })
}

async function malformedMediaPackage() {
  const type = new Notetype({
    id: 1_700_000_000_040,
    name: 'Malformed media',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [{ name: 'Card', questionFormat: '{{Front}}', answerFormat: '{{Back}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_041, name: 'Malformed media' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'malformed-media-guid', fields: ['<img src="broken.png">', 'answer'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('broken.png', new Uint8Array([1, 2, 3, 4]))
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'malformed-media.apkg', { type: 'application/octet-stream' })
}

async function executableTemplatePackage() {
  const type = new Notetype({
    id: 1_700_000_000_050,
    name: 'Executable template',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [{ name: 'Card', questionFormat: '<script>document.body.textContent = "changed"</script>{{Front}}', answerFormat: '{{Back}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_051, name: 'Executable template' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'executable-guid', fields: ['question', 'answer'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'executable.apkg', { type: 'application/octet-stream' })
}

describe('Anki package import', () => {
  test('previews and transactionally imports templates, scheduling, history, tags, and media from a modern package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await japanesePackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.summary).toMatchObject({ decks: 1, noteTypes: 2, notes: 2, cards: 4, reviews: 1, media: 2 })
    expect(prepared.duplicates).toEqual({ create: 2, update: 0, keepLocal: 0, unchanged: 0 })
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deck-hierarchy', detail: expect.stringContaining('Japanese::Core') }),
      expect.objectContaining({ code: 'scheduling-mapped', detail: expect.stringContaining('FSRS memory state') }),
    ]))

    await prepared.commit()

    const decks = await collection.decks.toArray()
    expect(decks).toEqual([expect.objectContaining({ name: 'Japanese::Core' })])
    const types = (await collection.noteTypes.toArray()).filter((type) => !type.protected)
    expect(types).toHaveLength(2)
    expect(types.find((type) => type.name === 'Japanese vocabulary')).toMatchObject({
      kind: 'standard',
      templates: [
        expect.objectContaining({ name: 'Recognition', front: expect.stringContaining('{{furigana:Reading}}'), css: expect.stringContaining('rgb(30, 40, 50)') }),
        expect.objectContaining({ name: 'Production' }),
      ],
    })
    const notes = await collection.notes.toArray()
    expect(notes.find((note) => note.id === 'anki-note:stable-vocabulary-guid')).toMatchObject({ tags: ['jlpt::n5', 'animal'] })
    expect(notes.find((note) => note.id === 'anki-note:stable-cloze-guid')?.fields).toEqual(expect.objectContaining({ 'anki-field:1700000000002:0': '{{c1::東京}}へ{{c2::行く}}' }))
    const scheduled = (await collection.cards.toArray()).find((card) => card.reps === 5)
    expect(scheduled).toMatchObject({ state: State.Review, stability: 12.5, difficulty: 4.25, scheduledDays: 12, lapses: 1 })
    await expect(collection.reviewEntries.toArray()).resolves.toEqual([expect.objectContaining({
      id: 'anki-review:1725192000000',
      reviewedAt: '2024-09-01T12:00:00.000Z',
      due: '2024-09-01T12:00:00.000Z',
      scheduledDays: 5,
      elapsedDays: 0,
    })])
    const media = await collection.mediaForNote('anki-note:stable-vocabulary-guid')
    expect(media).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'cat.png', kind: 'image', side: 'front' }),
      expect.objectContaining({ displayName: 'cat.wav', kind: 'audio', side: 'front', playback: 'automatic' }),
    ]))
    await expect(collection.mediaBlobs.count()).resolves.toBe(2)
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'noteType', action: 'create' }),
      expect.objectContaining({ entityType: 'review', action: 'create' }),
      expect.objectContaining({ entityType: 'noteMedia', action: 'create' }),
    ]))
  })

  test('keeps a newer local edit when the same stable Anki note is imported again', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })).commit()
    const note = await collection.notes.get('anki-note:stable-vocabulary-guid')
    if (!note) throw new Error('imported note missing')
    await collection.updateNote(note.id, { ...note.fields, 'anki-field:1700000000001:2': 'feline' }, new Date('2030-01-01T00:00:00.000Z'))
    const existingMedia = await collection.mediaForNote(note.id)
    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceNote = source.data.notes.find((candidate) => candidate.guid === 'stable-vocabulary-guid')
    if (!sourceNote) throw new Error('fixture note missing')
    const values = sourceNote.flds.split('\u001f')
    values[3] = ''
    sourceNote.flds = values.join('\u001f')
    sourceNote.mod = Math.floor(new Date('2027-01-01T00:00:00.000Z').getTime() / 1000)
    const olderPackage = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'older.apkg')

    const prepared = await prepareAnkiImport(olderPackage, collection, { SQL, now: new Date('2026-10-02T12:00:00.000Z') })
    expect(prepared.duplicates.keepLocal).toBe(1)
    await prepared.commit()
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { 'anki-field:1700000000001:2': 'feline' } })
    await expect(collection.mediaForNote(note.id)).resolves.toEqual(existingMedia)
    await expect(collection.reviewEntries.count()).resolves.toBe(1)
  })

  test('applies newer source scheduling without overwriting a newer local review', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })).commit()
    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceCard = source.data.cards.find((card) => card.reps === 5)
    if (!sourceCard) throw new Error('fixture card missing')
    sourceCard.mod = 1_799_000_000
    sourceCard.due = 40
    sourceCard.ivl = 20
    sourceCard.data = '{"s":20,"d":3}'
    const updated = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'updated.apkg')

    await (await prepareAnkiImport(updated, collection, { SQL, now: new Date('2027-01-01T12:00:00.000Z') })).commit()
    const importedCard = (await collection.cards.toArray()).find((card) => card.reps === 5)
    expect(importedCard).toMatchObject({ stability: 20, difficulty: 3, scheduledDays: 20, sourceModifiedAt: new Date(sourceCard.mod * 1000).toISOString() })

    await collection.answer(importedCard!.id, 3, new Date('2030-01-01T12:00:00.000Z'))
    const afterLocalReview = await collection.cards.get(importedCard!.id)
    sourceCard.mod = 1_830_000_000
    sourceCard.due = 60
    const staleSchedule = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'stale-schedule.apkg')
    await (await prepareAnkiImport(staleSchedule, collection, { SQL, now: new Date('2030-01-02T12:00:00.000Z') })).commit()
    await expect(collection.cards.get(importedCard!.id)).resolves.toEqual(afterLocalReview)
  })

  test('restores a filtered card to its original deck and original due day', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceCard = source.data.cards.find((card) => card.reps === 5)
    const homeDeck = source.data.decks.find((deck) => deck.id === sourceCard?.did)
    if (!sourceCard || !homeDeck) throw new Error('fixture card or deck missing')
    const filteredDeckId = 1_700_000_000_099
    source.data.decks.push({ ...homeDeck, id: filteredDeckId, name: 'Filtered' })
    sourceCard.odid = homeDeck.id
    sourceCard.odue = 7
    sourceCard.did = filteredDeckId
    sourceCard.due = 1_800_000_000
    const filtered = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'filtered.apkg')

    await (await prepareAnkiImport(filtered, collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })).commit()
    const imported = (await collection.cards.toArray()).find((card) => card.reps === 5)
    expect(imported).toMatchObject({
      deckId: `anki-deck:${homeDeck.id}`,
      due: new Date(source.data.col.crt * 1000 + 7 * 86_400_000).toISOString(),
    })
  })

  test('maps the supported native rectangular image-occlusion subset', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await imageOcclusionPackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.summary).toMatchObject({ decks: 1, noteTypes: 1, notes: 1, cards: 2, media: 1 })
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    await prepared.commit()

    const note = await collection.notes.get('anki-note:stable-occlusion-guid')
    expect(note).toMatchObject({
      typeId: 'image-occlusion',
      fields: { header: 'Skull bones', backExtra: 'Name the hidden bone.' },
      imageOcclusion: { imageWidth: 1, imageHeight: 1, masks: [
        expect.objectContaining({ ordinal: 1, x: .1, y: .2, width: .3, height: .2 }),
        expect.objectContaining({ ordinal: 2, x: .6, y: .5, width: .2, height: .3 }),
      ] },
    })
    await expect(collection.cards.where('noteId').equals(note!.id).count()).resolves.toBe(2)
    await expect(collection.mediaForNote(note!.id)).resolves.toEqual([expect.objectContaining({ displayName: 'diagram.png', kind: 'image' })])
  })

  test('rejects a stale preview without partially writing the package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await japanesePackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })
    await collection.decks.put({ id: 'anki-deck:1700000000010', name: 'Concurrent deck', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' })

    await expect(prepared.commit()).rejects.toThrow(/preview again/i)
    await expect(collection.decks.count()).resolves.toBe(1)
    await expect(collection.notes.count()).resolves.toBe(0)
    await expect(collection.cards.count()).resolves.toBe(0)
    await expect(collection.mediaBlobs.count()).resolves.toBe(0)
  })

  test('reports unsupported template features instead of silently dropping them', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await unsupportedPackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Unsupported hints', detail: expect.stringMatching(/unsupported template filter/i) }),
      expect.objectContaining({ severity: 'error', code: 'note-skipped', subject: 'unsupported-guid' }),
    ]))
    await expect(prepared.commit()).rejects.toThrow(/resolve package errors/i)
    await expect(collection.decks.count()).resolves.toBe(0)
    await expect(collection.notes.count()).resolves.toBe(0)
  })

  test('blocks executable templates and malformed media bytes with detailed errors', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const executable = await prepareAnkiImport(await executableTemplatePackage(), collection, { SQL })
    expect(executable.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Executable template', detail: expect.stringMatching(/executable/i) })]))
    await expect(executable.commit()).rejects.toThrow(/resolve package errors/i)
    const malformed = await prepareAnkiImport(await malformedMediaPackage(), collection, { SQL })
    expect(malformed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'media-malformed', subject: 'broken.png' })]))
    await expect(malformed.commit()).rejects.toThrow(/resolve package errors/i)
  })

})
