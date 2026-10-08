import Dexie, { type Table } from 'dexie'
import type { CardRecord, Collection, CollectionStorage, Deck, Note } from './collection'
import type { BrowserSelection } from './browser-maintenance'
import type { CustomStudySession } from './custom-study-state'

function storage(collection: Collection): CollectionStorage { return collection as unknown as CollectionStorage }

function readSnapshot<T>(collection: Collection, tables: Table | Table[], operation: () => Promise<T> | T): Promise<T> {
  if (Dexie.currentTransaction?.db.name === storage(collection).name) return Promise.resolve(operation())
  if (Array.isArray(tables)) return storage(collection).transaction('r', tables, operation)
  return storage(collection).transaction('r', tables, operation)
}

/** Lets Dexie's liveQuery own the tracked transaction so table changes trigger refreshes. */
function readLiveSnapshot<T>(_collection: Collection, _tables: Table | Table[], operation: () => Promise<T> | T): Promise<T> {
  const tables = Array.isArray(_tables) ? _tables : [_tables]
  if (tables.some((table) => table.db.name !== storage(_collection).name)) throw new Error('A live query cannot read another Collection.')
  return Promise.resolve(operation())
}

/** One consistent set of local rows used to plan an Anki Exchange. */
export function readAnkiImportSnapshot(collection: Collection, partialChoiceKey?: string) {
  const tables = [storage(collection).decks, storage(collection).noteTypes, storage(collection).notes, storage(collection).cards, storage(collection).reviewEntries, storage(collection).noteMedia, storage(collection).settings, storage(collection).mediaBlobs, storage(collection).outbox, storage(collection).syncRevisions, storage(collection).deletedEntities, storage(collection).deckOptionGroups]
  return readSnapshot(collection, tables, async () => ({
    decks: await storage(collection).decks.toArray(),
    noteTypes: await storage(collection).noteTypes.toArray(),
    notes: await storage(collection).notes.toArray(),
    cards: await storage(collection).cards.toArray(),
    reviews: await storage(collection).reviewEntries.toArray(),
    references: await storage(collection).noteMedia.toArray(),
    partialChoice: partialChoiceKey ? await storage(collection).settings.get(partialChoiceKey) : undefined,
    noteDeletionUndo: await storage(collection).settings.get('noteDeletionUndo'),
    deletionBarriers: await storage(collection).deletedEntities.toArray(),
    retainedRevisions: await storage(collection).syncRevisions.toArray(),
    tableCounts: await Promise.all(tables.map((table) => table.count())),
  }))
}

/** Looks up only the media digests admitted by the current Import Plan. */
export function readAnkiImportMediaBlobs(collection: Collection, digests: string[]) {
  return readSnapshot(collection, storage(collection).mediaBlobs, () => storage(collection).mediaBlobs.bulkGet(digests))
}

/** Owns the transaction scope and table reads for package export. */
export function readAnkiExportSnapshot(collection: Collection) {
  return readSnapshot(collection, [storage(collection).decks, storage(collection).notes, storage(collection).noteTypes, storage(collection).cards, storage(collection).reviewEntries, storage(collection).noteMedia, storage(collection).mediaBlobs], async () => ({
    decks: await storage(collection).decks.toArray(),
    notes: await storage(collection).notes.toArray(),
    types: await storage(collection).noteTypes.toArray(),
    cards: await storage(collection).cards.toArray(),
    reviews: await storage(collection).reviewEntries.toArray(),
    references: await storage(collection).noteMedia.toArray(),
    blobs: await storage(collection).mediaBlobs.toArray(),
  }))
}

/** Resolves the selected rows and their generated-card count for a fresh browser confirmation. */
export function readBrowserSelectionSnapshot(collection: Collection, selection: BrowserSelection) {
  return readLiveSnapshot(collection, [storage(collection).notes, storage(collection).cards], async () => {
    const ids = [...new Set(selection.ids)]
    if (!ids.length) throw new Error('Select at least one record.')
    let cards: CardRecord[]
    let notes: Note[]
    if (selection.view === 'cards') {
      const stored = await storage(collection).cards.bulkGet(ids)
      if (stored.some((card) => !card)) throw new Error('A selected card no longer exists. Refresh the results before applying this action.')
      cards = stored as CardRecord[]
      const storedNotes = await storage(collection).notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
      if (storedNotes.some((note) => !note)) throw new Error('A selected card no longer has a note.')
      notes = storedNotes as Note[]
    } else {
      const stored = await storage(collection).notes.bulkGet(ids)
      if (stored.some((note) => !note)) throw new Error('A selected note no longer exists. Refresh the results before applying this action.')
      notes = stored as Note[]
      cards = await storage(collection).cards.where('noteId').anyOf(ids).toArray()
    }
    const generatedCards = await storage(collection).cards.where('noteId').anyOf(notes.map((note) => note.id)).count()
    return { cards, notes, generatedCards }
  })
}

