import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { fsrs, get_fuzz_range, type Card as FsrsCard } from 'ts-fsrs'
import { Rating, State } from './scheduler'
import { createCollection, type CardRecord, type Collection } from './collection'

let collection: Collection | undefined

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

const DAY = 86_400_000

async function freshCollection(name: string) {
  collection = createCollection(`kiroku-${name}-${crypto.randomUUID()}`)
  await collection.open()
  return collection
}

/** The one deck every helper in this file seeds into. */
async function ensureDeck() {
  const existing = (await collection!.decks.toArray())[0]
  return existing ?? collection!.createDeck('Japanese')
}

/** Creates a note and returns its single generated card. */
async function seedNote(deckId: string, front: string, back = front) {
  const note = await collection!.createBasicNote(deckId, { front, back })
  return (await collection!.cards.where('noteId').equals(note.id).first())!
}

async function setCard(cardId: string, patch: Partial<CardRecord>) {
  await collection!.cards.update(cardId, patch)
  return (await collection!.cards.get(cardId))!
}

/**
 * Builds `count` notes in one deck whose cards are all mature reviews due at the
 * same instant, so the queue has to break the tie itself.
 */
async function seedSameDueReviews(count: number, due: string, lastReview: string) {
  const deck = await ensureDeck()
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const card = await seedNote(deck.id, `語${index}`, `ご${index}`)
    await setCard(card.id, {
      state: State.Review,
      due,
      stability: 30,
      difficulty: 5,
      elapsedDays: 30,
      scheduledDays: 30,
      reps: 4,
      lapses: 0,
      lastReview,
    })
    ids.push(card.id)
  }
  return { deckId: deck.id, ids }
}

function toFsrs(card: CardRecord): FsrsCard {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  }
}

describe('Anki scheduling parity', () => {
  async function matureCard(word: string, now: Date, overrides: Partial<CardRecord> = {}) {
    const deck = await ensureDeck()
    const card = await seedNote(deck.id, word)
    return (await setCard(card.id, {
      state: State.Review,
      due: now.toISOString(),
      stability: 30,
      difficulty: 5,
      elapsedDays: 30,
      scheduledDays: 30,
      reps: 4,
      lapses: 0,
      lastReview: new Date(now.getTime() - 30 * DAY).toISOString(),
      ...overrides,
    })).id
  }

  test('spreads mature review intervals instead of giving every card the same one', async () => {
    const now = new Date('2026-10-01T09:00:00.000Z')
    await freshCollection('parity')

    const baseline = fsrs({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false, enable_short_term: true })
    const scheduled: number[] = []
    const expected: Array<{ min_ivl: number; max_ivl: number }> = []
    for (let index = 0; index < 12; index += 1) {
      const cardId = await matureCard(`猫${index}`, now, { reps: 4 + index })
      const before = (await collection!.cards.get(cardId))!
      const unfuzzed = baseline.next(toFsrs(before), now, Rating.Good).card.scheduled_days
      expected.push(get_fuzz_range(unfuzzed, before.elapsedDays, 36500))
      await collection!.answer(cardId, Rating.Good, now)
      scheduled.push((await collection!.cards.get(cardId))!.scheduledDays)
    }

    // Anki always fuzzes, so sibling cards in the same state must not all collapse
    // onto one identical interval.
    expect(new Set(scheduled).size).toBeGreaterThan(1)
    for (const [index, days] of scheduled.entries()) {
      expect(days).toBeGreaterThanOrEqual(expected[index].min_ivl)
      expect(days).toBeLessThanOrEqual(expected[index].max_ivl)
    }
  })

  test('leaves short intervals unfuzzed', async () => {
    const now = new Date('2026-10-01T09:00:00.000Z')
    await freshCollection('parity')

    // A brand new card graduates through learning on the first Good, and Anki
    // applies no fuzz below 2.5 days, so every card takes the identical first step.
    const deck = await ensureDeck()
    const firstSteps = new Set<number>()
    for (let index = 0; index < 6; index += 1) {
      const card = await seedNote(deck.id, `新${index}`, `しん${index}`)
      firstSteps.add((await collection!.answer(card.id, Rating.Good, now)).scheduledDays)
    }
    expect(firstSteps).toEqual(new Set([0]))
  })

  test('schedules the same card to the same interval every time it is answered', async () => {
    const now = new Date('2026-10-01T09:00:00.000Z')
    await freshCollection('parity')

    const cardId = await matureCard('鳥', now)
    const before = (await collection!.cards.get(cardId))!

    // The seed comes from the card, not the clock. Rewinding this one card to the
    // state it started in and answering again must reproduce the identical interval,
    // or a replayed or synchronised review drifts away from the device that scheduled it.
    await collection!.answer(cardId, Rating.Good, now)
    const firstDue = (await collection!.cards.get(cardId))!.due
    await setCard(cardId, before)
    await collection!.answer(cardId, Rating.Good, now)
    expect((await collection!.cards.get(cardId))!.due).toBe(firstDue)

    // Fuzz must actually be moving the interval. A single card can land back on the
    // unfuzzed value by chance, so assert across a group rather than one card.
    const unfuzzed = fsrs({ enable_fuzz: false, enable_short_term: true })
    const moved: number[] = []
    for (const cardId of await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((n) => matureCard(`犬${n}`, now)))) {
      const card = (await collection!.cards.get(cardId))!
      await collection!.answer(cardId, Rating.Good, now)
      const after = (await collection!.cards.get(cardId))!
      if (after.scheduledDays !== unfuzzed.next(toFsrs(card), now, Rating.Good).card.scheduled_days) moved.push(after.scheduledDays)
    }
    expect(moved.length).toBeGreaterThan(0)
  })
})

