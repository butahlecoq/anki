import type { CardRecord, Note, SyncOperation } from './collection'

/** Keep structural delivery order while putting same-entity causal parents first. */
export function orderCausalOperations(operations: readonly SyncOperation[]): SyncOperation[] {
  const byId = new Map(operations.map(operation => [operation.opId, operation]))
  const completed = new Set<string>()
  const visiting = new Set<string>()
  const ordered: SyncOperation[] = []
  const visit = (operation: SyncOperation) => {
    if (completed.has(operation.opId) || visiting.has(operation.opId)) return
    visiting.add(operation.opId)
    for (const parentId of operation.parents ?? []) {
      const parent = byId.get(parentId)
      if (parent?.entityType === operation.entityType && parent.entityId === operation.entityId) visit(parent)
    }
    visiting.delete(operation.opId)
    completed.add(operation.opId)
    ordered.push(operation)
  }
  for (const operation of operations) visit(operation)
  return ordered
}

/** An intermediate card may wait only for a causal successor in its own lifetime. */
export function findCardMoveSuccessor(operation: SyncOperation, note: Pick<Note, 'id' | 'deckId'>, operations: readonly SyncOperation[]): SyncOperation | undefined {
  const byId = new Map(operations.map(candidate => [candidate.opId, candidate]))
  const follows = (candidate: SyncOperation): boolean => {
    const parents = [...(candidate.parents ?? [])]
    const visited = new Set<string>()
    while (parents.length) {
      const parentId = parents.pop()!
      if (parentId === operation.opId) return true
      if (visited.has(parentId)) continue
      visited.add(parentId)
      const parent = byId.get(parentId)
      if (parent?.entityType === 'card' && parent.entityId === operation.entityId) parents.push(...(parent.parents ?? []))
    }
    return false
  }
  return operations.find(candidate => candidate.entityType === 'card'
    && candidate.entityId === operation.entityId
    && candidate.action !== 'delete'
    && JSON.stringify(candidate.lifetime ?? []) === JSON.stringify(operation.lifetime ?? [])
    && (candidate.payload as Partial<CardRecord>)?.noteId === note.id
    && (candidate.payload as Partial<CardRecord>)?.deckId === note.deckId
    && follows(candidate))
}

/** Cross-page waiting needs causal evidence, never a timestamp or arbitrary deck mismatch. */
export function canWaitForCardMove(operation: SyncOperation, note: Pick<Note, 'id' | 'deckId'>, operations: readonly SyncOperation[], revisions: readonly SyncOperation[]): boolean {
  if (findCardMoveSuccessor(operation, note, operations)) return true
  // Present corrective envelopes must prove their own causality. Waiting is
  // for a missing later page, not permission to accept a disconnected update.
  if (operations.some(candidate => candidate.entityType === 'card' && candidate.entityId === operation.entityId
    && candidate.opId !== operation.opId && candidate.action !== 'delete'
    && (candidate.payload as Partial<CardRecord>)?.noteId === note.id
    && (candidate.payload as Partial<CardRecord>)?.deckId === note.deckId)) return false
  const incoming = operation.payload as Partial<CardRecord>
  if (incoming.noteId !== note.id || !incoming.deckId || incoming.deckId === note.deckId || operation.action === 'delete') return false
  const sameLifetime = (candidate: SyncOperation) => JSON.stringify(candidate.lifetime ?? []) === JSON.stringify(operation.lifetime ?? [])
  const noteLifetime = operation.relatedLifetimes?.find(ref => ref.entityType === 'note' && ref.entityId === note.id)?.lifetime ?? []
  const noteHistory = revisions.filter(candidate => candidate.entityType === 'note' && candidate.entityId === note.id
    && JSON.stringify(candidate.lifetime ?? []) === JSON.stringify(noteLifetime) && candidate.action !== 'delete')
  const byId = new Map(noteHistory.map(candidate => [candidate.opId, candidate]))
  const preceded = (candidate: SyncOperation): boolean => {
    const parents = [...(candidate.parents ?? [])]
    const visited = new Set<string>()
    while (parents.length) {
      const parentId = parents.pop()!
      if (visited.has(parentId)) continue
      visited.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) continue
      if ((parent.payload as Partial<Note>)?.deckId === incoming.deckId) return true
      parents.push(...(parent.parents ?? []))
    }
    return false
  }
  if (!noteHistory.some(candidate => (candidate.payload as Partial<Note>)?.deckId === note.deckId && preceded(candidate))) return false
  if (operation.action === 'create') return true
  // An old card update also needs its own retained causal predecessor in that deck.
  const cardHistory = new Map(revisions.filter(candidate => candidate.entityType === 'card' && candidate.entityId === operation.entityId && sameLifetime(candidate)).map(candidate => [candidate.opId, candidate]))
  const parents = [...(operation.parents ?? [])]
  const visited = new Set<string>()
  while (parents.length) {
    const parentId = parents.pop()!
    if (visited.has(parentId)) continue
    visited.add(parentId)
    const parent = cardHistory.get(parentId)
    if (!parent || parent.action === 'delete') continue
    const payload = parent.payload as Partial<CardRecord>
    if (payload.noteId === note.id && payload.deckId === incoming.deckId) return true
    parents.push(...(parent.parents ?? []))
  }
  return false
}

/** Received replays must preserve the complete original operation envelope. */
export function assertOperationIdentity(previous: SyncOperation, incoming: SyncOperation): void {
  if (previous.entityType !== incoming.entityType || previous.entityId !== incoming.entityId
    || previous.reviewId !== incoming.reviewId || previous.action !== incoming.action
    || previous.occurredAt !== incoming.occurredAt
    || JSON.stringify(previous.payload) !== JSON.stringify(incoming.payload)
    || JSON.stringify(previous.lifetime ?? []) !== JSON.stringify(incoming.lifetime ?? [])
    || JSON.stringify(previous.relatedLifetimes ?? []) !== JSON.stringify(incoming.relatedLifetimes ?? [])
    || JSON.stringify(previous.restoreOf ?? []) !== JSON.stringify(incoming.restoreOf ?? [])
    // Legacy messages omit parents that the receiver inferred when retaining history.
    || (incoming.parents !== undefined && JSON.stringify(previous.parents ?? []) !== JSON.stringify(incoming.parents))) {
    throw new Error('Sync operation identity was reused with different content')
  }
}

/** Validate identity reuse before a map can discard a conflicting envelope. */
export function uniqueSyncOperations(operations: readonly SyncOperation[]): SyncOperation[] {
  const byId = new Map<string, SyncOperation>()
  for (const operation of operations) {
    const previous = byId.get(operation.opId)
    if (previous) {
      assertOperationIdentity(previous, operation)
      // Unlike an inferred retained revision, both batch envelopes came over the wire.
      if (JSON.stringify(previous.parents ?? []) !== JSON.stringify(operation.parents ?? [])) {
        throw new Error('Sync operation identity was reused with different content')
      }
    }
    byId.set(operation.opId, operation)
  }
  return [...byId.values()]
}