/** Existence check used before a move confirmation is committed. */
export function readBrowserDestinationDeck(collection: Collection, deckId: string) {
  return readSnapshot(collection, storage(collection).decks, () => storage(collection).decks.get(deckId))
}

/** Reads every row named by a field-change preview in one consistent snapshot. */
export function readBrowserFieldState(collection: Collection, changes: readonly { noteId: string; typeId: string }[]) {
  return readLiveSnapshot(collection, [storage(collection).notes, storage(collection).noteTypes], async () => {
    const noteIds = [...new Set(changes.map((change) => change.noteId))]
    const typeIds = [...new Set(changes.map((change) => change.typeId))]
    const [notes, noteTypes] = await Promise.all([storage(collection).notes.bulkGet(noteIds), storage(collection).noteTypes.bulkGet(typeIds)])
    return { notes: notes.filter((note) => note !== undefined), noteTypes: noteTypes.filter((noteType) => noteType !== undefined) }
  })
}

/** A stable read set for the custom-study search and ordering rules. */
export function readCustomStudySnapshot(collection: Collection, sessionKey: string) {
  return readSnapshot(collection, [storage(collection).decks, storage(collection).notes, storage(collection).cards, storage(collection).noteTypes, storage(collection).reviewEntries, storage(collection).settings], async () => ({
    decks: await storage(collection).decks.toArray(),
    notes: await storage(collection).notes.toArray(),
    cards: await storage(collection).cards.toArray(),
    noteTypes: await storage(collection).noteTypes.toArray(),
    reviews: await storage(collection).reviewEntries.toArray(),
    sessions: (await storage(collection).settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? [],
  }))
}

/** Reads the saved temporary-session state without exposing the settings table to callers. */
export function readCustomStudySessions(collection: Collection, sessionKey: string) {
  return readLiveSnapshot(collection, storage(collection).settings, async () => (await storage(collection).settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? [])
}

/** Resolves one saved session and just the rows needed to build its current queue. */
export function readCustomStudyQueueSnapshot(collection: Collection, sessionKey: string, sessionId: string) {
  return readLiveSnapshot(collection, [storage(collection).settings, storage(collection).cards, storage(collection).notes, storage(collection).noteTypes], async () => {
    const sessions = (await storage(collection).settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? []
    const session = sessions.find((item) => item.id === sessionId)
    const cards = session ? (await storage(collection).cards.bulkGet(session.cardIds)).filter((card) => card !== undefined) : []
    const notes = await storage(collection).notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
    return { sessions, session, cards, notes, noteTypes: await storage(collection).noteTypes.toArray() }
  })
}

/** Reads the current sorted Deck list shown by workspace and study controls. */
export function readDeckList(collection: Collection) {
  return storage(collection).decks.orderBy('name').toArray()
}

/** Reads deck option groups in their workspace display order. */
export function readDeckOptionGroups(collection: Collection) {
  return storage(collection).deckOptionGroups.orderBy('name').toArray()
}

/** Reads the current sorted Note Type list shown by editors and managers. */
export function readNoteTypeList(collection: Collection) {
  return storage(collection).noteTypes.orderBy('name').toArray()
}

/** Reads one Deck by its stable Collection identity. */
export function readDeck(collection: Collection, deckId: string) {
  return storage(collection).decks.get(deckId)
}

/** Reads one Deck Option Group by its stable Collection identity. */
export function readDeckOptionGroup(collection: Collection, groupId: string) {
  return storage(collection).deckOptionGroups.get(groupId)
}

/** Reads one Note by its stable Collection identity. */
export function readNote(collection: Collection, noteId: string) {
  return storage(collection).notes.get(noteId)
}

/** Reads one Card by its stable Collection identity. */
export function readCard(collection: Collection, cardId: string) {
  return storage(collection).cards.get(cardId)
}

/** Resolves a requested set of Cards in the same order as their identities. */
export function readCardsByIds(collection: Collection, cardIds: string[]) {
  return storage(collection).cards.bulkGet(cardIds)
}

/** Reads the card content available to one study activity without exposing Collection tables. */
export function readStudyActivityRows(collection: Collection, cardIds: readonly string[]) {
  const cardsTable = storage(collection).cards
  const notesTable = storage(collection).notes
  const noteTypesTable = storage(collection).noteTypes
  const mediaTable = storage(collection).noteMedia
  return readLiveSnapshot(collection, [cardsTable, notesTable, noteTypesTable, mediaTable], async () => {
    const cards = (await cardsTable.bulkGet([...cardIds])).filter((card) => card !== undefined)
    const noteIds = [...new Set(cards.map((card) => card.noteId))]
    const notes = (await notesTable.bulkGet(noteIds)).filter((note) => note !== undefined)
    const typeIds = [...new Set(notes.map((note) => note.typeId))]
    const [noteTypes, media] = await Promise.all([
      noteTypesTable.bulkGet(typeIds),
      noteIds.length ? mediaTable.where('noteId').anyOf(noteIds).toArray() : Promise.resolve([]),
    ])
    return { cards, notes, noteTypes: noteTypes.filter((noteType) => noteType !== undefined), media }
  })
}

/** Reads one Note Type by its stable Collection identity. */
export function readNoteType(collection: Collection, noteTypeId: string) {
  return storage(collection).noteTypes.get(noteTypeId)
}

/** Reads the attachment reference used to load image-occlusion source media. */
export function readNoteMediaReference(collection: Collection, referenceId: string) {
  return readSnapshot(collection, storage(collection).noteMedia, () => storage(collection).noteMedia.get(referenceId))
}

/** Reads one cached media blob for a media recovery workflow. */
export function readCachedMediaBlob(collection: Collection, digest: string) {
  return readSnapshot(collection, storage(collection).mediaBlobs, () => storage(collection).mediaBlobs.get(digest))
}

/** Reads cards generated from one note in template order. */
export function readCardsForNote(collection: Collection, noteId: string) {
  return storage(collection).cards.where('noteId').equals(noteId).sortBy('templateId')
}

/** Reads the current Card identities used to count custom-study membership. */
export function readCardIds(collection: Collection) {
  return readLiveSnapshot(collection, storage(collection).cards, () => storage(collection).cards.toCollection().primaryKeys())
}

/** Reads a Deck's Notes and the Note Types used to render them. */
export function readDeckWorkspaceSnapshot(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [storage(collection).decks, storage(collection).notes, storage(collection).noteTypes], async () => ({
    deck: await storage(collection).decks.get(deckId),
    notes: await storage(collection).notes.where('deckId').equals(deckId).sortBy('createdAt'),
    noteTypes: await storage(collection).noteTypes.toArray(),
  }))
}

/** Reads the media attached to notes currently in a Deck. */
export function readDeckMediaSnapshot(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [storage(collection).notes, storage(collection).noteMedia, storage(collection).mediaBlobs], async () => {
    const noteIds = (await storage(collection).notes.where('deckId').equals(deckId).primaryKeys()).map(String)
    const references = noteIds.length ? await storage(collection).noteMedia.where('noteId').anyOf(noteIds).toArray() : []
    const digests = [...new Set(references.map((reference) => reference.digest))]
    return { references, blobs: digests.length ? await storage(collection).mediaBlobs.bulkGet(digests) : [] }
  })
}

/** Reads only the media references for notes currently in one Deck. */
export function readDeckMediaReferences(collection: Collection, deckId: string) {
  return readLiveSnapshot(collection, [storage(collection).notes, storage(collection).noteMedia], async () => {
    const noteIds = (await storage(collection).notes.where('deckId').equals(deckId).primaryKeys()).map(String)
    return noteIds.length ? storage(collection).noteMedia.where('noteId').anyOf(noteIds).toArray() : []
  })
}

/** Reads selected cards, their notes and types for the browser editor dialog. */
export function readBrowserEditorSnapshot(collection: Collection, selection: BrowserSelection) {
  return readLiveSnapshot(collection, [storage(collection).cards, storage(collection).notes, storage(collection).noteTypes], async () => {
    const cards = selection.view === 'cards' ? (await storage(collection).cards.bulkGet(selection.ids)).filter((card) => card !== undefined) : []
    const noteIds = selection.view === 'notes' ? selection.ids : cards.map((card) => card.noteId)
    const notes = (await storage(collection).notes.bulkGet([...new Set(noteIds)])).filter((note) => note !== undefined)
    const noteTypes = await storage(collection).noteTypes.bulkGet([...new Set(notes.map((note) => note.typeId))])
    return { cards, notes, types: noteTypes.filter((type) => type !== undefined) }
  })
}

/** Reads all rows needed by the browser's collection search and row renderer. */
export function readBrowserCollectionSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).decks, storage(collection).notes, storage(collection).cards, storage(collection).noteTypes, storage(collection).reviewEntries, storage(collection).settings], async () => ({
    sessions: (await storage(collection).settings.get('customStudySessions'))?.value as CustomStudySession[] | undefined ?? [],
    decks: await storage(collection).decks.toArray(), notes: await storage(collection).notes.toArray(), cards: await storage(collection).cards.toArray(),
    noteTypes: await storage(collection).noteTypes.toArray(), reviews: await storage(collection).reviewEntries.toArray(),
  }))
}

