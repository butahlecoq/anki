import {
  Rating,
  State,
  fsrs,
  type Card as FsrsCard,
  type Grade,
  type ReviewLog as FsrsReviewLog,
  get_fuzz_range,
} from 'ts-fsrs'
import type { CardRecord, Deck, DeckOptionGroup, Note, ReviewChoice, ReviewEntry } from './collection'
import { studyDayKey, studyDayWindow as localStudyDayWindow } from './study-day'

export { Rating, State }
export type { Grade }

export function isBuried(card: CardRecord, now: Date) {
  return card.buriedUntil != null && Date.parse(card.buriedUntil) > now.getTime()
}

/** Whether the template marked this card's content unavailable. The legacy
 * `suspended` flag mirrors template suspension, and package import and note-type
 * deletion still set only that field, so either one being true suspends the
 * card. This must be an OR: treating `suspended` as a fallback value would make
 * an imported suspended card answerable again. */
export function templateSuspended(card: CardRecord) {
  return card.templateSuspended === true || card.suspended === true
}

/** Suspension only, ignoring burial. Buried cards still occupy the forecast, so
 * workload reporting asks for this narrower rule. */
export function isSuspended(card: CardRecord) {
  return templateSuspended(card) || card.manualSuspended === true
}

/** Why a card cannot join a queue, or null when it can. This is the single
 * definition of unavailability; callers report the reason, they do not restate
 * the rule. */
export function unavailableReason(card: CardRecord, now: Date): 'template' | 'manual' | 'buried' | null {
  if (templateSuspended(card)) return 'template'
  if (card.manualSuspended === true) return 'manual'
  if (isBuried(card, now)) return 'buried'
  return null
}

export function eligibleForQueue(card: CardRecord, now: Date) {
  return unavailableReason(card, now) === null
}

export function isDueForStudy(card: CardRecord, now: Date) {
  return card.state === State.New || Date.parse(card.due) <= now.getTime()
}

export function eligibleForStudy(card: CardRecord, now: Date) {
  return eligibleForQueue(card, now) && isDueForStudy(card, now)
}

export function isLearningCard(card: CardRecord) {
  return card.state === State.Learning || card.state === State.Relearning
}

/** FSRS records day-crossing (interday) steps with a positive scheduled-day count. */
export function isInterdayLearning(card: CardRecord) {
  return isLearningCard(card) && card.scheduledDays >= 1
}

export function studyDayWindow(value: Date) {
  const { start, end } = localStudyDayWindow(value)
  return { start: start.getTime(), end: end.getTime() }
}

export function nextStudyBoundary(value: Date) {
  return new Date(studyDayWindow(value).end)
}

