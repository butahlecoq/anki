import Dexie from 'dexie'
import type { Collection } from './collection'
import { readDeckMediaReferences } from './collection-queries'
import { digestMedia } from './media'
import { userFacingStorageError } from './offline-storage'
import { syncCollection } from './sync-client'

export interface DeckOfflineReadiness {
  deckId: string
  required: number
  missing: number
  state: 'ready' | 'missing'
  /** Changes when Deck references or their observed content readiness changes. */
  signature: string
}

export type DeckMediaPreparation = {
  deckId: string
  state: 'ready' | 'authentication-required' | 'partial-download' | 'backup-failed' | 'unreachable' | 'sync-incomplete' | 'storage-error'
  message: string
  readiness?: DeckOfflineReadiness
}

type Synchronize = (collection: Collection) => ReturnType<typeof syncCollection>
type Progress = (update: { deckId: string; message: string }) => void

const readyMessage = 'This deck is ready for offline review. All referenced media is stored on this device.'
const fileCount = (count: number) => `${count} media file${count === 1 ? '' : 's'}`
/** At most four stored bodies and digest operations are in progress at once. */
export const DECK_MEDIA_VERIFICATION_LIMIT = 4
const VERIFIED_CONTENT_CACHE_LIMIT = 256
type Verification = { digest: string; valid: boolean; verifiedAt: string | null; byteLength: number | null; contentVersion: string | null }
const verifiedContent = new WeakMap<Collection, Map<string, { version: string; byteLength: number; valid: boolean }>>()

function cacheFor(collection: Collection) {
  let cache = verifiedContent.get(collection)
  if (!cache) { cache = new Map(); verifiedContent.set(collection, cache) }
  return cache
}

function rememberVerified(cache: Map<string, { version: string; byteLength: number; valid: boolean }>, digest: string, value: { version: string; byteLength: number; valid: boolean }) {
  cache.delete(digest)
  cache.set(digest, value)
  if (cache.size > VERIFIED_CONTENT_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

function referencesKey(references: Awaited<ReturnType<typeof readDeckMediaReferences>>) {
  return JSON.stringify(references.map(({ id, digest }) => [id, digest]).sort(([left], [right]) => left.localeCompare(right)))
}

async function verifyDeckMedia(collection: Collection, deckId: string, force: boolean, repair = false): Promise<DeckOfflineReadiness> {
  const cache = cacheFor(collection)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let changed = false
    const prefix = `idb://${collection.databaseName}/`
    const onMutation = (parts: Record<string, unknown>) => {
      if (Object.keys(parts).some((part) => ['notes', 'noteMedia', 'mediaBlobs'].some((table) => part.startsWith(`${prefix}${table}/`)))) changed = true
    }
    Dexie.on('storagemutated').subscribe(onMutation)
    try {
      const references = await readDeckMediaReferences(collection, deckId)
      const digests = [...new Set(references.map(({ digest }) => digest))]
      const checks = new Array<Verification>(digests.length)
      let next = 0
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(DECK_MEDIA_VERIFICATION_LIMIT, digests.length) }, async () => {
        while (next < digests.length) {
          const index = next++
          const digest = digests[index]!
          // The body is fetched inside the worker, so even a large Deck has only four bodies in flight.
          // verifiedMediaBlob only retrieves/normalizes; digestMedia checks the content address.
          const blob = await collection.verifiedMediaBlob(digest)
          if (!blob) {
            cache.delete(digest)
            checks[index] = { digest, valid: false, verifiedAt: null, byteLength: null, contentVersion: null }
            continue
          }
          const version = blob.contentVersion
          const previous = version ? cache.get(digest) : undefined
          const valid = !force && previous && previous.version === version && previous.byteLength === blob.byteLength
            ? previous.valid
            : await digestMedia(blob.blob) === digest
          if (repair && !valid) {
            await collection.evictCachedMediaIfVersion(digest, version)
            cache.delete(digest)
            checks[index] = { digest, valid: false, verifiedAt: null, byteLength: null, contentVersion: null }
            continue
          }
          if (version) rememberVerified(cache, digest, { version, byteLength: blob.byteLength, valid })
          checks[index] = { digest, valid, verifiedAt: blob.verifiedAt, byteLength: blob.byteLength, contentVersion: version ?? null }
        }
      }))
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failure) throw failure.reason
      const latest = await readDeckMediaReferences(collection, deckId)
      if (changed || referencesKey(latest) !== referencesKey(references)) continue
      const missing = checks.filter(({ valid }) => !valid).length
      const signature = JSON.stringify([
        deckId,
        JSON.parse(referencesKey(references)),
        checks.map(({ digest, valid, verifiedAt, byteLength, contentVersion }) => [digest, contentVersion, verifiedAt, byteLength, valid]).sort(([left], [right]) => String(left).localeCompare(String(right))),
      ])
      return { deckId, required: digests.length, missing, state: missing ? 'missing' : 'ready', signature }
    } finally { Dexie.on('storagemutated').unsubscribe(onMutation) }
  }
  // Continuous writes leave the latest Deck unverified; never publish an old ready result.
  const latest = await readDeckMediaReferences(collection, deckId)
  const required = new Set(latest.map(({ digest }) => digest)).size
  return { deckId, required, missing: required, state: required ? 'missing' : 'ready', signature: JSON.stringify([deckId, referencesKey(latest), 'verification-retry']) }
}

