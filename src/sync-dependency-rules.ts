import { currentLifetime, decideOperationLifetime, validateRestorationEvidence, type DeletionBarrier, type EntityLifetimeReference } from '../entity-lifetimes'
import type { Deck, Note, NoteMediaReference, SyncOperation } from './collection'
import { mergeRevisions } from './sync-revisions'

/** Validate a card against the settled owner, not a prior note type or deck. */
export function cardWaitsForPendingNote(operation: SyncOperation, pending: readonly SyncOperation[]): boolean {
  if (operation.entityType !== 'card' || operation.action === 'delete') return false
  const noteId = (operation.payload as { noteId?: string } | undefined)?.noteId
  const lifetime = operation.relatedLifetimes?.find(ref => ref.entityType === 'note' && ref.entityId === noteId)?.lifetime ?? []
  return pending.some(candidate => candidate.entityType === 'note' && candidate.entityId === noteId && candidate.action !== 'delete'
    && JSON.stringify(candidate.lifetime ?? []) === JSON.stringify(lifetime))
}

/** Diagnose only unambiguous creates without a materialized or retired history. */
export function hasPendingDeckCycle(snapshot: {
  operations: readonly SyncOperation[]
  materializedIds: readonly string[]
  deletedIds: readonly string[]
  revisedIds: readonly string[]
}): boolean {
  const byEntity = new Map<string, SyncOperation[]>()
  for (const operation of snapshot.operations) {
    if (operation.entityType !== 'deck') continue
    const candidates = byEntity.get(operation.entityId) ?? []
    candidates.push(operation)
    byEntity.set(operation.entityId, candidates)
  }
  const excluded = new Set([...snapshot.materializedIds, ...snapshot.deletedIds, ...snapshot.revisedIds])
  const parents = new Map<string, string>()
  for (const [id, candidates] of byEntity) {
    if (candidates.length !== 1 || excluded.has(id)) continue
    const operation = candidates[0]
    if (operation.action !== 'create' || operation.lifetime?.length || operation.relatedLifetimes?.some(ref => ref.lifetime.length)) continue
    const parent = (operation.payload as Partial<Deck> | undefined)?.parentId
    if (typeof parent === 'string' && parent) parents.set(id, parent)
  }
  const visited = new Set<string>()
  for (const id of parents.keys()) {
    const path = new Set<string>()
    let current: string | undefined = id
    while (current && parents.has(current) && !visited.has(current)) {
      if (path.has(current)) return true
      path.add(current)
      current = parents.get(current)
    }
    for (const node of path) visited.add(node)
  }
  return false
}

export function validateOcclusionSource(note: Pick<Note, 'id' | 'imageOcclusion'>, source: NoteMediaReference | undefined): void {
  if (!source || source.id !== note.imageOcclusion?.sourceMediaId || source.noteId !== note.id || source.kind !== 'image'
    || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType) || source.side !== 'front' || !/^[a-f0-9]{64}$/.test(source.digest)) {
    throw new Error('Image occlusion source image reference is invalid. Correct the source image on the sending device and retry.')
  }
}

/** A note/source pair may become valid together, but never publish half a pair. */
export function occlusionSourceReady(operation: SyncOperation, snapshot: {
  source?: NoteMediaReference
  previousOwner?: Pick<Note, 'imageOcclusion'>
  operations: readonly SyncOperation[]
  revisions: readonly SyncOperation[]
  barriers: readonly DeletionBarrier[]
}): boolean {
  const note = operation.payload as Note
  if (snapshot.source) { validateOcclusionSource(note, snapshot.source); return true }
  const candidates = snapshot.operations.filter(candidate => candidate.entityType === 'noteMedia' && candidate.entityId === note.imageOcclusion?.sourceMediaId)
  const history = snapshot.revisions.filter(revision => revision.entityType === 'noteMedia' && revision.entityId === note.imageOcclusion?.sourceMediaId)
  const applicable: SyncOperation[] = []
  const owner: EntityLifetimeReference = { entityType: 'note', entityId: note.id, lifetime: operation.lifetime ?? [] }
  const previous = [...history, ...snapshot.revisions.filter(revision => revision.entityType === 'note' && revision.entityId === note.id)]
    .flatMap(revision => (revision.restoreOf ?? []).map(cause => ({ entityType: revision.entityType, entityId: revision.entityId, lifetime: cause.deletedLifetime })))
  const deletions = new Map(snapshot.revisions.filter(revision => revision.action === 'delete').map(revision => [revision.opId, revision]))
  for (const candidate of candidates) {
    const decision = decideOperationLifetime(candidate, { current: currentLifetime(history), related: [owner], previous,
      knownDeletions: deletions, blocked: snapshot.barriers.filter(barrier => barrier.entityType === 'noteMedia' && barrier.entityId === candidate.entityId) })
    if (decision.state !== 'apply') continue
    if (candidate.action === 'restore') validateRestorationEvidence(candidate, candidate.restoreOf!, snapshot.revisions)
    applicable.push(candidate)
  }
  if (applicable.length) {
    const revisions = [...new Map([...history, ...applicable].map(revision => [revision.opId, revision])).values()]
    const merged = mergeRevisions(revisions, currentLifetime(revisions))
    if (merged.conflicts.length || merged.deleted) return false
    validateOcclusionSource(note, merged.value as NoteMediaReference)
    return true
  }
  // Existing invalid edits remain errors; a new note can wait for a later page.
  if (snapshot.previousOwner?.imageOcclusion) validateOcclusionSource(note, undefined)
  return false
}
