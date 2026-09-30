import Dexie, { type EntityTable } from 'dexie'
import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card as FsrsCard,
  type Grade,
  type ReviewLog as FsrsReviewLog,
} from 'ts-fsrs'

export { Rating, State }
export type { Grade }

export interface Deck {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface BasicNoteFields {
  front: string
  back: string
}

export interface Note {
  id: string
  deckId: string
  type: 'basic'
  fields: BasicNoteFields
  createdAt: string
  updatedAt: string
}

export interface CardRecord {
  id: string
  deckId: string
  noteId: string
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: State
  lastReview: string | null
}

export interface ReviewEntry {
  id: string
  cardId: string
  deckId: string
  rating: Rating
  state: State
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  lastElapsedDays: number
  scheduledDays: number
  learningSteps: number
  reviewedAt: string
}

export interface DeckCounts {
  new: number
  learning: number
  review: number
}

export interface DeckSummary extends Deck {
  counts: DeckCounts
  noteCount: number
  reviewCount: number
}

export interface ReviewChoice {
  rating: Grade
  label: 'Again' | 'Hard' | 'Good' | 'Easy'
  interval: string
}

export interface SyncOperation {
  opId: string
  entityType: 'deck' | 'note' | 'card' | 'review'
  entityId: string
  action: 'create' | 'update' | 'delete'
  occurredAt: string
  payload: unknown
}

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
})

function id() {
  return crypto.randomUUID()
}

function requiredText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function serializeCard(card: FsrsCard, identity: Pick<CardRecord, 'id' | 'deckId' | 'noteId'>): CardRecord {
  return {
    ...identity,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review?.toISOString() ?? null,
  }
}

