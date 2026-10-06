import type { Collection, CollectionStorage } from './collection'

function storage(collection: Collection): CollectionStorage { return collection as unknown as CollectionStorage }

/** Runs a browser bulk action with every row and undo record it can mutate. */
export function runBrowserBulkAction<T>(collection: Collection, operation: () => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).noteTypes, storage(collection).decks, storage(collection).notes, storage(collection).cards, storage(collection).reviewEntries, storage(collection).noteMedia, storage(collection).outbox, storage(collection).syncRevisions, storage(collection).deletedEntities, storage(collection).settings], operation)
}

/** Runs a field edit with its source rows and sync journal in one commit. */
export function runBrowserFieldChanges<T>(collection: Collection, operation: () => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).noteTypes, storage(collection).notes, storage(collection).cards, storage(collection).outbox, storage(collection).syncRevisions], operation)
}

/** Runs custom-study membership changes against their exact read/write set. */
export function runCustomStudyWrite<T>(collection: Collection, operation: () => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).decks, storage(collection).notes, storage(collection).cards, storage(collection).noteTypes, storage(collection).reviewEntries, storage(collection).settings], operation)
}

/** Runs a custom-study answer together with scheduling and undo state. */
export function runCustomStudyAnswer<T>(collection: Collection, operation: () => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).decks, storage(collection).deckOptionGroups, storage(collection).notes, storage(collection).cards, storage(collection).noteTypes, storage(collection).reviewEntries, storage(collection).outbox, storage(collection).syncRevisions, storage(collection).settings], operation)
}

/** Runs a custom-study undo with all affected review, content, and sync rows. */
export function runCustomStudyUndo<T>(collection: Collection, operation: () => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).settings, storage(collection).cards, storage(collection).notes, storage(collection).noteTypes, storage(collection).decks, storage(collection).reviewEntries, storage(collection).noteMedia, storage(collection).outbox, storage(collection).syncRevisions, storage(collection).deletedEntities], operation)
}

/** Applies a text-preview plan only against the exact data revision it described. */
export function applyTextImportTransaction<T, S extends { revision: string }>(collection: Collection, expectedRevision: string, readCurrentState: () => Promise<S>, applyRows: (state: S) => Promise<T>) {
  return storage(collection).transaction('rw', [storage(collection).notes, storage(collection).decks, storage(collection).noteTypes, storage(collection).cards, storage(collection).outbox, storage(collection).deletedEntities, storage(collection).deckOptionGroups, storage(collection).syncRevisions], async () => {
    const state = await readCurrentState()
    if (state.revision !== expectedRevision) throw new Error('Collection changed after preview. Preview again before importing.')
    return applyRows(state)
  })
}
