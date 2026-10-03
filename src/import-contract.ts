/**
 * The write contract for a package import.
 *
 * Import used to open its own transaction over eight tables and write them
 * directly, so the invariants the Collection enforces on every other write
 * route - deck hierarchy, tag normalisation, occlusion validity, identity
 * generation - did not run on the one route that can bring in thousands of rows
 * at once. That is the most dangerous direction for a bug to be missing.
 *
 * The Collection now owns the multi-table write. This module describes what it
 * is given, so `anki-import` depends on the contract rather than on the store.
 */
import type { CardRecord, Note, NoteMediaReference, NoteType, Deck, ReviewEntry } from './collection'

export interface ImportedWrite<T> {
  value: T
  action: 'create' | 'update'
}

export interface ImportedBlob {
  digest: string
  blob: ArrayBuffer
  byteLength: number
  mimeType: string
  verifiedAt: string
}

/** Everything one import would write, checked and ready. */
export interface ImportedPackageWrites {
  decks: ImportedWrite<Deck>[]
  deletedDecks: Deck[]
  noteTypes: ImportedWrite<NoteType>[]
  notes: ImportedWrite<Note>[]
  cards: ImportedWrite<CardRecord>[]
  reviews: ReviewEntry[]
  updatedReviews: ReviewEntry[]
  references: ImportedWrite<NoteMediaReference>[]
  deletedReferences: NoteMediaReference[]
  blobs: ImportedBlob[]
  /** Undo records whose snapshot names a deck this import superseded. */
  undoSettings: Array<{ key: string; value: unknown }>
}

/**
 * How a row is compared for the stale-preview check. Media is fingerprinted by
 * its stored identity rather than its bytes, so re-encoding a blob does not read
 * as a change.
 */
export function rowFingerprint(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value && typeof value === 'object' && 'blob' in value) {
    const media = value as { digest?: unknown; byteLength?: unknown; mimeType?: unknown }
    return JSON.stringify({ digest: media.digest, byteLength: media.byteLength, mimeType: media.mimeType })
  }
  return JSON.stringify(value)
}

/** Why an import was refused. Every message names what was wrong, not where. */
export class ImportedPackageRejected extends Error {
  constructor(readonly subject: string, readonly reason: string) {
    super(`${subject}: ${reason}`)
    this.name = 'ImportedPackageRejected'
  }
}