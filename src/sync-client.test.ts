import { expect, test, vi } from 'vitest'
import { connectPrivatePc, createAndDownloadPcBackup, foregroundSync, pairCollection, preflightSync, rotateCredential, syncCollection, type SyncProgress } from './sync-client'
import { createCollection, DEFAULT_DECK_OPTION_GROUP_ID, Rating } from './collection'
import { digestMedia } from './media'
import { readCardReviewHistory, readCardsForNote, readDeck, readNoteMediaReference } from './collection-queries'
import { CLIENT_COLLECTION_SCHEMA_VERSION, SYNC_OPERATION_BATCH_SIZE, SYNC_REQUESTS_PER_ATTEMPT } from '../sync-capabilities.js'

const health = (collectionSchemaVersion = CLIENT_COLLECTION_SCHEMA_VERSION, maximumCollectionSchemaVersion = CLIENT_COLLECTION_SCHEMA_VERSION) => new Response(JSON.stringify({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion, maximumCollectionSchemaVersion, collectionGeneration: '11111111-1111-4111-8111-111111111111', requiresCollectionGeneration: false, store: 'sqlite' }), { status: 200 })

test('automatic private PC connection keeps local work and reuses its saved credential without codes or collection exchange', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const deck = await collection.createDeck('Local words')
  await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const pending = await collection.pendingOperations()
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ automatic: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'private-device-token', collectionGeneration: '11111111-1111-4111-8111-111111111111' }), { status: 201 }))
  await expect(connectPrivatePc(collection, 'https://owner.example.test', fetcher)).resolves.toEqual({ state: 'paired' })
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['https://owner.example.test/api/connection', 'https://owner.example.test/api/connection'])
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ deviceId: expect.any(String) })
  expect(await collection.syncSettings()).toMatchObject({ endpoint: 'https://owner.example.test', token: 'private-device-token', cursor: 0 })
  expect(await collection.pendingOperations()).toEqual(pending)
  await expect(connectPrivatePc(collection, 'https://owner.example.test', fetcher)).resolves.toEqual({ state: 'paired' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await collection.removeLocalCollection()
})

test.each([
  ['private identity rejected', 403, undefined, 'authentication-required'],
  ['PC unavailable', 503, undefined, 'unreachable'],
  ['manual deployment', 200, { automatic: false }, 'manual'],
  ['unexpected discovery', 200, {}, 'unreachable'],
] as const)('automatic connection preserves local work when %s', async (_case, status, payload, state) => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    const deck = await collection.createDeck('Offline work')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    await collection.attachMedia(note.id, { file: new File(['local media'], 'cat.png', { type: 'image/png' }), side: 'front' })
    const pending = await collection.pendingOperations()
    const media = await collection.missingReferencedMedia()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }))
    await expect(connectPrivatePc(collection, 'https://owner.example.test', fetcher)).resolves.toEqual({ state })
    expect(await collection.syncSettings()).toBeUndefined()
    expect(await collection.pendingOperations()).toEqual(pending)
    expect(await collection.missingReferencedMedia()).toEqual(media)
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await collection.removeLocalCollection() }
})

test.each([403, 503])('failed automatic credential issuance (%s) leaves local changes queued', async status => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.createDeck('Keep me')
    const pending = await collection.pendingOperations()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ automatic: true })))
      .mockResolvedValueOnce(new Response('', { status }))
    await expect(connectPrivatePc(collection, 'https://owner.example.test', fetcher)).resolves.toEqual({ state: status === 403 ? 'authentication-required' : 'unreachable' })
    expect(await collection.syncSettings()).toBeUndefined()
    expect(await collection.pendingOperations()).toEqual(pending)
  } finally { await collection.removeLocalCollection() }
})

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
  await collection.removeLocalCollection()
})

test('holds local sync changes when the PC requires a newer collection generation', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 3, collectionGeneration: 'old-generation' })
    const deck = await collection.createDeck('Offline recovery')
    await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const response = new Response(JSON.stringify({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, maximumCollectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, collectionGeneration: 'new-generation', requiresCollectionGeneration: true, store: 'sqlite' }), { status: 200 })
    const fetcher = vi.fn().mockResolvedValue(response)

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'collection-generation-required' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(collection.pendingOperations()).resolves.not.toHaveLength(0)
  } finally { await collection.removeLocalCollection() }
})

