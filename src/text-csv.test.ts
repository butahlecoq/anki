import { afterEach, expect, test } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection, Rating, type Collection } from './collection'
import { applyTextImport, decodeText, defaultMapping, exportTextCollection, parseDelimited, pathsForDecks, plainText, previewTextImport, readTextDocument, serializeDelimited, type ImportOptions } from './text-csv'

const databases: Collection[] = []
async function database() { const db = createCollection(`text-test-${crypto.randomUUID()}`); databases.push(db); await db.open(); return db }
afterEach(async () => { for (const db of databases.splice(0)) await db.delete() })
const documentFrom = (rows: string[][]) => readTextDocument(new TextEncoder().encode(serializeDelimited(rows)), 'auto', 'auto', '"')
const options = (deckId: string, overrides: Partial<ImportOptions> = {}): ImportOptions => ({ mapping: ['field:front', 'field:back'], header: true, deckId, typeId: BASIC_NOTE_TYPE_ID, html: 'keep', duplicates: 'ignore', newRows: 'add', createDecks: false, replaceTags: true, ...overrides })

test('quoted Japanese commas, escaped quotes and multiline fields preserve logical rows and source lines', () => {
  const rows = parseDelimited('front,back\r\n"猫,ねこ","cat\n""feline"""\r\n犬,dog\r\n', ',', '"')
  expect(rows).toEqual([{ line: 1, values: ['front', 'back'], error: undefined }, { line: 2, values: ['猫,ねこ', 'cat\n"feline"'], error: undefined }, { line: 4, values: ['犬', 'dog'], error: undefined }])
  expect(parseDelimited('front;back\n\'猫;ねこ\';cat', ';', "'")[1].values).toEqual(['猫;ねこ', 'cat'])
  expect(readTextDocument(new TextEncoder().encode('front\tback\n猫\tcat'), 'auto', 'auto', '"').delimiter).toBe('\t')
})

test('encoding choices preserve Japanese and reject silent replacement characters', () => {
  expect(decodeText(Uint8Array.from([0x94, 0x4c]), 'shift_jis').text).toBe('猫')
  expect(() => decodeText(Uint8Array.from([0x94, 0x4c]), 'auto')).toThrow('Choose the correct encoding')
  expect(decodeText(Uint8Array.from([255, 254, 0x2b, 0x73]), 'auto')).toEqual({ text: '猫', encoding: 'utf-16le' })
  expect(decodeText(new TextEncoder().encode('\ufeff猫'), 'auto').text).toBe('猫')
})

test('invalid quoting is attached to the affected row and bounded fields cannot allocate indefinitely', () => {
  const rows = parseDelimited('front,back\nbad"quote,x\n猫,cat', ',', '"')
  expect(rows[1].error).toContain('Unexpected quote')
  expect(rows[2].values).toEqual(['猫', 'cat'])
  expect(parseDelimited('front,back\n"unclosed', ',', '"')[1].error).toContain('not closed')
  const oversized = parseDelimited(`"${'a'.repeat(1024 * 1024 + 1)}"\n猫`, ',', '"')
  expect(oversized[0].error).toContain('field is too large')
  expect(oversized[0].values[0]).toHaveLength(1024 * 1024)
  expect(oversized[1].values).toEqual(['猫'])
  expect(parseDelimited('field\n""', ',', '"')[1].values).toEqual([''])
})

test('HTML conversion removes executable markup without losing Japanese text, entities or line breaks', () => {
  expect(plainText('<b>猫</b>&amp;犬<br>ねこ<script>evil()</script><style>body{}</style>')).toBe('猫&犬\nねこ')
})

test('partial import is explicit and valid rows create synced notes/cards while invalid rows remain actionable', async () => {
  const db = await database(), deck = await db.createDeck('日本語')
  const preview = await previewTextImport(db, documentFrom([['front', 'back'], ['猫', 'cat'], ['', 'missing prompt'], ['犬', 'dog']]), options(deck.id))
  expect(preview.rows.map((row) => row.action)).toEqual(['add', 'error', 'add'])
  expect(preview.rows[1].line).toBe(3)
  await expect(applyTextImport(db, preview, false)).rejects.toThrow('partial import')
  expect(await db.notes.count()).toBe(0)
  expect(await applyTextImport(db, preview, true)).toEqual({ added: 2, updated: 0, ignored: 0, errors: 1 })
  expect((await db.notes.toArray()).map((note) => note.fields.front).sort()).toEqual(['犬', '猫'])
  expect(await db.cards.count()).toBe(2)
  expect((await db.outbox.toArray()).filter((operation) => operation.entityType === 'note')).toHaveLength(2)
})

test('stable-ID updates preserve cards and review history; changed previews cannot overwrite later edits', async () => {
  const db = await database(), deck = await db.createDeck('日本語'), note = await db.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const card = (await db.cards.toArray())[0]
  await db.answer(card.id, Rating.Good, new Date('2026-10-02T01:00:00Z'))
  const scheduled = await db.cards.get(card.id), reviews = await db.reviewEntries.toArray()
  const csv = documentFrom([['_note_id', 'front', 'back', '_tags'], [note.id, '猫', 'feline · ねこ', '["日本語","very common"]']])
  const settings = options(deck.id, { mapping: ['identifier', 'field:front', 'field:back', 'tags'], duplicates: 'update' })
  const preview = await previewTextImport(db, csv, settings)
  expect(preview.rows[0].action).toBe('update')
  await applyTextImport(db, preview, false)
  expect((await db.notes.get(note.id))?.tags).toEqual(['日本語', 'very common'])
  expect(await db.cards.get(card.id)).toEqual(scheduled)
  expect(await db.reviewEntries.toArray()).toEqual(reviews)
  const stale = await previewTextImport(db, csv, settings)
  await db.updateNote(note.id, { front: '猫', back: 'a later edit' })
  await expect(applyTextImport(db, stale, false)).rejects.toThrow('Collection changed')
  expect((await db.notes.get(note.id))?.fields.back).toBe('a later edit')
})

