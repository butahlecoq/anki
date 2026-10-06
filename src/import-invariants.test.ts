import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { createCollection, DEFAULT_DECK_OPTION_GROUP_ID, type Collection } from './collection'
import { ImportedPackageRejected, type ImportedPackageWrites } from './import-contract'
import { readDeck, readNote } from './collection-queries'

/**
 * The invariants the hand-written write routes enforce, asserted against the
 * one write route that used to bypass all of them.
 *
 * Import used to open its own transaction over eight tables and write them
 * directly. A package could therefore leave a deck hierarchy that cycles, a tag
 * the app would have refused, or an occlusion mask outside its image - states
 * no other route can produce.
 */
let collection: Collection | undefined

afterEach(async () => {
  await collection?.removeLocalCollection()
  collection = undefined
})

const empty = (): ImportedPackageWrites => ({
  decks: [], deletedDecks: [], noteTypes: [], notes: [], cards: [],
  reviews: [], updatedReviews: [], references: [], deletedReferences: [],
  blobs: [], undoSettings: [],
})

const deck = (id: string, name: string, parentId: string | null, optionGroupId = DEFAULT_DECK_OPTION_GROUP_ID) =>
  ({ value: { id, name, parentId, optionGroupId, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }, action: 'create' as const })

const note = (id: string, deckId: string, extra: Record<string, unknown> = {}) => ({
  value: {
    id, deckId, type: 'basic' as const, typeId: 'basic', fields: { front: '猫', back: 'cat' },
    tags: [], createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', ...extra,
  },
  action: 'create' as const,
})

async function importInto(writes: ImportedPackageWrites) {
  await expect(collection!.applyImportedPackage(writes, '2026-10-01T12:00:00.000Z')).rejects.toThrow(ImportedPackageRejected)
}