test('distinguishes authentication and unreachable service failures', async () => {
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockResolvedValue(new Response('', { status: 401 })))).resolves.toEqual({ state: 'authentication-required' })
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockRejectedValue(new TypeError('network')))).resolves.toEqual({ state: 'unreachable' })
})

test('surfaces an automatic PC backup failure without misreporting it as a network outage', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'backup-failed', error: 'Media abc is missing. Restore it before syncing.' }), { status: 507 }))
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [{ opId: 'one' }], fetcher)).resolves.toEqual({ state: 'backup-failed', message: 'Media abc is missing. Restore it before syncing.' })
})

for (const [kind, responseBytes] of [
  ['corrupted', new Uint8Array([1, 2, 99, 4])],
  ['truncated', new Uint8Array([1, 2])],
] as const) {
  test(`rejects a ${kind} PC backup body even when its digest header matches the manifest`, async () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4])
    const archiveSha256 = await digestMedia(new Blob([originalBytes]))
    const manifest = { format: 'kiroku-server-backup', formatVersion: 1, id: crypto.randomUUID(), createdAt: '2026-10-03T10:00:00.000Z', reason: 'manual', collectionSchemaVersion: 16, changeCount: 2, latestCursor: 2, databaseBytes: 1, databaseSha256: 'a'.repeat(64), media: [], archiveSha256, archiveBytes: originalBytes.byteLength }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 201 }))
      .mockResolvedValueOnce(new Response(responseBytes.slice().buffer as ArrayBuffer, { status: 200, headers: { 'x-content-sha256': archiveSha256 } }))
    await expect(createAndDownloadPcBackup({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, fetcher)).rejects.toThrow(/failed its size or SHA-256 check/i)
  })
}

test('rotates credentials only through a safe authenticated service endpoint', async () => {
  const settings = { endpoint: 'https://pc.example.test/', token: 'old-token', cursor: 8 }
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'new-token' }), { status: 200 }))

  await expect(rotateCredential(settings, fetcher)).resolves.toEqual({ state: 'rotated', token: 'new-token' })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/credential/rotate', expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer old-token' } }))
  await expect(rotateCredential(settings, vi.fn().mockResolvedValue(new Response('', { status: 401 })))).resolves.toEqual({ state: 'authentication-required' })
  await expect(rotateCredential(settings, vi.fn().mockRejectedValue(new TypeError('connection dropped')))).resolves.toEqual({ state: 'indeterminate' })
  await expect(rotateCredential(settings, vi.fn().mockResolvedValue(new Response('', { status: 500 })))).resolves.toEqual({ state: 'indeterminate' })
  await expect(rotateCredential(settings, vi.fn().mockResolvedValue(new Response('not json', { status: 200 })))).resolves.toEqual({ state: 'indeterminate' })
  const insecureFetcher = vi.fn()
  await expect(rotateCredential({ ...settings, endpoint: 'http://192.168.1.2' }, insecureFetcher)).resolves.toEqual({ state: 'unreachable' })
  expect(insecureFetcher).not.toHaveBeenCalled()
})

test('invalidates local undo before an in-flight sync can capture review operations', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const deck = await collection.createDeck('Undo sync', now)
    const note = await collection.createBasicNote(deck.id, { front: '戻す', back: 'restore' }, now)
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
    await collection.answer(card.id, Rating.Good, now)
    const fetcher = vi.fn(async () => {
      await expect(collection.undo()).rejects.toThrow(/sync attempt/i)
      throw new TypeError('network')
    })
    await expect(syncCollection(collection, fetcher)).resolves.toMatchObject({ state: 'unreachable' })
    expect(await readCardReviewHistory(collection, card.id).then(entries => entries.length)).toBe(1)
    expect(await collection.pendingOperations()).not.toHaveLength(0)
  } finally {
    await collection.removeLocalCollection()
  }
})

test('also invalidates undo for a review recorded during sync preflight', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const now = new Date('2026-10-01T12:00:00.000Z')
    const deck = await collection.createDeck('Concurrent review', now)
    const note = await collection.createBasicNote(deck.id, { front: '同時', back: 'concurrent' }, now)
    const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
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
    expect(await readCardReviewHistory(collection, card.id).then(entries => entries.length)).toBe(1)
  } finally {
    await collection.removeLocalCollection()
  }
})

