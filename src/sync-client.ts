import type { Collection, SyncOperation, SyncSettings } from './collection'

type Fetcher = typeof fetch
type Change = { cursor: number; opId: string; entityType: string; entityId: string; action: string; occurredAt: string; payload: unknown }
type Complete = { state: 'complete'; accepted: number; cursor: number; changes: Change[] }
type SyncResult = Complete | { state: 'authentication-required' } | { state: 'unreachable' }

export async function foregroundSync(settings: SyncSettings, operations: Partial<SyncOperation>[], fetcher: Fetcher = fetch): Promise<SyncResult> {
  try {
    const response = await fetcher(`${settings.endpoint.replace(/\/$/, '')}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: settings.cursor, operations }),
    })
    if (response.status === 401) return { state: 'authentication-required' }
    if (!response.ok) return { state: 'unreachable' }
    const payload = await response.json() as Omit<Complete, 'state'>
    return { state: 'complete', ...payload }
  } catch {
    return { state: 'unreachable' }
  }
}

export async function syncCollection(collection: Collection, fetcher: Fetcher = fetch): Promise<SyncResult> {
  const settings = await collection.syncSettings()
  if (!settings) return { state: 'authentication-required' }
  const result = await foregroundSync(settings, await collection.pendingOperations(), fetcher)
  if (result.state === 'complete') await collection.applyRemoteChanges(result.changes as SyncOperation[], result.cursor)
  return result
}
