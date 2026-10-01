import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, test } from 'vitest'
import { createCollection, IMAGE_OCCLUSION_NOTE_TYPE_ID, IMAGE_OCCLUSION_TEMPLATE_ID, Rating, type Collection } from './collection'
import { digestMedia } from './media'
import { syncCollection } from './sync-client'

let collection: Collection | undefined
const mask = (id: string, x: number) => ({ id, x, y: 0.2, width: 0.2, height: 0.25 })
const image = () => new File([new Uint8Array([137, 80, 78, 71, 1])], 'map.png', { type: 'image/png' })

afterEach(async () => {
  await collection?.delete()
  collection = undefined
})

test('migrates v7 notes with tags and seeds a protected image occlusion type without changing review history', async () => {
  const name = `kiroku-io-${crypto.randomUUID()}`
  const old = new Dexie(name)
  old.version(7).stores({ decks: 'id, name, createdAt', notes: 'id, deckId, typeId, updatedAt', cards: 'id, deckId, noteId, templateId, due, state', reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key', receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt', noteTypes: 'id, name, updatedAt' })
  await old.table('notes').add({ id: 'old-note', deckId: 'deck', type: 'basic', typeId: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
  await old.table('cards').add({ id: 'old-card', noteId: 'old-note', deckId: 'deck', templateId: 'basic', reps: 3 })
  await old.table('reviewEntries').add({ id: 'old-review', cardId: 'old-card', deckId: 'deck' })
  old.close()
  collection = createCollection(name)
  await expect(collection.notes.get('old-note')).resolves.toMatchObject({ tags: [] })
  await expect(collection.noteTypes.get(IMAGE_OCCLUSION_NOTE_TYPE_ID)).resolves.toMatchObject({ kind: 'image-occlusion', protected: true })
  await expect(collection.cards.get('old-card')).resolves.toMatchObject({ reps: 3 })
  await expect(collection.reviewEntries.get('old-review')).resolves.toMatchObject({ cardId: 'old-card' })
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
})

test('creates verified image reference and one deterministic card per mask atomically', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const file = image()
  const note = await collection.createImageOcclusionNote(deck.id, { image: file, imageWidth: 800, imageHeight: 600, header: 'Bones', backExtra: 'Review', tags: ['anatomy'], masks: [mask('alpha', 0.1), mask('beta', 0.6)] })
  expect(note.imageOcclusion?.masks.map((item) => [item.id, item.ordinal])).toEqual([['alpha', 1], ['beta', 2]])
  expect(note.tags).toEqual(['anatomy'])
  const digest = await digestMedia(file)
  expect(note.imageOcclusion?.sourceMediaId).toBeTruthy()
  await expect(collection.noteMedia.get(note.imageOcclusion!.sourceMediaId)).resolves.toMatchObject({ digest, kind: 'image', noteId: note.id })
  await expect(collection.mediaBlobs.get(digest)).resolves.toMatchObject({ digest, byteLength: file.size })
  const ids = (await collection.cards.where('noteId').equals(note.id).toArray()).map((card) => card.id).sort()
  expect(ids).toEqual([`${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:malpha`, `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:mbeta`])
})

test('geometry edits retain schedule and reviews; removal suspends one card and new masks do not reuse ordinals', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1), mask('beta', 0.6)] })
  const firstId = `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:malpha`
  const secondId = `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:mbeta`
  await collection.answer(firstId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
  await collection.updateImageOcclusionNote(note.id, { masks: [mask('alpha', 0.3), mask('beta', 0.6)], header: 'Updated' })
  await expect(collection.cards.get(firstId)).resolves.toMatchObject({ reps: 1 })
  expect((await collection.cards.get(firstId))?.suspended).toBeFalsy()
  await expect(collection.reviewEntries.where('cardId').equals(firstId).count()).resolves.toBe(1)
  await collection.updateImageOcclusionNote(note.id, { masks: [mask('beta', 0.6), mask('gamma', 0.1)] })
  await expect(collection.cards.get(firstId)).resolves.toMatchObject({ reps: 1, suspended: true })
  expect((await collection.cards.get(secondId))?.suspended).toBeFalsy()
  await expect(collection.notes.get(note.id)).resolves.toMatchObject({ imageOcclusion: { masks: [{ id: 'beta', ordinal: 2 }, { id: 'gamma', ordinal: 3 }] } })
  await collection.updateImageOcclusionNote(note.id, { masks: [mask('alpha', 0.3), mask('beta', 0.6), mask('gamma', 0.1)] })
  await expect(collection.cards.get(firstId)).resolves.toMatchObject({ reps: 1, suspended: false })
})

test('rejects invalid masks and image replacement without partial note changes', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1)] })
  await expect(collection.updateImageOcclusionNote(note.id, { masks: [mask('alpha', 0.9)], header: 'Bad' })).rejects.toThrow(/bounds/i)
  await expect(collection.notes.get(note.id)).resolves.toMatchObject({ fields: { header: '' }, imageOcclusion: { masks: [{ id: 'alpha', x: 0.1 }] } })
  await expect(collection.createImageOcclusionNote(deck.id, { image: new File(['bad'], 'bad.svg', { type: 'image/svg+xml' }), imageWidth: 1, imageHeight: 1, header: '', backExtra: '', tags: [], masks: [mask('x', 0.1)] })).rejects.toThrow(/supported/i)
  await expect(collection.notes.count()).resolves.toBe(1)
})

