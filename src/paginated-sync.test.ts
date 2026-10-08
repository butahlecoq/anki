// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSyncService } from '../server/sync-service'
import { createSyncHttpHandler } from '../server/sync-http'
import { createCollection, Rating, type Collection, type Deck, type SyncOperation } from './collection'
import { foregroundSync, pairCollection, syncCollection, uploadMedia } from './sync-client'
import { readAnkiExportSnapshot, readCardsForNote, readSyncProgressCounts } from './collection-queries'
import { syncOutcomeMessage } from './sync-messages'

function correctParent(operation: SyncOperation, parent: Deck): SyncOperation {
  return { ...operation, opId: 'correct-parent-cycle', action: 'update', parents: [operation.opId], payload: parent,
    relatedLifetimes: operation.relatedLifetimes?.map(ref => ref.entityType === 'deck' ? { ...ref, entityId: parent.parentId! } : ref) }
}

async function withHistory(customOptions: boolean, run: (source: Collection, receiver: Collection, operations: SyncOperation[], receiverName: string, sendRemaining: () => Promise<void>) => Promise<void>, options: { deleteRoot?: boolean; firstPageOnly?: boolean; cycle?: boolean; correctedCycle?: boolean } = {}) {
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-paginated-'))
  const service = createSyncService({ databasePath: join(runtime, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  const source = createCollection(`kiroku-source-${crypto.randomUUID()}`)
  const receiverName = `kiroku-receiver-${crypto.randomUUID()}`
  const receiver = createCollection(receiverName)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test service address')
  try {
    const endpoint = `http://127.0.0.1:${address.port}`
    for (const device of [source, receiver]) expect(await pairCollection(device, endpoint, service.createPairingCode())).toMatchObject({ state: 'paired' })
    const now = new Date('2026-10-01T12:00:00Z')
    const group = await source.createDeckOptionGroup('Japanese settings', now)
    const root = await source.createDeck('Japanese', now)
    const parent = await source.createDeck('Grammar', { parentId: root.id, ...(customOptions ? { optionGroupId: group.id } : {}) }, now)
    const child = await source.createDeck('Verbs', { parentId: parent.id, ...(customOptions ? { optionGroupId: group.id } : {}) }, now)
    const type = await source.createNoteType({ name: 'Vocabulary', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', front: '{{Expression}}', back: '{{Meaning}}', css: '' }] }, now)
    const note = await source.createNote(child.id, type.id, { [type.fields[0].id]: '食べる', [type.fields[1].id]: 'to eat' }, now)
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
    await source.attachMedia(note.id, { file: new File([png], 'food.png', { type: 'image/png' }), side: 'front' }, now)
    const card = (await readCardsForNote(source, note.id))[0]
    await source.answer(card.id, Rating.Good, new Date('2026-10-01T13:00:00Z'))
    if (options.deleteRoot) await source.deleteDeck(root.id, { mode: 'delete-subtree' })
    const original = await source.pendingOperations()
    const lateIds = new Set([parent.id, root.id, group.id, type.id])
    const early = original.filter(op => !lateIds.has(op.entityId))
    const rootOperation = original.find(op => op.entityId === root.id)!
    const fillers: SyncOperation[] = Array.from({ length: 300 }, (_, index) => ({ ...rootOperation, opId: `filler-op-${index}`, entityId: `filler-${index}`, payload: { ...root, id: `filler-${index}`, name: `Unrelated ${index}` } }))
    // The real service must retain this old append order, not repair the fixture.
    const operations = [...early, ...fillers, ...original.filter(op => lateIds.has(op.entityId))]
    if (options.cycle) {
      const index = operations.findIndex(op => op.entityId === parent.id)
      const operation = operations[index]
      operations[index] = { ...operation, payload: { ...parent, parentId: child.id }, relatedLifetimes: operation.relatedLifetimes?.map(ref => ref.entityType === 'deck' ? { ...ref, entityId: child.id } : ref) }
      if (options.correctedCycle) operations.push(...fillers.map((op, index) => ({ ...op, opId: `extra-filler-op-${index}`, entityId: `extra-filler-${index}`, payload: { ...root, id: `extra-filler-${index}`, name: `Extra unrelated ${index}` } })), correctParent(operations[index], parent))
    }
    expect(operations.findIndex(op => op.entityId === parent.id) - operations.findIndex(op => op.entityId === child.id)).toBeGreaterThan(250)
    const settings = (await source.syncSettings())!
    const snapshot = await readAnkiExportSnapshot(source)
    for (const blob of snapshot.blobs) await uploadMedia(settings, blob.digest, (await source.verifiedMediaBlob(blob.digest))!.blob)
    const send = async (offset: number) => {
      expect(await foregroundSync(settings, operations.slice(offset, offset + 250))).toMatchObject({ state: 'complete', accepted: Math.min(250, operations.length - offset) })
    }
    const sent = options.firstPageOnly ? 250 : operations.length
    for (let offset = 0; offset < sent; offset += 250) await send(offset)
    const sendRemaining = async () => { for (let offset = sent; offset < operations.length; offset += 250) await send(offset) }
    await run(source, receiver, operations, receiverName, sendRemaining)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await Promise.all([source.removeLocalCollection(), receiver.removeLocalCollection()])
    await rm(runtime, { recursive: true, force: true })
  }
}

test.each([false, true])('downloads nested decks and every related record when their parents arrive more than a page later (custom options: %s)', async customOptions => {
  await withHistory(customOptions, async (source, receiver, operations) => {
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length, media: { pending: 0 } })
    const expected = await readAnkiExportSnapshot(source)
    const actual = await readAnkiExportSnapshot(receiver)
    expect(actual.decks).toHaveLength(303)
    for (const deck of expected.decks) expect(actual.decks).toContainEqual(deck)
    for (const type of expected.types.filter(type => type.name === 'Vocabulary')) expect(actual.types).toContainEqual(type)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.cards).toEqual(expected.cards)
    expect(actual.reviews).toEqual(expected.reviews)
    expect(actual.references).toEqual(expected.references)
    expect(actual.blobs.map(blob => blob.digest)).toEqual(expected.blobs.map(blob => blob.digest))
    expect(await readSyncProgressCounts(receiver)).toMatchObject({ incomingPending: 0, conflicts: 0 })
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length })
    expect((await readAnkiExportSnapshot(receiver)).reviews).toHaveLength(1)
  })
})

