import { describe, expect, test } from 'vitest'
import type { CardRecord, Deck, DeckOptionGroup, Note, ReviewEntry } from './collection'
import { Rating, State } from './scheduler'
import { answerWithSchedule, eligibleForQueue, eligibleForStudy, intervalLabel, reviewChoices, selectDueCards } from './scheduler'

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
      reviews: [] as ReviewEntry[], temporaryCardIds: new Set(['reserved']),
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
})
