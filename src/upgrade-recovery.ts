interface SnapshotManifest {
  id: 'latest'
  generationId: string
  sourceDatabase: string
  sourceVersion: number
  targetVersion: number
  createdAt: string
  stores: { name: string; records: number }[]
  totalRecords: number
}

interface SnapshotRecord {
  generationId: string
  storeName: string
  recordKey: IDBValidKey
  value: unknown
}

const recoveryPrefix = 'kiroku-upgrade-recovery-'
const recordsPerBatch = 128

function recoveryDatabaseName(sourceName: string) {
  let hash = 2166136261
  for (let index = 0; index < sourceName.length; index += 1) hash = Math.imul(hash ^ sourceName.charCodeAt(index), 16777619)
  return `${recoveryPrefix}${(hash >>> 0).toString(36)}`
}

function describeFailure(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  const detail = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : undefined
  const result = new Error(typeof detail?.message === 'string' ? detail.message : fallback)
  if (typeof detail?.name === 'string') result.name = detail.name
  return result
}

function openExistingDatabase(name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    let createdDuringProbe = false
    request.onupgradeneeded = (event) => {
      if ((event as IDBVersionChangeEvent).oldVersion !== 0) return
      createdDuringProbe = true
      request.transaction?.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => createdDuringProbe ? resolve(undefined) : reject(request.error ?? new Error('Unable to inspect the local collection version.'))
    request.onblocked = () => reject(new Error('Another tab is blocking the local collection version check.'))
  })
}

function openRecoveryDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore('manifest', { keyPath: 'id' })
      const records = database.createObjectStore('records', { keyPath: ['generationId', 'storeName', 'recordKey'] })
      records.createIndex('generationId', 'generationId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open the local recovery snapshot.'))
    request.onblocked = () => reject(new Error('Another tab is blocking the local recovery snapshot.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('The recovery snapshot transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('The recovery snapshot transaction was aborted.'))
  })
}