test.each(['https://pc.example.test', 'http://127.0.0.1:4174', 'http://localhost:4174'])('pairs at allowed address %s and persists only the returned device credential', async endpoint => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deviceId: 'phone-1', token: 'device-token' }), { status: 201 }))

  await expect(pairCollection(collection, `${endpoint}/`, 'ABCD1234', fetcher)).resolves.toEqual({ state: 'paired' })
  await expect(collection.syncSettings()).resolves.toEqual({ endpoint, token: 'device-token', cursor: 0 })
  expect(fetcher).toHaveBeenCalledWith(`${endpoint}/api/pair`, expect.objectContaining({ method: 'POST' }))
  await collection.removeLocalCollection()
})

test('does not pair old local history onto a replacement PC collection', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const settings = { endpoint: 'https://pc.example.test', token: 'old-token', cursor: 5, collectionGeneration: 'old-generation' }
  await collection.configureSync(settings)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ collectionGeneration: 'new-generation', requiresCollectionGeneration: true }), { status: 200 }))

  await expect(pairCollection(collection, settings.endpoint, 'new-code', fetcher)).resolves.toEqual({ state: 'collection-generation-required' })
  await expect(collection.syncSettings()).resolves.toEqual(settings)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await collection.removeLocalCollection()
})

test('does not treat pre-generation local sync settings as a clean device after restore', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const settings = { endpoint: 'https://pc.example.test', token: 'legacy-token', cursor: 7 }
  await collection.configureSync(settings)
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ collectionGeneration: 'new-generation', requiresCollectionGeneration: true }), { status: 200 }))

  await expect(pairCollection(collection, settings.endpoint, 'new-code', fetcher)).resolves.toEqual({ state: 'collection-generation-required' })
  await expect(collection.syncSettings()).resolves.toEqual(settings)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await collection.removeLocalCollection()
})

test('keeps existing sync settings when pairing fails', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://old.example.test', token: 'old-token', cursor: 5 })

  await expect(pairCollection(collection, 'https://pc.example.test', 'wrong', vi.fn().mockResolvedValue(new Response('', { status: 400 })))).resolves.toEqual({ state: 'pairing-error' })
  await expect(collection.syncSettings()).resolves.toEqual({ endpoint: 'https://old.example.test', token: 'old-token', cursor: 5 })
  await collection.removeLocalCollection()
})

test('keeps unreachable service distinct from a rejected code without changing sync settings', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const settings = { endpoint: 'https://old.example.test', token: 'old-token', cursor: 5 }
  try {
    await collection.configureSync(settings)
    const fetcher = vi.fn().mockRejectedValue(new TypeError('connection refused'))
    await expect(pairCollection(collection, 'http://localhost:4174', 'code', fetcher)).resolves.toEqual({ state: 'unreachable' })
    await expect(collection.syncSettings()).resolves.toEqual(settings)
    expect(fetcher).toHaveBeenCalled()
  } finally { await collection.removeLocalCollection() }
})

test.each(['not-a-url', 'http://192.168.1.20:4174', 'file:///private-collection'])('identifies invalid address %s without sending a pairing code', async endpoint => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  const fetcher = vi.fn()

  await expect(pairCollection(collection, endpoint, 'code', fetcher)).resolves.toEqual({ state: 'address-error' })
  expect(fetcher).not.toHaveBeenCalled()
  await collection.removeLocalCollection()
})

test('syncs a configured collection, applies remote reviews, and clears acknowledged operations', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const card = (await readCardsForNote(collection, note.id).then(cards => cards[0]))!
  const fetcher = vi.fn((url: string) => Promise.resolve(url.endsWith('/api/health')
    ? health()
    : new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [{ opId: 'review-1', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: card.id, deckId: deck.id, rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }] }), { status: 200 })))
  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 1 })
  await expect(readCardReviewHistory(collection, card.id).then(entries => entries.length)).resolves.toBe(1)
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  await collection.removeLocalCollection()
})

