import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, test } from 'vitest'
import { createCollection, Rating, State, type CardRecord, type ReviewEntry } from './collection'
import { localDayKey, periodWindow, reviewHeatmap, reviewStatistics, schedulingStatistics } from './progress-statistics'
import { readCardsForNote, readDeckOptionGroup, readReviewHistory, readTodayWorkloadReviews } from './collection-queries'
import { studyDayWindow } from './study-day'

function review(id: string, date: Date, overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return { id, cardId: 'card', deckId: 'deck', reviewedAt: date.toISOString(), rating: Rating.Good, state: State.Review, due: date.toISOString(), stability: 10, difficulty: 5, elapsedDays: 2, lastElapsedDays: 2, scheduledDays: 10, learningSteps: 0, ...overrides }
}
function card(id: string, date: Date, overrides: Partial<CardRecord> = {}): CardRecord {
  return { id, noteId: 'note', deckId: 'deck', templateId: 'basic', due: date.toISOString(), stability: 10, difficulty: 5, elapsedDays: 2, scheduledDays: 10, learningSteps: 0, reps: 2, lapses: 0, state: State.Review, lastReview: date.toISOString(), ...overrides }
}

test('calendar periods align with the scheduler rollover, Mondays, and calendar months', () => {
  const anchor = new Date(2026, 2, 29, 23, 59)
  expect(periodWindow('day', anchor)).toEqual({ start: new Date(2026, 2, 29, 4).getTime(), end: new Date(2026, 2, 30, 4).getTime() })
  expect(periodWindow('week', anchor)).toEqual({ start: new Date(2026, 2, 23, 4).getTime(), end: new Date(2026, 2, 30, 4).getTime() })
  expect(periodWindow('month', anchor)).toEqual({ start: new Date(2026, 2, 1, 4).getTime(), end: new Date(2026, 3, 1, 4).getTime() })
  expect(periodWindow('week', new Date(2026, 0, 1))).toEqual({ start: new Date(2025, 11, 29, 4).getTime(), end: new Date(2026, 0, 5, 4).getTime() })
})

test('answers cross the 4am rollover once, and learning answers do not inflate recall', () => {
  const now = new Date(2026, 9, 1, 12)
  const log = [review('before', new Date(2026, 8, 30, 23, 59)), review('start', new Date(2026, 9, 1)), review('again', now, { rating: Rating.Again, durationMs: 4000 }), review('learning', now, { state: State.Learning, durationMs: 2000 }), review('next', new Date(2026, 9, 2))]
  const stats = reviewStatistics([...log, log[1]], 'day', now)
  expect(stats.count).toBe(3)
  expect(stats.cards).toBe(1)
  expect(stats.retention).toBe(.5)
  expect(stats.retentionCount).toBe(2)
  expect(stats.durationMs).toBe(6000)
  expect(stats.timedCount).toBe(2)
  expect(reviewStatistics([], 'all', now).retention).toBeNull()
  expect(reviewHeatmap([...log, log[1]], now, 2).map((day) => [day.key, day.count])).toEqual([['2026-09-30', 2], ['2026-10-01', 3]])
})

test('recall uses the resulting state while legacy logs use their original state', () => {
  const now = new Date(2026, 9, 1, 12)
  const stats = reviewStatistics([
    review('graduate', now, { state: State.Learning, afterState: State.Review, rating: Rating.Good }),
    review('relearn', now, { state: State.Review, afterState: State.Relearning, rating: Rating.Again }),
  ], 'day', now)
  expect(stats.retentionCount).toBe(1)
  expect(stats.retention).toBe(1)
})

test('forecasts count overdue once, respect burial, and exclude suspended and new cards', () => {
  const now = new Date(2026, 9, 1, 12)
  const tomorrow = new Date(2026, 9, 2, 4)
  const stats = schedulingStatistics([
    card('old', new Date(2026, 8, 1)), card('next', tomorrow, { scheduledDays: 35 }),
    card('buried', now, { buriedUntil: tomorrow.toISOString(), scheduledDays: 3 }),
    card('manual', now, { manualSuspended: true }), card('template', now, { templateSuspended: true }),
    card('new', now, { state: State.New }),
  ], now)
  expect(stats.forecast.slice(0, 3).map((day) => day.count)).toEqual([1, 2, 0])
  expect(stats.intervals.map((item) => item.count)).toEqual([0, 1, 1, 1])
  expect(stats.difficulty).toBe(5)
})

test('offline answers, undo, and replayed synchronization retain exactly one timed review', async () => {
  const source = createCollection(`stats-source-${crypto.randomUUID()}`)
  const remote = createCollection(`stats-remote-${crypto.randomUUID()}`)
  const now = new Date(2026, 9, 1, 12)
  try {
    const deck = await source.createDeck('日本語', now)
    const note = await source.createBasicNote(deck.id, { front: '猫', back: 'cat' }, now)
    const [card] = await readCardsForNote(source, note.id)
    const answer = await source.answer(card.id, Rating.Good, now, 90_000)
    expect(answer.durationMs).toBe(60_000)
    expect(reviewStatistics(await readReviewHistory(source), 'day', now).count).toBe(1)
    await source.undo()
    expect(reviewStatistics(await readReviewHistory(source), 'day', now).count).toBe(0)
    await source.answer(card.id, Rating.Easy, now, 1234)
    const changes = await source.pendingOperations()
    await remote.applyRemoteChanges(changes, changes.length)
    await remote.applyRemoteChanges(changes, changes.length)
    const stats = reviewStatistics(await readReviewHistory(remote), 'day', now)
    expect(stats.count).toBe(1)
    expect(stats.durationMs).toBe(1234)
  } finally { source.closeLocalCollection(); remote.closeLocalCollection(); await source.removeLocalCollection(); await remote.removeLocalCollection() }
})

