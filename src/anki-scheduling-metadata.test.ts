import { describe, expect, test } from 'vitest'
import type { CardRow, RevlogRow } from 'ankipack'
import { nativeReviewFingerprint, nativeScheduleFingerprint, readKirokuReview, readKirokuSchedule } from './anki-scheduling-metadata'

/**
 * The scheduling-metadata module had no direct test: everything it guards was
 * exercised only through a package round trip, so a bug in the fingerprint check
 * looked like an interchange failure and vice versa.
 */

function card(overrides: Partial<CardRow> = {}): CardRow {
  return { id: 1, nid: 1, did: 1, ord: 0, mod: 0, usn: -1, type: 2, queue: 2, due: 100, ivl: 10, factor: 2500, reps: 3, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '', ...overrides } as CardRow
}

const revlog = (overrides: Partial<RevlogRow> = {}): RevlogRow => ({ id: 1_700_000_000_000, cid: 1, usn: -1, ease: 3, ivl: 10, lastIvl: 5, factor: 2500, time: 1200, type: 1, ...overrides }) as RevlogRow

describe('native fingerprints', () => {
  test('the card fingerprint covers exactly the fields Anki rewrites on a review', () => {
    expect(nativeScheduleFingerprint(card())).toBe(nativeScheduleFingerprint(card()))
    // Every one of these changes when Anki answers a card.
    for (const change of [{ type: 1 }, { queue: -1 }, { due: 200 }, { ivl: 20 }, { factor: 2600 }, { reps: 4 }, { lapses: 1 }, { left: 600 }]) {
      expect(nativeScheduleFingerprint(card(change as Partial<CardRow>))).not.toBe(nativeScheduleFingerprint(card()))
    }
    // These do not, so supplementary data survives an unrelated native edit.
    for (const change of [{ mod: 99 }, { flags: 3 }, { data: 'edited' }, { usn: 5 }]) {
      expect(nativeScheduleFingerprint(card(change as Partial<CardRow>))).toBe(nativeScheduleFingerprint(card()))
    }
  })

  test('the review fingerprint covers exactly the fields Anki rewrites', () => {
    expect(nativeReviewFingerprint(revlog())).toBe(nativeReviewFingerprint(revlog()))
    for (const change of [{ ease: 1 }, { ivl: 20 }, { lastIvl: 10 }, { factor: 2600 }, { time: 1 }, { type: 0 }]) {
      expect(nativeReviewFingerprint(revlog(change as Partial<RevlogRow>))).not.toBe(nativeReviewFingerprint(revlog()))
    }
    expect(nativeReviewFingerprint(revlog({ usn: 7 }))).toBe(nativeReviewFingerprint(revlog()))
  })
})

describe('reading Kiroku scheduling metadata back off a native row', () => {
  test('a row carrying matching supplementary data is read', () => {
    const native = card()
    const data = JSON.stringify({ kiroku: { version: 1, native: nativeScheduleFingerprint(native), stability: 12.5, difficulty: 4.25, elapsedDays: 2, scheduledDays: 12, learningSteps: 0, reps: 5, lapses: 1, state: 2, due: '2026-10-13T12:00:00.000Z', lastReview: '2026-10-02T12:00:00.000Z', manualSuspended: false, templateSuspended: false, buriedUntil: null } })
    expect(readKirokuSchedule({ ...native, data })).toMatchObject({ stability: 12.5, difficulty: 4.25, scheduledDays: 12, state: 2, due: '2026-10-13T12:00:00.000Z' })
  })

  test('data whose fingerprint no longer matches is discarded, not trusted', () => {
    const native = card({ ivl: 99 })
    const data = JSON.stringify({ kiroku: { version: 1, native: nativeScheduleFingerprint(card()), stability: 12.5, state: 2, due: '2026-10-13T12:00:00.000Z' } })
    // Anki answered the card, so the captured memory state is stale.
    expect(readKirokuSchedule({ ...native, data })).toEqual({})
  })

  test('an unsupported metadata version is an error rather than a silent discard', () => {
    const native = card()
    const data = JSON.stringify({ kiroku: { version: 99, native: nativeScheduleFingerprint(native) } })
    expect(() => readKirokuSchedule({ ...native, data })).toThrow(/unsupported/i)
  })

  test('a malformed value is an error rather than a coerced number', () => {
    const native = card()
    const data = JSON.stringify({ kiroku: { version: 1, native: nativeScheduleFingerprint(native), stability: 'twelve' } })
    expect(() => readKirokuSchedule({ ...native, data })).toThrow(/invalid scheduling/i)
  })

  test('a state above the Anki range is refused', () => {
    const native = card()
    const data = JSON.stringify({ kiroku: { version: 1, native: nativeScheduleFingerprint(native), stability: 5, difficulty: 5, elapsedDays: 1, scheduledDays: 5, learningSteps: 0, reps: 2, lapses: 0, state: 9, due: '2026-10-13T12:00:00.000Z', lastReview: '2026-10-02T12:00:00.000Z' } })
    expect(() => readKirokuSchedule({ ...native, data })).toThrow(/invalid scheduling state/i)
  })

  test('a row with no Kiroku data at all is simply absent', () => {
    expect(readKirokuSchedule(card())).toEqual({})
    expect(readKirokuSchedule({ ...card(), data: 'not json' })).toEqual({})
  })
})

describe('reading Kiroku review metadata back off a native row', () => {
  // A stored record always carries the fields a review row requires; only the
  // post-answer fields and the timing are optional.
  const record = (native: RevlogRow, extra: Record<string, unknown> = {}) => ({
    native: nativeReviewFingerprint(native), rating: native.ease, state: 2,
    stability: 5, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1,
    scheduledDays: 5, learningSteps: 0, due: '2026-10-03T12:00:00.000Z',
    reviewedAt: new Date(native.id).toISOString(), ...extra,
  })

  test('a practice review carries its rescheduling mode', () => {
    const native = revlog({ type: 3 })
    const data = JSON.stringify({ kirokuReviews: { [native.id]: record(native, { rescheduled: false }) } })
    expect(readKirokuReview(data, native)).toMatchObject({ rescheduled: false })
  })

  test('post-answer fields are read when present and optional when absent', () => {
    const native = revlog()
    const data = JSON.stringify({ kirokuReviews: { [native.id]: record(native, { afterState: 2, afterScheduledDays: 12 }) } })
    expect(readKirokuReview(data, native)).toMatchObject({ afterState: 2, afterScheduledDays: 12 })
    // A record written before post-answer fields existed still reads.
    expect(readKirokuReview(JSON.stringify({ kirokuReviews: { [native.id]: record(native) } }), native)).not.toHaveProperty('afterState')
  })

  test('a rating outside the Anki range is refused', () => {
    const native = revlog()
    const data = JSON.stringify({ kirokuReviews: { [native.id]: record(native, { rating: 9 }) } })
    expect(() => readKirokuReview(data, native)).toThrow(/invalid review rating/i)
  })

  test('a row whose fingerprint changed is discarded', () => {
    const native = revlog({ ivl: 99 })
    const data = JSON.stringify({ kirokuReviews: { [native.id]: record(revlog()) } })
    expect(readKirokuReview(data, native)).toEqual({})
  })
})