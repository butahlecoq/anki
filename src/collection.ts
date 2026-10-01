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
import { clozeOrdinals, renderTemplate, tryRenderTemplate, validateTemplate } from './template-renderer'

export { Rating, State }
export type { Grade }

export interface Deck {
  id: string
  name: string
  parentId: string | null
  optionGroupId: string
  createdAt: string
  updatedAt: string
}

export const DEFAULT_DECK_OPTION_GROUP_ID = 'default'

/** Reusable scheduling settings are introduced independently of any individual deck. */
export interface DeckOptionGroup {
  id: string
  name: string
  protected: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateDeckOptions {
  parentId?: string | null
  optionGroupId?: string
}

export type DeleteDeckOptions =
  | { mode: 'delete-subtree' }
  | { mode: 'relocate'; destinationDeckId: string }

export interface BasicNoteFields {
  front: string
  back: string
}

export const BASIC_NOTE_TYPE_ID = 'basic'
export const BASIC_TEMPLATE_ID = 'basic'
export const IMAGE_OCCLUSION_NOTE_TYPE_ID = 'image-occlusion'
export const IMAGE_OCCLUSION_TEMPLATE_ID = 'image-occlusion'

export interface OcclusionMask { id: string; ordinal: number; x: number; y: number; width: number; height: number }
export interface ImageOcclusion { version: 1; sourceMediaId: string; imageWidth: number; imageHeight: number; nextOrdinal: number; masks: OcclusionMask[] }
export interface OcclusionMaskDraft { id?: string; ordinal?: number; x: number; y: number; width: number; height: number }
export interface NewImageOcclusionNote { image: File; imageWidth: number; imageHeight: number; header: string; backExtra: string; tags: string[]; masks: OcclusionMaskDraft[] }
export interface UpdateImageOcclusionNote { image?: File; imageWidth?: number; imageHeight?: number; header?: string; backExtra?: string; tags?: string[]; masks?: OcclusionMaskDraft[] }

export interface NoteTypeField { readonly id: string; readonly name: string }
export interface CardTemplate { readonly id: string; readonly name: string; readonly front: string; readonly back: string; readonly css: string }
export interface NoteType {
  readonly id: string
  readonly name: string
  readonly kind: 'standard' | 'cloze' | 'image-occlusion'
  readonly fields: readonly NoteTypeField[]
  readonly templates: readonly CardTemplate[]
  readonly protected: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
export interface NewNoteType {
  name: string
  kind?: 'standard' | 'cloze'
  fields: readonly { name: string }[]
  templates: readonly { name: string; front: string; back: string; css: string }[]
}
export interface UpdateNoteType {
  name?: string
  fields?: readonly { id?: string; name: string }[]
  templates?: readonly { id?: string; name: string; front: string; back: string; css: string }[]
  removedFields?: Record<string, 'discard' | 'keep-as-extra'>
}
export interface NoteTypeReplacement {
  replacementTypeId: string
  /** Source field ID to replacement field ID. Unmapped values become retired data. */
  fieldMapping?: Record<string, string>
}

const basicNoteType: NoteType = {
  id: BASIC_NOTE_TYPE_ID, name: 'Basic', kind: 'standard', protected: true,
  fields: [{ id: 'front', name: 'front' }, { id: 'back', name: 'back' }],
  templates: [{ id: BASIC_TEMPLATE_ID, name: 'Basic', front: '{{front}}', back: '{{FrontSide}}<hr>{{back}}', css: '' }],
  createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
}

const imageOcclusionNoteType: NoteType = {
  id: IMAGE_OCCLUSION_NOTE_TYPE_ID, name: 'Image Occlusion', kind: 'image-occlusion', protected: true,
  fields: [{ id: 'header', name: 'Header' }, { id: 'backExtra', name: 'Back Extra' }],
  templates: [{ id: IMAGE_OCCLUSION_TEMPLATE_ID, name: 'Hide one, reveal one', front: '{{Header}}', back: '{{Header}}<hr>{{Back Extra}}', css: '' }],
  createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
}

/** Note values are stored by immutable field ID; templates address display names. */
export function renderNoteTemplate(template: string, noteType: NoteType, fieldsById: Record<string, string>, front?: string, ordinal?: number, side?: 'front' | 'back') {
  const displayFields = Object.fromEntries(noteType.fields.map((field) => [field.name, fieldsById[field.id] ?? '']))
  return renderTemplate(template, displayFields, front, { kind: noteType.kind === 'image-occlusion' ? 'standard' : noteType.kind, ordinal, side: side ?? (front === undefined ? 'front' : 'back') })
}

export function tryRenderNoteTemplate(template: string, noteType: NoteType, fieldsById: Record<string, string>, front?: string, ordinal?: number, side?: 'front' | 'back') {
  const displayFields = Object.fromEntries(noteType.fields.map((field) => [field.name, fieldsById[field.id] ?? '']))
  return tryRenderTemplate(template, displayFields, front, { kind: noteType.kind === 'image-occlusion' ? 'standard' : noteType.kind, ordinal, side: side ?? (front === undefined ? 'front' : 'back') })
}

export interface Note {
  id: string
  deckId: string
  type: 'basic' | 'custom'
  typeId: string
  fields: Record<string, string>
  tags?: string[]
  imageOcclusion?: ImageOcclusion
  retiredFields?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface CardRecord {
  id: string
  deckId: string
  noteId: string
  templateId: string
  clozeOrdinal?: number
  occlusionId?: string
  occlusionOrdinal?: number
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

type LegacyNote = Omit<Note, 'typeId'> & { typeId?: string }
type LegacyCard = Omit<CardRecord, 'templateId'> & { templateId?: string }
type LegacyNoteType = Omit<NoteType, 'kind'> & { kind?: NoteType['kind'] }
type LegacyDeck = Omit<Deck, 'parentId' | 'optionGroupId'> & { parentId?: string | null; optionGroupId?: string }

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
  entityType: 'deck' | 'deckOptionGroup' | 'note' | 'card' | 'review' | 'noteMedia' | 'noteType'
  entityId: string
  action: 'create' | 'update' | 'delete'
  occurredAt: string
  payload: unknown
}

export interface SyncSettings { endpoint: string; token: string; cursor: number }
interface DeletionTombstone { key: string; entityType: SyncOperation['entityType']; entityId: string; occurredAt: string }
export interface NoteMediaReference { id: string; noteId: string; digest: string; kind: MediaKind; mimeType: string; displayName: string; side: MediaSide; playback: AudioPlayback; createdAt: string; updatedAt: string }
export interface MediaBlob { digest: string; blob: Blob; byteLength: number; mimeType: string; verifiedAt: string }
interface StoredMediaBlob extends Omit<MediaBlob, 'blob'> { blob: Blob | ArrayBuffer }
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
function inboundDependencyOrder(change: SyncOperation) {
  if (change.entityType === 'deckOptionGroup') return change.action === 'delete' ? 7 : 0
  return ({ deck: 1, noteType: 2, note: 3, card: 4, review: 5, noteMedia: 6 } as const)[change.entityType]
}

/** A sync batch can be delivered in append order from several clients, so deck parents are not necessarily first. */
function orderInboundChanges(changes: SyncOperation[]) {
  const indexed = changes.map((change, index) => ({ change, index }))
  const ordered = indexed.sort((left, right) => inboundDependencyOrder(left.change) - inboundDependencyOrder(right.change) || left.index - right.index)
  const deckIndexes = ordered.filter(({ change }) => change.entityType === 'deck' && change.action !== 'delete')
  const byDeckId = new Map<string, typeof deckIndexes[number]>()
  for (const entry of deckIndexes) if (!byDeckId.has(entry.change.entityId)) byDeckId.set(entry.change.entityId, entry)
  const visited = new Set<number>()
  const visiting = new Set<number>()
  const parentFirst: typeof deckIndexes = []
  const visit = (entry: typeof deckIndexes[number]) => {
    if (visited.has(entry.index)) return
    if (visiting.has(entry.index)) return
    visiting.add(entry.index)
    const parentId = (entry.change.payload as Partial<Deck> | undefined)?.parentId
    if (typeof parentId === 'string') {
      const parent = byDeckId.get(parentId)
      if (parent) visit(parent)
    }
    visiting.delete(entry.index)
    visited.add(entry.index)
    parentFirst.push(entry)
  }
  for (const entry of deckIndexes) visit(entry)
  const replacement = new Map(parentFirst.map((entry, index) => [entry.index, index]))
  return ordered.sort((left, right) => {
    const rank = inboundDependencyOrder(left.change) - inboundDependencyOrder(right.change)
    if (rank) return rank
    const leftDeck = replacement.get(left.index)
    const rightDeck = replacement.get(right.index)
    if (leftDeck !== undefined && rightDeck !== undefined) return leftDeck - rightDeck
    return left.index - right.index
  }).map(({ change }) => change)
}

function relatedEntityIds(change: SyncOperation) {
  if (!change.payload || typeof change.payload !== 'object') return {}
  const payload = change.payload as { deckId?: unknown; noteId?: unknown; parentId?: unknown; optionGroupId?: unknown }
  return {
    deckId: typeof payload.deckId === 'string' ? payload.deckId : undefined,
    noteId: typeof payload.noteId === 'string' ? payload.noteId : undefined,
    parentId: typeof payload.parentId === 'string' ? payload.parentId : undefined,
    optionGroupId: typeof payload.optionGroupId === 'string' ? payload.optionGroupId : undefined,
  }
}

function requiredText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

async function mediaBytes(file: Blob) {
  const bytes = 'arrayBuffer' in file && typeof file.arrayBuffer === 'function'
    ? await file.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read media bytes.'))
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(file)
    })
  return bytes
}

function renameTemplateFields(template: string, renamed: ReadonlyMap<string, string>, known: ReadonlySet<string>) {
  return template.replace(/{{\s*([#^/]?)\s*([^{}]+?)\s*}}/g, (token, marker: string, rawName: string) => {
    const raw = rawName.trim()
    const exact = renamed.get(raw)
    if (exact) return `{{${marker}${exact}}}`
    if (known.has(raw)) return token
    const parts = raw.split(':')
    const name = renamed.get(parts.at(-1) ?? '')
    return name ? `{{${marker}${[...parts.slice(0, -1), name].join(':')}}}` : token
  })
}

function clozeField(noteType: Pick<NoteType, 'kind' | 'fields' | 'templates'>): NoteTypeField | undefined {
  if (noteType.kind !== 'cloze') return undefined
  if (noteType.templates.length !== 1) throw new Error('A cloze note type requires exactly one template')
  if (noteType.fields.some((field) => /^c[1-9]\d*$/.test(field.name))) throw new Error('Cloze ordinal names such as c1 are reserved')
  const [template] = noteType.templates
  const front = [...template.front.matchAll(/{{\s*cloze:([^{}:]+?)\s*}}/g)].map((match) => match[1].trim())
  const back = [...template.back.matchAll(/{{\s*cloze:([^{}:]+?)\s*}}/g)].map((match) => match[1].trim())
  if (front.length !== 1 || back.length !== 1 || front[0] !== back[0]) throw new Error('Cloze front and back must each reference the same cloze field once')
  if (noteType.fields.some((field) => field.name === `cloze:${front[0]}`)) throw new Error('A field name shadows the cloze filter')
  return noteType.fields.find((field) => field.name === front[0])
}

function cardKey(card: Pick<CardRecord, 'templateId' | 'clozeOrdinal' | 'occlusionId'>) {
  return card.occlusionId ? `${card.templateId}:m${card.occlusionId}` : `${card.templateId}:c${card.clozeOrdinal ?? 0}`
}

function validateImageOcclusion(value: ImageOcclusion): void {
  if (value.version !== 1 || !value.sourceMediaId) throw new Error('Image occlusion source is invalid')
  if (![value.imageWidth, value.imageHeight].every((dimension) => Number.isSafeInteger(dimension) && dimension > 0)) throw new Error('Image dimensions are invalid')
  if (!Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1 || !Array.isArray(value.masks) || !value.masks.length || value.masks.length > 500) throw new Error('Image occlusion masks are invalid')
  const ids = new Set<string>()
  const ordinals = new Set<number>()
  for (const mask of value.masks) {
    if (!mask.id || ids.has(mask.id) || !Number.isSafeInteger(mask.ordinal) || mask.ordinal < 1 || mask.ordinal >= value.nextOrdinal || ordinals.has(mask.ordinal)) throw new Error('Image occlusion mask identity is invalid')
    ids.add(mask.id)
    ordinals.add(mask.ordinal)
    if (![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite) || mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0 || mask.x + mask.width > 1 || mask.y + mask.height > 1) throw new Error('Image occlusion mask is out of bounds')
  }
}

function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) throw new Error('Tags are invalid')
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean)
  if (normalized.some((tag) => tag.length > 120)) throw new Error('Tag is too long')
  return [...new Set(normalized)]
}

function resolveMasks(drafts: OcclusionMaskDraft[], previous?: ImageOcclusion, existingCards: CardRecord[] = []): Pick<ImageOcclusion, 'masks' | 'nextOrdinal'> {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('At least one image occlusion mask is required')
  let nextOrdinal = previous?.nextOrdinal ?? 1
  const known = new Map<string, number>([
    ...(previous?.masks ?? []).map((mask) => [mask.id, mask.ordinal] as const),
    ...existingCards.filter((card) => card.occlusionId && card.occlusionOrdinal).map((card) => [card.occlusionId!, card.occlusionOrdinal!] as const),
  ])
  const masks = drafts.map((draft) => {
    const maskId = draft.id ?? id()
    const knownOrdinal = known.get(maskId)
    if (knownOrdinal && draft.ordinal && draft.ordinal !== knownOrdinal) throw new Error('Image occlusion mask ordinal cannot change')
    if (!knownOrdinal && draft.ordinal && draft.ordinal < nextOrdinal) throw new Error('Image occlusion mask ordinal cannot be reused')
    const ordinal = knownOrdinal ?? draft.ordinal ?? nextOrdinal++
    if (!knownOrdinal && draft.ordinal) nextOrdinal = Math.max(nextOrdinal, draft.ordinal + 1)
    return { ...draft, id: maskId, ordinal }
  })
  return { masks, nextOrdinal }
}

function canonicalNote(note: LegacyNote): Note {
  if (note.type === 'basic') return { ...note, typeId: BASIC_NOTE_TYPE_ID }
  if (!note.typeId) throw new Error('Synced custom note is missing its note type ID')
  return { ...note, typeId: note.typeId }
}

function canonicalCard(card: LegacyCard): CardRecord {
  return { ...card, templateId: card.templateId ?? BASIC_TEMPLATE_ID }
}

function canonicalNoteType(noteType: LegacyNoteType): NoteType {
  return { ...noteType, kind: noteType.kind ?? 'standard' }
}

function canonicalDeck(deck: LegacyDeck): Deck {
  return { ...deck, parentId: deck.parentId ?? null, optionGroupId: deck.optionGroupId ?? DEFAULT_DECK_OPTION_GROUP_ID }
}

const defaultDeckOptionGroup: DeckOptionGroup = {
  id: DEFAULT_DECK_OPTION_GROUP_ID,
  name: 'Default',
  protected: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

function serializeCard(card: FsrsCard, identity: Pick<CardRecord, 'id' | 'deckId' | 'noteId' | 'templateId' | 'clozeOrdinal'>): CardRecord {
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
  deckOptionGroups!: EntityTable<DeckOptionGroup, 'id'>
  notes!: EntityTable<Note, 'id'>
  cards!: EntityTable<CardRecord, 'id'>
  reviewEntries!: EntityTable<ReviewEntry, 'id'>
  outbox!: EntityTable<SyncOperation, 'opId'>
  settings!: EntityTable<{ key: string; value: unknown }, 'key'>
  receivedOperations!: EntityTable<{ opId: string }, 'opId'>
  deletedEntities!: EntityTable<DeletionTombstone, 'key'>
  noteMedia!: EntityTable<NoteMediaReference, 'id'>
  mediaBlobs!: EntityTable<StoredMediaBlob, 'digest'>

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
      await transaction.table('notes').toCollection().modify((note: LegacyNote) => { if (note.type === 'basic' && !note.typeId) note.typeId = BASIC_NOTE_TYPE_ID })
      await transaction.table('cards').toCollection().modify((card: LegacyCard) => { if (!card.templateId) card.templateId = BASIC_TEMPLATE_ID })
    })
    this.version(7).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('noteTypes').toCollection().modify((noteType: LegacyNoteType) => { if (!noteType.kind) noteType.kind = 'standard' })
      if (!await transaction.table('noteTypes').get(BASIC_NOTE_TYPE_ID)) await transaction.table('noteTypes').put(basicNoteType)
    })
    this.version(8).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('notes').toCollection().modify((note: Note) => { if (!note.tags) note.tags = [] })
      await transaction.table('noteTypes').put(imageOcclusionNoteType)
    })
    this.version(9).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('decks').toCollection().modify((deck: LegacyDeck) => {
        if (deck.parentId === undefined) deck.parentId = null
        if (!deck.optionGroupId) deck.optionGroupId = DEFAULT_DECK_OPTION_GROUP_ID
      })
      await transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
    this.on('populate', (transaction) => {
      transaction.table('noteTypes').put(basicNoteType)
      transaction.table('noteTypes').put(imageOcclusionNoteType)
      transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
  }

  async createNoteType(input: NewNoteType, now = new Date()): Promise<NoteType> {
    if (!input.fields.length) throw new Error('A note type needs at least one field')
    if (!input.templates.length) throw new Error('A note type needs at least one template')
    const names = input.fields.map((field) => requiredText(field.name, 'Field name'))
    if (new Set(names).size !== names.length) throw new Error('Field names must be unique')
    if (names.includes('FrontSide')) throw new Error('FrontSide is reserved for template backs')
    const kind = input.kind ?? 'standard'
    if (kind !== 'standard' && kind !== 'cloze') throw new Error('Unknown note type kind')
    for (const template of input.templates) {
      validateTemplate(template.front, names, 'front', kind)
      validateTemplate(template.back, names, 'back', kind)
    }
    if (kind === 'cloze' && !clozeField({ kind, fields: names.map((name) => ({ id: name, name })), templates: input.templates.map((template) => ({ id: '', ...template })) })) throw new Error('Cloze field not found')
    const noteType: NoteType = {
      id: id(), name: requiredText(input.name, 'Note type name'), kind, protected: false,
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

  async cloneNoteType(typeId: string, name?: string, now = new Date()): Promise<NoteType> {
    return this.transaction('rw', [this.noteTypes, this.outbox], async () => {
      const source = await this.noteTypes.get(typeId)
      if (!source) throw new Error('Note type not found')
      if (source.kind === 'image-occlusion') throw new Error('Image occlusion type cannot be cloned')
      return this.createNoteType({
        name: name ?? `${source.name} copy`,
        kind: source.kind,
        fields: source.fields.map(({ name }) => ({ name })),
        templates: source.templates.map(({ name, front, back, css }) => ({ name, front, back, css })),
      }, now)
    })
  }

  private async reconcileCards(note: Note, noteType: NoteType, now: Date, operations: SyncOperation[]) {
    const existing = await this.cards.where('noteId').equals(note.id).toArray()
    const eligible = this.cardGenerationStatus(noteType, note.fields, note.imageOcclusion).eligible
    const eligibleIds = new Set(eligible.map((template) => cardKey({ templateId: template.id, clozeOrdinal: template.clozeOrdinal, occlusionId: template.occlusionId })))
    for (const card of existing) {
      const suspended = !eligibleIds.has(cardKey(card))
      if (Boolean(card.suspended) === suspended) continue
      const revised = { ...card, suspended }
      await this.cards.put(revised)
      operations.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'update', occurredAt: now.toISOString(), payload: revised })
    }
    const existingIds = new Set(existing.map(cardKey))
    for (const template of eligible) {
      if (existingIds.has(cardKey({ templateId: template.id, clozeOrdinal: template.clozeOrdinal, occlusionId: template.occlusionId }))) continue
      const card = serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}${template.clozeOrdinal ? `:c${template.clozeOrdinal}` : template.occlusionId ? `:m${template.occlusionId}` : ''}`, deckId: note.deckId, noteId: note.id, templateId: template.id, ...(template.clozeOrdinal ? { clozeOrdinal: template.clozeOrdinal } : {}), ...(template.occlusionId ? { occlusionId: template.occlusionId, occlusionOrdinal: template.occlusionOrdinal } : {}) })
      await this.cards.add(card)
      operations.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: now.toISOString(), payload: card })
    }
  }

  async updateNoteType(typeId: string, input: UpdateNoteType, now = new Date()): Promise<NoteType> {
    return this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox], async () => {
      const previous = await this.noteTypes.get(typeId)
      if (!previous) throw new Error('Note type not found')
      if (previous.protected) throw new Error('Protected note type cannot be changed')
      const oldFieldIds = new Set(previous.fields.map((field) => field.id))
      const oldTemplateIds = new Set(previous.templates.map((template) => template.id))
      const fields = (input.fields ?? previous.fields).map((field) => ({ id: field.id ?? id(), name: requiredText(field.name, 'Field name') }))
      const renamed = new Map(previous.fields.flatMap((field) => {
        const newName = fields.find((candidate) => candidate.id === field.id)?.name
        return newName && newName !== field.name ? [[field.name, newName] as const] : []
      }))
      const oldNames = new Set(previous.fields.map((field) => field.name))
      const templates = (input.templates ?? previous.templates).map((template) => {
        const old = previous.templates.find((candidate) => candidate.id === template.id)
        return {
          ...template,
          id: template.id ?? id(),
          name: requiredText(template.name, 'Template name'),
          front: old && template.front === old.front ? renameTemplateFields(template.front, renamed, oldNames) : template.front,
          back: old && template.back === old.back ? renameTemplateFields(template.back, renamed, oldNames) : template.back,
        }
      })
      if (!fields.length) throw new Error('A note type needs at least one field')
      if (!templates.length) throw new Error('A note type needs at least one template')
      if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new Error('Field IDs must be unique')
      if (fields.some((field) => !oldFieldIds.has(field.id) && input.fields?.some((candidate) => candidate.id === field.id))) throw new Error('Unknown field ID')
      if (new Set(templates.map((template) => template.id)).size !== templates.length) throw new Error('Template IDs must be unique')
      if (templates.some((template) => !oldTemplateIds.has(template.id) && input.templates?.some((candidate) => candidate.id === template.id))) throw new Error('Unknown template ID')
      const names = fields.map((field) => field.name)
      if (new Set(names).size !== names.length) throw new Error('Field names must be unique')
      if (names.includes('FrontSide')) throw new Error('FrontSide is reserved for template backs')
      for (const template of templates) {
        validateTemplate(template.front, names, 'front', previous.kind === 'image-occlusion' ? 'standard' : previous.kind)
        validateTemplate(template.back, names, 'back', previous.kind === 'image-occlusion' ? 'standard' : previous.kind)
      }
      if (previous.kind === 'cloze' && !clozeField({ kind: previous.kind, fields, templates })) throw new Error('Cloze field not found')
      const currentIds = new Set(fields.map((field) => field.id))
      const removed = previous.fields.filter((field) => !currentIds.has(field.id))
      for (const field of removed) {
        const mode = input.removedFields?.[field.id]
        if (mode !== 'discard' && mode !== 'keep-as-extra') throw new Error(`Valid field removal mode required for ${field.name}`)
      }
      if (Object.keys(input.removedFields ?? {}).some((fieldId) => !removed.some((field) => field.id === fieldId))) throw new Error('Removal mode supplied for a field that is not removed')
      const updated: NoteType = { ...previous, name: requiredText(input.name ?? previous.name, 'Note type name'), fields, templates, updatedAt: now.toISOString() }
      const operations: SyncOperation[] = [{ opId: id(), entityType: 'noteType', entityId: typeId, action: 'update', occurredAt: updated.updatedAt, payload: updated }]
      const notes = await this.notes.where('typeId').equals(typeId).toArray()
      for (const note of notes) {
        let revised = note
        if (removed.length || fields.some((field) => !oldFieldIds.has(field.id))) {
          const values = Object.fromEntries(fields.map((field) => [field.id, note.fields[field.id] ?? '']))
          const retiredFields = { ...note.retiredFields }
          for (const [fieldId, value] of Object.entries(note.fields)) {
            if (currentIds.has(fieldId)) continue
            if (input.removedFields?.[fieldId] === 'discard') delete retiredFields[fieldId]
            else retiredFields[fieldId] = value
          }
          revised = { ...note, fields: values, ...(Object.keys(retiredFields).length ? { retiredFields } : {}), updatedAt: now.toISOString() }
          await this.notes.put(revised)
          operations.push({ opId: id(), entityType: 'note', entityId: note.id, action: 'update', occurredAt: revised.updatedAt, payload: revised })
        }
        await this.reconcileCards(revised, updated, now, operations)
      }
      await this.noteTypes.put(updated)
      await this.outbox.bulkAdd(operations)
      return updated
    })
  }

  async deleteNoteType(typeId: string, replacement?: NoteTypeReplacement, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox, this.deletedEntities], async () => {
      const source = await this.noteTypes.get(typeId)
      if (!source) throw new Error('Note type not found')
      if (source.protected) throw new Error('Protected note type cannot be deleted')
      const notes = await this.notes.where('typeId').equals(typeId).toArray()
      if (notes.length && !replacement?.replacementTypeId) throw new Error('A replacement note type is required')
      if (notes.length && !replacement?.fieldMapping) throw new Error('An explicit field mapping is required')
      const target = replacement ? await this.noteTypes.get(replacement.replacementTypeId) : undefined
      if (replacement && (!target || target.id === typeId)) throw new Error('Replacement note type not found')
      const sourceIds = new Set(source.fields.map((field) => field.id))
      const targetIds = new Set(target?.fields.map((field) => field.id))
      const mapping = replacement?.fieldMapping ?? {}
      if (Object.keys(mapping).some((fieldId) => !sourceIds.has(fieldId))) throw new Error('Field mapping has an unknown source field')
      if (Object.values(mapping).some((fieldId) => !targetIds.has(fieldId))) throw new Error('Field mapping has an unknown replacement field')
      if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new Error('Field mapping must have unique targets')
      const operations: SyncOperation[] = []
      for (const note of notes) {
        if (!target) throw new Error('Replacement note type not found')
        const fields = Object.fromEntries(target.fields.map((field) => [field.id, ''])) as Record<string, string>
        const retiredFields = { ...note.retiredFields }
        for (const [fieldId, value] of Object.entries(note.fields)) {
          const destination = mapping[fieldId]
          if (destination) fields[destination] = value
          else retiredFields[fieldId] = value
        }
        const revised: Note = { ...note, typeId: target.id, type: target.id === BASIC_NOTE_TYPE_ID ? 'basic' : 'custom', fields, ...(Object.keys(retiredFields).length ? { retiredFields } : {}), updatedAt: now.toISOString() }
        await this.notes.put(revised)
        operations.push({ opId: id(), entityType: 'note', entityId: note.id, action: 'update', occurredAt: revised.updatedAt, payload: revised })
        await this.reconcileCards(revised, target, now, operations)
      }
      await this.noteTypes.delete(typeId)
      await this.deletedEntities.put({ key: tombstoneKey('noteType', typeId), entityType: 'noteType', entityId: typeId, occurredAt: now.toISOString() })
      operations.push({ opId: id(), entityType: 'noteType', entityId: typeId, action: 'delete', occurredAt: now.toISOString(), payload: { id: typeId } })
      await this.outbox.bulkAdd(operations)
    })
  }

  cardGenerationStatus(noteType: NoteType, fields: Record<string, string>, imageOcclusion?: ImageOcclusion) {
    const skipped: { templateId: string; reason: string }[] = []
    const eligible: Array<CardTemplate & { clozeOrdinal?: number; occlusionId?: string; occlusionOrdinal?: number }> = []
    if (noteType.kind === 'image-occlusion') {
      if (!imageOcclusion) throw new Error('Image occlusion metadata is required')
      validateImageOcclusion(imageOcclusion)
      if (noteType.templates.length !== 1) throw new Error('Image occlusion needs exactly one template')
      for (const mask of imageOcclusion.masks) eligible.push({ ...noteType.templates[0], occlusionId: mask.id, occlusionOrdinal: mask.ordinal })
      return { eligible, skipped }
    }
    if (noteType.kind === 'cloze') {
      const field = clozeField(noteType)
      if (!field) throw new Error('Cloze field not found')
      const ordinals = clozeOrdinals(fields[field.id] ?? '')
      for (const ordinal of ordinals) eligible.push({ ...noteType.templates[0], clozeOrdinal: ordinal })
      if (!ordinals.length) skipped.push({ templateId: noteType.templates[0].id, reason: 'No cloze deletions found' })
      return { eligible, skipped }
    }
    for (const template of noteType.templates) {
      if (renderNoteTemplate(template.front, noteType, fields).isEmpty) skipped.push({ templateId: template.id, reason: 'Front has no visible field content' })
      else eligible.push(template)
    }
    return { eligible, skipped }
  }

  tryCardGenerationStatus(noteType: NoteType, fields: Record<string, string>, imageOcclusion?: ImageOcclusion) {
    try { return { ok: true as const, value: this.cardGenerationStatus(noteType, fields, imageOcclusion) } }
    catch (reason) { return { ok: false as const, error: reason instanceof Error ? reason.message : 'Unable to generate cards' } }
  }

  private cardIsEligible(noteType: NoteType, note: Note, card: CardRecord): boolean {
    try {
      return this.cardGenerationStatus(noteType, note.fields, note.imageOcclusion).eligible.some((template) =>
        template.id === card.templateId && template.clozeOrdinal === card.clozeOrdinal && template.occlusionId === card.occlusionId && template.occlusionOrdinal === card.occlusionOrdinal &&
        (noteType.kind !== 'cloze' || card.id === `${note.id}:${template.id}:c${template.clozeOrdinal}`) &&
        (noteType.kind !== 'image-occlusion' || card.id === `${note.id}:${template.id}:m${template.occlusionId}`))
    } catch {
      return false
    }
  }

  async createImageOcclusionNote(deckId: string, input: NewImageOcclusionNote, now = new Date()): Promise<Note> {
    const definition = validateMedia(input.image)
    if (definition.kind !== 'image') throw new Error('Image occlusion requires an image')
    const digest = await digestMedia(input.image)
    const storedImage = await mediaBytes(input.image)
    const noteId = id()
    const mediaId = id()
    const createdAt = now.toISOString()
    const imageOcclusion: ImageOcclusion = { version: 1, sourceMediaId: mediaId, imageWidth: input.imageWidth, imageHeight: input.imageHeight, ...resolveMasks(input.masks) }
    validateImageOcclusion(imageOcclusion)
    const note: Note = { id: noteId, deckId, type: 'custom', typeId: IMAGE_OCCLUSION_NOTE_TYPE_ID, fields: { header: input.header, backExtra: input.backExtra }, tags: normalizeTags(input.tags), imageOcclusion, createdAt, updatedAt: createdAt }
    const reference: NoteMediaReference = { id: mediaId, noteId, digest, kind: 'image', mimeType: input.image.type, displayName: input.image.name, side: 'front', playback: 'manual', createdAt, updatedAt: createdAt }
    const blob: StoredMediaBlob = { digest, blob: storedImage, byteLength: input.image.size, mimeType: input.image.type, verifiedAt: createdAt }
    return this.transaction('rw', [this.decks, this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      await this.mediaBlobs.put(blob)
      await this.noteMedia.add(reference)
      await this.notes.add(note)
      const operations: SyncOperation[] = [
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: createdAt, payload: note },
        { opId: id(), entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: createdAt, payload: reference },
      ]
      await this.reconcileCards(note, imageOcclusionNoteType, now, operations)
      await this.outbox.bulkAdd(operations)
      return note
    })
  }

  async updateImageOcclusionNote(noteId: string, input: UpdateImageOcclusionNote, now = new Date()): Promise<void> {
    if ((input.imageWidth !== undefined || input.imageHeight !== undefined) && !input.image) throw new Error('Image dimensions require a new source image')
    const definition = input.image ? validateMedia(input.image) : undefined
    if (definition && definition.kind !== 'image') throw new Error('Image occlusion requires an image')
    const digest = input.image ? await digestMedia(input.image) : undefined
    const storedImage = input.image ? await mediaBytes(input.image) : undefined
    await this.transaction('rw', [this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox], async () => {
      const note = await this.notes.get(noteId)
      if (!note || note.typeId !== IMAGE_OCCLUSION_NOTE_TYPE_ID || !note.imageOcclusion) throw new Error('Image occlusion note not found')
      const original = note.imageOcclusion
      const previousCards = await this.cards.where('noteId').equals(noteId).toArray()
      const resolved = resolveMasks(input.masks ?? original.masks, original, previousCards)
      const imageOcclusion: ImageOcclusion = { ...original, imageWidth: input.imageWidth ?? original.imageWidth, imageHeight: input.imageHeight ?? original.imageHeight, ...resolved }
      validateImageOcclusion(imageOcclusion)
      const updated: Note = { ...note, fields: { header: input.header ?? note.fields.header, backExtra: input.backExtra ?? note.fields.backExtra }, tags: input.tags ? normalizeTags(input.tags) : note.tags ?? [], imageOcclusion, updatedAt: now.toISOString() }
      const operations: SyncOperation[] = [{ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated }]
      if (input.image && digest) {
        if (input.imageWidth === undefined || input.imageHeight === undefined) throw new Error('New image dimensions are required')
        const reference = await this.noteMedia.get(original.sourceMediaId)
        if (!reference || reference.noteId !== noteId || reference.kind !== 'image') throw new Error('Source image reference is missing')
        const revised: NoteMediaReference = { ...reference, digest, mimeType: input.image.type, displayName: input.image.name, updatedAt: updated.updatedAt }
        await this.mediaBlobs.put({ digest, blob: storedImage!, byteLength: input.image.size, mimeType: input.image.type, verifiedAt: updated.updatedAt })
        await this.noteMedia.put(revised)
        operations.push({ opId: id(), entityType: 'noteMedia', entityId: revised.id, action: 'update', occurredAt: updated.updatedAt, payload: revised })
      }
      await this.notes.put(updated)
      await this.reconcileCards(updated, imageOcclusionNoteType, now, operations)
      await this.outbox.bulkAdd(operations)
    })
  }

  async createNote(deckId: string, typeId: string, fields: Record<string, string>, now = new Date()): Promise<Note> {
    return this.transaction('rw', [this.decks, this.noteTypes, this.notes, this.cards, this.outbox], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      const noteType = await this.noteTypes.get(typeId)
      if (!noteType) throw new Error('Note type not found')
      if (noteType.kind === 'image-occlusion') throw new Error('Use the image occlusion editor to create this note')
      const values = Object.fromEntries(noteType.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const note: Note = { id: id(), deckId, type: typeId === BASIC_NOTE_TYPE_ID ? 'basic' : 'custom', typeId, fields: values, createdAt: now.toISOString(), updatedAt: now.toISOString() }
      const cards = this.cardGenerationStatus(noteType, values).eligible.map((template) => serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}${template.clozeOrdinal ? `:c${template.clozeOrdinal}` : ''}`, deckId, noteId: note.id, templateId: template.id, ...(template.clozeOrdinal ? { clozeOrdinal: template.clozeOrdinal } : {}) }))
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
      const noteType = await this.noteTypes.get(note.typeId)
      if (!noteType) throw new Error('Note type not found')
      if (noteType.kind === 'image-occlusion') throw new Error('Use the image occlusion editor to update this note')
      const values = Object.fromEntries(noteType.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const updated: Note = { ...note, fields: values, updatedAt: now.toISOString() }
      const changes: SyncOperation[] = [{ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated }]
      await this.reconcileCards(updated, noteType, now, changes)
      await this.notes.put(updated)
      await this.outbox.bulkAdd(changes)
    })
  }

  private async validateDeckHierarchy(deck: Deck) {
    if (deck.parentId !== null && typeof deck.parentId !== 'string') throw new Error('Deck parent is invalid')
    if (!deck.optionGroupId) throw new Error('Deck option group is required')
    requiredText(deck.name, 'Deck name')
    const normalizedName = deck.name.trim().toLocaleLowerCase()
    const sibling = (await this.decks.toArray()).find((candidate) => candidate.id !== deck.id && candidate.parentId === deck.parentId && candidate.name.trim().toLocaleLowerCase() === normalizedName)
    if (sibling) throw new Error('Deck names must be unique among siblings')
    if (deck.parentId === deck.id) throw new Error('Deck cannot be its own parent')
    const seen = new Set([deck.id])
    let parentId = deck.parentId
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error('Deck hierarchy contains a cycle')
      seen.add(parentId)
      const parent = await this.decks.get(parentId)
      if (!parent) throw new Error('Parent deck not found')
      parentId = parent.parentId
    }
  }

  private async deckSubtree(deckId: string) {
    const decks = await this.decks.toArray()
    const descendants = new Set([deckId])
    let changed = true
    while (changed) {
      changed = false
      for (const deck of decks) {
        if (deck.parentId !== null && descendants.has(deck.parentId) && !descendants.has(deck.id)) {
          descendants.add(deck.id)
          changed = true
        }
      }
    }
    return decks.filter((deck) => descendants.has(deck.id))
  }

  async createDeck(name: string, optionsOrNow: CreateDeckOptions | Date = {}, suppliedNow = new Date()): Promise<Deck> {
    const [options, now] = optionsOrNow instanceof Date ? [{}, optionsOrNow] as const : [optionsOrNow, suppliedNow] as const
    const deck: Deck = {
      id: id(),
      name: requiredText(name, 'Deck name'),
      parentId: options.parentId ?? null,
      optionGroupId: options.optionGroupId ?? DEFAULT_DECK_OPTION_GROUP_ID,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox], async () => {
      if (!await this.deckOptionGroups.get(deck.optionGroupId)) throw new Error('Deck option group not found')
      await this.validateDeckHierarchy(deck)
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
      await this.validateDeckHierarchy(updated)
      await this.decks.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async moveDeck(deckId: string, parentId: string | null, now = new Date()): Promise<void> {
    await this.transaction('rw', this.decks, this.outbox, async () => {
      const deck = await this.decks.get(deckId)
      if (!deck) throw new Error('Deck not found')
      const updated = { ...deck, parentId, updatedAt: now.toISOString() }
      await this.validateDeckHierarchy(updated)
      await this.decks.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async moveNote(noteId: string, destinationDeckId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.notes, this.cards, this.reviewEntries, this.outbox], async () => {
      const [note, destination] = await Promise.all([this.notes.get(noteId), this.decks.get(destinationDeckId)])
      if (!note) throw new Error('Note not found')
      if (!destination) throw new Error('Destination deck not found')
      if (note.deckId === destinationDeckId) return
      const occurredAt = now.toISOString()
      const updatedNote = { ...note, deckId: destinationDeckId, updatedAt: occurredAt }
      const cards = await this.cards.where('noteId').equals(noteId).toArray()
      const updatedCards = cards.map((card) => ({ ...card, deckId: destinationDeckId }))
      const reviews = cards.length ? await this.reviewEntries.where('cardId').anyOf(cards.map((card) => card.id)).toArray() : []
      const updatedReviews = reviews.map((review) => ({ ...review, deckId: destinationDeckId }))
      await this.notes.put(updatedNote)
      if (updatedCards.length) await this.cards.bulkPut(updatedCards)
      if (updatedReviews.length) await this.reviewEntries.bulkPut(updatedReviews)
      await this.outbox.bulkAdd([
        { opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt, payload: updatedNote },
        ...updatedCards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'update' as const, occurredAt, payload: card })),
        ...updatedReviews.map((review) => ({ opId: id(), entityType: 'review' as const, entityId: review.id, action: 'update' as const, occurredAt, payload: review })),
      ])
    })
  }

  async createDeckOptionGroup(name: string, now = new Date()): Promise<DeckOptionGroup> {
    const group: DeckOptionGroup = { id: id(), name: requiredText(name, 'Deck option group name'), protected: false, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    await this.transaction('rw', this.deckOptionGroups, this.outbox, async () => {
      await this.deckOptionGroups.add(group)
      await this.outbox.add({ opId: id(), entityType: 'deckOptionGroup', entityId: group.id, action: 'create', occurredAt: group.createdAt, payload: group })
    })
    return group
  }

  async renameDeckOptionGroup(groupId: string, name: string, now = new Date()): Promise<void> {
    await this.transaction('rw', this.deckOptionGroups, this.outbox, async () => {
      const group = await this.deckOptionGroups.get(groupId)
      if (!group) throw new Error('Deck option group not found')
      if (group.protected) throw new Error('The Default deck option group is protected')
      const updated = { ...group, name: requiredText(name, 'Deck option group name'), updatedAt: now.toISOString() }
      await this.deckOptionGroups.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'deckOptionGroup', entityId: group.id, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async assignDeckOptionGroup(deckId: string, groupId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox], async () => {
      const [deck, group] = await Promise.all([this.decks.get(deckId), this.deckOptionGroups.get(groupId)])
      if (!deck) throw new Error('Deck not found')
      if (!group) throw new Error('Deck option group not found')
      if (deck.optionGroupId === groupId) return
      const updated = { ...deck, optionGroupId: groupId, updatedAt: now.toISOString() }
      await this.decks.put(updated)
      await this.outbox.add({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async deleteDeckOptionGroup(groupId: string, replacementGroupId?: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox, this.deletedEntities], async () => {
      const group = await this.deckOptionGroups.get(groupId)
      if (!group) throw new Error('Deck option group not found')
      if (group.protected) throw new Error('The Default deck option group is protected')
      const affected = await this.decks.where('optionGroupId').equals(groupId).toArray()
      const replacement = replacementGroupId ? await this.deckOptionGroups.get(replacementGroupId) : undefined
      if (affected.length && !replacement) throw new Error('A replacement deck option group is required for referenced decks')
      if (replacementGroupId && (!replacement || replacement.id === groupId)) throw new Error('Deck option group replacement is invalid')
      const occurredAt = now.toISOString()
      const updated = affected.map((deck) => ({ ...deck, optionGroupId: replacement!.id, updatedAt: occurredAt }))
      if (updated.length) await this.decks.bulkPut(updated)
      await this.deckOptionGroups.delete(groupId)
      await this.deletedEntities.put({ key: tombstoneKey('deckOptionGroup', groupId), entityType: 'deckOptionGroup', entityId: groupId, occurredAt })
      await this.outbox.bulkAdd([
        ...updated.map((deck) => ({ opId: id(), entityType: 'deck' as const, entityId: deck.id, action: 'update' as const, occurredAt, payload: deck })),
        { opId: id(), entityType: 'deckOptionGroup', entityId: groupId, action: 'delete', occurredAt, payload: { id: groupId } },
      ])
    })
  }

  async deleteDeck(deckId: string, options: DeleteDeckOptions, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.outbox, this.deletedEntities], async () => {
      const deck = await this.decks.get(deckId)
      if (!deck) throw new Error('Deck not found')
      const occurredAt = now.toISOString()
      const subtree = await this.deckSubtree(deckId)
      const subtreeIds = subtree.map((item) => item.id)
      if (options.mode === 'relocate') {
        const destination = await this.decks.get(options.destinationDeckId)
        if (!destination || subtreeIds.includes(destination.id)) throw new Error('Destination deck must be outside the deleted deck subtree')
        const [notes, children] = await Promise.all([
          this.notes.where('deckId').equals(deckId).toArray(),
          this.decks.where('parentId').equals(deckId).toArray(),
        ])
        const cards = notes.length ? await this.cards.where('noteId').anyOf(notes.map((note) => note.id)).toArray() : []
        const reviews = cards.length ? await this.reviewEntries.where('cardId').anyOf(cards.map((card) => card.id)).toArray() : []
        const updatedNotes = notes.map((note) => ({ ...note, deckId: destination.id, updatedAt: occurredAt }))
        const updatedCards = cards.map((card) => ({ ...card, deckId: destination.id }))
        const updatedReviews = reviews.map((review) => ({ ...review, deckId: destination.id }))
        const updatedChildren = children.map((child) => ({ ...child, parentId: destination.id, updatedAt: occurredAt }))
        if (updatedNotes.length) await this.notes.bulkPut(updatedNotes)
        if (updatedCards.length) await this.cards.bulkPut(updatedCards)
        if (updatedReviews.length) await this.reviewEntries.bulkPut(updatedReviews)
        if (updatedChildren.length) await this.decks.bulkPut(updatedChildren)
        await this.decks.delete(deckId)
        await this.deletedEntities.put({ key: tombstoneKey('deck', deckId), entityType: 'deck', entityId: deckId, occurredAt })
        await this.outbox.bulkAdd([
          ...updatedChildren.map((child) => ({ opId: id(), entityType: 'deck' as const, entityId: child.id, action: 'update' as const, occurredAt, payload: child })),
          ...updatedNotes.map((note) => ({ opId: id(), entityType: 'note' as const, entityId: note.id, action: 'update' as const, occurredAt, payload: note })),
          ...updatedCards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'update' as const, occurredAt, payload: card })),
          ...updatedReviews.map((review) => ({ opId: id(), entityType: 'review' as const, entityId: review.id, action: 'update' as const, occurredAt, payload: review })),
          { opId: id(), entityType: 'deck', entityId: deckId, action: 'delete', occurredAt, payload: { id: deckId } },
        ])
        return
      }
      const [notes, cards, reviews] = await Promise.all([
        this.notes.where('deckId').anyOf(subtreeIds).toArray(),
        this.cards.where('deckId').anyOf(subtreeIds).toArray(),
        this.reviewEntries.where('deckId').anyOf(subtreeIds).toArray(),
      ])
      const noteIds = notes.map((note) => note.id)
      const media = noteIds.length ? await this.noteMedia.where('noteId').anyOf(noteIds).toArray() : []
      await Promise.all([
        this.decks.bulkDelete(subtreeIds),
        this.notes.where('deckId').anyOf(subtreeIds).delete(),
        this.cards.where('deckId').anyOf(subtreeIds).delete(),
        this.reviewEntries.where('deckId').anyOf(subtreeIds).delete(),
        noteIds.length ? this.noteMedia.where('noteId').anyOf(noteIds).delete() : Promise.resolve(),
      ])
      await this.deletedEntities.bulkPut([
        ...subtreeIds.map((id) => ({ key: tombstoneKey('deck', id), entityType: 'deck' as const, entityId: id, occurredAt })),
        ...notes.map((note) => ({ key: tombstoneKey('note', note.id), entityType: 'note' as const, entityId: note.id, occurredAt })),
        ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt })),
        ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt })),
        ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt })),
      ])
      await this.outbox.bulkAdd(subtree.sort((left, right) => Number(right.parentId !== null) - Number(left.parentId !== null)).map((item) => ({ opId: id(), entityType: 'deck' as const, entityId: item.id, action: 'delete' as const, occurredAt, payload: { id: item.id } })))
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
      return { definition, file, digest, bytes: await mediaBytes(file), side, playback }
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
    const blobs = [...new Map(prepared.map(({ file, digest, bytes }) => [digest, { digest, blob: bytes, byteLength: file.size, mimeType: file.type, verifiedAt: createdAt } satisfies StoredMediaBlob])).values()]

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
    const blob: StoredMediaBlob = { digest, blob: await mediaBytes(file), byteLength: file.size, mimeType: file.type, verifiedAt: now.toISOString() }
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

  async verifiedMediaBlob(digest: string): Promise<MediaBlob | undefined> {
    const stored = await this.mediaBlobs.get(digest)
    if (!stored) return undefined
    if (stored.blob instanceof Blob) return stored as MediaBlob
    return { ...stored, blob: new Blob([stored.blob], { type: stored.mimeType }) }
  }

  async storeDownloadedMedia(digest: string, blob: Blob, now = new Date()) {
    if (await digestMedia(blob) !== digest) throw new Error('Downloaded media did not match its content digest.')
    await this.mediaBlobs.put({ digest, blob: await mediaBytes(blob), byteLength: blob.size, mimeType: blob.type, verifiedAt: now.toISOString() })
  }

  async removeMedia(referenceId: string, now = new Date()) {
    await this.transaction('rw', this.notes, this.noteMedia, this.outbox, async () => {
      const reference = await this.noteMedia.get(referenceId)
      if (!reference) throw new Error('Media reference not found')
      const note = await this.notes.get(reference.noteId)
      if (note?.imageOcclusion?.sourceMediaId === referenceId) throw new Error('Cannot remove the source image from an image occlusion note')
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
    if (!card || card.suspended) return []
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
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.receivedOperations, this.settings, this.deletedEntities], async () => {
      const affectedNoteIds = new Set<string>()
      const affectedTypeIds = new Set<string>()
      // A parent-deck tombstone can suppress a historical note before its later media/card operations arrive.
      const suppressedNoteIds = new Set<string>()
      const suppressedCardIds = new Set<string>()
      // Resolve type and note changes before their cards, even when equal timestamps arrive in index order.
      for (const change of orderInboundChanges(changes)) {
        if (await this.receivedOperations.get(change.opId)) continue
        if (change.entityType === 'noteMedia') {
          const previous = await this.noteMedia.get(change.entityId)
          if (previous) affectedNoteIds.add(previous.noteId)
        }
        if (change.entityType === 'noteType' && [BASIC_NOTE_TYPE_ID, IMAGE_OCCLUSION_NOTE_TYPE_ID].includes(change.entityId)) {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.entityType === 'deckOptionGroup' && change.entityId === DEFAULT_DECK_OPTION_GROUP_ID) {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.action !== 'delete') {
          const related = relatedEntityIds(change)
          const deleted = await Promise.all([
            this.deletedEntities.get(tombstoneKey(change.entityType, change.entityId)),
            related.deckId ? this.deletedEntities.get(tombstoneKey('deck', related.deckId)) : undefined,
            related.noteId ? this.deletedEntities.get(tombstoneKey('note', related.noteId)) : undefined,
            related.parentId ? this.deletedEntities.get(tombstoneKey('deck', related.parentId)) : undefined,
            related.optionGroupId ? this.deletedEntities.get(tombstoneKey('deckOptionGroup', related.optionGroupId)) : undefined,
          ])
          if (deleted.some(Boolean)) {
            if (change.entityType === 'note') suppressedNoteIds.add(change.entityId)
            if (change.entityType === 'card') suppressedCardIds.add(change.entityId)
            await this.receivedOperations.add({ opId: change.opId })
            continue
          }
          if (change.entityType === 'deckOptionGroup') {
            const incoming = change.payload as DeckOptionGroup
            if (!incoming || incoming.id !== change.entityId || incoming.protected || !requiredText(incoming.name, 'Deck option group name')) throw new Error('Synced deck option group is invalid')
          }
          if (change.entityType === 'deck') {
            const incoming = canonicalDeck(change.payload as LegacyDeck)
            if (incoming.id !== change.entityId) throw new Error('Synced deck identity is invalid')
            if (!await this.deckOptionGroups.get(incoming.optionGroupId)) throw new Error('Synced deck option group was not found')
            await this.validateDeckHierarchy(incoming)
          }
          if (change.entityType === 'note') {
            const incoming = canonicalNote(change.payload as LegacyNote)
            if (!await this.decks.get(incoming.deckId)) throw new Error('Synced note deck was not found')
            if (incoming.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID) {
              if (!incoming.imageOcclusion) throw new Error('Synced image occlusion metadata is missing')
              validateImageOcclusion(incoming.imageOcclusion)
              if (!incoming.tags || !Array.isArray(incoming.tags)) throw new Error('Synced image occlusion tags are invalid')
              const previous = await this.notes.get(incoming.id)
              const previousCards = await this.cards.where('noteId').equals(incoming.id).toArray()
              const priorOrdinals = new Map<string, number>([
                ...(previous?.imageOcclusion?.masks ?? []).map((mask) => [mask.id, mask.ordinal] as const),
                ...previousCards.filter((card) => card.occlusionId && card.occlusionOrdinal).map((card) => [card.occlusionId!, card.occlusionOrdinal!] as const),
              ])
              const nextOrdinal = previous?.imageOcclusion?.nextOrdinal ?? 1
              if (incoming.imageOcclusion.nextOrdinal < nextOrdinal) throw new Error('Synced image occlusion mask ordinal cannot decrease')
              for (const mask of incoming.imageOcclusion.masks) {
                const prior = priorOrdinals.get(mask.id)
                if ((prior !== undefined && prior !== mask.ordinal) || (prior === undefined && mask.ordinal < nextOrdinal)) throw new Error('Synced image occlusion mask ordinal cannot change or be reused')
              }
            }
            if (await this.deletedEntities.get(tombstoneKey('noteType', incoming.typeId))) {
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
          }
          if (change.entityType === 'card') {
            const incoming = canonicalCard(change.payload as LegacyCard)
            if (suppressedNoteIds.has(incoming.noteId)) {
              suppressedCardIds.add(change.entityId)
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
            const note = await this.notes.get(incoming.noteId)
            if (!note) throw new Error('Synced card note was not found')
            if (incoming.deckId !== note.deckId) throw new Error('Synced card deck does not match its note deck')
            const noteType = note && await this.noteTypes.get(note.typeId)
            const deletedType = note && !noteType && await this.deletedEntities.get(tombstoneKey('noteType', note.typeId))
            if (note && noteType?.kind === 'image-occlusion') {
              const existing = await this.cards.get(incoming.id)
              const mask = note.imageOcclusion?.masks.find((item) => item.id === incoming.occlusionId)
              const expectedOrdinal = existing?.occlusionOrdinal ?? mask?.ordinal
              if (!incoming.occlusionId || incoming.id !== `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:m${incoming.occlusionId}` || incoming.templateId !== IMAGE_OCCLUSION_TEMPLATE_ID || expectedOrdinal !== incoming.occlusionOrdinal) {
                await this.receivedOperations.add({ opId: change.opId })
                continue
              }
            }
            if (note && (deletedType || (noteType && !this.cardIsEligible(noteType, note, incoming))) && !incoming.suspended) {
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
          }
          if (change.entityType === 'review') {
            const review = change.payload as ReviewEntry
            if (suppressedCardIds.has(review.cardId)) {
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
            const card = await this.cards.get(review.cardId)
            if (!card) throw new Error('Synced review card was not found')
            if (review.deckId !== card.deckId) throw new Error('Synced review deck does not match its card deck')
            const note = card && await this.notes.get(card.noteId)
            const noteType = note && await this.noteTypes.get(note.typeId)
            if (card && note && (!noteType || !this.cardIsEligible(noteType, note, card))) {
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
          }
          if (change.entityType === 'noteMedia') {
            const reference = change.payload as NoteMediaReference
            if (suppressedNoteIds.has(reference.noteId)) {
              await this.receivedOperations.add({ opId: change.opId })
              continue
            }
            const note = await this.notes.get(reference.noteId)
            if (!note) throw new Error('Synced media note was not found')
            if (note?.imageOcclusion?.sourceMediaId === reference.id &&
              (reference.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(reference.mimeType) || reference.side !== 'front' || !/^[a-f0-9]{64}$/.test(reference.digest))) {
              throw new Error('Synced source image reference is invalid')
            }
          }
        }
        if (change.action === 'delete' && change.entityType === 'card') {
          const existingCard = await this.cards.get(change.entityId)
          const note = existingCard && await this.notes.get(existingCard.noteId)
          const noteType = note && await this.noteTypes.get(note.typeId)
          const deletedType = note && !noteType && await this.deletedEntities.get(tombstoneKey('noteType', note.typeId))
          const retainedOcclusion = existingCard && note && noteType?.kind === 'image-occlusion' &&
            existingCard.templateId === IMAGE_OCCLUSION_TEMPLATE_ID && Boolean(existingCard.occlusionId) &&
            existingCard.id === `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:m${existingCard.occlusionId}` &&
            Number.isSafeInteger(existingCard.occlusionOrdinal) && (existingCard.occlusionOrdinal ?? 0) > 0
          if (existingCard && note && (retainedOcclusion || deletedType || (noteType && (this.cardIsEligible(noteType, note, existingCard) || !noteType.templates.some((template) => template.id === existingCard.templateId))))) {
            await this.receivedOperations.add({ opId: change.opId })
            continue
          }
        }
        if (change.action === 'delete') {
          await this.deletedEntities.put({ key: tombstoneKey(change.entityType, change.entityId), entityType: change.entityType, entityId: change.entityId, occurredAt: change.occurredAt })
          if (change.entityType === 'deck') {
            const subtree = await this.deckSubtree(change.entityId)
            const deckIds = [...new Set([change.entityId, ...subtree.map((deck) => deck.id)])]
            const [notes, cards, reviews] = await Promise.all([
              this.notes.where('deckId').anyOf(deckIds).toArray(),
              this.cards.where('deckId').anyOf(deckIds).toArray(),
              this.reviewEntries.where('deckId').anyOf(deckIds).toArray(),
            ])
            const noteIds = notes.map((note) => note.id)
            const media = noteIds.length ? await this.noteMedia.where('noteId').anyOf(noteIds).toArray() : []
            await this.deletedEntities.bulkPut([
              ...deckIds.map((id) => ({ key: tombstoneKey('deck', id), entityType: 'deck' as const, entityId: id, occurredAt: change.occurredAt })),
              ...notes.map((note) => ({ key: tombstoneKey('note', note.id), entityType: 'note' as const, entityId: note.id, occurredAt: change.occurredAt })),
              ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt: change.occurredAt })),
              ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt: change.occurredAt })),
              ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt: change.occurredAt })),
            ])
            await this.decks.bulkDelete(deckIds)
            await this.notes.where('deckId').anyOf(deckIds).delete()
            await this.cards.where('deckId').anyOf(deckIds).delete()
            await this.reviewEntries.where('deckId').anyOf(deckIds).delete()
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
            if (change.entityId !== BASIC_NOTE_TYPE_ID) {
              const noteIds = (await this.notes.where('typeId').equals(change.entityId).primaryKeys()) as string[]
              if (noteIds.length) await this.cards.where('noteId').anyOf(noteIds).modify({ suspended: true })
              await this.noteTypes.delete(change.entityId)
            }
          } else if (change.entityType === 'deckOptionGroup') {
            if (await this.decks.where('optionGroupId').equals(change.entityId).count()) throw new Error('Cannot delete a synced deck option group while decks still reference it')
            await this.deckOptionGroups.delete(change.entityId)
          } else {
            await this.reviewEntries.delete(change.entityId)
          }
        } else if (change.entityType === 'deck') await this.decks.put(canonicalDeck(change.payload as LegacyDeck))
        else if (change.entityType === 'deckOptionGroup') await this.deckOptionGroups.put(change.payload as DeckOptionGroup)
        else if (change.entityType === 'note') await this.notes.put(canonicalNote(change.payload as LegacyNote))
        else if (change.entityType === 'card') await this.cards.put(canonicalCard(change.payload as LegacyCard))
        else if (change.entityType === 'noteMedia') await this.noteMedia.put(change.payload as NoteMediaReference)
        else if (change.entityType === 'noteType' && change.entityId !== BASIC_NOTE_TYPE_ID) await this.noteTypes.put(canonicalNoteType(change.payload as LegacyNoteType))
        else if (change.entityType === 'review') await this.reviewEntries.put(change.payload as ReviewEntry)
        await this.receivedOperations.add({ opId: change.opId })
        if (change.entityType === 'note') affectedNoteIds.add(change.entityId)
        if (change.entityType === 'noteMedia') {
          const reference = change.payload as Partial<NoteMediaReference> | undefined
          if (reference?.noteId) affectedNoteIds.add(reference.noteId)
        }
        if (change.entityType === 'card') {
          const noteId = (change.payload as Partial<CardRecord> | undefined)?.noteId
          if (noteId) affectedNoteIds.add(noteId)
        }
        if (change.entityType === 'noteType') affectedTypeIds.add(change.entityId)
      }
      for (const typeId of affectedTypeIds) {
        for (const noteId of await this.notes.where('typeId').equals(typeId).primaryKeys()) affectedNoteIds.add(noteId as string)
      }
      for (const noteId of affectedNoteIds) {
        const note = await this.notes.get(noteId)
        if (!note) continue
        const noteType = await this.noteTypes.get(note.typeId)
        if (noteType?.kind === 'image-occlusion') {
          const source = note.imageOcclusion && await this.noteMedia.get(note.imageOcclusion.sourceMediaId)
          if (!source || source.noteId !== note.id || source.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType) || source.side !== 'front' || !/^[a-f0-9]{64}$/.test(source.digest)) throw new Error('Image occlusion source image reference is invalid')
        }
        const generation = noteType && this.tryCardGenerationStatus(noteType, note.fields, note.imageOcclusion)
        const eligible = new Set(generation?.ok ? generation.value.eligible.map((template) => cardKey({ templateId: template.id, clozeOrdinal: template.clozeOrdinal, occlusionId: template.occlusionId })) : [])
        for (const card of await this.cards.where('noteId').equals(noteId).toArray()) {
          const active = eligible.has(cardKey(card)) && (noteType?.kind !== 'cloze' || card.id === `${noteId}:${card.templateId}:c${card.clozeOrdinal}`) && (noteType?.kind !== 'image-occlusion' || card.id === `${noteId}:${card.templateId}:m${card.occlusionId}`)
          if (Boolean(card.suspended) !== !active) await this.cards.put({ ...card, suspended: !active })
        }
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
