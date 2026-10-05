import { NativeAnkiMedia } from './native-anki-media.js'
import { NativeAnkiState } from './native-anki-state.js'

export interface NativeAnkiAccountStorageNames {
  state: string
  media: string
}

/** Account data is kept in separate browser databases. The username is used
 * only to derive a stable opaque namespace; credentials and the username are
 * never written to either database or included in diagnostics. Logging out
 * must close these stores without deleting them. */
export async function nativeAnkiAccountStorageNames(username: string): Promise<NativeAnkiAccountStorageNames> {
  const identity = username.trim().normalize('NFC')
  if (!identity || identity.length > 256) throw new Error('Enter a valid AnkiWeb username.')
  const input = new TextEncoder().encode(`kiroku-native-account-v1\0${identity}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  const suffix = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const namespace = `kiroku-native-v1-${suffix}`
  return { state: `${namespace}-state`, media: `${namespace}-media` }
}

/** Opens the durable account stores without persisting login credentials.
 * Callers keep NativeAnkiClient in memory only and retain these stores on
 * logout so study data is not silently erased. */
export async function openNativeAnkiAccountStores(username: string) {
  const names = await nativeAnkiAccountStorageNames(username)
  return { identity: names.state, state: new NativeAnkiState(names.state), media: new NativeAnkiMedia(names.media) }
}
