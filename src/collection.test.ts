import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, test } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection, Rating, State, type CardRecord, type Collection, type DeckOptionSettings } from './collection'

let collection: Collection | undefined

type SchedulingSettings = DeckOptionSettings
type NodeRuntime = { execPath: string; cwd(): string; env: Record<string, string | undefined> }
type SpawnSync = (command: string, args: string[], options: { cwd: string; encoding: 'utf8'; env: Record<string, string | undefined> }) => { status: number | null; stderr: string }

function directCard(id: string, deckId: string, noteId: string, state: State, due: string): CardRecord {
  return { id, deckId, noteId, templateId: 'basic', due, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state, lastReview: null }
}

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

describe('local collection', () => {
  test('upgrades v6 note types to standard without changing card scheduling data', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(6).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
    await old.table('noteTypes').add({ id: 'old-type', name: 'Old', fields: [{ id: 'text', name: 'Text' }], templates: [{ id: 'old-template', name: 'Card', front: '{{Text}}', back: '{{Text}}', css: '' }], protected: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    await old.table('cards').add({ id: 'old-card', deckId: 'deck-1', noteId: 'note-1', templateId: 'old-template', due: '2026-01-02', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-01-01' })
    old.close()
    collection = createCollection(databaseName)
    await expect(collection.noteTypes.get('old-type')).resolves.toMatchObject({ kind: 'standard' })
    await expect(collection.noteTypes.get(BASIC_NOTE_TYPE_ID)).resolves.toMatchObject({ kind: 'standard' })
    await expect(collection.cards.get('old-card')).resolves.toMatchObject({ id: 'old-card', reps: 2, stability: 4 })
  })

  test('upgrades existing decks into the protected Default option group without changing their identities', async () => {
    const databaseName = `kiroku-test-${crypto.randomUUID()}`
    const old = new Dexie(databaseName)
    old.version(8).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
    await old.table('decks').add({ id: 'legacy-deck', name: 'Legacy', createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    old.close()

    collection = createCollection(databaseName)

    await expect(collection.decks.get('legacy-deck')).resolves.toMatchObject({ id: 'legacy-deck', parentId: null, optionGroupId: 'default' })
    await expect(collection.deckOptionGroups.get('default')).resolves.toMatchObject({ id: 'default', name: 'Default', protected: true })
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

    await expect(collection.deckOptionGroups.get('legacy-group')).resolves.toMatchObject({ dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due' })
    await expect(collection.cards.get(card.id)).resolves.toEqual(card)
    await expect(collection.reviewEntries.get(review.id)).resolves.toEqual(review)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: -1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/daily new/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0, learningSteps: ['1m'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/retention/i)
    await expect(collection.updateDeckOptionGroup('legacy-group', { dailyNewLimit: 1, dailyReviewLimit: 1, desiredRetention: 0.9, learningSteps: ['soon'], relearningSteps: [], newCardOrder: 'added', reviewCardOrder: 'due' })).rejects.toThrow(/learning step/i)
  })

  test('uses a shared option group for future scheduling while preserving existing history and card state', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const group = await collection.createDeckOptionGroup('Slow learning')
    const first = await collection.createDeck('First', { optionGroupId: group.id })
    const second = await collection.createDeck('Second', { optionGroupId: group.id })
    const firstNote = await collection.createBasicNote(first.id, { front: '一', back: 'one' }, new Date('2026-10-01T08:00:00.000Z'))
    const secondNote = await collection.createBasicNote(second.id, { front: '二', back: 'two' }, new Date('2026-10-01T08:00:00.000Z'))
    const firstCard = (await collection.cards.where('noteId').equals(firstNote.id).first())!
    const secondCard = (await collection.cards.where('noteId').equals(secondNote.id).first())!
    const settings: SchedulingSettings = { dailyNewLimit: 5, dailyReviewLimit: 15, desiredRetention: 0.9, learningSteps: ['2h'], relearningSteps: ['30m'], newCardOrder: 'added', reviewCardOrder: 'due' }

    await collection.updateDeckOptionGroup(group.id, settings, new Date('2026-10-01T09:00:00.000Z'))
    await expect(collection.deckOptionGroups.get(group.id)).resolves.toMatchObject(settings)
    await expect(collection.reviewChoices(firstCard.id, new Date('2026-10-01T10:00:00.000Z'))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Again', interval: '2h' })]))
    await expect(collection.reviewChoices(secondCard.id, new Date('2026-10-01T10:00:00.000Z'))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Again', interval: '2h' })]))

    await collection.answer(firstCard.id, Rating.Good, new Date('2026-10-01T10:00:00.000Z'))
    const scheduled = await collection.cards.get(firstCard.id)
    const history = await collection.reviewEntries.where('cardId').equals(firstCard.id).toArray()
    await collection.updateDeckOptionGroup(group.id, { ...settings, desiredRetention: 0.95, learningSteps: ['4h'] }, new Date('2026-10-01T11:00:00.000Z'))

    await expect(collection.cards.get(firstCard.id)).resolves.toEqual(scheduled)
    await expect(collection.reviewEntries.where('cardId').equals(firstCard.id).toArray()).resolves.toEqual(history)
  })

  test('syncs Default settings while rejecting a changed protected-group identity', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const defaults = (await collection.deckOptionGroups.get('default'))!
    const changedSettings = { ...defaults, dailyNewLimit: 7, updatedAt: '2026-10-01T10:00:00.000Z' }

    await collection.applyRemoteChanges([{ opId: 'default-settings', entityType: 'deckOptionGroup', entityId: defaults.id, action: 'update', occurredAt: changedSettings.updatedAt, payload: changedSettings }], 1)
    await expect(collection.deckOptionGroups.get(defaults.id)).resolves.toMatchObject({ name: 'Default', protected: true, dailyNewLimit: 7 })
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
    const childCards = await Promise.all(childNotes.map((note) => active.cards.where('noteId').equals(note.id).first()))
    const reviewedNew = childCards[0]!
    await collection.cards.update(reviewedNew.id, { state: State.Learning, due: '2026-10-02T08:00:00.000Z' })
    await collection.reviewEntries.add({ id: 'already-new', cardId: reviewedNew.id, deckId: child.id, rating: Rating.Good, state: State.New, due: '2026-10-02T08:00:00.000Z', stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 1, reviewedAt: '2026-10-01T09:00:00.000Z' })
    const reviewed = directCard('reviewed', child.id, 'reviewed-note', State.Learning, '2026-10-01T08:00:00.000Z')
    const reviewDue = directCard('review-due', child.id, 'review-note', State.Review, '2026-10-01T08:00:00.000Z')
    await collection.cards.bulkAdd([reviewed, reviewDue])
    await collection.reviewEntries.add({ id: 'already-review', cardId: reviewed.id, deckId: child.id, rating: Rating.Good, state: State.Review, due: reviewed.due, stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 1, learningSteps: 0, reviewedAt: '2026-10-01T09:00:00.000Z' })

    const queue = await collection.dueCards(root.id, new Date('2026-10-01T12:00:00.000Z'))

    expect(queue.map((card) => card.id)).toEqual(expect.arrayContaining([(await collection.cards.where('noteId').equals(rootNote.id).first())!.id]))
    expect(queue.filter((card) => card.deckId === child.id && card.state === State.New)).toHaveLength(1)
    expect(queue).toEqual(expect.arrayContaining([reviewed]))
    expect(queue.find((card) => card.id === reviewDue.id)).toBeUndefined()
  })

  test('summaries aggregate a parent deck with every descendant', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const parent = await collection.createDeck('Japanese')
    const child = await collection.createDeck('Verbs', { parentId: parent.id })
    await collection.createBasicNote(parent.id, { front: '読む', back: 'read' })
    await collection.createBasicNote(child.id, { front: '書く', back: 'write' })

    const summaries = await collection.summaries()
    const parentSummary = summaries.find((summary) => summary.id === parent.id)!

    expect(parentSummary).toMatchObject({ noteCount: 2, counts: { new: 2, learning: 0, review: 0 } })
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

  test('applies new-card caps to the learner local study day across a UTC midnight offset', async () => {
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
    const firstCard = (await collection.cards.where('noteId').equals(first.id).first())!
    const secondCard = (await collection.cards.where('noteId').equals(second.id).first())!
    const localMidnight = new Date(2026, 9, 1, 0, 0, 0, 0)
    const previousLocalDay = new Date(localMidnight.getTime() - 15 * 60 * 1000)
    const currentLocalDay = new Date(localMidnight.getTime() + 15 * 60 * 1000)
    await collection.cards.update(firstCard.id, { state: State.Learning, due: new Date(currentLocalDay.getTime() + 60 * 60 * 1000).toISOString() })
    await collection.reviewEntries.add({ id: 'previous-local-day', cardId: firstCard.id, deckId: deck.id, rating: Rating.Good, state: State.New, due: firstCard.due, stability: 1, difficulty: 5, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 1, reviewedAt: previousLocalDay.toISOString() })

    await expect(collection.dueCards(deck.id, currentLocalDay)).resolves.toEqual([expect.objectContaining({ id: secondCard.id })])
  })

  test('uses deck identity to make parent queues deterministic when child groups use different orders', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const timestamp = '2026-10-01T00:00:00.000Z'
    await collection.deckOptionGroups.bulkAdd([
      { id: 'a-due-options', name: 'Due', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due', createdAt: timestamp, updatedAt: timestamp },
      { id: 'z-random-options', name: 'Random', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'random', reviewCardOrder: 'random', createdAt: timestamp, updatedAt: timestamp },
    ])
    await collection.decks.bulkAdd([
      { id: 'parent', name: 'Parent', parentId: null, optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp },
      { id: 'a-due-deck', name: 'Due', parentId: 'parent', optionGroupId: 'a-due-options', createdAt: timestamp, updatedAt: timestamp },
      { id: 'z-random-deck', name: 'Random', parentId: 'parent', optionGroupId: 'z-random-options', createdAt: timestamp, updatedAt: timestamp },
    ])
    await collection.cards.bulkAdd([
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
    const group = { id: 'ordering-group', name: 'Ordering', protected: false, dailyNewLimit: 10, dailyReviewLimit: 10, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added' as const, reviewCardOrder: 'due' as const, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
    const deck = { id: 'ordering-deck', name: 'Ordered', parentId: null, optionGroupId: group.id, createdAt: group.createdAt, updatedAt: group.updatedAt }
    await collection.deckOptionGroups.add(group)
    await collection.decks.add(deck)
    await collection.notes.bulkAdd([
      { id: 'late', deckId: deck.id, type: 'basic', typeId: 'basic', fields: {}, createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z' },
      { id: 'early', deckId: deck.id, type: 'basic', typeId: 'basic', fields: {}, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' },
      { id: 'middle', deckId: deck.id, type: 'basic', typeId: 'basic', fields: {}, createdAt: '2026-10-01T08:30:00.000Z', updatedAt: '2026-10-01T08:30:00.000Z' },
      { id: 'fourth', deckId: deck.id, type: 'basic', typeId: 'basic', fields: {}, createdAt: '2026-10-01T08:45:00.000Z', updatedAt: '2026-10-01T08:45:00.000Z' },
      { id: 'fifth', deckId: deck.id, type: 'basic', typeId: 'basic', fields: {}, createdAt: '2026-10-01T08:50:00.000Z', updatedAt: '2026-10-01T08:50:00.000Z' },
    ])
    await collection.cards.bulkAdd([
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

    await collection.updateDeckOptionGroup(group.id, { ...group, newCardOrder: 'random', reviewCardOrder: 'random' })
    const first = await collection.dueCards(deck.id, new Date('2026-10-01T12:00:00.000Z'))
    const second = await collection.dueCards(deck.id, new Date('2026-10-01T19:00:00.000Z'))
    expect(first.map((card) => card.id)).toEqual(second.map((card) => card.id))
    expect(first.filter((card) => card.state === State.New).map((card) => card.id)).toEqual(['new-fifth', 'new-early', 'new-middle', 'new-fourth', 'new-late'])
    expect(first.filter((card) => card.state === State.Review).map((card) => card.id)).toEqual(['review-early', 'review-late', 'review-fifth', 'review-middle', 'review-fourth'])
  })

  test('nests decks and moves a reviewed note without changing card identity or review history', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const parent = await collection.createDeck('Japanese')
    const child = await collection.createDeck('Words', { parentId: parent.id })
    const destination = await collection.createDeck('Sentences')
    const note = await collection.createBasicNote(child.id, { front: '猫', back: 'cat' })
    const card = (await collection.cards.where('noteId').equals(note.id).first())!
    await collection.answer(card.id, Rating.Good, new Date('2026-10-01T12:00:00Z'))

    await collection.moveNote(note.id, destination.id, new Date('2026-10-02T00:00:00Z'))
    await collection.applyRemoteChanges([{
      opId: 'historical-review-after-move', entityType: 'review', entityId: 'historical-review', action: 'create', occurredAt: '2026-10-01T12:01:00Z',
      payload: { id: 'historical-review', cardId: card.id, deckId: child.id, rating: Rating.Good, state: 0, due: '2026-10-01T12:01:00Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:01:00Z' },
    }], 1)

    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ deckId: destination.id })
    await expect(collection.cards.get(card.id)).resolves.toMatchObject({ id: card.id, deckId: destination.id, reps: 1 })
    await expect(collection.reviewEntries.where('cardId').equals(card.id).toArray()).resolves.toEqual(expect.arrayContaining([
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

    await expect(collection.decks.get(source.id)).resolves.toBeUndefined()
    await expect(collection.decks.get(child.id)).resolves.toMatchObject({ parentId: target.id })
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ deckId: target.id })
    await collection.deleteDeckOptionGroup(custom.id)
    await expect(collection.deckOptionGroups.get(custom.id)).resolves.toBeUndefined()
  })

  test('rejects remote deck cycles, missing option groups, and cards that do not match a moved note deck', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const root = await collection.createDeck('Root')
    const child = await collection.createDeck('Child', { parentId: root.id })
    const note = await collection.createBasicNote(child.id, { front: '鳥', back: 'bird' })
    const card = (await collection.cards.where('noteId').equals(note.id).first())!
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

    await expect(collection.decks.get(child.id)).resolves.toMatchObject({ parentId: parent.id, optionGroupId: group.id })
    await expect(collection.deckOptionGroups.get(group.id)).resolves.toMatchObject(group)
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
    await expect(collection.receivedOperations.count()).resolves.toBe(0)
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

    await expect(collection.decks.count()).resolves.toBe(0)
    await expect(collection.notes.count()).resolves.toBe(0)
    await expect(collection.cards.count()).resolves.toBe(0)
    await expect(collection.reviewEntries.count()).resolves.toBe(0)
    await expect(collection.noteMedia.count()).resolves.toBe(0)
    await expect(collection.receivedOperations.count()).resolves.toBe(7)
  })

  test('deletes an entire deck subtree and rejects a delayed child note update', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const root = await collection.createDeck('Root')
    const child = await collection.createDeck('Child', { parentId: root.id })
    const note = await collection.createBasicNote(child.id, { front: '木', back: 'tree' })
    await collection.deleteDeck(root.id, { mode: 'delete-subtree' }, new Date('2026-10-02T00:00:00Z'))

    await expect(collection.decks.get(root.id)).resolves.toBeUndefined()
    await expect(collection.decks.get(child.id)).resolves.toBeUndefined()
    await expect(collection.notes.get(note.id)).resolves.toBeUndefined()
    await expect(collection.deletedEntities.get(`deck:${child.id}`)).resolves.toMatchObject({ entityType: 'deck' })
    await expect(collection.deletedEntities.get(`note:${note.id}`)).resolves.toMatchObject({ entityType: 'note' })
    await collection.applyRemoteChanges([{ opId: 'late-child-note', entityType: 'note', entityId: note.id, action: 'update', occurredAt: '2026-10-02T00:01:00Z', payload: { ...note, updatedAt: '2026-10-02T00:01:00Z' } }], 1)
    await expect(collection.notes.get(note.id)).resolves.toBeUndefined()
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

      await expect(remote.decks.get(deck.id)).resolves.toMatchObject({ optionGroupId: replacement.id })
      await expect(remote.deckOptionGroups.get(source.id)).resolves.toBeUndefined()
    } finally {
      await remote.delete()
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
    const type = await collection.noteTypes.get('legacy-type')
    const note = await collection.notes.get('legacy-note')
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
    expect((await collection.cards.where('noteId').equals(note.id).toArray()).map((card) => card.id).sort()).toEqual([firstId, thirdId].sort())
    await collection.answer(thirdId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
    await collection.updateNote(note.id, { [field]: '{{c1::東京}}と大阪' })
    await expect(collection.cards.get(thirdId)).resolves.toMatchObject({ suspended: true, reps: 1, clozeOrdinal: 3 })
    await collection.updateNote(note.id, { [field]: '{{c3::京都}}と{{c1::東京}}' })
    await expect(collection.cards.get(thirdId)).resolves.toMatchObject({ suspended: false, reps: 1, clozeOrdinal: 3 })
    await expect(collection.cards.get(firstId)).resolves.toMatchObject({ reps: 0 })
    expect((await collection.cards.get(firstId))?.suspended).toBeFalsy()
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(2)
  })

  test('ignores inbound card updates and reviews for removed cloze ordinals', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Sentences')
    const type = await collection.createNoteType({ name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
    const field = type.fields[0].id
    const note = await collection.createNote(deck.id, type.id, { [field]: '{{c1::東京}} {{c2::大阪}}' })
    const secondId = `${note.id}:${type.templates[0].id}:c2`
    const stale = await collection.cards.get(secondId)
    await collection.updateNote(note.id, { [field]: '{{c1::東京}} 大阪' })
    await collection.applyRemoteChanges([{ opId: 'stale-cloze-card', entityType: 'card', entityId: secondId, action: 'update', occurredAt: '2026-10-02', payload: stale }], 1)
    await expect(collection.cards.get(secondId)).resolves.toMatchObject({ suspended: true })
    await collection.applyRemoteChanges([{ opId: 'stale-cloze-review', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-02', payload: { id: 'review-1', cardId: secondId, deckId: deck.id } }], 2)
    await expect(collection.reviewEntries.get('review-1')).resolves.toBeUndefined()
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
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [field]: '{{c1::猫}}' } })
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(1)
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
      expect(await remote.cards.where('noteId').equals(note.id).toArray()).toEqual(await collection.cards.where('noteId').equals(note.id).toArray())
      await expect(remote.receivedOperations.count()).resolves.toBe(operations.length)
    } finally {
      await remote.delete()
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
      await expect(remote.notes.get(note.id)).resolves.toMatchObject({ fields: { [field]: '{{c1::猫}} {{c2::犬}}！' } })
      await expect(remote.cards.get(`${note.id}:${type.templates[0].id}:c2`)).resolves.toMatchObject({ suspended: false })
      await expect(remote.pendingOperations()).resolves.toHaveLength(retained.length)
    } finally {
      await remote.delete()
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

  test('creates a card when a typed answer is the only front prompt', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Typing')
    const type = await collection.createNoteType({ name: 'Typed', fields: [{ name: 'Word' }], templates: [
      { name: 'Type word', front: '{{type:Word}}', back: '{{Word}}', css: '' },
    ] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    expect(collection.cardGenerationStatus(type, note.fields).eligible).toHaveLength(1)
    await expect(collection.cards.where('noteId').equals(note.id).count()).resolves.toBe(1)
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
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' } })
    expect(await collection.cards.get(cardId)).toMatchObject({ reps: 1 })
    expect((await collection.cards.get(cardId))?.suspended).toBeFalsy()
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
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫' } })
    expect((await collection.cards.get(cardId))?.reps).toBe(1)
    expect((await collection.cards.get(cardId))?.suspended).toBeFalsy()
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
    await expect(collection.noteTypes.get(clone.id)).resolves.toBeUndefined()
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
    await expect(collection.noteTypes.get(type.id)).resolves.toEqual(type)
    await collection.updateNoteType(type.id, { fields, templates, removedFields: { [type.fields[1].id]: 'keep-as-extra' } })
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [type.fields[0].id]: '猫' }, retiredFields: { [type.fields[1].id]: 'feline' } })

    const disposable = await collection.createNoteType({ name: 'Disposable', fields: [{ name: 'Word' }, { name: 'Hint' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Hint}}', css: '' }] })
    const other = await collection.createNote(deck.id, disposable.id, { [disposable.fields[0].id]: '犬', [disposable.fields[1].id]: 'canine' })
    await collection.updateNoteType(disposable.id, { fields: [disposable.fields[0]], templates: [{ ...disposable.templates[0], back: '{{Word}}' }], removedFields: { [disposable.fields[1].id]: 'discard' } })
    const changed = await collection.notes.get(other.id)
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
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { [expanded.fields[1].id]: '' } })
    const secondId = `${note.id}:${expanded.templates[1].id}`
    expect(await collection.cards.get(secondId)).toMatchObject({ reps: 0 })
    expect((await collection.cards.get(secondId))?.suspended).toBeFalsy()

    await collection.updateNoteType(type.id, { templates: [expanded.templates[1]] })
    await expect(collection.cards.get(firstId)).resolves.toMatchObject({ reps: 1, suspended: true })
    expect((await collection.cards.get(secondId))?.suspended).toBeFalsy()
    await expect(collection.reviewEntries.where('cardId').equals(firstId).count()).resolves.toBe(1)
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
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ typeId: oldType.id })
    await expect(collection.pendingOperations()).resolves.toHaveLength(operationsBefore)
    await collection.deleteNoteType(oldType.id, { replacementTypeId: replacement.id, fieldMapping: { [oldType.fields[0].id]: replacement.fields[0].id } })

    await expect(collection.noteTypes.get(oldType.id)).resolves.toBeUndefined()
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ typeId: replacement.id, fields: { [replacement.fields[0].id]: '猫' }, retiredFields: { [oldType.fields[1].id]: 'feline' } })
    await expect(collection.cards.get(oldCardId)).resolves.toMatchObject({ reps: 1, suspended: true })
    expect(await collection.cards.get(`${note.id}:${replacement.templates[0].id}`)).toMatchObject({ reps: 0 })
    expect((await collection.cards.get(`${note.id}:${replacement.templates[0].id}`))?.suspended).toBeFalsy()
    await expect(collection.reviewEntries.where('cardId').equals(oldCardId).count()).resolves.toBe(1)
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'noteType', entityId: oldType.id, action: 'delete' })]))
  })

  test('ignores delayed source note and card updates after replacement migration', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const source = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const replacement = await collection.createNoteType({ name: 'New', fields: [{ name: 'Term' }], templates: [{ name: 'Card', front: '{{Term}}', back: '{{Term}}', css: '' }] })
    const note = await collection.createNote(deck.id, source.id, { [source.fields[0].id]: '猫' })
    const oldCardId = `${note.id}:${source.templates[0].id}`
    const staleCard = await collection.cards.get(oldCardId)
    await collection.deleteNoteType(source.id, { replacementTypeId: replacement.id, fieldMapping: { [source.fields[0].id]: replacement.fields[0].id } })
    const migrated = await collection.notes.get(note.id)
    const archived = await collection.cards.get(oldCardId)

    await collection.applyRemoteChanges([
      { opId: 'delayed-old-note', entityType: 'note', entityId: note.id, action: 'update', occurredAt: '2026-10-02T00:00:00.000Z', payload: { ...note, fields: { [source.fields[0].id]: 'dog' } } },
      { opId: 'delayed-old-card', entityType: 'card', entityId: oldCardId, action: 'update', occurredAt: '2026-10-02T00:00:00.000Z', payload: staleCard },
    ], 2)

    await expect(collection.notes.get(note.id)).resolves.toEqual(migrated)
    await expect(collection.cards.get(oldCardId)).resolves.toEqual(archived)
    await expect(collection.receivedOperations.count()).resolves.toBe(2)
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

    await expect(collection.reviewEntries.where('cardId').equals(oldCardId).count()).resolves.toBe(1)
    await expect(collection.receivedOperations.count()).resolves.toBe(1)
  })

  test('suspends dependent cards when a remote note type deletion arrives before note migration', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Words')
    const type = await collection.createNoteType({ name: 'Old', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Word}}', back: '{{Word}}', css: '' }] })
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const cardId = `${note.id}:${type.templates[0].id}`
    const staleCard = await collection.cards.get(cardId)

    await collection.applyRemoteChanges([{ opId: 'remote-type-delete', entityType: 'noteType', entityId: type.id, action: 'delete', occurredAt: '2026-10-02T00:00:00.000Z', payload: { id: type.id } }], 1)
    await collection.applyRemoteChanges([{ opId: 'old-card-after-type-delete', entityType: 'card', entityId: cardId, action: 'update', occurredAt: '2026-10-02T00:01:00.000Z', payload: staleCard }], 2)

    await expect(collection.noteTypes.get(type.id)).resolves.toBeUndefined()
    await expect(collection.cards.get(cardId)).resolves.toMatchObject({ suspended: true })
    await expect(collection.dueCards(deck.id)).resolves.toHaveLength(0)
    await expect(collection.notes.get(note.id)).resolves.toMatchObject({ typeId: type.id })
    await expect(collection.receivedOperations.count()).resolves.toBe(2)
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
      await expect(remote.noteTypes.get(source.id)).resolves.toMatchObject({ name: 'Renamed words' })
      await expect(remote.notes.get(note.id)).resolves.toMatchObject({ retiredFields: { [source.fields[1].id]: 'feline' } })
      await collection.acknowledgeOperations(updates.map((operation) => operation.opId))

      await collection.deleteNoteType(source.id, { replacementTypeId: replacement.id, fieldMapping: { [source.fields[0].id]: replacement.fields[0].id } })
      const deletion = await collection.pendingOperations()
      await remote.applyRemoteChanges(deletion, initial.length + updates.length + deletion.length)
      await remote.applyRemoteChanges(deletion, initial.length + updates.length + deletion.length)
      await expect(remote.noteTypes.get(source.id)).resolves.toBeUndefined()
      await expect(remote.notes.get(note.id)).resolves.toEqual(await collection.notes.get(note.id))
      await expect(remote.cards.where('noteId').equals(note.id).toArray()).resolves.toEqual(await collection.cards.where('noteId').equals(note.id).toArray())
      await expect(remote.receivedOperations.count()).resolves.toBe(initial.length + updates.length + deletion.length)
      await expect(remote.pendingOperations()).resolves.toHaveLength(0)
    } finally {
      await remote.delete()
    }
  })

  test('rejects note types whose templates reference an unknown field or FrontSide on front', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const input = { name: 'Words', fields: [{ name: 'Word' }], templates: [{ name: 'Card', front: '{{Missing}}', back: '{{Word}}', css: '' }] }
    await expect(collection.createNoteType(input)).rejects.toThrow(/unknown field/i)
    await expect(collection.createNoteType({ ...input, templates: [{ ...input.templates[0], front: '{{FrontSide}}' }] })).rejects.toThrow(/FrontSide.*front/i)
    await expect(collection.noteTypes.count()).resolves.toBe(2)
  })

  test('keeps the protected Basic type when an older Basic note syncs in twice', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const basic = await collection.noteTypes.get(BASIC_NOTE_TYPE_ID)
    const deck = await collection.createDeck('Remote')
    const note = { id: 'old-note', deckId: deck.id, type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const operation = { opId: 'old-note-create', entityType: 'note' as const, entityId: note.id, action: 'create' as const, occurredAt: note.createdAt, payload: note }
    await collection.applyRemoteChanges([operation], 1)
    await collection.applyRemoteChanges([operation], 1)
    await expect(collection.noteTypes.get(BASIC_NOTE_TYPE_ID)).resolves.toEqual(basic)
    await expect(collection.notes.get(note.id)).resolves.toEqual({ ...note, typeId: BASIC_NOTE_TYPE_ID })
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

    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })

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
    const deck = await collection.createDeck('Remote')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const card = (await collection.cards.where('noteId').equals(note.id).first())!
    const operation = { opId: 'remote-review', entityType: 'review' as const, entityId: 'review-1', action: 'create' as const, occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: card.id, deckId: deck.id, rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }
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

    await expect(collection.decks.get(deck.id)).resolves.toEqual({ ...deck, parentId: null, optionGroupId: 'default' })
    await expect(collection.notes.get(note.id)).resolves.toEqual({ ...note, typeId: BASIC_NOTE_TYPE_ID })
    await expect(collection.cards.get(card.id)).resolves.toEqual({ ...card, templateId: 'basic' })
    await expect(collection.receivedOperations.count()).resolves.toBe(3)
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

    await expect(collection.decks.get(deck.id)).resolves.toBeUndefined()
    await expect(collection.notes.get(note.id)).resolves.toBeUndefined()
    await expect(collection.cards.where('deckId').equals(deck.id).count()).resolves.toBe(0)
  })

  test('applies a remote media reference only once', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const deck = await collection.createDeck('Remote')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const reference = { id: 'media-1', noteId: note.id, digest: 'a'.repeat(64), kind: 'image' as const, mimeType: 'image/png', displayName: 'cat.png', side: 'front' as const, playback: 'manual' as const, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
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

  test('reconstructs byte-backed media records for browsers that cannot persist Blobs', async () => {
    collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer
    await collection.mediaBlobs.put({ digest: 'b'.repeat(64), blob: bytes, byteLength: 4, mimeType: 'image/png', verifiedAt: '2026-10-01' })
    const media = await collection.verifiedMediaBlob('b'.repeat(64))
    expect(media?.blob).toBeInstanceOf(Blob)
    expect(media?.blob.type).toBe('image/png')
    expect(media?.blob.size).toBe(4)
  })
})
