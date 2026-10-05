import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BASIC_NOTE_TYPE_ID, createCollection } from './collection'
import { readCollectionRecoverySnapshot, snapshotBeforeCollectionUpgrade } from './upgrade-recovery'

const openDatabases: Dexie[] = []

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.delete()))
})

describe('pre-upgrade local recovery snapshot', () => {
  test('snapshots populated prior-schema notes, review history, pending sync, and media before migration', async () => {
    const name = `kiroku-upgrade-${crypto.randomUUID()}`
    const old = new Dexie(name)
    openDatabases.push(old)
    old.version(5).stores({
      decks: 'id, name, createdAt', notes: 'id, deckId, updatedAt', cards: 'id, deckId, noteId, due, state',
      reviewEntries: 'id, cardId, deckId, reviewedAt', outbox: 'opId, entityType, entityId, occurredAt', settings: 'key',
      receivedOperations: 'opId', deletedEntities: 'key, entityType, entityId, occurredAt', noteMedia: 'id, noteId, digest, side, kind, updatedAt', mediaBlobs: 'digest, verifiedAt',
    })
    await old.table('decks').add({ id: 'deck', name: 'Offline', createdAt: '2026-10-01', updatedAt: '2026-10-01' })
    await old.table('notes').add({ id: 'note', deckId: 'deck', type: 'basic', fields: { front: '猫', back: 'cat' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' })
    await old.table('cards').add({ id: 'card', deckId: 'deck', noteId: 'note', due: '2026-10-02', stability: 4, difficulty: 5, elapsedDays: 1, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 0, state: 2, lastReview: '2026-10-01' })
    await old.table('reviewEntries').add({ id: 'review', cardId: 'card', deckId: 'deck', rating: 3, state: 2, due: '2026-10-02', stability: 4, difficulty: 5, elapsedDays: 1, lastElapsedDays: 1, scheduledDays: 2, learningSteps: 0, reviewedAt: '2026-10-01' })
    expect(await old.table('reviewEntries').count()).toBe(1)
    await old.table('outbox').add({ opId: 'offline-edit', entityType: 'note', entityId: 'note', action: 'update', occurredAt: '2026-10-01', payload: { id: 'note', fields: { front: '猫', back: 'cat' } } })
    const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    await old.table('noteMedia').add({ id: 'media-ref', noteId: 'note', digest: 'a'.repeat(64), displayName: 'cat.png', side: 'front', kind: 'image', mimeType: 'image/png', byteLength: 4, createdAt: '2026-10-01', updatedAt: '2026-10-01' })
    await old.table('mediaBlobs').add({ digest: 'a'.repeat(64), blob: image, byteLength: 4, mimeType: 'image/png', verifiedAt: '2026-10-01' })
    expect(old.verno).toBe(5)
    old.close()
    const rawCheck = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(await new Promise<number>((resolve, reject) => {
      const request = rawCheck.transaction('reviewEntries').objectStore('reviewEntries').count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })).toBe(1)
    rawCheck.close()

    const manifest = await snapshotBeforeCollectionUpgrade(name, 16)
    expect(manifest).toMatchObject({ sourceDatabase: name, sourceVersion: 5, targetVersion: 16, totalRecords: 7 })
    const recovery = await readCollectionRecoverySnapshot(name)
    expect(recovery.records).toHaveLength(7)
    expect(recovery.records.find((record) => record.storeName === 'mediaBlobs')?.value).toMatchObject({ byteLength: 4, blob: image })
    expect(recovery.records.find((record) => record.storeName === 'outbox')?.value).toMatchObject({ opId: 'offline-edit' })

    const migrated = createCollection(name)
    openDatabases.push(migrated)
    await expect(migrated.notes.get('note')).resolves.toMatchObject({ typeId: BASIC_NOTE_TYPE_ID, fields: { front: '猫', back: 'cat' } })
    await expect(migrated.cards.get('card')).resolves.toMatchObject({ id: 'card', reps: 2 })
    await expect(migrated.reviewEntries.get('review')).resolves.toMatchObject({ id: 'review', cardId: 'card' })
    await expect(migrated.pendingOperations()).resolves.toMatchObject([expect.objectContaining({ opId: 'offline-edit' })])
    await expect(migrated.mediaBlobs.get('a'.repeat(64))).resolves.toMatchObject({ byteLength: 4 })
    expect((await readCollectionRecoverySnapshot(name)).manifest?.sourceVersion).toBe(5)
  })

  test('keeps the previous verified generation when a replacement snapshot runs out of space', async () => {
    const name = `kiroku-upgrade-${crypto.randomUUID()}`
    const old = new Dexie(name)
    openDatabases.push(old)
    old.version(1).stores({ notes: 'id' })
    await old.table('notes').add({ id: 'note', front: 'original' })
    old.close()
    await snapshotBeforeCollectionUpgrade(name, 2)

    const update = new Dexie(name)
    openDatabases.push(update)
    update.version(1).stores({ notes: 'id' })
    await update.table('notes').update('note', { front: 'newer' })
    update.close()

    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('quota exhausted', 'QuotaExceededError') })
    try { await expect(snapshotBeforeCollectionUpgrade(name, 2)).rejects.toMatchObject({ name: 'QuotaExceededError' }) }
    finally { put.mockRestore() }

    const recovery = await readCollectionRecoverySnapshot(name)
    expect(recovery.records.find((record) => record.storeName === 'notes')?.value).toEqual({ id: 'note', front: 'original' })
  })

  test('does not duplicate storage when the collection is already on the current version', async () => {
    const name = `kiroku-upgrade-${crypto.randomUUID()}`
    const current = createCollection(name)
    openDatabases.push(current)
    await current.createDeck('Current collection')
    await expect(snapshotBeforeCollectionUpgrade(name, current.verno)).resolves.toBeNull()
  })

  test('copies records across multiple bounded batches without changing their keys', async () => {
    const name = `kiroku-upgrade-${crypto.randomUUID()}`
    const old = new Dexie(name)
    openDatabases.push(old)
    old.version(1).stores({ notes: 'id' })
    await old.table('notes').bulkAdd(Array.from({ length: 300 }, (_, index) => ({ id: `note-${String(index).padStart(3, '0')}`, field: index })))
    old.close()

    const manifest = await snapshotBeforeCollectionUpgrade(name, 2)
    const recovery = await readCollectionRecoverySnapshot(name)
    expect(manifest).toMatchObject({ sourceVersion: 1, targetVersion: 2, totalRecords: 300 })
    expect(recovery.records).toHaveLength(300)
    expect(recovery.records.find((record) => record.recordKey === 'note-299')?.value).toEqual({ id: 'note-299', field: 299 })
  })
})
