/**
 * The collection schema ladder, in one place.
 *
 * The current version used to be a bare literal in three places - the Dexie
 * migration chain, the client's advertised version, and the server's accepted
 * maximum - with nothing asserting they agreed. The server's per-operation
 * minimum was a hand-transcribed mirror of the same ladder, so a step that
 * added a field could be applied to the migrations and forgotten there.
 *
 * Each step declares the fields it introduced. The migrations, both version
 * constants and the server's minimum-per-operation are all derived from this
 * list, so a step cannot be added in one place and missed in another.
 */

/** A field introduced by a schema step, and the entity that carries it. */
export interface SchemaField {
  entity: string
  field: string
}

export interface SchemaStep {
  schema: number
  /** Fields this step added. A step that only re-indexes declares none. */
  fields: SchemaField[]
  actions?: readonly string[]
  /** Why the step exists, for whoever has to reason about it later. */
  note?: string
}

export const SCHEMA_LADDER: readonly SchemaStep[] = [
  { schema: 1, fields: [], note: 'Decks, notes, cards and review entries.' },
  { schema: 2, fields: [], note: 'The outbox.' },
  { schema: 3, fields: [], note: 'Settings and received-operation receipts.' },
  { schema: 4, fields: [], note: 'Deletion tombstones.' },
  { schema: 5, fields: [{ entity: 'noteMedia', field: 'digest' }, { entity: 'noteMedia', field: 'side' }, { entity: 'noteMedia', field: 'kind' }], note: 'Offline media.' },
  { schema: 6, fields: [{ entity: 'note', field: 'typeId' }, { entity: 'card', field: 'templateId' }], note: 'Note types.' },
  { schema: 7, fields: [{ entity: 'noteType', field: 'kind' }], note: 'Cloze note types.' },
  { schema: 8, fields: [{ entity: 'note', field: 'tags' }, { entity: 'note', field: 'imageOcclusion' }, { entity: 'card', field: 'occlusionId' }, { entity: 'card', field: 'occlusionOrdinal' }, { entity: 'noteType', field: 'kind=image-occlusion' }], note: 'Tags and image occlusion.' },
  { schema: 9, fields: [{ entity: 'deck', field: 'parentId' }, { entity: 'deck', field: 'optionGroupId' }, { entity: 'deckOptionGroup', field: 'protected' }], note: 'Nested decks and deck option groups.' },
  { schema: 10, fields: [{ entity: 'deckOptionGroup', field: 'dailyNewLimit' }, { entity: 'deckOptionGroup', field: 'dailyReviewLimit' }, { entity: 'deckOptionGroup', field: 'desiredRetention' }, { entity: 'deckOptionGroup', field: 'learningSteps' }, { entity: 'deckOptionGroup', field: 'relearningSteps' }, { entity: 'deckOptionGroup', field: 'newCardOrder' }, { entity: 'deckOptionGroup', field: 'reviewCardOrder' }], note: 'Scheduling policy.' },
  { schema: 11, fields: [{ entity: 'card', field: 'manualSuspended' }, { entity: 'card', field: 'templateSuspended' }, { entity: 'card', field: 'buriedUntil' }, { entity: 'deckOptionGroup', field: 'buryNewSiblings' }, { entity: 'deckOptionGroup', field: 'buryReviewSiblings' }, { entity: 'deckOptionGroup', field: 'leechThreshold' }, { entity: 'deckOptionGroup', field: 'leechAction' }, { entity: 'deckOptionGroup', field: 'leechTag' }], note: 'Suspension, burial and leeches.' },
  { schema: 12, fields: [{ entity: 'deckOptionGroup', field: 'interdayLearningOrder' }], note: 'Interday learning order.' },
  { schema: 13, fields: [{ entity: 'card', field: 'flag' }], note: 'Anki-compatible card flags.' },
  { schema: 14, fields: [{ entity: 'review', field: 'rescheduled' }], note: 'Practice answers that leave scheduling unchanged.' },
  { schema: 15, fields: [{ entity: 'review', field: 'scheduling' }], note: 'Causal replay: the card as it stood before the answer.' },
  { schema: 16, fields: [{ entity: 'review', field: 'afterState' }, { entity: 'review', field: 'afterDue' }, { entity: 'review', field: 'afterStability' }, { entity: 'review', field: 'afterDifficulty' }, { entity: 'review', field: 'afterElapsedDays' }, { entity: 'review', field: 'afterScheduledDays' }, { entity: 'review', field: 'afterLearningSteps' }], note: 'The schedule an answer produced.' },
  { schema: 17, fields: [{ entity: 'deckOptionGroup', field: 'newReviewOrder' }], note: 'New-card and review queue mixing.' },
  { schema: 18, fields: [{ entity: 'deckOptionGroup', field: 'buryInterdayLearningSiblings' }], note: 'Interday-learning sibling burial.' },
  { schema: 19, fields: [{ entity: 'card', field: 'newPosition' }, { entity: 'card', field: 'templateOrdinal' }], note: 'New-card gather and template order.' },
  { schema: 20, fields: [{ entity: 'deckOptionGroup', field: 'newCardGatherOrder' }], note: 'New-card gather priority.' },
  { schema: 21, fields: [{ entity: 'deckOptionGroup', field: 'newCardSortOrder' }], note: 'New-card sort order after gathering.' },
  { schema: 22, fields: [{ entity: 'operation', field: 'lifetime' }, { entity: 'operation', field: 'relatedLifetimes' }, { entity: 'operation', field: 'restoreOf' }], actions: ['restore'], note: 'Causal deletion provenance, explicit restoration, and durable receive dependencies.' },
]

