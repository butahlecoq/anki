import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { createCollection, Rating, type Collection } from './collection'

let collection: Collection | undefined

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

describe('local collection', () => {
  test('creates a Japanese Basic note with one new card in its deck', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)

    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })

    expect(note.deckId).toBe(deck.id)
    expect(note.fields).toEqual({ front: '猫', back: 'ねこ — cat' })
    await expect(collection.counts(deck.id)).resolves.toEqual({ new: 1, learning: 0, review: 0 })
  })

  test('persists an edit and an FSRS review event atomically', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    collection = createCollection(databaseName)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    await collection.updateBasicNote(note.id, { front: '猫', back: 'ねこ — feline' })
    const due = (await collection.dueCards(deck.id, new Date('2026-09-30T12:00:00.000Z')))[0]
    const choices = await collection.reviewChoices(due.id, new Date('2026-09-30T12:00:00.000Z'))

    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { back: 'ねこ — feline' } })
    expect(due.noteId).toBe(note.id)
    expect(choices.find((choice) => choice.label === 'Good')?.interval).toMatch(/m|d/)

    await collection.answer(due.id, Rating.Good, new Date('2026-09-30T12:00:00.000Z'))
    await expect(collection.counts(deck.id)).resolves.toEqual({ new: 0, learning: 1, review: 0 })
    await expect(collection.reviewEntries.where('deckId').equals(deck.id).count()).resolves.toBe(1)

    const reopened = createCollection(databaseName)
    await expect(reopened.notes.get(note.id)).resolves.toMatchObject({ fields: { back: 'ねこ — feline' } })
    await expect(reopened.reviewEntries.where('deckId').equals(deck.id).count()).resolves.toBe(1)
    await reopened.delete()
    collection = undefined
  })
})
