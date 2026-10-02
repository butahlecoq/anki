import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import { createCollection, Rating, type Collection } from './collection'

const collections: Collection[] = []
const time = new Date('2026-10-01T12:00:00Z')
afterEach(async () => { for (const collection of collections.splice(0)) await collection.delete() })

async function clients() {
  const a = createCollection(`concurrent-a-${crypto.randomUUID()}`)
  const b = createCollection(`concurrent-b-${crypto.randomUUID()}`)
  collections.push(a, b)
  const deck = await a.createDeck('日本語', time)
  const note = await a.createBasicNote(deck.id, { front: '猫', back: 'cat' }, time)
  const operations = await a.pendingOperations()
  await b.applyRemoteChanges(structuredClone(operations), operations.length)
  await a.acknowledgeOperations(operations.map((operation) => operation.opId))
  const card = (await a.cards.where('noteId').equals(note.id).first())!
  return { a, b, deck, note, card, seed: operations }
}

async function exchange(a: Collection, b: Collection, reverse = false) {
  const outgoingA = await a.pendingOperations(), outgoingB = await b.pendingOperations()
  const changes = reverse ? [...outgoingB, ...outgoingA] : [...outgoingA, ...outgoingB]
  await a.applyRemoteChanges(structuredClone(changes), changes.length)
  await b.applyRemoteChanges(structuredClone(changes), changes.length)
  await a.acknowledgeOperations(outgoingA.map((operation) => operation.opId))
  await b.acknowledgeOperations(outgoingB.map((operation) => operation.opId))
  return changes
}

test('independent offline Japanese field edits converge without losing either change', async () => {
  const { a, b, note } = await clients()
  await a.updateBasicNote(note.id, { front: 'ねこ', back: 'cat' }, new Date('2026-10-02T12:00:00Z'))
  await b.updateBasicNote(note.id, { front: '猫', back: 'кот' }, new Date('2026-10-02T12:00:01Z'))
  await exchange(a, b, true)
  expect(await a.notes.get(note.id)).toEqual(await b.notes.get(note.id))
  expect(await a.notes.get(note.id)).toMatchObject({ fields: { front: 'ねこ', back: 'кот' } })
  expect(await a.syncConflicts.count()).toBe(0)
})

test('conflicting edits survive reopening and an explicit revision choice converges', async () => {
  const { a, b, note } = await clients()
  await a.updateBasicNote(note.id, { front: 'ねこ', back: 'кот · feline' }, new Date('2026-10-02T12:00:00Z'))
  await b.updateBasicNote(note.id, { front: 'ネコ', back: 'cat' }, new Date('2026-10-02T12:00:01Z'))
  await exchange(a, b)
  const conflict = (await a.syncConflicts.toArray())[0]
  expect(conflict.conflicts).toContain('fields.front')
  expect(conflict.versions).toHaveLength(2)
  const name = a.name
  a.close()
  const reopened = createCollection(name); collections.push(reopened)
  expect(await reopened.syncConflicts.get(conflict.key)).toEqual(conflict)
  const selected = conflict.versions.find((version) => (version.value as { fields: { front: string } }).fields.front === 'ネコ')!
  await reopened.resolveSyncConflict(conflict.key, selected.opId, conflict.heads)
  await exchange(reopened, b)
  expect(await reopened.notes.get(note.id)).toEqual(await b.notes.get(note.id))
  expect(await reopened.notes.get(note.id)).toMatchObject({ fields: { front: 'ネコ', back: 'кот · feline' } })
  expect(await b.syncConflicts.count()).toBe(0)
  await expect(b.resolveSyncConflict(conflict.key, conflict.heads[1], conflict.heads)).rejects.toThrow(/changed/i)
})

test('offline reviews merge once and produce the same chronological FSRS schedule', async () => {
  const { a, b, card } = await clients()
  await a.answer(card.id, Rating.Good, new Date('2026-10-01T12:00:10Z'))
  await b.answer(card.id, Rating.Easy, new Date('2026-10-01T12:00:20Z'))
  const changes = await exchange(a, b, true)
  await a.applyRemoteChanges(structuredClone(changes), changes.length)
  await b.applyRemoteChanges(structuredClone(changes), changes.length)
  expect(await a.reviewEntries.count()).toBe(2)
  expect(await b.reviewEntries.count()).toBe(2)
  expect(await a.cards.get(card.id)).toEqual(await b.cards.get(card.id))
  expect(await a.cards.get(card.id)).toMatchObject({ reps: 2, lastReview: '2026-10-01T12:00:20.000Z' })
})