/** Reads one Note Type's example Note and generated Note count. */
export function readNoteTypeUsage(collection: Collection, noteTypeId: string) {
  return readLiveSnapshot(collection, storage(collection).notes, async () => ({
    example: await storage(collection).notes.where('typeId').equals(noteTypeId).first(),
    count: await storage(collection).notes.where('typeId').equals(noteTypeId).count(),
  }))
}

/** Reads historical review entries for one card. */
export function readCardReviewHistory(collection: Collection, cardId: string) {
  return storage(collection).reviewEntries.where('cardId').equals(cardId).toArray()
}

/** Reads one Review Entry by its stable Collection identity. */
export function readReviewEntry(collection: Collection, reviewId: string) {
  return storage(collection).reviewEntries.get(reviewId)
}

/** Counts retained deletion markers for sync diagnostics. */
export function readDeletedEntityCount(collection: Collection) {
  return storage(collection).deletedEntities.count()
}

/** Reads a retained deletion marker by its stable sync identity. */
export function readDeletedEntity(collection: Collection, key: string) {
  return storage(collection).deletedEntities.get(key)
}

/** Reads whether a remote operation identity has already been applied. */
export function readReceivedOperation(collection: Collection, operationId: string) {
  return storage(collection).receivedOperations.get(operationId)
}

