import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { createCollection, type Collection } from './collection'
import { readDeckOfflineMedia, prepareDeckOfflineMedia } from './deck-media-readiness'

const collections: Collection[] = []
function database() {
  const collection = createCollection(`deck-verification-${crypto.randomUUID()}`)
  collections.push(collection)
  return collection
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(collections.splice(0).map((collection) => collection.removeLocalCollection())) })

async function replaceVersionedBytes(databaseName: string, digest: string, length: number) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction('mediaBlobs', 'readwrite')
    const store = transaction.objectStore('mediaBlobs')
    const request = store.get(digest)
    request.onsuccess = () => store.put({ ...request.result, blob: new Uint8Array(length).fill(0).buffer, contentVersion: crypto.randomUUID() })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

test('a 12-digest Deck bounds body fetch and hash work and reuses unchanged verification', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const shared = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  const files = Array.from({ length: 12 }, (_, index) => new File([`media-${String(index).padStart(2, '0')}`], `image-${index}.png`, { type: 'image/png' }))
  await collection.attachMediaBatch(note.id, files.map((file) => ({ file, side: 'front' as const })))
  await collection.attachMedia(shared.id, { file: files[0]!, side: 'front' })

  const originalRead = collection.verifiedMediaBlob.bind(collection)
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let activeReads = 0, peakReads = 0, fetchedBytes = 0
  let activeHashes = 0, peakHashes = 0, hashedBytes = 0
  let releaseReads!: () => void, releaseHashes!: () => void
  const heldReads = new Promise<void>((resolve) => { releaseReads = resolve })
  const heldHashes = new Promise<void>((resolve) => { releaseHashes = resolve })
  const reads = vi.spyOn(collection, 'verifiedMediaBlob').mockImplementation(async (digest) => {
    activeReads += 1
    peakReads = Math.max(peakReads, activeReads)
    try {
      await heldReads
      const row = await originalRead(digest)
      fetchedBytes += row?.byteLength ?? 0
      return row
    } finally { activeReads -= 1 }
  })
  const hashes = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    activeHashes += 1
    peakHashes = Math.max(peakHashes, activeHashes)
    hashedBytes += data.byteLength
    try { await heldHashes; return await originalDigest(algorithm, data) }
    finally { activeHashes -= 1 }
  })

  const first = readDeckOfflineMedia(collection, deck.id)
  try {
    await vi.waitFor(() => expect(reads.mock.calls).toHaveLength(4))
    expect(peakReads).toBe(4)
  } finally { releaseReads() }
  try {
    await vi.waitFor(() => expect(hashes.mock.calls).toHaveLength(4))
    expect(peakHashes).toBe(4)
  } finally { releaseHashes() }
  expect(await first).toMatchObject({ required: 12, missing: 0, state: 'ready' })
  expect(reads).toHaveBeenCalledTimes(12)
  expect(hashes).toHaveBeenCalledTimes(12)
  expect({ fetchedBytes, hashedBytes, peakReads, peakHashes }).toEqual({ fetchedBytes: 96, hashedBytes: 96, peakReads: 4, peakHashes: 4 })

  await collection.updateBasicNote(note.id, { front: '猫 updated', back: 'cat' })
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 12, missing: 0, state: 'ready' })
  expect(reads).toHaveBeenCalledTimes(24)
  expect(fetchedBytes).toBe(192)
  expect(hashes).toHaveBeenCalledTimes(12)
})

test('content replacement, eviction, a new reference, and another Collection invalidate cached readiness', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 0, state: 'ready' })

  await replaceVersionedBytes(collection.databaseName, media.digest, 9)
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })
  expect(await prepareDeckOfflineMedia(collection, deck.id, { synchronize: async () => ({ state: 'authentication-required' }) })).toMatchObject({ state: 'authentication-required', readiness: { missing: 1 } })
  await collection.storeDownloadedMedia(media.digest, new Blob(['cat image'], { type: 'image/png' }))
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 0, state: 'ready' })
  await collection.evictCachedMedia(media.digest)
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })

  const otherTab = createCollection(collection.databaseName)
  try {
    await otherTab.storeDownloadedMedia(media.digest, new Blob(['cat image'], { type: 'image/png' }), new Date('2026-10-14T12:00:00.000Z'))
    const hashes = vi.spyOn(crypto.subtle, 'digest')
    expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 0, state: 'ready' })
    expect(hashes).toHaveBeenCalledTimes(1)
  } finally { otherTab.closeLocalCollection() }

  const next = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  await collection.attachMedia(next.id, { file: new File(['dog image'], 'dog.png', { type: 'image/png' }), side: 'front' })
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 2, missing: 0, state: 'ready' })
})

