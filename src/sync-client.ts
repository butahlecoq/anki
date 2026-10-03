import type { Collection, SyncOperation, SyncSettings } from './collection'
import { CLIENT_COLLECTION_SCHEMA_VERSION, SYNC_OPERATION_BATCH_SIZE, SYNC_REQUESTS_PER_ATTEMPT, SYNC_PROTOCOL_VERSION, type IncompatibleSync, type SyncHealth } from '../sync-capabilities.js'

type Fetcher = typeof fetch
type Change = { cursor: number; opId: string; entityType: string; entityId: string; action: string; occurredAt: string; payload: unknown }
export type MediaSyncProgress = { uploaded: number; downloaded: number; pending: number; uploadError?: 'authentication-required' | 'unreachable'; downloadError?: 'authentication-required' | 'unreachable' }
export type SyncProgress = { phase: 'records' | 'upload' | 'download'; completed: number; pending: number; cursor?: number; remoteChangesPending?: boolean }
type Complete = { state: 'complete'; accepted: number; cursor: number; changes: Change[]; hasMore?: boolean; media?: MediaSyncProgress }
type UpgradeRequired = { state: 'upgrade-required'; target: 'this-device' | 'pc-service'; message: string; requiredSchemaVersion?: number }
type SyncResult = Complete | UpgradeRequired | { state: 'authentication-required' } | { state: 'unreachable' } | { state: 'incomplete'; accepted: number; cursor: number; pendingOperations: number; remoteChangesPending: boolean }
type PreflightResult = { state: 'ready' } | Exclude<SyncResult, Complete>
export type PairingResult = { state: 'paired' } | { state: 'pairing-error' } | { state: 'unreachable' }

class MediaTransferError extends Error {
  constructor(readonly state: 'authentication-required' | 'unreachable') {
    super('Media transfer failed.')
  }
}

export async function uploadMedia(settings: SyncSettings, digest: string, blob: Blob, fetcher: Fetcher = fetch) {
  const response = await fetcher(`${settings.endpoint.replace(/\/$/, '')}/api/media/${digest}`, { method: 'PUT', headers: { authorization: `Bearer ${settings.token}`, 'content-type': blob.type }, body: blob })
  if (response.status === 401) throw new MediaTransferError('authentication-required')
  if (!response.ok) throw new MediaTransferError('unreachable')
  return response.json() as Promise<{ digest: string; byteLength: number; mimeType: string; deduplicated: boolean }>
}

export async function downloadMedia(settings: SyncSettings, digest: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`${settings.endpoint.replace(/\/$/, '')}/api/media/${digest}`, { headers: { authorization: `Bearer ${settings.token}` } })
  if (response.status === 401) throw new MediaTransferError('authentication-required')
  if (!response.ok || response.headers.get('x-content-sha256') !== digest) throw new MediaTransferError('unreachable')
  return new Blob([await response.arrayBuffer()], { type: response.headers.get('content-type') ?? '' })
}

function isSafeServiceEndpoint(endpoint: string) {
  try {
    const parsed = new URL(endpoint)
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname))
  } catch {
    return false
  }
}

function upgradeRequired(incompatibility: Partial<IncompatibleSync>, fallback: string): UpgradeRequired {
  const target = incompatibility.code === 'client-upgrade-required' ? 'this-device' : 'pc-service'
  return {
    state: 'upgrade-required',
    target,
    message: typeof incompatibility.message === 'string' ? incompatibility.message : fallback,
    ...(typeof incompatibility.requiredSchemaVersion === 'number' ? { requiredSchemaVersion: incompatibility.requiredSchemaVersion } : {}),
  }
}

export async function preflightSync(settings: SyncSettings, fetcher: Fetcher = fetch): Promise<PreflightResult> {
  if (!isSafeServiceEndpoint(settings.endpoint)) return { state: 'unreachable' }
  try {
    const response = await fetcher(`${settings.endpoint.replace(/\/$/, '')}/api/health`)
    if (!response.ok) return { state: 'unreachable' }
    const health = await response.json() as Partial<SyncHealth>
    if (health.protocolVersion !== SYNC_PROTOCOL_VERSION) return upgradeRequired({ code: 'server-upgrade-required' }, 'This PC sync service does not support the current sync protocol. Update the PC service, then try again.')
    if (typeof health.maximumCollectionSchemaVersion !== 'number' || health.maximumCollectionSchemaVersion < CLIENT_COLLECTION_SCHEMA_VERSION) {
      return upgradeRequired({ code: 'server-upgrade-required' }, `This PC sync service does not support collection schema ${CLIENT_COLLECTION_SCHEMA_VERSION}. Update the PC service, then try again.`)
    }
    if (typeof health.collectionSchemaVersion !== 'number') return upgradeRequired({ code: 'server-upgrade-required' }, 'This PC sync service did not report its collection schema. Update the PC service, then try again.')
    if (health.collectionSchemaVersion > CLIENT_COLLECTION_SCHEMA_VERSION) {
      return upgradeRequired({ code: 'client-upgrade-required', requiredSchemaVersion: health.collectionSchemaVersion }, `This collection requires schema ${health.collectionSchemaVersion}. Update Kiroku on this device, then try again.`)
    }
    return { state: 'ready' }
  } catch {
    return { state: 'unreachable' }
  }
}