test('default duplicate ignore, intentional duplicates and repeated conflicting input IDs have distinct previews', async () => {
  const db = await database(), deck = await db.createDeck('日本語')
  await db.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const csv = documentFrom([['front', 'back'], ['猫', 'cat']])
  expect((await previewTextImport(db, csv, options(deck.id))).rows[0].action).toBe('ignore')
  const duplicate = await previewTextImport(db, csv, options(deck.id, { duplicates: 'duplicate' }))
  await applyTextImport(db, duplicate, false)
  expect(await db.notes.count()).toBe(2)
  const conflict = await previewTextImport(db, documentFrom([['id', 'front', 'back'], ['cat', '猫', 'cat'], ['cat', '猫', 'different']]), options(deck.id, { mapping: ['identifier', 'field:front', 'field:back'] }))
  expect(conflict.rows.map((row) => row.action)).toEqual(['add', 'error'])
  expect(conflict.rows[1].message).toContain('different values')
})

test('deleted identifiers cannot resurrect notes and metadata-only updates preserve unmapped fields', async () => {
  const db = await database(), deck = await db.createDeck('日本語'), note = await db.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const metadata = await previewTextImport(db, documentFrom([['_note_id', '_tags'], [note.id, '["ねこ"]']]), options(deck.id, { mapping: ['identifier', 'tags'], duplicates: 'update' }))
  await applyTextImport(db, metadata, false)
  expect((await db.notes.get(note.id))?.fields).toEqual({ front: '猫', back: 'cat' })
  await db.deleteNote(note.id)
  const deleted = await previewTextImport(db, documentFrom([['_note_id', 'front', 'back'], [note.id, '猫', 'cat']]), options(deck.id, { mapping: ['identifier', 'field:front', 'field:back'] }))
  expect(deleted.rows[0].message).toContain('deleted note')
})

test('UTF-8 export re-imports Japanese note IDs, nested decks, quoted newlines and exact tags into a clean collection', async () => {
  const source = await database(), target = await database(), parent = await source.createDeck('日本語'), child = await source.createDeck('語彙', { parentId: parent.id })
  const note = await source.createBasicNote(child.id, { front: '猫,ねこ', back: 'cat\n"feline" · 猫' })
  await source.updateNoteTags(note.id, ['日本語', 'very common'])
  const output = await exportTextCollection(source, { mode: 'notes', fields: ['front', 'back'], tags: true, deck: true, type: true, identifiers: true, html: 'keep', header: true, delimiter: '\t', bom: true })
  const csv = readTextDocument(new TextEncoder().encode(output.text), 'auto', 'auto', '"')
  const type = (await target.noteTypes.get(BASIC_NOTE_TYPE_ID))!
  const preview = await previewTextImport(target, csv, options('', { mapping: defaultMapping(csv, type, true), createDecks: true }))
  await applyTextImport(target, preview, false)
  const restored = await target.notes.get(note.id)
  expect(restored?.fields).toEqual(note.fields)
  expect(restored?.tags).toEqual(['日本語', 'very common'])
  expect(pathsForDecks(await target.decks.toArray()).get(restored!.deckId)).toBe('日本語::語彙')
  expect(await target.cards.count()).toBe(1)
  const again = await previewTextImport(target, csv, options('', { mapping: defaultMapping(csv, type, true), createDecks: true }))
  expect(again.rows[0].action).toBe('ignore')
})

test('card CSV preserves note identity and does not create a duplicate note per template on re-import', async () => {
  const source = await database(), target = await database(), deck = await source.createDeck('両面')
  const definition = { name: 'Two sides', fields: [{ name: 'Word' }, { name: 'Meaning' }], templates: [{ name: 'Recognize', front: '{{Word}}', back: '{{Meaning}}', css: '' }, { name: 'Recall', front: '{{Meaning}}', back: '{{Word}}', css: '' }] }
  const type = await source.createNoteType(definition), targetType = await target.createNoteType(definition)
  const note = await source.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
  const output = await exportTextCollection(source, { mode: 'cards', fields: ['Word', 'Meaning'], tags: true, deck: true, type: true, identifiers: true, html: 'keep', header: true, delimiter: ',', bom: false })
  expect(output.count).toBe(2)
  const csv = documentFrom(parseDelimited(output.text, ',', '"').map((row) => row.values))
  const preview = await previewTextImport(target, csv, options('', { mapping: defaultMapping(csv, targetType, true), typeId: targetType.id, createDecks: true }))
  expect(preview.rows.map((row) => row.action)).toEqual(['add', 'ignore'])
  await applyTextImport(target, preview, false)
  expect(await target.notes.count()).toBe(1)
  expect((await target.notes.get(note.id))?.fields[targetType.fields[0].id]).toBe('猫')
  expect(await target.cards.count()).toBe(2)
})