describe('an imported package passes the same invariants as a hand-written write', () => {
  test('a deck naming a parent that does not exist is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    await importInto({ ...empty(), decks: [deck('orphan', 'Orphan', 'no-such-parent')] })
  })

  test('a deck that would close a cycle is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const root = await collection.createDeck('Root')
    const child = await collection.createDeck('Child', { parentId: root.id })
    // Re-pointing the root at its own descendant closes the loop.
    await importInto({ ...empty(), decks: [{ value: { ...root, parentId: child.id }, action: 'update' }] })
  })

  test('two decks with one name under one parent are refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const parent = await collection.createDeck('Parent')
    const sibling = await collection.createDeck('Sibling', { parentId: parent.id })
    await importInto({ ...empty(), decks: [{ value: { ...sibling, id: 'duplicate', name: 'Sibling' }, action: 'create' }] })
  })

  test('a deck naming an option group that does not exist is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    await importInto({ ...empty(), decks: [deck('stray', 'Stray', null, 'no-such-group')] })
  })

  test('an oversized tag is refused, as updateNoteTags would refuse it', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Tags')
    await importInto({ ...empty(), notes: [note('note:tagged', target.id, { tags: ['x'.repeat(400)] })] })
  })

  test('a tag list that is not a list of strings is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Tags')
    await importInto({ ...empty(), notes: [note('note:bad-tags', target.id, { tags: 'animal' as never })] })
  })

  test('an occlusion mask outside its image is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Occlusion')
    const writes = empty()
    writes.noteTypes = [{ value: { id: 'image-occlusion', name: 'Occlusion', kind: 'image-occlusion', protected: false, fields: [{ id: 'header', name: 'Header' }], templates: [], createdAt: '', updatedAt: '' }, action: 'create' }]
    writes.notes = [note('note:mask', target.id, {
      typeId: 'image-occlusion',
      imageOcclusion: { version: 1, sourceMediaId: 'media', imageWidth: 400, imageHeight: 400, nextOrdinal: 2, masks: [{ id: 'm1', ordinal: 1, x: 0.9, y: 0.1, width: 0.5, height: 0.5 }] },
    })]
    await importInto(writes)
  })

  test('an occlusion note with no mask data is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Occlusion')
    const writes = empty()
    writes.noteTypes = [{ value: { id: 'image-occlusion', name: 'Occlusion', kind: 'image-occlusion', protected: false, fields: [{ id: 'header', name: 'Header' }], templates: [], createdAt: '', updatedAt: '' }, action: 'create' }]
    writes.notes = [note('note:empty-mask', target.id, { typeId: 'image-occlusion' })]
    await importInto(writes)
  })

  test('a note or card naming a row the batch does not create is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    await importInto({ ...empty(), notes: [note('note:stray', 'no-such-deck')] })
    const target = await collection.createDeck('Cards')
    await importInto({ ...empty(), cards: [{ value: { id: 'card:stray', deckId: target.id, noteId: 'no-such-note', templateId: 'basic', due: '', stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null } as never, action: 'create' }] })
  })

  test('a refusal writes nothing at all', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const writes = { ...empty(), decks: [deck('good', 'Good', null), deck('bad', 'Bad', 'missing')], notes: [] }
    await expect(collection.applyImportedPackage(writes, '2026-10-01T12:00:00.000Z')).rejects.toThrow(ImportedPackageRejected)
    // The valid deck in the same batch must not have landed.
    await expect(readDeck(collection, 'good')).resolves.toBeUndefined()
    await expect(collection.pendingOperations()).resolves.toEqual([])
  })

  test('a valid batch still lands, and enqueues one operation per row', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Landing')
    const writes = { ...empty(), decks: [], notes: [note('note:lands', target.id)] }
    await collection.applyImportedPackage(writes, '2026-10-01T12:00:00.000Z')
    await expect(readNote(collection, 'note:lands')).resolves.toMatchObject({ id: 'note:lands', tags: [] })
    await expect(collection.pendingOperations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'note', entityId: 'note:lands', action: 'create' })]))
  })

  test('a note type that can never generate a card is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Types')
    const writes = empty()
    writes.noteTypes = [{ value: { id: 'broken', name: 'Broken', kind: 'cloze', protected: false, fields: [{ id: 'f', name: 'Front' }, { id: 'g', name: 'Back' }], templates: [{ id: 't', name: 'Recognition', front: '{{Front}}', back: '{{Back}}', css: '' }], createdAt: '', updatedAt: '' }, action: 'create' }]
    writes.notes = [note('note:typed', target.id, { typeId: 'broken' })]
    await importInto(writes)
  })

  test('a note type with duplicate field names is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const writes = empty()
    writes.noteTypes = [{ value: { id: 'dupes', name: 'Dupes', kind: 'standard', protected: false, fields: [{ id: 'a', name: 'Word' }, { id: 'b', name: 'word' }], templates: [{ id: 't', name: 'Recognition', front: '{{Word}}', back: '{{Word}}', css: '' }], createdAt: '', updatedAt: '' }, action: 'create' }]
    await importInto(writes)
  })

  test('a note claiming a deleted identity is refused, so a tombstone stays dead', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Tombstones')
    const doomed = await collection.createBasicNote(target.id, { front: '犬', back: 'dog' })
    await collection.deleteNote(doomed.id)
    await expect(readNote(collection, doomed.id)).resolves.toBeUndefined()
    // Re-importing a package carrying that note must not resurrect it: inbound
    // sync suppresses every operation for a tombstoned identity, so a live row
    // here could never be synchronised or deleted again.
    await importInto({ ...empty(), notes: [note(doomed.id, target.id)] })
  })

  test('a note with a malformed identity is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Identity')
    await importInto({ ...empty(), notes: [note('bad id', target.id)] })
  })

  test('an older package may not renumber occlusion masks the learner already has', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Masks')
    const existing = note('note:masks', target.id, {
      typeId: 'image-occlusion',
      imageOcclusion: { version: 1, sourceMediaId: 'media', imageWidth: 400, imageHeight: 400, nextOrdinal: 2, masks: [{ id: 'm1', ordinal: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] },
    })
    await collection.applyImportedPackage({ ...empty(), notes: [existing] }, '2026-10-01T12:00:00.000Z')
    // The same mask arriving with a different ordinal would rebind every card
    // identity that embeds it.
    await importInto({ ...empty(), notes: [note('note:masks', target.id, {
      typeId: 'image-occlusion',
      imageOcclusion: { version: 1, sourceMediaId: 'media', imageWidth: 400, imageHeight: 400, nextOrdinal: 3, masks: [{ id: 'm1', ordinal: 2, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] },
    })] })
  })

  test('a review naming a card the package does not carry is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    await importInto({ ...empty(), reviews: [{ id: 'review:stray', cardId: 'no-such-card', deckId: 'no-such-deck', rating: 3, state: 2, due: '', stability: 0, difficulty: 0, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' }] })
  })

  test('a media reference naming media the package did not carry is refused', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Media')
    const writes = { ...empty(), notes: [note('note:media', target.id)] }
    writes.references = [{ value: { id: 'media:1', noteId: 'note:media', digest: 'a'.repeat(64), kind: 'image', mimeType: 'image/png', displayName: 'cat.png', side: 'front', playback: 'manual', createdAt: '', updatedAt: '' }, action: 'create' }]
    await importInto(writes)
  })

  test('imported tags are normalised, not merely validated', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const target = await collection.createDeck('Normalising')
    await collection.applyImportedPackage({ ...empty(), notes: [note('note:tags', target.id, { tags: ['  Animal  ', 'JLPT::N5', 'Animal', ''] })] }, '2026-10-01T12:00:00.000Z')
    const stored = await readNote(collection, 'note:tags')
    // Trimmed, empties dropped, exact duplicates collapsed - the same result
    // `updateNoteTags` produces.
    expect(stored?.tags).toEqual(['Animal', 'JLPT::N5'])
  })

  test('a deck the same batch deletes does not make an incoming sibling a duplicate', async () => {
    collection = createCollection(`import-invariants-${crypto.randomUUID()}`)
    const superseded = await collection.createDeck('Shared')
    const existing = (await readDeck(collection, superseded.id))!
    const incoming = { ...existing, id: 'deck:incoming' }
    // The reconciliation writes the replacement and deletes the old row in one
    // batch; if the old row still counted, every rekeyed import would fail.
    await collection.applyImportedPackage({ ...empty(), decks: [{ value: incoming, action: 'create' }], deletedDecks: [superseded] }, '2026-10-01T12:00:00.000Z')
    await expect(readDeck(collection, 'deck:incoming')).resolves.toMatchObject({ name: 'Shared' })
    await expect(readDeck(collection, superseded.id)).resolves.toBeUndefined()
  })
})
