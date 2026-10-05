import type { CardRecord, Collection, Note } from './collection'
import type { BrowserSelection } from './browser-maintenance'
import type { CustomStudySession } from './custom-study-state'

/** One consistent set of local rows used to plan an Anki Exchange. */
export function readAnkiImportSnapshot(collection: Collection, partialChoiceKey?: string) {
  return collection.transaction('r', [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.settings], async () => ({
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
  return collection.transaction('r', collection.mediaBlobs, () => collection.mediaBlobs.bulkGet(digests))
}

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

/** Resolves the selected rows and their generated-card count for a fresh browser confirmation. */
export function readBrowserSelectionSnapshot(collection: Collection, selection: BrowserSelection) {
  return collection.transaction('r', [collection.notes, collection.cards], async () => {
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
  return collection.transaction('r', collection.decks, () => collection.decks.get(deckId))
}

/** Reads every row named by a field-change preview in one consistent snapshot. */
export function readBrowserFieldState(collection: Collection, changes: readonly { noteId: string; typeId: string }[]) {
  return collection.transaction('r', [collection.notes, collection.noteTypes], async () => {
    const noteIds = [...new Set(changes.map((change) => change.noteId))]
    const typeIds = [...new Set(changes.map((change) => change.typeId))]
    const [notes, noteTypes] = await Promise.all([collection.notes.bulkGet(noteIds), collection.noteTypes.bulkGet(typeIds)])
    return { notes: notes.filter((note) => note !== undefined), noteTypes: noteTypes.filter((noteType) => noteType !== undefined) }
  })
}

/** A stable read set for the custom-study search and ordering rules. */
export function readCustomStudySnapshot(collection: Collection, sessionKey: string) {
  return collection.transaction('r', [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings], async () => ({
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
  return collection.transaction('r', collection.settings, async () => (await collection.settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? [])
}

/** Resolves one saved session and just the rows needed to build its current queue. */
export function readCustomStudyQueueSnapshot(collection: Collection, sessionKey: string, sessionId: string) {
  return collection.transaction('r', [collection.settings, collection.cards, collection.notes, collection.noteTypes], async () => {
    const sessions = (await collection.settings.get(sessionKey))?.value as CustomStudySession[] | undefined ?? []
    const session = sessions.find((item) => item.id === sessionId)
    const cards = session ? (await collection.cards.bulkGet(session.cardIds)).filter((card) => card !== undefined) : []
    const notes = await collection.notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
    return { sessions, session, cards, notes, noteTypes: await collection.noteTypes.toArray() }
  })
}
