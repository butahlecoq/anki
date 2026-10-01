import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { createCollection, Rating } from './collection'
import { applyBulkAction, applyFieldChanges, fieldChangePreview, selectionSummary, type FieldOperation } from './browser-maintenance'

async function fixture() {
  const db = createCollection(`browser-maintenance-${crypto.randomUUID()}`)
  const deck = await db.createDeck('日本語')
  const type = await db.createNoteType({ name: 'Reversed vocabulary', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', front: '{{Expression}}', back: '{{Meaning}}', css: '' }, { name: 'Production', front: '{{Meaning}}', back: '{{Expression}}', css: '' }] })
  const note = await db.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
  const cards = await db.cards.where('noteId').equals(note.id).toArray()
  return { db, deck, type, note, cards }
}

test('card-level flags and suspension retain sibling identity; note view affects all generated cards', async () => {
  const { db, note, cards } = await fixture()
  try {
    await expect(selectionSummary(db, { view: 'cards', ids: [cards[0].id] })).resolves.toEqual({ selectedCards: 1, notes: 1, generatedCards: 2 })
    await applyBulkAction(db, { view: 'cards', ids: [cards[0].id] }, { kind: 'flag', flag: 3 })
    expect((await db.cards.get(cards[0].id))?.flag).toBe(3)
    expect((await db.cards.get(cards[1].id))?.flag ?? 0).toBe(0)
    await applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'suspend', suspended: true })
    expect((await db.cards.toArray()).every((card) => card.manualSuspended)).toBe(true)
    expect(await db.latestCardMaintenanceUndo()).toBeNull()
    await applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'suspend', suspended: false })
    expect((await db.cards.toArray()).every((card) => !card.manualSuspended)).toBe(true)
    expect((await db.cards.toArray()).map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort())
  } finally { db.close(); await db.delete() }
})

test('note actions deduplicate selected siblings and moving preserves scheduling and review identity', async () => {
  const { db, note, cards } = await fixture()
  try {
    const selection = { view: 'cards' as const, ids: cards.map((card) => card.id) }
    const review = await db.answer(cards[0].id, Rating.Easy)
    const scheduled = await db.cards.get(cards[0].id)
    await applyBulkAction(db, selection, { kind: 'tags', mode: 'add', tags: ['animal', 'jlpt::n5', 'animal'] })
    expect((await db.notes.get(note.id))?.tags).toEqual(['animal', 'jlpt::n5'])
    await applyBulkAction(db, selection, { kind: 'tags', mode: 'remove', tags: ['animal'] })
    expect((await db.notes.get(note.id))?.tags).toEqual(['jlpt::n5'])
    const destination = await db.createDeck('Vocabulary')
    await applyBulkAction(db, selection, { kind: 'move', deckId: destination.id })
    expect(await db.cards.get(cards[0].id)).toMatchObject({ ...scheduled, deckId: destination.id })
    expect(await db.reviewEntries.get(review.id)).toEqual(review)
  } finally { db.close(); await db.delete() }
})

test('a failed bulk deletion restores prior deletions, tombstones, and outbox writes', async () => {
  const { db, deck, note, cards } = await fixture()
  try {
    const broken = await db.createBasicNote(deck.id, { front: '犬', back: 'dog' })
    await db.notes.update(broken.id, { typeId: 'missing-type' })
    const outbox = await db.pendingOperations()
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id, broken.id] }, { kind: 'delete' })).rejects.toThrow('Note type not found')
    expect(await db.notes.get(note.id)).toBeDefined()
    expect(await db.cards.bulkGet(cards.map((card) => card.id))).not.toContain(undefined)
    expect(await db.deletedEntities.count()).toBe(0)
    expect(await db.pendingOperations()).toEqual(outbox)
    await db.notes.update(broken.id, { typeId: 'basic' })
    await applyBulkAction(db, { view: 'notes', ids: [note.id, broken.id] }, { kind: 'delete' })
    expect(await db.notes.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.latestNoteDeletionUndo()).toBeNull()
  } finally { db.close(); await db.delete() }
})

test('stale selections and missing destinations fail before mutating available records', async () => {
  const { db, note } = await fixture()
  try {
    const outbox = await db.pendingOperations()
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id, 'gone'] }, { kind: 'tags', mode: 'add', tags: ['new'] })).rejects.toThrow('no longer exists')
    await expect(applyBulkAction(db, { view: 'notes', ids: [note.id] }, { kind: 'move', deckId: 'gone' })).rejects.toThrow('Destination')
    expect(await db.pendingOperations()).toEqual(outbox)
    expect((await db.notes.get(note.id))?.tags ?? []).toEqual([])
  } finally { db.close(); await db.delete() }
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
    expect((await db.notes.get(note.id))?.fields).toEqual({ [type.fields[0].id]: '猫', [type.fields[1].id]: 'atc' })
  } finally { db.close(); await db.delete() }
})

test('a concurrent note edit invalidates the whole field preview without overriding it', async () => {
  const { db, type, note } = await fixture()
  try {
    const preview = fieldChangePreview([note], [type], { typeId: type.id, fieldId: type.fields[0].id, mode: 'set', find: '', replacement: '犬', caseSensitive: true })
    await db.updateNoteTags(note.id, ['changed'])
    const outbox = await db.pendingOperations()
    await expect(applyFieldChanges(db, preview)).rejects.toThrow('fresh preview')
    expect((await db.notes.get(note.id))?.fields[type.fields[0].id]).toBe('猫')
    expect(await db.pendingOperations()).toEqual(outbox)
  } finally { db.close(); await db.delete() }
})

test('a note-type edit invalidates the field preview before regenerating cards', async () => {
  const { db, type, note, cards } = await fixture()
  try {
    const preview = fieldChangePreview([note], [type], { typeId: type.id, fieldId: type.fields[0].id, mode: 'set', find: '', replacement: '犬', caseSensitive: true })
    await db.updateNoteType(type.id, { name: 'Renamed type' })
    const outbox = await db.pendingOperations()
    await expect(applyFieldChanges(db, preview)).rejects.toThrow('fresh preview')
    expect((await db.cards.toArray()).map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort())
    expect(await db.pendingOperations()).toEqual(outbox)
  } finally { db.close(); await db.delete() }
})