test('a held verification recounts references and content after a concurrent change', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  const actualRead = collection.verifiedMediaBlob.bind(collection)
  let release!: () => void, started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  vi.spyOn(collection, 'verifiedMediaBlob').mockImplementationOnce(async (digest) => {
    const row = await actualRead(digest)
    started()
    await held
    return row
  })
  const pending = readDeckOfflineMedia(collection, deck.id)
  await entered
  const next = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  await collection.attachMedia(next.id, { file: new File(['dog image'], 'dog.png', { type: 'image/png' }), side: 'front' })
  release()
  expect(await pending).toMatchObject({ required: 2, missing: 0, state: 'ready' })

  let releaseSecond!: () => void, startedSecond!: () => void
  const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve })
  const enteredSecond = new Promise<void>((resolve) => { startedSecond = resolve })
  vi.spyOn(collection, 'verifiedMediaBlob').mockImplementationOnce(async (digest) => {
    const row = await actualRead(digest)
    startedSecond()
    await heldSecond
    return row
  })
  const pendingContent = readDeckOfflineMedia(collection, deck.id)
  await enteredSecond
  await collection.evictCachedMedia(media.digest)
  releaseSecond()
  expect(await pendingContent).toMatchObject({ required: 2, missing: 1, state: 'missing' })
})

test('a failed worker releases the bounded run before a retry verifies the Deck', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMediaBatch(note.id, Array.from({ length: 6 }, (_, index) => ({ file: new File([`image-${index}`], `${index}.png`, { type: 'image/png' }), side: 'front' as const })))
  const actualRead = collection.verifiedMediaBlob.bind(collection)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let firstFailure = true
  const reads = vi.spyOn(collection, 'verifiedMediaBlob').mockImplementation(async (digest) => {
    if (firstFailure) { firstFailure = false; throw new Error('read failed') }
    await held
    return actualRead(digest)
  })
  const pending = readDeckOfflineMedia(collection, deck.id)
  let settled = false
  void pending.catch(() => { settled = true })
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(4))
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await expect(pending).rejects.toThrow('read failed')
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 6, missing: 0, state: 'ready' })
})

test('a transient Blob read error keeps reactive readiness conservative and allows a retry', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementationOnce(() => { throw new DOMException('The I/O read operation failed.', 'NotReadableError') })
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 1, state: 'missing' })
  expect(await readDeckOfflineMedia(collection, deck.id)).toMatchObject({ required: 1, missing: 0, state: 'ready' })
})

test('explicit preparation verifies a shared unchanged body only once', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const first = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const second = await collection.createBasicNote(deck.id, { front: '犬', back: 'dog' })
  await collection.attachMedia(first.id, { file: new File(['shared image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.attachMedia(second.id, { file: new File(['shared image'], 'dog.png', { type: 'image/png' }), side: 'front' })
  const hashes = vi.spyOn(crypto.subtle, 'digest')
  expect(await prepareDeckOfflineMedia(collection, deck.id)).toMatchObject({ state: 'ready', readiness: { required: 1, missing: 0 } })
  expect(hashes).toHaveBeenCalledTimes(1)
})

test('preparation preserves a valid replacement written while corrupt bytes are being hashed', async () => {
  const collection = database()
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await replaceVersionedBytes(collection.databaseName, media.digest, 9)
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let release!: () => void, started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    started()
    await held
    return originalDigest(algorithm, data)
  })
  const pending = prepareDeckOfflineMedia(collection, deck.id)
  await entered
  await collection.storeDownloadedMedia(media.digest, new Blob(['cat image'], { type: 'image/png' }))
  release()
  expect(await pending).toMatchObject({ state: 'ready', readiness: { missing: 0 } })
  expect(await collection.verifiedMediaBlob(media.digest)).toBeDefined()
})
