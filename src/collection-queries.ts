import type { Collection } from './collection'

/** Owns the transaction scope and table reads for package export. */
export function readAnkiExportSnapshot(collection: Collection) {
  return collection.transaction('r', [collection.decks, collection.notes, collection.noteTypes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs], async () => ({
    decks: await collection.decks.toArray(),
    notes: await collection.notes.toArray(),
    types: await collection.noteTypes.toArray(),
    cards: await collection.cards.toArray(),
    reviews: await collection.reviewEntries.toArray(),
    references: await collection.noteMedia.toArray(),
    blobs: await collection.mediaBlobs.toArray(),
  }))
}