test('today workload reads only current study-day answers and keeps selected descendants', async () => {
  const db = createCollection(`today-reviews-${crypto.randomUUID()}`)
  const now = new Date(2026, 9, 1, 12)
  try {
    const parent = await db.createDeck('Parent', now)
    const child = await db.createDeck('Parent::Child', now)
    const other = await db.createDeck('Other', now)
    for (let index = 0; index < 24; index++) {
      const note = await db.createBasicNote(child.id, { front: `old-${index}`, back: 'back' }, now)
      const [entry] = await readCardsForNote(db, note.id)
      await db.answer(entry.id, Rating.Good, new Date(2026, 8, 1, 12, index))
    }
    const current = await db.createBasicNote(child.id, { front: 'current', back: 'back' }, now)
    const [currentCard] = await readCardsForNote(db, current.id)
    await db.answer(currentCard.id, Rating.Good, new Date(2026, 9, 1, 4))
    const unrelated = await db.createBasicNote(other.id, { front: 'other', back: 'back' }, now)
    const [otherCard] = await readCardsForNote(db, unrelated.id)
    await db.answer(otherCard.id, Rating.Good, now)
    let materialized = 0
    ;(db as unknown as Dexie).table('reviewEntries').hook('reading', (row) => { materialized += 1; return row })
    expect((await readTodayWorkloadReviews(db, now, [parent.id, child.id])).map((entry) => entry.cardId)).toEqual([currentCard.id])
    expect(materialized).toBe(2)
    expect(await readTodayWorkloadReviews(db, new Date(2026, 9, 1, 3, 59), [parent.id, child.id])).toEqual([])
    expect(await readTodayWorkloadReviews(db, now, [])).toEqual([])
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('today workload accepts a synchronized ISO offset timestamp at the study-day boundary', async () => {
  const source = createCollection(`offset-source-${crypto.randomUUID()}`)
  const remote = createCollection(`offset-remote-${crypto.randomUUID()}`)
  const now = new Date('2026-10-01T12:00:00.000Z')
  try {
    const deck = await source.createDeck('Offset', now)
    const note = await source.createBasicNote(deck.id, { front: 'offset', back: 'back' }, now)
    const [entry] = await readCardsForNote(source, note.id)
    await source.answer(entry.id, Rating.Good, new Date('2026-10-01T04:00:00.000Z'))
    const changes = (await source.pendingOperations()).map((operation) => operation.entityType === 'review'
      ? { ...operation, occurredAt: '2026-10-01T06:00:00.000+02:00', payload: { ...(operation.payload as ReviewEntry), reviewedAt: '2026-10-01T06:00:00.000+02:00' } }
      : operation)
    await remote.applyRemoteChanges(changes, changes.length)
    expect((await readTodayWorkloadReviews(remote, now)).map((review) => review.cardId)).toEqual([entry.id])
  } finally { source.closeLocalCollection(); remote.closeLocalCollection(); await source.removeLocalCollection(); await remote.removeLocalCollection() }
})

test('dashboard queue shares daily limits and renderability with the reviewer', async () => {
  const db = createCollection(`stats-queue-${crypto.randomUUID()}`)
  const now = new Date(2026, 9, 1, 12)
  try {
    const deck = await db.createDeck('日本語', now)
    await db.createBasicNote(deck.id, { front: '猫', back: 'cat' }, now)
    const invisible = await db.createBasicNote(deck.id, { front: '犬', back: 'dog' }, now)
    await db.updateNote(invisible.id, { front: '', back: 'dog' })
    expect(await db.dueCards(deck.id, now)).toHaveLength(1)
    expect(await db.reviewQueue(deck.id, now)).toHaveLength(1)
    const defaults = await readDeckOptionGroup(db, 'default')
    await db.updateDeckOptionGroup('default', { ...defaults!, dailyNewLimit: 0 }, now)
    expect(await db.reviewQueue(deck.id, now)).toHaveLength(0)
  } finally { db.closeLocalCollection(); await db.removeLocalCollection() }
})

test('heatmap dates use calendar arithmetic across daylight-saving transitions', () => {
  const now = new Date(2026, 2, 30, 12)
  expect(reviewHeatmap([], now, 3).map((day) => localDayKey(day.date))).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
})

test('study-day window uses calendar rollover across a spring daylight-saving change', () => {
  const originalZone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const before = studyDayWindow(new Date('2026-03-08T07:59:59.000Z'))
    expect(before.start.toISOString()).toBe('2026-03-07T09:00:00.000Z')
    expect(before.end.toISOString()).toBe('2026-03-08T08:00:00.000Z')
    const at = studyDayWindow(new Date('2026-03-08T08:00:00.000Z'))
    expect(at.start.toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(at.end.toISOString()).toBe('2026-03-09T08:00:00.000Z')
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone }
})