test('an exhausted cyclic history reports a repairable hierarchy problem and converges after an ordinary corrective upload', async () => {
  await withHistory(true, async (source, receiver, operations) => {
    const outcome = await syncCollection(receiver)
    expect(outcome).toMatchObject({ state: 'incomplete', cursor: operations.length, remoteChangesPending: false })
    expect(syncOutcomeMessage(outcome)).toContain('deck parent cycle')
    expect(syncOutcomeMessage(outcome)).toContain('Correct the hierarchy on the sending device')
    expect((await readAnkiExportSnapshot(receiver)).notes).toEqual([])
    const validParent = (await readAnkiExportSnapshot(source)).decks.find(deck => deck.name === 'Grammar')!
    const badParent = operations.find(op => op.entityId === validParent.id)!
    const correction = correctParent(badParent, validParent)
    expect(await foregroundSync((await source.syncSettings())!, [correction])).toMatchObject({ state: 'complete', accepted: 1 })
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length + 1 })
    const actual = await readAnkiExportSnapshot(receiver)
    const expected = await readAnkiExportSnapshot(source)
    for (const deck of expected.decks) expect(actual.decks).toContainEqual(deck)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.reviews).toEqual(expected.reviews)
    expect(await readSyncProgressCounts(receiver)).toMatchObject({ incomingPending: 0, conflicts: 0 })
  }, { cycle: true })
})