function readBatch(source: IDBDatabase, storeName: string, afterKey?: IDBValidKey): Promise<{ rows: { key: IDBValidKey; value: unknown }[]; lastKey?: IDBValidKey; complete: boolean }> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try { transaction = source.transaction([storeName], 'readonly') }
    catch (error) { reject(describeFailure(error, `Unable to read collection data from ${storeName}.`)); return }
    const rows: { key: IDBValidKey; value: unknown }[] = []
    let lastKey = afterKey
    let reachedEnd = false
    const range = afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true)
    const request = transaction.objectStore(storeName).openCursor(range)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { reachedEnd = true; return }
      rows.push({ key: cursor.primaryKey, value: cursor.value })
      lastKey = cursor.primaryKey
      if (rows.length < recordsPerBatch) cursor.continue()
    }
    transaction.onerror = () => reject(transaction.error ?? new Error(`Unable to read collection data from ${storeName}.`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Reading collection data from ${storeName} was aborted.`))
    transaction.oncomplete = () => resolve({ rows, lastKey, complete: reachedEnd })
  })
}

async function writeBatch(recovery: IDBDatabase, rows: SnapshotRecord[]) {
  if (!rows.length) return
  const transaction = recovery.transaction('records', 'readwrite')
  const done = transactionDone(transaction)
  const records = transaction.objectStore('records')
  try { for (const row of rows) records.put(row) }
  catch (error) {
    try { transaction.abort() } catch { /* The transaction may already have aborted. */ }
    await done.catch(() => undefined)
    throw describeFailure(error, 'The local recovery snapshot could not be written.')
  }
  await done
}

async function deleteGeneration(recovery: IDBDatabase, generationId: string) {
  const transaction = recovery.transaction('records', 'readwrite')
  const done = transactionDone(transaction)
  const request = transaction.objectStore('records').index('generationId').openCursor(IDBKeyRange.only(generationId))
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    cursor.delete()
    cursor.continue()
  }
  await done
}

async function removeOldGenerations(recovery: IDBDatabase, generationId: string) {
  const transaction = recovery.transaction('records', 'readwrite')
  const done = transactionDone(transaction)
  const request = transaction.objectStore('records').openCursor()
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    if ((cursor.value as SnapshotRecord).generationId !== generationId) cursor.delete()
    cursor.continue()
  }
  await done
}

/** Keep the last complete snapshot visible until a newer generation is committed. */
export async function snapshotBeforeCollectionUpgrade(sourceName: string, targetVersion: number): Promise<SnapshotManifest | null> {
  const source = await openExistingDatabase(sourceName)
  if (!source) return null
  // Dexie multiplies logical versions by ten in IndexedDB to reserve migration steps.
  const sourceVersion = source.version / 10
  if (sourceVersion >= targetVersion) { source.close(); return null }

  let recovery: IDBDatabase | undefined
  let generationId: string | undefined
  try {
    recovery = await openRecoveryDatabase(recoveryDatabaseName(sourceName))
    const currentGenerationId = crypto.randomUUID()
    generationId = currentGenerationId
    const stores: SnapshotManifest['stores'] = []
    for (const storeName of Array.from(source.objectStoreNames)) {
      let count = 0
      let lastKey: IDBValidKey | undefined
      let complete = false
      while (!complete) {
        const batch = await readBatch(source, storeName, lastKey)
        await writeBatch(recovery, batch.rows.map((row) => ({ generationId: currentGenerationId, storeName, recordKey: row.key, value: row.value })))
        count += batch.rows.length
        lastKey = batch.lastKey
        complete = batch.complete
      }
      stores.push({ name: storeName, records: count })
    }

    const manifest: SnapshotManifest = {
      id: 'latest', generationId: currentGenerationId, sourceDatabase: sourceName, sourceVersion, targetVersion,
      createdAt: new Date().toISOString(), stores, totalRecords: stores.reduce((total, store) => total + store.records, 0),
    }
    const transaction = recovery.transaction('manifest', 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore('manifest').put(manifest)
    await done
    await removeOldGenerations(recovery, currentGenerationId).catch(() => undefined)
    return manifest
  } catch (error) {
    if (recovery && generationId) await deleteGeneration(recovery, generationId).catch(() => undefined)
    throw describeFailure(error, 'The local recovery snapshot could not be completed.')
  } finally {
    recovery?.close()
    source.close()
  }
}

export async function readCollectionRecoveryManifest(sourceName: string): Promise<SnapshotManifest | undefined> {
  const recovery = await openRecoveryDatabase(recoveryDatabaseName(sourceName))
  try {
    return await new Promise((resolve, reject) => {
      const transaction = recovery.transaction('manifest', 'readonly')
      const request = transaction.objectStore('manifest').get('latest')
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read the local recovery manifest.'))
      transaction.oncomplete = () => resolve(request.result as SnapshotManifest | undefined)
    })
  } finally { recovery.close() }
}

export async function readCollectionRecoverySnapshot(sourceName: string): Promise<{ manifest?: SnapshotManifest; records: SnapshotRecord[] }> {
  const recovery = await openRecoveryDatabase(recoveryDatabaseName(sourceName))
  try {
    return await new Promise((resolve, reject) => {
      const transaction = recovery.transaction('manifest', 'readonly')
      const request = transaction.objectStore('manifest').get('latest')
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read the local recovery snapshot.'))
      transaction.oncomplete = () => {
        const manifest = request.result as SnapshotManifest | undefined
        if (!manifest) { resolve({ records: [] }); return }
        const recordsTransaction = recovery.transaction('records', 'readonly')
        const records = recordsTransaction.objectStore('records').index('generationId').getAll(manifest.generationId)
        recordsTransaction.onerror = () => reject(recordsTransaction.error ?? new Error('Unable to read the local recovery snapshot records.'))
        recordsTransaction.oncomplete = () => resolve({ manifest, records: records.result as SnapshotRecord[] })
      }
    })
  } finally { recovery.close() }
}