test('sends pending collection changes in bounded batches and acknowledges each durable response', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    await collection.enqueueOperations(Array.from({ length: SYNC_OPERATION_BATCH_SIZE * 2 + 5 }, (_, index) => ({
      opId: `batch-${index}`, entityType: 'note', entityId: `note-${index}`, action: 'update',
      occurredAt: new Date(1_800_000_000_000 + index).toISOString(), payload: { id: `note-${index}`, value: index },
    })))
    let cursor = 0
    const requests: { cursor: number; operationCount: number }[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      const request = JSON.parse(String(init?.body)) as { cursor: number; operations: { opId: string }[] }
      requests.push({ cursor: request.cursor, operationCount: request.operations.length })
      cursor += request.operations.length
      return Promise.resolve(new Response(JSON.stringify({ accepted: request.operations.length, cursor, changes: [], hasMore: false }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', accepted: SYNC_OPERATION_BATCH_SIZE * 2 + 5, cursor: SYNC_OPERATION_BATCH_SIZE * 2 + 5 })
    expect(requests.map((request) => request.operationCount)).toEqual([SYNC_OPERATION_BATCH_SIZE, SYNC_OPERATION_BATCH_SIZE, 5])
    expect(requests.map((request) => request.cursor)).toEqual([0, SYNC_OPERATION_BATCH_SIZE, SYNC_OPERATION_BATCH_SIZE * 2])
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: SYNC_OPERATION_BATCH_SIZE * 2 + 5 })
  } finally { await collection.removeLocalCollection() }
})

test('replays a batch with stable operation IDs after the server commits but its response is lost', async () => {
  const databaseName = `kiroku-test-${crypto.randomUUID()}`
  let collection = createCollection(databaseName)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    await collection.enqueueOperation({ opId: 'lost-response-op', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1', value: true } })
    const committed = new Set<string>()
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      const request = JSON.parse(String(init?.body)) as { operations: { opId: string }[] }
      const accepted = request.operations.filter((operation) => {
        if (committed.has(operation.opId)) return false
        committed.add(operation.opId)
        return true
      }).length
      if (fetcher.mock.calls.filter(([calledURL]) => String(calledURL).endsWith('/api/sync')).length === 1) return Promise.reject(new TypeError('connection dropped after server commit'))
      return Promise.resolve(new Response(JSON.stringify({ accepted, cursor: committed.size, changes: [], hasMore: false }), { status: 200 }))
    })

    const interruptedProgress: SyncProgress[] = []
    await expect(syncCollection(collection, fetcher as typeof fetch, (progress) => interruptedProgress.push(progress))).resolves.toMatchObject({ state: 'unreachable' })
    expect(interruptedProgress).toContainEqual(expect.objectContaining({ phase: 'retry', task: 'records', pending: 1, cursor: 0 }))
    expect(interruptedProgress.some((progress) => progress.phase === 'complete')).toBe(false)
    await expect(collection.pendingOperations()).resolves.toHaveLength(1)
    collection.closeLocalCollection()
    collection = createCollection(databaseName)
    await expect(collection.pendingOperations()).resolves.toHaveLength(1)
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: 0 })
    const resumedProgress: SyncProgress[] = []
    await expect(syncCollection(collection, fetcher as typeof fetch, (progress) => resumedProgress.push(progress))).resolves.toMatchObject({ state: 'complete', accepted: 0, cursor: 1 })
    expect(resumedProgress.at(-1)).toMatchObject({ phase: 'complete', accepted: 0, cursor: 1, conflicts: 0, media: { pending: 0 } })
    expect(committed).toEqual(new Set(['lost-response-op']))
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  } finally { await collection.removeLocalCollection() }
})