function deserializeCard(card: CardRecord): FsrsCard {
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

function serializeReview(log: FsrsReviewLog, identity: Pick<ReviewEntry, 'id' | 'cardId' | 'deckId'>): ReviewEntry {
  return {
    ...identity,
    rating: log.rating,
    state: log.state,
    due: log.due.toISOString(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps,
    reviewedAt: log.review.toISOString(),
  }
}

function intervalLabel(due: Date, reviewedAt: Date) {
  const seconds = Math.max(1, Math.round((due.getTime() - reviewedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function countsFor(cards: CardRecord[]): DeckCounts {
  return cards.reduce<DeckCounts>((counts, card) => {
    if (card.state === State.New) counts.new += 1
    else if (card.state === State.Review) counts.review += 1
    else counts.learning += 1
    return counts
  }, { new: 0, learning: 0, review: 0 })
}

export class Collection extends Dexie {
  decks!: EntityTable<Deck, 'id'>
  notes!: EntityTable<Note, 'id'>
  cards!: EntityTable<CardRecord, 'id'>
  reviewEntries!: EntityTable<ReviewEntry, 'id'>
  outbox!: EntityTable<SyncOperation, 'opId'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      decks: 'id, name, createdAt',
      notes: 'id, deckId, updatedAt',
      cards: 'id, deckId, noteId, due, state',
      reviewEntries: 'id, cardId, deckId, reviewedAt',
    })
    this.version(2).stores({
      decks: 'id, name, createdAt',
      notes: 'id, deckId, updatedAt',
      cards: 'id, deckId, noteId, due, state',
      reviewEntries: 'id, cardId, deckId, reviewedAt',
      outbox: 'opId, entityType, entityId, occurredAt',
    })
  }

  async createDeck(name: string, now = new Date()): Promise<Deck> {
    const deck: Deck = {
      id: id(),
      name: requiredText(name, 'Deck name'),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    await this.transaction('rw', this.decks, this.outbox, async () => {
      await this.decks.add(deck)
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deck.id, action: 'create', occurredAt: deck.createdAt, payload: deck })
    })
    return deck
  }

  async renameDeck(deckId: string, name: string, now = new Date()): Promise<void> {
    const updated = await this.decks.update(deckId, {
      name: requiredText(name, 'Deck name'),
      updatedAt: now.toISOString(),
    })
    if (!updated) throw new Error('Deck not found')
  }

  async deleteDeck(deckId: string): Promise<void> {
    await this.transaction('rw', this.decks, this.notes, this.cards, this.reviewEntries, async () => {
      await Promise.all([
        this.decks.delete(deckId),
        this.notes.where('deckId').equals(deckId).delete(),
        this.cards.where('deckId').equals(deckId).delete(),
        this.reviewEntries.where('deckId').equals(deckId).delete(),
      ])
    })
  }

  async createBasicNote(deckId: string, fields: BasicNoteFields, now = new Date()): Promise<Note> {
    if (!await this.decks.get(deckId)) throw new Error('Deck not found')
    const noteId = id()
    const note: Note = {
      id: noteId,
      deckId,
      type: 'basic',
      fields: {
        front: requiredText(fields.front, 'Front'),
        back: requiredText(fields.back, 'Back'),
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    const emptyCard = createEmptyCard(now)
    const card = serializeCard(emptyCard, { id: id(), deckId, noteId })

    await this.transaction('rw', this.notes, this.cards, this.outbox, async () => {
      await this.notes.add(note)
      await this.cards.add(card)
      await this.outbox.bulkAdd([
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note },
        { opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: note.createdAt, payload: card },
      ])
    })
    return note
  }

  async updateBasicNote(noteId: string, fields: BasicNoteFields, now = new Date()): Promise<void> {
    const updated = await this.notes.update(noteId, {
      fields: {
        front: requiredText(fields.front, 'Front'),
        back: requiredText(fields.back, 'Back'),
      },
      updatedAt: now.toISOString(),
    })
    if (!updated) throw new Error('Note not found')
  }

  async counts(deckId: string): Promise<DeckCounts> {
    return countsFor(await this.cards.where('deckId').equals(deckId).toArray())
  }

  async summaries(): Promise<DeckSummary[]> {
    return this.transaction('r', this.decks, this.notes, this.cards, this.reviewEntries, async () => {
      const decks = await this.decks.orderBy('createdAt').toArray()
      return Promise.all(decks.map(async (deck) => {
        const [cards, noteCount, reviewCount] = await Promise.all([
          this.cards.where('deckId').equals(deck.id).toArray(),
          this.notes.where('deckId').equals(deck.id).count(),
          this.reviewEntries.where('deckId').equals(deck.id).count(),
        ])
        return { ...deck, counts: countsFor(cards), noteCount, reviewCount }
      }))
    })
  }

  async dueCards(deckId: string, now = new Date()): Promise<CardRecord[]> {
    const cards = await this.cards.where('deckId').equals(deckId).toArray()
    return cards
      .filter((card) => card.state === State.New || new Date(card.due).getTime() <= now.getTime())
      .sort((left, right) => left.due.localeCompare(right.due))
  }

  async reviewChoices(cardId: string, now = new Date()): Promise<ReviewChoice[]> {
    const card = await this.cards.get(cardId)
    if (!card) throw new Error('Card not found')
    const preview = scheduler.repeat(deserializeCard(card), now)
    const choices: Array<[Grade, ReviewChoice['label']]> = [
      [Rating.Again, 'Again'],
      [Rating.Hard, 'Hard'],
      [Rating.Good, 'Good'],
      [Rating.Easy, 'Easy'],
    ]
    return choices.map(([rating, label]) => ({
      rating,
      label,
      interval: intervalLabel(preview[rating].card.due, now),
    }))
  }

  async answer(cardId: string, rating: Grade, now = new Date()): Promise<ReviewEntry> {
    const existing = await this.cards.get(cardId)
    if (!existing) throw new Error('Card not found')
    const result = scheduler.next(deserializeCard(existing), now, rating)
    const card = serializeCard(result.card, existing)
    const review = serializeReview(result.log, {
      id: id(),
      cardId,
      deckId: existing.deckId,
    })
    await this.transaction('rw', this.cards, this.reviewEntries, this.outbox, async () => {
      await this.cards.put(card)
      await this.reviewEntries.add(review)
      await this.outbox.bulkAdd([
        { opId: id(), entityType: 'card', entityId: card.id, action: 'update', occurredAt: review.reviewedAt, payload: card },
        { opId: id(), entityType: 'review', entityId: review.id, action: 'create', occurredAt: review.reviewedAt, payload: review },
      ])
    })
    return review
  }

  async pendingOperations(): Promise<SyncOperation[]> {
    return this.outbox.orderBy('occurredAt').toArray()
  }
}

export function createCollection(name = 'kiroku-collection') {
  return new Collection(name)
}

export const collection = createCollection()
