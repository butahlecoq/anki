import Dexie, { type Table } from 'dexie'
import type { CardRecord, Collection, Note } from './collection'
import type { BrowserSelection } from './browser-maintenance'
import type { CustomStudySession } from './custom-study-state'

function readSnapshot<T>(collection: Collection, tables: Table | Table[], operation: () => Promise<T> | T): Promise<T> {
  if (Dexie.currentTransaction?.db.name === collection.name) return Promise.resolve(operation())
  if (Array.isArray(tables)) return collection.transaction('r', tables, operation)
  return collection.transaction('r', tables, operation)
}

/** Lets Dexie's liveQuery own the tracked transaction so table changes trigger refreshes. */
function readLiveSnapshot<T>(_collection: Collection, _tables: Table | Table[], operation: () => Promise<T> | T): Promise<T> {
  const tables = Array.isArray(_tables) ? _tables : [_tables]
  if (tables.some((table) => table.db.name !== _collection.name)) throw new Error('A live query cannot read another Collection.')
  return Promise.resolve(operation())
}

/** One consistent set of local rows used to plan an Anki Exchange. */
export function readAnkiImportSnapshot(collection: Collection, partialChoiceKey?: string) {
  return readSnapshot(collection, [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.settings], async () => ({
    decks: await collection.decks.toArray(),
    noteTypes: await collection.noteTypes.toArray(),
    notes: await collection.notes.toArray(),
    cards: await collection.cards.toArray(),
    reviews: await collection.reviewEntries.toArray(),
    references: await collection.noteMedia.toArray(),
    partialChoice: partialChoiceKey ? await collection.settings.get(partialChoiceKey) : undefined,
    noteDeletionUndo: await collection.settings.get('noteDeletionUndo'),
  }))
}

/** Looks up only the media digests admitted by the current Import Plan. */
export function readAnkiImportMediaBlobs(collection: Collection, digests: string[]) {
  return readSnapshot(collection, collection.mediaBlobs, () => collection.mediaBlobs.bulkGet(digests))
}

/** Owns the transaction scope and table reads for package export. */
export function readAnkiExportSnapshot(collection: Collection) {
  return readSnapshot(collection, [collection.decks, collection.notes, collection.noteTypes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs], async () => ({
    decks: await collection.decks.toArray(),
    notes: await collection.notes.toArray(),
    types: await collection.noteTypes.toArray(),
    cards: await collection.cards.toArray(),
    reviews: await collection.reviewEntries.toArray(),
    references: await collection.noteMedia.toArray(),
    blobs: await collection.mediaBlobs.toArray(),
  }))
}

/** Resolves the selected rows and their generated-card count for a fresh browser confirmation. */
export function readBrowserSelectionSnapshot(collection: Collection, selection: BrowserSelection) {
  return readLiveSnapshot(collection, [collection.notes, collection.cards], async () => {
    const ids = [...new Set(selection.ids)]
    if (!ids.length) throw new Error('Select at least one record.')
    let cards: CardRecord[]
    let notes: Note[]
    if (selection.view === 'cards') {
      const stored = await collection.cards.bulkGet(ids)
      if (stored.some((card) => !card)) throw new Error('A selected card no longer exists. Refresh the results before applying this action.')
      cards = stored as CardRecord[]
      const storedNotes = await collection.notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
      if (storedNotes.some((note) => !note)) throw new Error('A selected card no longer has a note.')
      notes = storedNotes as Note[]
    } else {
      const stored = await collection.notes.bulkGet(ids)
      if (stored.some((note) => !note)) throw new Error('A selected note no longer exists. Refresh the results before applying this action.')
      notes = stored as Note[]
      cards = await collection.cards.where('noteId').anyOf(ids).toArray()
    }
    const generatedCards = await collection.cards.where('noteId').anyOf(notes.map((note) => note.id)).count()
    return { cards, notes, generatedCards }
  })
}

/** Existence check used before a move confirmation is committed. */
export function readBrowserDestinationDeck(collection: Collection, deckId: string) {
  return readSnapshot(collection, collection.decks, () => collection.decks.get(deckId))
}

/** Reads every row named by a field-change preview in one consistent snapshot. */
export function readBrowserFieldState(collection: Collection, changes: readonly { noteId: string; typeId: string }[]) {
  return readLiveSnapshot(collection, [collection.notes, collection.noteTypes], async () => {
    const noteIds = [...new Set(changes.map((change) => change.noteId))]
    const typeIds = [...new Set(changes.map((change) => change.typeId))]
    const [notes, noteTypes] = await Promise.all([collection.notes.bulkGet(noteIds), collection.noteTypes.bulkGet(typeIds)])
    return { notes: notes.filter((note) => note !== undefined), noteTypes: noteTypes.filter((noteType) => noteType !== undefined) }
  })
}

