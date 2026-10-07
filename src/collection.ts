import Dexie, { type EntityTable } from 'dexie'
import { relatedEntities, recoverDeletionProvenance, currentLifetime, decideOperationLifetime, restoredLifetime, validateRestorationEvidence, type EntityType, type EntityLifetimeMetadata, type DeletionCause } from '../entity-lifetimes'
import { customStudyKey, customStudyMembership, customStudySessions, type CustomStudySession } from './custom-study-state'
import { createEmptyCard } from 'ts-fsrs'
import { answerWithSchedule, deserializeCard, eligibleForQueue, eligibleForStudy, isBuried, isInterdayLearning, isLearningCard, nextStudyBoundary, Rating, reviewChoices as previewReviewChoices, selectDueCards, serializeCard, State, templateSuspended, validateSteps, type Grade } from './scheduler'
import { SUPPORTED_MEDIA_TYPES } from '../anki-interchange'
import { digestMedia, validateMedia, type AudioPlayback, type MediaKind, type MediaSide } from './media'
import { clozeOrdinals, tryRenderTemplate, validateTemplate } from './template-renderer'
import { fieldsByName, isRenderedCardDisplayable, renderNoteCard } from './card-rendering'
import { mergeRevisions, revisionHeads, type RevisionMerge } from './sync-revisions'
import { isVerifiedPcBackupReceipt, type VerifiedPcBackupReceipt } from './pc-backup-receipt'
import { ImportedPackageRejected, rowFingerprint, type ImportedPackageWrites, type ImportedPartialChoice } from './import-contract'
import { undoBlocker, undoEpochMatches, undoOperationIds, undoOperationsPending, undoRowUnchanged, undoSubject, type CardMaintenanceUndo, type NoteDeletionUndo, type ReviewUndo, type UndoBlocker, type UndoRecord, type UndoRowBlocker } from './undo'

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
export type NewCardOrder = 'added' | 'random'
export type NewCardGatherOrder = 'deck' | 'deck-random-notes' | 'ascending-position' | 'descending-position' | 'random-notes' | 'random-cards'
export type NewCardSortOrder = 'template' | 'gathered' | 'template-random' | 'random-note-template' | 'random'
export type ReviewCardOrder = 'due' | 'due-then-deck' | 'deck-then-due' | 'interval-ascending' | 'interval-descending' | 'retrievability-ascending' | 'retrievability-descending' | 'random'
export type ReviewMixOrder = 'mix' | 'before-reviews' | 'after-reviews'
export type InterdayLearningOrder = ReviewMixOrder

export interface DeckOptionSettings {
  dailyNewLimit: number
  dailyReviewLimit: number
  desiredRetention: number
  learningSteps: readonly string[]
  relearningSteps: readonly string[]
  newCardOrder: NewCardOrder
  newCardGatherOrder?: NewCardGatherOrder
  newCardSortOrder?: NewCardSortOrder
  reviewCardOrder: ReviewCardOrder
  newReviewOrder?: ReviewMixOrder
  /** Controls where day-crossing learning cards appear relative to review cards. */
  interdayLearningOrder?: InterdayLearningOrder
  /** Omitted by pre-policy callers; the owning group retains its current policy. */
  buryNewSiblings?: boolean
  buryReviewSiblings?: boolean
  buryInterdayLearningSiblings?: boolean
  leechThreshold?: number
  leechAction?: LeechAction
  leechTag?: string
}

export type LeechAction = 'tag-only' | 'suspend'

export interface DeckOptionGroup {
  id: string
  name: string
  protected: boolean
  dailyNewLimit: number
  dailyReviewLimit: number
  desiredRetention: number
  learningSteps: readonly string[]
  relearningSteps: readonly string[]
  newCardOrder: NewCardOrder
  newCardGatherOrder: NewCardGatherOrder
  newCardSortOrder: NewCardSortOrder
  reviewCardOrder: ReviewCardOrder
  newReviewOrder: ReviewMixOrder
  interdayLearningOrder: InterdayLearningOrder
  buryNewSiblings: boolean
  buryReviewSiblings: boolean
  buryInterdayLearningSiblings: boolean
  leechThreshold: number
  leechAction: LeechAction
  leechTag: string
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
export function tryRenderNoteTemplate(template: string, noteType: NoteType, fieldsById: Record<string, string>, front?: string, ordinal?: number, side?: 'front' | 'back', htmlFieldIds: readonly string[] = []) {
  const displayFields = fieldsByName(noteType.fields, fieldsById)
  const richFieldIds = new Set(htmlFieldIds)
  const htmlFields = new Set(noteType.fields.filter((field) => richFieldIds.has(field.id)).map((field) => field.name))
  return tryRenderTemplate(template, displayFields, front, { kind: noteType.kind === 'image-occlusion' ? 'standard' : noteType.kind, ordinal, side: side ?? (front === undefined ? 'front' : 'back'), htmlFields })
}

export interface Note {
  id: string
  /** Original native Anki numeric identity, retained for package interchange. */
  ankiId?: number
  deckId: string
  type: 'basic' | 'custom'
  typeId: string
  fields: Record<string, string>
  renderedHtmlFields?: string[]
  tags?: string[]
  imageOcclusion?: ImageOcclusion
  retiredFields?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface CardRecord {
  id: string
  /** Original native Anki numeric identity, retained for package interchange. */
  ankiId?: number
  deckId: string
  noteId: string
  templateId: string
  clozeOrdinal?: number
  occlusionId?: string
  occlusionOrdinal?: number
  /** Retained only for legacy UI/data compatibility; it mirrors templateSuspended. */
  suspended?: boolean
  manualSuspended?: boolean
  templateSuspended?: boolean
  buriedUntil?: string | null
  /** Anki-compatible card flag: 0 is none, 1вЂ“7 are the standard colors. */
  flag?: number
  /** Anki insertion order for new-card gathering; sibling cards share a position. */
  newPosition?: number
  /** Anki card ordinal for sorting new cards by template. */
  templateOrdinal?: number
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
  /** Source modification time for deterministic Anki package updates. */
  sourceModifiedAt?: string
}

/** Undo lives in one module; these are re-exported so callers can name what they observe. */
export type { CardMaintenanceUndo, NoteDeletionUndo, ReviewUndo, UndoKind, UndoRecord } from './undo'

type LegacyNote = Omit<Note, 'typeId'> & { typeId?: string }
type LegacyCard = Omit<CardRecord, 'templateId' | 'manualSuspended' | 'templateSuspended' | 'buriedUntil'> & {
  templateId?: string
  manualSuspended?: boolean
  templateSuspended?: boolean
  buriedUntil?: string | null
}
type LegacyNoteType = Omit<NoteType, 'kind'> & { kind?: NoteType['kind'] }
type LegacyDeck = Omit<Deck, 'parentId' | 'optionGroupId'> & { parentId?: string | null; optionGroupId?: string }
type LegacyDeckOptionGroup = Omit<DeckOptionGroup, keyof DeckOptionSettings> & Partial<DeckOptionSettings>

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
  /** Active answer time, capped at 60 seconds. Absent from older/imported logs. */
  durationMs?: number
  /** False for custom-study practice: the scheduling record stays unchanged. */
  rescheduled?: boolean
  /** Original schedule and policy make independently produced reviews replayable. */
  scheduling?: { before: CardRecord; options: DeckOptionGroup }
  /** Resulting schedule after this answer. The fields above retain Anki's pre-answer review-log meaning. */
  afterState?: State
  afterDue?: string
  afterStability?: number
  afterDifficulty?: number
  afterElapsedDays?: number
  afterScheduledDays?: number
  afterLearningSteps?: number
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
  /** Cards currently claimed by a Custom Study Session in this Deck. */
  sessionCount: number
}

export interface ReviewChoice {
  rating: Grade
  label: 'Again' | 'Hard' | 'Good' | 'Easy'
  interval: string
}

export interface SyncOperation extends EntityLifetimeMetadata {
  opId: string
  entityType: EntityType
  entityId: string
  action: 'create' | 'update' | 'delete' | 'restore'
  occurredAt: string
  payload: unknown
  parents?: string[]
  reviewId?: string
}

export interface SyncConflict extends RevisionMerge { key: string; entityType: SyncOperation['entityType']; entityId: string }
interface SyncRevision extends SyncOperation { key: string }

export interface SyncSettings { endpoint: string; token: string; cursor: number; collectionGeneration?: string }
interface DeletionTombstone { key: string; entityType: SyncOperation['entityType']; entityId: string; occurredAt: string; causes?: DeletionCause[]; provenanceError?: string }
export interface NoteMediaReference { id: string; noteId: string; digest: string; kind: MediaKind; mimeType: string; displayName: string; side: MediaSide; templateId?: string; inline?: boolean; playback: AudioPlayback; createdAt: string; updatedAt: string }
export interface MediaBlob { digest: string; blob: Blob; byteLength: number; mimeType: string; verifiedAt: string }
export interface MediaBytes extends Omit<MediaBlob, 'blob'> { bytes: ArrayBuffer }
interface StoredMediaBlob extends Omit<MediaBlob, 'blob'> { blob: Blob | ArrayBuffer }
export interface NoteMediaAttachment { file: File; side: MediaSide; playback?: AudioPlayback }

const defaultDeckOptionSettings: Required<DeckOptionSettings> = {
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  desiredRetention: 0.9,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  newCardOrder: 'added',
  newCardGatherOrder: 'deck',
  newCardSortOrder: 'template',
  reviewCardOrder: 'due',
  newReviewOrder: 'mix',
  interdayLearningOrder: 'mix',
  buryNewSiblings: false,
  buryReviewSiblings: false,
  buryInterdayLearningSiblings: false,
  leechThreshold: 8,
  leechAction: 'suspend',
  leechTag: 'leech',
}

function id() {
  return crypto.randomUUID()
}

const tombstoneKey = (entityType: SyncOperation['entityType'], entityId: string) => `${entityType}:${entityId}`

/** The single settings key holding the one undo record. */
const UNDO_KEY = 'undo'

/** How the learner is referred to in an undo refusal. */
function undoLabel(record: UndoRecord) {
  if (record.kind === 'review') return 'This review'
  if (record.kind === 'note-deletion') return 'This deletion'
  return 'This card action'
}

/**
 * The message for a refusal. The guards are shared, but what the learner can be
 * told depends on which kind failed and why, so the wording stays per-kind.
 */
function undoRefusal(record: UndoRecord, blocker: UndoBlocker, rows: UndoRowBlocker | null): string {
  if (blocker === 'sync-attempt') return record.kind === 'review'
    ? 'This review cannot be undone after a sync attempt'
    : record.kind === 'note-deletion'
      ? 'This deletion cannot be undone after a sync attempt'
      : 'This card action cannot be undone after a sync attempt'
  if (blocker === 'synchronised') return record.kind === 'review'
    ? 'This review has already synchronized and cannot be undone'
    : `${undoLabel(record)} has already synchronized and cannot be undone`
  if (rows === 'original-deck-or-type-gone') return 'The original deck or note type was deleted; undo is unavailable'
  if (rows === 'note-type-changed') return 'The note type changed since deletion; undo is unavailable'
  if (record.kind === 'review') return record.note
    ? 'The note changed since this review; undo is unavailable'
    : 'A card changed since this review; undo is unavailable'
  if (record.kind === 'note-deletion') return 'The deleted note changed; undo is unavailable'
  return 'The card changed since this action; undo is unavailable'
}
function inboundDependencyOrder(change: SyncOperation) {
  if (change.entityType === 'deckOptionGroup') return change.action === 'delete' ? 7 : 0
  return ({ deck: 1, noteType: 2, note: 3, card: 4, review: 5, noteMedia: 6 } as const)[change.entityType]
}

/** A sync batch can be delivered in append order from several clients, so deck parents are not necessarily first. */
function orderInboundChanges(changes: SyncOperation[]) {
  const indexed = changes.map((change, index) => ({ change, index }))
  const ordered = indexed.sort((left, right) => inboundDependencyOrder(left.change) - inboundDependencyOrder(right.change) || left.index - right.index)
  const deckIndexes = ordered.filter(({ change }) => change.entityType === 'deck')
  const byDeckId = new Map<string, typeof deckIndexes[number]>()
  for (const entry of deckIndexes) if (!byDeckId.has(entry.change.entityId)) byDeckId.set(entry.change.entityId, entry)
  const visited = new Set<number>()
  const visiting = new Set<number>()
  const parentFirst: typeof deckIndexes = []
  const visit = (entry: typeof deckIndexes[number]) => {
    if (visited.has(entry.index)) return
    if (visiting.has(entry.index)) return
    visiting.add(entry.index)
    const parentId = (entry.change.payload as Partial<Deck> | undefined)?.parentId ?? entry.change.relatedLifetimes?.find(ref => ref.entityType === 'deck')?.entityId
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
    if (leftDeck !== undefined && rightDeck !== undefined) {
      if (left.change.action === 'delete' && right.change.action === 'delete') return rightDeck - leftDeck
      return leftDeck - rightDeck
    }
    return left.index - right.index
  }).map(({ change }) => change)
}

function relatedEntityIds(change: SyncOperation) {
  if (!change.payload || typeof change.payload !== 'object') return {}
  const payload = change.payload as { deckId?: unknown; noteId?: unknown; cardId?: unknown; parentId?: unknown; optionGroupId?: unknown }
  return {
    deckId: typeof payload.deckId === 'string' ? payload.deckId : undefined,
    noteId: typeof payload.noteId === 'string' ? payload.noteId : undefined,
    cardId: typeof payload.cardId === 'string' ? payload.cardId : undefined,
    parentId: typeof payload.parentId === 'string' ? payload.parentId : undefined,
    optionGroupId: typeof payload.optionGroupId === 'string' ? payload.optionGroupId : undefined,
  }
}

function requiredText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function copiedDeckOptionSettings(settings: DeckOptionSettings): Required<DeckOptionSettings> {
  return {
    ...settings,
    learningSteps: [...settings.learningSteps],
    relearningSteps: [...settings.relearningSteps],
    newCardGatherOrder: settings.newCardGatherOrder ?? defaultDeckOptionSettings.newCardGatherOrder,
    newCardSortOrder: settings.newCardSortOrder ?? (settings.newCardOrder === 'random' ? 'random' : defaultDeckOptionSettings.newCardSortOrder),
    newReviewOrder: settings.newReviewOrder ?? defaultDeckOptionSettings.newReviewOrder,
    interdayLearningOrder: settings.interdayLearningOrder ?? defaultDeckOptionSettings.interdayLearningOrder,
    buryNewSiblings: settings.buryNewSiblings ?? defaultDeckOptionSettings.buryNewSiblings,
    buryReviewSiblings: settings.buryReviewSiblings ?? defaultDeckOptionSettings.buryReviewSiblings,
    buryInterdayLearningSiblings: settings.buryInterdayLearningSiblings ?? defaultDeckOptionSettings.buryInterdayLearningSiblings,
    leechThreshold: settings.leechThreshold ?? defaultDeckOptionSettings.leechThreshold,
    leechAction: settings.leechAction ?? defaultDeckOptionSettings.leechAction,
    leechTag: settings.leechTag ?? defaultDeckOptionSettings.leechTag,
  }
}

function validateDailyLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999) throw new Error(`${label} must be a whole number from 0 to 9999`)
  return value
}

function validateLeechThreshold(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) throw new Error('Leech threshold must be a whole number from 1 to 9999')
  return value
}

function validateLeechTag(value: string) {
  const tag = requiredText(value, 'Leech tag')
  if (tag.length > 120) throw new Error('Leech tag is too long')
  return tag
}

function validateDeckOptionSettings(input: DeckOptionSettings): Required<DeckOptionSettings> {
  if (!input || typeof input !== 'object') throw new Error('Deck option settings are invalid')
  if (!Number.isFinite(input.desiredRetention) || input.desiredRetention <= 0 || input.desiredRetention > 1) throw new Error('Desired retention must be greater than 0 and at most 1')
  if (input.newCardOrder !== 'added' && input.newCardOrder !== 'random') throw new Error('New card order is invalid')
  const newCardGatherOrder = input.newCardGatherOrder ?? defaultDeckOptionSettings.newCardGatherOrder
  if (!['deck', 'deck-random-notes', 'ascending-position', 'descending-position', 'random-notes', 'random-cards'].includes(newCardGatherOrder)) throw new Error('New card gather order is invalid')
  const newCardSortOrder = input.newCardSortOrder ?? (input.newCardOrder === 'random' ? 'random' : defaultDeckOptionSettings.newCardSortOrder)
  if (!['template', 'gathered', 'template-random', 'random-note-template', 'random'].includes(newCardSortOrder)) throw new Error('New card sort order is invalid')
  if (!['due', 'due-then-deck', 'deck-then-due', 'interval-ascending', 'interval-descending', 'retrievability-ascending', 'retrievability-descending', 'random'].includes(input.reviewCardOrder)) throw new Error('Review card order is invalid')
  const newReviewOrder = input.newReviewOrder ?? defaultDeckOptionSettings.newReviewOrder
  if (!['mix', 'before-reviews', 'after-reviews'].includes(newReviewOrder)) throw new Error('New/review order is invalid')
  const interdayLearningOrder = input.interdayLearningOrder ?? defaultDeckOptionSettings.interdayLearningOrder
  if (!['mix', 'before-reviews', 'after-reviews'].includes(interdayLearningOrder)) throw new Error('Interday learning order is invalid')
  const buryNewSiblings = input.buryNewSiblings ?? defaultDeckOptionSettings.buryNewSiblings
  const buryReviewSiblings = input.buryReviewSiblings ?? defaultDeckOptionSettings.buryReviewSiblings
  const buryInterdayLearningSiblings = input.buryInterdayLearningSiblings ?? defaultDeckOptionSettings.buryInterdayLearningSiblings
  if (typeof buryNewSiblings !== 'boolean' || typeof buryReviewSiblings !== 'boolean' || typeof buryInterdayLearningSiblings !== 'boolean') throw new Error('Sibling burying options are invalid')
  const leechAction = input.leechAction ?? defaultDeckOptionSettings.leechAction
  if (leechAction !== 'tag-only' && leechAction !== 'suspend') throw new Error('Leech action is invalid')
  return {
    dailyNewLimit: validateDailyLimit(input.dailyNewLimit, 'Daily new limit'),
    dailyReviewLimit: validateDailyLimit(input.dailyReviewLimit, 'Daily review limit'),
    desiredRetention: input.desiredRetention,
    learningSteps: validateSteps(input.learningSteps, 'Learning steps'),
    relearningSteps: validateSteps(input.relearningSteps, 'Relearning steps'),
    newCardOrder: input.newCardOrder,
    newCardGatherOrder,
    newCardSortOrder,
    reviewCardOrder: input.reviewCardOrder,
    newReviewOrder,
    interdayLearningOrder,
    buryNewSiblings,
    buryReviewSiblings,
    buryInterdayLearningSiblings,
    leechThreshold: validateLeechThreshold(input.leechThreshold ?? defaultDeckOptionSettings.leechThreshold),
    leechAction,
    leechTag: validateLeechTag(input.leechTag ?? defaultDeckOptionSettings.leechTag),
  }
}

function canonicalDeckOptionGroup(group: LegacyDeckOptionGroup): DeckOptionGroup {
  return {
    ...group,
    ...validateDeckOptionSettings({
      dailyNewLimit: group.dailyNewLimit ?? defaultDeckOptionSettings.dailyNewLimit,
      dailyReviewLimit: group.dailyReviewLimit ?? defaultDeckOptionSettings.dailyReviewLimit,
      desiredRetention: group.desiredRetention ?? defaultDeckOptionSettings.desiredRetention,
      learningSteps: group.learningSteps ?? defaultDeckOptionSettings.learningSteps,
      relearningSteps: group.relearningSteps ?? defaultDeckOptionSettings.relearningSteps,
      newCardOrder: group.newCardOrder ?? defaultDeckOptionSettings.newCardOrder,
      newCardGatherOrder: group.newCardGatherOrder ?? defaultDeckOptionSettings.newCardGatherOrder,
      newCardSortOrder: group.newCardSortOrder ?? (group.newCardOrder === 'random' ? 'random' : defaultDeckOptionSettings.newCardSortOrder),
      reviewCardOrder: group.reviewCardOrder ?? defaultDeckOptionSettings.reviewCardOrder,
      newReviewOrder: group.newReviewOrder ?? defaultDeckOptionSettings.newReviewOrder,
      interdayLearningOrder: group.interdayLearningOrder ?? defaultDeckOptionSettings.interdayLearningOrder,
      buryNewSiblings: group.buryNewSiblings ?? defaultDeckOptionSettings.buryNewSiblings,
      buryReviewSiblings: group.buryReviewSiblings ?? defaultDeckOptionSettings.buryReviewSiblings,
      buryInterdayLearningSiblings: group.buryInterdayLearningSiblings ?? defaultDeckOptionSettings.buryInterdayLearningSiblings,
      leechThreshold: group.leechThreshold ?? defaultDeckOptionSettings.leechThreshold,
      leechAction: group.leechAction ?? defaultDeckOptionSettings.leechAction,
      leechTag: group.leechTag ?? defaultDeckOptionSettings.leechTag,
    }),
  }
}

function withPolicyDefaults(card: CardRecord): CardRecord {
  return {
    ...card,
    suspended: templateSuspended(card),
    templateSuspended: templateSuspended(card),
    manualSuspended: card.manualSuspended ?? false,
    buriedUntil: card.buriedUntil ?? null,
    flag: card.flag ?? 0,
  }
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
  if (card.suspended !== undefined && typeof card.suspended !== 'boolean') throw new Error('Card legacy suspension is invalid')
  if (card.manualSuspended !== undefined && typeof card.manualSuspended !== 'boolean') throw new Error('Card manual suspension is invalid')
  if (card.templateSuspended !== undefined && typeof card.templateSuspended !== 'boolean') throw new Error('Card template suspension is invalid')
  if (card.templateSuspended !== undefined && card.suspended !== undefined && card.templateSuspended !== card.suspended) throw new Error('Card suspension fields conflict')
  if (card.buriedUntil !== undefined && card.buriedUntil !== null && typeof card.buriedUntil !== 'string') throw new Error('Card burial time is invalid')
  if (card.flag !== undefined && (!Number.isSafeInteger(card.flag) || card.flag < 0 || card.flag > 7)) throw new Error('Card flag is invalid')
  if (card.newPosition !== undefined && (!Number.isSafeInteger(card.newPosition) || card.newPosition < 0)) throw new Error('New card position is invalid')
  if (card.templateOrdinal !== undefined && (!Number.isSafeInteger(card.templateOrdinal) || card.templateOrdinal < 0)) throw new Error('Card template ordinal is invalid')
  const buriedUntil = card.buriedUntil ?? null
  if (buriedUntil !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(buriedUntil) || Number.isNaN(new Date(buriedUntil).getTime()))) throw new Error('Card burial time is invalid')
  return withPolicyDefaults({ ...card, templateId: card.templateId ?? BASIC_TEMPLATE_ID, buriedUntil })
}

export type CardScheduleUpdate = Partial<Pick<CardRecord, 'state' | 'due' | 'stability' | 'difficulty' | 'elapsedDays' | 'scheduledDays' | 'learningSteps' | 'reps' | 'lapses' | 'lastReview'>>

