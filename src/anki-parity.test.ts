import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { fsrs, get_fuzz_range, type Card as FsrsCard } from 'ts-fsrs'
import { Rating, State, type Grade } from './scheduler'
import { createCollection, type CardRecord, type Collection } from './collection'
import nativeStateGradeMatrix from '../tests/fixtures/anki-26.9.3-scheduler-matrix.json'

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
  test('matches official previews and persisted outputs across every state and grade', async () => {
    expect(nativeStateGradeMatrix).toMatchObject({ ankiVersion: '26.9.3', scheduler: 'V3', algorithm: 'FSRS-6' })
    await freshCollection('anki-official-persisted-state-matrix')
    const deck = await ensureDeck()
    const base = new Date(nativeStateGradeMatrix.reviewedAt)
    const stateMap: Record<string, State> = { New: State.New, Learning: State.Learning, Review: State.Review, Relearning: State.Relearning }
    const gradeMap: Record<string, Grade> = { Again: Rating.Again, Hard: Rating.Hard, Good: Rating.Good, Easy: Rating.Easy }
    const differences: unknown[] = []

    for (const [index, expected] of nativeStateGradeMatrix.matrix.entries()) {
      const generated = await seedNote(deck.id, `Oracle ${expected.before} ${expected.grade}`)
      const answeredAt = new Date(base.getTime() + index)
      const due = expected.before === 'New'
        ? answeredAt
        : expected.before === 'Learning' || expected.before === 'Relearning'
          ? new Date(answeredAt.getTime() - 60_000)
          : new Date(answeredAt.getTime() - 8 * DAY)
      const card: CardRecord = {
        ...generated,
        id: String(1_234_567_900_000 + index),
        ankiId: 1_234_567_900_000 + index,
        state: stateMap[expected.before],
        due: due.toISOString(),
        stability: expected.before === 'Review' || expected.before === 'Relearning' ? 8 : 0,
        difficulty: expected.before === 'Review' || expected.before === 'Relearning' ? 9.985 : 0,
        elapsedDays: 0,
        scheduledDays: expected.before === 'Review' || expected.before === 'Relearning' ? 8 : 0,
        learningSteps: expected.before === 'Learning' ? 1 : 0,
        reps: expected.before === 'Review' || expected.before === 'Relearning' ? 2 : 0,
        lapses: expected.before === 'Relearning' ? 1 : 0,
        lastReview: null,
      }
      await collection!.cards.delete(generated.id)
      await collection!.cards.add(card)
      const choices = await collection!.reviewChoices(card.id, answeredAt, true)
      const preview = choices.map(({ interval }) => interval)
      const review = await collection!.answer(card.id, gradeMap[expected.grade], answeredAt, undefined, { allowEarly: true, reschedule: true })
      const actual = (await collection!.cards.get(card.id))!
      const persistedReview = (await collection!.reviewEntries.get(review.id))!
      const actualOutcome = {
        type: actual.state,
        intervalDays: actual.scheduledDays,
        reps: actual.reps,
        lapses: actual.lapses,
        review: {
          grade: persistedReview.rating, state: persistedReview.state,
          beforeScheduledDays: persistedReview.scheduledDays,
          afterState: persistedReview.afterState,
          afterScheduledDays: persistedReview.afterScheduledDays,
        },
      }
      const expectedOutcome = {
        type: expected.card.type,
        intervalDays: expected.card.queue === 1 ? 0 : expected.card.intervalDays,
        reps: expected.card.reps,
        lapses: expected.card.lapses,
        review: {
          grade: expected.review.grade,
          state: stateMap[expected.before],
          beforeScheduledDays: expected.before === 'Review' || expected.before === 'Relearning' ? 8 : 0,
          afterState: expected.card.type,
          afterScheduledDays: Math.max(0, expected.review.intervalDays),
        },
      }
      const comparable = actualOutcome
      const expectedComparable = expectedOutcome
      if (JSON.stringify(preview) !== JSON.stringify(expected.previewLabels.map((label) => label.replace(/^</, ''))) || JSON.stringify(comparable) !== JSON.stringify(expectedComparable)) {
        differences.push({ before: expected.before, grade: expected.grade, preview, expectedPreview: expected.previewLabels, actual: comparable, expected: expectedComparable })
      }
      if (Math.abs(actual.stability - expected.card.stability) >= 0.02 || Math.abs(actual.difficulty - expected.card.difficulty) >= 0.02) {
        differences.push({ before: expected.before, grade: expected.grade, actualMemory: [actual.stability, actual.difficulty], expectedMemory: [expected.card.stability, expected.card.difficulty] })
      }
    }
    expect(differences).toEqual([])
  })

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

  test('matches Anki 26.9.3 FSRS-6 new-card previews and keeps fuzz in the same native interval band', async () => {
    await freshCollection('anki-26-9-3-new-oracle')
    const deck = await ensureDeck()
    const group = await collection!.deckOptionGroups.get(deck.optionGroupId)
    expect(group).toMatchObject({ desiredRetention: 0.9, learningSteps: ['1m', '10m'], relearningSteps: ['10m'], dailyNewLimit: 20, dailyReviewLimit: 200 })
    const before = await seedNote(deck.id, '公式 Anki 26.9.3 oracle')
    const now = new Date(Date.now() + 60_000)
    const choices = await collection!.reviewChoices(before.id, now, true)
    expect(choices.map(({ interval }) => interval).slice(0, 3)).toEqual(['1m', '6m', '10m'])

    // Generated by scripts/verify-scheduler-oracle.py against Anki 26.9.3's
    // V3 scheduler, FSRS-6 default parameters, and fixed native card IDs
    // 1234567890000..1234567890063. The first identity gets 8d; all 64
    // intervals range from 6d to 10d.
    const officialAnkiEasyDays = 8
    const officialAnkiFuzzBand = { min_ivl: 6, max_ivl: 10 }
    const unfuzzed = fsrs({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] })
    const baseInterval = unfuzzed.next(toFsrs(before), now, Rating.Easy).card.scheduled_days
    const nativeFuzzBand = get_fuzz_range(baseInterval, before.elapsedDays, 36500)
    expect(nativeFuzzBand).toEqual(officialAnkiFuzzBand)
    const appEasyDays = Number(choices[3].interval.match(/^(\d+)d$/)?.[1])
    expect(Number.isFinite(appEasyDays)).toBe(true)
    expect(appEasyDays).toBeGreaterThanOrEqual(nativeFuzzBand.min_ivl)
    expect(appEasyDays).toBeLessThanOrEqual(nativeFuzzBand.max_ivl)
    expect(officialAnkiEasyDays).toBeGreaterThanOrEqual(nativeFuzzBand.min_ivl)
    expect(officialAnkiEasyDays).toBeLessThanOrEqual(nativeFuzzBand.max_ivl)
  })

  test.each(['numeric', 'imported'] as const)('matches Anki persisted new-card fuzz draws across 64 equivalent %s identities', async (identityKind) => {
    await freshCollection('anki-26-9-3-exact-fresh-fuzz')
    const deck = await ensureDeck()
    const now = new Date('2026-10-03T22:12:55.003Z')
    const nativeDays = [8, 9, 9, 6, 6, 7, 6, 8, 8, 6, 9, 10, 6, 8, 6, 6, 8, 6, 9, 6, 8, 7, 9, 8, 10, 10, 7, 10, 10, 9, 8, 10, 10, 10, 10, 10, 6, 8, 8, 8, 8, 10, 8, 7, 9, 7, 9, 9, 6, 7, 9, 6, 9, 8, 8, 10, 8, 9, 8, 8, 6, 7, 10, 8]
    const previews: number[] = []
    const persistedDays: number[] = []
    const historyDays: number[] = []

    for (let offset = 0; offset < nativeDays.length; offset += 1) {
      const generated = await seedNote(deck.id, `Anki exact new fuzz ${offset}`)
      await collection!.cards.delete(generated.id)
      const ankiId = 1_234_567_890_000 + offset
      const cardId = identityKind === 'numeric' ? String(ankiId) : `${generated.noteId}:${generated.templateId}`
      await collection!.cards.add({ ...generated, id: cardId, ...(identityKind === 'imported' ? { ankiId } : {}), due: now.toISOString() })
      const choices = await collection!.reviewChoices(cardId, now, true)
      previews.push(Number(choices[3].interval.match(/^(\d+)d$/)?.[1]))
      const answer = await collection!.answer(cardId, Rating.Easy, now)
      const persisted = (await collection!.cards.get(cardId))!
      const history = (await collection!.reviewEntries.get(answer.id))!
      persistedDays.push(persisted.scheduledDays)
      historyDays.push(history.afterScheduledDays ?? -1)
    }

    // Generated by the pinned Anki 26.9.3 V3/FSRS-6 oracle for the same
    // 64 Native Identities, fresh persisted cards, defaults, and no answer history.
    expect(previews).toEqual(nativeDays)
    expect(persistedDays).toEqual(nativeDays)
    expect(historyDays).toEqual(nativeDays)
  })

  test('keeps graduated review previews inside Anki 26.9.3 interval bands', async () => {
    await freshCollection('anki-26-9-3-review-oracle')
    const deck = await ensureDeck()
    const now = new Date('2026-10-03T12:00:00.000Z')
    const reviewedAt = new Date(now.getTime() - 8 * DAY)
    const nativeBands = { Hard: [23, 30], Good: [35, 43], Easy: [60, 71] } as const
    const observed: Record<keyof typeof nativeBands, number[]> = { Hard: [], Good: [], Easy: [] }

    // The official oracle graduates 512 fixed card identities in
    // scripts/verify-scheduler-oracle.py. App identities intentionally differ in
    // representation, so compare the resulting scheduler bands rather than
    // requiring matching fuzz draws.
    for (let offset = 0; offset < 64; offset += 1) {
      const generated = await seedNote(deck.id, `Anki review oracle ${offset}`)
      await collection!.cards.delete(generated.id)
      const cardId = `anki-review-oracle-${offset}`
      await collection!.cards.add({ ...generated, due: reviewedAt.toISOString(), id: cardId })
      await collection!.answer(cardId, Rating.Easy, reviewedAt)
      const graduated = (await collection!.cards.get(cardId))!
      const choices = await collection!.reviewChoices(cardId, now, true)
      const unfuzzed = fsrs({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] })

      for (const [grade, rating] of [['Hard', Rating.Hard], ['Good', Rating.Good], ['Easy', Rating.Easy]] as const) {
        const choice = choices.find(({ label }) => label === grade)!
        const days = Number(choice.interval.match(/^(\d+)d$/)?.[1])
        expect(Number.isFinite(days), `${grade} preview should be in days: ${choice.interval}`).toBe(true)
        observed[grade].push(days)
        const rawDays = unfuzzed.next(toFsrs(graduated), now, rating).card.scheduled_days
        if (rawDays > graduated.scheduledDays) {
          expect(days, `${grade} should not be fuzzed below the previous ${graduated.scheduledDays}d schedule`).toBeGreaterThan(graduated.scheduledDays)
        }
      }
    }

    for (const grade of ['Hard', 'Good', 'Easy'] as const) {
      for (const days of observed[grade]) {
        expect(days, `${grade} ${days}d should fit Anki’s native band`).toBeGreaterThanOrEqual(nativeBands[grade][0])
        expect(days, `${grade} ${days}d should fit Anki’s native band`).toBeLessThanOrEqual(nativeBands[grade][1])
      }
    }
  })

  test('does not fuzz an early review below its previous scheduled interval', async () => {
    await freshCollection('anki-review-scheduled-floor')
    const deck = await ensureDeck()
    const now = new Date('2026-10-03T12:00:00.000Z')
    const generated = await seedNote(deck.id, 'Early review scheduled interval floor')
    await collection!.cards.delete(generated.id)
    const cardId = 'candidate-11'
    await collection!.cards.add({
      ...generated,
      id: cardId,
      state: State.Review,
      due: new Date(now.getTime() + 30 * DAY).toISOString(),
      stability: 32,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 30,
      learningSteps: 0,
      reps: 4,
      lapses: 0,
      lastReview: now.toISOString(),
    })

    const good = (await collection!.reviewChoices(cardId, now, true)).find(({ label }) => label === 'Good')!
    const previewDays = Number(good.interval.match(/^(\d+)d$/)?.[1])
    expect(previewDays).toBeGreaterThan(30)
    const review = await collection!.answer(cardId, Rating.Good, now, undefined, { allowEarly: true, reschedule: true })
    expect(review.afterScheduledDays).toBe(previewDays)
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

  test('holds the same-due order steady across the 4am local rollover', async () => {
    await freshCollection('order')
    const { deckId } = await seedSameDueReviews(12, SAME_DUE, LAST_REVIEW)

    const beforeMidnight = (await collection!.reviewQueue(deckId, new Date(2026, 9, 1, 3, 50))).map((c) => c.id)
    const afterMidnight = (await collection!.reviewQueue(deckId, new Date(2026, 9, 1, 4, 10))).map((c) => c.id)

    // Anki salts the review tiebreak with each card's own last answer, so crossing
    // the study-day rollover must not reorder, repeat or skip the cards already shown.
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
