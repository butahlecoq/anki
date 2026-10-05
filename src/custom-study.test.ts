import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection, Rating, State, type Collection } from './collection'
import { answerCustomStudy, changeCustomStudy, createCustomStudy, customPreset, customStudyQueue, previewCustomStudy, undoCustomStudy } from './custom-study'
import { customStudySessions } from './custom-study-state'
let db: Collection
const now = new Date('2026-10-02T12:00:00Z')
afterEach(async () => { await db?.delete() })
async function fixture() {
  db = createCollection(`custom-${crypto.randomUUID()}`)
  const deck = await db.createDeck('日本語', now)
  const note = await db.createNote(deck.id, BASIC_NOTE_TYPE_ID, { front: '猫', back: 'cat' }, now)
  const card = (await db.cards.where('noteId').equals(note.id).toArray())[0]
  return { deck, note, card }
}
const definition = { name: 'Focus', search: 'deck:*', limit: 20, order: 'due' as const, reschedule: false }
test('custom-study mutations own bounded named transaction scopes', async () => {
  const { card } = await fixture()
  const transaction = vi.spyOn(db, 'transaction')
  const session = await createCustomStudy(db, definition, now)
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['rw', [db.decks, db.notes, db.cards, db.noteTypes, db.reviewEntries, db.settings]])

  transaction.mockClear()
  await answerCustomStudy(db, session.id, card.id, Rating.Good, now)
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['rw', [db.decks, db.deckOptionGroups, db.notes, db.cards, db.noteTypes, db.reviewEntries, db.outbox, db.syncRevisions, db.settings]])

  transaction.mockClear()
  await undoCustomStudy(db, session.id)
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['rw', [db.settings, db.cards, db.notes, db.noteTypes, db.decks, db.reviewEntries, db.noteMedia, db.outbox, db.syncRevisions, db.deletedEntities]])
})

test('validated search reserves membership without changing home identity; empty/delete return home', async () => {
  const { deck, card } = await fixture()
  await expect(previewCustomStudy(db, { ...definition, search: 'unknown:value' }, now)).rejects.toThrow()
  await expect(previewCustomStudy(db, { ...definition, limit: 0 }, now)).rejects.toThrow()
  const session = await createCustomStudy(db, definition, now)
  expect((await customStudyQueue(db, session.id, now)).map(c => c.id)).toEqual([card.id])
  expect(await db.reviewQueue(deck.id, now)).toEqual([])
  expect(await db.cards.get(card.id)).toEqual(card)
  expect((await db.summaries())[0].sessionCount).toBe(1)
  expect((await previewCustomStudy(db, { ...definition, name: 'Other' }, now)).cards).toEqual([])
  await changeCustomStudy(db, session.id, 'empty', now)
  expect((await db.reviewQueue(deck.id, now))[0].id).toBe(card.id)
  await changeCustomStudy(db, session.id, 'rebuild', now)
  await changeCustomStudy(db, session.id, 'delete', now)
  expect(await customStudySessions(db)).toEqual([])
  expect(await db.cards.get(card.id)).toEqual(card)
})
test('practice history syncs without scheduling changes and undo restores membership', async () => {
  const { card } = await fixture()
  const session = await createCustomStudy(db, definition, now)
  const review = await answerCustomStudy(db, session.id, card.id, Rating.Again, now, 1234)
  expect(review).toMatchObject({ rescheduled: false, due: card.due, durationMs: 1234 })
  expect(await db.cards.get(card.id)).toEqual(card)
  expect((await db.pendingOperations()).find(op => op.entityId === review.id)?.payload).toEqual(review)
  const receiver = createCollection(`custom-receiver-${crypto.randomUUID()}`)
  try {
    const operations = await db.pendingOperations()
    await receiver.applyRemoteChanges(operations, 1)
    await receiver.applyRemoteChanges(operations, 2)
    expect(await receiver.reviewEntries.toArray()).toEqual([review])
    expect(await receiver.cards.get(card.id)).toEqual(card)
    expect(await customStudySessions(receiver)).toEqual([])
    expect((await receiver.reviewQueue(card.deckId, now)).map(item => item.id)).toContain(card.id)
  } finally { await receiver.delete() }
  expect((await customStudySessions(db))[0].cardIds).toEqual([])
  await undoCustomStudy(db, session.id)
  expect(await db.reviewEntries.get(review.id)).toBeUndefined()
  expect((await customStudySessions(db))[0].cardIds).toEqual([card.id])
  await answerCustomStudy(db, session.id, card.id, Rating.Good, now)
  await changeCustomStudy(db, session.id, 'rebuild', now)
  expect(await db.latestReviewUndo()).toBeNull()
  expect(await db.cards.get(card.id)).toEqual(card)
})
test('ahead preset supports early FSRS scheduling and deletion preserves resulting history', async () => {
  const { card } = await fixture()
  await db.cards.update(card.id, { state: State.Review, due: '2026-10-09T12:00:00Z', stability: 5, difficulty: 5, reps: 2, lastReview: '2026-09-28T12:00:00Z' })
  const session = await createCustomStudy(db, { ...definition, ...customPreset('ahead'), reschedule: true }, now)
  expect(session.cardIds).toEqual([card.id])
  expect(await db.reviewChoices(card.id, now, true)).toHaveLength(4)
  const review = await answerCustomStudy(db, session.id, card.id, Rating.Good, now)
  expect((await db.cards.get(card.id))?.reps).toBe(3)
  await changeCustomStudy(db, session.id, 'delete', now)
  expect(await db.reviewEntries.get(review.id)).toEqual(review)
  expect((await db.cards.get(card.id))?.deckId).toBe(card.deckId)
})
