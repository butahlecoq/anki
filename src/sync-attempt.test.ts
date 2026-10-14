import 'fake-indexeddb/auto'
import { expect, test, vi } from 'vitest'
import { createCollection } from './collection'
import { syncCollection, type SyncProgress } from './sync-client'
import { prepareDeckOfflineMedia } from './deck-media-readiness'
import { CLIENT_COLLECTION_SCHEMA_VERSION } from '../sync-capabilities.js'

const health = () => new Response(JSON.stringify({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, maximumCollectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, collectionGeneration: '11111111-1111-4111-8111-111111111111', requiresCollectionGeneration: false, store: 'sqlite' }))
const complete = (cursor = 1) => new Response(JSON.stringify({ accepted: 0, cursor, changes: [], hasMore: false }))

test('overlapping callers share one collection transport attempt and both observe progress', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      entered()
      await held
      return complete()
    })
    const firstProgress: SyncProgress[] = []
    const secondProgress: SyncProgress[] = []
    const first = syncCollection(collection, fetcher as typeof fetch, (event) => firstProgress.push(event))
    await started
    const second = syncCollection(collection, fetcher as typeof fetch, (event) => secondProgress.push(event))
    release()
    expect(await first).toMatchObject({ state: 'complete', cursor: 1 })
    expect(await second).toMatchObject({ state: 'complete', cursor: 1 })
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/sync'))).toHaveLength(1)
    expect(firstProgress.some((event) => event.phase === 'complete')).toBe(true)
    expect(secondProgress.some((event) => event.phase === 'complete')).toBe(true)
  } finally { await collection.removeLocalCollection() }
})

test('a changed connection cannot receive an old cursor, and a new attempt may retry', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://old.example.test', token: 'old', cursor: 0 })
    await collection.createDeck('Local work')
    const pendingBefore = await collection.pendingOperations()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      if (url.startsWith('https://old.example.test')) { entered(); await held; return complete(9) }
      return complete(1)
    })
    const old = syncCollection(collection, fetcher as typeof fetch)
    await started
    await collection.configureSync({ endpoint: 'https://new.example.test', token: 'new', cursor: 0 })
    release()
    await old
    expect(await collection.syncSettings()).toMatchObject({ endpoint: 'https://new.example.test', cursor: 0 })
    expect(await collection.pendingOperations()).toEqual(pendingBefore)
    expect(await syncCollection(collection, fetcher as typeof fetch)).toMatchObject({ state: 'complete', cursor: 1 })
    expect(await collection.syncSettings()).toMatchObject({ endpoint: 'https://new.example.test', cursor: 1 })
  } finally { await collection.removeLocalCollection() }
})

test('detaching one progress observer keeps a shared attempt alive for the other', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      entered()
      await held
      return complete()
    })
    const detached: SyncProgress[] = []
    const remaining: SyncProgress[] = []
    const controller = new AbortController()
    const first = syncCollection(collection, fetcher as typeof fetch, (event) => detached.push(event), controller.signal)
    await started
    const second = syncCollection(collection, fetcher as typeof fetch, (event) => remaining.push(event))
    controller.abort()
    const countAtDetach = detached.length
    release()
    expect(await first).toMatchObject({ state: 'complete' })
    expect(await second).toMatchObject({ state: 'complete' })
    expect(detached).toHaveLength(countAtDetach)
    expect(remaining.some((event) => event.phase === 'complete')).toBe(true)
  } finally { await collection.removeLocalCollection() }
})

test('independent Collections sync concurrently and a finished attempt can retry', async () => {
  const first = createCollection(`sync-owner-${crypto.randomUUID()}`)
  const second = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await first.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    await second.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered = 0
    let bothEntered!: () => void
    const both = new Promise<void>((resolve) => { bothEntered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      entered += 1
      if (entered === 2) bothEntered()
      await held
      return complete()
    })
    const firstAttempt = syncCollection(first, fetcher as typeof fetch)
    const secondAttempt = syncCollection(second, fetcher as typeof fetch)
    await both
    release()
    expect(await firstAttempt).toMatchObject({ state: 'complete' })
    expect(await secondAttempt).toMatchObject({ state: 'complete' })
    expect(await syncCollection(first, fetcher as typeof fetch)).toMatchObject({ state: 'complete' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/sync'))).toHaveLength(3)
  } finally { await first.removeLocalCollection(); await second.removeLocalCollection() }
})

test('Sync now and Deck preparation share one held transport and both finish', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    const deck = await collection.createDeck('Japanese')
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
    const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
    await collection.evictCachedMedia(media.digest)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      if (url.endsWith('/api/sync')) { entered(); await held; return complete() }
      return new Response('cat image', { headers: { 'x-content-sha256': media.digest, 'content-type': 'image/png' } })
    })
    const settingsRead = vi.spyOn(collection, 'syncSettings')
    const syncNow = syncCollection(collection, fetcher as typeof fetch)
    await started
    const readsBeforePreparation = settingsRead.mock.calls.length
    const preparation = prepareDeckOfflineMedia(collection, deck.id, { synchronize: (owner) => syncCollection(owner, fetcher as typeof fetch) })
    await vi.waitFor(() => expect(settingsRead.mock.calls.length).toBeGreaterThan(readsBeforePreparation))
    release()
    expect(await syncNow).toMatchObject({ state: 'complete' })
    expect(await preparation).toMatchObject({ state: 'ready', readiness: { required: 1, missing: 0 } })
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/sync'))).toHaveLength(1)
  } finally { await collection.removeLocalCollection() }
})

test('a failed attempt releases ownership and the next call retries transport', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let recordCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      recordCalls += 1
      if (recordCalls === 1) throw new Error('Connection dropped')
      return complete()
    })
    expect(await syncCollection(collection, fetcher as typeof fetch)).toMatchObject({ state: 'unreachable' })
    expect(await syncCollection(collection, fetcher as typeof fetch)).toMatchObject({ state: 'complete' })
    expect(recordCalls).toBe(2)
  } finally { await collection.removeLocalCollection() }
})

test('a throwing progress observer cannot abort a joined durable sync or silence another observer', async () => {
  const collection = createCollection(`sync-owner-${crypto.randomUUID()}`)
  try {
    await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/health')) return health()
      entered()
      await held
      return complete()
    })
    const first = syncCollection(collection, fetcher as typeof fetch, (event) => { if (event.phase === 'complete') throw new Error('Unmounted observer') })
    await started
    const received: SyncProgress[] = []
    const second = syncCollection(collection, fetcher as typeof fetch, (event) => received.push(event))
    release()
    expect(await first).toMatchObject({ state: 'complete' })
    expect(await second).toMatchObject({ state: 'complete' })
    expect(received.some((event) => event.phase === 'complete')).toBe(true)
  } finally { await collection.removeLocalCollection() }
})