test('replacing the source image keeps its reference identity and existing card schedule', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1)] })
  const cardId = `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:malpha`
  await collection.answer(cardId, Rating.Good, new Date('2026-10-01T12:00:00Z'))
  const replacement = new File([new Uint8Array([137, 80, 78, 71, 2])], 'new.png', { type: 'image/png' })
  await collection.updateImageOcclusionNote(note.id, { image: replacement, imageWidth: 1600, imageHeight: 1200 })
  const updated = await collection.notes.get(note.id)
  expect(updated?.imageOcclusion?.sourceMediaId).toBe(note.imageOcclusion?.sourceMediaId)
  expect(updated?.imageOcclusion?.imageWidth).toBe(1600)
  await expect(collection.noteMedia.get(note.imageOcclusion!.sourceMediaId)).resolves.toMatchObject({ digest: await digestMedia(replacement), displayName: 'new.png' })
  await expect(collection.cards.get(cardId)).resolves.toMatchObject({ reps: 1 })
  await expect(collection.removeMedia(note.imageOcclusion!.sourceMediaId)).rejects.toThrow(/source image/i)
})

test('rejects reused mask ordinals and malformed inbound image occlusion notes', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1), mask('beta', 0.6)] })
  await collection.updateImageOcclusionNote(note.id, { masks: [mask('beta', 0.6)] })
  await expect(collection.updateImageOcclusionNote(note.id, { masks: [{ ...mask('gamma', 0.1), ordinal: 1 }, mask('beta', 0.6)] })).rejects.toThrow(/ordinal/i)
  const invalid = { ...note, imageOcclusion: { ...note.imageOcclusion!, masks: [{ ...note.imageOcclusion!.masks[0], width: 2 }] } }
  await expect(collection.applyRemoteChanges([{ opId: 'invalid-image-note', entityType: 'note', entityId: note.id, action: 'update', occurredAt: '2026-10-02', payload: invalid }], 1)).rejects.toThrow(/bounds/i)
  await expect(collection.notes.get(note.id)).resolves.toMatchObject({ imageOcclusion: { masks: [{ id: 'beta' }] } })
  await expect(collection.receivedOperations.get('invalid-image-note')).resolves.toBeUndefined()
})

test('syncs image occlusion metadata and ignores stale updates to removed mask cards', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const remote = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  try {
    const deck = await collection.createDeck('Anatomy')
    const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1), mask('beta', 0.6)] })
    const initial = await collection.pendingOperations()
    await remote.applyRemoteChanges(initial, initial.length)
    await expect(remote.missingReferencedMedia()).resolves.toHaveLength(1)
    const stale = await collection.cards.get(`${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:malpha`)
    await remote.updateImageOcclusionNote(note.id, { masks: [mask('beta', 0.6)] })
    await remote.applyRemoteChanges([{ opId: 'stale-mask-card', entityType: 'card', entityId: stale!.id, action: 'update', occurredAt: '2026-10-02', payload: stale }], initial.length + 1)
    await expect(remote.cards.get(stale!.id)).resolves.toMatchObject({ suspended: true })
    await remote.applyRemoteChanges([{ opId: 'stale-mask-review', entityType: 'review', entityId: 'stale-review', action: 'create', occurredAt: '2026-10-02', payload: { id: 'stale-review', cardId: stale!.id, deckId: deck.id } }], initial.length + 2)
    await expect(remote.reviewEntries.get('stale-review')).resolves.toBeUndefined()
  } finally {
    await remote.delete()
  }
})

test('rejects a synced source reference that is not an image', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const note = await collection.createImageOcclusionNote(deck.id, { image: image(), imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1)] })
  const source = (await collection.noteMedia.get(note.imageOcclusion!.sourceMediaId))!
  const invalid = { ...source, kind: 'audio', mimeType: 'audio/mpeg' }
  await expect(collection.applyRemoteChanges([{ opId: 'bad-source', entityType: 'noteMedia', entityId: source.id, action: 'update', occurredAt: '2026-10-02', payload: invalid }], 1)).rejects.toThrow(/source image/i)
  await expect(collection.noteMedia.get(source.id)).resolves.toMatchObject({ kind: 'image', mimeType: 'image/png' })
})

test('foreground sync requests the source digest and sends linked mask cards', async () => {
  collection = createCollection(`kiroku-io-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Anatomy')
  const file = image()
  const note = await collection.createImageOcclusionNote(deck.id, { image: file, imageWidth: 800, imageHeight: 600, header: '', backExtra: '', tags: [], masks: [mask('alpha', 0.1)] })
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const digest = await digestMedia(file)
  let uploadedDigest = ''
  let sentOperations: Array<{ entityType: string; entityId: string; payload: unknown }> = []
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith(`/api/media/${digest}`)) {
      uploadedDigest = String(url).split('/').at(-1) ?? ''
      return new Response(JSON.stringify({ digest, byteLength: file.size, mimeType: file.type, deduplicated: false }), { status: 200 })
    }
    sentOperations = (JSON.parse(String(options?.body)) as { operations: typeof sentOperations }).operations
    return new Response(JSON.stringify({ accepted: sentOperations.length, cursor: sentOperations.length, changes: [] }), { status: 200 })
  }
  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', media: { uploaded: 1, downloaded: 0, pending: 0 } })
  expect(uploadedDigest).toBe(digest)
  expect(sentOperations.map((operation) => [operation.entityType, operation.entityId])).toContainEqual(['card', `${note.id}:${IMAGE_OCCLUSION_TEMPLATE_ID}:malpha`])
  expect(sentOperations.some((operation) => operation.entityType === 'noteMedia' && operation.entityId === note.imageOcclusion?.sourceMediaId)).toBe(true)
})
