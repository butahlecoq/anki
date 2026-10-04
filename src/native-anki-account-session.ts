import initSqlJs, { type SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { SyncSettings } from './collection.js'
import { createPairedAnkiWebTransport } from './native-anki-account-client.js'
import { openNativeAnkiAccountStores } from './native-anki-account.js'
import { nativeAnkiProjectionData } from './native-anki-projection.js'
import { NativeAnkiClient, type NativeRequestOptions } from './native-anki-sync.js'

export interface NativeAnkiAccountDeck { id: number; name: string; path: string }
export interface NativeAnkiAccountSession {
  username: string
  client: NativeAnkiClient
  state: Awaited<ReturnType<typeof openNativeAnkiAccountStores>>['state']
  media: Awaited<ReturnType<typeof openNativeAnkiAccountStores>>['media']
  decks: NativeAnkiAccountDeck[]
  disconnect(): void
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
