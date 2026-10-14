import type { Collection } from './collection'
import { readDeckMediaReferences, readDeckMediaSnapshot } from './collection-queries'
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

async function discardCorruptDeckMedia(collection: Collection, deckId: string): Promise<void> {
  const references = await readDeckMediaReferences(collection, deckId)
  for (const digest of new Set(references.map((reference) => reference.digest))) {
    // verifiedMediaBlob normalizes legacy bytes to a Blob; it does not hash.
    const blob = await collection.verifiedMediaBlob(digest)
    if (blob) await collection.discardCorruptMediaBlob(digest)
  }
}

/** Reads cached bodies and hashes them; retrieving a Blob alone is not integrity verification. */
export async function inspectDeckOfflineMedia(collection: Collection, deckId: string): Promise<DeckOfflineReadiness> {
  const { references, blobs } = await readDeckMediaSnapshot(collection, deckId)
  const digests = [...new Set(references.map((reference) => reference.digest))]
  const available = await Promise.all(blobs.map(async (blob, index) => Boolean(blob && await digestMedia(blob.blob) === digests[index])))
  const missing = available.filter((value) => !value).length
  const signature = JSON.stringify([
    deckId,
    references.map((reference) => [reference.id, reference.digest]).sort(([left], [right]) => left.localeCompare(right)),
    digests.map((digest, index) => [digest, blobs[index]?.verifiedAt ?? null, blobs[index]?.byteLength ?? null, available[index]]).sort(([left], [right]) => String(left).localeCompare(String(right))),
  ])
  return { deckId, required: digests.length, missing, state: missing ? 'missing' : 'ready', signature }
}

/** Owns verification, corrupt-cache eviction, sync and the final Deck-specific recount. */
export async function prepareDeckOfflineMedia(collection: Collection, deckId: string, options: { synchronize?: Synchronize; onProgress?: Progress } = {}): Promise<DeckMediaPreparation> {
  const progress = (message: string) => options.onProgress?.({ deckId, message })
  progress('Checking this deck’s media before offline review…')
  try {
    await discardCorruptDeckMedia(collection, deckId)
    let readiness = await inspectDeckOfflineMedia(collection, deckId)
    if (readiness.missing === 0) return { deckId, state: 'ready', message: readyMessage, readiness }

    progress('Syncing the collection to download this deck’s missing media…')
    const result = await (options.synchronize ?? syncCollection)(collection)
    await discardCorruptDeckMedia(collection, deckId)
    readiness = await inspectDeckOfflineMedia(collection, deckId)
    if (readiness.missing === 0) return { deckId, state: 'ready', message: readyMessage, readiness }

    if (result.state === 'authentication-required') return { deckId, state: 'authentication-required', message: `This deck needs ${fileCount(readiness.missing)} from the paired PC. Connect to the PC, sync, and prepare the deck again.`, readiness }
    if (result.state === 'complete') return { deckId, state: 'partial-download', message: `${fileCount(readiness.missing)} could not be downloaded. Keep the PC reachable and try again before going offline.`, readiness }
    if (result.state === 'backup-failed') return { deckId, state: 'backup-failed', message: result.message, readiness }
    return { deckId, state: result.state === 'unreachable' ? 'unreachable' : 'sync-incomplete', message: `This deck still needs ${fileCount(readiness.missing)}. The collection could not sync; try again while the PC is reachable.`, readiness }
  } catch (error) {
    return { deckId, state: 'storage-error', message: userFacingStorageError(error, 'This deck could not be checked. Free device storage and try again.') }
  }
}
