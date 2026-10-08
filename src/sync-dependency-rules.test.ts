import { expect, test } from 'vitest'
import { inheritedDeletionBarrier } from '../entity-lifetimes'
import type { SyncOperation } from './collection'
import { hasPendingDeckCycle, occlusionSourceReady } from './sync-dependency-rules'

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
  const snapshot = { ownerMaterialized: false, operations: [media], revisions: [], barriers: [] }
  expect(occlusionSourceReady(note, snapshot)).toBe(true)
  expect(occlusionSourceReady(note, { ...snapshot, operations: [] })).toBe(false)
  expect(occlusionSourceReady(note, { ...snapshot, barriers: [{ entityType: 'noteMedia', entityId: 'source', occurredAt: note.occurredAt }] })).toBe(false)
  expect(occlusionSourceReady(note, { ...snapshot, operations: [{ ...media, lifetime: ['future'], relatedLifetimes: [{ entityType: 'note', entityId: 'note', lifetime: [] }] }] })).toBe(false)
  for (const invalid of [{ noteId: 'other' }, { kind: 'audio' }, { mimeType: 'image/svg+xml' }, { side: 'back' }, { digest: 'invalid' }]) {
    expect(() => occlusionSourceReady(note, { ...snapshot, operations: [{ ...media, payload: { ...reference, ...invalid } }] })).toThrow(/source image reference.*invalid/i)
  }
})