/** Counts applied remote operation identities for sync boundary assertions. */
export function readReceivedOperationCount(collection: Collection) {
  return storage(collection).receivedOperations.count()
}

/** Reads all rows used by the statistics screen's dashboard aggregates. */
export function readStatisticsSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).decks, storage(collection).cards, storage(collection).notes, storage(collection).noteTypes, storage(collection).reviewEntries], async () => ({
    decks: await storage(collection).decks.toArray(), cards: await storage(collection).cards.toArray(), notes: await storage(collection).notes.toArray(), noteTypes: await storage(collection).noteTypes.toArray(), reviews: await storage(collection).reviewEntries.toArray(),
  }))
}

/** Reads the full review history for one statistics period. */
export function readReviewHistory(collection: Collection) {
  return readLiveSnapshot(collection, storage(collection).reviewEntries, () => storage(collection).reviewEntries.toArray())
}

/** Reads media references for the sync upload pass. */
export function readSyncMediaReferences(collection: Collection) {
  return readLiveSnapshot(collection, storage(collection).noteMedia, () => storage(collection).noteMedia.toArray())
}

/** Reads pending-operation and conflict counts for sync progress reporting. */
export function readSyncProgressCounts(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).outbox, storage(collection).syncConflicts, storage(collection).pendingRemoteOperations], async () => ({
    pending: await storage(collection).outbox.count(), conflicts: await storage(collection).syncConflicts.count(), incomingPending: await storage(collection).pendingRemoteOperations.count(),
  }))
}

/** Diagnose only unambiguous, never-materialized creates after the remote history is exhausted. */
export function readPendingDeckCycle(collection: Collection) {
  const db = storage(collection)
  return readSnapshot(collection, [db.pendingRemoteOperations, db.decks, db.deletedEntities, db.syncRevisions], async () => {
    const operations = await db.pendingRemoteOperations.where('entityType').equals('deck').toArray()
    const byEntity = new Map<string, typeof operations>()
    for (const operation of operations) {
      const candidates = byEntity.get(operation.entityId) ?? []
      candidates.push(operation)
      byEntity.set(operation.entityId, candidates)
    }
    const ids = [...byEntity.keys()]
    if (!ids.length) return false
    const keys = ids.map(id => `deck:${id}`)
    const decks = await db.decks.bulkGet(ids)
    const barriers = await db.deletedEntities.bulkGet(keys)
    const histories = new Set((await db.syncRevisions.where('key').anyOf(keys).toArray()).map(operation => operation.entityId))
    const parents = new Map<string, string>()
    for (const [index, id] of ids.entries()) {
      const candidates = byEntity.get(id)!
      if (candidates.length !== 1 || decks[index] || barriers[index] || histories.has(id)) continue
      const operation = candidates[0]
      if (operation.action !== 'create' || operation.lifetime?.length || operation.relatedLifetimes?.some(ref => ref.lifetime.length)) continue
      const parent = (operation.payload as Partial<Deck> | undefined)?.parentId
      if (typeof parent === 'string' && parent) parents.set(id, parent)
    }
    const visited = new Set<string>()
    for (const id of parents.keys()) {
      const path = new Set<string>()
      let current: string | undefined = id
      while (current && parents.has(current) && !visited.has(current)) {
        if (path.has(current)) return true
        path.add(current)
        current = parents.get(current)
      }
      for (const node of path) visited.add(node)
    }
    return false
  })
}

