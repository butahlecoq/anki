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
import { digestMedia, validateMedia, type AudioPlayback, type MediaKind, type MediaSide } from './media'
import { renderTemplate, validateTemplate } from './template-renderer'

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

export const BASIC_NOTE_TYPE_ID = 'basic'
export const BASIC_TEMPLATE_ID = 'basic'

export interface NoteTypeField { readonly id: string; readonly name: string }
export interface CardTemplate { readonly id: string; readonly name: string; readonly front: string; readonly back: string; readonly css: string }
export interface NoteType {
  readonly id: string
  readonly name: string
  readonly fields: readonly NoteTypeField[]
  readonly templates: readonly CardTemplate[]
  readonly protected: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
export interface NewNoteType {
  name: string
  fields: readonly { name: string }[]
  templates: readonly { name: string; front: string; back: string; css: string }[]
}

const basicNoteType: NoteType = {
  id: BASIC_NOTE_TYPE_ID, name: 'Basic', protected: true,
  fields: [{ id: 'front', name: 'front' }, { id: 'back', name: 'back' }],
  templates: [{ id: BASIC_TEMPLATE_ID, name: 'Basic', front: '{{front}}', back: '{{FrontSide}}<hr>{{back}}', css: '' }],
  createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
}

/** Note values are stored by immutable field ID; templates address display names. */
export function renderNoteTemplate(template: string, noteType: NoteType, fieldsById: Record<string, string>, front?: string) {
  const displayFields = Object.fromEntries(noteType.fields.map((field) => [field.name, fieldsById[field.id] ?? '']))
  return renderTemplate(template, displayFields, front)
}

export interface Note {
  id: string
  deckId: string
  type: 'basic' | 'custom'
  typeId?: string
  fields: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface CardRecord {
  id: string
  deckId: string
  noteId: string
  templateId?: string
  suspended?: boolean
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
  entityType: 'deck' | 'note' | 'card' | 'review' | 'noteMedia' | 'noteType'
  entityId: string
  action: 'create' | 'update' | 'delete'
  occurredAt: string
  payload: unknown
}

export interface SyncSettings { endpoint: string; token: string; cursor: number }
interface DeletionTombstone { key: string; entityType: SyncOperation['entityType']; entityId: string; occurredAt: string }
export interface NoteMediaReference { id: string; noteId: string; digest: string; kind: MediaKind; mimeType: string; displayName: string; side: MediaSide; playback: AudioPlayback; createdAt: string; updatedAt: string }
export interface MediaBlob { digest: string; blob: Blob; byteLength: number; mimeType: string; verifiedAt: string }
export interface NoteMediaAttachment { file: File; side: MediaSide; playback?: AudioPlayback }

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

const tombstoneKey = (entityType: SyncOperation['entityType'], entityId: string) => `${entityType}:${entityId}`

function relatedEntityIds(change: SyncOperation) {
  if (!change.payload || typeof change.payload !== 'object') return {}
  const payload = change.payload as { deckId?: unknown; noteId?: unknown }
  return {
    deckId: typeof payload.deckId === 'string' ? payload.deckId : undefined,
    noteId: typeof payload.noteId === 'string' ? payload.noteId : undefined,
  }
}

function requiredText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function serializeCard(card: FsrsCard, identity: Pick<CardRecord, 'id' | 'deckId' | 'noteId' | 'templateId'>): CardRecord {
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
  return cards.filter((card) => !card.suspended).reduce<DeckCounts>((counts, card) => {
    if (card.state === State.New) counts.new += 1
    else if (card.state === State.Review) counts.review += 1
    else counts.learning += 1
    return counts
  }, { new: 0, learning: 0, review: 0 })
}

export class Collection extends Dexie {
  noteTypes!: EntityTable<NoteType, 'id'>
  decks!: EntityTable<Deck, 'id'>
  notes!: EntityTable<Note, 'id'>
  cards!: EntityTable<CardRecord, 'id'>
  reviewEntries!: EntityTable<ReviewEntry, 'id'>
  outbox!: EntityTable<SyncOperation, 'opId'>
  settings!: EntityTable<{ key: string; value: unknown }, 'key'>
  receivedOperations!: EntityTable<{ opId: string }, 'opId'>
  deletedEntities!: EntityTable<DeletionTombstone, 'key'>
  noteMedia!: EntityTable<NoteMediaReference, 'id'>
  mediaBlobs!: EntityTable<MediaBlob, 'digest'>

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
    this.version(3).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId',
    })
    this.version(4).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt',
    })
    this.version(5).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt',
    })
    this.version(6).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('noteTypes').put(basicNoteType)
      await transaction.table('notes').toCollection().modify((note: Note) => { if (note.type === 'basic' && !note.typeId) note.typeId = BASIC_NOTE_TYPE_ID })
      await transaction.table('cards').toCollection().modify((card: CardRecord) => { if (!card.templateId) card.templateId = BASIC_TEMPLATE_ID })
    })
    this.on('populate', (transaction) => {
      transaction.table('noteTypes').put(basicNoteType)
    })
  }

  async createNoteType(input: NewNoteType, now = new Date()): Promise<NoteType> {
    if (!input.fields.length) throw new Error('A note type needs at least one field')
    if (!input.templates.length) throw new Error('A note type needs at least one template')
    const names = input.fields.map((field) => requiredText(field.name, 'Field name'))
    if (new Set(names).size !== names.length) throw new Error('Field names must be unique')
    if (names.includes('FrontSide')) throw new Error('FrontSide is reserved for template backs')
    for (const template of input.templates) {
      validateTemplate(template.front, names, 'front')
      validateTemplate(template.back, names, 'back')
    }
    const noteType: NoteType = {
      id: id(), name: requiredText(input.name, 'Note type name'), protected: false,
      fields: names.map((name) => ({ id: id(), name })),
      templates: input.templates.map((template) => ({ id: id(), name: requiredText(template.name, 'Template name'), front: template.front, back: template.back, css: template.css })),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }
    await this.transaction('rw', this.noteTypes, this.outbox, async () => {
      await this.noteTypes.add(noteType)
      await this.outbox.add({ opId: id(), entityType: 'noteType', entityId: noteType.id, action: 'create', occurredAt: noteType.createdAt, payload: noteType })
    })
    return noteType
  }

  cardGenerationStatus(noteType: NoteType, fields: Record<string, string>) {
    const skipped: { templateId: string; reason: string }[] = []
    const eligible: CardTemplate[] = []
    for (const template of noteType.templates) {
      if (renderNoteTemplate(template.front, noteType, fields).isEmpty) skipped.push({ templateId: template.id, reason: 'Front has no visible field content' })
      else eligible.push(template)
    }
    return { eligible, skipped }
  }

  async createNote(deckId: string, typeId: string, fields: Record<string, string>, now = new Date()): Promise<Note> {
    return this.transaction('rw', [this.decks, this.noteTypes, this.notes, this.cards, this.outbox], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      const noteType = await this.noteTypes.get(typeId)
      if (!noteType) throw new Error('Note type not found')
      const values = Object.fromEntries(noteType.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const note: Note = { id: id(), deckId, type: typeId === BASIC_NOTE_TYPE_ID ? 'basic' : 'custom', typeId, fields: values, createdAt: now.toISOString(), updatedAt: now.toISOString() }
      const cards = this.cardGenerationStatus(noteType, values).eligible.map((template) => serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}`, deckId, noteId: note.id, templateId: template.id }))
      await this.notes.add(note)
      if (cards.length) await this.cards.bulkAdd(cards)
      await this.outbox.bulkAdd([
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note },
        ...cards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'create' as const, occurredAt: note.createdAt, payload: card })),
      ])
      return note
    })
  }

  async updateNote(noteId: string, fields: Record<string, string>, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox], async () => {
      const note = await this.notes.get(noteId)
      if (!note) throw new Error('Note not found')
      const noteType = await this.noteTypes.get(note.typeId ?? BASIC_NOTE_TYPE_ID)
      if (!noteType) throw new Error('Note type not found')
      const values = Object.fromEntries(noteType.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const updated: Note = { ...note, fields: values, updatedAt: now.toISOString() }
      const existing = await this.cards.where('noteId').equals(noteId).toArray()
      const eligible = this.cardGenerationStatus(noteType, values).eligible
      const eligibleIds = new Set(eligible.map((template) => template.id))
      const changes: SyncOperation[] = [{ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated }]
      for (const card of existing) {
        const suspended = !eligibleIds.has(card.templateId ?? BASIC_TEMPLATE_ID)
        if (Boolean(card.suspended) === suspended) continue
        const revised = { ...card, suspended }
        await this.cards.put(revised)
        changes.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'update', occurredAt: updated.updatedAt, payload: revised })
      }
      for (const template of eligible) {
        if (existing.some((card) => (card.templateId ?? BASIC_TEMPLATE_ID) === template.id)) continue
        const card = serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}`, deckId: note.deckId, noteId, templateId: template.id })
        await this.cards.put(card)
        changes.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: updated.updatedAt, payload: card })
      }
      await this.notes.put(updated)
      await this.outbox.bulkAdd(changes)
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
    await this.transaction('rw', this.decks, this.outbox, async () => {
      const deck = await this.decks.get(deckId)
      if (!deck) throw new Error('Deck not found')
      const updated = { ...deck, name: requiredText(name, 'Deck name'), updatedAt: now.toISOString() }
      await this.decks.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async deleteDeck(deckId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.outbox, this.deletedEntities], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      const noteIds = (await this.notes.where('deckId').equals(deckId).primaryKeys()) as string[]
      await Promise.all([
        this.decks.delete(deckId),
        this.notes.where('deckId').equals(deckId).delete(),
        this.cards.where('deckId').equals(deckId).delete(),
        this.reviewEntries.where('deckId').equals(deckId).delete(),
        noteIds.length ? this.noteMedia.where('noteId').anyOf(noteIds).delete() : Promise.resolve(),
      ])
      const occurredAt = now.toISOString()
      await this.deletedEntities.put({ key: tombstoneKey('deck', deckId), entityType: 'deck', entityId: deckId, occurredAt })
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deckId, action: 'delete', occurredAt, payload: { id: deckId } })
    })
  }

  async createBasicNote(deckId: string, fields: BasicNoteFields, now = new Date()): Promise<Note> {
    return this.createBasicNoteWithMedia(deckId, fields, [], now)
  }

  async createBasicNoteWithMedia(deckId: string, fields: BasicNoteFields, attachments: NoteMediaAttachment[], now = new Date()): Promise<Note> {
    const createdAt = now.toISOString()
    const prepared = await Promise.all(attachments.map(async ({ file, side, playback = 'manual' }) => {
      const definition = validateMedia(file)
      const digest = await digestMedia(file)
      return { definition, file, digest, side, playback }
    }))
    const noteId = id()
    const note: Note = {
      id: noteId,
      deckId,
      type: 'basic',
      typeId: BASIC_NOTE_TYPE_ID,
      fields: {
        front: requiredText(fields.front, 'Front'),
        back: requiredText(fields.back, 'Back'),
      },
      createdAt,
      updatedAt: createdAt,
    }
    const emptyCard = createEmptyCard(now)
    const card = serializeCard(emptyCard, { id: `${noteId}:${BASIC_TEMPLATE_ID}`, deckId, noteId, templateId: BASIC_TEMPLATE_ID })
    const references: NoteMediaReference[] = prepared.map(({ definition, file, digest, side, playback }) => ({ id: id(), noteId, digest, kind: definition.kind, mimeType: file.type, displayName: file.name, side, playback, createdAt, updatedAt: createdAt }))
    const blobs = [...new Map(prepared.map(({ file, digest }) => [digest, { digest, blob: file as Blob, byteLength: file.size, mimeType: file.type, verifiedAt: createdAt } satisfies MediaBlob])).values()]

    await this.transaction('rw', [this.decks, this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      await this.notes.add(note)
      await this.cards.add(card)
      if (references.length) await this.noteMedia.bulkAdd(references)
      if (blobs.length) await this.mediaBlobs.bulkPut(blobs)
      await this.outbox.bulkAdd([
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note },
        { opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: note.createdAt, payload: card },
        ...references.map((reference) => ({ opId: id(), entityType: 'noteMedia' as const, entityId: reference.id, action: 'create' as const, occurredAt: reference.createdAt, payload: reference })),
      ])
    })
    return note
  }

  async updateBasicNote(noteId: string, fields: BasicNoteFields, now = new Date()): Promise<void> {
    await this.transaction('rw', this.notes, this.outbox, async () => {
      const note = await this.notes.get(noteId)
      if (!note) throw new Error('Note not found')
      const updated = {
        ...note,
        fields: {
        front: requiredText(fields.front, 'Front'),
        back: requiredText(fields.back, 'Back'),
      },
        updatedAt: now.toISOString(),
      }
      await this.notes.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async attachMedia(noteId: string, { file, side, playback = 'manual' }: NoteMediaAttachment, now = new Date()): Promise<NoteMediaReference> {
    if (!await this.notes.get(noteId)) throw new Error('Note not found')
    const definition = validateMedia(file)
    const digest = await digestMedia(file)
    const reference: NoteMediaReference = { id: id(), noteId, digest, kind: definition.kind, mimeType: file.type, displayName: file.name, side, playback, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    const blob: MediaBlob = { digest, blob: file, byteLength: file.size, mimeType: file.type, verifiedAt: now.toISOString() }
    await this.transaction('rw', this.noteMedia, this.mediaBlobs, this.outbox, async () => {
      await this.mediaBlobs.put(blob)
      await this.noteMedia.add(reference)
      await this.outbox.add({ opId: id(), entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: reference.createdAt, payload: reference })
    })
    return reference
  }

  async mediaForNote(noteId: string) {
    return this.noteMedia.where('noteId').equals(noteId).sortBy('createdAt')
  }

  async missingReferencedMedia() {
    const references = await this.noteMedia.toArray()
    const available = new Set(await this.mediaBlobs.toCollection().primaryKeys())
    return references.filter((reference) => !available.has(reference.digest))
  }

  async verifiedMediaBlob(digest: string) {
    return this.mediaBlobs.get(digest)
  }

  async storeDownloadedMedia(digest: string, blob: Blob, now = new Date()) {
    if (await digestMedia(blob) !== digest) throw new Error('Downloaded media did not match its content digest.')
    await this.mediaBlobs.put({ digest, blob, byteLength: blob.size, mimeType: blob.type, verifiedAt: now.toISOString() })
  }

  async removeMedia(referenceId: string, now = new Date()) {
    await this.transaction('rw', this.noteMedia, this.outbox, async () => {
      const reference = await this.noteMedia.get(referenceId)
      if (!reference) throw new Error('Media reference not found')
      await this.noteMedia.delete(referenceId)
      await this.outbox.add({ opId: id(), entityType: 'noteMedia', entityId: referenceId, action: 'delete', occurredAt: now.toISOString(), payload: { id: referenceId, noteId: reference.noteId, digest: reference.digest } })
    })
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
      .filter((card) => !card.suspended && (card.state === State.New || new Date(card.due).getTime() <= now.getTime()))
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
    if (existing.suspended) throw new Error('Card is suspended because its template front is empty')
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

  async acknowledgeOperations(opIds: string[]) {
    await this.outbox.bulkDelete(opIds)
  }

  async configureSync(settings: SyncSettings) {
    await this.settings.put({ key: 'sync', value: settings })
  }

  async syncSettings(): Promise<SyncSettings | undefined> {
    return (await this.settings.get('sync'))?.value as SyncSettings | undefined
  }

  async applyRemoteChanges(changes: SyncOperation[], cursor: number) {
    await this.transaction('rw', [this.decks, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.receivedOperations, this.settings, this.deletedEntities], async () => {
      for (const change of changes) {
        if (await this.receivedOperations.get(change.opId)) continue
        if (change.action !== 'delete') {
          const related = relatedEntityIds(change)
          const deleted = await Promise.all([
            this.deletedEntities.get(tombstoneKey(change.entityType, change.entityId)),
            related.deckId ? this.deletedEntities.get(tombstoneKey('deck', related.deckId)) : undefined,
            related.noteId ? this.deletedEntities.get(tombstoneKey('note', related.noteId)) : undefined,
          ])
          if (deleted.some(Boolean)) {
            await this.receivedOperations.add({ opId: change.opId })
            continue
          }
        }
        if (change.action === 'delete') {
          await this.deletedEntities.put({ key: tombstoneKey(change.entityType, change.entityId), entityType: change.entityType, entityId: change.entityId, occurredAt: change.occurredAt })
          if (change.entityType === 'deck') {
            const noteIds = (await this.notes.where('deckId').equals(change.entityId).primaryKeys()) as string[]
            await this.decks.delete(change.entityId)
            await this.notes.where('deckId').equals(change.entityId).delete()
            await this.cards.where('deckId').equals(change.entityId).delete()
            await this.reviewEntries.where('deckId').equals(change.entityId).delete()
            if (noteIds.length) await this.noteMedia.where('noteId').anyOf(noteIds).delete()
          } else if (change.entityType === 'note') {
            await this.notes.delete(change.entityId)
            const cardIds = (await this.cards.where('noteId').equals(change.entityId).primaryKeys()) as string[]
            await this.cards.bulkDelete(cardIds)
            if (cardIds.length) await this.reviewEntries.where('cardId').anyOf(cardIds).delete()
            await this.noteMedia.where('noteId').equals(change.entityId).delete()
          } else if (change.entityType === 'card') {
            await this.cards.delete(change.entityId)
            await this.reviewEntries.where('cardId').equals(change.entityId).delete()
          } else if (change.entityType === 'noteMedia') {
            await this.noteMedia.delete(change.entityId)
          } else if (change.entityType === 'noteType') {
            if (change.entityId !== BASIC_NOTE_TYPE_ID) await this.noteTypes.delete(change.entityId)
          } else {
            await this.reviewEntries.delete(change.entityId)
          }
        } else if (change.entityType === 'deck') await this.decks.put(change.payload as Deck)
        else if (change.entityType === 'note') await this.notes.put(change.payload as Note)
        else if (change.entityType === 'card') await this.cards.put(change.payload as CardRecord)
        else if (change.entityType === 'noteMedia') await this.noteMedia.put(change.payload as NoteMediaReference)
        else if (change.entityType === 'noteType' && change.entityId !== BASIC_NOTE_TYPE_ID) await this.noteTypes.put(change.payload as NoteType)
        else if (change.entityType === 'review') await this.reviewEntries.put(change.payload as ReviewEntry)
        await this.receivedOperations.add({ opId: change.opId })
      }
      const existing = await this.settings.get('sync')
      if (existing) await this.settings.put({ key: 'sync', value: { ...(existing.value as SyncSettings), cursor } })
    })
  }
}

export function createCollection(name = 'kiroku-collection') {
  return new Collection(name)
}

export const collection = createCollection()
