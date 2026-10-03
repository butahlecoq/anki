import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import { createCollection, type Collection } from './collection'
import { readAnkiExportSnapshot } from './collection-queries'

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
