import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { Collection, createCollection } from './collection'
import { CLIENT_COLLECTION_SCHEMA_VERSION, SERVER_MAX_COLLECTION_SCHEMA_VERSION } from '../sync-capabilities'
import { SCHEMA_LADDER, schemaIntroducedFields, schemaRequiredByPayload } from '../schema-ladder'

test('the collection store version is the advertised schema version', async () => {
  // The ladder is the single definition; a client must never advertise a store
  // version its own migrations do not reach.
  const collection = new Collection(`kiroku-schema-${crypto.randomUUID()}`)
  expect(collection.verno).toBe(CLIENT_COLLECTION_SCHEMA_VERSION)
  expect(CLIENT_COLLECTION_SCHEMA_VERSION).toBe(SCHEMA_LADDER[SCHEMA_LADDER.length - 1].schema)
  expect(SERVER_MAX_COLLECTION_SCHEMA_VERSION).toBe(CLIENT_COLLECTION_SCHEMA_VERSION)
  const db = createCollection(`kiroku-schema-open-${crypto.randomUUID()}`)
  await db.createDeck('Schema')
  expect(db.verno).toBe(CLIENT_COLLECTION_SCHEMA_VERSION)
  await db.delete()
})

test('the ladder is ordered, contiguous, and starts at 1', () => {
  expect(SCHEMA_LADDER[0].schema).toBe(1)
  SCHEMA_LADDER.forEach((step, index) => expect(step.schema).toBe(index + 1))
})

test('every schema step a client declares, the service accepts', () => {
  // The watermark exists so a service cannot hold data it could not preserve.
  for (const step of SCHEMA_LADDER) {
    expect(step.schema).toBeLessThanOrEqual(SERVER_MAX_COLLECTION_SCHEMA_VERSION)
  }
})

test('a payload requires the step that introduced each field it carries', () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ['card', { templateId: 'basic' }, 6],
    ['card', { flag: 3 }, 13],
    ['card', { manualSuspended: true }, 11],
    ['card', { buriedUntil: null }, 11],
    ['card', { occlusionId: 'x' }, 8],
    ['note', { typeId: 'basic' }, 6],
    ['note', { tags: ['a'] }, 8],
    ['note', { imageOcclusion: {} }, 8],
    ['deck', { parentId: null }, 9],
    ['deck', { optionGroupId: 'g' }, 9],
    ['noteType', { kind: 'cloze' }, 7],
    ['review', { rescheduled: false }, 14],
    ['review', { scheduling: {} }, 15],
    ['review', { afterState: 2 }, 16],
    ['review', { afterScheduledDays: 12 }, 16],
    ['deckOptionGroup', { dailyNewLimit: 20 }, 10],
    ['deckOptionGroup', { leechAction: 'suspend' }, 11],
    ['deckOptionGroup', { interdayLearningOrder: 'before-reviews' }, 12],
    ['deckOptionGroup', { newReviewOrder: 'after-reviews' }, 17],
    ['deckOptionGroup', { buryInterdayLearningSiblings: true }, 18],
    ['noteMedia', { digest: 'a' }, 5],
  ]
  for (const [entityType, payload, expected] of cases) {
    expect(`${entityType} ${JSON.stringify(payload)} -> ${schemaRequiredByPayload(entityType, payload)}`).toBe(`${entityType} ${JSON.stringify(payload)} -> ${expected}`)
  }
})

test('a payload carrying several fields needs the latest step among them', () => {
  expect(schemaRequiredByPayload('card', { templateId: 'basic', flag: 1 })).toBe(13)
  expect(schemaRequiredByPayload('card', { templateId: 'basic', manualSuspended: true, flag: 1 })).toBe(13)
  expect(schemaRequiredByPayload('review', { rescheduled: false, scheduling: {}, afterState: 1 })).toBe(16)
})

test('an empty payload needs nothing beyond the first step', () => {
  expect(schemaRequiredByPayload('card', {})).toBe(1)
  expect(schemaRequiredByPayload('card', undefined)).toBe(1)
})

