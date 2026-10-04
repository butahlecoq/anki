import type { SyncSettings } from './collection.js'
import { isSafeServiceEndpoint } from './sync-client.js'
import type { NativeAnkiTransport } from './native-anki-sync.js'

/** Routes native protocol traffic through the already paired PC service.
 * The paired token authorizes that hop only; it is never placed in the body
 * or passed on to AnkiWeb. Browser cookies are always omitted. */
export function createPairedAnkiWebTransport(settings: SyncSettings, fetcher: typeof fetch = fetch): NativeAnkiTransport {
  const endpoint = settings.endpoint.replace(/\/$/, '')
  if (!isSafeServiceEndpoint(endpoint) || !/^[a-f0-9]{64}$/i.test(settings.token)) throw new Error('Connect to the PC service before connecting an AnkiWeb account.')
  return async (route, body, hostNumber, { signal }) => {
    if (!/^(?:sync|msync)\/[A-Za-z0-9]+$/.test(route) || !Number.isInteger(hostNumber) || hostNumber < 0 || hostNumber > 999) throw new Error('AnkiWeb request route is invalid.')
    const headers = new Headers({ authorization: `Bearer ${settings.token}` })
    if (hostNumber > 0) headers.set('x-ankiweb-host', `sync${hostNumber}.ankiweb.net`)
    return fetcher(`${endpoint}/api/ankiweb/${route}`, {
      method: 'POST',
      headers,
      body,
      credentials: 'omit',
      redirect: 'error',
      signal,
    })
  }
}