test('a transient deck cycle does not block a corrective revision on a later response page', async () => {
  await withHistory(true, async (source, receiver, operations) => {
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length })
    const expected = await readAnkiExportSnapshot(source)
    const actual = await readAnkiExportSnapshot(receiver)
    expect(actual.decks).toHaveLength(603)
    for (const deck of expected.decks) expect(actual.decks).toContainEqual(deck)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.cards).toEqual(expected.cards)
    expect(actual.reviews).toEqual(expected.reviews)
    expect(await readSyncProgressCounts(receiver)).toMatchObject({ incomingPending: 0, conflicts: 0 })
  }, { cycle: true, correctedCycle: true })
}, 15_000)

test('an interrupted receive durably retains a page and recovers through ordinary sync after reopening', async () => {
  await withHistory(true, async (source, receiver, operations, receiverName) => {
    let requests = 0
    const interrupted: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/sync') && ++requests === 2) throw new TypeError('Synthetic interruption')
      return fetch(url, init)
    }
    expect(await syncCollection(receiver, interrupted)).toMatchObject({ state: 'unreachable' })
    expect((await receiver.syncSettings())?.cursor).toBe(250)
    expect((await readSyncProgressCounts(receiver)).incomingPending).toBeGreaterThan(0)
    expect((await readAnkiExportSnapshot(receiver)).notes).toEqual([])
    receiver.closeLocalCollection()
    const reopened = createCollection(receiverName)
    try {
      expect((await reopened.syncSettings())?.cursor).toBe(250)
      expect((await readSyncProgressCounts(reopened)).incomingPending).toBeGreaterThan(0)
      expect(await syncCollection(reopened)).toMatchObject({ state: 'complete', cursor: operations.length, media: { pending: 0 } })
      const expected = await readAnkiExportSnapshot(source)
      const actual = await readAnkiExportSnapshot(reopened)
      expect(actual.notes).toEqual(expected.notes)
      expect(actual.cards).toEqual(expected.cards)
      expect(actual.reviews).toEqual(expected.reviews)
      expect(await syncCollection(reopened)).toMatchObject({ state: 'complete' })
      expect((await readAnkiExportSnapshot(reopened)).reviews).toHaveLength(1)
    } finally { reopened.closeLocalCollection() }
  })
})

test('a later subtree tombstone settles retained descendants including media without resurrecting records', async () => {
  await withHistory(true, async (_source, receiver, operations) => {
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length })
    const actual = await readAnkiExportSnapshot(receiver)
    expect(actual.decks).toHaveLength(300)
    expect(actual.notes).toEqual([])
    expect(actual.cards).toEqual([])
    expect(actual.reviews).toEqual([])
    expect(actual.references).toEqual([])
    expect(await readSyncProgressCounts(receiver)).toMatchObject({ incomingPending: 0 })
  }, { deleteRoot: true })
})

test('an exhausted partial history reports missing records honestly and recovers without resetting after they are uploaded', async () => {
  await withHistory(true, async (_source, receiver, operations, _receiverName, sendRemaining) => {
    const first = await syncCollection(receiver)
    expect(first).toMatchObject({ state: 'incomplete', cursor: 250, remoteChangesPending: false, pendingOperations: 0 })
    if (first.state !== 'incomplete') throw new Error('Missing dependencies must not report complete')
    expect(first.pendingIncomingOperations).toBeGreaterThan(0)
    expect(syncOutcomeMessage(first)).toContain('Sync the sending device')
    expect((await readAnkiExportSnapshot(receiver)).notes).toEqual([])
    const settings = await receiver.syncSettings()
    expect(await syncCollection(receiver)).toMatchObject({ state: 'incomplete', cursor: 250 })
    expect(await receiver.syncSettings()).toEqual(settings)
    await sendRemaining()
    expect(await syncCollection(receiver)).toMatchObject({ state: 'complete', cursor: operations.length, media: { pending: 0 } })
    expect((await readAnkiExportSnapshot(receiver)).reviews).toHaveLength(1)
  }, { firstPageOnly: true })
})
