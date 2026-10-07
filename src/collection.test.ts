import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, test } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection, Rating, State, type CardRecord, type Collection, type DeckOptionSettings, type SyncOperation } from './collection'
import { readAnkiExportSnapshot, readCard, readCardReviewHistory, readCardsForNote, readDeck, readDeckOptionGroup, readDeletedEntity, readNote, readNoteMediaReference, readNoteType, readReceivedOperationCount, readReviewEntry, readSyncProgressCounts } from './collection-queries'
import { intervalLabel } from './scheduler'
import { createCustomStudy } from './custom-study'
import { deleteIndexedDbFixtureRow, insertIndexedDbLegacyMediaBlob, overwriteIndexedDbBackupReceipt, overwriteIndexedDbLegacyCard } from '../tests/helpers/damage-indexeddb-media'

let collection: Collection | undefined

type SchedulingSettings = DeckOptionSettings
type NodeRuntime = { execPath: string; cwd(): string; env: Record<string, string | undefined> }
type SpawnSync = (command: string, args: string[], options: { cwd: string; encoding: 'utf8'; env: Record<string, string | undefined> }) => { status: number | null; stderr: string }

function directCard(id: string, deckId: string, noteId: string, state: State, due: string): CardRecord {
  return { id, deckId, noteId, templateId: 'basic', due, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state, lastReview: null }
}
function directNote(id: string, deckId: string, createdAt = '2026-10-01T00:00:00.000Z') {
  return { id, deckId, type: 'basic', typeId: BASIC_NOTE_TYPE_ID, fields: { front: id, back: id }, createdAt, updatedAt: createdAt }
}

let fixtureOperation = 0
async function applyRemoteFixtures<T extends { id: string }>(db: Collection, entityType: SyncOperation['entityType'], rows: readonly T[], action: 'create' | 'update' = 'create') {
  const occurredAt = '2026-10-01T12:00:00.000Z'
  const operations = rows.map((payload) => ({
    opId: `collection-test-fixture-${++fixtureOperation}`, entityType, entityId: payload.id,
    action, occurredAt, payload,
  } satisfies SyncOperation))
  await db.applyRemoteChanges(operations, fixtureOperation)
}



afterEach(async () => {
  await collection?.removeLocalCollection()
  collection = undefined
})