test('the ladder declares a field for every entity the sync protocol carries', () => {
  // A field the ladder omits would silently require only schema 1 on the
  // server, letting an old client acknowledge data it cannot preserve.
  const declared = new Set(schemaIntroducedFields().map(({ entity }) => entity))
  for (const entityType of ['card', 'note', 'deck', 'noteType', 'deckOptionGroup', 'review', 'noteMedia']) {
    expect(`${entityType}:${declared.has(entityType)}`).toBe(`${entityType}:true`)
  }
})

test('deriving the minimum matches the rules the service used to transcribe', () => {
  // The ladder replaces a hand-written mirror of itself. These are the exact
  // cases that mirror got right; if deriving them ever disagrees, the
  // derivation has changed a client's requirement and a mixed-version sync
  // hole has reopened.
  const transcribed: Array<[string, Record<string, unknown>, number]> = [
    ['noteMedia', { digest: 'a' }, 5],
    ['noteType', { id: 't' }, 6],
    ['deckOptionGroup', { id: 'g' }, 9],
    ['review', { scheduling: {} }, 15],
    ['review', { rescheduled: false }, 14],
    ['review', { afterState: 2 }, 16],
    ['note', { typeId: 'basic' }, 6],
    ['card', { templateId: 'basic' }, 6],
    ['noteType', { kind: 'cloze' }, 7],
    ['card', { clozeOrdinal: 2 }, 7],
    ['note', { tags: [] }, 8],
    ['note', { imageOcclusion: {} }, 8],
    ['noteType', { kind: 'image-occlusion' }, 8],
    ['card', { occlusionId: 'o' }, 8],
    ['card', { occlusionOrdinal: 1 }, 8],
    ['deck', { parentId: null }, 9],
    ['deck', { optionGroupId: 'g' }, 9],
    ['deckOptionGroup', { dailyNewLimit: 1 }, 10],
    ['deckOptionGroup', { desiredRetention: 0.9 }, 10],
    ['card', { manualSuspended: true }, 11],
    ['card', { templateSuspended: true }, 11],
    ['card', { buriedUntil: null }, 11],
    ['deckOptionGroup', { buryNewSiblings: true }, 11],
    ['deckOptionGroup', { leechTag: 'leech' }, 11],
    ['deckOptionGroup', { interdayLearningOrder: 'after-reviews' }, 12],
    ['card', { flag: 1 }, 13],
    ['deckOptionGroup', { newReviewOrder: 'mix', buryInterdayLearningSiblings: true }, 18],
  ]
  for (const [entityType, payload, expected] of transcribed) {
    const derived = schemaRequiredByPayload(entityType, payload)
    expect(`${entityType} ${JSON.stringify(payload)}: derived ${derived}, transcribed ${expected}`).toBe(`${entityType} ${JSON.stringify(payload)}: derived ${expected}, transcribed ${expected}`)
  }
})

test('the media allowlist is one table read by both runtimes', async () => {
  const { SUPPORTED_MEDIA_TYPES, isSupportedMediaType, mediaTypeForFilename } = await import('../media-types')
  // Every type the browser accepts is one the service accepts.
  for (const definition of SUPPORTED_MEDIA_TYPES) {
    expect(`${definition.mimeType}:${isSupportedMediaType(definition.mimeType)}`).toBe(`${definition.mimeType}:true`)
    expect(mediaTypeForFilename(`recording.${definition.extensions[0]}`)).toMatchObject({ mimeType: definition.mimeType })
  }
  expect(isSupportedMediaType('application/zip')).toBe(false)
  expect(mediaTypeForFilename('payload.exe')).toBeUndefined()
  // The browser's own validator reads the same table, so the two cannot drift.
  const { validateMedia } = await import('./media')
  expect(validateMedia(new File(['x'], 'a.png', { type: 'image/png' }))).toMatchObject({ kind: 'image' })
  expect(() => validateMedia(new File(['x'], 'a.exe', { type: 'application/x-msdownload' }))).toThrow(/not a supported/i)
})
