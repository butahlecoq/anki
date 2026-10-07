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