/** A stable read set for the custom-study search and ordering rules. */
export function readCustomStudySnapshot(collection: Collection, sessionKey: string) {
  return readSnapshot(collection, [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings], async () => ({
    decks: await collection.decks.toArray(),
    notes: await collection.notes.toArray(),
    cards: await collection.cards.toArray(),
    noteTypes: await collection.noteTypes.toArray(),
    reviews: await collection.reviewEntries.toArray(),
    sessions: (await collection.settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? [],
  }))
}

/** Reads the saved temporary-session state without exposing the settings table to callers. */
export function readCustomStudySessions(collection: Collection, sessionKey: string) {
  return readLiveSnapshot(collection, collection.settings, async () => (await collection.settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? [])
}

/** Resolves one saved session and just the rows needed to build its current queue. */
export function readCustomStudyQueueSnapshot(collection: Collection, sessionKey: string, sessionId: string) {
  return readLiveSnapshot(collection, [collection.settings, collection.cards, collection.notes, collection.noteTypes], async () => {
    const sessions = (await collection.settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? []
    const session = sessions.find((item) => item.id === sessionId)
    const cards = session ? (await collection.cards.bulkGet(session.cardIds)).filter((card) => card !== undefined) : []
    const notes = await collection.notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
    return { sessions, session, cards, notes, noteTypes: await collection.noteTypes.toArray() }
  })
}

/** Reads the current sorted Deck list shown by workspace and study controls. */
export function readDeckList(collection: Collection) {
  return collection.decks.orderBy('name').toArray()
}

/** Reads the current sorted Note Type list shown by editors and managers. */
export function readNoteTypeList(collection: Collection) {
  return collection.noteTypes.orderBy('name').toArray()
}

/** Reads one Deck by its stable Collection identity. */
export function readDeck(collection: Collection, deckId: string) {
  return collection.decks.get(deckId)
}

/** Reads one Note by its stable Collection identity. */
export function readNote(collection: Collection, noteId: string) {
  return collection.notes.get(noteId)
}

/** Reads one Card by its stable Collection identity. */
export function readCard(collection: Collection, cardId: string) {
  return collection.cards.get(cardId)
}

/** Reads one Note Type by its stable Collection identity. */
export function readNoteType(collection: Collection, noteTypeId: string) {
  return collection.noteTypes.get(noteTypeId)
}

/** Reads the attachment reference used to load image-occlusion source media. */
export function readNoteMediaReference(collection: Collection, referenceId: string) {
  return readSnapshot(collection, collection.noteMedia, () => collection.noteMedia.get(referenceId))
}

/** Reads cards generated from one note in template order. */
export function readCardsForNote(collection: Collection, noteId: string) {
  return collection.cards.where('noteId').equals(noteId).sortBy('templateId')
}

/** Reads the current Card identities used to count custom-study membership. */
export function readCardIds(collection: Collection) {
  return readLiveSnapshot(collection, collection.cards, () => collection.cards.toCollection().primaryKeys())
}

/** Reads a Deck's Notes and the Note Types used to render them. */
export function readDeckWorkspaceSnapshot(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [collection.decks, collection.notes, collection.noteTypes], async () => ({
    deck: await collection.decks.get(deckId),
    notes: await collection.notes.where('deckId').equals(deckId).sortBy('createdAt'),
    noteTypes: await collection.noteTypes.toArray(),
  }))
}

/** Reads the media attached to notes currently in a Deck. */
export function readDeckMediaSnapshot(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [collection.notes, collection.noteMedia, collection.mediaBlobs], async () => {
    const noteIds = (await collection.notes.where('deckId').equals(deckId).primaryKeys()).map(String)
    const references = noteIds.length ? await collection.noteMedia.where('noteId').anyOf(noteIds).toArray() : []
    const digests = [...new Set(references.map((reference) => reference.digest))]
    return { references, blobs: digests.length ? await collection.mediaBlobs.bulkGet(digests) : [] }
  })
}

/** Reads only the media references for notes currently in one Deck. */
export function readDeckMediaReferences(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [collection.notes, collection.noteMedia], async () => {
    const noteIds = (await collection.notes.where('deckId').equals(deckId).primaryKeys()).map(String)
    return noteIds.length ? collection.noteMedia.where('noteId').anyOf(noteIds).toArray() : []
  })
}

/** Reads selected cards, their notes and types for the browser editor dialog. */
export function readBrowserEditorSnapshot(collection: Collection, selection: BrowserSelection) {
  return readLiveSnapshot(collection, [collection.cards, collection.notes, collection.noteTypes], async () => {
    const cards = selection.view === 'cards' ? (await collection.cards.bulkGet(selection.ids)).filter((card) => card !== undefined) : []
    const noteIds = selection.view === 'notes' ? selection.ids : cards.map((card) => card.noteId)
    const notes = (await collection.notes.bulkGet([...new Set(noteIds)])).filter((note) => note !== undefined)
    const noteTypes = await collection.noteTypes.bulkGet([...new Set(notes.map((note) => note.typeId))])
    return { cards, notes, types: noteTypes.filter((type) => type !== undefined) }
  })
}

