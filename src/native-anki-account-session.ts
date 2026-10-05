import initSqlJs, { type SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { SyncSettings } from './collection.js'
import type { Collection } from './collection.js'
import { prepareAnkiDataImport, type AnkiImportCommitOptions, type PreparedAnkiImport } from './anki-import.js'
import { createPairedAnkiWebTransport } from './native-anki-account-client.js'
import { openNativeAnkiAccountStores } from './native-anki-account.js'
import { nativeAnkiProjectionData } from './native-anki-projection.js'
import { NativeAnkiClient, nativeSnapshotHash, type NativeRequestOptions } from './native-anki-sync.js'

export interface NativeAnkiAccountDeck { id: number; name: string; path: string }
export interface NativeAnkiAccountSession {
  username: string
  client: NativeAnkiClient
  state: Awaited<ReturnType<typeof openNativeAnkiAccountStores>>['state']
  media: Awaited<ReturnType<typeof openNativeAnkiAccountStores>>['media']
  sourceIdentity: string
  decks: NativeAnkiAccountDeck[]
  disconnect(): void
}

export interface PreparedNativeAccountImport {
  readonly revision: number
  readonly snapshotHash: string
  readonly prepared: PreparedAnkiImport
  commit(options?: AnkiImportCommitOptions): Promise<void>
}

let sqlPromise: Promise<SqlJsStatic> | undefined
function nativeSql() {
  return sqlPromise ??= initSqlJs({ locateFile: () => sqlWasmUrl })
}

/** Logs in through the paired PC relay, downloads a read-only native snapshot,
 * and lists its decks. Password and host key remain in this returned
 * in-memory session; only the existing native account checkpoint is persisted. */
export async function connectNativeAnkiAccount(
  settings: SyncSettings,
  username: string,
  password: string,
  options: NativeRequestOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<NativeAnkiAccountSession> {
  const identity = username.trim().normalize('NFC')
  if (!identity || !password) throw new Error('Enter your AnkiWeb username and password.')
  const stores = await openNativeAnkiAccountStores(identity)
  try {
    const SQL = await nativeSql()
    const client = await NativeAnkiClient.login(createPairedAnkiWebTransport(settings, fetcher), identity, password, options)
    const snapshot = await client.downloadCollection(SQL, options)
    const existing = await stores.state.checkpoint()
    await stores.state.replace(snapshot, existing?.revision ?? null)
    const current = await stores.state.checkpoint()
    if (!current) throw new Error('The downloaded AnkiWeb collection could not be retained locally.')
    const decks = nativeAnkiProjectionData(SQL, current.collection).decks
      .map((deck) => {
        const path = deck.name.replaceAll('\u001f', '::')
        return { id: deck.id, path, name: path.split('::').at(-1) ?? path }
      })
      .sort((left, right) => left.path.localeCompare(right.path))
    return {
      username: identity,
      client,
      state: stores.state,
      media: stores.media,
      sourceIdentity: stores.identity,
      decks,
      disconnect() {
        stores.state.close()
        stores.media.close()
      },
    }
  } catch (error) {
    stores.state.close()
    stores.media.close()
    throw error
  }
}

/** Builds an inspectable Import Plan from the durable account snapshot. The
 * account checkpoint and identity manifest remain authoritative and are saved
 * before the learner can commit the copy into their editable collection. */
export async function prepareNativeAccountImport(session: NativeAnkiAccountSession, collection: Collection): Promise<PreparedNativeAccountImport> {
  const SQL = await nativeSql()
  const checkpoint = await session.state.checkpoint()
  if (!checkpoint) throw new Error('The account snapshot is unavailable. Connect again before importing it.')
  const manifest = await session.state.saveProjectionManifest(SQL, checkpoint.revision)
  const snapshotHash = await nativeSnapshotHash(checkpoint.collection)
  if (manifest.snapshotHash !== snapshotHash) throw new Error('The account snapshot changed before its Import Plan was prepared. Preview it again.')
  const data = nativeAnkiProjectionData(SQL, checkpoint.collection)
  if (!data.notes.length || !data.cards.length) throw new Error('The account collection is empty. Nothing was copied into this device.')
  const media = await session.media?.verifiedFiles() ?? []
  const projection = media.length ? nativeAnkiProjectionData(SQL, checkpoint.collection, media) : data
  const prepared = await prepareAnkiDataImport(projection, collection, { SQL, sourceIdentity: session.sourceIdentity, sourceFingerprint: snapshotHash })
  return {
    revision: checkpoint.revision,
    snapshotHash,
    prepared,
    async commit(options) {
      const current = await session.state.checkpoint()
      if (!current || current.revision !== checkpoint.revision || await nativeSnapshotHash(current.collection) !== snapshotHash) {
        throw new Error('The account snapshot changed after this Import Plan was prepared. Preview the latest snapshot before importing.')
      }
      await prepared.commit(options)
    },
  }
}