test('resumes at the acknowledged batch when a later committed batch loses its response', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    await collection.enqueueOperations(Array.from({ length: SYNC_OPERATION_BATCH_SIZE * 2 + 5 }, (_, index) => ({
      opId: `resume-${index}`, entityType: 'note' as const, entityId: `note-${index}`, action: 'update' as const,
      occurredAt: new Date(1_800_000_000_000 + index).toISOString(), payload: { id: `note-${index}`, value: index },
    })))
    const committed = new Set<string>()
    let syncRequests = 0
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      const request = JSON.parse(String(init?.body)) as { operations: { opId: string }[] }
      syncRequests += 1
      const accepted = request.operations.filter((operation) => {
        if (committed.has(operation.opId)) return false
        committed.add(operation.opId)
        return true
      }).length
      if (syncRequests === 2) return Promise.reject(new TypeError('response lost after durable batch commit'))
      return Promise.resolve(new Response(JSON.stringify({ accepted, cursor: 0, changes: [], hasMore: false }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'unreachable' })
    await expect(collection.pendingOperations()).resolves.toHaveLength(SYNC_OPERATION_BATCH_SIZE + 5)
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: 0 })
    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', accepted: 5 })
    expect(committed.size).toBe(SYNC_OPERATION_BATCH_SIZE * 2 + 5)
    await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  } finally { await collection.removeLocalCollection() }
})

test('does not split an unsent revision parent from its child at a batch boundary', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const occurredAt = '2026-10-01T12:00:00.000Z'
    await collection.enqueueOperations([
      { opId: 'z-parent', entityType: 'note', entityId: 'note-chain', action: 'update', occurredAt, payload: { id: 'note-chain', front: 'parent' } },
      { opId: 'a-child', entityType: 'note', entityId: 'note-chain', action: 'update', occurredAt, payload: { id: 'note-chain', front: 'child' }, parents: ['z-parent'] },
      ...Array.from({ length: SYNC_OPERATION_BATCH_SIZE - 1 }, (_, index) => ({ opId: `b-filler-${index.toString().padStart(3, '0')}`, entityType: 'note' as const, entityId: `note-${index}`, action: 'update' as const, occurredAt, payload: { id: `note-${index}` } })),
    ])
    const committed = new Set<string>()
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      const request = JSON.parse(String(init?.body)) as { operations: { opId: string; parents?: string[] }[] }
      for (const operation of request.operations) {
        if (operation.parents?.some((parent) => !committed.has(parent) && !request.operations.some((item) => item.opId === parent))) return Promise.resolve(new Response('', { status: 400 }))
      }
      for (const operation of request.operations) committed.add(operation.opId)
      return Promise.resolve(new Response(JSON.stringify({ accepted: request.operations.length, cursor: committed.size, changes: [], hasMore: false }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', accepted: SYNC_OPERATION_BATCH_SIZE + 1 })
    const requests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/sync')).map(([, init]) => (JSON.parse(String(init?.body)) as { operations: { opId: string }[] }).operations)
    expect(requests).toHaveLength(2)
    expect(requests[0].map((operation) => operation.opId)).toContain('z-parent')
    expect(requests[0].map((operation) => operation.opId)).not.toContain('a-child')
    expect(requests[1].map((operation) => operation.opId)).toEqual(['a-child'])
  } finally { await collection.removeLocalCollection() }
})

test('follows paginated remote changes and durably advances the cursor after each page', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const change = (id: string, name: string, cursor: number) => ({ cursor, opId: `remote-${id}`, entityType: 'deck', entityId: id, action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id, name, parentId: null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' } })
    const syncCursors: number[] = []
    let page = 0
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      syncCursors.push((JSON.parse(String(init?.body)) as { cursor: number }).cursor)
      page += 1
      return Promise.resolve(new Response(JSON.stringify({
        accepted: 0,
        cursor: page,
        changes: [change(`remote-${page}`, `Remote ${page}`, page)],
        hasMore: page === 1,
      }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 2 })
    expect(syncCursors).toEqual([0, 1])
    await expect(readDeck(collection, 'remote-1')).resolves.toMatchObject({ name: 'Remote 1' })
    await expect(readDeck(collection, 'remote-2')).resolves.toMatchObject({ name: 'Remote 2' })
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: 2 })
  } finally { await collection.removeLocalCollection() }
})

test('caps one sync attempt and reports remote work that must resume on the next attempt', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let keepPaging = true
    let requests = 0
    const fetcher = vi.fn((url: string) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      requests += 1
      return Promise.resolve(new Response(JSON.stringify({ accepted: 0, cursor: 0, changes: [], hasMore: keepPaging }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'incomplete', pendingOperations: 0, remoteChangesPending: true })
    expect(requests).toBe(SYNC_REQUESTS_PER_ATTEMPT)
    keepPaging = false
    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 0 })
    expect(requests).toBe(SYNC_REQUESTS_PER_ATTEMPT + 1)
  } finally { await collection.removeLocalCollection() }
})