describe('local collection', () => {
  test.each(['direct', 'cascade', 'missing', 'ambiguous'] as const)('version 21 migration preserves %s deletion provenance', async (scenario) => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(21).stores({ decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state, newPosition', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, protected', syncRevisions: 'opId, key', syncConflicts: 'key, entityType, entityId' })
    const note = directNote('legacy-deleted-note', 'legacy-deleted-deck')
    const created: SyncOperation = { opId: 'legacy-note-created', entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note, parents: [] }
    const sourceType = scenario === 'cascade' ? 'deck' : 'note'
    const sourceId = sourceType === 'deck' ? note.deckId : note.id
    const deleted: SyncOperation = { opId: 'legacy-actual-deletion', entityType: sourceType, entityId: sourceId, action: 'delete', occurredAt: '2026-10-01T01:00:00.000Z', payload: { id: sourceId }, parents: sourceType === 'note' ? [created.opId] : [] }
    await old.table('syncRevisions').add({ ...created, key: `note:${note.id}` })
    if (scenario !== 'missing') {
      await old.table('syncRevisions').add({ ...deleted, key: `${sourceType}:${sourceId}` })
      await old.table('outbox').add(deleted)
    }
    if (scenario === 'ambiguous') await old.table('syncRevisions').add({ ...deleted, opId: 'legacy-other-deletion', key: `${sourceType}:${sourceId}` })
    await old.table('deletedEntities').add({ key: `note:${note.id}`, entityType: 'note', entityId: note.id, occurredAt: '2099-01-01T00:00:00.000Z' })
    old.close()
    collection = createCollection(databaseName)
    const tombstone = await readDeletedEntity(collection, `note:${note.id}`)
    if (scenario === 'missing' || scenario === 'ambiguous') {
      expect(tombstone).toMatchObject({ entityId: note.id, causes: [], provenanceError: expect.stringMatching(/deletion.*provenance/i) })
    } else {
      expect(tombstone).toMatchObject({ causes: [{ source: { entityType: sourceType, entityId: sourceId }, opId: deleted.opId, deletedLifetime: [] }] })
      expect((await collection.pendingOperations())[0]).toMatchObject({ opId: deleted.opId, lifetime: [] })
    }
  })

  test.each(['note', 'deck'] as const)('deletion provenance survives reopen for %s deletion and its descendants', async (sourceType) => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    collection = createCollection(databaseName)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const parent = await collection.createDeck('Restoration parent')
      const deck = await collection.createDeck('Restoration child', { parentId: parent.id })
      const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
      const cards = await readCardsForNote(collection, note.id)
      const media = await collection.attachMedia(note.id, { file: new File(['sound'], 'sound.mp3', { type: 'audio/mpeg' }), side: 'front' })
      const created = await collection.pendingOperations()
      await remote.applyRemoteChanges(created, created.length)
      if (sourceType === 'note') await collection.deleteNote(note.id)
      else await collection.deleteDeck(parent.id, { mode: 'delete-subtree' })
      const deletions = (await collection.pendingOperations()).filter((operation) => operation.action === 'delete')
      const sourceId = sourceType === 'note' ? note.id : deck.id
      const source = deletions.find((operation) => operation.entityType === sourceType && operation.entityId === sourceId)!
      expect(source).toBeDefined()
      collection.closeLocalCollection()
      collection = createCollection(databaseName)
      expect((await collection.pendingOperations()).find((operation) => operation.opId === source.opId)).toMatchObject({
        opId: source.opId, lifetime: [],
        relatedLifetimes: expect.arrayContaining([{ entityType: 'deck', entityId: sourceType === 'note' ? deck.id : parent.id, lifetime: [] }]),
      })
      await remote.applyRemoteChanges(deletions, created.length + deletions.length)
      const expectedCause = { source: { entityType: sourceType, entityId: sourceId }, opId: source.opId, deletedLifetime: [] }
      for (const target of [collection, remote]) {
        for (const key of [`note:${note.id}`, ...cards.map((card) => `card:${card.id}`), `noteMedia:${media.id}`]) {
          expect(await readDeletedEntity(target, key)).toMatchObject({ causes: [expectedCause] })
        }
      }
    } finally {
      await remote.removeLocalCollection()
    }
  })

  test('upgrades v6 note types to standard without changing card scheduling data', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(6).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
    await old.table('noteTypes').add({ id: 'old-type', name: 'Old', fields: [{ id: 'text', name: 'Text' }], templates: [{ id: 'old-template', name: 'Card', front: '{{Text}}', back: '{{Text}}', css: '' }], protected: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add({ id: 'old-card', deckId: 'deck-1', noteId: 'note-1', templateId: 'old-template', due: '2026-01-02', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-01-01' })
    old.close()
    collection = createCollection(databaseName)
    await expect(readNoteType(collection, 'old-type')).resolves.toMatchObject({ kind: 'standard' })
    await expect(readNoteType(collection, BASIC_NOTE_TYPE_ID)).resolves.toMatchObject({ kind: 'standard' })
    await expect(readCard(collection, 'old-card')).resolves.toMatchObject({ id: 'old-card', reps: 2, stability: 4 })
  })

  test('upgrades existing decks into the protected Default option group without changing their identities', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(8).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
    await old.table('decks').add({ id: 'legacy-deck', name: 'Legacy', createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    old.close()

    collection = createCollection(databaseName)

    await expect(readDeck(collection, 'legacy-deck')).resolves.toMatchObject({ id: 'legacy-deck', parentId: null, optionGroupId: 'default' })
    await expect(readDeckOptionGroup(collection, 'default')).resolves.toMatchObject({ id: 'default', name: 'Default', protected: true })
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  })

  test('upgrades reusable option groups with validated scheduling defaults without rewriting cards or reviews', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(9).stores({ decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt' })
    const card = directCard('legacy-card', 'legacy-deck', 'legacy-note', State.Review, '2026-10-01T00:00:00.000Z')
    const review = { id: 'legacy-review', cardId: card.id, deckId: card.deckId, rating: Rating.Good, state: State.Review, due: card.due, stability: 2, difficulty: 4, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 2, learningSteps: 0, reviewedAt: '2026-10-01T00:00:00.000Z' }
    await old.table('deckOptionGroups').add({ id: 'legacy-group', name: 'Legacy', protected: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add(card)
    await old.table('reviewEntries').add(review)
    old.close()

    collection = createCollection(databaseName)

    await expect(readDeckOptionGroup(collection, 'legacy-group')).resolves.toMatchObject({ dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due' })
    await expect(readCard(collection, card.id)).resolves.toMatchObject(card)
    await expect(readReviewEntry(collection, review.id)).resolves.toEqual(review)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: -1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/daily new/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/retention/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['soon'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/learning step/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due', leechThreshold: 0 })).rejects.toThrow(/leech threshold/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due', leechTag: ' ' })).rejects.toThrow(/leech tag/i)
  })

  test('upgrades v10 cards and option groups to durable scheduling policies', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(10).stores({ decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt' })
    const card = { ...directCard('legacy-policy-card', 'legacy-deck', 'legacy-note', State.Review, '2026-10-01T00:00:00.000Z'), suspended: true }
    const review = { id: 'legacy-policy-review', cardId: card.id, deckId: card.deckId, rating: Rating.Good, state: State.Review, due: card.due, stability: 2, difficulty: 4, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 2, learningSteps: 0, reviewedAt: '2026-10-01T00:00:00.000Z' }
    await old.table('deckOptionGroups').add({ id: 'legacy-policy-group', name: 'Legacy policy', protected: false, dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due', createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add(card)
    await old.table('reviewEntries').add(review)
    old.close()

    collection = createCollection(databaseName)

    await expect(readCard(collection, card.id)).resolves.toMatchObject({ ...card, manualSuspended: false, templateSuspended: true, buriedUntil: null })
    await expect(readReviewEntry(collection, review.id)).resolves.toEqual(review)
    await expect(readDeckOptionGroup(collection, 'legacy-policy-group')).resolves.toMatchObject({ buryNewSiblings: false, buryReviewSiblings: false, buryInterdayLearningSiblings: false, leechThreshold: 8, leechAction: 'suspend', leechTag: 'leech' })
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  })

  test('upgrades v18 cards with stable new-card positions, sibling positions, and template ordinals', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(18).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt', syncRevisions: 'opId, key', syncConflicts: 'key, entityType, entityId',
    })
    const createdAt = '2026-10-01T00:00:00.000Z'
    await old.table('deckOptionGroups').add({ id: 'default', name: 'Default', protected: true, dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due', interdayLearningOrder: 'before-reviews', buryNewSiblings: false, buryReviewSiblings: false, leechThreshold: 8, leechAction: 'suspend', leechTag: 'leech', createdAt, updatedAt: createdAt })
    await old.table('noteTypes').add({ id: 'basic', name: 'Basic', kind: 'standard', fields: [], templates: [{ id: 'second', name: 'Second', front: '', back: '', css: '' }, { id: 'first', name: 'First', front: '', back: '', css: '' }], protected: true, createdAt, updatedAt: createdAt })
    await old.table('notes').bulkAdd([
      { id: 'later', type: 'basic', typeId: 'basic', deckId: 'deck', fields: {}, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: createdAt },
      { id: 'earlier', type: 'basic', typeId: 'basic', deckId: 'deck', fields: {}, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: createdAt },
    ])
    const makeNewCard = (id: string, noteId: string, templateId: string): CardRecord => ({ id, noteId, deckId: 'deck', templateId, due: createdAt, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: State.New, lastReview: null })
    await old.table('cards').bulkAdd([
      makeNewCard('later-second', 'later', 'second'), makeNewCard('later-first', 'later', 'first'), makeNewCard('earlier-first', 'earlier', 'first'),
    ])
    old.close()

    collection = createCollection(databaseName)
    await expect(readCard(collection, 'earlier-first')).resolves.toMatchObject({ newPosition: 0, templateOrdinal: 1 })
    await expect(readCard(collection, 'later-second')).resolves.toMatchObject({ newPosition: 1, templateOrdinal: 0 })
    await expect(readCard(collection, 'later-first')).resolves.toMatchObject({ newPosition: 1, templateOrdinal: 1 })
    await expect(readDeckOptionGroup(collection, 'default')).resolves.toMatchObject({ newCardGatherOrder: 'deck', newCardSortOrder: 'template', newReviewOrder: 'mix', buryInterdayLearningSiblings: false })
  })

  test('upgrades v11 option groups with the explicit interday-learning order', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(11).stores({ decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt' })
    await old.table('deckOptionGroups').add({ id: 'v11-policy-group', name: 'V11 policy', protected: false, dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due', buryNewSiblings: false, buryReviewSiblings: false, leechThreshold: 8, leechAction: 'suspend', leechTag: 'leech', createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    old.close()

    collection = createCollection(databaseName)

    await expect(readDeckOptionGroup(collection, 'v11-policy-group')).resolves.toMatchObject({ newReviewOrder: 'mix', interdayLearningOrder: 'mix', buryInterdayLearningSiblings: false })
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  })

  test('rejects malformed or conflicting synchronized policy card fields', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const active = collection
    const deck = await active.createDeck('Policies')
    const note = await active.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(active, note.id).then(cards => cards[0]))!
    const operation = (opId: string, payload: unknown) => active.applyRemoteChanges([{ opId, entityType: 'card', entityId: card.id, action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload }], 1)

    await expect(operation('bad-manual-suspension', { ...card, manualSuspended: 'yes' })).rejects.toThrow(/manual suspension/i)
    await expect(operation('conflicting-suspension', { ...card, suspended: true, templateSuspended: false })).rejects.toThrow(/conflict/i)
    await expect(operation('bad-burial', { ...card, buriedUntil: 'tomorrow' })).rejects.toThrow(/burial time/i)
  })

  test('keeps manual suspension, burial, and rescheduling independent and durable', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Policies')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')

    await collection.suspendCard(card.id, now)
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([])
    await expect(readCard(collection, card.id)).resolves.toMatchObject({ manualSuspended: true, templateSuspended: false })
    await collection.unsuspendCard(card.id, now)
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([expect.objectContaining({ id: card.id })])

    await collection.buryCard(card.id, now)
    const buried = (await readCard(collection, card.id))!
    expect(buried.buriedUntil).toBe(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString())
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([])
    await expect(collection.dueCards(deck.id, new Date(buried.buriedUntil!))).resolves.toEqual([expect.objectContaining({ id: card.id })])
    await collection.unburyCard(card.id, now)

    await collection.updateCardSchedule(card.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3 })
    await applyRemoteFixtures(collection, 'review', [{ id: 'preserved-review', cardId: card.id, deckId: deck.id, rating: Rating.Good, state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 2, learningSteps: 0, reviewedAt: now.toISOString() }])
    const rescheduled = new Date('2026-10-03T09:00:00.000Z')
    await collection.rescheduleCard(card.id, rescheduled, now)
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([])
    await expect(readCard(collection, card.id)).resolves.toMatchObject({ due: rescheduled.toISOString(), state: State.Review, reps: 3 })
    await expect(readCardReviewHistory(collection, card.id)).resolves.toEqual([expect.objectContaining({ id: 'preserved-review' })])

    const reopened = createCollection(collection.databaseName)
    await expect(readCard(reopened, card.id)).resolves.toMatchObject({ manualSuspended: false, buriedUntil: null, due: rescheduled.toISOString() })
    await reopened.removeLocalCollection()
    collection = undefined
  })

  test('rejects previews and answers for future timed cards while keeping New cards eligible', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Policies')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')
    const future = new Date('2026-10-03T12:00:00.000Z')

    await collection.updateCardSchedule(card.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3 })
    await collection.rescheduleCard(card.id, future, now)
    await expect(collection.reviewChoices(card.id, now)).resolves.toEqual([])
    await expect(collection.answer(card.id, Rating.Good, now)).rejects.toThrow(/not due/i)

    for (const state of [State.Learning, State.Relearning]) {
      await collection.updateCardSchedule(card.id, { state, due: future.toISOString(), stability: 2, difficulty: 5, reps: 3, scheduledDays: state === State.Learning ? 0 : 1 })
      await expect(collection.reviewChoices(card.id, now)).resolves.toEqual([])
      await expect(collection.answer(card.id, Rating.Good, now)).rejects.toThrow(/not due/i)
    }
    await expect(readCardReviewHistory(collection, card.id).then(entries => entries.length)).resolves.toBe(0)

    await collection.updateCardSchedule(card.id, { state: State.New, due: future.toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0, scheduledDays: 0, learningSteps: 0, lastReview: null })
    await expect(collection.reviewChoices(card.id, now)).resolves.toHaveLength(4)
    await expect(collection.answer(card.id, Rating.Good, now)).resolves.toMatchObject({ cardId: card.id, rating: Rating.Good })
  })

  test('an ineligible card yields no review choices even when its deck policy is gone', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Choices')
    const note = await collection.createBasicNote(deck.id, { front: 'front', back: 'back' })
    const [card] = await readCardsForNote(collection, note.id)
    const now = new Date('2026-10-01T12:00:00.000Z')
    // An eligible card in a deck that has lost its option group is a real fault.
    await deleteIndexedDbFixtureRow(collection.databaseName, 'deckOptionGroups', deck.optionGroupId)
    await expect(collection.reviewChoices(card.id, now)).rejects.toThrow(/option group/i)
    // An ineligible one is refused on eligibility alone, before the deck policy
    // is read, so the reviewer's poll cannot fail on a card it would not show.
    await collection.suspendCard(card.id, now)
    await expect(collection.reviewChoices(card.id, now)).resolves.toEqual([])
    await expect(collection.reviewChoices(card.id, now, true)).resolves.toEqual([])
  })

  test('a card suspended only by the legacy flag stays ineligible for review', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Legacy suspension')
    const note = await collection.createBasicNote(deck.id, { front: 'front', back: 'back' })
    const [card] = await readCardsForNote(collection, note.id)
    const now = new Date('2026-10-01T12:00:00.000Z')
    // Package import and note-type deletion write `suspended` alone.
    await overwriteIndexedDbLegacyCard(collection.databaseName, { ...card, templateSuspended: false, suspended: true })
    await expect(collection.reviewChoices(card.id, now)).resolves.toEqual([])
    await expect(collection.reviewChoices(card.id, now, true)).resolves.toEqual([])
    await expect(collection.answer(card.id, Rating.Good, now)).rejects.toThrow(/suspended or buried/i)
  })

  test('does not let template reconciliation clear a manual suspension', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Policies')
    const type = await collection.createNoteType({ name: 'Term', fields: [{ name: 'Term' }], templates: [{ name: 'Forward', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')

    await collection.suspendCard(card.id, now)
    await collection.updateNote(note.id, { [type.fields[0].id]: '' }, now)
    await expect(readCard(collection, card.id)).resolves.toMatchObject({ manualSuspended: true, templateSuspended: true, suspended: true })
    await collection.updateNote(note.id, { [type.fields[0].id]: '猫' }, now)
    await expect(readCard(collection, card.id)).resolves.toMatchObject({ manualSuspended: true, templateSuspended: false, suspended: false })
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([])
    await collection.unsuspendCard(card.id, now)
    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([expect.objectContaining({ id: card.id })])
  })

  test('buries configured siblings and applies a leech tag and action atomically', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Bury siblings')
    await collection.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: true, buryReviewSiblings: true, leechThreshold: 1, leechAction: 'suspend', leechTag: ' leech ' })
    const deck = await collection.createDeck('Policies', { optionGroupId: group.id })
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const first = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const sibling = { ...directCard('sibling-card', deck.id, note.id, State.New, first.due), manualSuspended: false, templateSuspended: false, buriedUntil: null }
    await applyRemoteFixtures(collection, 'card', [sibling])
    const now = new Date('2026-10-01T12:00:00.000Z')

    await collection.answer(first.id, Rating.Good, now)
    await expect(readCard(collection, sibling.id)).resolves.toMatchObject({ buriedUntil: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString() })

    await collection.unburyCard(sibling.id, now)
    await collection.updateCardSchedule(sibling.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3, lapses: 0 })
    const review = await collection.answer(sibling.id, Rating.Again, now)
    await expect(readCard(collection, sibling.id)).resolves.toMatchObject({ manualSuspended: true, templateSuspended: false, buriedUntil: null })
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ tags: ['leech'] })
    await expect(readReviewEntry(collection, review.id)).resolves.toMatchObject({ cardId: sibling.id })
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'card', entityId: sibling.id, action: 'update' }),
      expect.objectContaining({ entityType: 'note', entityId: note.id, action: 'update' }),
      expect.objectContaining({ entityType: 'review', entityId: review.id, action: 'create' }),
    ]))

    await collection.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: false, buryReviewSiblings: false, leechThreshold: 1, leechAction: 'tag-only', leechTag: 'needs-attention' })
    const tagOnlyNote = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
    const tagOnlyCard = (await readCardsForNote(collection, tagOnlyNote.id).then(cards => cards[0]))!
    await collection.updateCardSchedule(tagOnlyCard.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3, lapses: 0 })
    await collection.answer(tagOnlyCard.id, Rating.Again, now)
    await expect(readCard(collection, tagOnlyCard.id)).resolves.toMatchObject({ manualSuspended: false })
    await expect(readNote(collection, tagOnlyNote.id)).resolves.toMatchObject({ tags: ['needs-attention'] })
  })

  test('buries later sibling types with separate review and interday-learning policies', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Bury learning siblings')
    await collection.updateDeckOptionGroup(group.id, {
      ...group,
      buryNewSiblings: false,
      buryReviewSiblings: true,
      buryInterdayLearningSiblings: false,
    })
    const deck = await collection.createDeck('Policies', { optionGroupId: group.id })
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const reviewed = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')
    const intraday = {
      ...directCard('intraday-learning-sibling', deck.id, note.id, State.Learning, new Date(now.getTime() - 60_000).toISOString()),
      manualSuspended: false,
      templateSuspended: false,
      buriedUntil: null,
      scheduledDays: 0,
    }
    const interday = {
      ...directCard('interday-relearning-sibling', deck.id, note.id, State.Relearning, new Date(now.getTime() - 60_000).toISOString()),
      manualSuspended: false,
      templateSuspended: false,
      buriedUntil: null,
      scheduledDays: 1,
    }
    const reviewSibling = { ...directCard('review-sibling', deck.id, note.id, State.Review, now.toISOString()), manualSuspended: false, templateSuspended: false, buriedUntil: null }
    await applyRemoteFixtures(collection, 'card', [intraday, interday, reviewSibling])
    await collection.updateCardSchedule(reviewed.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3 })

    await collection.answer(reviewed.id, Rating.Good, now)

    const nextBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString()
    await expect(readCard(collection, reviewSibling.id)).resolves.toMatchObject({ buriedUntil: nextBoundary })
    await expect(readCard(collection, intraday.id)).resolves.toMatchObject({ buriedUntil: null })
    await expect(readCard(collection, interday.id)).resolves.toMatchObject({ buriedUntil: null })
    const due = await collection.dueCards(deck.id, now)
    expect(due).toEqual(expect.arrayContaining([expect.objectContaining({ id: intraday.id }), expect.objectContaining({ id: interday.id })]))

    await collection.updateDeckOptionGroup(group.id, { ...group, buryReviewSiblings: false, buryInterdayLearningSiblings: true })
    const secondNote = await collection.createBasicNote(deck.id, { front: '鳥', back: 'bird' })
    const intradaySource = (await readCardsForNote(collection, secondNote.id).then(cards => cards[0]))!
    await collection.updateCardSchedule(intradaySource.id, { state: State.Learning, due: now.toISOString(), scheduledDays: 0 })
    const intradaySibling = { ...directCard('intraday-sibling', deck.id, secondNote.id, State.Relearning, now.toISOString()), manualSuspended: false, templateSuspended: false, buriedUntil: null, scheduledDays: 0 }
    const interdaySibling = { ...directCard('interday-sibling', deck.id, secondNote.id, State.Relearning, now.toISOString()), manualSuspended: false, templateSuspended: false, buriedUntil: null, scheduledDays: 1 }
    await applyRemoteFixtures(collection, 'card', [intradaySibling, interdaySibling])
    await collection.answer(intradaySource.id, Rating.Good, now)
    await expect(readCard(collection, intradaySibling.id)).resolves.toMatchObject({ buriedUntil: null })
    await expect(readCard(collection, interdaySibling.id)).resolves.toMatchObject({ buriedUntil: nextBoundary })
  })

  test('matches Anki sibling bury precedence for every answering card stage', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Complete sibling precedence')
    await collection.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: true, buryReviewSiblings: true, buryInterdayLearningSiblings: true })
    const deck = await collection.createDeck('Bury precedence', { optionGroupId: group.id })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const nextBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString()
    const stages = [
      { name: 'intraday', state: State.Learning, scheduledDays: 0, learningSteps: 1, stability: 1, difficulty: 5, reps: 1 },
      { name: 'interday', state: State.Relearning, scheduledDays: 1, learningSteps: 0, stability: 2, difficulty: 5, reps: 2 },
      { name: 'review', state: State.Review, scheduledDays: 5, learningSteps: 0, stability: 5, difficulty: 5, reps: 3 },
      { name: 'new', state: State.New, scheduledDays: 0, learningSteps: 0, stability: 0, difficulty: 0, reps: 0 },
    ] as const
    const priority = (name: string) => stages.findIndex((stage) => stage.name === name)

    for (const answeringStage of stages) {
      const note = await collection.createBasicNote(deck.id, { front: answeringStage.name, back: 'sibling test' })
      const [created] = await readCardsForNote(collection, note.id)
      const due = new Date(now.getTime() - 60_000).toISOString()
      const source = { ...created, ...answeringStage, due, lastReview: answeringStage.state === State.New ? null : due }
      await collection.updateCardSchedule(created.id, {
        state: source.state, due: source.due, stability: source.stability, difficulty: source.difficulty,
        elapsedDays: source.elapsedDays, scheduledDays: source.scheduledDays, learningSteps: source.learningSteps,
        reps: source.reps, lapses: source.lapses, lastReview: source.lastReview,
      })
      const siblings = stages.flatMap((stage) => [0, 1].map((copy) => ({
        ...directCard(`${answeringStage.name}-${stage.name}-${copy}`, deck.id, note.id, stage.state, due),
        ...stage,
        due,
        lastReview: stage.state === State.New ? null : due,
        manualSuspended: false,
        templateSuspended: false,
        suspended: false,
        buriedUntil: null,
      })))
      await applyRemoteFixtures(collection, 'card', siblings)

      await collection.answer(source.id, Rating.Good, now)

      for (const sibling of siblings) {
        const shouldBury = priority(sibling.name) >= priority(answeringStage.name) && sibling.name !== 'intraday'
        await expect(readCard(collection, sibling.id)).resolves.toMatchObject({ buriedUntil: shouldBury ? nextBoundary : null })
      }
    }
  })

  test('keeps interval previews and persisted states aligned for every rating', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Ratings')
    const now = new Date('2026-10-01T12:00:00.000Z')
    for (const [rating, label] of [[Rating.Again, 'Again'], [Rating.Hard, 'Hard'], [Rating.Good, 'Good'], [Rating.Easy, 'Easy']] as const) {
      const note = await collection.createBasicNote(deck.id, { front: label, back: label })
      const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
      const choice = (await collection.reviewChoices(card.id, now)).find((candidate) => candidate.rating === rating)!
      const review = await collection.answer(card.id, rating, now)
      const persisted = (await readCard(collection, card.id))!
      expect(review.rating).toBe(rating)
      expect(persisted.state).not.toBe(State.New)
      expect(intervalLabel(new Date(persisted.due), now)).toBe(choice.interval)
    }
  })

  test('stores pre-answer Anki values and the resulting schedule for each card state transition', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Review history meanings')
    const now = new Date('2026-10-01T12:00:00.000Z')
    const cases = [
      { name: 'New to Learning', initial: { state: State.New, due: now.toISOString(), stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, lastReview: null }, rating: Rating.Good, after: State.Learning },
      { name: 'Learning to Learning', initial: { state: State.Learning, due: now.toISOString(), stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 0, learningSteps: 1, reps: 1, lapses: 0, lastReview: now.toISOString() }, rating: Rating.Again, after: State.Learning },
      { name: 'Learning to Review', initial: { state: State.Learning, due: now.toISOString(), stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 0, learningSteps: 1, reps: 1, lapses: 0, lastReview: now.toISOString() }, rating: Rating.Easy, after: State.Review },
      { name: 'Review to Relearning', initial: { state: State.Review, due: now.toISOString(), stability: 5, difficulty: 5, elapsedDays: 2, scheduledDays: 5, learningSteps: 0, reps: 3, lapses: 0, lastReview: now.toISOString() }, rating: Rating.Again, after: State.Relearning },
      { name: 'Relearning to Review', initial: { state: State.Relearning, due: now.toISOString(), stability: 2, difficulty: 6, elapsedDays: 1, scheduledDays: 2, learningSteps: 1, reps: 4, lapses: 1, lastReview: now.toISOString() }, rating: Rating.Easy, after: State.Review },
    ] as const
    for (const scenario of cases) {
      const note = await collection.createBasicNote(deck.id, { front: scenario.name, back: 'result' })
      const [created] = await readCardsForNote(collection, note.id)
      const initial = { ...created, ...scenario.initial }
      await collection.updateCardSchedule(created.id, scenario.initial)
      const result = await collection.answer(created.id, scenario.rating, now)
      const after = (await readCard(collection, created.id))!
      const stored = (await readReviewEntry(collection, result.id))!
      expect(stored).toMatchObject({ state: initial.state, due: initial.due, scheduledDays: initial.scheduledDays, afterState: scenario.after, afterDue: after.due, afterScheduledDays: after.scheduledDays })
    }
  })

  test('keeps preview, persisted answer state, history, and reload aligned across every state and grade', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Scheduler grade matrix')
    const now = new Date('2026-10-01T12:00:00.000Z')
    const stateCases = [
      { state: State.New, name: 'New', initial: { stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, lastReview: null } },
      { state: State.Learning, name: 'Learning', initial: { stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 0, learningSteps: 1, reps: 1, lapses: 0, lastReview: now.toISOString() } },
      { state: State.Review, name: 'Review', initial: { stability: 30, difficulty: 5, elapsedDays: 30, scheduledDays: 30, learningSteps: 0, reps: 4, lapses: 0, lastReview: new Date(now.getTime() - 30 * 86_400_000).toISOString() } },
      { state: State.Relearning, name: 'Relearning', initial: { stability: 2, difficulty: 6, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 4, lapses: 1, lastReview: now.toISOString() } },
    ] as const
    const grades = [
      { rating: Rating.Again, label: 'Again' },
      { rating: Rating.Hard, label: 'Hard' },
      { rating: Rating.Good, label: 'Good' },
      { rating: Rating.Easy, label: 'Easy' },
    ] as const
    const expected: { cardId: string; reviewId: string; rating: number; choice: string }[] = []

    for (const stateCase of stateCases) {
      for (const grade of grades) {
        const note = await collection.createBasicNote(deck.id, { front: `${stateCase.name} ${grade.label}`, back: 'matrix' })
        const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
        await collection.updateCardSchedule(card.id, { ...stateCase.initial, state: stateCase.state, due: now.toISOString() })
        const choices = await collection.reviewChoices(card.id, now, true)
        const choice = choices.find((candidate) => candidate.rating === grade.rating)
        expect(choice).toBeDefined()
        const review = await collection.answer(card.id, grade.rating, now, undefined, { allowEarly: true, reschedule: true })
        const persisted = (await readCard(collection, card.id))!
        const history = (await readReviewEntry(collection, review.id))!
        expect(intervalLabel(new Date(persisted.due), now)).toBe(choice!.interval)
        expect(history).toMatchObject({
          rating: grade.rating,
          state: stateCase.state,
          afterState: persisted.state,
          afterDue: persisted.due,
          afterScheduledDays: persisted.scheduledDays,
        })
        expected.push({ cardId: card.id, reviewId: review.id, rating: grade.rating, choice: choice!.interval })
      }
    }

    collection.closeLocalCollection()
    await collection.openLocalCollection()
    for (const item of expected) {
      const card = (await readCard(collection, item.cardId))!
      const review = (await readReviewEntry(collection, item.reviewId))!
      expect(review.rating).toBe(item.rating)
      expect(review.afterDue).toBe(card.due)
      expect(intervalLabel(new Date(card.due), now)).toBe(item.choice)
    }
  })

  test('converges durable manual policy changes between two clients', async () => {
    const source = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const now = new Date('2026-10-01T12:00:00.000Z')
      const createdAt = new Date('2026-10-01T11:59:00.000Z')
      const deck = await source.createDeck('Sync policy', createdAt)
      const note = await source.createBasicNote(deck.id, { front: '猫', back: 'cat' }, createdAt)
      const card = (await readCardsForNote(source, note.id).then(cards => cards[0]))!
      await source.suspendCard(card.id, now)
      await source.buryCard(card.id, new Date('2026-10-01T12:01:00.000Z'))
      await source.rescheduleCard(card.id, new Date('2026-10-03T12:00:00.000Z'), new Date('2026-10-01T12:02:00.000Z'))
      const outbound = await source.pendingOperations()
      await remote.applyRemoteChanges(outbound, outbound.length)

      await expect(readCard(remote, card.id)).resolves.toMatchObject({ manualSuspended: true, templateSuspended: false, buriedUntil: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString(), due: '2026-10-03T12:00:00.000Z', state: State.Review })
      await remote.unsuspendCard(card.id, new Date('2026-10-01T12:01:00.000Z'))
      const returnOperations = await remote.pendingOperations()
      await source.applyRemoteChanges(returnOperations, outbound.length + returnOperations.length)
      await expect(readCard(source, card.id)).resolves.toMatchObject({ manualSuspended: false, buriedUntil: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString(), due: '2026-10-03T12:00:00.000Z' })
    } finally {
      await source.removeLocalCollection()
      await remote.removeLocalCollection()
    }
  })

  test('undo restores scheduling, review log, leech tag, and sibling burial before sync', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Undo policy')
    await collection.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: true, leechThreshold: 1, leechAction: 'suspend', leechTag: 'leech' })
    const deck = await collection.createDeck('Undo review', { optionGroupId: group.id })
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')
    await collection.updateCardSchedule(card.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3 })
    const sibling = directCard('undo-sibling', deck.id, note.id, State.New, now.toISOString())
    await applyRemoteFixtures(collection, 'card', [sibling])
    const before = (await readCard(collection, card.id))!
    const pendingBefore = (await collection.pendingOperations()).map((operation) => operation.opId)
    const review = await collection.answer(card.id, Rating.Again, now)
    expect(await readCard(collection, card.id)).toMatchObject({ manualSuspended: true })
    expect(await readCard(collection, sibling.id)).toMatchObject({ buriedUntil: expect.any(String) })
    expect(await readNote(collection, note.id)).toMatchObject({ tags: ['leech'] })

    await expect(collection.undo()).resolves.toBe(card.id)
    expect(await readCard(collection, card.id)).toEqual(before)
    expect(await readCard(collection, sibling.id)).toMatchObject(sibling)
    expect(await readNote(collection, note.id)).toEqual(note)
    expect(await readReviewEntry(collection, review.id)).toBeUndefined()
    expect((await collection.pendingOperations()).map((operation) => operation.opId)).toEqual(pendingBefore)
  })

  test('review undo refuses an in-flight sync attempt or later card edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Undo boundary')
    const note = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')
    const review = await collection.answer(card.id, Rating.Good, now)
    await collection.beginSyncAttempt()
    await expect(collection.latestReviewUndo()).resolves.toBeNull()
    await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
    expect(await readReviewEntry(collection, review.id)).toBeDefined()

    await collection.updateCardSchedule(card.id, { due: now.toISOString() })
    await collection.answer(card.id, Rating.Good, now)
    await collection.setCardFlag(card.id, 1, now)
    // A later edit to the same card invalidates the record that captured it.
    await applyRemoteFixtures(collection, 'card', [{ ...(await readCard(collection, card.id))!, flag: 7 }], 'update')
    await expect(collection.undo()).rejects.toThrow(/changed since/i)
  })

  test('deleting and undoing a note restores its cards, reviews, and media before sync', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const createdAt = new Date('2026-10-01T11:59:00.000Z')
    const deck = await collection.createDeck('Delete note', createdAt)
    const note = await collection.createBasicNote(deck.id, { front: '音', back: 'sound' }, createdAt)
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const media = await collection.attachMedia(note.id, { file: new File(['sound'], 'sound.mp3', { type: 'audio/mpeg' }), side: 'front' })
    const review = await collection.answer(card.id, Rating.Good, new Date('2026-10-01T12:00:00.000Z'))
    const answered = (await readCard(collection, card.id))!
    await collection.deleteNote(note.id, new Date('2026-10-01T12:01:00.000Z'))
    expect(await readNote(collection, note.id)).toBeUndefined()
    expect(await readCard(collection, card.id)).toBeUndefined()
    expect(await readReviewEntry(collection, review.id)).toBeUndefined()
    expect(await readNoteMediaReference(collection, media.id)).toBeUndefined()
    expect(await readDeletedEntity(collection, `note:${note.id}`)).toBeDefined()

    await expect(collection.undo()).resolves.toBe(note.id)
    expect(await readNote(collection, note.id)).toEqual(note)
    expect(await readCard(collection, card.id)).toEqual(answered)
    expect(await readReviewEntry(collection, review.id)).toEqual(review)
    expect(await readNoteMediaReference(collection, media.id)).toEqual(media)
    expect(await readDeletedEntity(collection, `note:${note.id}`)).toBeUndefined()
    expect((await collection.pendingOperations()).some((operation) => operation.entityType === 'note' && operation.entityId === note.id && operation.action === 'delete')).toBe(false)

    await collection.deleteNote(note.id, new Date('2026-10-01T12:02:00.000Z'))
    await collection.beginSyncAttempt()
    await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
  })

  test('note deletion syncs its child tombstones and suppresses stale offline card edits', async () => {
    const source = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const createdAt = new Date('2026-10-01T11:59:00.000Z')
      const deck = await source.createDeck('Delete sync', createdAt)
      const note = await source.createBasicNote(deck.id, { front: '古い', back: 'old' }, createdAt)
      const card = (await readCardsForNote(source, note.id).then(cards => cards[0]))!
      const created = await source.pendingOperations()
      await remote.applyRemoteChanges(created, created.length)
      await source.deleteNote(note.id, new Date('2026-10-01T12:00:00.000Z'))
      const deletion = (await source.pendingOperations()).filter((operation) => operation.action === 'delete')
      await remote.applyRemoteChanges(deletion, created.length + deletion.length)
      expect(await readNote(remote, note.id)).toBeUndefined()
      expect(await readCard(remote, card.id)).toBeUndefined()
      expect(await readDeletedEntity(remote, `card:${card.id}`)).toBeDefined()
      await remote.applyRemoteChanges([{ opId: 'stale-card', entityType: 'card', entityId: card.id, action: 'update', occurredAt: '2026-10-01T12:01:00.000Z', payload: { ...card, flag: 1 } }], created.length + deletion.length + 1)
      expect(await readCard(remote, card.id)).toBeUndefined()
      await remote.applyRemoteChanges([{ opId: 'stale-review', entityType: 'review', entityId: 'stale-review', action: 'create', occurredAt: '2026-10-01T12:02:00.000Z', payload: { id: 'stale-review', cardId: card.id, deckId: deck.id } }], created.length + deletion.length + 2)
      expect(await readReviewEntry(remote, 'stale-review')).toBeUndefined()
    } finally {
      await source.removeLocalCollection()
      await remote.removeLocalCollection()
    }
  })

  test('note deletion undo cannot restore material into a subsequently deleted deck', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Deleted parent')
    const note = await collection.createBasicNote(deck.id, { front: '消す', back: 'delete' })
    await collection.deleteNote(note.id)
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await expect(collection.latestNoteDeletionUndo()).resolves.toBeNull()
    await expect(collection.undo()).rejects.toThrow(/original deck/i)
    expect(await readNote(collection, note.id)).toBeUndefined()
  })

  test('note deletion undo refuses a changed note type instead of restoring obsolete cards', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Changed template')
    const type = await collection.createNoteType({ name: 'Term', fields: [{ name: 'Term' }], templates: [{ name: 'Forward', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    await collection.deleteNote(note.id)
    await collection.updateNoteType(type.id, { ...type, templates: [{ ...type.templates[0], front: 'Changed {{Term}}' }] })
    await expect(collection.latestNoteDeletionUndo()).resolves.toBeNull()
    await expect(collection.undo()).rejects.toThrow(/note type changed/i)
    expect(await readNote(collection, note.id)).toBeUndefined()
  })

  test('card maintenance undo restores suspension and burial only before sync', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Card undo')
    const note = await collection.createBasicNote(deck.id, { front: '戻す', back: 'restore' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const now = new Date('2026-10-01T12:00:00.000Z')
    const before = (await readCard(collection, card.id))!
    const pendingBefore = (await collection.pendingOperations()).map((operation) => operation.opId)

    await collection.suspendCard(card.id, now)
    await expect(collection.undo()).resolves.toBe(card.id)
    expect(await readCard(collection, card.id)).toEqual(before)
    expect((await collection.pendingOperations()).map((operation) => operation.opId)).toEqual(pendingBefore)

    await collection.buryCard(card.id, now)
    await expect(collection.latestCardMaintenanceUndo()).resolves.toMatchObject({ action: 'bury' })
    await collection.undo()
    expect(await readCard(collection, card.id)).toEqual(before)

    await collection.setCardFlag(card.id, 1, now)
    await collection.beginSyncAttempt()
    await expect(collection.latestCardMaintenanceUndo()).resolves.toBeNull()
    await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
    expect(await readCard(collection, card.id)).toMatchObject({ flag: 1 })
  })

  test('preserves and syncs a card flag across review scheduling', async () => {
    const source = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const createdAt = new Date('2026-10-01T11:59:00.000Z')
      const deck = await source.createDeck('Flagged', createdAt)
      const note = await source.createBasicNote(deck.id, { front: '旗', back: 'flag' }, createdAt)
      const card = (await readCardsForNote(source, note.id).then(cards => cards[0]))!
      await source.setCardFlag(card.id, 1, new Date('2026-10-01T12:00:00.000Z'))
      await source.answer(card.id, Rating.Good, new Date('2026-10-01T12:01:00.000Z'))
      expect(await readCard(source, card.id)).toMatchObject({ flag: 1, reps: 1 })
      const outbound = await source.pendingOperations()
      await remote.applyRemoteChanges(outbound, outbound.length)
      expect(await readCard(remote, card.id)).toMatchObject({ flag: 1, reps: 1 })
      await expect(source.setCardFlag(card.id, 8)).rejects.toThrow('Card flag is invalid')
    } finally {
      await source.removeLocalCollection()
      await remote.removeLocalCollection()
    }
  })

  test('converges answer-side sibling burial and leech actions as one sync batch', async () => {
    const source = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const type = await source.createNoteType({ name: 'Two cards', fields: [{ name: 'Term' }], templates: [
        { name: 'Forward', front: '{{Term}}', back: '{{Term}}', css: '' },
        { name: 'Reverse', front: '{{Term}}', back: '{{Term}}', css: '' },
      ] }, new Date('2026-10-01T08:00:00.000Z'))
      const group = await source.createDeckOptionGroup('Policies', new Date('2026-10-01T08:01:00.000Z'))
      await source.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: true, buryReviewSiblings: true, leechThreshold: 1, leechAction: 'suspend', leechTag: 'leech' }, new Date('2026-10-01T08:02:00.000Z'))
      const deck = await source.createDeck('Sync policy', { optionGroupId: group.id }, new Date('2026-10-01T08:03:00.000Z'))
      const note = await source.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' }, new Date('2026-10-01T08:04:00.000Z'))
      const [reviewed, sibling] = await readCardsForNote(source, note.id).then(cards => cards.sort((left, right) => left.id.localeCompare(right.id)))
      const now = new Date('2026-10-01T12:00:00.000Z')
      await source.updateCardSchedule(reviewed.id, { state: State.Review, due: now.toISOString(), stability: 2, difficulty: 5, reps: 3, lapses: 0 })
      await source.answer(reviewed.id, Rating.Again, now)
      const changes = await source.pendingOperations()

      await remote.applyRemoteChanges(changes, changes.length)

      await expect(readCard(remote, reviewed.id)).resolves.toMatchObject({ manualSuspended: true })
      await expect(readCard(remote, sibling.id)).resolves.toMatchObject({ buriedUntil: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4).toISOString() })
      await expect(readNote(remote, note.id)).resolves.toMatchObject({ tags: ['leech'] })
      await expect(readCardReviewHistory(remote, reviewed.id).then(reviews => reviews.length)).resolves.toBe(1)
    } finally {
      await source.removeLocalCollection()
      await remote.removeLocalCollection()
    }
  })

  test('uses a shared option group for future scheduling while preserving existing history and card state', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Slow learning')
    const first = await collection.createDeck('First', { optionGroupId: group.id })
    const second = await collection.createDeck('Second', { optionGroupId: group.id })
    const firstNote = await collection.createBasicNote(first.id, { front: '一', back: 'one' }, new Date('2026-10-01T08:00:00.000Z'))
    const secondNote = await collection.createBasicNote(second.id, { front: '二', back: 'two' }, new Date('2026-10-01T08:00:00.000Z'))
    const firstCard = (await readCardsForNote(collection, firstNote.id).then(cards => cards[0]))!
    const secondCard = (await readCardsForNote(collection, secondNote.id).then(cards => cards[0]))!
    const settings: SchedulingSettings = { dailyNewLimit: 5, dailyReviewLimit: 15, desiredRetention: 0.9, learningSteps: ['2h'], relearningSteps: ['30m'], newCardOrder: 'added', reviewCardOrder: 'due' }

    await collection.updateDeckOptionGroup(group.id, settings, new Date('2026-10-01T09:00:00.000Z'))
    await expect(readDeckOptionGroup(collection, group.id)).resolves.toMatchObject(settings)
    await expect(collection.reviewChoices(firstCard.id, new Date('2026-10-01T10:00:00.000Z'))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Again', interval: '2h' })]))
    await expect(collection.reviewChoices(secondCard.id, new Date('2026-10-01T10:00:00.000Z'))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Again', interval: '2h' })]))

    await collection.answer(firstCard.id, Rating.Good, new Date('2026-10-01T10:00:00.000Z'))
    const scheduled = await readCard(collection, firstCard.id)
    const history = await readCardReviewHistory(collection, firstCard.id)
    await collection.updateDeckOptionGroup(group.id, { ...settings, desiredRetention: 0.95, learningSteps: ['4h'] }, new Date('2026-10-01T11:00:00.000Z'))

    await expect(readCard(collection, firstCard.id)).resolves.toEqual(scheduled)
    await expect(readCardReviewHistory(collection, firstCard.id)).resolves.toEqual(history)
  })

  test('syncs Default settings while rejecting a changed protected-group identity', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const defaults = (await readDeckOptionGroup(collection, 'default'))!
    const changedSettings = { ...defaults, dailyNewLimit: 7, updatedAt: '2026-10-01T10:00:00.000Z' }

    await collection.applyRemoteChanges([{ opId: 'default-settings', entityType: 'deckOptionGroup', entityId: defaults.id, action: 'update', occurredAt: changedSettings.updatedAt, payload: changedSettings }], 1)
    await expect(readDeckOptionGroup(collection, defaults.id)).resolves.toMatchObject({ name: 'Default', protected: true, dailyNewLimit: 7 })
    await expect(collection.applyRemoteChanges([{ opId: 'changed-default-name', entityType: 'deckOptionGroup', entityId: defaults.id, action: 'update', occurredAt: '2026-10-01T10:01:00.000Z', payload: { ...changedSettings, name: 'Changed default', updatedAt: '2026-10-01T10:01:00.000Z' } }], 2)).rejects.toThrow(/Default deck option group/i)
  })

  test('aggregates descendant queues while enforcing each owning deck option group daily caps from review pre-state', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const active = collection
    const root = await active.createDeck('Root')
    const childGroup = await active.createDeckOptionGroup('Child limits')
    const child = await active.createDeck('Child', { parentId: root.id, optionGroupId: childGroup.id })
    await active.updateDeckOptionGroup(childGroup.id, { dailyNewLimit: 2, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due' })
    const rootNote = await active.createBasicNote(root.id, { front: 'root', back: 'root' }, new Date('2026-10-01T08:00:00.000Z'))
    const childNotes = await Promise.all(['a', 'b', 'c'].map((front) => active.createBasicNote(child.id, { front, back: front }, new Date('2026-10-01T08:00:00.000Z'))))
    const childCards = await Promise.all(childNotes.map((note) => readCardsForNote(active, note.id).then(cards => cards[0])))
    const reviewedNew = childCards[0]!
    await collection.updateCardSchedule(reviewedNew.id, { state: State.Learning, due: '2026-10-02T08:00:00.000Z' })
    await applyRemoteFixtures(collection, 'review', [{ id: 'already-new', cardId: reviewedNew.id, deckId: child.id, rating: Rating.Good, state: State.New, due: '2026-10-02T08:00:00.000Z', stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 1, reviewedAt: '2026-10-01T09:00:00.000Z' }])
    const reviewed = directCard('reviewed', child.id, 'reviewed-note', State.Learning, '2026-10-01T08:00:00.000Z')
    const reviewDue = directCard('review-due', child.id, 'review-note', State.Review, '2026-10-01T08:00:00.000Z')
    await applyRemoteFixtures(collection, 'note', [directNote('reviewed-note', child.id), directNote('review-note', child.id)])
    await applyRemoteFixtures(collection, 'card', [reviewed, reviewDue])
    await applyRemoteFixtures(collection, 'review', [{ id: 'already-review', cardId: reviewed.id, deckId: child.id, rating: Rating.Good, state: State.Review, due: reviewed.due, stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 1, learningSteps: 0, reviewedAt: '2026-10-01T09:00:00.000Z' }])

    const queue = await collection.dueCards(root.id, new Date('2026-10-01T12:00:00.000Z'))

    expect(queue.map((card) => card.id)).toEqual(expect.arrayContaining([(await readCardsForNote(collection, rootNote.id).then(cards => cards[0]))!.id]))
    expect(queue.filter((card) => card.deckId === child.id && card.state === State.New)).toHaveLength(0)
    expect(queue).toEqual(expect.arrayContaining([expect.objectContaining({ id: reviewed.id })]))
    expect(queue.find((card) => card.id === reviewDue.id)).toBeUndefined()
  })

  test('keeps intraday learning due-prioritized while interday learning shares the configured review cap and order', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Learning policy')
    await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 1, dailyReviewLimit: 1, interdayLearningOrder: 'before-reviews' })
    const deck = await collection.createDeck('Learning', { optionGroupId: group.id })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const intradayFirst = { ...directCard('intraday-first', deck.id, 'intraday-note', State.Learning, '2026-10-01T10:00:00.000Z'), scheduledDays: 0 }
    const intradaySecond = { ...directCard('intraday-second', deck.id, 'intraday-note-2', State.Relearning, '2026-10-01T11:00:00.000Z'), scheduledDays: 0 }
    const interday = { ...directCard('interday', deck.id, 'interday-note', State.Learning, '2026-10-01T09:00:00.000Z'), scheduledDays: 1 }
    const review = directCard('review', deck.id, 'review-note', State.Review, '2026-10-01T08:00:00.000Z')
    const firstNew = directCard('new-first', deck.id, 'new-note', State.New, '2026-10-01T07:00:00.000Z')
    const secondNew = directCard('new-second', deck.id, 'new-note-2', State.New, '2026-10-01T07:01:00.000Z')
    await applyRemoteFixtures(collection, 'note', [intradayFirst, intradaySecond, interday, review, firstNew, secondNew].map((card) => directNote(card.noteId, deck.id)))
    await applyRemoteFixtures(collection, 'card', [intradayFirst, intradaySecond, interday, review, firstNew, secondNew])

    await expect(collection.dueCards(deck.id, now)).resolves.toEqual([
      expect.objectContaining({ id: intradayFirst.id }),
      expect.objectContaining({ id: intradaySecond.id }),
      expect.objectContaining({ id: interday.id }),
    ])

    await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 1, dailyReviewLimit: 1, interdayLearningOrder: 'after-reviews' })
    const reviewFirst = await collection.dueCards(deck.id, now)
    expect(reviewFirst.map((card) => card.id)).toEqual([intradayFirst.id, intradaySecond.id, interday.id])

    await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 0, dailyReviewLimit: 5, interdayLearningOrder: 'mix' })
    expect((await collection.dueCards(deck.id, now)).map((card) => card.id)).toEqual([intradayFirst.id, intradaySecond.id, review.id, interday.id])

    await applyRemoteFixtures(collection, 'review', [{ id: 'already-interday', cardId: interday.id, deckId: deck.id, rating: Rating.Good, state: State.Learning, due: interday.due, stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 1, learningSteps: 1, reviewedAt: now.toISOString() }])
    await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 1, dailyReviewLimit: 1, interdayLearningOrder: 'after-reviews' })
    const capped = await collection.dueCards(deck.id, now)
    expect(capped.map((card) => card.id)).toEqual([intradayFirst.id, intradaySecond.id])
  })

  test('uses child gathering caps and the selected parent total review cap', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const rootGroup = await collection.createDeckOptionGroup('Root display')
    const childGroup = await collection.createDeckOptionGroup('Child gather')
    await collection.updateDeckOptionGroup(rootGroup.id, { ...rootGroup, dailyReviewLimit: 1, interdayLearningOrder: 'before-reviews' })
    await collection.updateDeckOptionGroup(childGroup.id, { ...childGroup, dailyReviewLimit: 1, interdayLearningOrder: 'after-reviews' })
    const root = await collection.createDeck('Root', { optionGroupId: rootGroup.id })
    const child = await collection.createDeck('Child', { parentId: root.id, optionGroupId: childGroup.id })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const rootInterday = { ...directCard('root-interday', root.id, 'root-interday-note', State.Learning, '2026-10-01T09:00:00.000Z'), scheduledDays: 1 }
    const rootReview = directCard('root-review', root.id, 'root-review-note', State.Review, '2026-10-01T08:00:00.000Z')
    const childInterday = { ...directCard('child-interday', child.id, 'child-interday-note', State.Relearning, '2026-10-01T09:00:00.000Z'), scheduledDays: 1 }
    const childReview = directCard('child-review', child.id, 'child-review-note', State.Review, '2026-10-01T08:00:00.000Z')
    await applyRemoteFixtures(collection, 'note', [rootInterday, rootReview, childInterday, childReview].map((card) => directNote(card.noteId, card.deckId)))
    await applyRemoteFixtures(collection, 'card', [rootInterday, rootReview, childInterday, childReview])

    const queue = await collection.dueCards(root.id, now)

    expect(queue.map((card) => card.id)).toEqual([rootInterday.id])
    await expect(collection.dueCards(child.id, now)).resolves.toEqual([expect.objectContaining({ id: childInterday.id })])
    await applyRemoteFixtures(collection, 'review', [{ id: 'child-reviewed-today', cardId: childReview.id, deckId: child.id, rating: Rating.Good, state: State.Review, due: childReview.due, stability: 10, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 1, learningSteps: 0, reviewedAt: now.toISOString() }])
    await expect(collection.dueCards(root.id, now)).resolves.toEqual([])
  })

  test('mixes reviews and new cards evenly using the selected deck display policy', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Mixed queue')
    await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 2, dailyReviewLimit: 10 })
    const deck = await collection.createDeck('Mixed', { optionGroupId: group.id })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const reviews = [1, 2, 3, 4, 5].map((index) => directCard(`review-${index}`, deck.id, `review-note-${index}`, State.Review, `2026-10-01T0${index}:00:00.000Z`))
    const newCards = [1, 2].map((index) => directCard(`new-${index}`, deck.id, `new-note-${index}`, State.New, `2026-10-01T0${index}:30:00.000Z`))
    await applyRemoteFixtures(collection, 'note', [...reviews, ...newCards].map((card) => directNote(card.noteId, deck.id)))
    await applyRemoteFixtures(collection, 'card', [...reviews, ...newCards])

    const defaultMix = await collection.dueCards(deck.id, now)
    expect(defaultMix.map((card) => card.state === State.New ? 'new' : 'review')).toEqual(['review', 'review', 'new', 'review', 'review', 'new', 'review'])

    await collection.updateDeckOptionGroup(group.id, { ...group, newReviewOrder: 'before-reviews' })
    expect((await collection.dueCards(deck.id, now)).map((card) => card.state === State.New ? 'new' : 'review')).toEqual(['new', 'new', 'review', 'review', 'review', 'review', 'review'])

    await collection.updateDeckOptionGroup(group.id, { ...group, newReviewOrder: 'after-reviews' })
    expect((await collection.dueCards(deck.id, now)).map((card) => card.state === State.New ? 'new' : 'review')).toEqual(['review', 'review', 'review', 'review', 'review', 'new', 'new'])
  })

  test('applies the selected parent new-card total after subdeck gather limits', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const rootGroup = await collection.createDeckOptionGroup('Selected parent limit')
    const childGroup = await collection.createDeckOptionGroup('Child gather limit')
    await collection.updateDeckOptionGroup(rootGroup.id, { ...rootGroup, dailyNewLimit: 1 })
    await collection.updateDeckOptionGroup(childGroup.id, { ...childGroup, dailyNewLimit: 2 })
    const root = await collection.createDeck('Root', { optionGroupId: rootGroup.id })
    const child = await collection.createDeck('Child', { parentId: root.id, optionGroupId: childGroup.id })
    await collection.createBasicNote(root.id, { front: 'root new', back: 'root new' })
    await collection.createBasicNote(child.id, { front: 'child new 1', back: 'child new 1' })
    await collection.createBasicNote(child.id, { front: 'child new 2', back: 'child new 2' })
    const now = new Date('2026-10-01T12:00:00.000Z')

    await expect(collection.dueCards(root.id, now)).resolves.toHaveLength(1)
    await expect(collection.dueCards(child.id, now)).resolves.toHaveLength(2)
  })

  test('the selected parent review cap also limits new cards gathered from subdecks', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const rootGroup = await collection.createDeckOptionGroup('Parent shared cap')
    const childGroup = await collection.createDeckOptionGroup('Child gather capacity')
    await collection.updateDeckOptionGroup(rootGroup.id, { ...rootGroup, dailyNewLimit: 10, dailyReviewLimit: 2 })
    await collection.updateDeckOptionGroup(childGroup.id, { ...childGroup, dailyNewLimit: 10, dailyReviewLimit: 10 })
    const root = await collection.createDeck('Root', { optionGroupId: rootGroup.id })
    const child = await collection.createDeck('Child', { parentId: root.id, optionGroupId: childGroup.id })
    for (const front of ['a', 'b', 'c']) await collection.createBasicNote(child.id, { front, back: front })
    const now = new Date('2026-10-01T12:00:00.000Z')

    await expect(collection.dueCards(root.id, now)).resolves.toHaveLength(2)
    await expect(collection.dueCards(child.id, now)).resolves.toHaveLength(3)
  })

  test('summaries preserve nested totals, empty decks, reviews, and custom study membership', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const parent = await collection.createDeck('Japanese')
    const child = await collection.createDeck('Verbs', { parentId: parent.id })
    const grandchild = await collection.createDeck('Godan', { parentId: child.id })
    const empty = await collection.createDeck('Empty')
    const parentNote = await collection.createBasicNote(parent.id, { front: '読む', back: 'read' })
    const childNote = await collection.createBasicNote(child.id, { front: '書く', back: 'write' })
    const grandchildNote = await collection.createBasicNote(grandchild.id, { front: '泳ぐ', back: 'swim' })
    const parentCard = (await readCardsForNote(collection, parentNote.id).then(cards => cards[0]))!
    const childCard = (await readCardsForNote(collection, childNote.id).then(cards => cards[0]))!
    const grandchildCard = (await readCardsForNote(collection, grandchildNote.id).then(cards => cards[0]))!
    await collection.updateCardSchedule(childCard.id, { state: State.Learning })
    await collection.updateCardSchedule(grandchildCard.id, { state: State.Review })
    await applyRemoteFixtures(collection, 'review', [
      { id: 'parent-review', cardId: parentCard.id, deckId: parent.id },
      { id: 'grandchild-review', cardId: grandchildCard.id, deckId: grandchild.id },
    ])
    await createCustomStudy(collection, { name: 'Practice', search: '読む OR 泳ぐ', limit: 2, order: 'added', reschedule: false }, new Date('2026-10-01T12:00:00.000Z'))

    const summaries = await collection.summaries()
    const byId = new Map(summaries.map((summary) => [summary.id, summary]))

    expect(byId.get(parent.id)).toMatchObject({ noteCount: 3, reviewCount: 2, sessionCount: 2, counts: { new: 1, learning: 1, review: 1 } })
    expect(byId.get(child.id)).toMatchObject({ noteCount: 2, reviewCount: 1, sessionCount: 1, counts: { new: 0, learning: 1, review: 1 } })
    expect(byId.get(grandchild.id)).toMatchObject({ noteCount: 1, reviewCount: 1, sessionCount: 1, counts: { new: 0, learning: 0, review: 1 } })
    expect(byId.get(empty.id)).toMatchObject({ noteCount: 0, reviewCount: 0, sessionCount: 0, counts: { new: 0, learning: 0, review: 0 } })
  })

  test('returns an empty queue when an active deck has been deleted in another tab', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Transient')
    await collection.createBasicNote(deck.id, { front: '前', back: 'back' })
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })

    await expect(collection.dueCards(deck.id, new Date('2026-10-01T12:00:00.000Z'))).resolves.toEqual([])
  })

  test('rejects relocation that would duplicate a destination child name', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const source = await collection.createDeck('Source')
    const destination = await collection.createDeck('Destination')
    await collection.createDeck('Words', { parentId: source.id })
    await collection.createDeck('Words', { parentId: destination.id })

    await expect(collection.deleteDeck(source.id, { mode: 'relocate', destinationDeckId: destination.id })).rejects.toThrow(/unique among siblings/i)
  })

  test('applies new-card caps to the learner local study day across the 4am rollover and UTC midnight offset', async () => {
    const runtime = (globalThis as unknown as { process: NodeRuntime }).process
    if (runtime.env.KIROKU_LOCAL_DAY_CHILD !== '1') {
      const moduleName = ['node', 'child_process'].join(':')
      const { spawnSync } = await import(/* @vite-ignore */ moduleName) as { spawnSync: SpawnSync }
      const child = spawnSync(runtime.execPath, [`${runtime.cwd()}/node_modules/vitest/vitest.mjs`, 'run', 'src/collection.test.ts', '-t', 'applies new-card caps to the learner local study day'], {
        cwd: runtime.cwd(),
        encoding: 'utf8',
        env: { ...runtime.env, TZ: 'Europe/Moscow', KIROKU_LOCAL_DAY_CHILD: '1' },
      })
      expect(child.status, child.stderr).toBe(0)
      return
    }
    expect(new Date(2026, 9, 1).getTimezoneOffset()).not.toBe(0)
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('One per local day')
    await collection.updateDeckOptionGroup(group.id, { dailyNewLimit: 1, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due' })
    const deck = await collection.createDeck('Local day', { optionGroupId: group.id })
    const first = await collection.createBasicNote(deck.id, { front: 'first', back: 'first' })
    const second = await collection.createBasicNote(deck.id, { front: 'second', back: 'second' })
    const firstCard = (await readCardsForNote(collection, first.id).then(cards => cards[0]))!
    const secondCard = (await readCardsForNote(collection, second.id).then(cards => cards[0]))!
    const rollover = new Date(2026, 9, 1, 4, 0, 0, 0)
    const previousLocalDay = new Date(rollover.getTime() - 15 * 60 * 1000)
    const currentLocalDay = new Date(rollover.getTime() + 15 * 60 * 1000)
    await collection.updateCardSchedule(firstCard.id, { state: State.Learning, due: new Date(currentLocalDay.getTime() + 60 * 60 * 1000).toISOString() })
    await applyRemoteFixtures(collection, 'review', [{ id: 'previous-local-day', cardId: firstCard.id, deckId: deck.id, rating: Rating.Good, state: State.New, due: firstCard.due, stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 1, reviewedAt: previousLocalDay.toISOString() }])

    await expect(collection.dueCards(deck.id, currentLocalDay)).resolves.toEqual([expect.objectContaining({ id: secondCard.id })])
  }, 20_000)

  test('uses deck identity to make parent queues deterministic when child groups use different orders', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const timestamp = '2026-10-01T00:00:00.000Z'
    await applyRemoteFixtures(collection, 'deckOptionGroup', [
      { id: 'a-due-options', name: 'Due', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', newCardGatherOrder: 'deck', newCardSortOrder: 'template', reviewCardOrder: 'due', newReviewOrder: 'mix', interdayLearningOrder: 'before-reviews', buryNewSiblings: false, buryReviewSiblings: false, buryInterdayLearningSiblings: false, leechThreshold: 8, leechAction: 'suspend', leechTag: 'leech', createdAt: timestamp, updatedAt: timestamp },
      { id: 'z-random-options', name: 'Random', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'random', newCardGatherOrder: 'random-cards', newCardSortOrder: 'random', reviewCardOrder: 'random', newReviewOrder: 'mix', interdayLearningOrder: 'before-reviews', buryNewSiblings: false, buryReviewSiblings: false, buryInterdayLearningSiblings: false, leechThreshold: 8, leechAction: 'suspend', leechTag: 'leech', createdAt: timestamp, updatedAt: timestamp },
    ])
    await applyRemoteFixtures(collection, 'deck', [
      { id: 'parent', name: 'Parent', parentId: null, optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp },
      { id: 'a-due-deck', name: 'Due', parentId: 'parent', optionGroupId: 'a-due-options', createdAt: timestamp, updatedAt: timestamp },
      { id: 'z-random-deck', name: 'Random', parentId: 'parent', optionGroupId: 'z-random-options', createdAt: timestamp, updatedAt: timestamp },
    ])
    await applyRemoteFixtures(collection, 'note', ['a-note', 'z-note'].map((id) => ({ id, deckId: id === 'a-note' ? 'a-due-deck' : 'z-random-deck', type: 'basic', typeId: BASIC_NOTE_TYPE_ID, fields: { front: id, back: id }, createdAt: timestamp, updatedAt: timestamp })))
    await applyRemoteFixtures(collection, 'card', [
      directCard('a-new', 'a-due-deck', 'a-note', State.New, '2026-10-01T09:00:00.000Z'),
      directCard('z', 'z-random-deck', 'z-note', State.New, '2026-10-01T08:00:00.000Z'),
    ])

    await expect(collection.dueCards('parent', new Date('2026-10-01T12:00:00.000Z'))).resolves.toEqual([
      expect.objectContaining({ id: 'a-new' }),
      expect.objectContaining({ id: 'z' }),
    ])
  })

  test('orders new and review cards according to their group with a deterministic per-day random order', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = { id: 'ordering-group', name: 'Ordering', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added' as const, newCardGatherOrder: 'deck' as const, newCardSortOrder: 'template' as const, reviewCardOrder: 'due' as const, newReviewOrder: 'mix' as const, interdayLearningOrder: 'before-reviews' as const, buryNewSiblings: false, buryReviewSiblings: false, buryInterdayLearningSiblings: false, leechThreshold: 8, leechAction: 'suspend' as const, leechTag: 'leech', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
    const deck = { id: 'ordering-deck', name: 'Ordered', parentId: null, optionGroupId: group.id, createdAt: group.createdAt, updatedAt: group.updatedAt }
    await applyRemoteFixtures(collection, 'deckOptionGroup', [group])
    await applyRemoteFixtures(collection, 'deck', [deck])
    const orderingNotes = [
      directNote('late', deck.id, '2026-10-01T09:00:00.000Z'),
      directNote('early', deck.id, '2026-10-01T08:00:00.000Z'),
      directNote('middle', deck.id, '2026-10-01T08:30:00.000Z'),
      directNote('fourth', deck.id, '2026-10-01T08:45:00.000Z'),
      directNote('fifth', deck.id, '2026-10-01T08:50:00.000Z'),
    ]
    const reviewNotes = ['review-late-note', 'review-early-note', 'review-middle-note', 'review-fourth-note', 'review-fifth-note']
    await applyRemoteFixtures(collection, 'note', [...orderingNotes, ...reviewNotes.map((id) => ({ id, deckId: deck.id, type: 'basic', typeId: BASIC_NOTE_TYPE_ID, fields: { front: id, back: id }, createdAt: group.createdAt, updatedAt: group.updatedAt }))])
    await applyRemoteFixtures(collection, 'card', [
      directCard('new-late', deck.id, 'late', State.New, '2026-10-01T09:00:00.000Z'),
      directCard('new-early', deck.id, 'early', State.New, '2026-10-01T08:00:00.000Z'),
      directCard('new-middle', deck.id, 'middle', State.New, '2026-10-01T08:30:00.000Z'),
      directCard('new-fourth', deck.id, 'fourth', State.New, '2026-10-01T08:45:00.000Z'),
      directCard('new-fifth', deck.id, 'fifth', State.New, '2026-10-01T08:50:00.000Z'),
      directCard('review-late', deck.id, 'review-late-note', State.Review, '2026-10-01T11:00:00.000Z'),
      directCard('review-early', deck.id, 'review-early-note', State.Review, '2026-10-01T10:00:00.000Z'),
      directCard('review-middle', deck.id, 'review-middle-note', State.Review, '2026-10-01T10:30:00.000Z'),
      directCard('review-fourth', deck.id, 'review-fourth-note', State.Review, '2026-10-01T10:45:00.000Z'),
      directCard('review-fifth', deck.id, 'review-fifth-note', State.Review, '2026-10-01T10:50:00.000Z'),
    ])

    const dueOrder = await collection.dueCards(deck.id, new Date('2026-10-01T12:00:00.000Z'))
    expect(dueOrder.filter((card) => card.state === State.New).map((card) => card.id)).toEqual(['new-early', 'new-middle', 'new-fourth', 'new-fifth', 'new-late'])
    expect(dueOrder.filter((card) => card.state === State.Review).map((card) => card.id)).toEqual(['review-early', 'review-middle', 'review-fourth', 'review-fifth', 'review-late'])

    await collection.updateDeckOptionGroup(group.id, { ...group, newCardOrder: 'random', newCardSortOrder: 'random', reviewCardOrder: 'random' })
    const first = await collection.dueCards(deck.id, new Date('2026-10-01T12:00:00.000Z'))
    const second = await collection.dueCards(deck.id, new Date('2026-10-01T19:00:00.000Z'))
    expect(first.map((card) => card.id)).toEqual(second.map((card) => card.id))
    expect(first.filter((card) => card.state === State.New).map((card) => card.id)).toEqual(second.filter((card) => card.state === State.New).map((card) => card.id))
    expect(first.filter((card) => card.state === State.Review).map((card) => card.id)).toEqual(['review-early', 'review-late', 'review-fifth', 'review-middle', 'review-fourth'])
  })

  test('nests decks and moves a reviewed note without changing card identity or review history', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const parent = await collection.createDeck('Japanese')
    const child = await collection.createDeck('Words', { parentId: parent.id })
    const destination = await collection.createDeck('Sentences')
    const note = await collection.createBasicNote(child.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    await collection.answer(card.id, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    await collection.moveNote(note.id, destination.id, new Date('2026-10-02T00:00:00Z'))
    await collection.applyRemoteChanges([{
      opId: 'historical-review-after-move', entityType: 'review', entityId: 'historical-review', action: 'create', occurredAt: '2026-10-01T12:01:00Z',
      payload: { id: 'historical-review', cardId: card.id, deckId: child.id, rating: Rating.Good, state: 0, due: '2026-10-01T12:01:00Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:01:00Z' },
    }], 1)

    await expect(readNote(collection, note.id)).resolves.toMatchObject({ deckId: destination.id })
    await expect(readCard(collection, card.id)).resolves.toMatchObject({ id: card.id, deckId: destination.id, reps: 1 })
    await expect(readCardReviewHistory(collection, card.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ deckId: child.id }),
      expect.objectContaining({ id: 'historical-review', deckId: child.id }),
    ]))
    await expect(collection.moveDeck(parent.id, child.id)).rejects.toThrow(/descendant|cycle/i)
  })

  test('requires unique names among sibling decks but allows the same name under another parent', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const firstParent = await collection.createDeck('First')
    const secondParent = await collection.createDeck('Second')
    const words = await collection.createDeck('Words', { parentId: firstParent.id })
    const grammar = await collection.createDeck('Grammar', { parentId: firstParent.id })
    await expect(collection.createDeck('Words', { parentId: firstParent.id })).rejects.toThrow(/sibling/i)
    const secondWords = await collection.createDeck('Words', { parentId: secondParent.id })
    await expect(collection.renameDeck(secondWords.id, words.name)).resolves.toBeUndefined()
    await expect(collection.renameDeck(words.id, grammar.name)).rejects.toThrow(/sibling/i)
  })

  test("relocates a deck's notes and children safely and requires a replacement for a referenced option group", async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const custom = await collection.createDeckOptionGroup('Focused')
    const source = await collection.createDeck('Source', { optionGroupId: custom.id })
    const child = await collection.createDeck('Child', { parentId: source.id })
    const target = await collection.createDeck('Target')
    const note = await collection.createBasicNote(source.id, { front: '犬', back: 'dog' })

    await expect(collection.deleteDeckOptionGroup(custom.id)).rejects.toThrow(/referenced|replacement/i)
    await collection.assignDeckOptionGroup(source.id, 'default')
    await collection.deleteDeck(source.id, { mode: 'relocate', destinationDeckId: target.id }, new Date('2026-10-02T00:00:00Z'))

    await expect(readDeck(collection, source.id)).resolves.toBeUndefined()
    await expect(readDeck(collection, child.id)).resolves.toMatchObject({ parentId: target.id })
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ deckId: target.id })
    await collection.deleteDeckOptionGroup(custom.id)
    await expect(readDeckOptionGroup(collection, custom.id)).resolves.toBeUndefined()
  })

  test('rejects remote deck cycles, missing option groups, and cards that do not match a moved note deck', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const root = await collection.createDeck('Root')
    const child = await collection.createDeck('Child', { parentId: root.id })
    const note = await collection.createBasicNote(child.id, { front: '鳥', back: 'bird' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const changedRoot = { ...root, parentId: child.id, updatedAt: '2026-10-02T00:00:00Z' }
    await expect(collection.applyRemoteChanges([{ opId: 'cycle', entityType: 'deck', entityId: root.id, action: 'update', occurredAt: changedRoot.updatedAt, payload: changedRoot }], 1)).rejects.toThrow(/cycle/i)
    const badGroup = { ...child, optionGroupId: 'missing-group', updatedAt: '2026-10-02T00:01:00Z' }
    await expect(collection.applyRemoteChanges([{ opId: 'bad-group', entityType: 'deck', entityId: child.id, action: 'update', occurredAt: badGroup.updatedAt, payload: badGroup }], 1)).rejects.toThrow(/option group/i)
    const mismatched = { ...card, deckId: root.id }
    await expect(collection.applyRemoteChanges([{ opId: 'mismatched-card', entityType: 'card', entityId: card.id, action: 'update', occurredAt: '2026-10-02T00:02:00Z', payload: mismatched }], 1)).rejects.toThrow(/deck/i)
  })

  test('orders remote parent decks and option groups before dependent decks despite delivery order', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const timestamp = '2026-10-02T00:00:00Z'
    const group = { id: 'remote-group', name: 'Remote', protected: false, createdAt: timestamp, updatedAt: timestamp }
    const parent = { id: 'remote-parent', name: 'Parent', parentId: null, optionGroupId: group.id, createdAt: timestamp, updatedAt: timestamp }
    const child = { id: 'remote-child', name: 'Child', parentId: parent.id, optionGroupId: group.id, createdAt: timestamp, updatedAt: timestamp }

    await collection.applyRemoteChanges([
      { opId: 'remote-child', entityType: 'deck', entityId: child.id, action: 'create', occurredAt: timestamp, payload: child },
      { opId: 'remote-parent', entityType: 'deck', entityId: parent.id, action: 'create', occurredAt: timestamp, payload: parent },
      { opId: 'remote-group', entityType: 'deckOptionGroup', entityId: group.id, action: 'create', occurredAt: timestamp, payload: group },
    ], 3)

    await expect(readDeck(collection, child.id)).resolves.toMatchObject({ parentId: parent.id, optionGroupId: group.id })
    await expect(readDeckOptionGroup(collection, group.id)).resolves.toMatchObject(group)
  })

  test('rejects inbound notes, cards, reviews, and media with missing owners', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const timestamp = '2026-10-02T00:00:00Z'
    const note = { id: 'orphan-note', deckId: 'missing-deck', type: 'basic' as const, fields: { front: '猫', back: 'cat' }, createdAt: timestamp, updatedAt: timestamp }
    const card = { id: 'orphan-card', noteId: note.id, deckId: note.deckId, templateId: 'basic', due: timestamp, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null }
    const review = { id: 'orphan-review', cardId: card.id, deckId: note.deckId, rating: Rating.Good, state: 0, due: timestamp, stability: 0, difficulty: 0, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: timestamp }
    const media = { id: 'orphan-media', noteId: note.id, digest: 'a'.repeat(64), kind: 'image' as const, mimeType: 'image/png', displayName: 'cat.png', side: 'front' as const, playback: 'manual' as const, createdAt: timestamp, updatedAt: timestamp }

    await expect(collection.applyRemoteChanges([{ opId: 'orphan-note', entityType: 'note', entityId: note.id, action: 'create', occurredAt: timestamp, payload: note }], 1)).rejects.toThrow(/deck/i)
    await expect(collection.applyRemoteChanges([{ opId: 'orphan-card', entityType: 'card', entityId: card.id, action: 'create', occurredAt: timestamp, payload: card }], 1)).rejects.toThrow(/note/i)
    await expect(collection.applyRemoteChanges([{ opId: 'orphan-review', entityType: 'review', entityId: review.id, action: 'create', occurredAt: timestamp, payload: review }], 1)).rejects.toThrow(/card/i)
    await expect(collection.applyRemoteChanges([{ opId: 'orphan-media', entityType: 'noteMedia', entityId: media.id, action: 'create', occurredAt: timestamp, payload: media }], 1)).rejects.toThrow(/note/i)
    await expect(readReceivedOperationCount(collection)).resolves.toBe(0)
  })

  test('suppresses a historical create-and-subtree-delete batch without orphaned records', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const timestamp = '2026-10-02T00:00:00Z'
    const root = { id: 'history-root', name: 'Root', parentId: null, optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp }
    const child = { id: 'history-child', name: 'Child', parentId: root.id, optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp }
    const note = { id: 'history-note', deckId: child.id, type: 'basic' as const, fields: { front: '犬', back: 'dog' }, createdAt: timestamp, updatedAt: timestamp }
    const card = { id: 'history-card', noteId: note.id, deckId: child.id, templateId: 'basic', due: timestamp, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null }
    const review = { id: 'history-review', cardId: card.id, deckId: child.id, rating: Rating.Good, state: 0, due: timestamp, stability: 0, difficulty: 0, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: timestamp }
    const media = { id: 'history-media', noteId: note.id, digest: 'b'.repeat(64), kind: 'image' as const, mimeType: 'image/png', displayName: 'dog.png', side: 'front' as const, playback: 'manual' as const, createdAt: timestamp, updatedAt: timestamp }

    await collection.applyRemoteChanges([
      { opId: 'history-root-create', entityType: 'deck', entityId: root.id, action: 'create', occurredAt: timestamp, payload: root },
      { opId: 'history-child-create', entityType: 'deck', entityId: child.id, action: 'create', occurredAt: timestamp, payload: child },
      { opId: 'history-root-delete', entityType: 'deck', entityId: root.id, action: 'delete', occurredAt: timestamp, payload: { id: root.id } },
      { opId: 'history-note-create', entityType: 'note', entityId: note.id, action: 'create', occurredAt: timestamp, payload: note },
      { opId: 'history-card-create', entityType: 'card', entityId: card.id, action: 'create', occurredAt: timestamp, payload: card },
      { opId: 'history-review-create', entityType: 'review', entityId: review.id, action: 'create', occurredAt: timestamp, payload: review },
      { opId: 'history-media-create', entityType: 'noteMedia', entityId: media.id, action: 'create', occurredAt: timestamp, payload: media },
    ], 7)

    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.decks.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.references.length)).resolves.toBe(0)
    await expect(readReceivedOperationCount(collection)).resolves.toBe(7)
  })

  test('deletes an entire deck subtree and rejects a delayed child note update', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const root = await collection.createDeck('Root')
    const child = await collection.createDeck('Child', { parentId: root.id })
    const note = await collection.createBasicNote(child.id, { front: '木', back: 'tree' })
    await collection.deleteDeck(root.id, { mode: 'delete-subtree' }, new Date('2026-10-02T00:00:00Z'))

    await expect(readDeck(collection, root.id)).resolves.toBeUndefined()
    await expect(readDeck(collection, child.id)).resolves.toBeUndefined()
    await expect(readNote(collection, note.id)).resolves.toBeUndefined()
    await expect(readDeletedEntity(collection, `deck:${child.id}`)).resolves.toMatchObject({ entityType: 'deck' })
    await expect(readDeletedEntity(collection, `note:${note.id}`)).resolves.toMatchObject({ entityType: 'note' })
    await collection.applyRemoteChanges([{ opId: 'late-child-note', entityType: 'note', entityId: note.id, action: 'update', occurredAt: '2026-10-02T00:01:00Z', payload: { ...note, updatedAt: '2026-10-02T00:01:00Z' } }], 1)
    await expect(readNote(collection, note.id)).resolves.toBeUndefined()
  })

  test('moves referenced option groups before their delete operation on another collection', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const source = await collection.createDeckOptionGroup('Source')
      const replacement = await collection.createDeckOptionGroup('Replacement')
      const deck = await collection.createDeck('Words', { optionGroupId: source.id })
      const initial = await collection.pendingOperations()
      await remote.applyRemoteChanges(initial, initial.length)
      await collection.acknowledgeOperations(initial.map((operation) => operation.opId))

      await collection.deleteDeckOptionGroup(source.id, replacement.id, new Date('2026-10-02T00:00:00Z'))
      const changes = await collection.pendingOperations()
      await remote.applyRemoteChanges(changes, initial.length + changes.length)

      await expect(readDeck(remote, deck.id)).resolves.toMatchObject({ optionGroupId: replacement.id })
      await expect(readDeckOptionGroup(remote, source.id)).resolves.toBeUndefined()
    } finally {
      await remote.removeLocalCollection()
    }
  })

  test('renders an upgraded v6 template whose field name contains a colon', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(6).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
    await old.table('noteTypes').add({ id: 'legacy-type', name: 'Legacy', fields: [{ id: 'legacy-field', name: 'type:Word' }], templates: [{ id: 'legacy-template', name: 'Card', front: '{{type:Word}}', back: '{{type:Word}}', css: '' }], protected: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('notes').add({ id: 'legacy-note', deckId: 'deck-1', type: 'custom', typeId: 'legacy-type', fields: { 'legacy-field': '猫' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    old.close()
    collection = createCollection(databaseName)
    const type = await readNoteType(collection, 'legacy-type')
    const note = await readNote(collection, 'legacy-note')
    expect(type && note && collection.cardGenerationStatus(type, note.fields).eligible).toHaveLength(1)
    expect(type && note && collection.tryCardGenerationStatus(type, note.fields)).toMatchObject({ ok: true })
    const renamed = await collection.updateNoteType('legacy-type', { fields: [{ id: 'legacy-field', name: 'Prompt' }] })
    expect(renamed.templates[0]).toMatchObject({ front: '{{Prompt}}', back: '{{Prompt}}' })
  })

  test('creates one cloze card per ordinal and preserves its schedule across deletion and restoration', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Sentences')
    const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
    const field = type.fields[0].id
    const note = await collection.createNote(deck.id, type.id, { [field]: '{{c1::東京}}と{{c3::大阪}}、{{c1::日本}}' })
    const firstId = `${note.id}:${type.templates[0].id}:c1`
    const thirdId = `${note.id}:${type.templates[0].id}:c3`
    expect((await readCardsForNote(collection, note.id)).map((card) => card.id).sort()).toEqual([firstId, thirdId].sort())
    await collection.answer(thirdId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.updateNote(note.id, { [field]: '{{c1::東京}}と大阪' })
    await expect(readCard(collection, thirdId)).resolves.toMatchObject({ suspended: true, reps: 1, clozeOrdinal: 3 })
    await collection.updateNote(note.id, { [field]: '{{c3::京都}}と{{c1::東京}}' })
    await expect(readCard(collection, thirdId)).resolves.toMatchObject({ suspended: false, reps: 1, clozeOrdinal: 3 })
    await expect(readCard(collection, firstId)).resolves.toMatchObject({ reps: 0 })
    expect((await readCard(collection, firstId))?.suspended).toBeFalsy()
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(2)
  })

  test('ignores inbound card updates and reviews for removed cloze ordinals', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Sentences')
    const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
    const field = type.fields[0].id
    const note = await collection.createNote(deck.id, type.id, { [field]: '{{c1::東京}} {{c2::大阪}}' })
    const secondId = `${note.id}:${type.templates[0].id}:c2`
    const stale = await readCard(collection, secondId)
    await collection.updateNote(note.id, { [field]: '{{c1::東京}} 大阪' })
    await collection.applyRemoteChanges([{ opId: 'stale-cloze-card', entityType: 'card', entityId: secondId, action: 'update', occurredAt: '2026-10-02', payload: stale }], 1)
    await expect(readCard(collection, secondId)).resolves.toMatchObject({ suspended: true })
    await collection.applyRemoteChanges([{ opId: 'stale-cloze-review', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-02', payload: { id: 'review-1', cardId: secondId, deckId: deck.id } }], 2)
    await expect(readReviewEntry(collection, 'review-1')).resolves.toBeUndefined()
  })

  test('rejects malformed cloze type definitions and preserves filtered references on field rename', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const draft = { name: 'Cloze', kind: 'cloze' as const, fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] }
    await expect(collection.createNoteType({ ...draft, templates: [{ ...draft.templates[0], back: '{{Text}}' }] })).rejects.toThrow(/Cloze front and back/)
    await expect(collection.createNoteType({ ...draft, fields: [{ name: 'Text' }, { name: 'cloze:Text' }] })).rejects.toThrow(/cloze filter/i)
    await expect(collection.createNoteType({ ...draft, fields: [{ name: 'Text' }, { name: 'c1' }] })).rejects.toThrow(/reserved/i)
    const type = await collection.createNoteType(draft)
    const renamed = await collection.updateNoteType(type.id, { fields: [{ ...type.fields[0], name: 'Sentence' }] })
    expect(renamed.templates[0]).toMatchObject({ front: '{{cloze:Sentence}}', back: '{{cloze:Sentence}}' })
  })

  test('returns a generation error for malformed cloze text without partially saving an edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Sentences')
    const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
    const field = type.fields[0].id
    const note = await collection.createNote(deck.id, type.id, { [field]: '{{c1::猫}}' })
    expect(collection.tryCardGenerationStatus(type, { [field]: '{{c2::unclosed' })).toMatchObject({ ok: false, error: expect.stringMatching(/Unclosed cloze deletion/) })
    await expect(collection.updateNote(note.id, { [field]: '{{c2::unclosed' })).rejects.toThrow(/Unclosed cloze deletion/)
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [field]: '{{c1::猫}}' } })
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(1)
  })

  test('replays cloze type, note, and generated cards on another collection', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const deck = await collection.createDeck('Sentences')
      const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
      const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '{{c1::猫}} {{c2::犬}}' })
      const operations = await collection.pendingOperations()
      await remote.applyRemoteChanges(operations, operations.length)
      await remote.applyRemoteChanges(operations, operations.length)
      expect(await readCardsForNote(remote, note.id)).toEqual(await readCardsForNote(collection, note.id))
      await expect(readReceivedOperationCount(remote)).resolves.toBe(operations.length)
    } finally {
      await remote.removeLocalCollection()
    }
  })

  test('keeps a live cloze card active after a mixed inbound note and stale suspension batch', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const deck = await collection.createDeck('Sentences')
      const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
      const field = type.fields[0].id
      const note = await collection.createNote(deck.id, type.id, { [field]: '{{c1::猫}} {{c2::犬}}' })
      const initial = await collection.pendingOperations()
      await remote.applyRemoteChanges(initial, initial.length)
      await collection.acknowledgeOperations(initial.map((operation) => operation.opId))
      await collection.updateNote(note.id, { [field]: '{{c1::猫}} 犬' }, new Date('2026-10-02T00:00:00Z'))
      const removal = await collection.pendingOperations()
      await remote.updateNote(note.id, { [field]: '{{c1::猫}} {{c2::犬}}！' }, new Date('2026-10-03T00:00:00Z'))
      const retained = await remote.pendingOperations()
      await remote.applyRemoteChanges([...removal, ...retained], initial.length + removal.length + retained.length)
      await expect(readNote(remote, note.id)).resolves.toMatchObject({ fields: { [field]: '{{c1::猫}} {{c2::犬}}！' } })
      await expect(readCard(remote, `${note.id}:${type.templates[0].id}:c2`)).resolves.toMatchObject({ suspended: false })
      await expect(remote.pendingOperations()).resolves.toHaveLength(retained.length)
    } finally {
      await remote.removeLocalCollection()
    }
  })

  test('upgrades v5 Basic data without changing note, card, or review identities', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(5).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt' })
    await old.table('notes').add({ id: 'note-1', deckId: 'deck-1', type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add({ id: 'legacy-card', deckId: 'deck-1', noteId: 'note-1', due: '2026-01-02', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-01-01' })
    await old.table('reviewEntries').add({ id: 'review-1', cardId: 'legacy-card', deckId: 'deck-1', reviewedAt: '2026-01-01' })
    old.close()

    collection = createCollection(databaseName)
    await expect(readNoteType(collection, BASIC_NOTE_TYPE_ID)).resolves.toMatchObject({ name: 'Basic', protected: true })
    await expect(readNote(collection, 'note-1')).resolves.toMatchObject({ typeId: BASIC_NOTE_TYPE_ID, fields: { front: '猫', back: 'cat' } })
    await expect(readCard(collection, 'legacy-card')).resolves.toMatchObject({ templateId: 'basic', reps: 2 })
    await expect(readReviewEntry(collection, 'review-1')).resolves.toMatchObject({ cardId: 'legacy-card' })
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
    const cards = await readCardsForNote(collection, note.id)
    expect(cards.map((card) => card.id).sort()).toEqual(type.templates.map((template) => `${note.id}:${template.id}`).sort())
    await collection.answer(cards[0].id, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.updateNote(note.id, { [type.fields[0].id]: '犬', [type.fields[1].id]: 'dog' })
    await expect(readCard(collection, cards[0].id)).resolves.toMatchObject({ reps: 1, templateId: cards[0].templateId })
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(2)
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
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(1)
    expect(collection.cardGenerationStatus(type, note.fields).skipped).toEqual([{ templateId: type.templates[1].id, reason: 'Front has no visible field content' }])
  })

  test('creates a card when a typed answer is the only front prompt', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Typing')
    const type = await collection.createNoteType({ name: 'Typed', fields: [{ name: 'Word' }], templates: [
      { name: 'Type word', front: '{{type:Word}}', back: '{{Word}}', css: '' },
    ] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    expect(collection.cardGenerationStatus(type, note.fields).eligible).toHaveLength(1)
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(1)
    await expect(collection.dueCards(deck.id)).resolves.toHaveLength(1)
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
    await expect(readCard(collection, cardId)).resolves.toMatchObject({ suspended: true, reps: 1 })
    await expect(collection.dueCards(deck.id)).resolves.toHaveLength(0)
    await collection.updateNote(note.id, { [type.fields[0].id]: 'restored' })
    await expect(readCard(collection, cardId)).resolves.toMatchObject({ id: cardId, templateId: type.templates[0].id, suspended: false, reps: 1 })
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
    await collection.updateNoteType(type.id, { fields: renamed.fields, templates: renamed.templates })

    expect(collection.cardGenerationStatus(renamed, note.fields).eligible).toHaveLength(1)
    await collection.updateNote(note.id, { [fieldId]: '犬' })
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [fieldId]: '犬' } })
    await expect(readCardsForNote(collection, note.id).then(cards => cards.length)).resolves.toBe(1)
  })

  test('renames and reorders fields without moving values or resetting a reviewed card', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }, { name: 'Meaning' }], templates: [{ name: 'Forward', front: '{{Word}}', back: '{{Meaning}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
    const cardId = `${note.id}:${type.templates[0].id}`
    await collection.answer(cardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    const updated = await collection.updateNoteType(type.id, { name: 'Vocabulary', fields: [{ ...type.fields[1], name: 'Definition' }, type.fields[0]], templates: [{ ...type.templates[0], back: '{{Definition}}' }] })

    expect(updated.name).toBe('Vocabulary')
    expect(updated.fields.map((field) => field.id)).toEqual([type.fields[1].id, type.fields[0].id])
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' } })
    expect(await readCard(collection, cardId)).toMatchObject({ reps: 1 })
    expect((await readCard(collection, cardId))?.suspended).toBeFalsy()
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'noteType', entityId: type.id, action: 'update' })]))
  })

  test('renames a field and rewrites retained template tokens without an explicit template edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{#Word}}<b>{{ Word }}</b>{{/Word}}', back: '{{^Word}}empty{{/Word}}{{Word}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const cardId = `${note.id}:${type.templates[0].id}`
    await collection.answer(cardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    const updated = await collection.updateNoteType(type.id, { fields: [{ ...type.fields[0], name: 'Term' }] })

    expect(updated.templates[0].front).toBe('{{#Term}}<b>{{Term}}</b>{{/Term}}')
    expect(updated.templates[0].back).toBe('{{^Term}}empty{{/Term}}{{Term}}')
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫' } })
    expect((await readCard(collection, cardId))?.reps).toBe(1)
    expect((await readCard(collection, cardId))?.suspended).toBeFalsy()
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'noteType', entityId: type.id, action: 'update', payload: expect.objectContaining({ templates: updated.templates }) })]))
  })

  test('clones a note type with independent field and template identities', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const original = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const clone = await collection.cloneNoteType(original.id, 'Words copy')
    expect(clone.name).toBe('Words copy')
    expect(clone.id).not.toBe(original.id)
    expect(clone.fields[0].id).not.toBe(original.fields[0].id)
    expect(clone.templates[0].id).not.toBe(original.templates[0].id)
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'noteType', entityId: clone.id, action: 'create' })]))
    await collection.deleteNoteType(clone.id)
    await expect(readNoteType(collection, clone.id)).resolves.toBeUndefined()
  })

  test('requires an explicit mode for removed fields and retains or discards their values', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }, { name: 'Hint' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Hint}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'feline' })
    const fields = [type.fields[0]]
    const templates = [{ ...type.templates[0], back: '{{Word}}' }]

    await expect(collection.updateNoteType(type.id, { fields, templates })).rejects.toThrow(/removal mode/i)
    await expect(collection.updateNoteType(type.id, { fields, templates, removedFields: { [type.fields[1].id]: 'unexpected' as 'discard' } })).rejects.toThrow(/removal mode/i)
    await expect(readNoteType(collection, type.id)).resolves.toEqual(type)
    await collection.updateNoteType(type.id, { fields, templates, removedFields: { [type.fields[1].id]: 'keep-as-extra' } })
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫' }, retiredFields: { [type.fields[1].id]: 'feline' } })

    const disposable = await collection.createNoteType({ name: 'Disposable', fields: [{ name: 'Word' }, { name: 'Hint' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Hint}}', css: '' }] })
    const other = await collection.createNote(deck.id, disposable.id, { [disposable.fields[0].id]: '犬', [disposable.fields[1].id]: 'canine' })
    await collection.updateNoteType(disposable.id, { fields: [disposable.fields[0]], templates: [{ ...disposable.templates[0], back: '{{Word}}' }], removedFields: { [disposable.fields[1].id]: 'discard' } })
    const changed = await readNote(collection, other.id)
    expect(changed?.fields).toEqual({ [disposable.fields[0].id]: '犬' })
    expect(changed?.retiredFields?.[disposable.fields[1].id]).toBeUndefined()
  })

  test('adds a field and template, then suspends a removed template without losing review history', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Forward', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const firstId = `${note.id}:${type.templates[0].id}`
    await collection.answer(firstId, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    const expanded = await collection.updateNoteType(type.id, { fields: [...type.fields, { name: 'Meaning' }], templates: [...type.templates, { name: 'Reverse', front: '{{Word}}', back: '{{Meaning}}', css: '' }] })
    expect(expanded.fields[1].id).toBeTruthy()
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { [expanded.fields[1].id]: '' } })
    const secondId = `${note.id}:${expanded.templates[1].id}`
    expect(await readCard(collection, secondId)).toMatchObject({ reps: 0 })
    expect((await readCard(collection, secondId))?.suspended).toBeFalsy()

    await collection.updateNoteType(type.id, { templates: [expanded.templates[1]] })
    await expect(readCard(collection, firstId)).resolves.toMatchObject({ reps: 1, suspended: true })
    expect((await readCard(collection, secondId))?.suspended).toBeFalsy()
    await expect(readCardReviewHistory(collection, firstId).then(entries => entries.length)).resolves.toBe(1)
  })

  test('deletes a used type only with replacement mapping and archives old cards', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const oldType = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }, { name: 'Hint' }], templates: [{ name: 'Old card', front: '{{Word}}', back: '{{Hint}}', css: '' }] })
    const replacement = await collection.createNoteType({ name: 'New', fields: [{ name: 'Term' }], templates: [{ name: 'New card', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, oldType.id, { [oldType.fields[0].id]: '猫', [oldType.fields[1].id]: 'feline' })
    const oldCardId = `${note.id}:${oldType.templates[0].id}`
    await collection.answer(oldCardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    await expect(collection.deleteNoteType(oldType.id)).rejects.toThrow(/replacement/i)
    await expect(collection.deleteNoteType(oldType.id, { replacementTypeId: replacement.id })).rejects.toThrow(/field mapping/i)
    const operationsBefore = (await collection.pendingOperations()).length
    await expect(collection.deleteNoteType(oldType.id, { replacementTypeId: replacement.id, fieldMapping: { [oldType.fields[0].id]: 'missing-field' } })).rejects.toThrow(/unknown replacement field/i)
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ typeId: oldType.id })
    await expect(collection.pendingOperations()).resolves.toHaveLength(operationsBefore)
    await collection.deleteNoteType(oldType.id, { replacementTypeId: replacement.id, fieldMapping: { [oldType.fields[0].id]: replacement.fields[0].id } })

    await expect(readNoteType(collection, oldType.id)).resolves.toBeUndefined()
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ typeId: replacement.id, fields: { [replacement.fields[0].id]: '猫' }, retiredFields: { [oldType.fields[1].id]: 'feline' } })
    await expect(readCard(collection, oldCardId)).resolves.toMatchObject({ reps: 1, suspended: true })
    expect(await readCard(collection, `${note.id}:${replacement.templates[0].id}`)).toMatchObject({ reps: 0 })
    expect((await readCard(collection, `${note.id}:${replacement.templates[0].id}`))?.suspended).toBeFalsy()
    await expect(readCardReviewHistory(collection, oldCardId).then(entries => entries.length)).resolves.toBe(1)
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'noteType', entityId: oldType.id, action: 'delete' })]))
  })

  test('ignores delayed source note and card updates after replacement migration', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const source = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const replacement = await collection.createNoteType({ name: 'New', fields: [{ name: 'Term' }], templates: [{ name: 'Card', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, source.id, { [source.fields[0].id]: '猫' })
    const oldCardId = `${note.id}:${source.templates[0].id}`
    const staleCard = await readCard(collection, oldCardId)
    await collection.deleteNoteType(source.id, { replacementTypeId: replacement.id, fieldMapping: { [source.fields[0].id]: replacement.fields[0].id } })
    const migrated = await readNote(collection, note.id)
    const archived = await readCard(collection, oldCardId)

    await collection.applyRemoteChanges([
      { opId: 'delayed-old-note', entityType: 'note', entityId: note.id, action: 'update', occurredAt: '2026-10-02T00:00:00.000Z', payload: { ...note, fields: { [source.fields[0].id]: 'dog' } } },
      { opId: 'delayed-old-card', entityType: 'card', entityId: oldCardId, action: 'update', occurredAt: '2026-10-02T00:00:00.000Z', payload: staleCard },
    ], 2)

    await expect(readNote(collection, note.id)).resolves.toEqual(migrated)
    await expect(readCard(collection, oldCardId)).resolves.toEqual(archived)
    await expect(readReceivedOperationCount(collection)).resolves.toBe(2)
  })

  test('ignores a delayed review for an archived card after type replacement', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const source = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const replacement = await collection.createNoteType({ name: 'New', fields: [{ name: 'Term' }], templates: [{ name: 'Card', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, source.id, { [source.fields[0].id]: '猫' })
    const oldCardId = `${note.id}:${source.templates[0].id}`
    const review = await collection.answer(oldCardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.deleteNoteType(source.id, { replacementTypeId: replacement.id, fieldMapping: { [source.fields[0].id]: replacement.fields[0].id } })

    await collection.applyRemoteChanges([{ opId: 'delayed-review-op', entityType: 'review', entityId: 'delayed-review', action: 'create', occurredAt: '2026-10-02T00:00:00.000Z', payload: { ...review, id: 'delayed-review' } }], 1)

    await expect(readCardReviewHistory(collection, oldCardId).then(entries => entries.length)).resolves.toBe(1)
    await expect(readReceivedOperationCount(collection)).resolves.toBe(1)
  })

  test('suspends dependent cards when a remote note type deletion arrives before note migration', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const cardId = `${note.id}:${type.templates[0].id}`
    const staleCard = await readCard(collection, cardId)

    await collection.applyRemoteChanges([{ opId: 'remote-type-delete', entityType: 'noteType', entityId: type.id, action: 'delete', occurredAt: '2026-10-02T00:00:00.000Z', payload: { id: type.id } }], 1)
    await collection.applyRemoteChanges([{ opId: 'old-card-after-type-delete', entityType: 'card', entityId: cardId, action: 'update', occurredAt: '2026-10-02T00:01:00.000Z', payload: staleCard }], 2)

    await expect(readNoteType(collection, type.id)).resolves.toBeUndefined()
    await expect(readCard(collection, cardId)).resolves.toMatchObject({ suspended: true })
    await expect(collection.dueCards(deck.id)).resolves.toHaveLength(0)
    await expect(readNote(collection, note.id)).resolves.toMatchObject({ typeId: type.id })
    await expect(readReceivedOperationCount(collection)).resolves.toBe(2)
  })

  test('replays note type mutation and deletion operations only once on a second client', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const remote = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    try {
      const deck = await collection.createDeck('Words')
      const source = await collection.createNoteType({ name: 'Words', fields: [{ name: 'Word' }, { name: 'Hint' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Hint}}', css: '' }] })
      const replacement = await collection.createNoteType({ name: 'Replacement', fields: [{ name: 'Term' }], templates: [{ name: 'Card', front: '{{Term}}', back: '{{Term}}', css: '' }] })
      const note = await collection.createNote(deck.id, source.id, { [source.fields[0].id]: '猫', [source.fields[1].id]: 'feline' })
      const initial = await collection.pendingOperations()
      await remote.applyRemoteChanges(initial, initial.length)
      await collection.acknowledgeOperations(initial.map((operation) => operation.opId))

      await collection.updateNoteType(source.id, { name: 'Renamed words', fields: [source.fields[0]], templates: [{ ...source.templates[0], back: '{{Word}}' }], removedFields: { [source.fields[1].id]: 'keep-as-extra' } })
      const updates = await collection.pendingOperations()
      await remote.applyRemoteChanges(updates, initial.length + updates.length)
      await remote.applyRemoteChanges(updates, initial.length + updates.length)
      await expect(readNoteType(remote, source.id)).resolves.toMatchObject({ name: 'Renamed words' })
      await expect(readNote(remote, note.id)).resolves.toMatchObject({ retiredFields: { [source.fields[1].id]: 'feline' } })
      await collection.acknowledgeOperations(updates.map((operation) => operation.opId))

      await collection.deleteNoteType(source.id, { replacementTypeId: replacement.id, fieldMapping: { [source.fields[0].id]: replacement.fields[0].id } })
      const deletion = await collection.pendingOperations()
      await remote.applyRemoteChanges(deletion, initial.length + updates.length + deletion.length)
      await remote.applyRemoteChanges(deletion, initial.length + updates.length + deletion.length)
      await expect(readNoteType(remote, source.id)).resolves.toBeUndefined()
      await expect(readNote(remote, note.id)).resolves.toEqual(await readNote(collection, note.id))
      await expect(readCardsForNote(remote, note.id)).resolves.toEqual(await readCardsForNote(collection, note.id))
      await expect(readReceivedOperationCount(remote)).resolves.toBe(initial.length + updates.length + deletion.length)
      await expect(remote.pendingOperations()).resolves.toHaveLength(0)
    } finally {
      await remote.removeLocalCollection()
    }
  })

  test('rejects note types whose templates reference an unknown field or FrontSide on front', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const input = { name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Missing}}', back: '{{Word}}', css: '' }] }
    await expect(collection.createNoteType(input)).rejects.toThrow(/unknown field/i)
    await expect(collection.createNoteType({ ...input, templates: [{ ...input.templates[0], front: '{{FrontSide}}' }] })).rejects.toThrow(/FrontSide.*front/i)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.types.length)).resolves.toBe(2)
  })

  test('keeps the protected Basic type when an older Basic note syncs in twice', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const basic = await readNoteType(collection, BASIC_NOTE_TYPE_ID)
    const deck = await collection.createDeck('Remote')
    const note = { id: 'old-note', deckId: deck.id, type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const operation = { opId: 'old-note-create', entityType: 'note' as const, entityId: note.id, action: 'create' as const, occurredAt: note.createdAt, payload: note }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(readNoteType(collection, BASIC_NOTE_TYPE_ID)).resolves.toEqual(basic)
    await expect(readNote(collection, note.id)).resolves.toEqual({ ...note, typeId: BASIC_NOTE_TYPE_ID })
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

    await expect(readNote(collection, note.id)).resolves.toMatchObject({ fields: { back: 'ねこ — feline' } })
    expect(due.noteId).toBe(note.id)
    expect(choices.find((choice) => choice.label === 'Good')?.interval).toMatch(/m|d/)

    await collection.answer(due.id, Rating.Good, new Date('2026-09-30T12:00:00.000Z'))
    await expect(collection.counts(deck.id)).resolves.toEqual({ new: 0, learning: 1, review: 0 })
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.filter(review => review.deckId === deck.id).length)).resolves.toBe(1)

    const reopened = createCollection(databaseName)
    await expect(readNote(reopened, note.id)).resolves.toMatchObject({ fields: { back: 'ねこ — feline' } })
    await expect(readAnkiExportSnapshot(reopened).then(snapshot => snapshot.reviews.filter(review => review.deckId === deck.id).length)).resolves.toBe(1)
    await reopened.removeLocalCollection()
    collection = undefined
  })

  test('queues deck and note changes for sync', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })

    await collection.renameDeck(deck.id, 'Japanese words')
    await collection.updateBasicNote(note.id, { front: '猫', back: 'ねこ — feline' })
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })

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
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(1)
    await expect(collection.mediaForNote(first.id)).resolves.toHaveLength(1)
    await collection.removeMedia(firstReference.id)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(1)
    await expect(collection.mediaForNote(second.id)).resolves.toHaveLength(1)
  })

  test('creates a note and its media references atomically', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const image = new File(['image'], 'cat.png', { type: 'image/png' })
    const note = await collection.createBasicNoteWithMedia(deck.id, { front: '猫', back: 'cat' }, [{ file: image, side: 'front' }, { file: image, side: 'back' }])
    await expect(collection.mediaForNote(note.id)).resolves.toHaveLength(2)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(1)
    await expect(collection.createBasicNoteWithMedia(deck.id, { front: '犬', back: 'dog' }, [{ file: new File(['bad'], 'bad.txt', { type: 'text/plain' }), side: 'front' }])).rejects.toThrow('not a supported')
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.notes.length)).resolves.toBe(1)
  })

  test('removes media references with their deleted deck while retaining shared bytes', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    await collection.attachMedia(note.id, { file: new File(['image'], 'cat.png', { type: 'image/png' }), side: 'front' })

    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })

    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.references.length)).resolves.toBe(0)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(1)
  })

  test('keeps a paired sync credential in local collection settings', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'device-token', cursor: 4 })
    await expect(collection.syncSettings()).resolves.toEqual({ endpoint: 'https://pc.example.test', token: 'device-token', cursor: 4 })
  })

  test('persists a validated local receipt for the latest PC backup downloaded and verified on this device', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const receipt = {
      backupId: 'backup-verified-1', createdAt: '2026-10-03T11:00:00.000Z', verifiedAt: '2026-10-03T12:00:00.000Z',
      reason: 'manual' as const, changeCount: 42, mediaFiles: 3, mediaBytes: 768, archiveBytes: 2048, archiveSha256: 'a'.repeat(64),
    }

    await collection.recordVerifiedPcBackup(receipt)

    await expect(collection.lastVerifiedPcBackup()).resolves.toEqual(receipt)
    await expect(collection.recordVerifiedPcBackup({ ...receipt, archiveSha256: 'invalid' })).rejects.toThrow(/receipt is invalid/i)
    await expect(collection.lastVerifiedPcBackup()).resolves.toEqual(receipt)
    await overwriteIndexedDbBackupReceipt(collection.databaseName, { ...receipt, archiveSha256: 'corrupt' })
    await expect(collection.lastVerifiedPcBackup()).rejects.toThrow(/saved pc backup verification receipt is invalid/i)
  })

  test('applies a remote review only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Remote')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const operation = { opId: 'remote-review', entityType: 'review' as const, entityId: 'review-1', action: 'create' as const, occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: card.id, deckId: deck.id, rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.reviews.length)).resolves.toBe(1)
  })

  test('replays a synced review with the same card-seeded schedule', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Remote')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    const reviewedAt = new Date('2026-10-01T12:00:00.000Z')

    await collection.answer(card.id, Rating.Good, reviewedAt, undefined, { allowEarly: true, reschedule: true })
    const expected = await readCard(collection, card.id)
    const review = (await collection.captureSyncOperations()).find((operation) => operation.entityType === 'review')!
    await collection.applyRemoteChanges([review], 1)

    await expect(readCard(collection, card.id)).resolves.toEqual(expected)
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

    await expect(readDeck(collection, deck.id)).resolves.toEqual({ ...deck, parentId: null, optionGroupId: 'default' })
    await expect(readNote(collection, note.id)).resolves.toEqual({ ...note, typeId: BASIC_NOTE_TYPE_ID })
    await expect(readCard(collection, card.id)).resolves.toEqual({ ...card, templateId: 'basic', suspended: false, manualSuspended: false, templateSuspended: false, buriedUntil: null, flag: 0 })
    await expect(readReceivedOperationCount(collection)).resolves.toBe(3)
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  })

  test('keeps a deleted deck deleted when an offline client later sends an edit', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ — cat' })
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' }, new Date('2026-10-01T12:01:00.000Z'))
    const editedNote = { ...note, fields: { front: '猫', back: 'ねこ — feline' }, updatedAt: '2026-10-01T12:02:00.000Z' }

    await collection.applyRemoteChanges([{
      opId: 'offline-note-edit', entityType: 'note', entityId: note.id, action: 'update', occurredAt: editedNote.updatedAt, payload: editedNote,
    }], 1)

    await expect(readDeck(collection, deck.id)).resolves.toBeUndefined()
    await expect(readNote(collection, note.id)).resolves.toBeUndefined()
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.cards.filter(card => card.deckId === deck.id).length)).resolves.toBe(0)
  })

  test('applies a remote media reference only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Remote')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const reference = { id: 'media-1', noteId: note.id, digest: 'a'.repeat(64), kind: 'image' as const, mimeType: 'image/png', displayName: 'cat.png', side: 'front' as const, playback: 'manual' as const, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
    const operation = { opId: 'remote-media', entityType: 'noteMedia' as const, entityId: reference.id, action: 'create' as const, occurredAt: reference.createdAt, payload: reference }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.references.length)).resolves.toBe(1)
  })

  test('rejects downloaded media whose bytes do not match its digest', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    await expect(collection.storeDownloadedMedia('a'.repeat(64), new Blob(['wrong'], { type: 'image/png' }))).rejects.toThrow('content digest')
    await expect(readAnkiExportSnapshot(collection).then(snapshot => snapshot.blobs.length)).resolves.toBe(0)
  })

  test('reconstructs byte-backed media records for browsers that cannot persist Blobs', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer
    await insertIndexedDbLegacyMediaBlob(collection.databaseName, { digest: 'b'.repeat(64), blob: bytes, byteLength: 4, mimeType: 'image/png', verifiedAt: '2026-10-01' })
    const media = await collection.verifiedMediaBlob('b'.repeat(64))
    expect(media?.blob).toBeInstanceOf(Blob)
    expect(media?.blob.type).toBe('image/png')
    expect(media?.blob.size).toBe(4)
  })
})