test('a deletion remains effective when an offline client uploads a stale edit', async () => {
  const { a, b, note, card } = await clients()
  await a.deleteNote(note.id, new Date('2026-10-02T12:00:00Z'))
  await b.updateBasicNote(note.id, { front: 'ねこ', back: 'cat' }, new Date('2026-10-02T13:00:00Z'))
  await exchange(a, b, true)
  expect(await a.notes.get(note.id)).toBeUndefined()
  expect(await b.notes.get(note.id)).toBeUndefined()
  expect(await b.cards.get(card.id)).toBeUndefined()
  expect((await b.syncConflicts.toArray()).some((conflict) => conflict.deleted)).toBe(true)
})

test('undoing an unpublished deletion removes its causal revision before later synchronization', async () => {
  const { a, b, note } = await clients()
  await a.deleteNote(note.id, new Date('2026-10-02T12:00:00Z'))
  await a.undoLastNoteDeletion()
  await b.updateBasicNote(note.id, { front: 'ねこ', back: 'cat' }, new Date('2026-10-02T12:01:00Z'))
  await exchange(a, b)
  expect(await a.notes.get(note.id)).toEqual(await b.notes.get(note.id))
  expect(await a.notes.get(note.id)).toMatchObject({ fields: { front: 'ねこ' } })
  expect(await a.syncConflicts.count()).toBe(0)
})

for (const reverse of [false, true]) {
  test(`deck deletion suppresses offline edits and reviews in ${reverse ? 'reverse' : 'forward'} delivery order`, async () => {
    const { a, b, deck, note, card } = await clients()
    await a.deleteDeck(deck.id, { mode: 'delete-subtree' }, new Date('2026-10-02T12:00:00Z'))
    await b.updateBasicNote(note.id, { front: 'ねこ', back: 'cat' }, new Date('2026-10-02T12:01:00Z'))
    await b.answer(card.id, Rating.Easy, new Date('2026-10-02T12:02:00Z'))
    const changes = await exchange(a, b, reverse)
    for (const client of [a, b]) {
      await client.applyRemoteChanges(structuredClone(changes), changes.length)
      expect(await client.decks.get(deck.id)).toBeUndefined()
      expect(await client.notes.get(note.id)).toBeUndefined()
      expect(await client.cards.get(card.id)).toBeUndefined()
      expect(await client.reviewEntries.count()).toBe(0)
    }
  })

  test(`manual rescheduling and a concurrent review replay like chronological single-client actions (${reverse})`, async () => {
    const { a, b, card, seed } = await clients()
    const oracle = createCollection(`concurrent-oracle-${crypto.randomUUID()}`); collections.push(oracle)
    await oracle.applyRemoteChanges(structuredClone(seed), seed.length)
    const first = new Date('2026-10-01T12:00:01Z')
    await a.answer(card.id, Rating.Easy, first)
    await oracle.answer(card.id, Rating.Easy, first)
    await exchange(a, b)
    const commandAt = new Date('2026-10-02T12:00:10Z'), due = new Date('2026-10-05T12:00:00Z')
    await a.rescheduleCard(card.id, due, commandAt)
    await oracle.rescheduleCard(card.id, due, commandAt)
    const reviewedAt = new Date('2026-10-02T12:00:20Z')
    await b.answer(card.id, Rating.Good, reviewedAt, undefined, { allowEarly: true, reschedule: true })
    await oracle.answer(card.id, Rating.Good, reviewedAt, undefined, { allowEarly: true, reschedule: true })
    await exchange(a, b, reverse)
    expect(await a.cards.get(card.id)).toEqual(await b.cards.get(card.id))
    expect(await a.cards.get(card.id)).toEqual(await oracle.cards.get(card.id))
    expect(await a.syncConflicts.count()).toBe(0)
  })
}
