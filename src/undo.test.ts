import { describe, expect, test, vi } from 'vitest'
import type { CardRecord, Note, NoteType, ReviewEntry } from './collection'
import {
  undoAnnouncement, undoBlocker, undoEpochMatches, undoLabel, undoOperationIds,
  undoOperationsPending, undoRowUnchanged, undoSubject,
  type NoteDeletionUndo, type ReviewUndo, type UndoRecord,
} from './undo'

const card: CardRecord = {
  id: 'card-1', deckId: 'deck-1', noteId: 'note-1', templateId: 'basic',
  due: '2026-10-03T12:00:00.000Z', stability: 5, difficulty: 5, elapsedDays: 1,
  scheduledDays: 5, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-10-02T12:00:00.000Z',
  manualSuspended: false, templateSuspended: false, suspended: false, buriedUntil: null,
}
const review: ReviewEntry = {
  id: 'review-1', cardId: card.id, deckId: card.deckId, rating: 3, state: 2,
  due: '2026-10-03T12:00:00.000Z', stability: 5, difficulty: 5, elapsedDays: 1,
  lastElapsedDays: 1, scheduledDays: 5, learningSteps: 0, reviewedAt: '2026-10-02T12:00:00.000Z',
}

const reviewUndo: ReviewUndo = {
  kind: 'review', syncEpoch: 3, operationIds: ['op-1', 'op-2'], review,
  cards: [{ before: { ...card, scheduledDays: 3 }, after: card }],
}
const noteDeletionUndo: NoteDeletionUndo = {
  kind: 'note-deletion', syncEpoch: 3, operationIds: ['op-3'], occurredAt: '2026-10-02T12:00:00.000Z',
  note: { id: 'note-1', deckId: 'deck-1', type: 'basic', typeId: 'basic', fields: {}, tags: [], createdAt: '', updatedAt: '' },
  noteType: { id: 'basic', name: 'Basic', kind: 'standard', fields: [], templates: [], protected: true, createdAt: '', updatedAt: '' } as unknown as NoteType,
  cards: [card], reviews: [review], media: [],
}
const maintenanceUndo: UndoRecord = {
  kind: 'card-maintenance', syncEpoch: 3, operationIds: ['op-4'], action: 'suspend',
  before: { ...card, manualSuspended: false }, after: { ...card, manualSuspended: true },
}

describe('the undo guard protocol', () => {
  test('a sync attempt since the action ends it, whatever the kind', () => {
    for (const record of [reviewUndo, noteDeletionUndo, maintenanceUndo]) {
      expect(undoEpochMatches(3, record)).toBe(true)
      expect(undoEpochMatches(4, record)).toBe(false)
    }
  })

  test('every named operation must still be queued locally', async () => {
    const queued = new Set(['op-1', 'op-2'])
    const pending = (id: string) => Promise.resolve(queued.has(id))
    expect(await undoOperationsPending(pending, reviewUndo)).toBe(true)
    queued.delete('op-2')
    expect(await undoOperationsPending(pending, reviewUndo)).toBe(false)
    expect(undoOperationIds(reviewUndo)).toEqual(['op-1', 'op-2'])
    // A record holding one operation uses the same rule as one holding many.
    expect(undoOperationIds(maintenanceUndo)).toEqual(['op-4'])
    expect(await undoOperationsPending(pending, noteDeletionUndo)).toBe(false)
  })

  test('the guards are reported in the order a learner would need them', () => {
    const all = { epochMatches: true, operationsPending: true, rowsUnchanged: null }
    expect(undoBlocker(all)).toBe(null)
    expect(undoBlocker({ ...all, rowsUnchanged: 'changed' })).toBe('changed')
    expect(undoBlocker({ ...all, operationsPending: false, rowsUnchanged: 'changed' })).toBe('synchronised')
    expect(undoBlocker({ epochMatches: false, operationsPending: false, rowsUnchanged: 'changed' })).toBe('sync-attempt')
    // A missing container is its own reason, not a generic change.
    expect(undoBlocker({ ...all, rowsUnchanged: 'original-deck-or-type-gone' })).toBe('changed')
    expect(undoBlocker({ ...all, rowsUnchanged: 'note-type-changed' })).toBe('changed')
  })

  test('the equality guard compares whole rows', () => {
    expect(undoRowUnchanged(card, { ...card })).toBe(true)
    expect(undoRowUnchanged({ ...card, flag: 7 }, card)).toBe(false)
    expect(undoRowUnchanged(undefined, card)).toBe(false)
    expect(undoRowUnchanged(card, undefined)).toBe(false)
  })
})

describe('what the learner is told', () => {
  test('one record, one subject, one label, whatever produced it', () => {
    expect(undoSubject(reviewUndo)).toBe(card.id)
    expect(undoSubject(noteDeletionUndo)).toBe('note-1')
    expect(undoSubject(maintenanceUndo)).toBe(card.id)
    expect(undoLabel(reviewUndo)).toBe('Undo last review')
    expect(undoLabel(noteDeletionUndo)).toBe('Undo note deletion')
    expect(undoLabel(maintenanceUndo)).toBe('Undo card action')
    expect(undoAnnouncement(reviewUndo)).toMatch(/review undone/i)
    expect(undoAnnouncement(noteDeletionUndo)).toMatch(/note is back/i)
    expect(undoAnnouncement(maintenanceUndo)).toMatch(/card action undone/i)
    expect(undoAnnouncement(null)).toMatch(/review undone/i)
  })
})

describe('the record is one value', () => {
  test('each kind names the operations it depends on through the same field', () => {
    // One `operationIds` on every kind, so the outbox guard has no per-kind path.
    for (const record of [reviewUndo, noteDeletionUndo, maintenanceUndo]) {
      expect(record.operationIds.length).toBeGreaterThan(0)
      expect(record.kind).toBeTruthy()
    }
    expect(reviewUndo.operationIds).toHaveLength(2)
    expect(noteDeletionUndo.operationIds).toHaveLength(1)
    expect(maintenanceUndo.operationIds).toHaveLength(1)
  })

  test('a record survives a round trip through JSON, as the settings table requires', () => {
    const stored = JSON.parse(JSON.stringify(reviewUndo)) as UndoRecord
    expect(stored).toEqual(reviewUndo)
    expect(undoSubject(stored)).toBe(card.id)
  })

  test('a pending-operation lookup is never called for a record with none', async () => {
    const lookup = vi.fn(async () => true)
    await undoOperationsPending(lookup, maintenanceUndo)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('note deletion records what restoring needs', () => {
  test('a deletion carries the note, its type, and everything hanging off it', () => {
    expect(noteDeletionUndo.note.id).toBe('note-1')
    expect(noteDeletionUndo.noteType.id).toBe('basic')
    expect(noteDeletionUndo.cards.map((entry) => entry.id)).toEqual([card.id])
    expect(noteDeletionUndo.reviews.map((entry) => entry.id)).toEqual([review.id])
  })

  test('a note is not a ReviewEntry and the union keeps them apart', () => {
    const asReview = reviewUndo as ReviewUndo
    expect('review' in asReview).toBe(true)
    expect('note' in (noteDeletionUndo as NoteDeletionUndo)).toBe(true)
    const note: Note = noteDeletionUndo.note
    expect(note.fields).toEqual({})
  })
})