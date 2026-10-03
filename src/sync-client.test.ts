import { expect, test, vi } from 'vitest'
import { foregroundSync, pairCollection, preflightSync, syncCollection } from './sync-client'
import { createCollection, Rating } from './collection'
import { digestMedia } from './media'
import { CLIENT_COLLECTION_SCHEMA_VERSION } from '../sync-capabilities'

const health = (collectionSchemaVersion = CLIENT_COLLECTION_SCHEMA_VERSION, maximumCollectionSchemaVersion = CLIENT_COLLECTION_SCHEMA_VERSION) => new Response(JSON.stringify({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion, maximumCollectionSchemaVersion, store: 'sqlite' }), { status: 200 })

test('sends pending operations with the local pairing credential', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: 2, cursor: 2, changes: [] }), { status: 200 }))
  const result = await foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [{ opId: 'one' }], fetcher)

  expect(result).toEqual({ state: 'complete', accepted: 2, cursor: 2, changes: [] })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/sync', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer token' }) }))
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ protocolVersion: 2, collectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, cursor: 0 })
})

test('preflights the service and gives an actionable upgrade result without posting local changes', async () => {
  const fetcher = vi.fn().mockResolvedValue(health(CLIENT_COLLECTION_SCHEMA_VERSION + 1, CLIENT_COLLECTION_SCHEMA_VERSION + 1))

  await expect(preflightSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, fetcher)).resolves.toMatchObject({ state: 'upgrade-required', target: 'this-device', requiredSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION + 1 })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/health')
})

test('does not upload media or acknowledge local operations when the preflight requires an app update', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Words')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  const fetcher = vi.fn().mockResolvedValue(health(15, 15))

  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'upgrade-required', target: 'pc-service' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/health')
  await expect(collection.pendingOperations()).resolves.not.toHaveLength(0)
  await collection.delete()
})

test('distinguishes authentication and unreachable service failures', async () => {
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockResolvedValue(new Response('', { status: 401 })))).resolves.toEqual({ state: 'authentication-required' })
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockRejectedValue(new TypeError('network')))).resolves.toEqual({ state: 'unreachable' })
})

test('surfaces an automatic PC backup failure without misreporting it as a network outage', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'backup-failed', error: 'Media abc is missing. Restore it before syncing.' }), { status: 507 }))
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [{ opId: 'one' }], fetcher)).resolves.toEqual({ state: 'backup-failed', message: 'Media abc is missing. Restore it before syncing.' })
})

test('invalidates local undo before an in-flight sync can capture review operations', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const deck = await collection.createDeck('Undo sync', now)
    const note = await collection.createBasicNote(deck.id, { front: '戻す', back: 'restore' }, now)
    const card = (await collection.cards.where('noteId').equals(note.id).first())!
    await collection.answer(card.id, Rating.Good, now)
    const fetcher = vi.fn(async () => {
      await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
      throw new TypeError('network')
    })
    await expect(syncCollection(collection, fetcher)).resolves.toMatchObject({ state: 'unreachable' })
    expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(1)
    expect(await collection.pendingOperations()).not.toHaveLength(0)
  } finally {
    await collection.delete()
  }
})

test('also invalidates undo for a review recorded during sync preflight', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const deck = await collection.createDeck('Concurrent review', now)
    const note = await collection.createBasicNote(deck.id, { front: '同時', back: 'concurrent' }, now)
    const card = (await collection.cards.where('noteId').equals(note.id).first())!
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/api/health')) {
        await collection.answer(card.id, Rating.Good, now)
        expect(await collection.latestReviewUndo()).not.toBeNull()
        return health()
      }
      await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
      return new Response(JSON.stringify({ accepted: 4, cursor: 4, changes: [] }), { status: 200 })
    })
    await expect(syncCollection(collection, fetcher)).resolves.toMatchObject({ state: 'complete' })
    expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(1)
  } finally {
    await collection.delete()
  }
})

test('pairs a collection and persists only the returned device credential', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deviceId: 'phone-1', token: 'device-token' }), { status: 201 }))

  await expect(pairCollection(collection, 'https://pc.example.test/', 'ABCD1234', fetcher)).resolves.toEqual({ state: 'paired' })
  await expect(collection.syncSettings()).resolves.toEqual({ endpoint: 'https://pc.example.test', token: 'device-token', cursor: 0 })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/pair', expect.objectContaining({ method: 'POST' }))
  await collection.delete()
})

test('keeps existing sync settings when pairing fails', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://old.example.test', token: 'old-token', cursor: 5 })

  await expect(pairCollection(collection, 'https://pc.example.test', 'wrong', vi.fn().mockResolvedValue(new Response('', { status: 400 })))).resolves.toEqual({ state: 'pairing-error' })
  await expect(collection.syncSettings()).resolves.toEqual({ endpoint: 'https://old.example.test', token: 'old-token', cursor: 5 })
  await collection.delete()
})

test('does not send pairing codes to a non-loopback HTTP endpoint', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const fetcher = vi.fn()

  await expect(pairCollection(collection, 'http://192.168.1.20:4174', 'code', fetcher)).resolves.toEqual({ state: 'pairing-error' })
  expect(fetcher).not.toHaveBeenCalled()
  await collection.delete()
})

test('syncs a configured collection, applies remote reviews, and clears acknowledged operations', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  const fetcher = vi.fn((url: string) => Promise.resolve(url.endsWith('/api/health')
    ? health()
    : new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [{ opId: 'review-1', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: card.id, deckId: deck.id, rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }] }), { status: 200 })))
  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 1 })
  await expect(collection.reviewEntries.count()).resolves.toBe(1)
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  await collection.delete()
})

test('reports a media upload failure separately while syncing card changes', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  const fetcher = vi.fn((url: string) => url.endsWith('/api/health')
    ? Promise.resolve(health())
    : url.includes('/api/media/')
    ? Promise.resolve(new Response('', { status: 503 }))
    : Promise.resolve(new Response(JSON.stringify({ accepted: 3, cursor: 3, changes: [] }), { status: 200 })))

  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', accepted: 3, media: { uploaded: 0, downloaded: 0, pending: 1, uploadError: 'unreachable' } })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/sync', expect.anything())
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  await collection.delete()
})

test('downloads remote media even when an unrelated local upload fails', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['local'], 'local.png', { type: 'image/png' }), side: 'front' })
  const remoteBytes = new TextEncoder().encode('remote')
  const remoteDigest = await digestMedia(new Blob([remoteBytes], { type: 'image/png' }))
  const remoteReference = { id: 'remote-media', noteId: note.id, digest: remoteDigest, kind: 'image' as const, mimeType: 'image/png', displayName: 'remote.png', side: 'front' as const, playback: 'manual' as const, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/api/health')) return Promise.resolve(health())
    if (url.endsWith(`/api/media/${remoteDigest}`)) return Promise.resolve(new Response(remoteBytes, { status: 200, headers: { 'x-content-sha256': remoteDigest, 'content-type': 'image/png' } }))
    if (url.includes('/api/media/')) return Promise.resolve(new Response('', { status: 503 }))
    return Promise.resolve(new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [{ opId: 'remote-media-op', entityType: 'noteMedia', entityId: remoteReference.id, action: 'create', occurredAt: remoteReference.createdAt, payload: remoteReference }] }), { status: 200 }))
  })

  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', media: { uploaded: 0, downloaded: 1, pending: 1, uploadError: 'unreachable' } })
  await expect(collection.verifiedMediaBlob(remoteDigest)).resolves.toMatchObject({ digest: remoteDigest })
  await collection.delete()
})
