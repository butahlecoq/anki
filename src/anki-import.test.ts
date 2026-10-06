import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection, Deck, Note as AnkiNote, Notetype, Package } from 'ankipack'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { DEFAULT_DECK_OPTION_GROUP_ID, createCollection, tryRenderNoteTemplate, State, Rating, type Collection } from './collection'
import { prepareAnkiDataImport, prepareAnkiImport, validateMediaBytes } from './anki-import'
import { exportAnkiPackage } from './anki-export'
import { renderNoteCard } from './card-rendering'
import { prepareReviewMedia } from './review-media'
import { digestMedia } from './media'
import { zipSync } from 'fflate'
import { ANKI_ARCHIVE_LIMITS } from './anki-archive'
import { readAnkiExportSnapshot, readCard, readCardsForNote, readCardReviewHistory, readCollectionSetting, readNote, readNoteType, readReceivedOperation, readSyncRevision } from './collection-queries'

let SQL: SqlJsStatic
let collection: Collection | undefined
let syncReplica: Collection | undefined

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await collection?.removeLocalCollection()
  await syncReplica?.removeLocalCollection()
  collection = undefined
  syncReplica = undefined
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
      { name: 'Production', questionFormat: '{{type:Meaning}}', answerFormat: '{{Expression}}<br>{{kana:Reading}}' },
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
  opened.data.revlog.push({ id: 1_725_192_060_000, cid: firstCard.id, usn: -1, ease: 4, ivl: 30, lastIvl: 12, factor: 425, time: 900, type: 0 })
  return new File([(await opened.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'japanese.apkg', { type: 'application/octet-stream' })
}

async function templateMediaPackage() {
  const type = new Notetype({
    id: 1_700_000_000_030,
    name: 'Template media',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [
      { name: 'Image front', questionFormat: '<img src="static.png">{{Front}}', answerFormat: '{{FrontSide}}<audio src="tone.wav"></audio>{{Back}}' },
    ],
    css: '.card { background-image: url("static.png"); }',
  })
  const deck = new Deck({ id: 1_700_000_000_031, name: 'Template assets' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'template-media-guid', fields: ['猫', 'cat'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('static.png', png)
  pkg.addMedia('tone.wav', wav)
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'template-media.apkg', { type: 'application/octet-stream' })
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

async function fieldHtmlPackage(unsafe = true, layoutOverride?: string) {
  const type = new Notetype({
    id: 1_700_000_000_060,
    name: 'Layout field fixture',
    fields: [{ name: 'Front' }, { name: 'Layout' }],
    templates: [{ name: 'Card', questionFormat: '{{Front}}<hr>{{Layout}}', answerFormat: '{{FrontSide}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_061, name: 'HTML Fixture' })
  const layout = layoutOverride ?? (unsafe
    ? '<table onclick="run()"><tr><td style="width:50%;background-image:url(https://invalid.test/x)">猫</td><td><script>alert(1)</script><img src=x onerror="run()"><b>ねこ</b></td></tr></table>'
    : '<table><tr><td style="width:50%">猫</td><td><b>ねこ</b></td></tr></table>')
  deck.addNote(new AnkiNote({ notetype: type, guid: 'field-html-guid', fields: ['plain text', layout] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  return new File([(await pkg.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'field-html.apkg', { type: 'application/octet-stream' })
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
  test('restores a deleted package deck after reopening and re-imports it idempotently', async () => {
    const name = `kiroku-delete-reimport-${crypto.randomUUID()}`
    collection = createCollection(name)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const before = await readAnkiExportSnapshot(collection)
    const deck = before.decks.find((candidate) => before.notes.some((note) => note.deckId === candidate.id))!
    await collection.deleteDeck(deck.id, { mode: 'delete' })
    collection.close()
    collection = createCollection(name)
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const restored = await readAnkiExportSnapshot(collection)
    expect(restored.notes.map((note) => note.id).sort()).toEqual(before.notes.map((note) => note.id).sort())
    expect(restored.cards.map((card) => card.id).sort()).toEqual(before.cards.map((card) => card.id).sort())
    expect(restored.references.map((reference) => reference.id).sort()).toEqual(before.references.map((reference) => reference.id).sort())
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    expect((await readAnkiExportSnapshot(collection)).notes).toHaveLength(before.notes.length)
  })

  test('takes the redistributable synthetic compatibility corpus through import, render/study, export, and clean re-import', async () => {
    collection = createCollection(`kiroku-compatibility-corpus-${crypto.randomUUID()}`)
    for (const file of [await japanesePackage(), await imageOcclusionPackage()]) {
      const prepared = await prepareAnkiImport(file, collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })
      expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      await prepared.commit()
    }

    const notes = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes)
    const noteTypes = new Map((await readAnkiExportSnapshot(collection).then(snapshot => snapshot.types)).map((type) => [type.id, type]))
    for (const note of notes) {
      const type = noteTypes.get(note.typeId)!
      if (type.kind === 'image-occlusion') {
        expect(note.imageOcclusion?.masks.length).toBeGreaterThan(0)
        continue
      }
      for (const template of type.templates) {
        const card = (await readCardsForNote(collection, note.id)).find((candidate) => candidate.templateId === template.id)
        if (!card) continue
        const rendered = renderNoteCard(type, template, note.fields, card.clozeOrdinal)
        expect(rendered.error).toBeUndefined()
        expect(rendered.backError).toBeUndefined()
        if (template.front.includes('{{type:Meaning}}')) expect(rendered.typedAnswer).toBe('cat')
        if (template.front.includes('{{furigana:Reading}}')) expect(rendered.front?.html).toContain('<ruby>猫<rt>ねこ</rt></ruby>')
        if (template.name === 'Recognition') expect(rendered.css).toContain('rgb(30, 40, 50)')
      }
    }

    const sourceCards = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)
    for (const note of notes) {
      const card = sourceCards.find((candidate) => candidate.noteId === note.id)
      if (card) await collection.answer(card.id, Rating.Good, new Date('2026-10-01T12:30:00.000Z'), 500, { allowEarly: true, reschedule: true })
    }

    const expectedDigests = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs)).map((entry) => entry.digest).sort()
    const expectedReviewCount = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.length)
    const expectedCardCount = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)
    const exported = await exportAnkiPackage(collection, { scheduling: true, history: true, media: true, SQL })
    const clean = createCollection(`kiroku-compatibility-reimport-${crypto.randomUUID()}`)
    syncReplica = clean
    const roundtrip = await prepareAnkiImport(new File([exported.bytes.slice().buffer], 'synthetic-compatibility.apkg'), clean, { SQL })
    expect(roundtrip.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    await roundtrip.commit()

    const cleanSnapshot = await readAnkiExportSnapshot(clean)
    expect(cleanSnapshot.notes).toHaveLength(notes.length)
    expect(cleanSnapshot.cards).toHaveLength(expectedCardCount)
    expect(cleanSnapshot.reviews).toHaveLength(expectedReviewCount)
    expect(cleanSnapshot.types.filter((type) => !type.protected).map((type) => type.templates.length).sort()).toEqual([1, 2])
    expect(cleanSnapshot.blobs.map((entry) => entry.digest).sort()).toEqual(expectedDigests)
    const restoredNotes = cleanSnapshot.notes
    expect(restoredNotes.find((note) => note.id === 'anki-note:stable-occlusion-guid')?.imageOcclusion?.masks).toHaveLength(2)
    expect((await Promise.all(restoredNotes.map((note) => clean.mediaForNote(note.id)))).flat()).toHaveLength(3)
  })

  test.skipIf(!process.env.KIROKU_ANKI_COMPAT_PACKAGE)('Anki 26.09.3 official export imports, renders, studies, exports, and reimports with media semantics intact', async () => {
    const packagePath = process.env.KIROKU_ANKI_COMPAT_PACKAGE!
    const manifest = JSON.parse(await readFile(packagePath.replace(/\.colpkg$/i, '.json'), 'utf8')) as {
      format: string; ankiRelease: string; ankiSourceCommit: string; contentLicense: string;
      sourceDeck: string; filteredDeck: { name: string; cardCount: number; originDeck: string }
      notes: { front: string; back: string }[]; media: { name: string; sha256: string; byteLength: number; mimeType: string }[]
    }
    expect(manifest).toMatchObject({ format: 'colpkg', ankiRelease: '26.09.3', ankiSourceCommit: '29bb700' })
    expect(manifest.contentLicense).toContain('CC0-1.0')
    expect(manifest.filteredDeck).toMatchObject({ name: 'Kiroku Corpus::Filtered Practice', originDeck: 'Kiroku Corpus::Source' })
    expect(manifest.filteredDeck.cardCount).toBe(4)
    expect(manifest.sourceDeck).toBe('Kiroku Corpus::Source')
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const sourceBytes = await readFile(packagePath)
    const prepared = await prepareAnkiImport(new File([sourceBytes], 'anki-26.09.3.colpkg'), collection, { SQL })
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(prepared.summary).toMatchObject({ notes: 2, cards: 4, media: 1 })
    await prepared.commit()

    const sourceNotes = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes)
    const sourceTypes = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.types)
    const sourceType = sourceTypes.find((type) => type.name.includes('Kiroku corpus reverse card'))!
    const catNote = sourceNotes.find((note) => Object.values(note.fields).includes('猫'))!
    const sourceMedia = await collection.mediaForNote(catNote.id)
    expect(sourceMedia).toHaveLength(1)
    const allMediaReferences = (await Promise.all(sourceNotes.map((note) => collection!.mediaForNote(note.id)))).flat()
    expect(allMediaReferences).toHaveLength(2)
    const blob = (await readAnkiExportSnapshot(collection)).blobs.find((entry) => entry.digest === sourceMedia[0].digest)
    expect(blob).toBeDefined()
    expect(await digestMedia(blob!.blob)).toBe(manifest.media[0].sha256)
    expect(blob!.byteLength).toBe(manifest.media[0].byteLength)

    const fields = Object.fromEntries(sourceType.fields.map((field) => [field.name, catNote.fields[field.id] ?? '']))
    const rendered = renderNoteCard(sourceType, sourceType.templates[0], catNote.fields, undefined, {
      'generated-tone.wav': { kind: 'audio', url: 'blob:compatibility-tone', automatic: true },
    }, [{ id: sourceMedia[0].id, kind: 'audio', displayName: 'generated-tone.wav', side: 'front', playback: 'automatic', url: 'blob:compatibility-tone' }])
    expect(fields).toMatchObject({ Front: '猫', Back: 'ねこ' })
    expect(rendered.front?.html).toContain('blob:compatibility-tone')
    expect(rendered.front?.html).toContain('<audio')
    expect(rendered.media).toContainEqual(expect.objectContaining({ kind: 'audio', displayName: 'generated-tone.wav', playback: 'automatic' }))
    const reversed = renderNoteCard(sourceType, sourceType.templates[1], catNote.fields)
    expect(reversed.front?.html).toBe('ねこ')

    const originalDecks = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks)
    const sourceDeck = originalDecks.find((deck) => deck.name === 'Source')!
    expect(sourceDeck.parentId).toBe(originalDecks.find((deck) => deck.name === 'Kiroku Corpus')!.id)
    expect(originalDecks.some((deck) => deck.name === 'Filtered Practice')).toBe(false)
    expect((await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)).every((card) => card.deckId === sourceDeck.id)).toBe(true)
    const sourceCard = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)).find((card) => card.noteId === catNote.id)!
    await collection.answer(sourceCard.id, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    expect(await readCardReviewHistory(collection, sourceCard.id).then(entries => entries.length)).toBe(1)

    const exported = await exportAnkiPackage(collection, { scheduling: true, history: true, media: true, SQL })
    const clean = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    syncReplica = clean
    const roundtrip = await prepareAnkiImport(new File([exported.bytes.slice().buffer], 'roundtrip.apkg'), clean, { SQL })
    expect(roundtrip.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    await roundtrip.commit()
    const cleanSnapshot = await readAnkiExportSnapshot(clean)
    const cleanType = cleanSnapshot.types[0]
    expect(cleanSnapshot.notes.map((note) => cleanType.fields.map((field) => note.fields[field.id] ?? '').slice(0, 2)).sort()).toEqual(manifest.notes.map(({ front, back }) => [front, back]).sort())
    const cleanCards = cleanSnapshot.cards
    expect(cleanCards).toHaveLength(4)
    expect(cleanSnapshot.reviews).toHaveLength(1)
    const cleanDecks = cleanSnapshot.decks
    const cleanSourceDeck = cleanDecks.find((deck) => deck.name === 'Source')!
    expect(cleanCards.every((card) => card.deckId === cleanSourceDeck.id)).toBe(true)
    expect(cleanDecks.some((deck) => deck.name === 'Filtered Practice')).toBe(false)
    expect((await Promise.all(cleanSnapshot.notes.map((note) => clean.mediaForNote(note.id)))).flat()).toHaveLength(2)
    expect(cleanSnapshot.blobs).toHaveLength(1)
    const roundtripDigests = await Promise.all(cleanSnapshot.blobs.map((entry) => digestMedia(entry.blob)))
    expect(roundtripDigests).toEqual([manifest.media[0].sha256])
  })

  test('accepts MPEG audio frames with common trailing metadata and padding', () => {
    const frames = new Uint8Array(365 * 2)
    for (let offset = 0; offset < frames.length; offset += 365) frames.set([0xff, 0xfb, 0x80, 0x64], offset)
    const tagPlus = new Uint8Array(227)
    tagPlus.set([0x54, 0x41, 0x47, 0x2b])
    const id3v1 = new Uint8Array(128)
    id3v1.set([0x54, 0x41, 0x47])
    const apev2 = new Uint8Array(32)
    apev2.set([0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58])
    new DataView(apev2.buffer).setUint32(12, 32, true)
    const withId3 = new Uint8Array(frames.length + tagPlus.length + id3v1.length)
    withId3.set(frames)
    withId3.set(tagPlus, frames.length)
    withId3.set(id3v1, frames.length + tagPlus.length)
    const withApe = new Uint8Array(frames.length + apev2.length)
    withApe.set(frames)
    withApe.set(apev2, frames.length)
    const id3v2Header = [0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 13]
    const id3v2Frame = [0x54, 0x49, 0x54, 0x32, 0, 0, 0, 3, 0, 0, 0, 0x78, 0x79]
    const id3v2Footer = [0x33, 0x44, 0x49, 4, 0, 0x10, 0, 0, 0, 13]
    const withAppendedId3v2 = new Uint8Array(frames.length + id3v2Header.length + id3v2Frame.length + id3v2Footer.length)
    withAppendedId3v2.set(frames)
    withAppendedId3v2.set([...id3v2Header, ...id3v2Frame, ...id3v2Footer], frames.length)
    const padded = new Uint8Array(frames.length + 8)
    padded.set(frames)
    const corruptTail = new Uint8Array(frames.length + 32)
    corruptTail.set(frames)
    corruptTail[frames.length + 12] = 0xff
    const prefixed = new Uint8Array(frames.length + 4)
    prefixed.set([1, 2, 3, 4])
    prefixed.set(frames, 4)

    expect(() => validateMediaBytes(withId3, 'audio/mpeg')).not.toThrow()
    expect(() => validateMediaBytes(withApe, 'audio/mpeg')).not.toThrow()
    expect(() => validateMediaBytes(withAppendedId3v2, 'audio/mpeg')).not.toThrow()
    expect(() => validateMediaBytes(padded, 'audio/mpeg')).not.toThrow()
    expect(() => validateMediaBytes(corruptTail, 'audio/mpeg')).toThrow(/do not match/i)
    expect(() => validateMediaBytes(prefixed, 'audio/mpeg')).toThrow(/do not match/i)
    expect(() => validateMediaBytes(id3v1, 'audio/mpeg')).toThrow(/do not match/i)
  })

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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const bytes of fixtures) {
      const file = new File([bytes.slice().buffer], `hostile.${extension}`)
      await expect(prepareAnkiImport(file, collection, { SQL })).rejects.toThrow(/Unable to read/i)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks.length)).toBe(0)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).toBe(0)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)).toBe(0)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.length)).toBe(0)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.references.length)).toBe(0)
      expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).toBe(0)
      expect(await collection.pendingOperations()).toHaveLength(0)
    }
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
  test('previews and transactionally imports templates, scheduling, history, tags, and media from a modern package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await japanesePackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.summary).toMatchObject({ decks: 2, noteTypes: 2, notes: 2, cards: 4, reviews: 2, media: 2 })
    expect(prepared.duplicates).toEqual({ create: 2, update: 0, keepLocal: 0, unchanged: 0 })
    expect(structuredClone(prepared.plan)).toMatchObject({
      blocksImport: false,
      writes: {
        decks: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-deck:1700000000010' }) })]),
        noteTypes: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-note-type:1700000000001' }) })]),
        notes: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-note:stable-vocabulary-guid' }) })]),
        cards: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: expect.any(String) }) })]),
        reviews: expect.arrayContaining([
          expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-review:1725192000000', afterState: State.Learning }) }),
          expect.objectContaining({ action: 'create', value: expect.objectContaining({ id: 'anki-review:1725192060000', afterState: State.Review }) }),
        ]),
        references: expect.arrayContaining([expect.objectContaining({ action: 'create', value: expect.objectContaining({ noteId: 'anki-note:stable-vocabulary-guid' }) })]),
      },
      decisions: expect.arrayContaining([
        { entity: 'note', id: 'anki-note:stable-vocabulary-guid', action: 'create' },
        { entity: 'review', id: 'anki-review:1725192000000', action: 'create' },
        { entity: 'review', id: 'anki-review:1725192060000', action: 'create' },
      ]),
    })
    expect(prepared.plan).not.toHaveProperty('collection')
    expect(prepared.plan.writes.blobs.every((blob) => !('blob' in blob))).toBe(true)
    // Every row commit() writes must appear in the plan, or the learner approves
    // an incomplete description of what the import will do. This asserts the
    // plan's shape directly rather than trusting a hand-maintained list.
    expect(Object.keys(prepared.plan.writes).sort()).toEqual([
      'blobs', 'cards', 'decks', 'deletedDecks', 'deletedReferences',
      'noteTypes', 'notes', 'references', 'reviews', 'undoSettings', 'updatedReviews',
    ])
    // Every planned row carries a matching decision, so nothing is written
    // without having been inspected first.
    const planned = [
      ...prepared.plan.writes.decks, ...prepared.plan.writes.noteTypes,
      ...prepared.plan.writes.notes, ...prepared.plan.writes.cards,
      ...prepared.plan.writes.reviews, ...prepared.plan.writes.updatedReviews,
      ...prepared.plan.writes.references,
    ].map((write) => write.value.id)
    for (const id of planned) expect(prepared.plan.decisions.some((decision) => decision.id === id)).toBe(true)
    for (const id of prepared.plan.writes.deletedDecks.map((deck) => deck.id)) {
      expect(prepared.plan.decisions).toContainEqual({ entity: 'deck', id, action: 'delete' })
    }
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deck-hierarchy', detail: expect.stringContaining('Japanese::Core') }),
      expect.objectContaining({ code: 'scheduling-mapped', detail: expect.stringContaining('FSRS memory state') }),
    ]))

    await prepared.commit()

    const decks = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks)
    expect(decks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Japanese', parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID }),
      expect.objectContaining({ name: 'Core', parentId: expect.any(String), optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID }),
    ]))
    const types = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.types)).filter((type) => !type.protected)
    expect(types).toHaveLength(2)
    expect(types.find((type) => type.name === 'Japanese vocabulary')).toMatchObject({
      kind: 'standard',
      templates: [
        expect.objectContaining({ name: 'Recognition', front: expect.stringContaining('{{furigana:Reading}}'), css: expect.stringContaining('rgb(30, 40, 50)') }),
        expect.objectContaining({ name: 'Production', front: '{{type:Meaning}}' }),
      ],
    })
    const notes = await readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes)
    expect(notes.find((note) => note.id === 'anki-note:stable-vocabulary-guid')).toMatchObject({ tags: ['jlpt::n5', 'animal'] })
    expect(notes.find((note) => note.id === 'anki-note:stable-cloze-guid')?.fields).toEqual(expect.objectContaining({ 'anki-field:1700000000002:0': '{{c1::東京}}へ{{c2::行く}}' }))
    const scheduled = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)).find((card) => card.reps === 5)
    expect(scheduled).toMatchObject({ state: State.Review, stability: 12.5, difficulty: 4.25, scheduledDays: 12, lapses: 1 })
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews)).resolves.toEqual([
      expect.objectContaining({
        id: 'anki-review:1725192000000',
        reviewedAt: '2024-09-01T12:00:00.000Z',
        durationMs: 1200,
        due: '2024-09-01T12:00:00.000Z',
        scheduledDays: 5,
        afterDue: '2024-09-13T12:00:00.000Z',
        afterScheduledDays: 12,
        afterState: State.Learning,
        elapsedDays: 0,
      }),
      expect.objectContaining({ id: 'anki-review:1725192060000', afterState: State.Review, lastElapsedDays: 0 }),
    ])
    const media = await collection.mediaForNote('anki-note:stable-vocabulary-guid')
    expect(media).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'cat.png', kind: 'image', side: 'front' }),
      expect.objectContaining({ displayName: 'cat.wav', kind: 'audio', side: 'front', playback: 'automatic' }),
    ]))
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(2)
    const pending = await collection.pendingOperations()
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'noteType', action: 'create' }),
      expect.objectContaining({ entityType: 'review', action: 'create' }),
      expect.objectContaining({ entityType: 'noteMedia', action: 'create' }),
    ]))
    for (const operation of pending) {
      expect(await readSyncRevision(collection, operation.opId)).toMatchObject({ ...operation, key: `${operation.entityType}:${operation.entityId}` })
    }
  })

  test('imports local template media for front and answer with digest deduplication', async () => {
    collection = createCollection(`kiroku-template-media-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await templateMediaPackage(), collection, { SQL })
    expect(prepared.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(prepared.summary.media).toBe(2)
    await prepared.commit()

    const note = await readNote(collection, 'anki-note:template-media-guid')
    const type = await readNoteType(collection, note!.typeId)
    const references = await collection.mediaForNote(note!.id)
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'static.png', side: 'front', inline: true }),
      expect.objectContaining({ displayName: 'static.png', side: 'back', inline: true }),
      expect.objectContaining({ displayName: 'tone.wav', side: 'back', kind: 'audio', inline: true, playback: 'automatic' }),
    ]))
    expect(await readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).toBe(2)
    const sources = await prepareReviewMedia(references, new AbortController().signal, (digest) => collection!.verifiedMediaBytes(digest))
    expect(sources.byName).toHaveProperty('static.png')
    const rendered = renderNoteCard(type!, type!.templates[0], note!.fields, undefined, sources.byName)
    expect(rendered.front?.html).toContain('src="data:image/png;base64,')
    expect(rendered.back?.html).toContain('src="data:audio/wav;base64,')
    expect(rendered.css).toContain('background-image: url("data:image/png;base64,')
  })

  test('previews a large collection history without changing per-row semantics', async () => {
    collection = createCollection(`kiroku-import-scale-${crypto.randomUUID()}`)
    const packageData = AnkiCollection.open(await fileBytes(await japanesePackage()), SQL).data
    const seed = packageData.notes.find((note) => note.guid === 'stable-vocabulary-guid')
    if (!seed) throw new Error('scale fixture note missing')
    const seedCards = packageData.cards.filter((card) => card.nid === seed.id)
    const count = 3_000
    const notes = Array.from({ length: count }, (_, index) => ({ ...seed, id: 1_000_000_000 + index, guid: `scale-guid-${index}` }))
    const cards = notes.flatMap((note, index) => seedCards.map((card, ordinal) => ({ ...card, id: 2_000_000_000 + index * seedCards.length + ordinal, nid: note.id })))
    const revlog = notes.map((_, index) => ({
      id: 1_800_000_000_000 + index * 60_000,
      cid: cards[index * seedCards.length].id,
      usn: -1,
      ease: 3,
      ivl: 12,
      lastIvl: 5,
      factor: 425,
      time: 800,
      type: 1,
    }))
    const preview = await prepareAnkiDataImport({ ...packageData, notes, cards, revlog }, collection, { now: new Date('2026-10-01T12:00:00.000Z') })

    expect(preview.summary).toMatchObject({ notes: count, cards: count * seedCards.length, reviews: count })
    expect(preview.plan.blocksImport).toBe(false)
  }, 20_000)

  test('keeps a newer local edit when the same stable Anki note is imported again', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })).commit()
    const note = await readNote(collection, 'anki-note:stable-vocabulary-guid')
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
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { 'anki-field:1700000000001:2': 'feline' } })
    await expect(collection.mediaForNote(note.id)).resolves.toEqual(existingMedia)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.length)).resolves.toBe(2)
  })

  test('plans suspension only for local cards absent from the package and keeps present local card state', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const noteId = 'anki-note:stable-vocabulary-guid'
    const localCards = await readCardsForNote(collection, noteId)
    const missingCard = localCards.find((card) => card.templateId === 'anki-template:1700000000001:1')
    const presentCard = localCards.find((card) => card.templateId === 'anki-template:1700000000001:0')
    if (!missingCard || !presentCard) throw new Error('Expected both generated vocabulary cards')
    await collection.suspendCard(missingCard.id)
    await collection.suspendCard(presentCard.id)

    const source = AnkiCollection.open(await fileBytes(file), SQL)
    const sourceNote = source.data.notes.find((candidate) => candidate.guid === 'stable-vocabulary-guid')
    if (!sourceNote) throw new Error('Fixture note missing')
    source.data.cards = source.data.cards.filter((card) => card.nid !== sourceNote.id || card.ord !== 1)
    const reduced = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'reduced-cards.apkg')
    const plan = await prepareAnkiImport(reduced, collection, { SQL })

    expect(plan.plan.writes.cards).toContainEqual(expect.objectContaining({
      action: 'update',
      value: expect.objectContaining({ id: missingCard.id, suspended: true, templateSuspended: true, manualSuspended: true }),
    }))
    expect(plan.plan.decisions).toContainEqual({ entity: 'card', id: missingCard.id, action: 'update' })
    expect(plan.plan.decisions).toContainEqual({ entity: 'card', id: presentCard.id, action: 'keepLocal' })
    expect(plan.plan.writes.cards).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ id: presentCard.id }) }))

    syncReplica = createCollection(`kiroku-import-replica-${crypto.randomUUID()}`)
    await (await prepareAnkiImport(file, syncReplica, { SQL })).commit()
    await plan.commit()
    await expect(readCard(collection, missingCard.id)).resolves.toMatchObject({ suspended: true, templateSuspended: true, manualSuspended: true })
    const reconciliationOperation = (await collection.pendingOperations()).find((operation) => operation.entityType === 'card' && operation.entityId === missingCard.id && operation.action === 'update')
    if (!reconciliationOperation) throw new Error('Expected the committed card reconciliation operation in the outbox')
    await syncReplica.applyRemoteChanges([reconciliationOperation], 1)
    await expect(readReceivedOperation(syncReplica, reconciliationOperation.opId)).resolves.toBeDefined()
    await collection.unsuspendCard(missingCard.id)
    await expect(collection.dueCards(missingCard.deckId, new Date('2026-10-02T12:00:00.000Z'))).resolves.not.toContainEqual(expect.objectContaining({ id: missingCard.id }))
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

  test('blocks a package card whose referenced deck has no row', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const source = AnkiCollection.open(await fileBytes(await japanesePackage()), SQL)
    const data = structuredClone(source.data)
    const sourceNote = data.notes.find((candidate) => candidate.guid === 'stable-vocabulary-guid')
    const orphanedCard = data.cards.find((card) => card.nid === sourceNote?.id && card.ord === 1)
    if (!sourceNote || !orphanedCard) throw new Error('Expected the second vocabulary card')
    orphanedCard.did = 1_700_000_000_999

    const plan = await prepareAnkiDataImport(data, collection)

    expect(plan.plan.blocksImport).toBe(true)
    expect(plan.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'card-deck-missing',
      subject: String(orphanedCard.id),
      detail: expect.stringContaining('1700000000999'),
    }))
    expect(plan.plan.writes.cards).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ ankiId: orphanedCard.id }) }))
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
    const importedCard = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)).find((card) => card.reps === 5)
    expect(importedCard).toMatchObject({ stability: 20, difficulty: 3, scheduledDays: 20, sourceModifiedAt: new Date(sourceCard.mod * 1000).toISOString() })

    await collection.answer(importedCard!.id, 3, new Date('2030-01-01T12:00:00.000Z'))
    const afterLocalReview = await readCard(collection, importedCard!.id)
    sourceCard.mod = 1_830_000_000
    sourceCard.due = 60
    const staleSchedule = new File([(await source.toUint8Array(SQL)).slice().buffer as ArrayBuffer], 'stale-schedule.apkg')
    await (await prepareAnkiImport(staleSchedule, collection, { SQL, now: new Date('2030-01-02T12:00:00.000Z') })).commit()
    await expect(readCard(collection, importedCard!.id)).resolves.toEqual(afterLocalReview)
  })

  test('keeps a note aggregate intact when its locally newer note type wins', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const file = await japanesePackage()
    await (await prepareAnkiImport(file, collection, { SQL })).commit()
    const noteId = 'anki-note:stable-vocabulary-guid'
    const typeId = 'anki-note-type:1700000000001'
    const localType = await readNoteType(collection, typeId)
    const localNote = await readNote(collection, noteId)
    if (!localType || !localNote) throw new Error('imported fixture missing')
    await collection.updateNoteType(typeId, { name: 'Locally customized' }, new Date('2030-01-01T00:00:00.000Z'))
    const beforeCards = await readCardsForNote(collection, noteId)
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
    await expect(readNote(collection, noteId)).resolves.toEqual(localNote)
    await expect(readCardsForNote(collection, noteId)).resolves.toEqual(beforeCards)
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
    const imported = (await readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards)).find((card) => card.reps === 5)
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

    const note = await readNote(collection, 'anki-note:stable-occlusion-guid')
    expect(note).toMatchObject({
      typeId: 'image-occlusion',
      fields: { header: 'Skull bones', backExtra: 'Name the hidden bone.\nImported fixture' },
      imageOcclusion: { imageWidth: 1, imageHeight: 1, masks: [
        expect.objectContaining({ ordinal: 1, x: .1, y: .2, width: .3, height: .2 }),
        expect.objectContaining({ ordinal: 2, x: .6, y: .5, width: .2, height: .3 }),
      ] },
    })
    await expect(readCardsForNote(collection, note!.id).then(cards => cards.length)).resolves.toBe(2)
    await expect(collection.mediaForNote(note!.id)).resolves.toEqual([expect.objectContaining({ displayName: 'diagram.png', kind: 'image' })])
  })

  test('rejects a stale preview without partially writing the package', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await japanesePackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })
    await collection.createDeck('Concurrent deck', new Date('2026-10-01T12:00:00.000Z'))

    await expect(prepared.commit()).rejects.toThrow(/preview again/i)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks.length)).resolves.toBe(1)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(0)
  })

  test('reports unsupported template features instead of silently dropping them', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await unsupportedPackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Unsupported custom filters', detail: expect.stringMatching(/unsupported template filter/i) }),
      expect.objectContaining({ severity: 'error', code: 'note-skipped', subject: 'unsupported-guid' }),
    ]))
    await expect(prepared.commit()).rejects.toThrow(/resolve package errors/i)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(0)
  })

  test('explicit partial choice imports supported note aggregates, records omissions, and keeps them excluded on refresh', async () => {
    collection = createCollection(`kiroku-import-partial-${crypto.randomUUID()}`)
    const sourceIdentity = 'test-account-source-opaque-id'
    const supported = AnkiCollection.open(await fileBytes(await japanesePackage()), SQL).data
    const unsupported = AnkiCollection.open(await fileBytes(await unsupportedPackage()), SQL).data
    const mixed = {
      ...supported,
      notetypes: [...supported.notetypes, ...unsupported.notetypes],
      fields: [...supported.fields, ...unsupported.fields],
      templates: [...supported.templates, ...unsupported.templates],
      decks: [...supported.decks, ...unsupported.decks],
      notes: [...supported.notes, ...unsupported.notes],
      cards: [...supported.cards, ...unsupported.cards],
      revlog: [...supported.revlog, ...unsupported.revlog],
      media: [...supported.media, ...unsupported.media],
    }

    const prepared = await prepareAnkiDataImport(mixed, collection, { SQL, sourceIdentity, sourceFingerprint: 'revision-hash-1' })
    expect(prepared.plan.blocksImport).toBe(true)
    expect(prepared.plan.canImportRepresentable).toBe(true)
    expect(prepared.plan.skipped).toEqual([expect.objectContaining({
      guid: 'unsupported-guid',
      noteType: 'Unsupported custom filters',
      cardIds: [expect.any(Number)],
      reviewIds: [],
      reasons: expect.arrayContaining([expect.stringContaining('Unsupported template filter')]),
    })])
    expect(prepared.plan.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'note', id: 'anki-note:unsupported-guid', action: 'skip' }),
      expect.objectContaining({ entity: 'card', id: expect.stringMatching(/^anki-card:/), action: 'skip' }),
    ]))
    await expect(prepared.commit()).rejects.toThrow(/explicitly choosing/i)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(0)
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)

    await prepared.commit({ importRepresentableOnly: true })
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(2)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)).resolves.toBe(4)
    await expect(readNote(collection, 'anki-note:unsupported-guid')).resolves.toBeUndefined()
    const receiptKey = `ankiPartialImport:${sourceIdentity}`
    await expect(readCollectionSetting(collection, receiptKey)).resolves.toMatchObject({
      key: receiptKey,
      value: { version: 1, sourceIdentity, sourceFingerprint: 'revision-hash-1', excludedNoteGuids: ['unsupported-guid'] },
    })

    const newlySupported = new Notetype({
      id: 1_700_000_000_030,
      name: 'Unsupported custom filters',
      fields: [{ name: 'Front' }, { name: 'Back' }],
      templates: [{ name: 'Custom filter card', questionFormat: '{{Front}}', answerFormat: '{{Back}}' }],
    })
    const supportedReplacementDeck = new Deck({ id: 1_700_000_000_031, name: 'Unsupported' })
    supportedReplacementDeck.addNote(new AnkiNote({ notetype: newlySupported, guid: 'unsupported-guid', fields: ['question', 'answer'] }))
    const replacementPackage = new Package()
    replacementPackage.addDeck(supportedReplacementDeck)
    const replacement = AnkiCollection.open(await replacementPackage.toUint8Array(SQL), SQL).data
    const refreshed = {
      ...supported,
      notetypes: [...supported.notetypes, ...replacement.notetypes],
      fields: [...supported.fields, ...replacement.fields],
      templates: [...supported.templates, ...replacement.templates],
      decks: [...supported.decks, ...replacement.decks],
      notes: [...supported.notes, ...replacement.notes],
      cards: [...supported.cards, ...replacement.cards],
      revlog: supported.revlog,
      media: supported.media,
    }
    const refreshPlan = await prepareAnkiDataImport(refreshed, collection, { SQL, sourceIdentity, sourceFingerprint: 'revision-hash-2' })
    expect(refreshPlan.plan.blocksImport).toBe(false)
    expect(refreshPlan.plan.savedPartialChoice).toBe(true)
    expect(refreshPlan.plan.skipped).toContainEqual(expect.objectContaining({ guid: 'unsupported-guid' }))
    await refreshPlan.commit()
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(2)
    await expect(readNote(collection, 'anki-note:unsupported-guid')).resolves.toBeUndefined()
    await expect(readCollectionSetting(collection, receiptKey)).resolves.toMatchObject({ value: { sourceFingerprint: 'revision-hash-2', excludedNoteGuids: ['unsupported-guid'] } })
  })

  test('ignores unsupported note types that are unused by the account snapshot', async () => {
    collection = createCollection(`kiroku-import-unused-note-type-${crypto.randomUUID()}`)
    const supportedBytes = await japanesePackage()
    const unusedBytes = await unsupportedPackage()
    const supported = AnkiCollection.open(await fileBytes(supportedBytes), SQL).data
    const unused = AnkiCollection.open(await fileBytes(unusedBytes), SQL).data
    supported.notetypes.push(...unused.notetypes)
    supported.fields.push(...unused.fields)
    supported.templates.push(...unused.templates)

    const prepared = await prepareAnkiDataImport(supported, collection, { SQL })

    expect(prepared.plan.blocksImport).toBe(false)
    expect(prepared.issues).not.toContainEqual(expect.objectContaining({ code: 'unsupported-note-type', subject: 'Unsupported custom filters' }))
    expect(prepared.summary.notes).toBe(2)
    await prepared.commit()
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(2)
  })

  test('preserves safe field layout HTML and reports preserved markup in import findings', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await fieldHtmlPackage(), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })
    const note = prepared.plan.writes.notes.map((write) => write.value).find((entry) => entry.ankiId !== undefined)!
    const type = prepared.plan.writes.noteTypes.map((write) => write.value).find((entry) => entry.name === 'Layout field fixture')!
    const rendered = tryRenderNoteTemplate(type.templates[0].front, type, note.fields, undefined, undefined, undefined, note.renderedHtmlFields)
    if (!rendered.ok) throw new Error(rendered.error)

    expect(note.fields[type.fields[0].id]).toBe('plain text')
    expect(note.fields[type.fields[1].id]).toContain('<table>')
    expect(rendered.value.html).toContain('<table><tbody><tr><td style="width: 50%">猫</td><td>&lt;script&gt;alert(1)&lt;/script&gt;<b>ねこ</b></td></tr></tbody></table>')
    expect(rendered.value.html).toContain('plain text')
    expect(prepared.issues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'field-html-sanitized', subject: expect.stringContaining('Layout') }))
  })

  test('labels fully supported field markup as preserved in the import report', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await fieldHtmlPackage(false), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.issues).toContainEqual(expect.objectContaining({
      severity: 'info', code: 'field-html-preserved', subject: expect.stringContaining('Layout'),
      detail: expect.stringMatching(/preserved/i),
    }))
  })

  test('reports HTML-like constructs outside the supported element list', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const prepared = await prepareAnkiImport(await fieldHtmlPackage(false, '<blink>special text</blink>'), collection, { SQL, now: new Date('2026-10-01T12:00:00.000Z') })

    expect(prepared.issues).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'field-html-sanitized', subject: expect.stringContaining('Layout'), detail: expect.stringContaining('<blink>'),
    }))
  })

  test('blocks executable templates and malformed media from creating partial note aggregates', async () => {
    collection = createCollection(`kiroku-import-${crypto.randomUUID()}`)
    const executable = await prepareAnkiImport(await executableTemplatePackage(), collection, { SQL })
    expect(executable.plan.blocksImport).toBe(true)
    expect(executable.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unsupported-note-type', subject: 'Executable template', detail: expect.stringMatching(/executable/i) })]))
    await expect(executable.commit()).rejects.toThrow(/resolve package errors/i)
    const malformed = await prepareAnkiImport(await malformedMediaPackage(), collection, { SQL })
    expect(malformed.plan.blocksImport).toBe(true)
    expect(malformed.plan.canImportRepresentable).toBe(false)
    expect(malformed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'media-malformed', subject: 'broken.png' })]))
    await expect(malformed.commit({ importRepresentableOnly: true })).rejects.toThrow(/cannot be isolated safely/i)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(0)
  })

})