/** Anki gathers intraday learning, interday learning, review, then new cards. */
function queueGatherPriority(card: CardRecord) {
  if (isLearningCard(card) && !isInterdayLearning(card)) return 0
  if (isInterdayLearning(card)) return 1
  if (card.state === State.Review) return 2
  return 3
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
  ...copiedDeckOptionSettings(defaultDeckOptionSettings),
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

function addCardCount(counts: DeckCounts, card: CardRecord) {
  if (card.suspended) return
  if (card.state === State.New) counts.new += 1
  else if (card.state === State.Review) counts.review += 1
  else counts.learning += 1
}

function countsFor(cards: CardRecord[]): DeckCounts {
  const counts = { new: 0, learning: 0, review: 0 }
  for (const card of cards) addCardCount(counts, card)
  return counts
}

class DexieCollection extends Dexie {
  noteTypes!: EntityTable<NoteType, 'id'>
  decks!: EntityTable<Deck, 'id'>
  deckOptionGroups!: EntityTable<DeckOptionGroup, 'id'>
  notes!: EntityTable<Note, 'id'>
  cards!: EntityTable<CardRecord, 'id'>
  reviewEntries!: EntityTable<ReviewEntry, 'id'>
  outbox!: EntityTable<SyncOperation, 'opId'>
  syncRevisions!: EntityTable<SyncRevision, 'opId'>
  pendingRemoteOperations!: EntityTable<SyncOperation, 'opId'>
  syncConflicts!: EntityTable<SyncConflict, 'key'>
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
    this.version(10).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
      if (!await transaction.table('deckOptionGroups').get(DEFAULT_DECK_OPTION_GROUP_ID)) await transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
    this.version(11).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
      await transaction.table('cards').toCollection().modify((card: LegacyCard) => Object.assign(card, canonicalCard(card)))
      if (!await transaction.table('deckOptionGroups').get(DEFAULT_DECK_OPTION_GROUP_ID)) await transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
    this.version(12).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
      if (!await transaction.table('deckOptionGroups').get(DEFAULT_DECK_OPTION_GROUP_ID)) await transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
    this.version(13).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('cards').toCollection().modify((card: CardRecord) => { if (card.flag === undefined) card.flag = 0 })
    })
    this.version(14).stores({})
    this.version(15).stores({ syncRevisions: 'opId, key', syncConflicts: 'key, entityType, entityId' })
    this.version(16).stores({})
    this.version(17).stores({}).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
    })
    this.version(18).stores({}).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
    })
    this.version(19).stores({
      decks: 'id, parentId, optionGroupId, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state, newPosition', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt', deckOptionGroups: 'id, name, updatedAt', syncRevisions: 'opId, key', syncConflicts: 'key, entityType, entityId',
    }).upgrade(async (transaction) => {
      const notes = new Map((await transaction.table('notes').toArray()).map((note: Note) => [note.id, note]))
      const noteTypes = new Map((await transaction.table('noteTypes').toArray()).map((noteType: NoteType) => [noteType.id, noteType]))
      const cards = await transaction.table('cards').toArray() as CardRecord[]
      const maxPosition = cards.reduce((max, card) => Math.max(max, card.newPosition ?? -1), -1)
      const newNotes = [...new Set(cards.filter((card) => card.state === State.New && card.newPosition === undefined).map((card) => card.noteId))]
        .sort((left, right) => (notes.get(left)?.createdAt ?? '').localeCompare(notes.get(right)?.createdAt ?? '') || left.localeCompare(right))
      const positions = new Map(newNotes.map((noteId, index) => [noteId, maxPosition + index + 1]))
      await transaction.table('cards').toCollection().modify((card: CardRecord) => {
        const note = notes.get(card.noteId)
        const noteType = note ? noteTypes.get(note.typeId) : undefined
        card.newPosition ??= card.state === State.New ? positions.get(card.noteId) ?? 0 : undefined
        card.templateOrdinal ??= noteType?.kind === 'cloze'
          ? Math.max(0, (card.clozeOrdinal ?? 1) - 1)
          : noteType?.kind === 'image-occlusion'
            ? Math.max(0, (card.occlusionOrdinal ?? 1) - 1)
            : Math.max(0, noteType?.templates.findIndex((template) => template.id === card.templateId) ?? 0)
      })
    })
    this.version(20).stores({}).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
    })
    this.version(21).stores({}).upgrade(async (transaction) => {
      await transaction.table('deckOptionGroups').toCollection().modify((group: LegacyDeckOptionGroup) => Object.assign(group, canonicalDeckOptionGroup(group)))
    })
    this.version(22).stores({ pendingRemoteOperations: 'opId, entityType, entityId' }).upgrade(async (transaction) => {
      const revisions = await transaction.table('syncRevisions').toArray() as SyncRevision[]
      await transaction.table('deletedEntities').toCollection().modify((barrier: DeletionTombstone) => {
        if (!barrier.causes?.length) Object.assign(barrier, recoverDeletionProvenance(barrier, revisions))
      })
      // Legacy queued work retains its initial lifetime and original references.
      // Receiving legacy operations also treats absent metadata as initial.
      await transaction.table('outbox').toCollection().modify((operation: SyncOperation) => {
        operation.lifetime ??= []
        operation.relatedLifetimes ??= relatedEntities(operation.entityType, operation.payload).map(ref => ({ ...ref, lifetime: [] }))
      })
    })
    this.on('populate', (transaction) => {
      transaction.table('noteTypes').put(basicNoteType)
      transaction.table('noteTypes').put(imageOcclusionNoteType)
      transaction.table('deckOptionGroups').put(defaultDeckOptionGroup)
    })
  }

  get databaseName() { return this.name }
  get schemaVersion() { return this.verno }
  async openLocalCollection(): Promise<Collection> {
    if (!this.isOpen()) await this.open()
    return this as Collection
  }

  closeLocalCollection() {
    if (this.isOpen()) this.close()
  }

  async removeLocalCollection() {
    this.closeLocalCollection()
    await this.delete()
  }

  onOpenBlocked(listener: () => void) {
    this.on('blocked', listener)
    return () => this.on('blocked').unsubscribe(listener)
  }

  private async nextNewPosition() {
    const last = await this.cards.orderBy('newPosition').last()
    return (last?.newPosition ?? -1) + 1
  }

  private cardTemplateOrdinal(noteType: NoteType, template: { id: string; clozeOrdinal?: number; occlusionOrdinal?: number }) {
    if (template.clozeOrdinal !== undefined) return Math.max(0, template.clozeOrdinal - 1)
    if (template.occlusionOrdinal !== undefined) return Math.max(0, template.occlusionOrdinal - 1)
    return Math.max(0, noteType.templates.findIndex((candidate) => candidate.id === template.id))
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
    await this.transaction('rw', this.noteTypes, this.outbox, this.syncRevisions, async () => {
      await this.noteTypes.add(noteType)
      await this.enqueueOperation({ opId: id(), entityType: 'noteType', entityId: noteType.id, action: 'create', occurredAt: noteType.createdAt, payload: noteType })
    })
    return noteType
  }

  async cloneNoteType(typeId: string, name?: string, now = new Date()): Promise<NoteType> {
    return this.transaction('rw', [this.noteTypes, this.outbox, this.syncRevisions], async () => {
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
    const existingNewPosition = existing.find((card) => card.state === State.New)?.newPosition
    const newPosition = existingNewPosition ?? await this.nextNewPosition()
    const eligible = this.cardGenerationStatus(noteType, note.fields, note.imageOcclusion).eligible
    const eligibleIds = new Set(eligible.map((template) => cardKey({ templateId: template.id, clozeOrdinal: template.clozeOrdinal, occlusionId: template.occlusionId })))
    for (const card of existing) {
      const suspended = !eligibleIds.has(cardKey(card))
      if (templateSuspended(card) === suspended && card.templateSuspended !== undefined) continue
      const revised = { ...card, suspended, templateSuspended: suspended, manualSuspended: card.manualSuspended ?? false, buriedUntil: card.buriedUntil ?? null }
      await this.cards.put(revised)
      operations.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'update', occurredAt: now.toISOString(), payload: revised })
    }
    const existingIds = new Set(existing.map(cardKey))
    for (const template of eligible) {
      if (existingIds.has(cardKey({ templateId: template.id, clozeOrdinal: template.clozeOrdinal, occlusionId: template.occlusionId }))) continue
      const card = serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}${template.clozeOrdinal ? `:c${template.clozeOrdinal}` : template.occlusionId ? `:m${template.occlusionId}` : ''}`, deckId: note.deckId, noteId: note.id, templateId: template.id, ...(template.clozeOrdinal ? { clozeOrdinal: template.clozeOrdinal } : {}), ...(template.occlusionId ? { occlusionId: template.occlusionId, occlusionOrdinal: template.occlusionOrdinal } : {}) })
      card.newPosition = newPosition
      card.templateOrdinal = this.cardTemplateOrdinal(noteType, template)
      await this.cards.add(card)
      operations.push({ opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: now.toISOString(), payload: card })
    }
  }

  async updateNoteType(typeId: string, input: UpdateNoteType, now = new Date()): Promise<NoteType> {
    return this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox, this.syncRevisions], async () => {
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
          revised = { ...note, fields: values, ...(note.renderedHtmlFields ? { renderedHtmlFields: note.renderedHtmlFields.filter((fieldId) => currentIds.has(fieldId)) } : {}), ...(Object.keys(retiredFields).length ? { retiredFields } : {}), updatedAt: now.toISOString() }
          await this.notes.put(revised)
          operations.push({ opId: id(), entityType: 'note', entityId: note.id, action: 'update', occurredAt: revised.updatedAt, payload: revised })
        }
        await this.reconcileCards(revised, updated, now, operations)
      }
      await this.noteTypes.put(updated)
      await this.enqueueOperations(operations)
      return updated
    })
  }

  async deleteNoteType(typeId: string, replacement?: NoteTypeReplacement, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox, this.syncRevisions, this.deletedEntities], async () => {
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
        const renderedHtmlFields = note.renderedHtmlFields?.flatMap((fieldId) => mapping[fieldId] ? [mapping[fieldId]] : [])
        const revised: Note = { ...note, typeId: target.id, type: target.id === BASIC_NOTE_TYPE_ID ? 'basic' : 'custom', fields, ...(renderedHtmlFields ? { renderedHtmlFields } : {}), ...(Object.keys(retiredFields).length ? { retiredFields } : {}), updatedAt: now.toISOString() }
        await this.notes.put(revised)
        operations.push({ opId: id(), entityType: 'note', entityId: note.id, action: 'update', occurredAt: revised.updatedAt, payload: revised })
        await this.reconcileCards(revised, target, now, operations)
      }
      await this.noteTypes.delete(typeId)
      await this.deletedEntities.put({ key: tombstoneKey('noteType', typeId), entityType: 'noteType', entityId: typeId, occurredAt: now.toISOString() })
      operations.push({ opId: id(), entityType: 'noteType', entityId: typeId, action: 'delete', occurredAt: now.toISOString(), payload: { id: typeId } })
      await this.enqueueOperations(operations)
    })
  }

  cardGenerationStatus(noteType: NoteType, fields: Record<string, string>, imageOcclusion?: ImageOcclusion) {
    const skipped: { templateId: string; reason: string }[] = []
    const eligible: Array<CardTemplate & { clozeOrdinal?: number; occlusionId?: string; occlusionOrdinal?: number }> = []
    // The failure convention, stated once: a template that cannot be rendered is
    // a fault, and is reported as one. Emptiness is a separate, quieter thing -
    // a card with nothing visible is merely skipped.
    const assertRenderable = (template: CardTemplate, ordinal?: number) => {
      for (const side of ['front', 'back'] as const) {
        const result = tryRenderNoteTemplate(template[side], noteType, fields, undefined, ordinal, side)
        if (!result.ok) throw new Error(result.error)
      }
    }
    if (noteType.kind === 'image-occlusion') {
      if (!imageOcclusion) throw new Error('Image occlusion metadata is required')
      validateImageOcclusion(imageOcclusion)
      if (noteType.templates.length !== 1) throw new Error('Image occlusion needs exactly one template')
      for (const mask of imageOcclusion.masks) {
        assertRenderable(noteType.templates[0], mask.ordinal)
        eligible.push({ ...noteType.templates[0], occlusionId: mask.id, occlusionOrdinal: mask.ordinal })
      }
      return { eligible, skipped }
    }
    if (noteType.kind === 'cloze') {
      const field = clozeField(noteType)
      if (!field) throw new Error('Cloze field not found')
      const ordinals = clozeOrdinals(fields[field.id] ?? '')
      assertRenderable(noteType.templates[0], ordinals[0] ?? 1)
      for (const ordinal of ordinals) eligible.push({ ...noteType.templates[0], clozeOrdinal: ordinal })
      if (!ordinals.length) skipped.push({ templateId: noteType.templates[0].id, reason: 'No cloze deletions found' })
      return { eligible, skipped }
    }
    for (const template of noteType.templates) {
      // A template that renders but shows nothing is skipped, not refused. A
      // template that does not render is a fault, and throws.
      assertRenderable(template)
      const rendered = renderNoteCard(noteType, template, fields)
      if (!isRenderedCardDisplayable(rendered, noteType.kind)) skipped.push({ templateId: template.id, reason: 'Front has no visible field content' })
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
    return this.transaction('rw', [this.decks, this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox, this.syncRevisions], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      await this.mediaBlobs.put(blob)
      await this.noteMedia.add(reference)
      await this.notes.add(note)
      const operations: SyncOperation[] = [
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: createdAt, payload: note },
        { opId: id(), entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: createdAt, payload: reference },
      ]
      await this.reconcileCards(note, imageOcclusionNoteType, now, operations)
      await this.enqueueOperations(operations)
      return note
    })
  }

  async updateImageOcclusionNote(noteId: string, input: UpdateImageOcclusionNote, now = new Date()): Promise<void> {
    if ((input.imageWidth !== undefined || input.imageHeight !== undefined) && !input.image) throw new Error('Image dimensions require a new source image')
    const definition = input.image ? validateMedia(input.image) : undefined
    if (definition && definition.kind !== 'image') throw new Error('Image occlusion requires an image')
    const digest = input.image ? await digestMedia(input.image) : undefined
    const storedImage = input.image ? await mediaBytes(input.image) : undefined
    await this.transaction('rw', [this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox, this.syncRevisions], async () => {
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
      await this.enqueueOperations(operations)
    })
  }

  async createNote(deckId: string, typeId: string, fields: Record<string, string>, now = new Date(), stableId?: string): Promise<Note> {
    return this.transaction('rw', [this.decks, this.noteTypes, this.notes, this.cards, this.outbox, this.deletedEntities, this.syncRevisions], async () => {
      if (stableId !== undefined && (!stableId.length || stableId.length > 512 || [...stableId].some((character) => character.charCodeAt(0) < 32) || await this.deletedEntities.get(tombstoneKey('note', stableId)))) throw new Error('Note identifier is invalid or belongs to a deleted note')
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      const noteType = await this.noteTypes.get(typeId)
      if (!noteType) throw new Error('Note type not found')
      if (noteType.kind === 'image-occlusion') throw new Error('Use the image occlusion editor to create this note')
      const values = Object.fromEntries(noteType.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const note: Note = { id: stableId ?? id(), deckId, type: typeId === BASIC_NOTE_TYPE_ID ? 'basic' : 'custom', typeId, fields: values, createdAt: now.toISOString(), updatedAt: now.toISOString() }
      const newPosition = await this.nextNewPosition()
      const cards = this.cardGenerationStatus(noteType, values).eligible.map((template) => {
        const card = serializeCard(createEmptyCard(now), { id: `${note.id}:${template.id}${template.clozeOrdinal ? `:c${template.clozeOrdinal}` : ''}`, deckId, noteId: note.id, templateId: template.id, ...(template.clozeOrdinal ? { clozeOrdinal: template.clozeOrdinal } : {}) })
        card.newPosition = newPosition
        card.templateOrdinal = this.cardTemplateOrdinal(noteType, template)
        return card
      })
      await this.notes.add(note)
      if (cards.length) await this.cards.bulkAdd(cards)
      await this.enqueueOperations([
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note },
        ...cards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'create' as const, occurredAt: note.createdAt, payload: card })),
      ])
      return note
    })
  }

  async updateNote(noteId: string, fields: Record<string, string>, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.outbox, this.syncRevisions], async () => {
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
      await this.enqueueOperations(changes)
    })
  }

  /**
   * The one multi-table write. Package import and inbound sync both go through
   * a Collection operation rather than naming tables, so an invariant cannot be
   * mirrored into a second writer and go stale there.
   *
   * Everything is checked before anything is written: a rejected import leaves
   * the collection exactly as it was.
   */
  async applyImportedPackage(writes: ImportedPackageWrites, importedAt: string, expectUnchanged: Array<{ table: string; id: string; value: string }> = [], partialChoice?: ImportedPartialChoice): Promise<void> {
    const scope = [this.decks, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.mediaBlobs, this.outbox, this.syncRevisions, this.settings, this.deckOptionGroups, this.deletedEntities]
    await this.transaction('rw', scope, async () => {
      // The preview is only trustworthy if the rows it read are unchanged, so
      // this check shares the transaction rather than preceding it.
      for (const snapshot of expectUnchanged) {
        const current = snapshot.table === '$tableCounts'
          ? await Promise.all([this.decks, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.settings, this.mediaBlobs, this.outbox, this.syncRevisions, this.deletedEntities, this.deckOptionGroups].map((table) => table.count()))
          : await (this as unknown as Record<string, { get(id: string): Promise<unknown> }>)[snapshot.table].get(snapshot.id)
        if (rowFingerprint(current) !== snapshot.value) throw new Error('The collection changed after this preview. Please preview again before importing.')
      }
      const restorationByKey = new Map((writes.restorations ?? []).map(restoration => [tombstoneKey(restoration.entityType, restoration.entityId), restoration]))
      if (restorationByKey.size !== (writes.restorations?.length ?? 0)) throw new Error('Duplicate restoration authorization. Nothing was imported.')
      const targets = [
        ...writes.decks.map(({ value }) => ({ entityType: 'deck' as const, entityId: value.id })),
        ...writes.noteTypes.map(({ value }) => ({ entityType: 'noteType' as const, entityId: value.id })),
        ...writes.notes.map(({ value }) => ({ entityType: 'note' as const, entityId: value.id })),
        ...writes.cards.map(({ value }) => ({ entityType: 'card' as const, entityId: value.id })),
        ...writes.reviews.map(value => ({ entityType: 'review' as const, entityId: value.id })),
        ...writes.updatedReviews.map(value => ({ entityType: 'review' as const, entityId: value.id })),
        ...writes.references.map(({ value }) => ({ entityType: 'noteMedia' as const, entityId: value.id })),
      ]
      const targetKeys = new Set(targets.map(target => tombstoneKey(target.entityType, target.entityId)))
      if ([...restorationByKey.keys()].some(key => !targetKeys.has(key))) throw new Error('Restoration authorization names content outside this import.')
      const retained = await this.syncRevisions.toArray()
      for (const target of targets) {
        const key = tombstoneKey(target.entityType, target.entityId)
        const barrier = await this.deletedEntities.get(key)
        const restoration = restorationByKey.get(key)
        if (!barrier && restoration) throw new Error('The collection changed after this preview. Please preview again before importing.')
        if (!barrier) continue
        if (!restoration) throw new ImportedPackageRejected(`${target.entityType} ${target.entityId}`, 'has the identity of a deleted record')
        if (barrier.provenanceError || JSON.stringify(barrier.causes) !== JSON.stringify(restoration.causes)) throw new Error('Deletion provenance changed after this preview. Preview again before restoring.')
        validateRestorationEvidence(target, restoration.causes, retained)
      }
      await this.assertImportedPackageValid(writes, new Set(restorationByKey.keys()))
      const operation = (entityType: SyncOperation['entityType'], entityId: string, action: 'create' | 'update', payload: unknown): SyncOperation => {
        const restoration = restorationByKey.get(tombstoneKey(entityType, entityId))
        return { opId: id(), entityType, entityId, action: restoration ? 'restore' : action, occurredAt: importedAt, payload, ...(restoration ? { lifetime: restoredLifetime(restoration.causes), restoreOf: restoration.causes } : {}) }
      }
      const deletion = (entityType: SyncOperation['entityType'], entityId: string) =>
        ({ opId: id(), entityType, entityId, action: 'delete' as const, occurredAt: importedAt, payload: { id: entityId } })

      if (writes.decks.length) await this.decks.bulkPut(writes.decks.map(({ value }) => value))
      if (writes.deletedDecks.length) await this.decks.bulkDelete(writes.deletedDecks.map(({ id }) => id))
      for (const { key, value } of writes.undoSettings) await this.settings.put({ key, value })
      if (partialChoice) await this.settings.put({ key: partialChoice.key, value: partialChoice.value })
      if (writes.noteTypes.length) await this.noteTypes.bulkPut(writes.noteTypes.map(({ value }) => value))
      if (writes.notes.length) await this.notes.bulkPut(writes.notes.map(({ value }) => value))
      if (writes.cards.length) await this.cards.bulkPut(writes.cards.map(({ value }) => value))
      if (writes.reviews.length) await this.reviewEntries.bulkAdd(writes.reviews)
      if (writes.updatedReviews.length) await this.reviewEntries.bulkPut(writes.updatedReviews)
      if (writes.references.length) await this.noteMedia.bulkPut(writes.references.map(({ value }) => value))
      if (writes.deletedReferences.length) await this.noteMedia.bulkDelete(writes.deletedReferences.map(({ id }) => id))
      if (writes.blobs.length) await this.mediaBlobs.bulkPut(writes.blobs)

      const operations: SyncOperation[] = [
        ...writes.decks.map(({ value, action }) => operation('deck', value.id, action, value)),
        ...writes.deletedDecks.map((value) => deletion('deck', value.id)),
        ...writes.noteTypes.map(({ value, action }) => operation('noteType', value.id, action, value)),
        ...writes.notes.map(({ value, action }) => operation('note', value.id, action, value)),
        ...writes.cards.map(({ value, action }) => operation('card', value.id, action, value)),
        ...writes.reviews.map((value) => operation('review', value.id, 'create', value)),
        ...writes.updatedReviews.map((value) => operation('review', value.id, 'update', value)),
        ...writes.references.map(({ value, action }) => operation('noteMedia', value.id, action, value)),
        ...writes.deletedReferences.map((value) => deletion('noteMedia', value.id)),
      ]
      await this.deletedEntities.bulkDelete([...restorationByKey.keys()])
      if (operations.length) await this.enqueueOperations(operations)
    })
  }

  /**
   * Applies every rule the hand-written write routes enforce. Import bypassed
   * all of them, so a package could leave a deck hierarchy that cycles, a tag
   * the app would have refused, or an occlusion mask outside its image.
   *
   * The whole batch is checked before any write, so a refusal is total.
   */
  private async assertImportedPackageValid(writes: ImportedPackageWrites, restoredKeys = new Set<string>()): Promise<void> {
    const groupIds = new Set((await this.deckOptionGroups.toArray()).map(({ id }) => id))

    // Decks: identity, required fields, a resolvable option group, no duplicate
    // sibling name, no cycle - including cycles created within this batch.
    const projected = new Map<string, Deck>()
    for (const deck of await this.decks.toArray()) projected.set(deck.id, deck)
    // A deck this batch reconciles away does not exist afterwards, so it cannot
    // make an incoming sibling a duplicate.
    for (const superseded of writes.deletedDecks) projected.delete(superseded.id)
    for (const { value: deck } of writes.decks) projected.set(deck.id, deck)
    // Sibling names are indexed rather than scanned: import is the one route that
    // writes thousands of decks at once, and a scan per deck made that quadratic.
    const siblingNames = new Map<string, Set<string>>()
    for (const deck of projected.values()) {
      const key = `${deck.parentId ?? ''} ${deck.name.trim().toLocaleLowerCase()}`
      const ids = siblingNames.get(key) ?? new Set<string>()
      ids.add(deck.id)
      siblingNames.set(key, ids)
    }
    for (const { value: deck } of writes.decks) {
      if (!groupIds.has(deck.optionGroupId)) throw new ImportedPackageRejected(`Deck "${deck.name}"`, 'names a deck option group that does not exist')
      requiredText(deck.name, 'Deck name')
      const contenders = siblingNames.get(`${deck.parentId ?? ''} ${deck.name.trim().toLocaleLowerCase()}`)
      if (contenders && [...contenders].some((id) => id !== deck.id)) {
        throw new ImportedPackageRejected(`Deck "${deck.name}"`, 'duplicates the name of a sibling deck')
      }
      const seen = new Set([deck.id])
      let parentId = deck.parentId
      while (parentId !== null) {
        if (seen.has(parentId)) throw new ImportedPackageRejected(`Deck "${deck.name}"`, 'would create a cycle in the deck hierarchy')
        seen.add(parentId)
        const parent = projected.get(parentId)
        if (!parent) throw new ImportedPackageRejected(`Deck "${deck.name}"`, 'names a parent deck that does not exist')
        parentId = parent.parentId
      }
    }

    // Note types: a type with no fields, no templates or a broken cloze field can
    // never generate a card, so importing one leaves a type the editor refuses
    // to open.
    const writtenTypes = new Map(writes.noteTypes.map(({ value }) => [value.id, value]))
    for (const type of writtenTypes.values()) {
      if (!type.fields.length) throw new ImportedPackageRejected(`Note type "${type.name}"`, 'has no fields')
      if (!type.templates.length) throw new ImportedPackageRejected(`Note type "${type.name}"`, 'has no templates')
      const names = type.fields.map(({ name }) => name.trim().toLocaleLowerCase())
      if (new Set(names).size !== names.length) throw new ImportedPackageRejected(`Note type "${type.name}"`, 'has duplicate field names')
      if (names.includes('frontside')) throw new ImportedPackageRejected(`Note type "${type.name}"`, 'uses the reserved field name FrontSide')
      const templateNames = type.templates.map(({ id }) => id)
      if (new Set(templateNames).size !== templateNames.length) throw new ImportedPackageRejected(`Note type "${type.name}"`, 'has duplicate template identities')
      try {
        for (const template of type.templates) {
          validateTemplate(template.front, type.fields.map(({ name }) => name), 'front', type.kind === 'image-occlusion' ? 'standard' : type.kind)
          validateTemplate(template.back, type.fields.map(({ name }) => name), 'back', type.kind === 'image-occlusion' ? 'standard' : type.kind)
        }
        if (type.kind === 'cloze') clozeField(type)
      } catch (reason) {
        throw new ImportedPackageRejected(`Note type "${type.name}"`, reason instanceof Error ? reason.message : 'has an invalid template')
      }
    }

    // Notes: identity, a resolvable deck and note type, normalised tags, and a
    // valid occlusion mask that does not renumber what already exists.
    const deckIds = new Set(projected.keys())
    const typeIds = new Set([...(await this.noteTypes.toArray()).map(({ id }) => id), ...writtenTypes.keys()])
    const existingNotes = new Map((await this.notes.toArray()).map((note) => [note.id, note]))
    const existingCards = await this.cards.where('noteId').anyOf([...writes.notes.map(({ value }) => value.id)]).toArray()
    for (const { value: note } of writes.notes) {
      if (!note.id.length || note.id.length > 512 || [...note.id].some((character) => character.charCodeAt(0) < 32)) throw new ImportedPackageRejected(`Note ${note.id}`, 'has an invalid identity')
      // A tombstoned identity must stay dead: inbound sync suppresses every
      // operation for it, so recreating the row would make it un-syncable.
      if (!restoredKeys.has(tombstoneKey('note', note.id)) && await this.deletedEntities.get(tombstoneKey('note', note.id))) throw new ImportedPackageRejected(`Note ${note.id}`, 'has the identity of a deleted note')
      if (!deckIds.has(note.deckId)) throw new ImportedPackageRejected(`Note ${note.id}`, 'names a deck that does not exist')
      if (!typeIds.has(note.typeId)) throw new ImportedPackageRejected(`Note ${note.id}`, 'names a note type that does not exist')
      if (!Array.isArray(note.tags)) throw new ImportedPackageRejected(`Note ${note.id}`, 'has no tag list')
      let normalized: string[]
      try {
        normalized = normalizeTags(note.tags)
      } catch (reason) {
        throw new ImportedPackageRejected(`Note ${note.id}`, reason instanceof Error ? reason.message : 'has invalid tags')
      }
      // Normalise, do not merely validate: an Anki package carries whatever
      // whitespace and casing the exporter used, and the app's own paths store
      // the normalised form.
      if (JSON.stringify(normalized) !== JSON.stringify(note.tags)) writes.notes[writes.notes.findIndex(({ value }) => value.id === note.id)].value.tags = normalized
      if (note.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID) {
        if (!note.imageOcclusion) throw new ImportedPackageRejected(`Note ${note.id}`, 'is an image occlusion note with no mask data')
        try {
          validateImageOcclusion(note.imageOcclusion)
        } catch (reason) {
          throw new ImportedPackageRejected(`Note ${note.id}`, reason instanceof Error ? reason.message : 'has an invalid image occlusion mask')
        }
        // An older package must not renumber masks a learner already has: card
        // identities embed the ordinal, so renumbering silently rebinds them.
        const previous = existingNotes.get(note.id)
        const priorOrdinals = new Map<string, number>([
          ...(previous?.imageOcclusion?.masks ?? []).map((mask) => [mask.id, mask.ordinal] as const),
          ...existingCards.filter((card) => card.noteId === note.id && card.occlusionId && card.occlusionOrdinal).map((card) => [card.occlusionId!, card.occlusionOrdinal!] as const),
        ])
        const nextOrdinal = previous?.imageOcclusion?.nextOrdinal ?? 1
        if (note.imageOcclusion.nextOrdinal < nextOrdinal) throw new ImportedPackageRejected(`Note ${note.id}`, 'would renumber image occlusion masks backwards')
        for (const mask of note.imageOcclusion.masks) {
          const prior = priorOrdinals.get(mask.id)
          if ((prior !== undefined && prior !== mask.ordinal) || (prior === undefined && mask.ordinal < nextOrdinal)) {
            throw new ImportedPackageRejected(`Note ${note.id}`, 'would change or reuse an existing image occlusion mask ordinal')
          }
        }
      }
    }

    // Cards: a card belongs to a note, sits in that note's deck, and a note may
    // not generate the same template twice.
    const noteIds = new Set([...existingNotes.keys(), ...writes.notes.map(({ value }) => value.id)])
    const writtenNotes = new Map(writes.notes.map(({ value }) => [value.id, value]))
    for (const { value: card } of writes.cards) {
      if (!noteIds.has(card.noteId)) throw new ImportedPackageRejected(`Card ${card.id}`, 'names a note that does not exist')
      if (!deckIds.has(card.deckId)) throw new ImportedPackageRejected(`Card ${card.id}`, 'names a deck that does not exist')
      // A card may sit in a deck other than its note's: Anki's filtered decks
      // borrow a card without moving its note, and import restores such a card
      // to the deck it originally belonged to. So this is deliberately not a
      // check that the two agree.
    }

    // Reviews: a review must reach a card that reaches a note.
    const cardIds = new Set([...(await this.cards.toArray()).map(({ id }) => id), ...writes.cards.map(({ value }) => value.id)])
    for (const review of [...writes.reviews, ...writes.updatedReviews]) {
      if (!cardIds.has(review.cardId)) throw new ImportedPackageRejected(`Review ${review.id}`, 'names a card that does not exist')
      if (Number.isInteger(review.rating) && (review.rating < 1 || review.rating > 4)) throw new ImportedPackageRejected(`Review ${review.id}`, 'records an unsupported rating')
    }

    // Media references: a reference must belong to a note, and an occlusion
    // source must be an image the app can actually render.
    const digests = new Set([...(await this.mediaBlobs.toArray()).map(({ digest }) => digest), ...writes.blobs.map(({ digest }) => digest)])
    for (const { value: reference } of writes.references) {
      if (!noteIds.has(reference.noteId)) throw new ImportedPackageRejected(`Media reference ${reference.id}`, 'names a note that does not exist')
      if (!/^[a-f0-9]{64}$/.test(reference.digest)) throw new ImportedPackageRejected(`Media reference ${reference.id}`, 'has a malformed content digest')
      if (!digests.has(reference.digest)) throw new ImportedPackageRejected(`Media reference ${reference.id}`, 'names media the package did not carry')
      const note = writtenNotes.get(reference.noteId) ?? existingNotes.get(reference.noteId)
      if (note?.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID && reference.id === note.imageOcclusion?.sourceMediaId) {
        if (reference.kind !== 'image' || !SUPPORTED_MEDIA_TYPES.some(({ mimeType }) => mimeType === reference.mimeType)) {
          throw new ImportedPackageRejected(`Media reference ${reference.id}`, 'is not a supported image occlusion source')
        }
        if (reference.side !== 'front') throw new ImportedPackageRejected(`Media reference ${reference.id}`, 'is an occlusion source on the wrong side')
      }
    }
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
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox, this.syncRevisions], async () => {
      if (!await this.deckOptionGroups.get(deck.optionGroupId)) throw new Error('Deck option group not found')
      await this.validateDeckHierarchy(deck)
      await this.decks.add(deck)
      await this.enqueueOperation({ opId: id(), entityType: 'deck', entityId: deck.id, action: 'create', occurredAt: deck.createdAt, payload: deck })
    })
    return deck
  }

  async renameDeck(deckId: string, name: string, now = new Date()): Promise<void> {
    await this.transaction('rw', this.decks, this.outbox, this.syncRevisions, async () => {
      const deck = await this.decks.get(deckId)
      if (!deck) throw new Error('Deck not found')
      const updated = { ...deck, name: requiredText(name, 'Deck name'), updatedAt: now.toISOString() }
      await this.validateDeckHierarchy(updated)
      await this.decks.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async moveDeck(deckId: string, parentId: string | null, now = new Date()): Promise<void> {
    await this.transaction('rw', this.decks, this.outbox, this.syncRevisions, async () => {
      const deck = await this.decks.get(deckId)
      if (!deck) throw new Error('Deck not found')
      const updated = { ...deck, parentId, updatedAt: now.toISOString() }
      await this.validateDeckHierarchy(updated)
      await this.decks.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async moveNote(noteId: string, destinationDeckId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.notes, this.cards, this.outbox, this.syncRevisions], async () => {
      const [note, destination] = await Promise.all([this.notes.get(noteId), this.decks.get(destinationDeckId)])
      if (!note) throw new Error('Note not found')
      if (!destination) throw new Error('Destination deck not found')
      if (note.deckId === destinationDeckId) return
      const occurredAt = now.toISOString()
      const updatedNote = { ...note, deckId: destinationDeckId, updatedAt: occurredAt }
      const cards = await this.cards.where('noteId').equals(noteId).toArray()
      const updatedCards = cards.map((card) => ({ ...card, deckId: destinationDeckId }))
      await this.notes.put(updatedNote)
      if (updatedCards.length) await this.cards.bulkPut(updatedCards)
      await this.enqueueOperations([
        { opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt, payload: updatedNote },
        ...updatedCards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'update' as const, occurredAt, payload: card })),
      ])
    })
  }

  async createDeckOptionGroup(name: string, now = new Date()): Promise<DeckOptionGroup> {
    const group: DeckOptionGroup = { id: id(), name: requiredText(name, 'Deck option group name'), protected: false, ...copiedDeckOptionSettings(defaultDeckOptionSettings), createdAt: now.toISOString(), updatedAt: now.toISOString() }
    await this.transaction('rw', this.deckOptionGroups, this.outbox, this.syncRevisions, async () => {
      await this.deckOptionGroups.add(group)
      await this.enqueueOperation({ opId: id(), entityType: 'deckOptionGroup', entityId: group.id, action: 'create', occurredAt: group.createdAt, payload: group })
    })
    return group
  }

  async renameDeckOptionGroup(groupId: string, name: string, now = new Date()): Promise<void> {
    await this.transaction('rw', this.deckOptionGroups, this.outbox, this.syncRevisions, async () => {
      const group = await this.deckOptionGroups.get(groupId)
      if (!group) throw new Error('Deck option group not found')
      if (group.protected) throw new Error('The Default deck option group is protected')
      const updated = { ...group, name: requiredText(name, 'Deck option group name'), updatedAt: now.toISOString() }
      await this.deckOptionGroups.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'deckOptionGroup', entityId: group.id, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async updateDeckOptionGroup(groupId: string, settings: DeckOptionSettings, now = new Date()): Promise<void> {
    await this.transaction('rw', this.deckOptionGroups, this.outbox, this.syncRevisions, async () => {
      const group = await this.deckOptionGroups.get(groupId)
      if (!group) throw new Error('Deck option group not found')
      const validated = validateDeckOptionSettings({ ...group, ...settings })
      const updated: DeckOptionGroup = { ...group, ...validated, updatedAt: now.toISOString() }
      await this.deckOptionGroups.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'deckOptionGroup', entityId: group.id, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async assignDeckOptionGroup(deckId: string, groupId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox, this.syncRevisions], async () => {
      const [deck, group] = await Promise.all([this.decks.get(deckId), this.deckOptionGroups.get(groupId)])
      if (!deck) throw new Error('Deck not found')
      if (!group) throw new Error('Deck option group not found')
      if (deck.optionGroupId === groupId) return
      const updated = { ...deck, optionGroupId: groupId, updatedAt: now.toISOString() }
      await this.decks.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'deck', entityId: deckId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async deleteDeckOptionGroup(groupId: string, replacementGroupId?: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.outbox, this.syncRevisions, this.deletedEntities], async () => {
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
      await this.enqueueOperations([
        ...updated.map((deck) => ({ opId: id(), entityType: 'deck' as const, entityId: deck.id, action: 'update' as const, occurredAt, payload: deck })),
        { opId: id(), entityType: 'deckOptionGroup', entityId: groupId, action: 'delete', occurredAt, payload: { id: groupId } },
      ])
    })
  }

  async deleteNote(noteId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.outbox, this.syncRevisions, this.deletedEntities, this.settings], async () => {
      const note = await this.notes.get(noteId)
      if (!note) throw new Error('Note not found')
      const noteType = await this.noteTypes.get(note.typeId)
      if (!noteType) throw new Error('Note type not found')
      const cards = await this.cards.where('noteId').equals(noteId).toArray()
      const cardIds = cards.map((card) => card.id)
      const reviews = cardIds.length ? await this.reviewEntries.where('cardId').anyOf(cardIds).toArray() : []
      const media = await this.noteMedia.where('noteId').equals(noteId).toArray()
      const occurredAt = now.toISOString()
      const operationId = id()
      const deletion: SyncOperation = { opId: operationId, entityType: 'note', entityId: noteId, action: 'delete', occurredAt, payload: { id: noteId } }
      const tombstones: DeletionTombstone[] = [
        { key: tombstoneKey('note', noteId), entityType: 'note', entityId: noteId, occurredAt },
        ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt })),
        ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt })),
        ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt })),
      ]
      await this.notes.delete(noteId)
      if (cardIds.length) {
        await this.cards.bulkDelete(cardIds)
        await this.reviewEntries.where('cardId').anyOf(cardIds).delete()
      }
      await this.noteMedia.where('noteId').equals(noteId).delete()
      await this.deletedEntities.bulkPut(await Promise.all(tombstones.map(target => this.deletionBarrier(target, deletion))))
      await this.enqueueOperation({ opId: operationId, entityType: 'note', entityId: noteId, action: 'delete', occurredAt, payload: { id: noteId } })
      const syncEpoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      await this.recordUndo({ kind: 'note-deletion', syncEpoch, operationIds: [operationId], occurredAt, note, noteType, cards, reviews, media })
    })
  }

  async latestNoteDeletionUndo(): Promise<NoteDeletionUndo | null> {
    const record = await this.pendingUndo()
    return record?.kind === 'note-deletion' ? record : null
  }

  async deleteDeck(deckId: string, options: DeleteDeckOptions, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.decks, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.outbox, this.syncRevisions, this.deletedEntities], async () => {
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
        const updatedNotes = notes.map((note) => ({ ...note, deckId: destination.id, updatedAt: occurredAt }))
        const updatedCards = cards.map((card) => ({ ...card, deckId: destination.id }))
        const updatedChildren = children.map((child) => ({ ...child, parentId: destination.id, updatedAt: occurredAt }))
        await Promise.all(updatedChildren.map((child) => this.validateDeckHierarchy(child)))
        if (updatedNotes.length) await this.notes.bulkPut(updatedNotes)
        if (updatedCards.length) await this.cards.bulkPut(updatedCards)
        if (updatedChildren.length) await this.decks.bulkPut(updatedChildren)
        await this.decks.delete(deckId)
        await this.deletedEntities.put({ key: tombstoneKey('deck', deckId), entityType: 'deck', entityId: deckId, occurredAt })
        await this.enqueueOperations([
          ...updatedChildren.map((child) => ({ opId: id(), entityType: 'deck' as const, entityId: child.id, action: 'update' as const, occurredAt, payload: child })),
          ...updatedNotes.map((note) => ({ opId: id(), entityType: 'note' as const, entityId: note.id, action: 'update' as const, occurredAt, payload: note })),
          ...updatedCards.map((card) => ({ opId: id(), entityType: 'card' as const, entityId: card.id, action: 'update' as const, occurredAt, payload: card })),
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
      const deletions: SyncOperation[] = subtree.sort((left, right) => Number(right.parentId !== null) - Number(left.parentId !== null)).map(item => ({ opId: id(), entityType: 'deck', entityId: item.id, action: 'delete', occurredAt, payload: { id: item.id } }))
      const sourceForDeck = (id: string) => deletions.find(operation => operation.entityId === id)!
      const targets: DeletionTombstone[] = [
        ...subtreeIds.map((id) => ({ key: tombstoneKey('deck', id), entityType: 'deck' as const, entityId: id, occurredAt })),
        ...notes.map((note) => ({ key: tombstoneKey('note', note.id), entityType: 'note' as const, entityId: note.id, occurredAt })),
        ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt })),
        ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt })),
        ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt })),
      ]
      const noteDecks = new Map(notes.map(note => [note.id, note.deckId]))
      const owners = new Map([
        ...subtreeIds.map(entityId => [tombstoneKey('deck', entityId), entityId] as const),
        ...notes.map(note => [tombstoneKey('note', note.id), note.deckId] as const),
        ...cards.map(card => [tombstoneKey('card', card.id), card.deckId] as const),
        ...reviews.map(review => [tombstoneKey('review', review.id), review.deckId] as const),
        ...media.map(reference => [tombstoneKey('noteMedia', reference.id), noteDecks.get(reference.noteId)!] as const),
      ])
      await this.deletedEntities.bulkPut(await Promise.all(targets.map(target => this.deletionBarrier(target, sourceForDeck(owners.get(target.key)!)))))
      await this.enqueueOperations(deletions)
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

    await this.transaction('rw', [this.decks, this.notes, this.cards, this.noteMedia, this.mediaBlobs, this.outbox, this.syncRevisions], async () => {
      if (!await this.decks.get(deckId)) throw new Error('Deck not found')
      await this.notes.add(note)
      await this.cards.add(card)
      if (references.length) await this.noteMedia.bulkAdd(references)
      if (blobs.length) await this.mediaBlobs.bulkPut(blobs)
      await this.enqueueOperations([
        { opId: id(), entityType: 'note', entityId: note.id, action: 'create', occurredAt: note.createdAt, payload: note },
        { opId: id(), entityType: 'card', entityId: card.id, action: 'create', occurredAt: note.createdAt, payload: card },
        ...references.map((reference) => ({ opId: id(), entityType: 'noteMedia' as const, entityId: reference.id, action: 'create' as const, occurredAt: reference.createdAt, payload: reference })),
      ])
    })
    return note
  }

  async updateBasicNote(noteId: string, fields: BasicNoteFields, now = new Date()): Promise<void> {
    await this.transaction('rw', this.notes, this.outbox, this.syncRevisions, async () => {
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
      await this.enqueueOperation({ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async updateNoteTags(noteId: string, tags: string[], now = new Date()): Promise<void> {
    const normalizedTags = normalizeTags(tags)
    await this.transaction('rw', [this.notes, this.outbox, this.syncRevisions], async () => {
      const note = await this.notes.get(noteId)
      if (!note) throw new Error('Note not found')
      const updated: Note = { ...note, tags: normalizedTags, updatedAt: now.toISOString() }
      await this.notes.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async attachMedia(noteId: string, { file, side, playback = 'manual' }: NoteMediaAttachment, now = new Date()): Promise<NoteMediaReference> {
    const [reference] = await this.attachMediaBatch(noteId, [{ file, side, playback }], now)
    return reference!
  }

  /** Applies native writeback fields while preserving the imported card schedule. */
  async updateNativeNoteContent(noteId: string, fields: Record<string, string>, tags: string[], now = new Date()): Promise<void> {
    const normalizedTags = normalizeTags(tags)
    await this.transaction('rw', [this.notes, this.outbox, this.syncRevisions], async () => {
      const note = await this.notes.get(noteId)
      if (!note) throw new Error('Note not found')
      const updated: Note = { ...note, fields: { ...fields }, tags: normalizedTags, updatedAt: now.toISOString() }
      await this.notes.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'note', entityId: noteId, action: 'update', occurredAt: updated.updatedAt, payload: updated })
    })
  }

  async attachMediaBatch(noteId: string, attachments: NoteMediaAttachment[], now = new Date()): Promise<NoteMediaReference[]> {
    if (!await this.notes.get(noteId)) throw new Error('Note not found')
    const references: NoteMediaReference[] = []
    const blobs: StoredMediaBlob[] = []
    for (const { file, side, playback = 'manual' } of attachments) {
      const definition = validateMedia(file)
      const digest = await digestMedia(file)
      references.push({ id: id(), noteId, digest, kind: definition.kind, mimeType: file.type, displayName: file.name, side, playback, createdAt: now.toISOString(), updatedAt: now.toISOString() })
      blobs.push({ digest, blob: await mediaBytes(file), byteLength: file.size, mimeType: file.type, verifiedAt: now.toISOString() })
    }
    if (!references.length) return references
    await this.transaction('rw', this.noteMedia, this.mediaBlobs, this.outbox, this.syncRevisions, async () => {
      await this.mediaBlobs.bulkPut(blobs)
      await this.noteMedia.bulkAdd(references)
      for (const reference of references) await this.enqueueOperation({ opId: id(), entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: reference.createdAt, payload: reference })
    })
    return references
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

  /** Evicts downloaded bytes while preserving references so sync can fetch them again. */
  async evictCachedMedia(digest: string): Promise<boolean> {
    return this.transaction('rw', [this.noteMedia, this.mediaBlobs], async () => {
      if (!await this.noteMedia.where('digest').equals(digest).count()) return false
      await this.mediaBlobs.delete(digest)
      return true
    })
  }

  /** Removes bytes after checking their content address inside the storage boundary. */
  async discardCorruptMediaBlob(digest: string): Promise<boolean> {
    const stored = await this.mediaBlobs.get(digest)
    if (!stored) return false
    const actualDigest = await digestMedia(stored.blob instanceof Blob ? stored.blob : new Blob([stored.blob], { type: stored.mimeType }))
    if (actualDigest === digest) return false
    await this.mediaBlobs.delete(digest)
    return true
  }

  async verifiedMediaBytes(digest: string): Promise<MediaBytes | undefined> {
    const stored = await this.mediaBlobs.get(digest)
    if (!stored) return undefined
    // Current writes persist byte buffers; no blob/resource read is required
    // when the reviewer starts after the browser goes offline.
    const bytes = stored.blob instanceof Blob ? await mediaBytes(stored.blob) : stored.blob
    return { digest: stored.digest, bytes, byteLength: stored.byteLength, mimeType: stored.mimeType, verifiedAt: stored.verifiedAt }
  }

  async storeDownloadedMedia(digest: string, blob: Blob, now = new Date()) {
    if (await digestMedia(blob) !== digest) throw new Error('Downloaded media did not match its content digest.')
    await this.mediaBlobs.put({ digest, blob: await mediaBytes(blob), byteLength: blob.size, mimeType: blob.type, verifiedAt: now.toISOString() })
  }

  async removeMedia(referenceId: string, now = new Date()) {
    await this.transaction('rw', this.notes, this.noteMedia, this.outbox, this.syncRevisions, this.deletedEntities, async () => {
      const reference = await this.noteMedia.get(referenceId)
      if (!reference) throw new Error('Media reference not found')
      const note = await this.notes.get(reference.noteId)
      if (note?.imageOcclusion?.sourceMediaId === referenceId) throw new Error('Cannot remove the source image from an image occlusion note')
      await this.noteMedia.delete(referenceId)
      await this.enqueueOperation({ opId: id(), entityType: 'noteMedia', entityId: referenceId, action: 'delete', occurredAt: now.toISOString(), payload: { id: referenceId, noteId: reference.noteId, digest: reference.digest } })
    })
  }

  async counts(deckId: string): Promise<DeckCounts> {
    return countsFor(await this.cards.where('deckId').equals(deckId).toArray())
  }

  async summaries(): Promise<DeckSummary[]> {
    return this.transaction('r', [this.settings, this.decks, this.notes, this.cards, this.reviewEntries], async () => {
      const sessionCards = await customStudyMembership(this)
      const [decks, notes, cards, reviews] = await Promise.all([
        this.decks.orderBy('createdAt').toArray(),
        this.notes.toArray(),
        this.cards.toArray(),
        this.reviewEntries.toArray(),
      ])
      const totals = new Map(decks.map((deck) => [deck.id, {
        counts: { new: 0, learning: 0, review: 0 }, noteCount: 0, reviewCount: 0, sessionCount: 0,
      }]))
      const decksById = new Map(decks.map((deck) => [deck.id, deck]))
      const children = new Map<string, string[]>()
      for (const deck of decks) if (deck.parentId && totals.has(deck.parentId)) {
        const siblings = children.get(deck.parentId)
        if (siblings) siblings.push(deck.id)
        else children.set(deck.parentId, [deck.id])
      }
      for (const note of notes) {
        const total = totals.get(note.deckId)
        if (total) total.noteCount += 1
      }
      for (const card of cards) {
        const total = totals.get(card.deckId)
        if (!total) continue
        addCardCount(total.counts, card)
        if (sessionCards.has(card.id)) total.sessionCount += 1
      }
      for (const review of reviews) {
        const total = totals.get(review.deckId)
        if (total) total.reviewCount += 1
      }

      // A single post-order traversal folds each Deck's local totals into its
      // parent, leaving each node with the same descendant totals as before.
      const postOrder: string[] = []
      const visited = new Set<string>()
      for (const deck of decks) {
        const stack: Array<[string, boolean]> = [[deck.id, false]]
        while (stack.length) {
          const [id, expanded] = stack.pop()!
          if (expanded) {
            postOrder.push(id)
            continue
          }
          if (visited.has(id)) continue
          visited.add(id)
          stack.push([id, true])
          for (const childId of children.get(id) ?? []) stack.push([childId, false])
        }
      }
      for (const id of postOrder) {
        const deck = decksById.get(id)!
        const parent = deck.parentId ? totals.get(deck.parentId) : undefined
        const total = totals.get(id)!
        if (parent) {
          parent.counts.new += total.counts.new
          parent.counts.learning += total.counts.learning
          parent.counts.review += total.counts.review
          parent.noteCount += total.noteCount
          parent.reviewCount += total.reviewCount
          parent.sessionCount += total.sessionCount
        }
      }
      return decks.map((deck) => ({ ...deck, ...totals.get(deck.id)! }))
    })
  }

  async dueCards(deckId: string, now = new Date()): Promise<CardRecord[]> {
    return this.transaction('r', [this.decks, this.deckOptionGroups, this.notes, this.cards, this.reviewEntries, this.settings], async () => {
      const sessionCards = await customStudyMembership(this)
      const subtree = await this.deckSubtree(deckId)
      if (!subtree.length) return []
      const deckIds = subtree.map((deck) => deck.id)
      const [cards, notes, groups, reviewEntries] = await Promise.all([
        this.cards.where('deckId').anyOf(deckIds).toArray(),
        this.notes.where('deckId').anyOf(deckIds).toArray(),
        this.deckOptionGroups.toArray(),
        this.reviewEntries.toArray(),
      ])
      return selectDueCards({ deckId, now, decks: subtree, groups, notes, cards, reviews: reviewEntries, sessionCardIds: new Set(sessionCards.keys()) })
    })
  }

  /** Eligibility for every rating is decided by the scheduler module. An
   * ineligible card resolves to no choices without consulting its deck policy,
   * so a card whose deck has since lost its option group cannot turn the
   * reviewer's poll into an error. */
  async reviewChoices(cardId: string, now = new Date(), allowEarly = false): Promise<ReviewChoice[]> {
    const card = await this.cards.get(cardId)
    if (!card || !(allowEarly ? eligibleForQueue(card, now) : eligibleForStudy(card, now))) return []
    const deck = await this.decks.get(card.deckId)
    const group = deck ? await this.deckOptionGroups.get(deck.optionGroupId) : undefined
    if (!deck || !group) throw new Error('Deck option group not found')
    return previewReviewChoices(card, group, now, allowEarly)
  }

  /** The renderable queue shared by the reviewer and today's workload. */
  async reviewQueue(deckId: string, now = new Date()): Promise<CardRecord[]> {
    return this.transaction('r', [this.decks, this.deckOptionGroups, this.cards, this.notes, this.noteTypes, this.reviewEntries, this.settings], async () => {
      const scheduled = await this.dueCards(deckId, now)
      const [notes, types, stored] = await Promise.all([
        this.notes.bulkGet(scheduled.map((card) => card.noteId)), this.noteTypes.toArray(), this.cards.bulkGet(scheduled.map((card) => card.id)),
      ])
      const notesById = new Map(notes.filter((note): note is Note => Boolean(note)).map((note) => [note.id, note]))
      const typesById = new Map(types.map((type) => [type.id, type]))
      return stored.filter((card): card is CardRecord => Boolean(card)).filter((card) => {
        const note = notesById.get(card.noteId)
        const type = note && typesById.get(note.typeId)
        const template = type?.templates.find((candidate) => candidate.id === card.templateId)
        if (!note || !type || !template || !eligibleForStudy(card, now)) return false
        if (type.kind === 'image-occlusion') return true
        const front = tryRenderNoteTemplate(template.front, type, note.fields, undefined, card.clozeOrdinal, 'front')
        return !front.ok || !front.value.isEmpty
      })
    })
  }

  async answer(cardId: string, rating: Grade, now = new Date(), durationMs?: number, options?: { allowEarly: boolean; reschedule: boolean }): Promise<ReviewEntry> {
    return this.transaction('rw', [this.decks, this.deckOptionGroups, this.notes, this.cards, this.reviewEntries, this.outbox, this.syncRevisions, this.settings], async () => {
      const existing = await this.cards.get(cardId)
      if (!existing) throw new Error('Card not found')
      if (!eligibleForQueue(existing, now)) throw new Error('Card is unavailable because it is suspended or buried')
      if (!options?.allowEarly && !eligibleForStudy(existing, now)) throw new Error('Card is not due')
      const deck = await this.decks.get(existing.deckId)
      const group = deck ? await this.deckOptionGroups.get(deck.optionGroupId) : undefined
      if (!deck || !group) throw new Error('Deck option group not found')
      const scheduled = answerWithSchedule(existing, group, rating, now, id())
      let card = withPolicyDefaults(scheduled.card)
      const review = scheduled.review
      if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) review.durationMs = Math.round(Math.min(60_000, durationMs))
      if (options?.reschedule === false) {
        Object.assign(review, { rescheduled: false, due: existing.due, stability: existing.stability, difficulty: existing.difficulty, elapsedDays: existing.elapsedDays, scheduledDays: existing.scheduledDays, learningSteps: existing.learningSteps, afterState: existing.state, afterDue: existing.due, afterStability: existing.stability, afterDifficulty: existing.difficulty, afterElapsedDays: existing.elapsedDays, afterScheduledDays: existing.scheduledDays, afterLearningSteps: existing.learningSteps })
        await this.reviewEntries.add(review)
        const operation: SyncOperation = { opId: id(), entityType: 'review', entityId: review.id, action: 'create', occurredAt: review.reviewedAt, payload: review }
        await this.enqueueOperation(operation)
        const syncEpoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
        await this.recordUndo({ kind: 'review', review, syncEpoch, operationIds: [operation.opId], cards: [{ before: existing, after: existing }] })
        return review
      }
      const operations: SyncOperation[] = []
      const changedCards: ReviewUndo['cards'] = []
      let changedNote: ReviewUndo['note']
      const note = await this.notes.get(card.noteId)
      if (!note) throw new Error('Card note not found')
      if (card.lapses >= group.leechThreshold) {
        const tags = normalizeTags([...(note.tags ?? []), group.leechTag])
        if (tags.length !== (note.tags ?? []).length || tags.some((tag, index) => tag !== note.tags?.[index])) {
          const revisedNote = { ...note, tags, updatedAt: review.reviewedAt }
          await this.notes.put(revisedNote)
          changedNote = { before: note, after: revisedNote }
          operations.push({ opId: id(), entityType: 'note', entityId: note.id, action: 'update', occurredAt: review.reviewedAt, payload: revisedNote })
        }
        if (group.leechAction === 'suspend') card = { ...card, manualSuspended: true }
      }
      Object.assign(review, { afterState: card.state, afterDue: card.due, afterStability: card.stability, afterDifficulty: card.difficulty, afterElapsedDays: card.elapsedDays, afterScheduledDays: card.scheduledDays, afterLearningSteps: card.learningSteps })
      const buriedUntil = nextStudyBoundary(now).toISOString()
      const siblings = await this.cards.where('noteId').equals(card.noteId).toArray()
      for (const sibling of siblings) {
        if (sibling.id === card.id || isBuried(sibling, now)) continue
        if (queueGatherPriority(sibling) < queueGatherPriority(existing)) continue
        const bury = sibling.state === State.New
          ? group.buryNewSiblings
          : sibling.state === State.Review
            ? group.buryReviewSiblings
            : isInterdayLearning(sibling) && group.buryInterdayLearningSiblings
        if (!bury) continue
        const revised = withPolicyDefaults({ ...sibling, buriedUntil })
        await this.cards.put(revised)
        changedCards.push({ before: sibling, after: revised })
        operations.push({ opId: id(), entityType: 'card', entityId: revised.id, action: 'update', occurredAt: review.reviewedAt, payload: revised })
      }
      await this.cards.put(card)
      changedCards.push({ before: existing, after: card })
      await this.reviewEntries.add(review)
      const outbound: SyncOperation[] = [
        { opId: id(), entityType: 'card', entityId: card.id, action: 'update', occurredAt: review.reviewedAt, payload: card, reviewId: review.id },
        { opId: id(), entityType: 'review', entityId: review.id, action: 'create', occurredAt: review.reviewedAt, payload: review },
        ...operations,
      ]
      await this.enqueueOperations(outbound)
      const syncEpoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      await this.recordUndo({ kind: 'review', review, syncEpoch, operationIds: outbound.map((operation) => operation.opId), cards: changedCards, ...(changedNote ? { note: changedNote } : {}) })
      return review
    })
  }

  /** The single undo slot. Exactly one record exists at a time, so the learner
   * is offered one undo rather than three competing ones. */
  private async recordUndo(record: UndoRecord): Promise<void> {
    await this.settings.put({ key: UNDO_KEY, value: record })
  }

  /** Replaces the stored record, so a bulk deletion cannot leave an undo behind
   * that would restore only part of what was removed. */
  private async clearUndo(): Promise<void> {
    await this.settings.delete(UNDO_KEY)
  }

  private async readUndo(): Promise<UndoRecord | null> {
    return ((await this.settings.get(UNDO_KEY))?.value as UndoRecord | undefined) ?? null
  }

  /**
   * What can be undone right now, or null when the last action is no longer
   * undoable. This is the whole of the public undo read surface: one call, one
   * discriminated record, no protocol knowledge required of the caller.
   */
  async pendingUndo(): Promise<UndoRecord | null> {
    const record = await this.readUndo()
    if (!record) return null
    const epoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
    const guards = {
      epochMatches: undoEpochMatches(epoch, record),
      operationsPending: await undoOperationsPending(async (operationId) => Boolean(await this.outbox.get(operationId)), record),
      rowsUnchanged: await this.undoRowsUnchanged(record),
    }
    return undoBlocker(guards) === null ? record : null
  }

  /**
   * Drops the pending undo.
   *
   * A bulk deletion records one undo per item, so only the last would survive -
   * and pressing it would restore a fraction of what was removed, which reads as
   * a bug. Bulk maintenance calls this so no undo is offered at all.
   */
  async clearPendingUndo(): Promise<void> {
    await this.clearUndo()
  }

  /**
   * Attaches context to the pending undo without replacing it.
   *
   * Custom Study records which session an answer came from so the session can be
   * rolled back with the answer. It used to read the undo and write it back into
   * the Collection's private settings key, which is how a record could be
   * reshaped behind the seam.
   */
  async attachUndoContext(customSession: { before: CustomStudySession; after: CustomStudySession }): Promise<void> {
    await this.transaction('rw', this.settings, async () => {
      const record = await this.readUndo()
      if (!record || record.kind !== 'review') return
      await this.recordUndo({ ...record, customSession })
    })
  }

  /**
   * Whether every row this record depends on still holds the value it captured.
   * Returns the specific reason rather than a bare false, so a refusal can say
   * what changed instead of a generic "unavailable".
   */
  private async undoRowsUnchanged(record: UndoRecord): Promise<UndoRowBlocker | null> {
    if (record.kind === 'review') {
      if (record.customSession && !undoRowUnchanged((await customStudySessions(this)).find((session) => session.id === record.customSession!.after.id), record.customSession.after)) return 'changed'
      const cards = await this.cards.bulkGet(record.cards.map(({ after }) => after.id))
      if (cards.some((card, index) => !undoRowUnchanged(card, record.cards[index].after))) return 'changed'
      if (record.note && !undoRowUnchanged(await this.notes.get(record.note.after.id), record.note.after)) return 'changed'
      return undoRowUnchanged(await this.reviewEntries.get(record.review.id), record.review) ? null : 'changed'
    }
    if (record.kind === 'note-deletion') {
      if (!await this.decks.get(record.note.deckId) || !await this.noteTypes.get(record.note.typeId)) return 'original-deck-or-type-gone'
      if (!undoRowUnchanged(await this.noteTypes.get(record.note.typeId), record.noteType)) return 'note-type-changed'
      if (await this.notes.get(record.note.id)) return 'changed'
      return (await this.cards.bulkGet(record.cards.map((card) => card.id))).every((card) => !card) ? null : 'changed'
    }
    return undoRowUnchanged(await this.cards.get(record.after.id), record.after) ? null : 'changed'
  }

  /**
   * Undoes the last action and returns what it affected. Rejects when the
   * action is no longer undoable, with the reason the guards give.
   */
  async undo(): Promise<string> {
    return this.transaction('rw', [this.settings, this.cards, this.notes, this.noteTypes, this.decks, this.reviewEntries, this.noteMedia, this.outbox, this.syncRevisions, this.deletedEntities], async () => {
      const record = await this.readUndo()
      if (!record) throw new Error('There is nothing to undo.')
      const epoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      const rows = await this.undoRowsUnchanged(record)
      const blocker = undoBlocker({
        epochMatches: undoEpochMatches(epoch, record),
        operationsPending: await undoOperationsPending(async (operationId) => Boolean(await this.outbox.get(operationId)), record),
        rowsUnchanged: rows,
      })
      if (blocker) throw new Error(undoRefusal(record, blocker, rows))
      const subject = undoSubject(record)
      const ids = undoOperationIds(record)
      if (record.kind === 'review') {
        const sessions = record.customSession ? await customStudySessions(this) : []
        await this.cards.bulkPut(record.cards.map(({ before }) => before))
        if (record.note) await this.notes.put(record.note.before)
        await this.reviewEntries.delete(record.review.id)
        if (record.customSession) await this.settings.put({ key: customStudyKey, value: sessions.map((session) => session.id === record.customSession!.after.id ? record.customSession!.before : session) })
      } else if (record.kind === 'note-deletion') {
        const keys = [tombstoneKey('note', record.note.id), ...record.cards.map((card) => tombstoneKey('card', card.id)), ...record.reviews.map((review) => tombstoneKey('review', review.id)), ...record.media.map((reference) => tombstoneKey('noteMedia', reference.id))]
        const tombstones = await this.deletedEntities.bulkGet(keys)
        if (tombstones.some((tombstone) => tombstone?.occurredAt !== record.occurredAt)) throw new Error('The deleted note changed; undo is unavailable')
        if ((await this.cards.bulkGet(record.cards.map((card) => card.id))).some(Boolean) || (await this.reviewEntries.bulkGet(record.reviews.map((review) => review.id))).some(Boolean) || (await this.noteMedia.bulkGet(record.media.map((reference) => reference.id))).some(Boolean)) throw new Error('The deleted note changed; undo is unavailable')
        await this.notes.add(record.note)
        if (record.cards.length) await this.cards.bulkAdd(record.cards)
        if (record.reviews.length) await this.reviewEntries.bulkAdd(record.reviews)
        if (record.media.length) await this.noteMedia.bulkAdd(record.media)
        await this.deletedEntities.bulkDelete(keys)
      } else {
        await this.cards.put(record.before)
      }
      await this.outbox.bulkDelete(ids)
      await this.syncRevisions.bulkDelete(ids)
      await this.clearUndo()
      return subject
    })
  }

  async latestReviewUndo(): Promise<ReviewUndo | null> {
    const record = await this.pendingUndo()
    return record?.kind === 'review' ? record : null
  }

  async beginSyncAttempt(): Promise<void> {
    await this.transaction('rw', this.settings, async () => {
      const epoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      await this.settings.put({ key: 'syncEpoch', value: epoch + 1 })
    })
  }

  async suspendCard(cardId: string, now = new Date()): Promise<void> {
    await this.updateCardWithUndo(cardId, 'suspend', now, (card) => card.manualSuspended ? null : withPolicyDefaults({ ...card, manualSuspended: true }))
  }

  async unsuspendCard(cardId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.cards, this.outbox, this.syncRevisions], async () => {
      const card = await this.cards.get(cardId)
      if (!card) throw new Error('Card not found')
      if (!card.manualSuspended) return
      const updated = withPolicyDefaults({ ...card, manualSuspended: false })
      await this.cards.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'card', entityId: cardId, action: 'update', occurredAt: now.toISOString(), payload: updated })
    })
  }

  async buryCard(cardId: string, now = new Date()): Promise<void> {
    const buriedUntil = nextStudyBoundary(now).toISOString()
    await this.updateCardWithUndo(cardId, 'bury', now, (card) => card.buriedUntil === buriedUntil ? null : withPolicyDefaults({ ...card, buriedUntil }))
  }

  async unburyCard(cardId: string, now = new Date()): Promise<void> {
    await this.transaction('rw', [this.cards, this.outbox, this.syncRevisions], async () => {
      const card = await this.cards.get(cardId)
      if (!card) throw new Error('Card not found')
      if (card.buriedUntil === null || card.buriedUntil === undefined) return
      const updated = withPolicyDefaults({ ...card, buriedUntil: null })
      await this.cards.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'card', entityId: cardId, action: 'update', occurredAt: now.toISOString(), payload: updated })
    })
  }

  async rescheduleCard(cardId: string, due: Date, now = new Date()): Promise<void> {
    if (Number.isNaN(due.getTime())) throw new Error('Reschedule time is invalid')
    await this.updateCardSchedule(cardId, { due: due.toISOString() }, now, true)
  }

  /** Applies a validated scheduler result and journals it as one Collection operation. */
  async updateCardSchedule(cardId: string, schedule: CardScheduleUpdate, now = new Date(), graduateNewCard = false): Promise<void> {
    if (schedule.due !== undefined && (Number.isNaN(new Date(schedule.due).getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(schedule.due))) throw new Error('Card due time is invalid')
    for (const field of ['stability', 'difficulty'] as const) if (schedule[field] !== undefined && (!Number.isFinite(schedule[field]) || schedule[field]! < 0)) throw new Error(`Card ${field} is invalid`)
    for (const field of ['elapsedDays', 'scheduledDays', 'learningSteps', 'reps', 'lapses'] as const) if (schedule[field] !== undefined && (!Number.isSafeInteger(schedule[field]) || schedule[field]! < 0)) throw new Error(`Card ${field} is invalid`)
    if (schedule.lastReview !== undefined && schedule.lastReview !== null && Number.isNaN(new Date(schedule.lastReview).getTime())) throw new Error('Card last review time is invalid')
    await this.transaction('rw', [this.cards, this.outbox, this.syncRevisions], async () => {
      const card = await this.cards.get(cardId)
      if (!card) throw new Error('Card not found')
      const state = schedule.state ?? (graduateNewCard && card.state === State.New ? State.Review : card.state)
      if (state !== State.New && state !== State.Learning && state !== State.Relearning && state !== State.Review) throw new Error('Card state is invalid')
      const updated = canonicalCard({ ...card, ...schedule, state })
      await this.cards.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'card', entityId: cardId, action: 'update', occurredAt: now.toISOString(), payload: updated })
    })
  }

  async setCardFlag(cardId: string, flag: number, now = new Date()): Promise<void> {
    if (!Number.isSafeInteger(flag) || flag < 0 || flag > 7) throw new Error('Card flag is invalid')
    await this.updateCardWithUndo(cardId, 'flag', now, (card) => (card.flag ?? 0) === flag ? null : withPolicyDefaults({ ...card, flag }))
  }

  private async updateCardWithUndo(cardId: string, action: CardMaintenanceUndo['action'], now: Date, update: (card: CardRecord) => CardRecord | null): Promise<void> {
    await this.transaction('rw', [this.cards, this.outbox, this.syncRevisions, this.settings], async () => {
      const card = await this.cards.get(cardId)
      if (!card) throw new Error('Card not found')
      const updated = update(card)
      if (!updated) return
      await this.cards.put(updated)
      const operationId = id()
      await this.enqueueOperation({ opId: operationId, entityType: 'card', entityId: cardId, action: 'update', occurredAt: now.toISOString(), payload: updated })
      const syncEpoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      await this.recordUndo({ kind: 'card-maintenance', syncEpoch, operationIds: [operationId], action, before: card, after: updated })
    })
  }

  async latestCardMaintenanceUndo(): Promise<CardMaintenanceUndo | null> {
    const record = await this.pendingUndo()
    return record?.kind === 'card-maintenance' ? record : null
  }

  async pendingOperations(): Promise<SyncOperation[]> {
    return this.outbox.orderBy('occurredAt').toArray()
  }

  private async entityLifetime(ref: { entityType: EntityType; entityId: string }) {
    const history = await this.syncRevisions.where('key').equals(tombstoneKey(ref.entityType, ref.entityId)).toArray()
    return currentLifetime(history)
  }

  private async deletionBarrier(target: { entityType: EntityType; entityId: string }, source: SyncOperation, occurredAt = source.occurredAt): Promise<DeletionTombstone> {
    return { ...target, key: tombstoneKey(target.entityType, target.entityId), occurredAt, causes: [{ source: { entityType: source.entityType, entityId: source.entityId }, opId: source.opId, deletedLifetime: await this.entityLifetime(target) }] }
  }

  async enqueueOperation(operation: SyncOperation) {
    const key = tombstoneKey(operation.entityType, operation.entityId)
    const history = await this.syncRevisions.where('key').equals(key).toArray()
    if (!operation.parents && this.mergeSyncRevisions(operation.entityType, history).conflicts.length) throw new Error('Resolve the retained sync conflict before editing this record.')
    const payload = operation.action === 'delete' ? this.mergeSyncRevisions(operation.entityType, history).value : operation.payload
    const relatedLifetimes = operation.relatedLifetimes ?? await Promise.all(relatedEntities(operation.entityType, payload).map(async (ref) => ({ ...ref, lifetime: await this.entityLifetime(ref) })))
    const revision = { ...operation, lifetime: operation.lifetime ?? await this.entityLifetime(operation), relatedLifetimes, parents: operation.parents ?? revisionHeads(history) }
    if (operation.action === 'delete') await this.deletedEntities.put(await this.deletionBarrier(operation, revision))
    await this.syncRevisions.add({ ...revision, key })
    return this.outbox.add(revision)
  }

  async enqueueOperations(operations: SyncOperation[]) {
    for (const operation of operations) await this.enqueueOperation(operation)
  }

  private mergeSyncRevisions(entityType: SyncOperation['entityType'], revisions: SyncOperation[]) {
    const lifetime = currentLifetime(revisions)
    if (entityType !== 'card') return mergeRevisions(revisions, lifetime)
    const scheduling = ['due', 'stability', 'difficulty', 'elapsedDays', 'scheduledDays', 'reps', 'lapses', 'state', 'lastReview', 'learningSteps']
    const projected = new Map<string, SyncOperation>()
    const project = (revision: SyncOperation): SyncOperation => {
      const prior = projected.get(revision.opId)
      if (prior) return prior
      const payload = { ...revision.payload as Record<string, unknown> }
      const schedule = Object.fromEntries(scheduling.map((field) => [field, payload[field]]))
      for (const field of scheduling) delete payload[field]
      payload.$schedule = schedule
      // Reviews are append-only domain events. Their card snapshots carry policy
      // changes, while chronological replay owns the resulting FSRS schedule.
      if (revision.reviewId) {
        const parent = revisions.find((candidate) => (revision.parents ?? []).includes(candidate.opId))
        if (parent) payload.$schedule = (project(parent).payload as Record<string, unknown>).$schedule
      }
      const result = { ...revision, payload }
      projected.set(revision.opId, result)
      return result
    }
    revisionHeads(revisions) // Reject cycles before recursively projecting parents.
    const stripped = revisions.map(project)
    const merged = mergeRevisions(stripped, lifetime)
    const value = { ...merged.value as Record<string, unknown> }
    Object.assign(value, value.$schedule)
    delete value.$schedule
    return { ...merged, value, versions: merged.heads.map((opId) => {
      const revision = revisions.find((revision) => revision.opId === opId)!
      return { opId, value: revision.action === 'delete' ? null : revision.payload }
    }) }
  }

  async resolveSyncConflict(key: string, headId: string, expectedHeads: string[], now = new Date()) {
    const conflict = await this.syncConflicts.get(key)
    if (!conflict || JSON.stringify(conflict.heads) !== JSON.stringify(expectedHeads)) throw new Error('This conflict changed. Review its current versions before choosing.')
    const chosen = conflict.versions.find((version) => version.opId === headId)
    if (!chosen) throw new Error('Conflict version was not found')
    if (conflict.deleted && chosen.value !== null) throw new Error('Deleted records cannot be restored by a stale conflict choice. Copy the retained content into a new note.')
    let resolved = structuredClone(conflict.value)
    for (const conflicted of conflict.deleted ? [] : conflict.conflicts) {
      if (conflicted === '$') { resolved = structuredClone(chosen.value); break }
      if (conflicted === '$deleted') continue
      const path = conflicted.replace(/^\$schedule\./, '').split('.')
      let target = resolved as Record<string, unknown>
      let source = chosen.value as Record<string, unknown>
      for (const part of path.slice(0, -1)) {
        target = target[part] as Record<string, unknown>
        source = source[part] as Record<string, unknown>
      }
      target[path.at(-1)!] = structuredClone(source[path.at(-1)!])
    }
    const operation: SyncOperation = { opId: id(), entityType: conflict.entityType, entityId: conflict.entityId, action: conflict.deleted ? 'delete' : 'update', occurredAt: now.toISOString(), payload: conflict.deleted ? { id: conflict.entityId } : resolved, parents: expectedHeads }
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.receivedOperations, this.settings, this.deletedEntities, this.syncRevisions, this.syncConflicts, this.outbox], async () => {
      const current = await this.syncConflicts.get(key)
      if (!current || JSON.stringify(current.heads) !== JSON.stringify(expectedHeads)) throw new Error('This conflict changed. Review its current versions before choosing.')
      await this.enqueueOperation(operation)
      await this.applyRemoteChanges([operation], (await this.syncSettings())?.cursor ?? 0)
    })
  }

  async captureSyncOperations(limit?: number): Promise<SyncOperation[]> {
    return this.transaction('rw', [this.outbox, this.syncRevisions, this.settings], async () => {
      // Reviews can be recorded while preflight or media upload is running.
      // Invalidate their undo in the same transaction that captures the batch.
      const epoch = (await this.settings.get('syncEpoch'))?.value as number | undefined ?? 0
      await this.settings.put({ key: 'syncEpoch', value: epoch + 1 })
      const pending = await this.outbox.orderBy('occurredAt').toArray()
      if (limit === undefined) return pending

      // A page boundary must never split a local revision from its unsent
      // parent. Topological selection yields every ready ancestor first, even
      // when timestamps and operation IDs would otherwise sort a child first.
      const pendingIds = new Set(pending.map((operation) => operation.opId))
      const byId = new Map(pending.map((operation) => [operation.opId, operation]))
      const waitingFor = new Map<string, number>()
      const childrenByParent = new Map<string, string[]>()
      const ready: SyncOperation[] = []
      for (const operation of pending) {
        const unsentParents = [...new Set(operation.parents ?? [])].filter((parentId) => pendingIds.has(parentId))
        waitingFor.set(operation.opId, unsentParents.length)
        if (!unsentParents.length) ready.push(operation)
        for (const parentId of unsentParents) {
          let children = childrenByParent.get(parentId)
          if (!children) { children = []; childrenByParent.set(parentId, children) }
          children.push(operation.opId)
        }
      }

      const selected: SyncOperation[] = []
      for (let index = 0; index < ready.length && selected.length < limit; index += 1) {
        const operation = ready[index]
        selected.push(operation)
        for (const childId of childrenByParent.get(operation.opId) ?? []) {
          const remaining = waitingFor.get(childId)! - 1
          waitingFor.set(childId, remaining)
          if (remaining === 0) ready.push(byId.get(childId)!)
        }
      }
      return selected
    })
  }

  async acknowledgeOperations(opIds: string[]) {
    await this.outbox.bulkDelete(opIds)
  }

  async configureSync(settings: SyncSettings) {
    let endpoint: URL
    try { endpoint = new URL(settings.endpoint) } catch { throw new Error('Sync endpoint must be a valid URL.') }
    if (!['https:', 'http:'].includes(endpoint.protocol) || !settings.token.trim() || !Number.isSafeInteger(settings.cursor) || settings.cursor < 0) throw new Error('Sync configuration is invalid.')
    await this.settings.put({ key: 'sync', value: settings })
  }

  /** Removes the paired-device configuration when the learner disconnects it. */
  async clearSyncConfiguration() {
    await this.settings.delete('sync')
  }

  async syncSettings(): Promise<SyncSettings | undefined> {
    return (await this.settings.get('sync'))?.value as SyncSettings | undefined
  }

  /** Persists validated custom-study membership as one settings update. */
  async replaceCustomStudySessions(sessions: CustomStudySession[]) {
    if (!Array.isArray(sessions) || sessions.length > 100) throw new Error('Custom study session list is invalid.')
    const ids = new Set<string>(), names = new Set<string>()
    for (const session of sessions) {
      const name = session.name.trim().toLocaleLowerCase()
      if (!session.id.trim() || !name || name.length > 100 || session.search.length > 4000 || !Number.isInteger(session.limit) || session.limit < 1 || session.limit > 5000 || !['due', 'added', 'random', 'forgotten'].includes(session.order) || typeof session.reschedule !== 'boolean' || !Array.isArray(session.cardIds) || !Array.isArray(session.completed) || Number.isNaN(Date.parse(session.createdAt))) throw new Error('Custom study session is invalid.')
      if (ids.has(session.id) || names.has(name) || new Set(session.cardIds).size !== session.cardIds.length || session.cardIds.some((cardId) => typeof cardId !== 'string' || !cardId.trim()) || session.completed.some((entry) => !entry.cardId?.trim() || !entry.reviewId?.trim())) throw new Error('Custom study session identities are invalid.')
      ids.add(session.id); names.add(name)
    }
    await this.transaction('rw', this.settings, () => this.settings.put({ key: customStudyKey, value: structuredClone(sessions) }))
  }

  /** Records the native Anki card identity used when writing a portable package. */
  async assignAnkiCardIdentity(cardId: string, ankiId: number, now = new Date()): Promise<void> {
    if (!Number.isSafeInteger(ankiId) || ankiId <= 0) throw new Error('Anki card identity must be a positive safe integer')
    await this.transaction('rw', [this.cards, this.outbox, this.syncRevisions], async () => {
      const card = await this.cards.get(cardId)
      if (!card) throw new Error('Card not found')
      const owner = (await this.cards.toArray()).find((candidate) => candidate.ankiId === ankiId)
      if (owner && owner.id !== cardId) throw new Error('Anki card identity is already assigned')
      const updated = { ...card, ankiId }
      await this.cards.put(updated)
      await this.enqueueOperation({ opId: id(), entityType: 'card', entityId: cardId, action: 'update', occurredAt: now.toISOString(), payload: updated })
    })
  }

  async recordVerifiedPcBackup(receipt: VerifiedPcBackupReceipt) {
    if (!isVerifiedPcBackupReceipt(receipt)) throw new Error('Verified PC backup receipt is invalid.')
    await this.settings.put({ key: 'lastVerifiedPcBackup', value: structuredClone(receipt) })
  }

  async lastVerifiedPcBackup(): Promise<VerifiedPcBackupReceipt | undefined> {
    const value = (await this.settings.get('lastVerifiedPcBackup'))?.value
    if (value === undefined) return undefined
    if (!isVerifiedPcBackupReceipt(value)) throw new Error('Saved PC backup verification receipt is invalid.')
    return value
  }

  async applyRemoteChanges(changes: SyncOperation[], cursor: number) {
    await this.transaction('rw', [this.decks, this.deckOptionGroups, this.noteTypes, this.notes, this.cards, this.reviewEntries, this.noteMedia, this.receivedOperations, this.settings, this.deletedEntities, this.syncRevisions, this.syncConflicts, this.pendingRemoteOperations], async () => {
      const affectedNoteIds = new Set<string>()
      const affectedTypeIds = new Set<string>()
      const reviewedCardIds = new Set<string>()
      // A parent-deck tombstone can suppress a historical note before its later media/card operations arrive.
      const suppressedNoteIds = new Set<string>()
      const suppressedCardIds = new Set<string>()
      // Resolve type and note changes before their cards, even when equal timestamps arrive in index order.
      let incoming = [...new Map([...(await this.pendingRemoteOperations.toArray()), ...changes].map(operation => [operation.opId, operation])).values()]
      while (incoming.length) {
        let progress = false
        for (const source of orderInboundChanges(incoming)) {
        const change = { ...source }
        const key = tombstoneKey(change.entityType, change.entityId)
        const previousRevision = await this.syncRevisions.get(change.opId)
        const pending = await this.pendingRemoteOperations.get(change.opId)
        const previous = previousRevision ?? pending
        if (previous && (JSON.stringify(previous.payload) !== JSON.stringify(change.payload) || previous.action !== change.action || previous.occurredAt !== change.occurredAt || JSON.stringify(previous.lifetime ?? []) !== JSON.stringify(change.lifetime ?? []) || JSON.stringify(previous.relatedLifetimes ?? []) !== JSON.stringify(change.relatedLifetimes ?? []) || JSON.stringify(previous.restoreOf ?? []) !== JSON.stringify(change.restoreOf ?? []) || (change.parents !== undefined && JSON.stringify(previous.parents ?? []) !== JSON.stringify(change.parents)))) throw new Error('Sync operation identity was reused with different content')
        if (await this.receivedOperations.get(change.opId)) { await this.pendingRemoteOperations.delete(change.opId); continue }
        const retained = await this.syncRevisions.toArray()
        const refs = change.relatedLifetimes ?? relatedEntities(change.entityType, change.payload).map(ref => ({ ...ref, lifetime: [] }))
        const identities = [change, ...refs]
        const histories = identities.map(ref => ({ ref, history: retained.filter(revision => revision.entityType === ref.entityType && revision.entityId === ref.entityId) }))
        const barriers = await this.deletedEntities.bulkGet(identities.map(ref => tombstoneKey(ref.entityType, ref.entityId)))
        const previousLifetimes = histories.flatMap(({ ref, history }) => history.flatMap(revision => (revision.restoreOf ?? []).map(cause => ({ entityType: ref.entityType, entityId: ref.entityId, lifetime: cause.deletedLifetime }))))
        const tables = { deck: this.decks, deckOptionGroup: this.deckOptionGroups, note: this.notes, card: this.cards, review: this.reviewEntries, noteMedia: this.noteMedia, noteType: this.noteTypes }
        const unavailable = (await Promise.all(refs.map(async ref => await tables[ref.entityType].get(ref.entityId) ? [] : [ref]))).flat()
        const decision = decideOperationLifetime(change, {
          current: currentLifetime(histories[0].history),
          related: histories.slice(1).map(({ ref, history }) => ({ entityType: ref.entityType, entityId: ref.entityId, lifetime: currentLifetime(history) })),
          causes: barriers[0]?.causes ?? [],
          previous: previousLifetimes,
          knownDeletions: new Map(retained.filter(revision => revision.action === 'delete').map(revision => [revision.opId, revision])),
          blocked: barriers.flatMap(barrier => barrier ? [barrier] : []),
          unavailable,
        })
        if (decision.state === 'pending') { await this.pendingRemoteOperations.put(change); continue }
        if (change.action === 'restore' && decision.state === 'apply') validateRestorationEvidence(change, change.restoreOf!, retained)
        if (!previousRevision) {
          const history = histories[0].history
          await this.syncRevisions.add({ ...change, parents: change.parents ?? revisionHeads(history), key })
        }
        progress = true
        await this.pendingRemoteOperations.delete(change.opId)
        if (decision.state === 'stale') {
          if (change.entityType === 'note') suppressedNoteIds.add(change.entityId)
          if (change.entityType === 'card') suppressedCardIds.add(change.entityId)
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.action === 'restore') await this.deletedEntities.delete(key)
        const history = await this.syncRevisions.where('key').equals(key).toArray()
        const merged = this.mergeSyncRevisions(change.entityType, history)
        if (merged.conflicts.length) await this.syncConflicts.put({ ...merged, key, entityType: change.entityType, entityId: change.entityId })
        else await this.syncConflicts.delete(key)
        if (merged.conflicts.length && change.action !== 'delete' && !merged.deleted) {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (merged.deleted && change.action !== 'delete') {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.action !== 'delete') change.payload = merged.value
        if (change.entityType === 'noteMedia') {
          const previous = await this.noteMedia.get(change.entityId)
          if (previous) affectedNoteIds.add(previous.noteId)
        }
        if (change.entityType === 'noteType' && [BASIC_NOTE_TYPE_ID, IMAGE_OCCLUSION_NOTE_TYPE_ID].includes(change.entityId)) {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.entityType === 'deckOptionGroup' && change.entityId === DEFAULT_DECK_OPTION_GROUP_ID && change.action === 'delete') {
          await this.receivedOperations.add({ opId: change.opId })
          continue
        }
        if (change.action !== 'delete') {
          const related = relatedEntityIds(change)
          const deleted = await Promise.all([
            this.deletedEntities.get(tombstoneKey(change.entityType, change.entityId)),
            related.deckId ? this.deletedEntities.get(tombstoneKey('deck', related.deckId)) : undefined,
            related.noteId ? this.deletedEntities.get(tombstoneKey('note', related.noteId)) : undefined,
            related.cardId ? this.deletedEntities.get(tombstoneKey('card', related.cardId)) : undefined,
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
            const incoming = canonicalDeckOptionGroup(change.payload as LegacyDeckOptionGroup)
            if (!incoming || incoming.id !== change.entityId || !requiredText(incoming.name, 'Deck option group name') || (incoming.id === DEFAULT_DECK_OPTION_GROUP_ID ? !incoming.protected : incoming.protected)) throw new Error('Synced deck option group is invalid')
            if (incoming.id === DEFAULT_DECK_OPTION_GROUP_ID && incoming.name !== defaultDeckOptionGroup.name) throw new Error('The Default deck option group identity cannot change')
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
            if (note && (deletedType || (noteType && !this.cardIsEligible(noteType, note, incoming))) && !templateSuspended(incoming)) {
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
          await this.deletedEntities.put(await this.deletionBarrier(change, change))
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
            await this.deletedEntities.bulkPut(await Promise.all([
              ...deckIds.map((id) => ({ key: tombstoneKey('deck', id), entityType: 'deck' as const, entityId: id, occurredAt: change.occurredAt })),
              ...notes.map((note) => ({ key: tombstoneKey('note', note.id), entityType: 'note' as const, entityId: note.id, occurredAt: change.occurredAt })),
              ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt: change.occurredAt })),
              ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt: change.occurredAt })),
              ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt: change.occurredAt })),
            ].map(target => this.deletionBarrier(target, change))))
            await this.decks.bulkDelete(deckIds)
            await this.notes.where('deckId').anyOf(deckIds).delete()
            await this.cards.where('deckId').anyOf(deckIds).delete()
            await this.reviewEntries.where('deckId').anyOf(deckIds).delete()
            if (noteIds.length) await this.noteMedia.where('noteId').anyOf(noteIds).delete()
          } else if (change.entityType === 'note') {
            const cards = await this.cards.where('noteId').equals(change.entityId).toArray()
            const cardIds = cards.map((card) => card.id)
            const reviews = cardIds.length ? await this.reviewEntries.where('cardId').anyOf(cardIds).toArray() : []
            const media = await this.noteMedia.where('noteId').equals(change.entityId).toArray()
            await this.deletedEntities.bulkPut(await Promise.all([
              ...cards.map((card) => ({ key: tombstoneKey('card', card.id), entityType: 'card' as const, entityId: card.id, occurredAt: change.occurredAt })),
              ...reviews.map((review) => ({ key: tombstoneKey('review', review.id), entityType: 'review' as const, entityId: review.id, occurredAt: change.occurredAt })),
              ...media.map((reference) => ({ key: tombstoneKey('noteMedia', reference.id), entityType: 'noteMedia' as const, entityId: reference.id, occurredAt: change.occurredAt })),
            ].map(target => this.deletionBarrier(target, change))))
            await this.notes.delete(change.entityId)
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
        else if (change.entityType === 'deckOptionGroup') {
          const incoming = canonicalDeckOptionGroup(change.payload as LegacyDeckOptionGroup)
          if (incoming.id === DEFAULT_DECK_OPTION_GROUP_ID) {
            const existing = await this.deckOptionGroups.get(DEFAULT_DECK_OPTION_GROUP_ID)
            await this.deckOptionGroups.put({ ...(existing ?? defaultDeckOptionGroup), ...copiedDeckOptionSettings(incoming), updatedAt: incoming.updatedAt })
          } else await this.deckOptionGroups.put(incoming)
        }
        else if (change.entityType === 'note') await this.notes.put(canonicalNote(change.payload as LegacyNote))
        else if (change.entityType === 'card') await this.cards.put(canonicalCard(change.payload as LegacyCard))
        else if (change.entityType === 'noteMedia') await this.noteMedia.put(change.payload as NoteMediaReference)
        else if (change.entityType === 'noteType' && change.entityId !== BASIC_NOTE_TYPE_ID) await this.noteTypes.put(canonicalNoteType(change.payload as LegacyNoteType))
        else if (change.entityType === 'review') {
          const review = change.payload as ReviewEntry
          await this.reviewEntries.put(review)
          reviewedCardIds.add(review.cardId)
        }
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
        if (!progress) break
        incoming = await this.pendingRemoteOperations.toArray()
      }
      for (const cardId of reviewedCardIds) {
        const conflict = await this.syncConflicts.get(tombstoneKey('card', cardId))
        if (conflict?.conflicts.some((path) => path.startsWith('$schedule') || path === '$deleted')) continue
        const card = await this.cards.get(cardId)
        if (!card) continue
        const reviews = (await this.reviewEntries.where('cardId').equals(cardId).toArray())
          .filter((review) => review.rescheduled !== false && review.scheduling)
          .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id))
        if (!reviews.length) continue
        let schedule = deserializeCard(reviews[0].scheduling!.before)
        const history = await this.syncRevisions.where('key').equals(tombstoneKey('card', cardId)).toArray()
        const commands = history.filter((revision) => {
          if (revision.action !== 'update' || revision.reviewId || revision.occurredAt < reviews[0].reviewedAt) return false
          const parent = history.find((candidate) => revision.parents?.includes(candidate.opId))
          const before = parent?.payload as CardRecord | undefined
          const after = revision.payload as CardRecord
          return before && (before.due !== after.due || before.state !== after.state)
        })
        const events = [
          ...reviews.map((review) => ({ at: review.reviewedAt, id: review.id, review, command: undefined as SyncRevision | undefined })),
          ...commands.map((command) => ({ at: command.occurredAt, id: command.opId, review: undefined as ReviewEntry | undefined, command })),
        ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
        for (const event of events) {
          if (event.review) {
            const before = serializeCard(schedule, card)
            const replayed = answerWithSchedule(before, event.review.scheduling!.options, event.review.rating as Grade, new Date(event.at), event.review.id)
            schedule = deserializeCard(replayed.card)
          }
          else if (event.command) {
            const commanded = event.command.payload as CardRecord
            schedule = { ...schedule, due: new Date(commanded.due), state: commanded.state }
          }
        }
        const updated = serializeCard(schedule, card)
        await this.cards.put({ ...card, ...updated, manualSuspended: card.manualSuspended, templateSuspended: card.templateSuspended, suspended: card.suspended, buriedUntil: card.buriedUntil })
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
          if (templateSuspended(card) !== !active || card.templateSuspended === undefined) {
            await this.cards.put({ ...card, suspended: !active, templateSuspended: !active, manualSuspended: card.manualSuspended ?? false, buriedUntil: card.buriedUntil ?? null })
          }
        }
      }
      const existing = await this.settings.get('sync')
      if (existing) await this.settings.put({ key: 'sync', value: { ...(existing.value as SyncSettings), cursor } })
    })
  }
}

type CollectionTables = 'noteTypes' | 'decks' | 'deckOptionGroups' | 'notes' | 'cards' | 'reviewEntries' | 'outbox' | 'syncRevisions' | 'syncConflicts' | 'settings' | 'receivedOperations' | 'deletedEntities' | 'noteMedia' | 'mediaBlobs' | 'pendingRemoteOperations'
/** Internal storage type. Import only from collection query/mutation infrastructure. */
export type CollectionStorage = DexieCollection
export type Collection = Omit<DexieCollection, keyof Dexie | CollectionTables> & {
  readonly databaseName: string
  readonly schemaVersion: number
  openLocalCollection(): Promise<Collection>
  closeLocalCollection(): void
  removeLocalCollection(): Promise<void>
  onOpenBlocked(listener: () => void): () => void
}

export function createCollection(name = 'kiroku-collection'): Collection {
  return new DexieCollection(name) as Collection
}

export const collection = createCollection()