/** Reads all rows needed by the browser's collection search and row renderer. */
export function readBrowserCollectionSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings], async () => ({
    sessions: (await collection.settings.get('customStudySessions'))?.value as CustomStudySession[] | undefined ?? [],
    decks: await collection.decks.toArray(), notes: await collection.notes.toArray(), cards: await collection.cards.toArray(),
    noteTypes: await collection.noteTypes.toArray(), reviews: await collection.reviewEntries.toArray(),
  }))
}

/** Reads one Note Type's example Note and generated Note count. */
export function readNoteTypeUsage(collection: Collection, noteTypeId: string) {
  return readLiveSnapshot(collection, collection.notes, async () => ({
    example: await collection.notes.where('typeId').equals(noteTypeId).first(),
    count: await collection.notes.where('typeId').equals(noteTypeId).count(),
  }))
}

/** Reads historical review entries for one card. */
export function readCardReviewHistory(collection: Collection, cardId: string) {
  return collection.reviewEntries.where('cardId').equals(cardId).toArray()
}

/** Reads all rows used by the statistics screen's dashboard aggregates. */
export function readStatisticsSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [collection.decks, collection.cards, collection.notes, collection.reviewEntries], async () => ({
    decks: await collection.decks.toArray(), cards: await collection.cards.toArray(), notes: await collection.notes.toArray(), reviews: await collection.reviewEntries.toArray(),
  }))
}

/** Reads the full review history for one statistics period. */
export function readReviewHistory(collection: Collection) {
  return readLiveSnapshot(collection, collection.reviewEntries, () => collection.reviewEntries.toArray())
}

/** Reads media references for the sync upload pass. */
export function readSyncMediaReferences(collection: Collection) {
  return readLiveSnapshot(collection, collection.noteMedia, () => collection.noteMedia.toArray())
}

/** Reads pending-operation and conflict counts for sync progress reporting. */
export function readSyncProgressCounts(collection: Collection) {
  return readLiveSnapshot(collection, [collection.outbox, collection.syncConflicts], async () => ({
    pending: await collection.outbox.count(), conflicts: await collection.syncConflicts.count(),
  }))
}

/** Reads the visible sync status including collection sizes and stored media. */
export function readSyncStatusSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [collection.notes, collection.cards, collection.mediaBlobs], async () => ({
    notes: await collection.notes.count(), cards: await collection.cards.count(), media: await collection.mediaBlobs.toArray(),
  }))
}

/** Reads the conflicts shown in the conflict-resolution screen. */
export function readSyncConflicts(collection: Collection) {
  return collection.syncConflicts.toArray()
}

/** Reads all rows needed to resolve text import destinations and identities. */
export function readTextImportSnapshot(collection: Collection) {
  return readSnapshot(collection, [collection.notes, collection.decks, collection.noteTypes, collection.deletedEntities], async () => ({
    notes: await collection.notes.toArray(), decks: await collection.decks.toArray(), noteTypes: await collection.noteTypes.toArray(),
    deleted: await collection.deletedEntities.toArray(),
  }))
}

/** Reads the row set rendered into a text collection export. */
export function readTextExportSnapshot(collection: Collection) {
  return readSnapshot(collection, [collection.notes, collection.decks, collection.noteTypes, collection.cards], async () => ({
    notes: await collection.notes.toArray(), decks: await collection.decks.toArray(), noteTypes: await collection.noteTypes.toArray(), cards: await collection.cards.toArray(),
  }))
}

/** Reads the Deck and Note Type choices shown by the text exchange dialog. */
export function readTextExchangeChoices(collection: Collection) {
  return readLiveSnapshot(collection, [collection.decks, collection.noteTypes], async () => ({
    decks: await collection.decks.toArray(), noteTypes: await collection.noteTypes.toArray(),
  }))
}

/** Reads whether the sample Deck and its Note Type already exist. */
export function readSampleDeckSnapshot(collection: Collection, deckName: string, noteTypeName: string) {
  return readSnapshot(collection, [collection.decks, collection.notes, collection.noteTypes], async () => {
    const deck = await collection.decks.where('name').equals(deckName).first()
    const noteType = await collection.noteTypes.where('name').equals(noteTypeName).first()
    return { deck, noteType, deckNoteCount: deck ? await collection.notes.where('deckId').equals(deck.id).count() : 0,
      typeNoteCount: noteType ? await collection.notes.where('typeId').equals(noteType.id).count() : 0 }
  })
}

/** Reads a consistent Collection projection used to compare Anki writeback state. */
export function readNativeWritebackSnapshot(collection: Collection) {
  return readSnapshot(collection, [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia], async () => ({
    decks: await collection.decks.toArray(), notetypes: await collection.noteTypes.toArray(), notes: await collection.notes.toArray(),
    cards: await collection.cards.toArray(), reviews: await collection.reviewEntries.toArray(), references: await collection.noteMedia.toArray(),
  }))
}
