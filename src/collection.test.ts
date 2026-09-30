import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, test } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection, Rating, type Collection } from './collection'

let collection: Collection | undefined

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

describe('local collection', () => {
  test('upgrades v5 Basic data without changing note, card, or review identities', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(5).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt' })
    await old.table('notes').add({ id: 'note-1', deckId: 'deck-1', type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add({ id: 'legacy-card', deckId: 'deck-1', noteId: 'note-1', due: '2026-01-02', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-01-01' })
    await old.table('reviewEntries').add({ id: 'review-1', cardId: 'legacy-card', deckId: 'deck-1', reviewedAt: '2026-01-01' })
    old.close()

    collection = createCollection(databaseName)
    await expect(collection.noteTypes.get(BASIC_NOTE_TYPE_ID)).resolves.toMatchObject({ name: 'Basic', protected: true })
    await expect(collection.notes.get('note-1')).resolves.toMatchObject({ typeId: BASIC_NOTE_TYPE_ID, fields: { front: '猫', back: 'cat' } })
    await expect(collection.cards.get('legacy-card')).resolves.toMatchObject({ templateId: 'basic', reps: 2 })
    await expect(collection.reviewEntries.get('review-1')).resolves.toMatchObject({ cardId: 'legacy-card' })
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  })

  test('creates one stable card per nonempty template and preserves its schedule on edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Vocabulary')
    const type = await collection.createNoteType({ name: 'Bidirectional', fields: [{ name: 'word' }, { name: 'meaning' }], templates: [
      { name: 'Forward', front: '{{word}}', back: '{{meaning}}', css: '' },
      { name: 'Reverse', front: '{{meaning}}', back: '{{word}}', css: '' },
    ] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
    expect(note.fields).toEqual({ [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
    const cards = await collection.cards.where('noteId').equals(note.id).toArray()
    expect(cards.map((card) => card.id).sort()).toEqual(type.templates.map((template) => `${note.id}:${template.id}`).sort())
    await collection.answer(cards[0].id, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.updateNote(note.id, { [type.fields[0].id]: '犬', [type.fields[1].id]: 'dog' })
    await expect(collection.cards.get(cards[0].id)).resolves.toMatchObject({ reps: 1, templateId: cards[0].templateId })
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(2)
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'noteType', entityId: type.id, action: 'create' }),
    ]))
  })

  test('skips an empty template front without creating a study card', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Vocabulary')
    const type = await collection.createNoteType({ name: 'Conditional', fields: [{ name: 'word' }, { name: 'hint' }], templates: [
      { name: 'Word', front: '{{word}}', back: 'answer', css: '' },
      { name: 'Hint', front: '<b>{{hint}}</b>', back: 'answer', css: '' },
    ] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: '' })
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(1)
    expect(collection.cardGenerationStatus(type, note.fields).skipped).toEqual([{ templateId: type.templates[1].id, reason: 'Front has no visible field content' }])
  })

  test('suspends an ineligible generated card and restores its schedule when content returns', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Vocabulary')
    const type = await collection.createNoteType({ name: 'Hints', fields: [{ name: 'hint' }], templates: [
      { name: 'Hint', front: '{{hint}}', back: 'answer', css: '' },
    ] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: 'first' })
    const cardId = `${note.id}:${type.templates[0].id}`
    await collection.answer(cardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.updateNote(note.id, { [type.fields[0].id]: '' })
    await expect(collection.cards.get(cardId)).resolves.toMatchObject({ suspended: true, reps: 1 })
    await expect(collection.dueCards(deck.id)).resolves.toHaveLength(0)
    await collection.updateNote(note.id, { [type.fields[0].id]: 'restored' })
    await expect(collection.cards.get(cardId)).resolves.toMatchObject({ id: cardId, templateId: type.templates[0].id, suspended: false, reps: 1 })
  })

  test('keeps field values under stable IDs when display metadata is renamed', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Vocabulary')
    const type = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }], templates: [
      { name: 'Word card', front: '{{Word}}', back: 'answer', css: '' },
    ] })
    const fieldId = type.fields[0].id
    const note = await collection.createNote(deck.id, type.id, { [fieldId]: '猫' })
    const renamed = { ...type, fields: [{ ...type.fields[0], name: 'Term' }], templates: [{ ...type.templates[0], front: '{{Term}}' }] }
    await collection.noteTypes.put(renamed)

    expect(collection.cardGenerationStatus(renamed, note.fields).eligible).toHaveLength(1)
    await collection.updateNote(note.id, { [fieldId]: '犬' })
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [fieldId]: '犬' } })
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(1)
  })

  test('rejects note types whose templates reference an unknown field or FrontSide on front', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const input = { name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Missing}}', back: '{{Word}}', css: '' }] }
    await expect(collection.createNoteType(input)).rejects.toThrow(/unknown field/i)
    await expect(collection.createNoteType({ ...input, templates: [{ ...input.templates[0], front: '{{FrontSide}}' }] })).rejects.toThrow(/FrontSide.*front/i)
    await expect(collection.noteTypes.count()).resolves.toBe(1)
  })

  test('keeps the protected Basic type when an older Basic note syncs in twice', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const basic = await collection.noteTypes.get(BASIC_NOTE_TYPE_ID)
    const note = { id: 'old-note', deckId: 'remote-deck', type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const operation = { opId: 'old-note-create', entityType: 'note' as const, entityId: note.id, action: 'create' as const, occurredAt: note.createdAt, payload: note }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(collection.noteTypes.get(BASIC_NOTE_TYPE_ID)).resolves.toEqual(basic)
    await expect(collection.notes.get(note.id)).resolves.toEqual(note)
  })

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

  test('creates a note and its media references atomically', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const image = new File(['image'], 'cat.png', { type: 'image/png' })
    const note = await collection.createBasicNoteWithMedia(deck.id, { front: '猫', back: 'cat' }, [{ file: image, side: 'front' }, { file: image, side: 'back' }])
    await expect(collection.mediaForNote(note.id)).resolves.toHaveLength(2)
    await expect(collection.mediaBlobs.count()).resolves.toBe(1)
    await expect(collection.createBasicNoteWithMedia(deck.id, { front: '犬', back: 'dog' }, [{ file: new File(['bad'], 'bad.txt', { type: 'text/plain' }), side: 'front' }])).rejects.toThrow('not a supported')
    await expect(collection.notes.count()).resolves.toBe(1)
  })

  test('removes media references with their deleted deck while retaining shared bytes', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    await collection.attachMedia(note.id, { file: new File(['image'], 'cat.png', { type: 'image/png' }), side: 'front' })

    await collection.deleteDeck(deck.id)

    await expect(collection.noteMedia.count()).resolves.toBe(0)
    await expect(collection.mediaBlobs.count()).resolves.toBe(1)
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