/** Rechecks stored bytes on every call, including legacy and out-of-band corruption. */
export async function inspectDeckOfflineMedia(collection: Collection, deckId: string): Promise<DeckOfflineReadiness> {
  return verifyDeckMedia(collection, deckId, true)
}

/** Reuses a trusted content version after its bytes were verified; storage changes trigger a new read. */
export async function readDeckOfflineMedia(collection: Collection, deckId: string): Promise<DeckOfflineReadiness> {
  try { return await verifyDeckMedia(collection, deckId, false) }
  catch (error) {
    if (!(error && typeof error === 'object' && 'name' in error && error.name === 'NotReadableError')) throw error
    // WebKit can reject a Blob read at the instant its network context goes offline.
    // Keep the reactive view mounted and require a later successful check for "ready".
    const references = await readDeckMediaReferences(collection, deckId)
    const required = new Set(references.map(({ digest }) => digest)).size
    return { deckId, required, missing: required, state: required ? 'missing' : 'ready', signature: JSON.stringify([deckId, referencesKey(references), 'unreadable']) }
  }
}

/** Owns verification, corrupt-cache eviction, sync and the final Deck-specific recount. */
export async function prepareDeckOfflineMedia(collection: Collection, deckId: string, options: { synchronize?: Synchronize; onProgress?: Progress } = {}): Promise<DeckMediaPreparation> {
  const progress = (message: string) => options.onProgress?.({ deckId, message })
  progress('Checking this deck’s media before offline review…')
  try {
    let readiness = await verifyDeckMedia(collection, deckId, true, true)
    if (readiness.missing === 0) return { deckId, state: 'ready', message: readyMessage, readiness }

    progress('Syncing the collection to download this deck’s missing media…')
    const result = await (options.synchronize ?? syncCollection)(collection)
    readiness = await verifyDeckMedia(collection, deckId, true, true)
    if (readiness.missing === 0) return { deckId, state: 'ready', message: readyMessage, readiness }

    if (result.state === 'authentication-required') return { deckId, state: 'authentication-required', message: `This deck needs ${fileCount(readiness.missing)} from the paired PC. Connect to the PC, sync, and prepare the deck again.`, readiness }
    if (result.state === 'complete') return { deckId, state: 'partial-download', message: `${fileCount(readiness.missing)} could not be downloaded. Keep the PC reachable and try again before going offline.`, readiness }
    if (result.state === 'backup-failed') return { deckId, state: 'backup-failed', message: result.message, readiness }
    return { deckId, state: result.state === 'unreachable' ? 'unreachable' : 'sync-incomplete', message: `This deck still needs ${fileCount(readiness.missing)}. The collection could not sync; try again while the PC is reachable.`, readiness }
  } catch (error) {
    return { deckId, state: 'storage-error', message: userFacingStorageError(error, 'This deck could not be checked. Free device storage and try again.') }
  }
}
