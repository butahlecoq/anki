import { NativeSyncError } from './native-anki-sync.js'

export function nativeAnkiAccountErrorMessage(error: unknown) {
  if (!(error instanceof NativeSyncError)) return 'The AnkiWeb connection could not be completed.'
  if (error.code === 'upgrade') return 'AnkiWeb needs an update. Update this app before trying again; your account data remains safe.'
  if (error.code === 'authentication') return 'AnkiWeb rejected the username or password. Check them and try again.'
  if (error.code === 'service-authentication') return 'This device is no longer paired with the PC service. Reconnect it, then try again.'
  if (error.code === 'transfer' && /unavailable|interrupted/i.test(error.message)) return 'The PC relay could not reach AnkiWeb or the transfer was interrupted. Check connectivity and retry.'
  return error.message
}
