import { expect, test } from 'vitest'
import { inheritedDeletionBarrier } from '../entity-lifetimes'
import type { CardRecord, Note, SyncOperation } from './collection'
import { cardWaitsForPendingNote, decideOcclusionCardDependency, hasPendingDeckCycle, occlusionSourceReady } from './sync-dependency-rules'

const operation = (entityType: SyncOperation['entityType'], entityId: string, payload: unknown, extra: Partial<SyncOperation> = {}): SyncOperation => ({
  opId: `${entityType}-${entityId}`, entityType, entityId, action: 'create', occurredAt: '2026-10-08T12:00:00Z', payload, ...extra,
})

test('cycle diagnosis excludes ambiguous, materialized, deleted and restored candidates', () => {
  const operations = [operation('deck', 'a', { parentId: 'b' }), operation('deck', 'b', { parentId: 'a' })]
  const snapshot = { operations, materializedIds: [], deletedIds: [], revisedIds: [] }
  expect(hasPendingDeckCycle(snapshot)).toBe(true)
  expect(hasPendingDeckCycle({ ...snapshot, materializedIds: ['a'] })).toBe(false)
  expect(hasPendingDeckCycle({ ...snapshot, deletedIds: ['a'] })).toBe(false)
  expect(hasPendingDeckCycle({ ...snapshot, revisedIds: ['a'] })).toBe(false)
  expect(hasPendingDeckCycle({ ...snapshot, operations: [...operations, { ...operations[0], opId: 'revision-a' }] })).toBe(false)
  expect(hasPendingDeckCycle({ ...snapshot, operations: [{ ...operations[0], lifetime: ['restore-a'] }, operations[1]] })).toBe(false)
})

test('descendants inherit only matching structural deletion lifetimes, retaining ambiguity', () => {
  const note = operation('note', 'note', { deckId: 'deck', typeId: 'type' })
  const barrier = { entityType: 'deck' as const, entityId: 'deck', occurredAt: note.occurredAt, causes: [{ source: { entityType: 'deck' as const, entityId: 'deck' }, opId: 'deleted-deck', deletedLifetime: [] }] }
  const context = { materialized: false, revisions: [], barriers: [barrier] }
  expect(inheritedDeletionBarrier(note, context)).toMatchObject({ entityType: 'note', entityId: 'note', causes: barrier.causes })
  expect(inheritedDeletionBarrier(note, { ...context, materialized: true })).toBeUndefined()
  expect(inheritedDeletionBarrier(note, { ...context, barriers: [{ ...barrier, entityType: 'noteType', entityId: 'type' }] })).toBeUndefined()
  expect(inheritedDeletionBarrier({ ...note, lifetime: ['new'] }, context)).toBeUndefined()
  expect(inheritedDeletionBarrier(note, { ...context, barriers: [{ ...barrier, causes: [] }] })?.provenanceError).toMatch(/ambiguous/i)
})

test('atomic occlusion source evidence rejects malformed sources and cannot bypass lifetime barriers', () => {
  const note = operation('note', 'note', { id: 'note', imageOcclusion: { sourceMediaId: 'source' } })
  const reference = { id: 'source', noteId: 'note', digest: 'a'.repeat(64), kind: 'image', mimeType: 'image/png', side: 'front' }
  const media = operation('noteMedia', 'source', reference)
  const snapshot = { operations: [media], revisions: [], barriers: [] }
  expect(occlusionSourceReady(note, snapshot)).toBe(true)
  expect(occlusionSourceReady(note, { ...snapshot, operations: [] })).toBe(false)
  expect(occlusionSourceReady(note, { ...snapshot, operations: [], previousOwner: {} })).toBe(false)
  expect(() => occlusionSourceReady(note, { ...snapshot, operations: [], previousOwner: { imageOcclusion: { version: 1, sourceMediaId: 'previous-source', imageWidth: 1, imageHeight: 1, masks: [], nextOrdinal: 1 } } })).toThrow(/source image reference.*invalid/i)
  expect(occlusionSourceReady(note, { ...snapshot, barriers: [{ entityType: 'noteMedia', entityId: 'source', occurredAt: note.occurredAt }] })).toBe(false)
  expect(occlusionSourceReady(note, { ...snapshot, operations: [{ ...media, lifetime: ['future'], relatedLifetimes: [{ entityType: 'note', entityId: 'note', lifetime: [] }] }] })).toBe(false)
  for (const invalid of [{ noteId: 'other' }, { kind: 'audio' }, { mimeType: 'image/svg+xml' }, { side: 'back' }, { digest: 'invalid' }]) {
    expect(() => occlusionSourceReady(note, { ...snapshot, operations: [{ ...media, payload: { ...reference, ...invalid } }] })).toThrow(/source image reference.*invalid/i)
  }
})

