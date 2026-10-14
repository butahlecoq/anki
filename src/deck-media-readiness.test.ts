import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { createCollection, type Collection } from './collection'
import { inspectDeckOfflineMedia, prepareDeckOfflineMedia } from './deck-media-readiness'
import { damageIndexedDbMediaBlob } from '../tests/helpers/damage-indexeddb-media'
import { readCachedMediaBlob } from './collection-queries'

const collections: Collection[] = []
function database() {
  const collection = createCollection(`deck-media-${crypto.randomUUID()}`)
  collections.push(collection)
  return collection
}
afterEach(async () => { await Promise.all(collections.splice(0).map((collection) => collection.removeLocalCollection())) })

test('readiness distinguishes no media, shared local media, missing media and corrupt bytes', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const unrelated = await collection.createDeck('Other')
  const first = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const second = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  const elsewhere = await collection.createBasicNote(unrelated.id, { front: '鳥', back: 'bird' })
  expect(await inspectDeckOfflineMedia(collection, deck.id)).toMatchObject({ deckId: deck.id, required: 0, missing: 0, state: 'ready' })

  const attached = await collection.attachMedia(first.id, { file: new File(['shared image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.attachMedia(second.id, { file: new File(['shared image'], 'dog.png', { type: 'image/png' }), side: 'front' })
  await collection.attachMedia(elsewhere.id, { file: new File(['shared image'], 'bird.png', { type: 'image/png' }), side: 'front' })
  expect(await inspectDeckOfflineMedia(collection, deck.id)).toMatchObject({ deckId: deck.id, required: 1, missing: 0, state: 'ready' })
  expect(await inspectDeckOfflineMedia(collection, unrelated.id)).toMatchObject({ deckId: unrelated.id, required: 1, missing: 0, state: 'ready' })

  await damageIndexedDbMediaBlob(collection.databaseName, attached.digest)
  expect(await inspectDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })
  expect(await inspectDeckOfflineMedia(collection, unrelated.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })
  const damaged = await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'authentication-required' }) })
  expect(damaged).toMatchObject({ state: 'authentication-required', readiness: { required: 1, missing: 1 } })
  expect(await readCachedMediaBlob(collection, attached.digest)).toBeUndefined()
  await collection.evictCachedMedia(attached.digest)
  expect(await inspectDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })
})

test('preparation recounts changed Deck references after a held sync', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const first = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const initial = await collection.attachMedia(first.id, { file: new File(['initial'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.evictCachedMedia(initial.digest)
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { started = resolve })
  const pending = prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => { started(); await waiting; return { state: 'complete', accepted: 0, cursor: 0, changes: [] } } })
  await began
  const second = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  const later = await collection.attachMedia(second.id, { file: new File(['later'], 'dog.png', { type: 'image/png' }), side: 'front' })
  await damageIndexedDbMediaBlob(collection.databaseName, later.digest)
  release()
  expect(await pending).toMatchObject({ state: 'partial-download', readiness: { deckId: deck.id, required: 2, missing: 2 } })
  expect(await readCachedMediaBlob(collection, later.digest)).toBeUndefined()
})

test('preparation translates a storage failure into an explicit result', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  vi.spyOn(collection, 'verifiedMediaBlob').mockRejectedValueOnce(new DOMException('Storage is full.', 'QuotaExceededError'))
  const result = await prepareDeckOfflineMedia(collection, deck.id)
  expect(result.state).toBe('storage-error')
  expect(result.message).toMatch(/storage|space|device/i)
})

test('preparation never reports ready when required bytes remain absent', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.evictCachedMedia(media.digest)

  const auth = await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'authentication-required' }) })
  expect(auth).toMatchObject({ state: 'authentication-required', readiness: { required: 1, missing: 1 } })
  expect(auth.message).toContain('paired PC')
  const partial = await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'complete', accepted: 0, cursor: 0, changes: [] }) })
  expect(partial).toMatchObject({ state: 'partial-download', readiness: { required: 1, missing: 1 } })
  const backup = await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'backup-failed', message: 'PC backup failed.' }) })
  expect(backup).toMatchObject({ state: 'backup-failed', message: 'PC backup failed.', readiness: { required: 1, missing: 1 } })
  const unreachable = await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'unreachable' }) })
  expect(unreachable).toMatchObject({ state: 'unreachable', readiness: { required: 1, missing: 1 } })
})
