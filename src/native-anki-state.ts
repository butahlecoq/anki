import Dexie, { type Table } from 'dexie'
import type { SqlJsStatic } from 'sql.js'
import { NativeAnkiClient, NativeSyncConflict, NativeSyncError } from './native-anki-sync'

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
}
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
  constructor(name = 'kiroku-native-account') {
    super(name)
    this.version(1).stores({ checkpoints: 'id', attempts: 'id', conflicts: 'id, createdAt' })
  }
  async checkpoint() { return this.checkpoints.get('collection') }
  async recovery() { return this.attempts.get('active') }

  /** The caller must obtain the user's explicit full-sync direction decision
   * before invoking replacement, and retain a separate recoverable backup. */
  async replace(collection: Uint8Array, expectedRevision: number | null) {
    await this.transaction('rw', this.checkpoints, this.attempts, async () => {
      const current = await this.checkpoint()
      if ((current?.revision ?? null) !== expectedRevision || await this.recovery()) throw this.concurrentChange()
      await this.checkpoints.put({ id: 'collection', revision: (current?.revision ?? 0) + 1, collection: collection.slice(), updatedAt: Date.now() })
    })
  }

  async synchronize(client: NativeAnkiClient, SQL: SqlJsStatic) { return this.exclusive(() => this.run(client, SQL, false)) }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new NativeSyncError('upgrade', 'Account synchronization requires browser support for exclusive storage operations.')
    return navigator.locks.request(`${this.name}:sync`, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) throw new NativeSyncError('transfer', 'Another page is synchronizing this account. Wait for it to finish.')
      return action()
    })
  }
  private async run(client: NativeAnkiClient, SQL: SqlJsStatic, recovering: boolean) {
    const base = await this.transaction('rw', this.checkpoints, this.attempts, this.conflicts, async () => {
      const checkpoint = await this.checkpoint()
      if (!checkpoint) throw new NativeSyncError('protocol', 'Choose and preview the initial account sync direction first.')
      const attempt = await this.recovery()
      if (recovering) {
        if (!attempt || checkpoint.revision !== attempt.baseRevision || await this.conflicts.count()) throw new NativeSyncError('conflict', 'Resolve retained versions before recovering this account sync.')
      } else if (attempt) throw new NativeSyncError('transfer', 'A previous account sync needs recovery before starting another session.')
      await this.attempts.put({ id: 'active', baseRevision: checkpoint.revision, startedAt: Date.now(), status: 'running' })
      return checkpoint
    })
    try {
      const result = await client.syncCollection(SQL, base.collection)
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
  async recover(client: NativeAnkiClient, SQL: SqlJsStatic) {
    return this.exclusive(() => this.run(client, SQL, true))
  }
  private concurrentChange() { return new NativeSyncError('conflict', 'The native collection changed in another operation. Preserve both checkpoints and retry.') }
}
