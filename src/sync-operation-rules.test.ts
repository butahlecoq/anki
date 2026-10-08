import { expect, test } from 'vitest'
import type { SyncOperation } from './collection'
import { assertOperationIdentity, canWaitForCardMove, findCardMoveSuccessor, orderCausalOperations, uniqueSyncOperations } from './sync-operation-rules'

const card = (opId: string, deckId: string, parents: string[] = []): SyncOperation => ({
  opId, entityType: 'card', entityId: 'card', action: 'update',
  occurredAt: '2026-10-07T12:00:00.000Z', payload: { noteId: 'note', deckId }, parents, lifetime: [],
})

test('causal card ordering preserves structural order and ignores foreign entity parents', () => {
  const deck: SyncOperation = { ...card('deck', 'current'), entityType: 'deck', entityId: 'current' }
  const ancestor = card('z-ancestor', 'original')
  const descendant = card('a-descendant', 'current', [ancestor.opId, deck.opId])
  expect(orderCausalOperations([deck, descendant, ancestor])).toEqual([deck, ancestor, descendant])
})

test('only a matching same-lifetime causal card successor authorizes waiting', () => {
  const original = card('original', 'previous')
  const middle = card('middle', 'intermediate', [original.opId])
  const successor = card('successor', 'current', [middle.opId])
  const note = { id: 'note', deckId: 'current' }
  expect(findCardMoveSuccessor(original, note, [successor, middle, original])).toBe(successor)
  expect(findCardMoveSuccessor(original, note, [{ ...successor, parents: [] }, middle, original])).toBeUndefined()
  expect(findCardMoveSuccessor(original, note, [{ ...successor, lifetime: ['another-lifetime'] }, middle, original])).toBeUndefined()
  expect(findCardMoveSuccessor(original, note, [{ ...successor, payload: { noteId: 'another-note', deckId: 'current' } }, middle, original])).toBeUndefined()
})

test('legacy retained parents may be inferred but conflicting wire parents cannot be deduplicated', () => {
  const retained = card('legacy', 'current', ['inferred-parent'])
  const legacy = { ...retained, parents: undefined }
  expect(() => assertOperationIdentity(retained, legacy)).not.toThrow()
  expect(() => uniqueSyncOperations([retained, legacy])).toThrow('identity was reused')
  expect(uniqueSyncOperations([legacy, legacy])).toEqual([legacy])
})

test('a historical card can wait across pages only with same-lifetime causal note movement evidence', () => {
  const original = { ...card('original', 'previous'), action: 'create' as const }
  const created: SyncOperation = { ...original, entityType: 'note', entityId: 'note', opId: 'note-created', payload: { deckId: 'previous' } }
  const moved: SyncOperation = { ...created, opId: 'note-moved', action: 'update', parents: [created.opId], payload: { deckId: 'current' } }
  const note = { id: 'note', deckId: 'current' }
  expect(canWaitForCardMove(original, note, [], [created, moved])).toBe(true)
  expect(canWaitForCardMove(original, note, [card('disconnected-move', 'current')], [created, moved])).toBe(false)
  expect(canWaitForCardMove(original, note, [], [created, { ...moved, parents: [] }])).toBe(false)
  expect(canWaitForCardMove(original, note, [], [{ ...created, lifetime: ['restored'] }, moved])).toBe(false)
  expect(canWaitForCardMove({ ...original, payload: { noteId: note.id, deckId: 'unrelated' } }, note, [], [created, moved])).toBe(false)
  const oldUpdate = card('old-update', 'previous', [original.opId])
  expect(canWaitForCardMove(oldUpdate, note, [], [created, moved, original])).toBe(true)
  expect(canWaitForCardMove({ ...oldUpdate, parents: [] }, note, [], [created, moved, original])).toBe(false)
})
