import {
  Rating,
  State,
  StrategyMode,
  fsrs,
  type AbstractScheduler,
  type Card as FsrsCard,
  type Grade,
  type ReviewLog as FsrsReviewLog,
} from 'ts-fsrs'
import type { CardRecord, Deck, DeckOptionGroup, Note, ReviewChoice, ReviewEntry } from './collection'

export { Rating, State }
export type { Grade }

export function eligibleForQueue(card: CardRecord, now: Date) {
  const buried = card.buriedUntil != null && Date.parse(card.buriedUntil) > now.getTime()
  return card.manualSuspended !== true && !(card.templateSuspended ?? Boolean(card.suspended)) && !buried
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
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  const end = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1)
  return { start: start.getTime(), end: end.getTime() }
}

export function nextStudyBoundary(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1)
}

function stableRank(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function studyDay(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
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

export function schedulerFor(group: DeckOptionGroup, cardId: string) {
  const scheduler = fsrs({
    request_retention: group.desiredRetention,
    maximum_interval: 36500,
    // Match Anki's fuzz policy and permit short-term learning steps.
    enable_fuzz: true,
    enable_short_term: true,
    learning_steps: validateSteps(group.learningSteps, 'Learning steps'),
    relearning_steps: validateSteps(group.relearningSteps, 'Relearning steps'),
  })
  // Seed fuzz from card identity and repetition count so replay on another device
  // produces the same answer schedule while sibling cards receive separate offsets.
  return scheduler.useStrategy(StrategyMode.SEED, function (this: AbstractScheduler) {
    return `${cardId}_${this.current.reps}`
  })
}

export function serializeCard(card: FsrsCard, identity: Pick<CardRecord, 'id' | 'deckId' | 'noteId' | 'templateId' | 'clozeOrdinal' | 'flag'>): CardRecord {
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

export function reviewChoices(card: CardRecord, group: DeckOptionGroup, now: Date, allowEarly = false): ReviewChoice[] {
  if (!(allowEarly ? eligibleForQueue(card, now) : eligibleForStudy(card, now))) return []
  const preview = schedulerFor(group, card.id).repeat(deserializeCard(card), now)
  const choices: Array<[Grade, ReviewChoice['label']]> = [
    [Rating.Again, 'Again'], [Rating.Hard, 'Hard'], [Rating.Good, 'Good'], [Rating.Easy, 'Easy'],
  ]
  return choices.map(([rating, label]) => ({ rating, label, interval: intervalLabel(preview[rating].card.due, now) }))
}

export function answerWithSchedule(card: CardRecord, group: DeckOptionGroup, rating: Grade, now: Date, reviewId: string) {
  const result = schedulerFor(group, card.id).next(deserializeCard(card), now, rating)
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
  temporaryCardIds: ReadonlySet<string>
}

/** Pure queue selection over a deck subtree and its current scheduling policy. */
export function selectDueCards(input: DueSelectionInput): CardRecord[] {
  const { deckId, now, decks, groups, notes, cards, reviews, temporaryCardIds } = input
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
  const day = studyDay(now)
  const orderKey = (card: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => {
    const random = kind === 'new' ? group.newCardOrder === 'random' : kind === 'review' ? group.reviewCardOrder === 'random' : false
    if (random) return dailyShuffleRank(card, day)
    return kind === 'new' ? notesById.get(card.noteId)?.createdAt ?? card.due : card.due
  }
  const tiebreakKey = (card: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => {
    if (kind !== 'review' || group.reviewCardOrder !== 'due') return card.id
    // Anki's due-date review order randomizes equal-due cards using their schedule
    // history; it stays stable until the card is answered again.
    return String(stableRank(`${card.lastReview ?? ''}:${card.reps}:${card.deckId}:${card.id}`)).padStart(10, '0')
  }
  const compareWithinDeck = (left: CardRecord, right: CardRecord, group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') =>
    orderKey(left, group, kind).localeCompare(orderKey(right, group, kind))
    || tiebreakKey(left, group, kind).localeCompare(tiebreakKey(right, group, kind))
    || left.id.localeCompare(right.id)
  const sortWithinDeck = (candidates: CardRecord[], group: DeckOptionGroup, kind: 'new' | 'review' | 'learning') => candidates.sort((left, right) => compareWithinDeck(left, right, group, kind))
  const sortQueue = (candidates: CardRecord[], kind: 'new' | 'review' | 'learning') => candidates.sort((left, right) => {
    if (left.deckId !== right.deckId) return left.deckId.localeCompare(right.deckId)
    const deck = decksById.get(left.deckId)!
    const group = groupsById.get(deck.optionGroupId)
    if (!group) throw new Error('Deck option group not found')
    return compareWithinDeck(left, right, group, kind)
  })
  const selected: CardRecord[] = []
  for (const deck of decks) {
    const group = groupsById.get(deck.optionGroupId)
    if (!group) throw new Error('Deck option group not found')
    const own = cards.filter((card) => card.deckId === deck.id && !temporaryCardIds.has(card.id) && eligibleForStudy(card, now))
    const learning = sortWithinDeck(own.filter(isLearningCard), group, 'learning')
    const intradayLearning = learning.filter((card) => !isInterdayLearning(card))
    const interdayLearning = learning.filter(isInterdayLearning)
    const reviewsDue = sortWithinDeck(own.filter((card) => card.state === State.Review), group, 'review')
    const newCards = sortWithinDeck(own.filter((card) => card.state === State.New), group, 'new')
    const totals = reviewedToday.get(deck.id) ?? { new: 0, review: 0 }
    const limited = group.interdayLearningOrder === 'before-reviews' ? [...interdayLearning, ...reviewsDue] : [...reviewsDue, ...interdayLearning]
    selected.push(...intradayLearning, ...limited.slice(0, Math.max(0, group.dailyReviewLimit - totals.review)), ...newCards.slice(0, Math.max(0, group.dailyNewLimit - totals.new)))
  }
  const intradayLearning = sortQueue(selected.filter((card) => isLearningCard(card) && !isInterdayLearning(card)), 'learning')
  const interdayLearning = sortQueue(selected.filter(isInterdayLearning), 'learning')
  const orderedReviews = sortQueue(selected.filter((card) => card.state === State.Review), 'review')
  const newCards = sortQueue(selected.filter((card) => card.state === State.New), 'new')
  const reviewQueue = selectedGroup.interdayLearningOrder === 'before-reviews'
    ? [...interdayLearning, ...orderedReviews]
    : [...orderedReviews, ...interdayLearning]
  return [...intradayLearning, ...reviewQueue, ...newCards]
}
