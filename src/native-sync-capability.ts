import { NativeSyncError } from './native-anki-sync'

export function requireWebLocks(feature: 'Anki account' | 'Anki media') {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new NativeSyncError('unsupported', `${feature} sync is unavailable because this browser does not provide the Web Locks API. Keep this app open and use a browser configuration with Web Locks before syncing; the local checkpoint is unchanged.`)
  }
  return navigator.locks
}
