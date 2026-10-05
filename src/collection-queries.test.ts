import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { createCollection, type Collection } from './collection'
import { readAnkiExportSnapshot, readAnkiImportMediaBlobs, readAnkiImportSnapshot, readBrowserFieldState, readBrowserSelectionSnapshot, readCustomStudyQueueSnapshot, readCustomStudySessions, readCustomStudySnapshot } from './collection-queries'

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

test('browser and custom-study named queries declare their smallest read sets', async () => {
  const collection = database()
  const deck = await collection.createDeck('日本語')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  const transaction = vi.spyOn(collection, 'transaction')

  await expect(readBrowserSelectionSnapshot(collection, { view: 'cards', ids: [card.id] })).resolves.toMatchObject({ notes: [note], cards: [card], generatedCards: 1 })
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', [collection.notes, collection.cards]])

  transaction.mockClear()
  await readBrowserFieldState(collection, [{ noteId: note.id, typeId: note.typeId }])
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', [collection.notes, collection.noteTypes]])

  transaction.mockClear()
  await readCustomStudySnapshot(collection, 'customStudySessions')
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings]])

  transaction.mockClear()
  await readCustomStudyQueueSnapshot(collection, 'customStudySessions', 'missing-session')
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', [collection.settings, collection.cards, collection.notes, collection.noteTypes]])

  transaction.mockClear()
  await readCustomStudySessions(collection, 'customStudySessions')
  expect(transaction.mock.calls[0]?.slice(0, 2)).toEqual(['r', collection.settings])
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
