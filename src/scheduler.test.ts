import { describe, expect, test } from 'vitest'
import type { CardRecord, Deck, DeckOptionGroup, Note, ReviewEntry } from './collection'
import { Rating, State } from './scheduler'
import { answerWithSchedule, eligibleForQueue, eligibleForStudy, intervalLabel, isBuried, isInterdayLearning, isLearningCard, isSuspended, nextStudyBoundary, reviewChoices, selectDueCards, studyDayWindow, templateSuspended, unavailableReason, validateSteps } from './scheduler'

const now = new Date('2026-10-03T12:00:00.000Z')

function card(id: string, state: State, overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id, deckId: 'deck', noteId: `note-${id}`, templateId: 'basic',
    due: '2026-10-03T11:00:00.000Z', stability: 10, difficulty: 5,
    elapsedDays: 10, scheduledDays: 10, learningSteps: 0,
    reps: 2, lapses: 0, state, lastReview: '2026-09-23T12:00:00.000Z',
    manualSuspended: false, templateSuspended: false, suspended: false, buriedUntil: null,
    ...overrides,
  }
}

const deck: Deck = { id: 'deck', name: 'Deck', parentId: null, optionGroupId: 'options', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const options: DeckOptionGroup = {
  id: 'options', name: 'Options', protected: false, dailyNewLimit: 20, dailyReviewLimit: 200,
  desiredRetention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'],
  newCardOrder: 'added', reviewCardOrder: 'due', interdayLearningOrder: 'before-reviews',
  buryNewSiblings: false, buryReviewSiblings: false, leechThreshold: 8,
  leechAction: 'suspend', leechTag: 'leech', createdAt: '2026-01-01', updatedAt: '2026-01-01',
}

describe('pure scheduling rules', () => {
  test('queue eligibility handles suspension, burial, due times, and new cards consistently', () => {
    expect(eligibleForQueue(card('active', State.Review), now)).toBe(true)
    expect(eligibleForStudy(card('future', State.Review, { due: '2026-10-04T12:00:00.000Z' }), now)).toBe(false)
    expect(eligibleForStudy(card('new', State.New, { due: '2026-10-04T12:00:00.000Z' }), now)).toBe(true)
    expect(eligibleForQueue(card('manual', State.Review, { manualSuspended: true }), now)).toBe(false)
    expect(eligibleForQueue(card('template', State.Review, { templateSuspended: true, suspended: true }), now)).toBe(false)
    expect(eligibleForQueue(card('buried', State.Review, { buriedUntil: '2026-10-04T00:00:00.000Z' }), now)).toBe(false)
  })

  test('pure due selection applies daily limits and filters custom-study reservations', () => {
    const cards = [
      card('review-due', State.Review),
      card('review-future', State.Review, { due: '2026-10-04T12:00:00.000Z' }),
      card('new-a', State.New, { due: '2026-10-04T12:00:00.000Z' }),
      card('new-b', State.New, { noteId: 'note-new-b' }),
      card('reserved', State.Review),
    ]
    const notes: Pick<Note, 'id' | 'createdAt'>[] = [
      { id: 'note-new-b', createdAt: '2026-01-01' }, { id: 'note-new-a', createdAt: '2026-01-02' },
    ]
    const result = selectDueCards({
      deckId: deck.id, now, decks: [deck], groups: [{ ...options, dailyNewLimit: 1 }], notes, cards,
      reviews: [] as ReviewEntry[], sessionCardIds: new Set(['reserved']),
    })
    expect(result.map((entry) => entry.id)).toEqual(['review-due', 'new-b'])
  })

  test('answering is a pure, deterministic schedule transition with an explicit review identity', () => {
    const source = card('answer-me', State.Review)
    const first = answerWithSchedule(source, options, Rating.Good, now, 'review-1')
    const replay = answerWithSchedule(source, options, Rating.Good, now, 'review-2')
    expect(first.card).toEqual(replay.card)
    expect(Date.parse(first.card.due)).toBeGreaterThan(now.getTime())
    expect(first.review).toMatchObject({ id: 'review-1', cardId: source.id, deckId: source.deckId, rating: Rating.Good, state: State.Review, scheduling: { before: source } })
    expect(reviewChoices(source, options, now).map((choice) => choice.label)).toEqual(['Again', 'Hard', 'Good', 'Easy'])
  })

  test('interval labels use the answer time and round into human-readable units', () => {
    expect(intervalLabel(new Date(now.getTime() + 30_000), now)).toBe('30s')
    expect(intervalLabel(new Date(now.getTime() + 90_000), now)).toBe('2m')
    expect(intervalLabel(new Date(now.getTime() + 90 * 60_000), now)).toBe('2h')
    expect(intervalLabel(new Date(now.getTime() + 3 * 86_400_000), now)).toBe('3d')
  })

  test('unavailability has one rule, and every caller reads the same reason', () => {
    expect(unavailableReason(card('none', State.Review), now)).toBe(null)
    expect(unavailableReason(card('t', State.Review, { templateSuspended: true, suspended: true }), now)).toBe('template')
    expect(unavailableReason(card('m', State.Review, { manualSuspended: true }), now)).toBe('manual')
    expect(unavailableReason(card('b', State.Review, { buriedUntil: '2026-10-04T00:00:00.000Z' }), now)).toBe('buried')
    // Every reason is exactly the negation of queue eligibility, so the reviewer,
    // the browser, custom study and statistics cannot drift apart.
    const unavailable = (id: string) => card(id, State.Review, {
      templateSuspended: id === 't', suspended: id === 't',
      manualSuspended: id === 'm',
      buriedUntil: id === 'b' ? '2026-10-04T00:00:00.000Z' : null,
    })
    for (const id of ['none', 't', 'm', 'b']) {
      expect(eligibleForQueue(unavailable(id), now)).toBe(unavailableReason(unavailable(id), now) === null)
    }
    // A row carrying only the legacy `suspended` flag is still suspended. Package
    // import and note-type deletion both write `suspended` without
    // `templateSuspended`, so treating the flag as a mere fallback would make
    // an imported suspended card answerable again.
    expect(templateSuspended({ ...card('legacy', State.Review), templateSuspended: undefined, suspended: true })).toBe(true)
    expect(templateSuspended({ ...card('legacy-clear', State.Review), templateSuspended: false, suspended: true })).toBe(true)
    expect(templateSuspended({ ...card('legacy-partial', State.Review), templateSuspended: undefined, suspended: false })).toBe(false)
    expect(eligibleForQueue({ ...card('imported-suspended', State.Review), templateSuspended: false, suspended: true }, now)).toBe(false)
    expect(isSuspended(card('m', State.Review, { manualSuspended: true }))).toBe(true)
    expect(isSuspended(card('b', State.Review, { buriedUntil: '2026-10-04T00:00:00.000Z' }))).toBe(false)
    expect(isBuried(card('b', State.Review, { buriedUntil: '2026-10-01T00:00:00.000Z' }), now)).toBe(false)
  })

  test('a learning card is interday once FSRS gives it a positive day count', () => {
    expect(isLearningCard(card('l', State.Learning))).toBe(true)
    expect(isLearningCard(card('r', State.Relearning))).toBe(true)
    expect(isLearningCard(card('v', State.Review))).toBe(false)
    expect(isInterdayLearning(card('intraday', State.Learning, { scheduledDays: 0 }))).toBe(false)
    expect(isInterdayLearning(card('interday', State.Learning, { scheduledDays: 1 }))).toBe(true)
    expect(isInterdayLearning(card('review', State.Review, { scheduledDays: 1 }))).toBe(false)
  })

  test('study day boundaries are local midnight, matching the statistics day key', () => {
    const { start, end } = studyDayWindow(new Date(2026, 9, 3, 23, 59, 59))
    expect(new Date(start).getHours()).toBe(0)
    expect(new Date(start).getDate()).toBe(3)
    expect(new Date(end).getDate()).toBe(4)
    expect(end - start).toBe(86_400_000)
    expect(nextStudyBoundary(new Date(2026, 9, 3, 12)).getDate()).toBe(4)
  })

  test('the interday learning policy decides whether interday steps precede due reviews', () => {
    const build = (order: DeckOptionGroup['interdayLearningOrder']) => selectDueCards({
      deckId: deck.id, now, decks: [deck], groups: [{ ...options, interdayLearningOrder: order, dailyNewLimit: 0 }],
      notes: [], sessionCardIds: new Set<string>(),
      reviews: [] as ReviewEntry[],
      cards: [
        card('review', State.Review, { due: '2026-10-03T08:00:00.000Z' }),
        card('interday', State.Learning, { due: '2026-10-03T09:00:00.000Z', scheduledDays: 1 }),
        card('intraday', State.Learning, { due: '2026-10-03T10:00:00.000Z', scheduledDays: 0 }),
      ],
    }).map((entry) => entry.id)
    // Intraday steps always come first; the policy only orders interday against reviews.
    expect(build('before-reviews')).toEqual(['intraday', 'interday', 'review'])
    expect(build('after-reviews')).toEqual(['intraday', 'review', 'interday'])
  })

  test('learning steps are validated as a bounded, unit-suffixed list', () => {
    expect(validateSteps(['1m', '10m', '1.5h', '2d'], 'Learning steps')).toEqual(['1m', '10m', '1.5h', '2d'])
    expect(() => validateSteps(['10'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['0m'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['400d'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '10m', '11m'], 'Learning steps')).toThrow(/are invalid/)
  })
})
