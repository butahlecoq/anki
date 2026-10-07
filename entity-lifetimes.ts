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
    if (target.entityType === source.entityType && target.entityId === source.entityId && JSON.stringify(cause.deletedLifetime) !== JSON.stringify(source.lifetime ?? [])) throw new Error('Deletion provenance names the wrong deleted lifetime.')
    const visited = new Set<string>()
    const belongs = (ref: EntityLifetimeReference): boolean => {
      if (ref.entityType === source.entityType && ref.entityId === source.entityId) return sameLifetime(ref.lifetime, source.lifetime ?? [])
      const key = `${ref.entityType}:${ref.entityId}:${JSON.stringify(ref.lifetime)}`
      if (visited.has(key)) return false
      visited.add(key)
      const history = revisions.filter(revision => revision.entityType === ref.entityType && revision.entityId === ref.entityId && sameLifetime(revision.lifetime ?? [], ref.lifetime) && revision.action !== 'delete')
      // A retained stale move must not erase the membership that explains an
      // original cascade. Historical links still name each ancestor's exact
      // lifetime, so a later deletion of the same identity is not interchangeable.
      return history.some(revision => relatedEntities(ref.entityType, revision.payload).filter(parent => ['deck', 'note', 'card'].includes(parent.entityType)).some(parent => belongs({ ...parent, lifetime: revision.relatedLifetimes?.find(reference => sameEntity(reference, parent))?.lifetime ?? [] })))
    }
    if (!belongs({ ...target, lifetime: cause.deletedLifetime })) throw new Error('Deletion provenance names an unrelated record or lifetime. Nothing was restored.')
  }
}

const sameLifetime = (left: EntityLifetime, right: EntityLifetime) => JSON.stringify(left) === JSON.stringify(right)
const sameEntity = (left: EntityRef, right: EntityRef) => left.entityType === right.entityType && left.entityId === right.entityId

function assertLifetime(value: EntityLifetime): void {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id) || !sameLifetime(value, [...new Set(value)].sort())) throw new Error('Invalid entity lifetime; retain local work and recover the original sync history.')
}

/** Validate wire metadata before storage or classification; omitted owner references are unsafe. */
export function validateLifetimeMetadata(operation: EntityLifetimeOperation): void {
  const entityTypes: EntityType[] = ['deck', 'deckOptionGroup', 'note', 'card', 'review', 'noteMedia', 'noteType']
  function assertReference(value: unknown): asserts value is EntityRef {
    if (!value || typeof value !== 'object' || !('entityType' in value) || !entityTypes.includes(value.entityType as EntityType) || !('entityId' in value) || typeof value.entityId !== 'string' || !value.entityId) throw new Error('Invalid entity lifetime reference; retain local work and recover the original sync history.')
  }
  if (operation.lifetime !== undefined) assertLifetime(operation.lifetime)
  if (operation.relatedLifetimes !== undefined) {
    if (!Array.isArray(operation.relatedLifetimes)) throw new Error('Invalid related lifetime references.')
    const keys = new Set<string>()
    for (const reference of operation.relatedLifetimes) {
      assertReference(reference)
      assertLifetime((reference as EntityLifetimeReference).lifetime)
      const key = `${reference.entityType}:${reference.entityId}`
      if (keys.has(key)) throw new Error('Duplicate related lifetime reference.')
      keys.add(key)
    }
    if (operation.action !== 'delete' && relatedEntities(operation.entityType, operation.payload).some(reference => !keys.has(`${reference.entityType}:${reference.entityId}`))) throw new Error('A required parent lifetime reference is missing; retain local work and retry with the original operation.')
  } else if (operation.lifetime !== undefined) throw new Error('Entity lifetime requires original related lifetime references.')
  if (operation.action === 'restore') {
    if (!operation.lifetime || !operation.relatedLifetimes || !Array.isArray(operation.restoreOf) || !operation.restoreOf.length) throw new Error('Restoration requires original deletion provenance and lifetime references.')
    const causes = new Set<string>()
    for (const cause of operation.restoreOf) {
      if (!cause || typeof cause !== 'object' || typeof cause.opId !== 'string' || !cause.opId) throw new Error('Invalid restoration deletion provenance.')
      assertReference(cause.source)
      assertLifetime(cause.deletedLifetime)
      if (cause.deletedLifetime.includes(cause.opId)) throw new Error('Cyclic restoration deletion provenance; recover the original lifetime history.')
      if (causes.has(cause.opId)) throw new Error('Duplicate restoration deletion provenance.')
      causes.add(cause.opId)
    }
  } else if (operation.restoreOf !== undefined) throw new Error('Deletion provenance requires an explicit restoration operation.')
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
  validateLifetimeMetadata(operation)
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