function stableRank(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function dailyShuffleRank(card: Pick<CardRecord, 'deckId' | 'id'>, day: string) {
  return String(stableRank(`${day}:${card.deckId}:${card.id}`)).padStart(10, '0')
}

export function validateSteps(values: readonly string[], label: string) {
  if (!Array.isArray(values) || values.length > 10) throw new Error(`${label} are invalid`)
  return values.map((step) => {
    if (typeof step !== 'string' || !/^(?:[1-9]\d*(?:\.\d+)?)(?:m|h|d)$/.test(step)) throw new Error(`${label} contain an invalid learning step`)
    if (!Number.isFinite(Number.parseFloat(step)) || Number.parseFloat(step) > 365) throw new Error(`${label} contain an invalid learning step`)
    return step as `${number}${'m' | 'h' | 'd'}`
  })
}

/** Evenly weave two sorted queues, matching Anki's V3 intersperser. */
function mixQueues<T>(first: readonly T[], second: readonly T[]): T[] {
  const ratio = (first.length + 1) / (second.length + 1)
  const mixed: T[] = []
  let firstIndex = 0
  let secondIndex = 0
  while (firstIndex < first.length || secondIndex < second.length) {
    if (firstIndex >= first.length) mixed.push(second[secondIndex++])
    else if (secondIndex >= second.length) mixed.push(first[firstIndex++])
    else if ((secondIndex + 1) * ratio < firstIndex + 1) mixed.push(second[secondIndex++])
    else mixed.push(first[firstIndex++])
  }
  return mixed
}

export function schedulerFor(group: DeckOptionGroup) {
  return fsrs({
    request_retention: group.desiredRetention,
    maximum_interval: 36500,
    // Anki has no fuzz toggle: intervals of 2.5 days or more always carry a
    // random offset. Short-term learning steps are permitted for the same reason.
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: validateSteps(group.learningSteps, 'Learning steps'),
    relearning_steps: validateSteps(group.relearningSteps, 'Relearning steps'),
  })
}

/** Port rand 0.9.4's seed_from_u64 + StdRng (ChaCha12) draw used by Anki 26.9.3. */
function ankiFuzzFactor(seed: bigint): number {
  const mask64 = (1n << 64n) - 1n
  const mask32 = 0xffff_ffff
  let pcgState = seed
  const key: number[] = []
  for (let index = 0; index < 8; index += 1) {
    pcgState = (pcgState * 6_364_136_223_846_793_005n + 11_634_580_027_462_260_723n) & mask64
    const xorshifted = Number(((pcgState >> 18n) ^ pcgState) >> 27n) >>> 0
    const rotation = Number(pcgState >> 59n)
    key.push(((xorshifted >>> rotation) | (xorshifted << ((-rotation) & 31))) & mask32)
  }

  const state = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, 0, 0, 0, 0]
  const working = [...state]
  const rotate = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits))
  const quarterRound = (a: number, b: number, c: number, d: number) => {
    working[a] = (working[a] + working[b]) >>> 0
    working[d] = rotate(working[d] ^ working[a], 16) >>> 0
    working[c] = (working[c] + working[d]) >>> 0
    working[b] = rotate(working[b] ^ working[c], 12) >>> 0
    working[a] = (working[a] + working[b]) >>> 0
    working[d] = rotate(working[d] ^ working[a], 8) >>> 0
    working[c] = (working[c] + working[d]) >>> 0
    working[b] = rotate(working[b] ^ working[c], 7) >>> 0
  }
  for (let round = 0; round < 6; round += 1) {
    quarterRound(0, 4, 8, 12); quarterRound(1, 5, 9, 13)
    quarterRound(2, 6, 10, 14); quarterRound(3, 7, 11, 15)
    quarterRound(0, 5, 10, 15); quarterRound(1, 6, 11, 12)
    quarterRound(2, 7, 8, 13); quarterRound(3, 4, 9, 14)
  }
  const firstWord = (working[0] + state[0]) >>> 0
  return (firstWord >>> 8) / 0x1_000000
}

function fuzzSeed(card: Pick<CardRecord, 'id' | 'ankiId'>, reps: number) {
  // Imported cards use composite app IDs; their retained Native Identity is
  // the identity Anki uses for its deterministic draw.
  const identity = Number.isSafeInteger(card.ankiId) && card.ankiId! > 0
    ? BigInt(card.ankiId!)
    : /^\d+$/.test(card.id) ? BigInt(card.id) : BigInt(stableRank(card.id))
  return BigInt.asUintN(64, identity + BigInt(reps))
}

export function serializeCard(card: FsrsCard, identity: Pick<CardRecord, 'id' | 'deckId' | 'noteId' | 'templateId'> & Partial<CardRecord>): CardRecord {
  return {
    manualSuspended: false, templateSuspended: false, buriedUntil: null, suspended: false,
    ...identity, flag: identity.flag ?? 0,
    due: card.due.toISOString(), stability: card.stability, difficulty: card.difficulty,
    elapsedDays: card.elapsed_days, scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps, reps: card.reps, lapses: card.lapses,
    state: card.state, lastReview: card.last_review?.toISOString() ?? null,
  }
}

