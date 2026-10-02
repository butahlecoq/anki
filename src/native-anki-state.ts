import { Dexie, type Table } from 'dexie'
import type { SqlJsStatic } from 'sql.js'
import { NativeAnkiClient, NativeSyncConflict, NativeSyncError, nativeSnapshotHash, prepareNativeUpload, type NativeFullSyncDecision, type NativeRequestOptions, type NativeSyncMeta } from './native-anki-sync.js'

interface Checkpoint {
  id: 'collection'
  revision: number
  collection: Uint8Array
  updatedAt: number
}
interface Attempt {
  id: 'active'
  baseRevision: number
  startedAt: number
  status: 'running' | 'recovery-required'
  kind?: 'incremental' | 'full'
  direction?: 'upload' | 'download'
  preparedBackupId?: string
}
interface Backup { id: string; createdAt: number; baseRevision: number; reason: 'replacement' | 'full-sync-local' | 'full-sync-remote' | 'upload-prepared' | 'restore'; collection: Uint8Array; remote?: NativeSyncMeta }
interface Conflict {
  id: string
  createdAt: number
  baseRevision: number
  table: NativeSyncConflict['table']
  identity: number
  local: NativeSyncConflict['local']
  remote: NativeSyncConflict['remote']
}

/** Separate native account state has no credential fields and is never part
 * of application collection exports. A failed session retains its checkpoint,
 * recovery marker, and concrete conflicting versions for a resolution UI. */
export class NativeAnkiState extends Dexie {
  checkpoints!: Table<Checkpoint, string>
  attempts!: Table<Attempt, string>
  conflicts!: Table<Conflict, string>
  backups!: Table<Backup, string>
  constructor(name = 'kiroku-native-account') {
    super(name)
    this.version(1).stores({ checkpoints: 'id', attempts: 'id', conflicts: 'id, createdAt' })
    this.version(2).stores({ backups: 'id, createdAt, baseRevision' })
  }
  async checkpoint() { return this.checkpoints.get('collection') }
  async recovery() { return this.attempts.get('active') }

  /** Replacement retains the original checkpoint atomically. The caller must
   * still expose its intended direction before replacing account content. */
  async replace(collection: Uint8Array, expectedRevision: number | null) {
    await this.transaction('rw', this.checkpoints, this.attempts, this.backups, async () => {
      const current = await this.checkpoint()
      if ((current?.revision ?? null) !== expectedRevision || await this.recovery()) throw this.concurrentChange()
      if (current) await this.backups.put(this.backup(current, 'replacement'))
      await this.checkpoints.put({ id: 'collection', revision: (current?.revision ?? 0) + 1, collection: collection.slice(), updatedAt: Date.now() })
    })
  }
  private backup(checkpoint: Checkpoint, reason: Backup['reason'], remote?: NativeSyncMeta): Backup {
    return { id: crypto.randomUUID(), createdAt: Date.now(), baseRevision: checkpoint.revision, reason, collection: checkpoint.collection.slice(), ...(remote ? { remote } : {}) }
  }
  async previewFullSync(client: NativeAnkiClient, SQL: SqlJsStatic, options: NativeRequestOptions = {}) {
    const current = await this.checkpoint()
    if (!current) throw new NativeSyncError('protocol', 'A native local collection is required before choosing full-sync direction.')
    return { ...await client.previewFullSync(SQL, current.collection, options), localRevision: current.revision }
  }
  async fullSynchronize(client: NativeAnkiClient, SQL: SqlJsStatic, decision: NativeFullSyncDecision, options: NativeRequestOptions = {}) {
    return this.exclusive(async () => {
      if (decision.direction !== 'upload' && decision.direction !== 'download') throw new NativeSyncError('protocol', 'Choose an explicit full-sync direction before replacing either collection.')
      const current = await this.checkpoint()
      if (!current || current.revision !== decision.localRevision || await nativeSnapshotHash(current.collection) !== decision.localHash) throw this.concurrentChange()
      const prepared = decision.direction === 'upload' ? await prepareNativeUpload(SQL, current.collection) : undefined
      const preparedBackup = prepared ? this.backup({ ...current, collection: prepared }, 'upload-prepared') : undefined
      await this.transaction('rw', this.checkpoints, this.attempts, this.backups, async () => {
        const checkpoint = await this.checkpoint(), prior = await this.recovery()
        if (checkpoint?.revision !== current.revision || (prior && (prior.status !== 'recovery-required' || prior.baseRevision !== current.revision))) throw this.concurrentChange()
        await this.backups.put(this.backup(current, 'full-sync-local'))
        if (preparedBackup) await this.backups.put(preparedBackup)
        await this.attempts.put({ id: 'active', baseRevision: current.revision, startedAt: Date.now(), status: 'running', kind: 'full', direction: decision.direction, ...(preparedBackup ? { preparedBackupId: preparedBackup.id } : {}) })
      })
      try {
        const downloaded = await client.downloadWithRevision(SQL, decision.remote, options)
        // Remote backup must be durable before any destructive upload request.
        await this.backups.put(this.backup({ ...current, collection: downloaded.collection }, 'full-sync-remote', downloaded.remote))
        const collection = prepared ? await client.uploadPreparedCollection(SQL, prepared, downloaded.remote, options) : downloaded.collection
        await this.commitFull(current.revision, collection)
        return { outcome: 'synced' as const, direction: decision.direction, collection }
      } catch (error) { await this.attempts.update('active', { status: 'recovery-required' }); throw error }
    })
  }
  private async commitFull(revision: number, collection: Uint8Array) {
    await this.transaction('rw', this.checkpoints, this.attempts, async () => {
      if ((await this.checkpoint())?.revision !== revision || (await this.recovery())?.baseRevision !== revision) throw this.concurrentChange()
      await this.checkpoints.put({ id: 'collection', revision: revision + 1, collection, updatedAt: Date.now() })
      await this.attempts.delete('active')
    })
  }
  /** A lost upload response is verified by a read-only collection download;
   * this method never automatically retries a destructive upload. */
  async recoverFullSync(client: NativeAnkiClient, SQL: SqlJsStatic, options: NativeRequestOptions = {}) {
    return this.exclusive(async () => {
      const attempt = await this.recovery(), current = await this.checkpoint()
      if (attempt?.kind !== 'full' || current?.revision !== attempt.baseRevision) throw this.concurrentChange()
      if (attempt.direction !== 'upload' || !attempt.preparedBackupId) throw new NativeSyncError('conflict', 'Preview the current account revision and choose full-sync direction again. The original collection backup is retained.')
      const prepared = await this.backups.get(attempt.preparedBackupId)
      if (!prepared) throw new NativeSyncError('protocol', 'The prepared upload backup is unavailable. Restore a retained checkpoint before choosing direction again.')
      const collection = await client.verifyUploadedCollection(SQL, prepared.collection, options)
      await this.commitFull(current.revision, collection)
      return { outcome: 'synced' as const, direction: 'upload' as const, collection }
    })
  }
  async restoreBackup(id: string, expectedRevision: number) {
    return this.exclusive(async () => {
      await this.transaction('rw', this.checkpoints, this.attempts, this.backups, async () => {
        const backup = await this.backups.get(id), current = await this.checkpoint()
        if (!backup || current?.revision !== expectedRevision || await this.recovery()) throw this.concurrentChange()
        await this.backups.put(this.backup(current, 'restore'))
        await this.checkpoints.put({ id: 'collection', revision: current.revision + 1, collection: backup.collection.slice(), updatedAt: Date.now() })
      })
    })
  }

