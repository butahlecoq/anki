import type { SyncSettings } from './collection'

/** Cursor moves within a pairing; endpoint, credential and generation identify it. */
export const syncConnectionKey = (settings: SyncSettings) => JSON.stringify([settings.endpoint, settings.token, settings.collectionGeneration])
export const sameSyncConnection = (left: SyncSettings | undefined, right: SyncSettings) => Boolean(left && syncConnectionKey(left) === syncConnectionKey(right))
