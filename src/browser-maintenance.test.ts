import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { createCollection, Rating } from './collection'
import { applyBulkAction, applyFieldChanges, fieldChangePreview, selectionSummary, type FieldOperation } from './browser-maintenance'
import { readAnkiExportSnapshot, readCard, readCardsByIds, readCardsForNote, readNote, readNoteType, readReviewEntry } from './collection-queries'
import { deleteIndexedDbFixtureRow, overwriteIndexedDbLegacyNote } from '../tests/helpers/damage-indexeddb-media'

async function fixture() {
  const db = createCollection(`browser-maintenance-${crypto.randomUUID()}`)
  const deck = await db.createDeck('日本語')
  const type = await db.createNoteType({ name: 'Reversed vocabulary', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', front: '{{Expression}}', back: '{{Meaning}}', css: '' }, { name: 'Production', front: '{{Meaning}}', back: '{{Expression}}', css: '' }] })
  const note = await db.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
  const cards = await readCardsForNote(db, note.id)
  return { db, deck, type, note, cards }
}

test('card-level flags and suspension retain sibling identity; note view affects all generated cards', async () => {
  const { db, note, cards } = await fixture()
  try {
    await expect(selectionSummary(db, { view: 'cards', ids: [cards[0].id] })).resolves.toEqual({ selectedCards: 1, notes: 1, generatedCards: 2 })
    await applyBulkAction(db, { view: 'cards', ids: [cards[0].id] }, { kind: 'flag', flag: 3 })
    expect((await readCard(db, cards[0].id))?.flag).toBe(3)
    expect((await readCard(db, cards[1].id))?.flag ?? 0).toBe(0)
    await applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'suspend', suspended: true })
    expect((await readAnkiExportSnapshot(db)).cards.every((card) => card.manualSuspended)).toBe(true)
    expect(await db.latestCardMaintenanceUndo()).toBeNull()
    await applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'suspend', suspended: false })
    expect((await readAnkiExportSnapshot(db)).cards.every((card) => !card.manualSuspended)).toBe(true)
    expect((await readAnkiExportSnapshot(db)).cards.map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort())
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('bulk and field mutations persist their intended note changes', async () => {
  const { db, note } = await fixture()
  try {
    await applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'tags', mode: 'add', tags: ['reviewed'] })
    const updated = await readNote(db, note.id)
    const type = await readNoteType(db, note.typeId)
    const field = type!.fields[0]!
    await applyFieldChanges(db, [{ noteId: note.id, typeId: type!.id, fieldId: field.id, before: updated!.fields[field.id]!, after: '犬', expectedNote: updated!, expectedType: type! }])
    expect(await readNote(db, note.id)).toMatchObject({ tags: ['reviewed'], fields: { [field.id]: '犬' } })
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('a bulk deletion leaves no undo to press, because one record cannot restore it all', async () => {
  const { db, deck } = await fixture()
  const other = await db.createDeck('Second')
  const notes = [
    await db.createBasicNote(deck.id, { front: '犬', back: 'dog' }),
    await db.createBasicNote(other.id, { front: '鳥', back: 'bird' }),
  ]

  // A single deletion is genuinely reversible, and keeps its undo.
  await applyBulkAction(db, { view: 'notes', ids: [notes[0].id] }, { kind: 'delete' })
  await expect(db.pendingUndo()).resolves.toMatchObject({ kind: 'note-deletion', note: { id: notes[0].id } })
  await expect(db.undo()).resolves.toBe(notes[0].id)

  // Two would leave only the last record, and pressing it would restore one note
  // while the learner believes both came back.
  await applyBulkAction(db, { view: 'notes', ids: notes.map((note) => note.id) }, { kind: 'delete' })
  await expect(db.pendingUndo()).resolves.toBeNull()
  await expect(db.undo()).rejects.toThrow(/nothing to undo/i)
  await expect(Promise.all(notes.map((note) => readNote(db, note.id)))).resolves.toEqual([undefined, undefined])
})

test('bulk card maintenance drops the single-record undo it cannot honour', async () => {
  const { db, cards } = await fixture()
  await db.suspendCard(cards[0].id)
  await expect(db.pendingUndo()).resolves.toMatchObject({ kind: 'card-maintenance' })

  await applyBulkAction(db, { view: 'cards', ids: cards.map((card) => card.id) }, { kind: 'suspend', suspended: true })
  await expect(db.pendingUndo()).resolves.toBeNull()
})

test('note actions deduplicate selected siblings and moving preserves scheduling and review identity', async () => {
  const { db, note, cards } = await fixture()
  try {
    const selection = { view: 'cards' as const, ids: cards.map((card) => card.id) }
    const review = await db.answer(cards[0].id, Rating.Easy)
    const scheduled = await readCard(db, cards[0].id)
    await applyBulkAction(db, selection, { kind: 'tags', mode: 'add', tags: ['animal', 'jlpt::n5', 'animal'] })
    expect((await readNote(db, note.id))?.tags).toEqual(['animal', 'jlpt::n5'])
    await applyBulkAction(db, selection, { kind: 'tags', mode: 'remove', tags: ['animal'] })
    expect((await readNote(db, note.id))?.tags).toEqual(['jlpt::n5'])
    const destination = await db.createDeck('Vocabulary')
    await applyBulkAction(db, selection, { kind: 'move', deckId: destination.id })
    expect(await readCard(db, cards[0].id)).toMatchObject({ ...scheduled, deckId: destination.id })
    expect(await readReviewEntry(db, review.id)).toEqual(review)
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('a failed bulk deletion restores prior deletions, tombstones, and outbox writes', async () => {
  const { db, deck, note, cards } = await fixture()
  try {
    const broken = await db.createBasicNote(deck.id, { front: '犬', back: 'dog' })
    await overwriteIndexedDbLegacyNote(db.databaseName, { ...broken, typeId: 'missing-type' })
    const outbox = await db.pendingOperations()
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id, broken.id] }, { kind: 'delete' })).rejects.toThrow('Note type not found')
    expect(await readNote(db, note.id)).toBeDefined()
    expect(await readCardsByIds(db, cards.map((card) => card.id))).not.toContain(undefined)
    expect(await db.pendingOperations()).toEqual(outbox)
    await deleteIndexedDbFixtureRow(db.databaseName, 'notes', broken.id)
    for (const orphan of await readCardsForNote(db, broken.id)) await deleteIndexedDbFixtureRow(db.databaseName, 'cards', orphan.id)
    const validReplacement = await db.createBasicNote(deck.id, { front: '鳥', back: 'bird' })
    await applyBulkAction(db, { view: 'notes', ids: [note.id, validReplacement.id] }, { kind: 'delete' })
    expect((await readAnkiExportSnapshot(db)).notes).toHaveLength(0)
    expect((await readAnkiExportSnapshot(db)).cards).toHaveLength(0)
    expect(await db.latestNoteDeletionUndo()).toBeNull()
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('stale selections and missing destinations fail before mutating available records', async () => {
  const { db, note } = await fixture()
  try {
    const outbox = await db.pendingOperations()
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id, 'gone'] }, { kind: 'tags', mode: 'add', tags: ['new'] })).rejects.toThrow('no longer exists')
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'move', deckId: 'gone' })).rejects.toThrow('Destination')
    expect(await db.pendingOperations()).toEqual(outbox)
    expect((await readNote(db, note.id))?.tags ?? []).toEqual([])
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('new sibling cards invalidate previously reviewed affected counts', async () => {
  const { db, note, cards } = await fixture()
  try {
    const selection = { view: 'cards' as const, ids: [cards[0].id] }
    const expected = await selectionSummary(db, selection)
    await db.updateNoteType((await readNoteType(db, note.typeId))!.id, { templates: [...(await readNoteType(db, note.typeId))!.templates, { name: 'Additional', front: '{{Expression}}', back: '{{Meaning}}', css: '' }] })
    const outbox = await db.pendingOperations()
    await expect(applyBulkAction(db, selection, { kind: 'delete' }, new Date(), expected)).rejects.toThrow('affected counts changed')
    expect(await readNote(db, note.id)).toBeDefined()
    expect(await db.pendingOperations()).toEqual(outbox)
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('literal replacement keeps $ text literal while regex replacement supports capture groups and field selection', async () => {
  const { db, type, note } = await fixture()
  try {
    const operation: FieldOperation = { typeId: type.id, fieldId: type.fields[1].id, mode: 'literal', find: 'cat', replacement: '$1 & cat', caseSensitive: true }
    const literal = fieldChangePreview([note], [type], operation)
    expect(literal[0]).toMatchObject({ before: 'cat', after: '$1 & cat' })
    const insensitive = fieldChangePreview([note], [type], { ...operation, find: 'CAT', caseSensitive: false })
    expect(insensitive[0].after).toBe('$1 & cat')
    const regex = fieldChangePreview([note], [type], { ...operation, mode: 'regex', find: '(c)(at)', replacement: '$2$1' })
    expect(regex[0].after).toBe('atc')
    await applyFieldChanges(db, regex)
    expect((await readNote(db, note.id))?.fields).toEqual({ [type.fields[0].id]: '猫', [type.fields[1].id]: 'atc' })
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('a concurrent note edit invalidates the whole field preview without overriding it', async () => {
  const { db, type, note } = await fixture()
  try {
    const preview = fieldChangePreview([note], [type], { typeId: type.id, fieldId: type.fields[0].id, mode: 'set', find: '', replacement: '犬', caseSensitive: true })
    await db.updateNoteTags(note.id, ['changed'])
    const outbox = await db.pendingOperations()
    await expect(applyFieldChanges(db, preview)).rejects.toThrow('fresh preview')
    expect((await readNote(db, note.id))?.fields[type.fields[0].id]).toBe('猫')
    expect(await db.pendingOperations()).toEqual(outbox)
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('a note-type edit invalidates the field preview before regenerating cards', async () => {
  const { db, type, note, cards } = await fixture()
  try {
    const preview = fieldChangePreview([note], [type], { typeId: type.id, fieldId: type.fields[0].id, mode: 'set', find: '', replacement: '犬', caseSensitive: true })
    await db.updateNoteType(type.id, { name: 'Renamed type' })
    const outbox = await db.pendingOperations()
    await expect(applyFieldChanges(db, preview)).rejects.toThrow('fresh preview')
    expect((await readAnkiExportSnapshot(db)).cards.map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort())
    expect(await db.pendingOperations()).toEqual(outbox)
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})
