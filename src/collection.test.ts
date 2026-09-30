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
    await expect(collection.pendingOperations()).resolves.toHaveLength(3)
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

  test('queues deck and note changes for sync', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })

    await collection.renameDeck(deck.id, 'Japanese words')
    await collection.updateBasicNote(note.id, { front: '猫', back: 'ねこ — feline' })
    await collection.deleteDeck(deck.id)

    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'deck', entityId: deck.id, action: 'update' }),
      expect.objectContaining({ entityType: 'note', entityId: note.id, action: 'update' }),
      expect.objectContaining({ entityType: 'deck', entityId: deck.id, action: 'delete' }),
    ]))
  })

  test('deduplicates verified media bytes while keeping independent note references', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const first = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    const second = await collection.createBasicNote(deck.id, { front: '犬', back: 'いぬ — dog' })
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'example.png', { type: 'image/png' })

    const firstReference = await collection.attachMedia(first.id, { file: image, side: 'front' })
    const secondReference = await collection.attachMedia(second.id, { file: image, side: 'back' })

    expect(firstReference.digest).toBe(secondReference.digest)
    await expect(collection.mediaBlobs.count()).resolves.toBe(1)
    await expect(collection.mediaForNote(first.id)).resolves.toHaveLength(1)
    await collection.removeMedia(firstReference.id)
    await expect(collection.mediaBlobs.count()).resolves.toBe(1)
    await expect(collection.mediaForNote(second.id)).resolves.toHaveLength(1)
  })

  test('keeps a paired sync credential in local collection settings', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'device-token', cursor: 4 })
    await expect(collection.syncSettings()).resolves.toEqual({ endpoint: 'https://pc.example.test', token: 'device-token', cursor: 4 })
  })

  test('applies a remote review only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const operation = { opId: 'remote-review', entityType: 'review' as const, entityId: 'review-1', action: 'create' as const, occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: 'card-1', deckId: 'deck-1', rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(collection.reviewEntries.count()).resolves.toBe(1)
  })

  test('applies remote deck, note, and card entities only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = { id: 'remote-deck', name: 'Remote Japanese', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
    const note = { id: 'remote-note', deckId: deck.id, type: 'basic' as const, fields: { front: '犬', back: 'いぬ — dog' }, createdAt: deck.createdAt, updatedAt: deck.updatedAt }
    const card = { id: 'remote-card', deckId: deck.id, noteId: note.id, due: deck.createdAt, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null }
    const changes = [
      { opId: 'remote-deck-create', entityType: 'deck' as const, entityId: deck.id, action: 'create' as const, occurredAt: deck.createdAt, payload: deck },
      { opId: 'remote-note-create', entityType: 'note' as const, entityId: note.id, action: 'create' as const, occurredAt: note.createdAt, payload: note },
      { opId: 'remote-card-create', entityType: 'card' as const, entityId: card.id, action: 'create' as const, occurredAt: card.due, payload: card },
    ]

    await collection.applyRemoteChanges(changes, 3)
    await collection.applyRemoteChanges(changes, 3)

    await expect(collection.decks.get(deck.id)).resolves.toEqual(deck)
    await expect(collection.notes.get(note.id)).resolves.toEqual(note)
    await expect(collection.cards.get(card.id)).resolves.toEqual(card)
    await expect(collection.receivedOperations.count()).resolves.toBe(3)
  })

  test('keeps a deleted deck deleted when an offline client later sends an edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    await collection.deleteDeck(deck.id, new Date('2026-10-01T12:01:00.000Z'))
    const editedNote = { ...note, fields: { front: '猫', back: 'ねこ — feline' }, updatedAt: '2026-10-01T12:02:00.000Z' }

    await collection.applyRemoteChanges([{
      opId: 'offline-note-edit', entityType: 'note', entityId: note.id, action: 'update', occurredAt: editedNote.updatedAt, payload: editedNote,
    }], 1)

    await expect(collection.decks.get(deck.id)).resolves.toBeUndefined()
    await expect(collection.notes.get(note.id)).resolves.toBeUndefined()
    await expect(collection.cards.where('deckId').equals(deck.id).count()).resolves.toBe(0)
  })

  test('applies a remote media reference only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const reference = { id: 'media-1', noteId: 'note-1', digest: 'a'.repeat(64), kind: 'image' as const, mimeType: 'image/png', displayName: 'cat.png', side: 'front' as const, playback: 'manual' as const, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
    const operation = { opId: 'remote-media', entityType: 'noteMedia' as const, entityId: reference.id, action: 'create' as const, occurredAt: reference.createdAt, payload: reference }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(collection.noteMedia.count()).resolves.toBe(1)
  })

  test('rejects downloaded media whose bytes do not match its digest', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    await expect(collection.storeDownloadedMedia('a'.repeat(64), new Blob(['wrong'], { type: 'image/png' }))).rejects.toThrow('content digest')
    await expect(collection.mediaBlobs.count()).resolves.toBe(0)
  })
})