test('resumes a long paginated backlog and retained child from its durable cursor after the client restarts', async () => {
  const databaseName = `kiroku-test-${crypto.randomUUID()}`
  let collection = createCollection(databaseName)
  let online = true
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (!online) return Promise.reject(new TypeError('network offline'))
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      const request = JSON.parse(String(init?.body)) as { cursor: number }
      const cursor = request.cursor + 1
      const occurredAt = new Date(1_800_000_000_000 + cursor).toISOString()
      return Promise.resolve(new Response(JSON.stringify({
        accepted: 0,
        cursor,
        changes: [{ opId: `remote-${cursor}`, entityType: 'deck', entityId: `remote-${cursor}`, action: 'create', occurredAt, payload: { id: `remote-${cursor}`, name: `Remote ${cursor}`, parentId: cursor === 1 ? `remote-${SYNC_REQUESTS_PER_ATTEMPT + 1}` : null, optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID, createdAt: occurredAt, updatedAt: occurredAt } }],
        hasMore: cursor < SYNC_REQUESTS_PER_ATTEMPT + 1,
      }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'incomplete', cursor: SYNC_REQUESTS_PER_ATTEMPT, pendingOperations: 0, pendingIncomingOperations: 1, remoteChangesPending: true })
    await expect(readDeck(collection, 'remote-1')).resolves.toBeUndefined()
    await expect(readDeck(collection, `remote-${SYNC_REQUESTS_PER_ATTEMPT}`)).resolves.toMatchObject({ name: `Remote ${SYNC_REQUESTS_PER_ATTEMPT}` })
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: SYNC_REQUESTS_PER_ATTEMPT })

    collection.closeLocalCollection()
    collection = createCollection(databaseName)
    online = false
    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'unreachable' })
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: SYNC_REQUESTS_PER_ATTEMPT })

    online = true
    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: SYNC_REQUESTS_PER_ATTEMPT + 1 })
    await expect(readDeck(collection, 'remote-1')).resolves.toMatchObject({ parentId: `remote-${SYNC_REQUESTS_PER_ATTEMPT + 1}` })
    await expect(readDeck(collection, `remote-${SYNC_REQUESTS_PER_ATTEMPT + 1}`)).resolves.toMatchObject({ name: `Remote ${SYNC_REQUESTS_PER_ATTEMPT + 1}` })
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: SYNC_REQUESTS_PER_ATTEMPT + 1 })
  } finally { await collection.removeLocalCollection() }
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

  const progress: SyncProgress[] = []
  await expect(syncCollection(collection, fetcher as typeof fetch, (event) => progress.push(event))).resolves.toMatchObject({ state: 'complete', accepted: 3, media: { uploaded: 0, downloaded: 0, pending: 1, uploadError: 'unreachable' } })
  expect(progress).toContainEqual(expect.objectContaining({ phase: 'retry', task: 'upload', pending: 1 }))
  expect(progress.at(-1)).toMatchObject({ phase: 'complete', accepted: 3, conflicts: 0, media: { pending: 1 } })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/sync', expect.anything())
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  await collection.removeLocalCollection()
})

test('retries a media upload after the server stored it but the response was lost', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['image bytes'], 'cat.png', { type: 'image/png' }), side: 'front' })
  const objects = new Map<string, Uint8Array>()
  const putDigests: string[] = []
  let loseFirstPutResponse = true
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/api/health')) return health()
    if (url.includes('/api/media/')) {
      const digest = url.split('/').pop()!
      putDigests.push(digest)
      const alreadyStored = objects.has(digest)
      objects.set(digest, new Uint8Array(10))
      if (loseFirstPutResponse) { loseFirstPutResponse = false; throw new TypeError('response lost after object commit') }
      return new Response(JSON.stringify({ digest, byteLength: 10, mimeType: 'image/png', deduplicated: alreadyStored }), { status: 200 })
    }
    return new Response(JSON.stringify({ accepted: 3, cursor: 3, changes: [], hasMore: false }), { status: 200 })
  })

  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', media: { uploaded: 0, pending: 1, uploadError: 'unreachable' } })
  const retryResult = await syncCollection(collection, fetcher as typeof fetch)
  expect(retryResult).toMatchObject({ state: 'complete', media: { uploaded: 1, pending: 0 } })
  expect(objects.size).toBe(1)
  expect(putDigests).toHaveLength(2)
  expect(new Set(putDigests).size).toBe(1)
  await collection.removeLocalCollection()
})