test('cards wait for same-lifetime pending owner revisions instead of validating a prior note type', () => {
  const card = operation('card', 'card', { noteId: 'note' })
  const pendingNote = operation('note', 'note', { typeId: 'image-occlusion' }, { action: 'update' })
  expect(cardWaitsForPendingNote(card, [pendingNote])).toBe(true)
  expect(cardWaitsForPendingNote(card, [{ ...pendingNote, entityId: 'other' }])).toBe(false)
  expect(cardWaitsForPendingNote(card, [{ ...pendingNote, lifetime: ['future'] }])).toBe(false)
  expect(cardWaitsForPendingNote({ ...card, action: 'delete' }, [pendingNote])).toBe(false)
  expect(cardWaitsForPendingNote(card, [{ ...pendingNote, action: 'delete' }])).toBe(false)
})

test('unknown mask generations wait while malformed, mutated and historically removed masks stay suppressed', () => {
  const note = { id: 'note', typeId: 'basic' } as Note
  const card = { id: 'note:image-occlusion:mnext', noteId: note.id, templateId: 'image-occlusion', occlusionId: 'next', occlusionOrdinal: 2 } as CardRecord
  const incoming = operation('card', card.id, card)
  const snapshot = { note, revisions: [], templateId: 'image-occlusion' }
  expect(decideOcclusionCardDependency(incoming, snapshot)).toBe('pending')
  expect(decideOcclusionCardDependency({ ...incoming, payload: { ...card, id: 'wrong' } }, snapshot)).toBe('stale')
  expect(decideOcclusionCardDependency({ ...incoming, payload: { ...card, occlusionOrdinal: -1 } }, snapshot)).toBe('stale')
  const owner = { ...note, imageOcclusion: { version: 1 as const, sourceMediaId: 'source', imageWidth: 1, imageHeight: 1, masks: [{ id: 'next', ordinal: 2, x: .1, y: .1, width: .2, height: .2 }], nextOrdinal: 3 } }
  expect(decideOcclusionCardDependency(incoming, { ...snapshot, note: owner })).toBe('apply')
  expect(decideOcclusionCardDependency(incoming, { ...snapshot, note: owner, existing: { ...card, occlusionOrdinal: 1 } })).toBe('stale')
  const removed = { ...owner, imageOcclusion: { ...owner.imageOcclusion, masks: [] } }
  expect(decideOcclusionCardDependency(incoming, { ...snapshot, note: removed })).toBe('stale')
  expect(decideOcclusionCardDependency(incoming, { ...snapshot, revisions: [operation('note', note.id, owner)] })).toBe('stale')
  expect(decideOcclusionCardDependency({ ...incoming, payload: { ...card, templateSuspended: true } }, { ...snapshot, note: removed, existing: card })).toBe('apply')
  const retired = { ...incoming, payload: { ...card, templateSuspended: true } }
  const history = [operation('note', note.id, owner)]
  expect(decideOcclusionCardDependency(retired, { ...snapshot, revisions: history })).toBe('apply')
  expect(decideOcclusionCardDependency({ ...retired, payload: { ...card, templateSuspended: true, occlusionOrdinal: 1 } }, { ...snapshot, revisions: history })).toBe('stale')
  expect(decideOcclusionCardDependency(retired, { ...snapshot, revisions: [{ ...history[0], lifetime: ['another-owner-lifetime'] }] })).toBe('pending')
  const retirement = operation('card', card.id, { ...card, templateSuspended: true }, { opId: 'retired-mask' })
  const reactivation = { ...incoming, action: 'update' as const, parents: [retirement.opId] }
  expect(decideOcclusionCardDependency(reactivation, { ...snapshot, revisions: [...history, retirement] })).toBe('pending')
  expect(decideOcclusionCardDependency(reactivation, { ...snapshot, revisions: [...history, { ...retirement, lifetime: ['another-card-lifetime'] }] })).toBe('stale')
  expect(decideOcclusionCardDependency(reactivation, { ...snapshot, revisions: [...history, { ...retirement, entityId: 'unrelated-card' }] })).toBe('stale')
  expect(decideOcclusionCardDependency({ ...reactivation, payload: { ...card, occlusionOrdinal: 1 } }, { ...snapshot, revisions: [...history, retirement] })).toBe('stale')
  expect(decideOcclusionCardDependency(incoming, { ...snapshot, note: { ...removed, imageOcclusion: { ...removed.imageOcclusion, nextOrdinal: 2 } } })).toBe('pending')
})