export async function pairCollection(collection: Collection, endpoint: string, code: string, fetcher: Fetcher = fetch): Promise<PairingResult> {
  const serviceEndpoint = endpoint.trim().replace(/\/$/, '')
  if (!isSafeServiceEndpoint(serviceEndpoint)) return { state: 'pairing-error' }
  try {
    const response = await fetcher(`${serviceEndpoint}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceId: crypto.randomUUID() }),
    })
    if (!response.ok) return { state: 'pairing-error' }
    const credential = await response.json() as { token?: unknown }
    if (typeof credential.token !== 'string' || !credential.token) return { state: 'pairing-error' }
    await collection.configureSync({ endpoint: serviceEndpoint, token: credential.token, cursor: 0 })
    return { state: 'paired' }
  } catch {
    return { state: 'unreachable' }
  }
}

export async function foregroundSync(settings: SyncSettings, operations: Partial<SyncOperation>[], fetcher: Fetcher = fetch): Promise<SyncResult> {
  if (!isSafeServiceEndpoint(settings.endpoint)) return { state: 'unreachable' }
  try {
    const response = await fetcher(`${settings.endpoint.replace(/\/$/, '')}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, collectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, cursor: settings.cursor, operations }),
    })
    if (response.status === 401) return { state: 'authentication-required' }
    if (response.status === 409) {
      let incompatibility: Partial<IncompatibleSync> = {}
      try { incompatibility = await response.json() as Partial<IncompatibleSync> } catch { /* Keep upgrade guidance useful for a malformed response. */ }
      return upgradeRequired(incompatibility, 'This collection cannot sync until Kiroku is updated.')
    }
    if (!response.ok) return { state: 'unreachable' }
    const payload = await response.json() as Omit<Complete, 'state'>
    return { state: 'complete', ...payload }
  } catch {
    return { state: 'unreachable' }
  }
}

export async function syncCollection(collection: Collection, fetcher: Fetcher = fetch, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
  const settings = await collection.syncSettings()
  if (!settings) return { state: 'authentication-required' }
  // An in-flight upload may already hold a snapshot of pending operations.
  // Invalidate local-only undo before any network work can begin.
  await collection.beginSyncAttempt()
  const preflight = await preflightSync(settings, fetcher)
  if (preflight.state !== 'ready') return preflight
  let uploaded = 0
  let downloaded = 0
  let uploadError: MediaSyncProgress['uploadError']
  let downloadError: MediaSyncProgress['downloadError']
  const references = await collection.noteMedia.toArray()
  const localDigests = new Set(references.map((reference) => reference.digest))
  onProgress?.({ phase: 'upload', completed: 0, pending: localDigests.size })
  for (const digest of localDigests) {
    const local = await collection.verifiedMediaBlob(digest)
    if (!local) continue
    try {
      await uploadMedia(settings, digest, local.blob, fetcher)
      uploaded += 1
    } catch (error) {
      uploadError = error instanceof MediaTransferError ? error.state : 'unreachable'
    }
    onProgress?.({ phase: 'upload', completed: uploaded, pending: localDigests.size - uploaded })
  }
  let cursor = settings.cursor
  let accepted = 0
  let result: Complete | undefined
  let rounds = 0
  let remoteChangesPending = false
  while (rounds < SYNC_REQUESTS_PER_ATTEMPT) {
    const operations = await collection.captureSyncOperations(SYNC_OPERATION_BATCH_SIZE)
    const page = await foregroundSync({ ...settings, cursor }, operations, fetcher)
    if (page.state !== 'complete') return page
    await collection.applyRemoteChanges(page.changes as SyncOperation[], page.cursor)
    await collection.acknowledgeOperations(operations.map((operation) => operation.opId))
    cursor = page.cursor
    accepted += page.accepted
    remoteChangesPending = page.hasMore === true
    result = page
    rounds += 1
    const pending = await collection.outbox.count()
    onProgress?.({ phase: 'records', completed: accepted, pending, cursor, remoteChangesPending })
    if (!remoteChangesPending && pending === 0) break
  }

  const pendingOperations = await collection.outbox.count()
  if (pendingOperations > 0 || remoteChangesPending) {
    return { state: 'incomplete', accepted, cursor, pendingOperations, remoteChangesPending }
  }

  if (result) {
    const missingDigests = new Set((await collection.missingReferencedMedia()).map((reference) => reference.digest))
    onProgress?.({ phase: 'download', completed: 0, pending: missingDigests.size, cursor })
    for (const digest of missingDigests) {
      try {
        const blob = await downloadMedia(settings, digest, fetcher)
        await collection.storeDownloadedMedia(digest, blob)
        downloaded += 1
      } catch (error) {
        downloadError = error instanceof MediaTransferError ? error.state : 'unreachable'
      }
      onProgress?.({ phase: 'download', completed: downloaded, pending: missingDigests.size - downloaded, cursor })
    }
    const missing = new Set((await collection.missingReferencedMedia()).map((reference) => reference.digest)).size
    const pending = (uploadError ? localDigests.size - uploaded : 0) + missing
    return { ...result, accepted, cursor, hasMore: false, media: { uploaded, downloaded, pending, ...(uploadError ? { uploadError } : {}), ...(downloadError ? { downloadError } : {}) } }
  }
  return { state: 'unreachable' }
}