describe('received operation identity', () => {
  test('rejects conflicting envelopes before deduplicating one receive batch', async () => {
    collection = createCollection(`kiroku-batch-envelope-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Local work remains')
    await collection.configureSync({ endpoint: 'http://127.0.0.1:1', token: 'synthetic-local-fixture', cursor: 0 })
    const before = await readAnkiExportSnapshot(collection)
    const operation: SyncOperation = { opId: 'same-batch-id', entityType: 'deck', entityId: deck.id, action: 'update', occurredAt: deck.createdAt, payload: { ...deck, name: 'First version' } }
    await expect(collection.applyRemoteChanges([operation, { ...operation, payload: { ...deck, name: 'Conflicting version' } }], 2)).rejects.toThrow('identity was reused')
    expect(await readAnkiExportSnapshot(collection)).toEqual(before)
    expect(await readReceivedOperationCount(collection)).toBe(0)
  })

  test.each(['entityType', 'entityId', 'reviewId'] as const)('rejects a received replay changing only %s', async field => {
    collection = createCollection(`kiroku-replay-envelope-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Retained deck')
    await collection.configureSync({ endpoint: 'http://127.0.0.1:1', token: 'synthetic-local-fixture', cursor: 0 })
    const operation: SyncOperation = { opId: 'replayed-envelope-id', entityType: 'deck', entityId: deck.id, action: 'update', occurredAt: deck.createdAt, payload: deck }
    await collection.applyRemoteChanges([operation], 1)
    const before = await readAnkiExportSnapshot(collection)
    const changed: SyncOperation = { ...operation, [field]: field === 'entityType' ? 'note' : 'different-identity' }
    await expect(collection.applyRemoteChanges([changed], 2)).rejects.toThrow('identity was reused')
    expect(await readAnkiExportSnapshot(collection)).toEqual(before)
    expect(await readReceivedOperationCount(collection)).toBe(1)
    expect((await collection.syncSettings())?.cursor).toBe(1)
  })

  test('retains a pending envelope when a replay changes its entity identity', async () => {
    collection = createCollection(`kiroku-pending-envelope-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Local deck remains')
    await collection.configureSync({ endpoint: 'http://127.0.0.1:1', token: 'synthetic-local-fixture', cursor: 0 })
    const operation: SyncOperation = { opId: 'pending-envelope-id', entityType: 'deck', entityId: 'future-deck', action: 'update', occurredAt: deck.createdAt, payload: { ...deck, id: 'future-deck' }, lifetime: ['future-deletion'], relatedLifetimes: [{ entityType: 'deckOptionGroup', entityId: deck.optionGroupId, lifetime: [] }] }
    await collection.applyRemoteChanges([operation], 1)
    const before = await readAnkiExportSnapshot(collection)
    await expect(collection.applyRemoteChanges([{ ...operation, entityId: 'different-deck' }], 2)).rejects.toThrow('identity was reused')
    expect(await readAnkiExportSnapshot(collection)).toEqual(before)
    expect(await readReceivedOperationCount(collection)).toBe(0)
    expect((await collection.syncSettings())?.cursor).toBe(1)
    await collection.applyRemoteChanges([operation], 2)
    expect(await readSyncProgressCounts(collection)).toMatchObject({ incomingPending: 1 })
  })
})


test('a deferred card whose successor is still missing a lifetime commits bounded receive progress', async () => {
  const databaseName = `kiroku-deferred-card-${crypto.randomUUID()}`
  collection = createCollection(databaseName)
  const original = await collection.createDeck('Original card deck')
  const destination = await collection.createDeck('Current note deck')
  const note = await collection.createBasicNote(original.id, { front: 'retained question', back: 'retained answer' })
  await collection.moveNote(note.id, destination.id)
  const card = (await readCardsForNote(collection, note.id))[0]
  const parent = (await collection.pendingOperations()).filter(operation => operation.entityType === 'card' && operation.entityId === card.id).at(-1)!
  await collection.configureSync({ endpoint: 'http://127.0.0.1:1', token: 'synthetic-local-fixture', cursor: 0 })
  const intermediate: SyncOperation = { opId: 'deferred-intermediate-card', entityType: 'card', entityId: card.id, action: 'update', occurredAt: note.updatedAt, payload: { ...card, deckId: original.id }, parents: [parent.opId], lifetime: [], relatedLifetimes: [{ entityType: 'deck', entityId: original.id, lifetime: [] }, { entityType: 'note', entityId: note.id, lifetime: [] }] }
  const successor: SyncOperation = { ...intermediate, opId: 'deferred-successor-card', payload: card, parents: [intermediate.opId], relatedLifetimes: [{ entityType: 'deck', entityId: destination.id, lifetime: [] }, { entityType: 'note', entityId: note.id, lifetime: ['future-note-deletion'] }] }
  const before = await readAnkiExportSnapshot(collection)
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      collection.applyRemoteChanges([intermediate, successor], 2),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('receive made no bounded durable progress')), 2000) }),
    ])
  } catch (error) {
    collection.closeLocalCollection()
    throw error
  } finally { clearTimeout(watchdog) }
  expect(await readAnkiExportSnapshot(collection)).toEqual(before)
  expect(await readSyncProgressCounts(collection)).toMatchObject({ incomingPending: 2 })
  expect((await collection.syncSettings())?.cursor).toBe(2)
  collection.closeLocalCollection()
  collection = createCollection(databaseName)
  expect(await readSyncProgressCounts(collection)).toMatchObject({ incomingPending: 2 })
  await collection.applyRemoteChanges([], 2)
  expect(await readAnkiExportSnapshot(collection)).toEqual(before)
  expect(await readReceivedOperationCount(collection)).toBe(0)
})
