import { createCollection } from '../../src/collection'

/**
 * Simulates bytes damaged outside the app (for example by browser storage
 * corruption). This fixture intentionally uses the browser IndexedDB API so
 * production Collection callers never need a media-table mutation operation.
 */
export async function damageIndexedDbMediaBlob(databaseName: string, digest: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB fixture.'))
  })
  try {
    const transaction = database.transaction('mediaBlobs', 'readwrite')
    const store = transaction.objectStore('mediaBlobs')
    const request = store.get(digest)
    request.onsuccess = () => {
      const row = request.result as { digest: string; blob: ArrayBuffer | Blob; byteLength: number; mimeType: string; verifiedAt: string } | undefined
      if (!row) throw new Error(`Missing media fixture ${digest}.`)
      row.blob = new Uint8Array(row.byteLength).fill(0).buffer
      store.put(row)
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not damage IndexedDB fixture.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB fixture transaction aborted.'))
    })
  } finally {
    database.close()
  }
}

async function putIndexedDbFixtureRow(databaseName: string, storeName: string, row: unknown) {
  const fixtureCollection = createCollection(databaseName)
  await fixtureCollection.openLocalCollection()
  await fixtureCollection.closeLocalCollection()
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB fixture.'))
  })
  try {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(row)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not write IndexedDB fixture.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB fixture transaction aborted.'))
    })
  } finally {
    database.close()
  }
}

/** Seeds impossible-by-current-rules identities left by historical deck imports. */
export async function seedLegacyDeckCollision(databaseName: string, fixture: {
  decks: readonly unknown[]
  note?: unknown
  card?: unknown
  review?: unknown
  noteDeletionUndo?: unknown
}) {
  const storeNames = ['decks', ...(fixture.note ? ['notes'] : []), ...(fixture.card ? ['cards'] : []), ...(fixture.review ? ['reviewEntries'] : []), ...(fixture.noteDeletionUndo ? ['settings'] : [])]
  const fixtureCollection = createCollection(databaseName)
  await fixtureCollection.openLocalCollection()
  await fixtureCollection.closeLocalCollection()
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB fixture.'))
  })
  try {
    const transaction = database.transaction(storeNames, 'readwrite')
    for (const deck of fixture.decks) transaction.objectStore('decks').put(deck)
    if (fixture.note) transaction.objectStore('notes').put(fixture.note)
    if (fixture.card) transaction.objectStore('cards').put(fixture.card)
    if (fixture.review) transaction.objectStore('reviewEntries').put(fixture.review)
    if (fixture.noteDeletionUndo) transaction.objectStore('settings').put({ key: 'noteDeletionUndo', value: fixture.noteDeletionUndo })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not seed historical deck fixture.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Historical deck fixture transaction aborted.'))
    })
  } finally {
    database.close()
  }
}

/** Stores a pre-migration byte-backed media row to exercise legacy conversion. */
export function insertIndexedDbLegacyMediaBlob(databaseName: string, row: { digest: string; blob: ArrayBuffer; byteLength: number; mimeType: string; verifiedAt: string }) {
  return putIndexedDbFixtureRow(databaseName, 'mediaBlobs', row)
}

/** Corrupts a persisted receipt as if storage changed outside the application. */
export function overwriteIndexedDbBackupReceipt(databaseName: string, receipt: unknown) {
  return putIndexedDbFixtureRow(databaseName, 'settings', { key: 'lastVerifiedPcBackup', value: receipt })
}

/** Persists a legacy card suspension representation for compatibility checks. */
export function overwriteIndexedDbLegacyCard(databaseName: string, card: unknown) {
  return putIndexedDbFixtureRow(databaseName, 'cards', card)
}

/** Stores malformed synchronized note-type content for reviewer recovery checks. */
export function overwriteIndexedDbLegacyNoteType(databaseName: string, noteType: unknown) {
  return putIndexedDbFixtureRow(databaseName, 'noteTypes', noteType)
}

/** Makes a dangling note-type reference to exercise bulk-operation rollback. */
export function overwriteIndexedDbLegacyNote(databaseName: string, note: unknown) {
  return putIndexedDbFixtureRow(databaseName, 'notes', note)
}

/** Removes a row as if it vanished outside the application (for corruption tests). */
export async function deleteIndexedDbFixtureRow(databaseName: string, storeName: string, key: IDBValidKey) {
  const fixtureCollection = createCollection(databaseName)
  await fixtureCollection.openLocalCollection()
  await fixtureCollection.closeLocalCollection()
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB fixture.'))
  })
  try {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).delete(key)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete IndexedDB fixture row.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB fixture transaction aborted.'))
    })
  } finally { database.close() }
}
