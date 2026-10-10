import { afterEach, expect, test } from 'vitest'
import { createCollection, Rating, type Collection } from './collection'
import { createDeckPractice, createCustomStudy, answerCustomStudy, customStudyQueue, undoCustomStudy } from './custom-study'
import { readCard, readCardsForNote, readCardReviewHistory } from './collection-queries'
let db: Collection
const now = new Date('2026-10-02T12:00:00Z')
afterEach(async () => { await db?.removeLocalCollection() })
test('graduated cards can practice repeatedly without changing schedule, including subtree and undo', async () => {
  db = createCollection(`repeat-${crypto.randomUUID()}`)
  const deck = await db.createDeck('日本語 * "test"', now)
  const child = await db.createDeck('Child', { parentId: deck.id }, now)
  const note = await db.createBasicNote(child.id, { front: '猫', back: 'cat' }, now)
  const card = (await readCardsForNote(db, note.id))[0]
  await db.answer(card.id, Rating.Easy, now)
  const graduated = await readCard(db, card.id)
  expect(await db.reviewQueue(deck.id, now)).toEqual([])
  const first = await createDeckPractice(db, deck.id, now)
  expect(first.reschedule).toBe(false)
  expect((await customStudyQueue(db, first.id, now)).map(card => card.id)).toEqual([card.id])
  await answerCustomStudy(db, first.id, card.id, Rating.Good, now)
  expect(await readCard(db, card.id)).toEqual(graduated)
  await undoCustomStudy(db, first.id)
  expect((await customStudyQueue(db, first.id, now)).map(card => card.id)).toEqual([card.id])
  await answerCustomStudy(db, first.id, card.id, Rating.Easy, now)
  const second = await createDeckPractice(db, deck.id, now)
  expect(second.cardIds).toEqual([card.id])
  await answerCustomStudy(db, second.id, card.id, Rating.Hard, now)
  expect(await readCard(db, card.id)).toEqual(graduated)
  expect(await readCardReviewHistory(db, card.id)).toHaveLength(3)
})

test('practice excludes other decks, unavailable and reserved cards, and cleans up an empty attempt', async () => {
  db = createCollection(`practice-scope-${crypto.randomUUID()}`)
  const deck = await db.createDeck('Target', now)
  const other = await db.createDeck('Other', now)
  const add = async (deckId: string, front: string) => {
    const note = await db.createBasicNote(deckId, { front, back: 'answer' }, now)
    return (await readCardsForNote(db, note.id))[0]
  }
  const available = await add(deck.id, 'available')
  const suspended = await add(deck.id, 'suspended')
  const buried = await add(deck.id, 'buried')
  const reserved = await add(deck.id, 'reserved')
  await add(other.id, 'outside')
  await db.suspendCard(suspended.id, now)
  await db.buryCard(buried.id, now)
  await createCustomStudy(db, { name: 'Existing session', search: 'reserved', limit: 20, order: 'due', reschedule: false }, now)
  const practice = await createDeckPractice(db, deck.id, now)
  expect(practice.cardIds).toEqual([available.id])
  expect(practice.cardIds).not.toContain(reserved.id)
  await expect(createDeckPractice(db, deck.id, now)).rejects.toThrow('No cards are available')
})
