import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { createCollection, type Collection } from './collection'
import { readAnkiExportSnapshot, readAnkiImportMediaBlobs, readAnkiImportSnapshot, readBrowserFieldState, readBrowserSelectionSnapshot, readCardsForNote, readCustomStudyQueueSnapshot, readCustomStudySessions, readCustomStudySnapshot } from './collection-queries'

const collections: Collection[] = []
function database() {
  const collection = createCollection(crypto.randomUUID())
  collections.push(collection)
  return collection
}

afterEach(async () => {
  await Promise.all(collections.splice(0).map((collection) => collection.delete()))
})

test('Anki export snapshot owns one read transaction over only its required tables', async () => {
  const collection = database()
  const transaction = vi.spyOn(collection, 'transaction')

  const snapshot = await readAnkiExportSnapshot(collection)

  expect(snapshot).toMatchObject({ decks: [], notes: [], cards: [], reviews: [], references: [], blobs: [] })
  expect(snapshot.types.map((type) => type.id)).toEqual(['basic', 'image-occlusion'])
  expect(transaction).toHaveBeenCalledOnce()
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual([
    'r',
    [collection.decks, collection.notes, collection.noteTypes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs],
  ])
})

test('Anki import reads one consistent named snapshot and only looks up requested media digests', async () => {
  const collection = database()
  const transaction = vi.spyOn(collection, 'transaction')

  const snapshot = await readAnkiImportSnapshot(collection, 'ankiPartialImport:source')
  expect(snapshot).toMatchObject({ decks: [], notes: [], cards: [], reviews: [], references: [], partialChoice: undefined, noteDeletionUndo: undefined })
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual([
    'r',
    [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.settings],
  ])

  transaction.mockClear()
  await readAnkiImportMediaBlobs(collection, ['digest-a', 'digest-b'])
  expect(transaction.mock.calls).toHaveLength(1)
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', collection.mediaBlobs])
})

test('browser live queries keep tracked reads while stable custom-study snapshots own their read sets', async () => {
  const collection = database()
  const deck = await collection.createDeck('日本語')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const card = (await readCardsForNote(collection, note.id))[0]!
  const transaction = vi.spyOn(collection, 'transaction')

  await expect(readBrowserSelectionSnapshot(collection, { view: 'cards', ids: [card.id] })).resolves.toMatchObject({ notes: [note], cards: [card], generatedCards: 1 })
  expect(transaction).not.toHaveBeenCalled()

  await expect(readBrowserFieldState(collection, [{ noteId: note.id, typeId: note.typeId }])).resolves.toMatchObject({ notes: [note] })
  expect(transaction).not.toHaveBeenCalled()

  await readCustomStudySnapshot(collection, 'customStudySessions')
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings]])

  transaction.mockClear()
  await expect(readCustomStudyQueueSnapshot(collection, 'customStudySessions', 'missing-session')).resolves.toMatchObject({ session: undefined, cards: [] })
  expect(transaction).not.toHaveBeenCalled()

  await expect(readCustomStudySessions(collection, 'customStudySessions')).resolves.toEqual([])
  expect(transaction).not.toHaveBeenCalled()
})

test('the four first callers use named reads and mutations instead of raw table queries', async () => {
  const paths = ['anki-import.ts', 'anki-export.ts', 'browser-maintenance.ts', 'custom-study.ts']
  const [importer, exporter, browser, customStudy] = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  expect(importer).toContain('readAnkiImportSnapshot')
  expect(importer).toContain('readAnkiImportMediaBlobs')
  expect(exporter).toContain('readAnkiExportSnapshot')
  expect(browser).toContain('readBrowserSelectionSnapshot')
  expect(browser).toContain('readBrowserFieldState')
  expect(customStudy).toContain('readCustomStudySnapshot')
  expect(customStudy).toContain('readCustomStudyQueueSnapshot')
  expect(customStudy).toContain('persistCustomStudySessions')

  for (const source of [importer, exporter, browser, customStudy]) {
    expect(source).not.toMatch(/\b(?:collection|db)\.tables\b/)
  }
  for (const source of [importer, exporter, browser, customStudy]) {
    expect(source).not.toMatch(/\b(?:collection|db)\.(?:decks|noteTypes|notes|cards|reviewEntries|noteMedia|mediaBlobs|settings)\.(?:toArray|bulkGet|where|get|put)\s*\(/)
  }
})

test('remaining production callers keep table reads inside named collection queries', async () => {
  const paths = [
    'CollectionBrowser.tsx', 'CollectionWorkspace.tsx', 'CustomStudy.tsx', 'ImageOcclusion.tsx', 'NoteTypeManager.tsx',
    'ReviewSession.tsx', 'Statistics.tsx', 'SyncConflicts.tsx', 'SyncControls.tsx', 'TextCollectionDialog.tsx',
    'native-anki-writeback.ts', 'sample-deck.ts', 'sync-client.ts', 'text-csv.ts',
  ]
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  const rawRead = /\b(?:collection|db)\.(?:decks|notes|cards|noteTypes|reviewEntries|settings|mediaBlobs|noteMedia|outbox|syncRevisions|syncConflicts|receivedOperations|deletedEntities)\.(?:toArray|get|bulkGet|where|filter|count|first|orderBy|offset|limit|each|keys|primaryKeys|toCollection)\s*\(/
  for (const [index, source] of sources.entries()) {
    expect(source, paths[index]).not.toMatch(rawRead)
  }
})
