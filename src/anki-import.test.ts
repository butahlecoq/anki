import 'fake-indexeddb/auto'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection, Deck, Note as AnkiNote, Notetype, Package } from 'ankipack'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { DEFAULT_DECK_OPTION_GROUP_ID, createCollection, State, type Collection } from './collection'
import { prepareAnkiImport } from './anki-import'
import { zipSync } from 'fflate'
import { ANKI_ARCHIVE_LIMITS } from './anki-archive'

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
  const bytes = new Uint8Array(54 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => [...value].forEach((character, index) => { bytes[offset + index] = character.charCodeAt(0) })
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true)
  view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  text(36, 'JUNK'); view.setUint32(40, 1, true); bytes[44] = 1
  text(46, 'data'); view.setUint32(50, samples, true); bytes.fill(128, 54)
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
    name: 'Unsupported custom filters',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [{ name: 'Custom filter card', questionFormat: '{{custom:Front}}', answerFormat: '{{Back}}' }],
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
  const truncatedPng = new Uint8Array(24)
  truncatedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  truncatedPng.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(truncatedPng.buffer).setUint32(16, 1)
  new DataView(truncatedPng.buffer).setUint32(20, 1)
  pkg.addMedia('broken.png', truncatedPng)
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
  test.each(['apkg', 'colpkg'])('rejects hostile %s archives without collection or outbox mutation', async (extension) => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const hugeEntry = zipSync({ 'collection.anki2': new Uint8Array(1) })
    const view = new DataView(hugeEntry.buffer)
    view.setUint32(22, ANKI_ARCHIVE_LIMITS.entryBytes + 1, true)
    for (let offset = 0; offset <= hugeEntry.length - 46; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, ANKI_ARCHIVE_LIMITS.entryBytes + 1, true)
    }
    const hugeCount = zipSync({ media: new Uint8Array() })
    const countView = new DataView(hugeCount.buffer)
    countView.setUint16(hugeCount.length - 22 + 8, ANKI_ARCHIVE_LIMITS.entries + 1, true)
    countView.setUint16(hugeCount.length - 22 + 10, ANKI_ARCHIVE_LIMITS.entries + 1, true)
    const hugeWindow = zipSync({ 'collection.anki21b': Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x88, 1, 0, 0]) })
    // No frame declares its output size. A few kilobytes of RLE frames emit
    // more than 64 MiB, exercising the real streamed cap rather than metadata.
    const frame = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x38, 3, 0, 0x10, 65])
    const frames = new Uint8Array(frame.length * (ANKI_ARCHIVE_LIMITS.entryBytes / 131_072 + 1))
    for (let offset = 0; offset < frames.length; offset += frame.length) frames.set(frame, offset)
    const actualBomb = zipSync({ 'collection.anki21b': frames })
    const fixtures = [hugeEntry, hugeCount, hugeWindow, actualBomb, zipSync({ '../media': new Uint8Array() }), Uint8Array.from([1, 2, 3])]
    for (const bytes of fixtures) {
      const file = new File([bytes.slice().buffer], `hostile.${extension}`)
      await expect(prepareAnkiImport(file, collection, { SQL })).rejects.toThrow(/Unable to read/i)
      expect(await collection.decks.count()).toBe(0)
      expect(await collection.notes.count()).toBe(0)
      expect(await collection.cards.count()).toBe(0)
      expect(await collection.reviewEntries.count()).toBe(0)
      expect(await collection.noteMedia.count()).toBe(0)
      expect(await collection.mediaBlobs.count()).toBe(0)
      expect(await collection.pendingOperations()).toHaveLength(0)
    }
  })
  test('previews and transactionally imports templates, scheduling, history, tags, and media from a modern package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await japanesePackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.summary).toMatchObject({ decks: 2, noteTypes: 2, notes: 2, cards: 4, reviews: 1, media: 2 })
    expect(prepared.duplicates).toEqual({ create: 2, update: 0, keepLocal: 0, unchanged: 0 })
    expect(structuredClone(prepared.plan)).toMatchObject({
      blocksImport: false,
      writes: {
        decks: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-deck:1700000000010' }) })]),
        noteTypes: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-note-type:1700000000001' }) })]),
        notes: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-note:stable-vocabulary-guid' }) })]),
        cards: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: expect.any(String) }) })]),
        reviews: [expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-review:1725192000000' }) })],
        references: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ noteId: 'anki-note:stable-vocabulary-guid' }) })]),
      },
      decisions: expect.arrayContaining([
        { entity: 'note', id: 'anki-note:stable-vocabulary-guid', action: 'create' },
        { entity: 'review', id: 'anki-review:1725192000000', action: 'create' },
      ]),
    })
    expect(prepared.plan).not.toHaveProperty('collection')
    expect(prepared.plan.writes.blobs.every((blob) => !('blob' in blob))).toBe(true)
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deck-hierarchy', detail: expect.stringContaining('Japanese::Core') }),
      expect.objectContaining({ code: 'scheduling-mapped', detail: expect.stringContaining('FSRS memory state') }),
    ]))

    await prepared.commit()

    const decks = await collection.decks.toArray()
    expect(decks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Japanese', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID }),
      expect.objectContaining({ name: 'Core', parentId: expect.any(String), optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID }),
    ]))
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
      durationMs: 1200,
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
    expect(prepared.plan.decisions).toContainEqual({ entity: 'note', id: note.id, action: 'keepLocal' })
    expect(prepared.plan.writes.notes).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ id: note.id }) }))
    await prepared.commit()
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { 'anki-field:1700000000001:2': 'feline' } })
    await expect(collection.mediaForNote(note.id)).resolves.toEqual(existingMedia)
    await expect(collection.reviewEntries.count()).resolves.toBe(1)
  })

  test('plans suspension only for local cards absent from the package and keeps present local card state', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const noteId = 'anki-note:stable-vocabulary-guid'
    const localCards = await collection.cards.where('noteId').equals(noteId).toArray()
    const missingCard = localCards.find((card) => card.templateId === 'anki-template:1700000000001:1')
    const presentCard = localCards.find((card) => card.templateId === 'anki-template:1700000000001:0')
    if (!missingCard || !presentCard) throw new Error('Expected both generated vocabulary cards')
    await collection.cards.put({ ...presentCard, suspended: true, manualSuspended: true })

    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceNote = source.data.notes.find((candidate) => candidate.guid === 'stable-vocabulary-guid')
    if (!sourceNote) throw new Error('Fixture note missing')
    source.data.cards = source.data.cards.filter((card) => card.nid !== sourceNote.id || card.ord !== 1)
    const reduced = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'reduced-cards.apkg')
    const plan = await prepareAnkiImport(reduced, collection, { SQL })

    expect(plan.plan.writes.cards).toContainEqual(expect.objectContaining({
      action: 'update',
      value: expect.objectContaining({ id: missingCard.id, suspended: true }),
    }))
    expect(plan.plan.decisions).toContainEqual({ entity: 'card', id: missingCard.id, action: 'update' })
    expect(plan.plan.decisions).toContainEqual({ entity: 'card', id: presentCard.id, action: 'keepLocal' })
    expect(plan.plan.writes.cards).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ id: presentCard.id }) }))
  })

  test('plans removal of dropped media references while retaining references still present in the package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const noteId = 'anki-note:stable-vocabulary-guid'
    const localReferences = await collection.mediaForNote(noteId)
    const dropped = localReferences.find((reference) => reference.displayName === 'cat.png')
    const retained = localReferences.find((reference) => reference.displayName === 'cat.wav')
    if (!dropped || !retained) throw new Error('Expected image and audio references')

    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceNote = source.data.notes.find((candidate) => candidate.guid === 'stable-vocabulary-guid')
    if (!sourceNote) throw new Error('Fixture note missing')
    const fields = sourceNote.flds.split('\u001f')
    fields[3] = '[sound:cat.wav]'
    sourceNote.flds = fields.join('\u001f')
    sourceNote.mod = Math.floor(new Date('2027-01-01T00:00:00.000Z').getTime() / 1000)
    const reduced = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'reduced-media.apkg')
    const plan = await prepareAnkiImport(reduced, collection, { SQL })

    expect(plan.plan.writes.deletedReferences).toContainEqual(expect.objectContaining({ id: dropped.id, noteId }))
    expect(plan.plan.decisions).toContainEqual({ entity: 'mediaReference', id: dropped.id, action: 'delete' })
    expect(plan.plan.decisions).toContainEqual(expect.objectContaining({ entity: 'mediaReference', id: retained.id, action: 'update' }))
    expect(plan.plan.writes.deletedReferences).not.toContainEqual(expect.objectContaining({ id: retained.id }))
  })

  test('keeps card-generation failures distinct from templates that are simply ineligible', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const type = await collection.createNoteType({ name: 'Card generation failure', fields: [{ name: 'Front' }], templates: [{ name: 'Card', front: '{{Front}}', back: 'Answer', css: '' }] })
    const malformed = { ...type, templates: [{ ...type.templates[0], back: '{{Front' }] }

    expect(collection.tryCardGenerationStatus(type, { [type.fields[0].id]: '' })).toEqual({
      ok: true,
      value: { eligible: [], skipped: [{ templateId: type.templates[0].id, reason: 'Front has no visible field content' }] },
    })
    expect(collection.tryCardGenerationStatus(malformed, { [type.fields[0].id]: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/template delimiter/i) })
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

  test('keeps a note aggregate intact when its locally newer note type wins', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const noteId = 'anki-note:stable-vocabulary-guid'
    const typeId = 'anki-note-type:1700000000001'
    const localType = await collection.noteTypes.get(typeId)
    const localNote = await collection.notes.get(noteId)
    if (!localType || !localNote) throw new Error('imported fixture missing')
    await collection.noteTypes.put({ ...localType, name: 'Locally customized', updatedAt: '2030-01-01T00:00:00.000Z' })
    const beforeCards = await collection.cards.where('noteId').equals(noteId).toArray()
    const beforeMedia = await collection.mediaForNote(noteId)
    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceNote = source.data.notes.find((note) => note.guid === 'stable-vocabulary-guid')
    if (!sourceNote) throw new Error('source fixture missing')
    const fields = sourceNote.flds.split('\u001f')
    fields[2] = 'package replacement'
    sourceNote.flds = fields.join('\u001f')
    sourceNote.mod = Math.floor(new Date('2029-01-01T00:00:00.000Z').getTime() / 1000)
    const changed = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'changed.apkg')

    const prepared = await prepareAnkiImport(changed, collection, { SQL })
    expect(prepared.duplicates.keepLocal).toBeGreaterThan(0)
    expect(prepared.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', code: 'local-note-type-wins', subject: noteId })]))
    await prepared.commit()
    await expect(collection.notes.get(noteId)).resolves.toEqual(localNote)
    await expect(collection.cards.where('noteId').equals(noteId).toArray()).resolves.toEqual(beforeCards)
    await expect(collection.mediaForNote(noteId)).resolves.toEqual(beforeMedia)
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
      fields: { header: 'Skull bones', backExtra: 'Name the hidden bone.\nImported fixture' },
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
    await collection.decks.put({ id: 'anki-deck:1700000000010', name: 'Concurrent deck', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' })

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
      expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Unsupported custom filters', detail: expect.stringMatching(/unsupported template filter/i) }),
      expect.objectContaining({ severity: 'error', code: 'note-skipped', subject: 'unsupported-guid' }),
    ]))
    await expect(prepared.commit()).rejects.toThrow(/resolve package errors/i)
    await expect(collection.decks.count()).resolves.toBe(0)
    await expect(collection.notes.count()).resolves.toBe(0)
  })

  test('blocks executable templates and malformed media bytes with detailed errors', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const executable = await prepareAnkiImport(await executableTemplatePackage(), collection, { SQL })
    expect(executable.plan.blocksImport).toBe(true)
    expect(executable.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Executable template', detail: expect.stringMatching(/executable/i) })]))
    await expect(executable.commit()).rejects.toThrow(/resolve package errors/i)
    const malformed = await prepareAnkiImport(await malformedMediaPackage(), collection, { SQL })
    expect(malformed.plan.blocksImport).toBe(true)
    expect(malformed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'media-malformed', subject: 'broken.png' })]))
    await expect(malformed.commit()).rejects.toThrow(/resolve package errors/i)
  })

})
