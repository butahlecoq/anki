import type { Collection } from './collection'
import type { CustomStudySession } from './custom-study-state'

/** Replaces the saved custom-study sessions without exposing the settings table to callers. */
export function persistCustomStudySessions(collection: Collection, key: string, sessions: CustomStudySession[]) {
  return collection.transaction('rw', collection.settings, () => collection.settings.put({ key, value: sessions }))
}

/** Runs a browser bulk action with every row and undo record it can mutate. */
export function runBrowserBulkAction<T>(collection: Collection, operation: () => Promise<T>) {
  return collection.transaction('rw', [collection.noteTypes, collection.decks, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.outbox, collection.syncRevisions, collection.deletedEntities, collection.settings], operation)
}

/** Runs a field edit with its source rows and sync journal in one commit. */
export function runBrowserFieldChanges<T>(collection: Collection, operation: () => Promise<T>) {
  return collection.transaction('rw', [collection.noteTypes, collection.notes, collection.cards, collection.outbox, collection.syncRevisions], operation)
}

/** Runs custom-study membership changes against their exact read/write set. */
export function runCustomStudyWrite<T>(collection: Collection, operation: () => Promise<T>) {
  return collection.transaction('rw', [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings], operation)
}

/** Runs a custom-study answer together with scheduling and undo state. */
export function runCustomStudyAnswer<T>(collection: Collection, operation: () => Promise<T>) {
  return collection.transaction('rw', [collection.decks, collection.deckOptionGroups, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.outbox, collection.syncRevisions, collection.settings], operation)
}

/** Runs a custom-study undo with all affected review, content, and sync rows. */
export function runCustomStudyUndo<T>(collection: Collection, operation: () => Promise<T>) {
  return collection.transaction('rw', [collection.settings, collection.cards, collection.notes, collection.noteTypes, collection.decks, collection.reviewEntries, collection.noteMedia, collection.outbox, collection.syncRevisions, collection.deletedEntities], operation)
}
