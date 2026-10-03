/**
 * One undo record behind one seam.
 *
 * Review undo, note-deletion undo and card-maintenance undo used to be three
 * types under three private settings keys, each restating the same four-step
 * protocol: a sync-epoch guard, an outbox-pending guard, a deep-equality guard,
 * then a restore. Two modules outside the Collection reached past the seam to
 * read and write those keys directly.
 *
 * The record is now one discriminated value under one key, and the guards are
 * stated once. What each kind restores differs, so that part stays per-kind.
 */
import type { CardRecord, Note, NoteMediaReference, NoteType, ReviewEntry } from './collection'
import type { CustomStudySession } from './custom-study-state'

export type UndoKind = 'review' | 'note-deletion' | 'card-maintenance'

/** Fields every undo shares. The three guards read only these. */
interface UndoGuard {
  /** The sync epoch at the time of the action. A sync attempt bumps it, which
   * is what makes an action permanently unundoable once it has left the device. */
  syncEpoch: number
  /** Outbox operations that must still be pending. If any has been
   * acknowledged, another device has the change and it cannot be taken back. */
  operationIds: string[]
}

export type ReviewUndo = UndoGuard & {
  kind: 'review'
  review: ReviewEntry
  cards: Array<{ before: CardRecord; after: CardRecord }>
  note?: { before: Note; after: Note }
  customSession?: { before: CustomStudySession; after: CustomStudySession }
}

export type NoteDeletionUndo = UndoGuard & {
  kind: 'note-deletion'
  occurredAt: string
  note: Note
  noteType: NoteType
  cards: CardRecord[]
  reviews: ReviewEntry[]
  media: NoteMediaReference[]
}

export type CardMaintenanceUndo = UndoGuard & {
  kind: 'card-maintenance'
  action: 'suspend' | 'bury' | 'flag'
  before: CardRecord
  after: CardRecord
}

export type UndoRecord = ReviewUndo | NoteDeletionUndo | CardMaintenanceUndo

/** Every outbox operation this record depends on. */
export function undoOperationIds(record: UndoRecord): string[] {
  return record.operationIds
}

/** True when every named operation is still queued locally and unsynchronised. */
export async function undoOperationsPending(pending: (id: string) => Promise<boolean>, record: UndoRecord) {
  const results = await Promise.all(undoOperationIds(record).map(pending))
  return results.every(Boolean)
}

/** The epoch guard, stated once: a sync attempt since the action ends it. */
export function undoEpochMatches(current: number, undo: UndoGuard) {
  return undo.syncEpoch === current
}

/** The deep-equality guard, stated once. */
export function undoRowUnchanged(current: unknown, expected: unknown) {
  return JSON.stringify(current) === JSON.stringify(expected)
}

/**
 * Why a record is no longer undoable, or null when it is. The guards are
 * evaluated in the order a learner would need them explained, and each kind
 * names its own rows, so the refusal can still say what actually changed.
 */
export type UndoBlocker = 'sync-attempt' | 'synchronised' | 'changed'

/** Why a kind's own rows no longer match what it captured. A note deletion can
 * lose its container, which is a different situation from a row changing. */
export type UndoRowBlocker = 'changed' | 'original-deck-or-type-gone' | 'note-type-changed'

export function undoBlocker(guards: { epochMatches: boolean; operationsPending: boolean; rowsUnchanged: UndoRowBlocker | null }): UndoBlocker | null {
  if (!guards.epochMatches) return 'sync-attempt'
  if (!guards.operationsPending) return 'synchronised'
  if (guards.rowsUnchanged) return 'changed'
  return null
}

/** What the learner is told the undo will affect. */
export function undoSubject(record: UndoRecord) {
  if (record.kind === 'review') return record.review.cardId
  if (record.kind === 'note-deletion') return record.note.id
  return record.after.id
}

/** The button label, so one affordance still says what it will reverse. */
export function undoLabel(record: UndoRecord) {
  if (record.kind === 'review') return 'Undo last review'
  if (record.kind === 'note-deletion') return 'Undo note deletion'
  return 'Undo card action'
}

/** The confirmation read aloud after an undo succeeds. */
export function undoAnnouncement(record: UndoRecord | null) {
  if (record?.kind === 'note-deletion') return 'Deletion undone. The note is back.'
  if (record?.kind === 'card-maintenance') return 'Card action undone.'
  return 'Last review undone. The card is back in the queue.'
}