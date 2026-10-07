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
  previous?: readonly EntityLifetimeReference[]
  unavailable?: readonly EntityRef[]
  blocked?: readonly EntityRef[]
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

/** Check the original source and retained structural membership before authorizing an import. */
export function validateRestorationEvidence(target: EntityRef, causes: readonly DeletionCause[], revisions: readonly EntityLifetimeOperation[]): void {
  if (!causes.length) throw new Error('Deletion provenance is missing. Keep the collection and recover its original deletion history before restoring.')
  for (const cause of causes) {
    const source = revisions.find(revision => revision.opId === cause.opId)
    if (!source || source.action !== 'delete' || source.entityType !== cause.source.entityType || source.entityId !== cause.source.entityId) throw new Error('Deletion provenance does not match retained deletion history.')
    const visited = new Set<string>()
    const belongs = (ref: EntityRef): boolean => {
      if (ref.entityType === source.entityType && ref.entityId === source.entityId) return true
      const key = `${ref.entityType}:${ref.entityId}`
      if (visited.has(key)) return false
      visited.add(key)
      const history = revisions.filter(revision => revision.entityType === ref.entityType && revision.entityId === ref.entityId && JSON.stringify(revision.lifetime ?? []) === JSON.stringify(cause.deletedLifetime) && revision.action !== 'delete')
      const heads = new Set(revisionHeads(history))
      return history.filter(revision => heads.has(revision.opId)).some(revision => relatedEntities(ref.entityType, revision.payload).filter(parent => ['deck', 'note', 'card'].includes(parent.entityType)).some(belongs))
    }
    if (!belongs(target)) throw new Error('Deletion provenance names an unrelated record. Nothing was restored.')
  }
}

const sameLifetime = (left: EntityLifetime, right: EntityLifetime) => JSON.stringify(left) === JSON.stringify(right)
const sameEntity = (left: EntityRef, right: EntityRef) => left.entityType === right.entityType && left.entityId === right.entityId

function assertLifetime(value: EntityLifetime): void {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id) || !sameLifetime(value, [...new Set(value)].sort())) throw new Error('Invalid entity lifetime; retain local work and recover the original sync history.')
}

/** Ordinary heads do not choose an epoch; only validated explicit restores advance it. */
export function currentLifetime(revisions: readonly EntityLifetimeOperation[]): EntityLifetime {
  let current: EntityLifetime = []
  const visited = new Set<string>()
  while (true) {
    const candidates = revisions.filter(revision => revision.action === 'restore' && revision.restoreOf?.length && revision.restoreOf.every(cause => sameLifetime(cause.deletedLifetime, current)))
    if (!candidates.length) return current
    const lifetimes = [...new Map(candidates.map(revision => [JSON.stringify(revision.lifetime), revision.lifetime!])).values()]
    if (lifetimes.length !== 1) throw new Error('Restoration history has incompatible deletion barriers. Retain the collection and recover its causal history.')
    const next = lifetimes[0]
    assertLifetime(next)
    if (sameLifetime(next, current) || visited.has(JSON.stringify(next))) throw new Error('Cyclic restoration lifetime history.')
    visited.add(JSON.stringify(current))
    current = next
  }
}

/** Classify prior epochs explicitly; future dependencies are held rather than lost. */
export function decideOperationLifetime(operation: EntityLifetimeOperation, context: LifetimeContext): LifetimeDecision {
  const lifetime = operation.lifetime ?? []
  assertLifetime(lifetime)
  const missing: string[] = []
  if (operation.action === 'restore') {
    if (!operation.restoreOf?.length || !operation.relatedLifetimes || !operation.lifetime) throw new Error('Restoration requires original deletion provenance and lifetime references.')
    for (const cause of operation.restoreOf) {
      assertLifetime(cause.deletedLifetime)
      const deletion = context.knownDeletions.get(cause.opId)
      if (!deletion) { missing.push(cause.opId); continue }
      if (deletion.action !== 'delete' || !sameEntity(deletion, cause.source)) throw new Error('Restoration provenance does not name its original deletion.')
    }
    if (!sameLifetime(lifetime, restoredLifetime(operation.restoreOf))) throw new Error('Restoration lifetime differs from its deletion provenance.')
    if (missing.length) return { state: 'pending', missing }
    if (!sameLifetime(context.current, lifetime) && !operation.restoreOf.every(cause => sameLifetime(cause.deletedLifetime, context.current))) return { state: 'stale', missing: [] }
  } else if (!sameLifetime(lifetime, context.current)) {
    if ((context.previous ?? []).some(ref => sameEntity(ref, operation) && sameLifetime(ref.lifetime, lifetime))) return { state: 'stale', missing: [] }
    missing.push(`${operation.entityType}:${operation.entityId}`)
  } else if (operation.action !== 'delete' && context.blocked?.some(ref => sameEntity(ref, operation))) return { state: 'stale', missing: [] }
  const references = operation.relatedLifetimes ?? relatedEntities(operation.entityType, operation.payload).map(ref => ({ ...ref, lifetime: [] }))
  for (const reference of references) {
    assertLifetime(reference.lifetime)
    const current = context.related.find(ref => sameEntity(ref, reference))?.lifetime ?? []
    if (!sameLifetime(reference.lifetime, current)) {
      if ((context.previous ?? []).some(ref => sameEntity(ref, reference) && sameLifetime(ref.lifetime, reference.lifetime))) return { state: 'stale', missing: [] }
      missing.push(`${reference.entityType}:${reference.entityId}`)
    } else if (operation.action === 'delete') continue
    else if (context.blocked?.some(ref => sameEntity(ref, reference))) {
      if (operation.action !== 'restore') return { state: 'stale', missing: [] }
      missing.push(`${reference.entityType}:${reference.entityId}`)
    } else if ((operation.action === 'restore' || lifetime.length > 0) && context.unavailable?.some(ref => sameEntity(ref, reference))) missing.push(`${reference.entityType}:${reference.entityId}`)
  }
  return { state: missing.length ? 'pending' : 'apply', missing: [...new Set(missing)] }
}