  async synchronize(client: NativeAnkiClient, SQL: SqlJsStatic, options: NativeRequestOptions = {}) { return this.exclusive(() => this.run(client, SQL, false, options)) }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new NativeSyncError('upgrade', 'Account synchronization requires browser support for exclusive storage operations.')
    return navigator.locks.request(`${this.name}:sync`, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) throw new NativeSyncError('transfer', 'Another page is synchronizing this account. Wait for it to finish.')
      return action()
    })
  }
  private async run(client: NativeAnkiClient, SQL: SqlJsStatic, recovering: boolean, options: NativeRequestOptions) {
    const base = await this.transaction('rw', this.checkpoints, this.attempts, this.conflicts, async () => {
      const checkpoint = await this.checkpoint()
      if (!checkpoint) throw new NativeSyncError('protocol', 'Choose and preview the initial account sync direction first.')
      const attempt = await this.recovery()
      if (recovering) {
        if (attempt?.kind === 'full') throw new NativeSyncError('conflict', 'Use full-sync recovery or preview a new explicit direction; a full upload is never retried automatically.')
        if (!attempt || checkpoint.revision !== attempt.baseRevision || await this.conflicts.filter((conflict) => conflict.baseRevision === checkpoint.revision).count()) throw new NativeSyncError('conflict', 'Resolve retained versions before recovering this account sync.')
      } else if (attempt) throw new NativeSyncError('transfer', 'A previous account sync needs recovery before starting another session.')
      await this.attempts.put({ id: 'active', baseRevision: checkpoint.revision, startedAt: Date.now(), status: 'running' })
      return checkpoint
    })
    try {
      const result = await client.syncCollection(SQL, base.collection, options)
      await this.transaction('rw', this.checkpoints, this.attempts, async () => {
        const current = await this.checkpoint(), attempt = await this.recovery()
        if (current?.revision !== base.revision || attempt?.baseRevision !== base.revision) throw this.concurrentChange()
        if ('collection' in result && result.outcome === 'synced') await this.checkpoints.put({ id: 'collection', revision: base.revision + 1, collection: result.collection, updatedAt: Date.now() })
        await this.attempts.delete('active')
      })
      return result
    } catch (error) {
      await this.transaction('rw', this.attempts, this.conflicts, async () => {
        await this.attempts.update('active', { status: 'recovery-required' })
        if (error instanceof NativeSyncConflict) await this.conflicts.put({ id: crypto.randomUUID(), createdAt: Date.now(), baseRevision: base.revision, table: error.table, identity: error.identity, local: error.local, remote: error.remote })
      })
      throw error
    }
  }

  /** Retry uses the original snapshot and native stable review identities.
   * This also handles a terminated page: a persisted running marker is never
   * assumed to mean that the remote finish did not commit. */
  async recover(client: NativeAnkiClient, SQL: SqlJsStatic, options: NativeRequestOptions = {}) {
    return this.exclusive(() => this.run(client, SQL, true, options))
  }
  private concurrentChange() { return new NativeSyncError('conflict', 'The native collection changed in another operation. Preserve both checkpoints and retry.') }
}