test('does not expose downloaded media when its content digest fails verification', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese foundations')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const expectedDigest = await digestMedia(new Blob(['expected image'], { type: 'image/png' }))
  const reference = { id: 'remote-media', noteId: note.id, digest: expectedDigest, kind: 'image' as const, mimeType: 'image/png', displayName: 'remote.png', side: 'front' as const, playback: 'manual' as const, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/api/health')) return Promise.resolve(health())
    if (url.endsWith(`/api/media/${expectedDigest}`)) return Promise.resolve(new Response('tampered image', { status: 200, headers: { 'x-content-sha256': expectedDigest, 'content-type': 'image/png' } }))
    return Promise.resolve(new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [{ opId: 'remote-media-op', entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: reference.createdAt, payload: reference }] }), { status: 200 }))
  })

  await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', media: { downloaded: 0, pending: 1, downloadError: 'unreachable' } })
  await expect(collection.verifiedMediaBlob(expectedDigest)).resolves.toBeUndefined()
  await collection.removeLocalCollection()
})

test('resumes an interrupted remote media download after a client restart', async () => {
  const databaseName = `kiroku-test-${crypto.randomUUID()}`
  let collection = createCollection(databaseName)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const deck = await collection.createDeck('Japanese foundations')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const remoteBytes = new TextEncoder().encode('verified remote media')
    const remoteBlob = new Blob([remoteBytes], { type: 'image/png' })
    const remoteDigest = await digestMedia(remoteBlob)
    const createdAt = '2026-10-01T12:00:00.000Z'
    const reference = { id: 'interrupted-remote-media', noteId: note.id, digest: remoteDigest, kind: 'image' as const, mimeType: 'image/png', displayName: 'cat.png', side: 'front' as const, playback: 'manual' as const, createdAt, updatedAt: createdAt }
    let loseFirstDownload = true
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return Promise.resolve(health())
      if (url.endsWith(`/api/media/${remoteDigest}`)) {
        if (loseFirstDownload) { loseFirstDownload = false; return Promise.reject(new TypeError('network dropped during download')) }
        return Promise.resolve(new Response(remoteBytes, { status: 200, headers: { 'x-content-sha256': remoteDigest, 'content-type': 'image/png' } }))
      }
      const request = JSON.parse(String(init?.body)) as { operations: { opId: string }[]; cursor: number }
      return Promise.resolve(new Response(JSON.stringify({
        accepted: request.operations.length,
        cursor: 1,
        changes: request.cursor === 0 ? [{ cursor: 1, opId: 'remote-media-reference', entityType: 'noteMedia', entityId: reference.id, action: 'create', occurredAt: createdAt, payload: reference }] : [],
        hasMore: false,
      }), { status: 200 }))
    })

    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 1, media: { downloaded: 0, pending: 1, downloadError: 'unreachable' } })
    await expect(collection.syncSettings()).resolves.toMatchObject({ cursor: 1 })
    await expect(readNoteMediaReference(collection, reference.id)).resolves.toMatchObject({ digest: remoteDigest })
    await expect(collection.verifiedMediaBlob(remoteDigest)).resolves.toBeUndefined()

    collection.closeLocalCollection()
    collection = createCollection(databaseName)
    await expect(syncCollection(collection, fetcher as typeof fetch)).resolves.toMatchObject({ state: 'complete', cursor: 1, media: { downloaded: 1, pending: 0 } })
    await expect(collection.verifiedMediaBlob(remoteDigest)).resolves.toMatchObject({ digest: remoteDigest, byteLength: remoteBytes.byteLength })
    await expect(readNoteMediaReference(collection, reference.id)).resolves.toMatchObject({ digest: remoteDigest })
  } finally { await collection.removeLocalCollection() }
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
  await collection.removeLocalCollection()
})
