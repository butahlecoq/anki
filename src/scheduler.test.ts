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
  newCardOrder: 'added', newCardGatherOrder: 'deck', newCardSortOrder: 'template', reviewCardOrder: 'due', newReviewOrder: 'mix', interdayLearningOrder: 'mix',
  buryNewSiblings: false, buryReviewSiblings: false, buryInterdayLearningSiblings: false, leechThreshold: 8,
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

  test('review sort modes match the pinned Anki 26.9.3 queue fixture', () => {
    const child: Deck = { ...deck, id: 'child', name: 'Child', parentId: deck.id, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const optionsFor = (reviewCardOrder: DeckOptionGroup['reviewCardOrder']) => ({ ...options, reviewCardOrder })
    const cards = [
      card('parent-due-tie-short', State.Review, { scheduledDays: 4, due: '2026-10-03T12:00:00.000Z', stability: 4, difficulty: 8, elapsedDays: 2, lastReview: '2026-10-01T12:00:00.000Z' }),
      card('parent-due-tie-long', State.Review, { scheduledDays: 30, due: '2026-10-03T12:00:00.000Z', stability: 30, difficulty: 4, elapsedDays: 30, lastReview: '2026-09-03T12:00:00.000Z' }),
      card('parent-overdue', State.Review, { scheduledDays: 10, due: '2026-10-01T12:00:00.000Z', stability: 10, difficulty: 6, elapsedDays: 12, lastReview: '2026-09-21T12:00:00.000Z' }),
      card('child-due-tie', State.Review, { id: 'child-due-tie', noteId: 'child-note', deckId: child.id, due: '2026-10-03T12:00:00.000Z', scheduledDays: 7, stability: 7, difficulty: 5, elapsedDays: 8, lastReview: '2026-09-25T12:00:00.000Z' }),
    ]
    const select = (order: DeckOptionGroup['reviewCardOrder'], selectedDeck = deck) => selectDueCards({
      deckId: selectedDeck.id, now, decks: [deck, child], groups: [optionsFor(order)], notes: [], cards,
      reviews: [], sessionCardIds: new Set<string>(),
    }).map((entry) => entry.id)

    expect(select('due-then-deck')).toEqual(['parent-overdue', 'parent-due-tie-long', 'parent-due-tie-short', 'child-due-tie'])
    expect(select('deck-then-due', deck)).toEqual(['parent-overdue', 'parent-due-tie-long', 'parent-due-tie-short', 'child-due-tie'])
    expect(select('interval-ascending')).toEqual(['parent-due-tie-short', 'child-due-tie', 'parent-overdue', 'parent-due-tie-long'])
    expect(select('interval-descending')).toEqual(['parent-due-tie-long', 'parent-overdue', 'child-due-tie', 'parent-due-tie-short'])
    expect(select('retrievability-ascending')).toEqual(['parent-overdue', 'child-due-tie', 'parent-due-tie-long', 'parent-due-tie-short'])
    expect(select('retrievability-descending')).toEqual(['parent-due-tie-short', 'parent-due-tie-long', 'child-due-tie', 'parent-overdue'])
  })

  test('new-card gather modes match the pinned Anki 26.9.3 queue fixture', () => {
    const child: Deck = { ...deck, id: 'child', name: 'Child', parentId: deck.id }
    const childCard = (id: string, newPosition: number, templateOrdinal: number, noteId = `note-${id}`) => card(id, State.New, {
      deckId: child.id, noteId, newPosition, templateOrdinal, due: '2026-10-03T12:00:00.000Z',
    })
    const parentCard = (id: string, newPosition: number, templateOrdinal: number, noteId = `note-${id}`) => card(id, State.New, {
      noteId, newPosition, templateOrdinal, due: '2026-10-03T12:00:00.000Z',
    })
    const cards = [
      parentCard('parent-position-2', 2, 1), parentCard('parent-position-3', 3, 0),
      childCard('child-1', 1, 0), childCard('child-4', 4, 1),
    ]
    const select = (newCardGatherOrder: DeckOptionGroup['newCardGatherOrder'], newCardSortOrder: DeckOptionGroup['newCardSortOrder'] = 'gathered', dailyNewLimit = 20) => selectDueCards({
      deckId: deck.id, now, decks: [deck, child],
      groups: [{ ...options, dailyNewLimit, newCardGatherOrder, newCardSortOrder }],
      notes: [], cards, reviews: [], sessionCardIds: new Set<string>(),
    }).map((entry) => entry.id)

    expect(select('deck')).toEqual(['parent-position-2', 'parent-position-3', 'child-1', 'child-4'])
    expect(select('ascending-position')).toEqual(['child-1', 'parent-position-2', 'parent-position-3', 'child-4'])
    expect(select('descending-position')).toEqual(['child-4', 'parent-position-3', 'parent-position-2', 'child-1'])
    expect(select('deck', 'template')).toEqual(['parent-position-3', 'child-1', 'parent-position-2', 'child-4'])
    expect(select('ascending-position', 'gathered', 2)).toEqual(['child-1', 'parent-position-2'])
    expect(select('deck', 'template-random').sort()).toEqual(['child-1', 'child-4', 'parent-position-2', 'parent-position-3'])

    const siblingCards = [
      parentCard('sibling-a-0', 5, 0, 'sibling-a'), parentCard('sibling-a-1', 5, 1, 'sibling-a'),
      childCard('sibling-b-0', 6, 0, 'sibling-b'), childCard('sibling-b-1', 6, 1, 'sibling-b'),
    ]
    const selectSiblings = (gather: DeckOptionGroup['newCardGatherOrder'], sort: DeckOptionGroup['newCardSortOrder']) => selectDueCards({
      deckId: deck.id, now, decks: [deck, child], groups: [{ ...options, newCardGatherOrder: gather, newCardSortOrder: sort }],
      notes: [], cards: siblingCards, reviews: [], sessionCardIds: new Set<string>(),
    }).map((entry) => entry.id)
    const gatheredByRandomNotes = selectSiblings('random-notes', 'gathered')
    const gatheredByDeckRandomNotes = selectSiblings('deck-random-notes', 'gathered')
    expect(new Set(gatheredByRandomNotes.slice(0, 2).map((id) => id.slice(0, 10))).size).toBe(1)
    expect(new Set(gatheredByRandomNotes.slice(2).map((id) => id.slice(0, 10))).size).toBe(1)
    expect(gatheredByRandomNotes.slice(0, 2).map((id) => id.slice(0, 10))).not.toEqual(gatheredByRandomNotes.slice(2).map((id) => id.slice(0, 10)))
    expect(gatheredByDeckRandomNotes).toEqual(['sibling-a-0', 'sibling-a-1', 'sibling-b-0', 'sibling-b-1'])
    expect(selectSiblings('random-notes', 'random-note-template')).toEqual(gatheredByRandomNotes)
    expect(selectSiblings('random-cards', 'random')).toEqual(selectSiblings('random-cards', 'random'))
  })

  test('the review limit also caps new cards after reviews and interday learning are gathered', () => {
    const cards = [
      card('review', State.Review),
      card('interday', State.Learning, { scheduledDays: 1 }),
      card('new-a', State.New),
      card('new-b', State.New, { due: '2026-10-03T12:01:00.000Z' }),
      card('new-c', State.New, { due: '2026-10-03T12:02:00.000Z' }),
    ]
    const select = (dueCards: CardRecord[], reviews: ReviewEntry[] = []) => selectDueCards({
      deckId: deck.id, now, decks: [deck], groups: [{ ...options, dailyNewLimit: 5, dailyReviewLimit: 2 }],
      notes: [], cards: dueCards, reviews, sessionCardIds: new Set<string>(),
    })

    expect(select(cards.filter((entry) => entry.id !== 'interday')).map((entry) => entry.id)).toEqual(['review', 'new-a'])
    expect(select(cards).map((entry) => entry.id)).toEqual(['review', 'interday'])
    expect(select(cards.filter((entry) => entry.id !== 'review' && entry.id !== 'interday')).map((entry) => entry.id)).toEqual(['new-a', 'new-b'])

    const reviewedToday: ReviewEntry = {
      id: 'today-review', cardId: 'older-card', deckId: deck.id, rating: Rating.Good, state: State.Review,
      due: now.toISOString(), stability: 10, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1,
      scheduledDays: 1, learningSteps: 0, reviewedAt: now.toISOString(),
    }
    expect(select(cards.filter((entry) => entry.state === State.New), [reviewedToday]).map((entry) => entry.id)).toEqual(['new-a'])
  })

  test('answering is a pure, deterministic schedule transition with an explicit review identity', () => {
    const source = card('answer-me', State.Review, { occlusionId: 'mask-7', occlusionOrdinal: 7, newPosition: 42, templateOrdinal: 6 })
    const first = answerWithSchedule(source, options, Rating.Good, now, 'review-1')
    const replay = answerWithSchedule(source, options, Rating.Good, now, 'review-2')
    expect(first.card).toEqual(replay.card)
    expect(first.card).toMatchObject({ occlusionId: 'mask-7', occlusionOrdinal: 7, newPosition: 42, templateOrdinal: 6 })
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

  test('study day boundaries use the local 4 a.m. Anki rollover', () => {
    const { start, end } = studyDayWindow(new Date(2026, 9, 3, 23, 59, 59))
    expect(new Date(start).getHours()).toBe(4)
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
    expect(build('mix')).toEqual(['intraday', 'review', 'interday'])
  })

  test('learning steps are validated as a bounded, unit-suffixed list', () => {
    expect(validateSteps(['1m', '10m', '1.5h', '2d'], 'Learning steps')).toEqual(['1m', '10m', '1.5h', '2d'])
    expect(() => validateSteps(['10'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['0m'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['400d'], 'Learning steps')).toThrow(/invalid learning step/)
    expect(() => validateSteps(['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '10m', '11m'], 'Learning steps')).toThrow(/are invalid/)
  })
})