describe('Anki queue ordering parity', () => {
  const SAME_DUE = '2026-10-01T08:00:00.000Z'
  const LAST_REVIEW = '2026-09-01T09:00:00.000Z'

  test('breaks same-due ties with a shuffled key rather than card identity', async () => {
    await freshCollection('order')
    const { deckId, ids } = await seedSameDueReviews(12, SAME_DUE, LAST_REVIEW)

    const order = (await collection!.reviewQueue(deckId, new Date('2026-10-01T12:00:00.000Z'))).map((c) => c.id)

    expect(order).toHaveLength(12)
    expect([...order].sort()).toEqual([...ids].sort())
    expect(order).not.toEqual([...order].sort())
  })

  test('holds the same-due order steady across local midnight', async () => {
    await freshCollection('order')
    const { deckId } = await seedSameDueReviews(12, SAME_DUE, LAST_REVIEW)

    const beforeMidnight = (await collection!.reviewQueue(deckId, new Date('2026-10-01T23:50:00.000Z'))).map((c) => c.id)
    const afterMidnight = (await collection!.reviewQueue(deckId, new Date('2026-10-02T00:10:00.000Z'))).map((c) => c.id)

    // Anki salts the review tiebreak with each card's own last answer, so a session
    // running past midnight must not reorder, repeat or skip the cards it already showed.
    expect(afterMidnight).toEqual(beforeMidnight)
  })

  test('reorders same-due reviews once they are answered again', async () => {
    await freshCollection('order')
    const { deckId, ids } = await seedSameDueReviews(12, SAME_DUE, LAST_REVIEW)
    const before = (await collection!.reviewQueue(deckId, new Date('2026-10-01T12:00:00.000Z'))).map((c) => c.id)

    // Anki salts the review tiebreak with each card's own last answer, so the whole
    // group moves once its members have been reviewed. Re-keying every card keeps the
    // assertion deterministic; re-keying one card in a dozen could land it back in place.
    for (const id of ids) await setCard(id, { lastReview: '2026-10-01T11:00:00.000Z', reps: 9 })
    const after = (await collection!.reviewQueue(deckId, new Date('2026-10-01T12:00:00.000Z'))).map((c) => c.id)

    expect([...after].sort()).toEqual([...before].sort())
    expect(after).not.toEqual(before)
  })

  test('orders by due date ahead of the tiebreak', async () => {
    await freshCollection('order')
    const { deckId, ids } = await seedSameDueReviews(6, SAME_DUE, LAST_REVIEW)
    const [earliest] = ids
    await setCard(earliest, { due: '2026-10-01T07:00:00.000Z' })

    const queue = await collection!.reviewQueue(deckId, new Date('2026-10-01T12:00:00.000Z'))
    expect(queue).toHaveLength(6)
    expect(queue[0].id).toBe(earliest)
  })
})