/** The highest step in the ladder. This is the client's store version. */
export const CLIENT_COLLECTION_SCHEMA_VERSION = SCHEMA_LADDER[SCHEMA_LADDER.length - 1].schema

/**
 * The highest step the sync service accepts. It deliberately matches the
 * client: the service refuses anything it could not preserve, so it must be
 * able to hold exactly what this client writes.
 */
export const SERVER_MAX_COLLECTION_SCHEMA_VERSION = CLIENT_COLLECTION_SCHEMA_VERSION

/**
 * The step at which each entity first became storable. A row of that kind cannot
 * exist before it, whatever fields the payload happens to carry.
 */
export const ENTITY_INTRODUCED_AT: Readonly<Record<string, number>> = {
  noteMedia: 5,
  noteType: 6,
  card: 1,
  note: 1,
  deck: 1,
  review: 1,
  deckOptionGroup: 9,
}

/**
 * The minimum schema needed to preserve a payload, derived from the ladder
 * rather than transcribed. An operation carrying any field a step introduced
 * requires at least that step.
 */
export function schemaRequiredByPayload(entityType: string, payload: unknown): number {
  // An entity's existence is itself a floor, not a field-level one.
  const floor = ENTITY_INTRODUCED_AT[entityType] ?? 1
  if (!isRecord(payload)) return floor
  let required = floor
  for (const step of SCHEMA_LADDER) {
    if (step.fields.some(({ entity, field }) => entity === entityType && field in payload)) required = Math.max(required, step.schema)
  }
  // A note type's kind is a discriminator the service matches on rather than a
  // field presence test, so the two note-type shapes need it stated here.
  if (entityType === 'noteType' && typeof payload.kind === 'string') required = Math.max(required, payload.kind === 'cloze' ? 7 : payload.kind === 'image-occlusion' ? 8 : 7)
  if (entityType === 'card' && Number.isSafeInteger(payload.clozeOrdinal)) required = Math.max(required, 7)
  if (entityType === 'note' && typeof payload.typeId === 'string') required = Math.max(required, 6)
  return required
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Wire metadata and action requirements share the same ladder as row fields. */
export function schemaRequiredByOperation(operation: { entityType: string; action: string; payload: unknown; parents?: unknown; reviewId?: unknown }): number {
  const causal = operation.parents !== undefined || operation.reviewId !== undefined ? 15 : 1
  const actions = SCHEMA_LADDER.filter(step => step.actions?.includes(operation.action)).map(step => step.schema)
  return Math.max(causal, schemaRequiredByPayload(operation.entityType, operation.payload), schemaRequiredByPayload('operation', operation), ...actions)
}

/**
 * Every (entity, field) pair the ladder claims to have introduced. Used by the
 * test that proves the ladder covers the server's rules rather than restating
 * them, and available to a caller that needs to explain a requirement.
 */
export function schemaIntroducedFields() {
  return SCHEMA_LADDER.flatMap((step) => step.fields.map(({ entity, field }) => ({ schema: step.schema, entity, field })))
}