export function deserializeCard(card: CardRecord): FsrsCard {
  return {
    due: new Date(card.due), stability: card.stability, difficulty: card.difficulty,
    elapsed_days: card.elapsedDays, scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps, reps: card.reps, lapses: card.lapses,
    state: card.state, last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  }
}

function serializeReview(log: FsrsReviewLog, identity: Pick<ReviewEntry, 'id' | 'cardId' | 'deckId'>): ReviewEntry {
  return {
    ...identity, rating: log.rating, state: log.state, due: log.due.toISOString(),
    stability: log.stability, difficulty: log.difficulty, elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days, scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps, reviewedAt: log.review.toISOString(),
  }
}

export function intervalLabel(due: Date, reviewedAt: Date) {
  const seconds = Math.max(1, Math.round((due.getTime() - reviewedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function nextSchedule(scheduler: ReturnType<typeof schedulerFor>, card: FsrsCard, identity: Pick<CardRecord, 'id' | 'ankiId'>, now: Date, grade: Grade) {
  const result = scheduler.next(card, now, grade)
  if (result.card.state === State.Review && result.card.scheduled_days >= 2.5) {
    const range = get_fuzz_range(result.card.scheduled_days, card.elapsed_days, scheduler.parameters.maximum_interval)
    const seed = fuzzSeed(identity, card.reps)
    const scheduledDays = Math.floor(range.min_ivl + ankiFuzzFactor(seed) * (range.max_ivl - range.min_ivl + 1))
    result.card.scheduled_days = scheduledDays
    result.card.due = new Date(now.getTime() + scheduledDays * 86_400_000)
  }
  if (card.state !== State.Review || grade === Rating.Again) return result

  // Anki never fuzzes a successful review below its current scheduled interval.
  const baseInterval = Math.min(scheduler.parameters.maximum_interval, Math.max(1, Math.round(result.card.stability * scheduler.interval_modifier)))
  if (baseInterval > card.scheduled_days && result.card.scheduled_days <= card.scheduled_days) {
    result.card.scheduled_days = card.scheduled_days + 1
    result.card.due = new Date(now.getTime() + result.card.scheduled_days * 86_400_000)
  }
  return result
}

export function reviewChoices(card: CardRecord, group: DeckOptionGroup, now: Date, allowEarly = false): ReviewChoice[] {
  if (!(allowEarly ? eligibleForQueue(card, now) : eligibleForStudy(card, now))) return []
  const choices: Array<[Grade, ReviewChoice['label']]> = [
    [Rating.Again, 'Again'], [Rating.Hard, 'Hard'], [Rating.Good, 'Good'], [Rating.Easy, 'Easy'],
  ]
  return choices.map(([rating, label]) => ({
    rating,
    label,
    interval: intervalLabel(nextSchedule(schedulerFor(group), deserializeCard(card), card, now, rating).card.due, now),
  }))
}

export function answerWithSchedule(card: CardRecord, group: DeckOptionGroup, rating: Grade, now: Date, reviewId: string) {
  const result = nextSchedule(schedulerFor(group), deserializeCard(card), card, now, rating)
  return {
    card: serializeCard(result.card, card),
    review: { ...serializeReview(result.log, { id: reviewId, cardId: card.id, deckId: card.deckId }), scheduling: { before: card, options: group } },
  }
}

export interface DueSelectionInput {
  deckId: string
  now: Date
  decks: readonly Deck[]
  groups: readonly DeckOptionGroup[]
  notes: readonly Pick<Note, 'id' | 'createdAt'>[]
  cards: readonly CardRecord[]
  reviews: readonly ReviewEntry[]
  /** Cards a Custom Study Session has claimed; they are withheld from the daily queue. */
  sessionCardIds: ReadonlySet<string>
}

/** Pure queue selection over a deck subtree and its current scheduling policy. */
export function selectDueCards(input: DueSelectionInput): CardRecord[] {
  const { deckId, now, decks, groups, notes, cards, reviews, sessionCardIds } = input
  const decksById = new Map(decks.map((deck) => [deck.id, deck]))
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const notesById = new Map(notes.map((note) => [note.id, note]))
  const selectedGroup = decksById.get(deckId) && groupsById.get(decksById.get(deckId)!.optionGroupId)
  if (!selectedGroup) throw new Error('Deck option group not found')
  const { start, end } = studyDayWindow(now)
  const reviewedToday = new Map<string, { new: number; review: number }>()
  for (const review of reviews) {
    const timestamp = Date.parse(review.reviewedAt)
    if (review.rescheduled === false || !decksById.has(review.deckId) || timestamp < start || timestamp >= end) continue
    const totals = reviewedToday.get(review.deckId) ?? { new: 0, review: 0 }
    if (review.state === State.New) totals.new += 1
    if (review.state === State.Review || ((review.state === State.Learning || review.state === State.Relearning) && review.scheduledDays >= 1)) totals.review += 1
    reviewedToday.set(review.deckId, totals)
  }
  const deckPath = (deck: Deck) => {
    const names = [deck.name]
    let parent = deck.parentId ? decksById.get(deck.parentId) : undefined
    while (parent) {
      names.unshift(parent.name)
      parent = parent.parentId ? decksById.get(parent.parentId) : undefined
    }
    return names.join('\u0000')
  }
  const orderedDecks = [...decks].sort((left, right) => deckPath(left).localeCompare(deckPath(right)))
  const day = studyDayKey(now)
  const orderKey = (card: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => {
    const random = kind === 'new' ? group.newCardOrder === 'random' : kind === 'review' ? group.reviewCardOrder === 'random' : false
    if (random) return dailyShuffleRank(card, day)
    return kind === 'new' ? notesById.get(card.noteId)?.createdAt ?? card.due : card.due
  }
  const tiebreakKey = (card: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => {
    if (kind !== 'review' || group.reviewCardOrder !== 'due') return card.id
    // Anki's due-date review order randomizes equal-due cards using their
    // scheduling history rather than a per-day seed, so the order a learner
    // sees survives until those cards are answered.
    return String(stableRank(`${card.lastReview ?? ''}:${card.reps}:${card.deckId}:${card.id}`)).padStart(10, '0')
  }
  const compareWithinDeck = (left: CardRecord, right: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') =>
    orderKey(left, group, kind).localeCompare(orderKey(right, group, kind))
    || tiebreakKey(left, group, kind).localeCompare(tiebreakKey(right, group, kind))
    || left.id.localeCompare(right.id)
  const sortWithinDeck = (candidates: CardRecord[], group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => candidates.sort((left, right) => compareWithinDeck(left, right, group, kind))
  const sortQueue = (candidates: CardRecord[], kind: 'new' | 'review' | 'learning') => candidates.sort((left, right) => {
    if (left.deckId !== right.deckId) return deckPath(decksById.get(left.deckId)!).localeCompare(deckPath(decksById.get(right.deckId)!))
    return compareWithinDeck(left, right, selectedGroup, kind)
  })
  const reviewRetrievability = new Map<string, number>()
  const retrievability = (card: CardRecord) => {
    let value = reviewRetrievability.get(card.id)
    if (value === undefined) {
      value = schedulerFor(selectedGroup).get_retrievability(deserializeCard(card), now, false)
      reviewRetrievability.set(card.id, value)
    }
    return value
  }
  const compareReviews = (left: CardRecord, right: CardRecord) => {
    const order = selectedGroup.reviewCardOrder
    const due = left.due.localeCompare(right.due)
    const deck = deckPath(decksById.get(left.deckId)!).localeCompare(deckPath(decksById.get(right.deckId)!))
    const interval = left.scheduledDays - right.scheduledDays
    if (order === 'due') return due || String(stableRank(`${left.lastReview ?? ''}:${left.reps}:${left.deckId}:${left.id}`)).padStart(10, '0').localeCompare(String(stableRank(`${right.lastReview ?? ''}:${right.reps}:${right.deckId}:${right.id}`)).padStart(10, '0'))
    if (order === 'due-then-deck') return due || deck || left.id.localeCompare(right.id)
    if (order === 'deck-then-due') return deck || due || left.id.localeCompare(right.id)
    if (order === 'interval-ascending') return interval || due || left.id.localeCompare(right.id)
    if (order === 'interval-descending') return -interval || due || left.id.localeCompare(right.id)
    if (order === 'retrievability-ascending') return retrievability(left) - retrievability(right) || due || left.id.localeCompare(right.id)
    if (order === 'retrievability-descending') return retrievability(right) - retrievability(left) || due || left.id.localeCompare(right.id)
    return dailyShuffleRank(left, day).localeCompare(dailyShuffleRank(right, day)) || left.id.localeCompare(right.id)
  }
  const templateOrdinal = (card: CardRecord) => card.templateOrdinal ?? 0
  const noteShuffleRank = (card: CardRecord) => String(stableRank(`${day}:${card.deckId}:${card.noteId}`)).padStart(10, '0')
  const gatheredNew: CardRecord[] = []
  const newBudgetByDeck = new Map<string, number>()
  const selected: CardRecord[] = []
  for (const deck of orderedDecks) {
    const group = groupsById.get(deck.optionGroupId)
    if (!group) throw new Error('Deck option group not found')
    const own = cards.filter((card) => card.deckId === deck.id && !sessionCardIds.has(card.id) && eligibleForStudy(card, now))
    const learning = sortWithinDeck(own.filter(isLearningCard), selectedGroup, 'learning')
    const intradayLearning = learning.filter((card) => !isInterdayLearning(card))
    const interdayLearning = learning.filter(isInterdayLearning)
    const reviewsDue = own.filter((card) => card.state === State.Review).sort(compareReviews)
    const totals = reviewedToday.get(deck.id) ?? { new: 0, review: 0 }
    const limited = [...interdayLearning, ...reviewsDue]
    const reviewBudget = Math.max(0, group.dailyReviewLimit - totals.review)
    const gatheredLimited = limited.slice(0, reviewBudget)
    const newBudget = Math.min(
      Math.max(0, group.dailyNewLimit - totals.new),
      Math.max(0, reviewBudget - gatheredLimited.length),
    )
    newBudgetByDeck.set(deck.id, newBudget)
    selected.push(...intradayLearning, ...gatheredLimited)
  }
  const dueNewByDeck = new Map(orderedDecks.map((deck) => [deck.id, cards.filter((card) => card.deckId === deck.id && card.state === State.New && !sessionCardIds.has(card.id) && eligibleForStudy(card, now))]))
  const gatherOrder = selectedGroup.newCardGatherOrder ?? 'deck'
  const positionOrder = (left: CardRecord, right: CardRecord) => {
    const position = left.newPosition !== undefined && right.newPosition !== undefined
      ? left.newPosition - right.newPosition
      : (notesById.get(left.noteId)?.createdAt ?? left.due).localeCompare(notesById.get(right.noteId)?.createdAt ?? right.due)
    return position
      || deckPath(decksById.get(left.deckId)!).localeCompare(deckPath(decksById.get(right.deckId)!))
      || templateOrdinal(left) - templateOrdinal(right)
      || left.id.localeCompare(right.id)
  }
  const gatherNewDeckOrder = (candidates: CardRecord[]) => candidates.sort((left, right) => {
    if (gatherOrder === 'deck-random-notes') return noteShuffleRank(left).localeCompare(noteShuffleRank(right)) || templateOrdinal(left) - templateOrdinal(right) || left.id.localeCompare(right.id)
    return positionOrder(left, right)
  })
  const ownerRemaining = new Map(newBudgetByDeck)
  const takeNew = (card: CardRecord) => {
    const remaining = ownerRemaining.get(card.deckId) ?? 0
    if (remaining <= 0) return
    gatheredNew.push(card)
    ownerRemaining.set(card.deckId, remaining - 1)
  }
  if (gatherOrder === 'deck' || gatherOrder === 'deck-random-notes') {
    for (const deck of orderedDecks) {
      const due = dueNewByDeck.get(deck.id) ?? []
      for (const card of gatherNewDeckOrder(due)) takeNew(card)
    }
  } else {
    const due = [...dueNewByDeck.values()].flat()
    due.sort((left, right) => {
      if (gatherOrder === 'ascending-position') return positionOrder(left, right)
      if (gatherOrder === 'descending-position') return -positionOrder(left, right) || left.id.localeCompare(right.id)
      if (gatherOrder === 'random-notes') return noteShuffleRank(left).localeCompare(noteShuffleRank(right)) || templateOrdinal(left) - templateOrdinal(right) || left.id.localeCompare(right.id)
      return dailyShuffleRank(left, day).localeCompare(dailyShuffleRank(right, day)) || left.id.localeCompare(right.id)
    })
    for (const card of due) takeNew(card)
  }
  const gatherRank = new Map(gatheredNew.map((card, index) => [card.id, index]))
  const orderedNewCards = [...gatheredNew].sort((left, right) => {
    const order = selectedGroup.newCardSortOrder ?? (selectedGroup.newCardOrder === 'random' ? 'random' : 'template')
    const gathered = (gatherRank.get(left.id) ?? 0) - (gatherRank.get(right.id) ?? 0)
    if (order === 'gathered') return gathered || left.id.localeCompare(right.id)
    if (order === 'template') return templateOrdinal(left) - templateOrdinal(right) || gathered || left.id.localeCompare(right.id)
    if (order === 'template-random') return templateOrdinal(left) - templateOrdinal(right) || dailyShuffleRank(left, day).localeCompare(dailyShuffleRank(right, day)) || left.id.localeCompare(right.id)
    if (order === 'random-note-template') return noteShuffleRank(left).localeCompare(noteShuffleRank(right)) || templateOrdinal(left) - templateOrdinal(right) || left.id.localeCompare(right.id)
    return dailyShuffleRank(left, day).localeCompare(dailyShuffleRank(right, day)) || left.id.localeCompare(right.id)
  })
  const intradayLearning = sortQueue(selected.filter((card) => isLearningCard(card) && !isInterdayLearning(card)), 'learning')
  const interdayLearning = sortQueue(selected.filter(isInterdayLearning), 'learning')
  const orderedReviews = selected.filter((card) => card.state === State.Review).sort(compareReviews)
  const totalsAcrossSubtree = orderedDecks.reduce((sum, deck) => {
    const totals = reviewedToday.get(deck.id)
    return { new: sum.new + (totals?.new ?? 0), review: sum.review + (totals?.review ?? 0) }
  }, { new: 0, review: 0 })
  const reviewBudget = Math.max(0, selectedGroup.dailyReviewLimit - totalsAcrossSubtree.review)
  const gatheredLimited = [...interdayLearning, ...orderedReviews].slice(0, reviewBudget)
  const gatheredInterdayLearning = gatheredLimited.filter(isInterdayLearning)
  const gatheredReviews = gatheredLimited.filter((card) => card.state === State.Review)
  const reviewQueue = selectedGroup.interdayLearningOrder === 'before-reviews'
    ? [...gatheredInterdayLearning, ...gatheredReviews]
    : selectedGroup.interdayLearningOrder === 'after-reviews'
      ? [...gatheredReviews, ...gatheredInterdayLearning]
      : mixQueues(gatheredReviews, gatheredInterdayLearning)
  const newCards = orderedNewCards
    .slice(0, Math.min(
      Math.max(0, selectedGroup.dailyNewLimit - totalsAcrossSubtree.new),
      Math.max(0, reviewBudget - gatheredLimited.length),
    ))
  const mainQueue = selectedGroup.newReviewOrder === 'before-reviews'
    ? [...newCards, ...reviewQueue]
    : selectedGroup.newReviewOrder === 'after-reviews'
      ? [...reviewQueue, ...newCards]
      : mixQueues(reviewQueue, newCards)
  return [...intradayLearning, ...mainQueue]
}
