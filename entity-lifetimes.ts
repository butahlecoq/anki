import { revisionHeads } from './src/sync-revisions.js'

export type EntityType = 'deck' | 'deckOptionGroup' | 'note' | 'card' | 'review' | 'noteMedia' | 'noteType'
export type EntityRef = { entityType: EntityType; entityId: string }
export type EntityLifetime = readonly string[]
export type DeletionCause = { source: EntityRef; opId: string; deletedLifetime: EntityLifetime }
export type EntityLifetimeReference = EntityRef & { lifetime: EntityLifetime }
export interface EntityLifetimeMetadata {
  lifetime?: EntityLifetime
  relatedLifetimes?: readonly EntityLifetimeReference[]
  restoreOf?: readonly DeletionCause[]
}
export interface EntityLifetimeOperation extends EntityRef, EntityLifetimeMetadata {
  opId: string
  action: 'create' | 'update' | 'delete' | 'restore'
  payload: unknown
  parents?: string[]
}
export type LifetimeContext = {
  current: EntityLifetime
  causes: readonly DeletionCause[]
  related: readonly EntityLifetimeReference[]
  knownDeletions: ReadonlyMap<string, EntityLifetimeOperation>
}
export type LifetimeDecision = { state: 'apply' | 'stale' | 'pending'; missing: string[] }

export function restoredLifetime(causes: readonly DeletionCause[]): EntityLifetime {
  return [...new Set(causes.map(cause => cause.opId))].sort()
}

export function relatedEntities(entityType: EntityType, payload: unknown): EntityRef[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const row = payload as Record<string, unknown>
  const fields: Partial<Record<EntityType, Array<[string, EntityType]>>> = {
    deck: [['parentId', 'deck'], ['optionGroupId', 'deckOptionGroup']],
    note: [['deckId', 'deck'], ['typeId', 'noteType']],
    card: [['deckId', 'deck'], ['noteId', 'note']],
    review: [['deckId', 'deck'], ['cardId', 'card']],
    noteMedia: [['noteId', 'note']],
  }
  return (fields[entityType] ?? []).flatMap(([field, kind]) => typeof row[field] === 'string' && row[field] ? [{ entityType: kind, entityId: row[field] as string }] : [])
}

/** Legacy barriers are recovered from identities/relationships, never timestamps. */
export function recoverDeletionProvenance(target: EntityRef, revisions: readonly EntityLifetimeOperation[]): { causes: DeletionCause[]; provenanceError?: string } {
  const historyFor = (ref: EntityRef) => revisions.filter(revision => revision.entityType === ref.entityType && revision.entityId === ref.entityId)
  const candidates = new Map<string, EntityLifetimeOperation>()
  const visited = new Set<string>()
  let uncertain = false
  const visit = (ref: EntityRef) => {
    const key = `${ref.entityType}:${ref.entityId}`
    if (visited.has(key)) return
    visited.add(key)
    const history = historyFor(ref)
    const deletes = history.filter(revision => revision.action === 'delete')
    if (deletes.length) {
      for (const deletion of deletes) candidates.set(deletion.opId, deletion)
      return
    }
    const heads = new Set(revisionHeads(history))
    const relationships = history.filter(revision => heads.has(revision.opId)).map(revision => relatedEntities(ref.entityType, revision.payload).filter(parent => ['deck', 'note', 'card'].includes(parent.entityType)))
    const fingerprint = (refs: EntityRef[]) => JSON.stringify(refs.map(parent => `${parent.entityType}:${parent.entityId}`).sort())
    if (new Set(relationships.map(fingerprint)).size > 1) { uncertain = true; return }
    for (const parent of relationships[0] ?? []) visit(parent)
  }
  try { visit(target) } catch { uncertain = true }
  if (!uncertain && candidates.size === 1) {
    const deletion = [...candidates.values()][0]
    return { causes: [{ source: { entityType: deletion.entityType, entityId: deletion.entityId }, opId: deletion.opId, deletedLifetime: [] }] }
  }
  return { causes: [], provenanceError: 'Deletion provenance is missing or ambiguous. Keep this collection and its backup; restoration requires recovery of the original deletion history.' }
}