/** Reads the visible sync status including collection sizes and stored media. */
export function readSyncStatusSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).notes, storage(collection).cards, storage(collection).mediaBlobs], async () => ({
    notes: await storage(collection).notes.count(), cards: await storage(collection).cards.count(), media: await storage(collection).mediaBlobs.toArray(),
  }))
}

/** Reads the conflicts shown in the conflict-resolution screen. */
export function readSyncConflicts(collection: Collection) {
  return storage(collection).syncConflicts.toArray()
}

/** Reads pending operations and their durable revisions for sync diagnostics. */
export function readSyncJournalSnapshot(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).outbox, storage(collection).syncRevisions], async () => ({
    operations: await storage(collection).outbox.toArray(),
    revisions: await storage(collection).syncRevisions.toArray(),
  }))
}

/** Reads a durable revision by its operation identity. */
export function readSyncRevision(collection: Collection, operationId: string) {
  return storage(collection).syncRevisions.get(operationId)
}

/** Reads one persisted setting without exposing the settings table. */
export function readCollectionSetting(collection: Collection, key: string) {
  return storage(collection).settings.get(key)
}

/** Reads all rows needed to resolve text import destinations and identities. */
export function readTextImportSnapshot(collection: Collection) {
  return readSnapshot(collection, [storage(collection).notes, storage(collection).decks, storage(collection).noteTypes, storage(collection).deletedEntities], async () => ({
    notes: await storage(collection).notes.toArray(), decks: await storage(collection).decks.toArray(), noteTypes: await storage(collection).noteTypes.toArray(),
    deleted: await storage(collection).deletedEntities.toArray(),
  }))
}

/** Reads the row set rendered into a text collection export. */
export function readTextExportSnapshot(collection: Collection) {
  return readSnapshot(collection, [storage(collection).notes, storage(collection).decks, storage(collection).noteTypes, storage(collection).cards], async () => ({
    notes: await storage(collection).notes.toArray(), decks: await storage(collection).decks.toArray(), noteTypes: await storage(collection).noteTypes.toArray(), cards: await storage(collection).cards.toArray(),
  }))
}

/** Reads the Deck and Note Type choices shown by the text exchange dialog. */
export function readTextExchangeChoices(collection: Collection) {
  return readLiveSnapshot(collection, [storage(collection).decks, storage(collection).noteTypes], async () => ({
    decks: await storage(collection).decks.toArray(), noteTypes: await storage(collection).noteTypes.toArray(),
  }))
}

/** Reads whether the sample Deck and its Note Type already exist. */
export function readSampleDeckSnapshot(collection: Collection, deckName: string, noteTypeName: string) {
  return readSnapshot(collection, [storage(collection).decks, storage(collection).notes, storage(collection).noteTypes], async () => {
    const deck = await storage(collection).decks.where('name').equals(deckName).first()
    const noteType = await storage(collection).noteTypes.where('name').equals(noteTypeName).first()
    return { deck, noteType, deckNoteCount: deck ? await storage(collection).notes.where('deckId').equals(deck.id).count() : 0,
      typeNoteCount: noteType ? await storage(collection).notes.where('typeId').equals(noteType.id).count() : 0 }
  })
}

/** Reads a consistent Collection projection used to compare Anki writeback state. */
export function readNativeWritebackSnapshot(collection: Collection) {
  return readSnapshot(collection, [storage(collection).decks, storage(collection).noteTypes, storage(collection).notes, storage(collection).cards, storage(collection).reviewEntries, storage(collection).noteMedia], async () => ({
    decks: await storage(collection).decks.toArray(), notetypes: await storage(collection).noteTypes.toArray(), notes: await storage(collection).notes.toArray(),
    cards: await storage(collection).cards.toArray(), reviews: await storage(collection).reviewEntries.toArray(), references: await storage(collection).noteMedia.toArray(),
  }))
}
