// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { decompress } from 'fzstd'
import { unzipSync, zipSync } from 'fflate'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { createSyncService } from '../server/sync-service'
import { createSyncHttpHandler } from '../server/sync-http'
import { foregroundSync, pairCollection, syncCollection, uploadMedia } from './sync-client'
import { createCollection, Rating, type Collection, type SyncOperation } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'
import { readAnkiExportSnapshot, readAnkiImportSnapshot, readCardsForNote, readReceivedOperation, readSyncConflicts, readSyncProgressCounts } from './collection-queries'

let SQL: SqlJsStatic
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })

async function restorationPackage(includeOtherRoot = false, conditionalCard = false) {
  const owner = createCollection(`kiroku-restoration-fixture-${crypto.randomUUID()}`)
  try {
  const root = await owner.createDeck('Restoration root')
  const child = await owner.createDeck('Restoration child', { parentId: root.id })
  const type = includeOtherRoot ? await owner.createNoteType({ name: 'Restoration vocabulary', fields: [{ name: 'front' }, { name: 'back' }, ...(conditionalCard ? [{ name: 'extra' }] : [])], templates: [{ name: 'Recognition', front: '{{front}}', back: '{{back}}', css: '' }, ...(conditionalCard ? [{ name: 'Extra recognition', front: '{{#extra}}{{extra}}{{/extra}}', back: '{{back}}', css: '' }] : [])] }) : undefined
  const note = type ? await owner.createNote(child.id, type.id, { [type.fields[0].id]: 'cat', [type.fields[1].id]: 'a small feline' }) : await owner.createBasicNote(child.id, { front: 'cat', back: 'a small feline' })
  if (type) await owner.createNote(child.id, type.id, { [type.fields[0].id]: 'dog', [type.fields[1].id]: 'a canine' })
  else await owner.createBasicNote(child.id, { front: 'dog', back: 'a canine' })
  if (includeOtherRoot) {
    const other = await owner.createDeck('Other root')
    await owner.createBasicNote(other.id, { front: 'other root vocabulary', back: 'keeps the second root in the package' })
  }
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
  await owner.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  const exported = await exportAnkiPackage(owner, { SQL, scheduling: true, history: true, media: true })
  return new File([exported.bytes.slice().buffer as ArrayBuffer], 'restoration.apkg', { type: 'application/octet-stream' })
  } finally { await owner.removeLocalCollection() }
}

async function editedPackage(file: File, edit: (database: InstanceType<SqlJsStatic['Database']>) => void, name: string) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const databaseEntry = Object.keys(archive).find(entry => entry.startsWith('collection.anki'))!
  const packed = archive[databaseEntry]
  const database = new SQL.Database(packed[0] === 0x28 ? decompress(packed) : packed)
  let bytes: Uint8Array
  try { edit(database); bytes = database.export() }
  finally { database.close() }
  if (packed[0] === 0x28) {
    expect(bytes.length).toBeLessThan(128 * 1024)
    const frame = new Uint8Array(13 + bytes.length)
    frame.set([0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x38])
    new DataView(frame.buffer).setUint32(6, bytes.length, true)
    const block = (bytes.length << 3) | 1
    frame.set([block & 255, (block >>> 8) & 255, (block >>> 16) & 255], 10)
    frame.set(bytes, 13)
    archive[databaseEntry] = frame
  } else archive[databaseEntry] = Uint8Array.from(bytes)
  return new File([zipSync(archive).slice().buffer as ArrayBuffer], name)
}

async function withPairedCollections(count: number, run: (devices: Collection[], service: ReturnType<typeof createSyncService>, origin: string) => Promise<void>, initiallyPaired = count) {
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-restoration-client-'))
  const service = createSyncService({ databasePath: join(runtime, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  const devices = Array.from({ length: count }, () => createCollection(`kiroku-real-restoration-${crypto.randomUUID()}`))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test service did not bind its isolated loopback port')
  try {
    for (const device of devices.slice(0, initiallyPaired)) expect(await pairCollection(device, `http://127.0.0.1:${address.port}`, service.createPairingCode())).toMatchObject({ state: 'paired' })
    await run(devices, service, `http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await Promise.all(devices.map(device => device.removeLocalCollection()))
    await rm(runtime, { recursive: true, force: true })
  }
}

async function syncComplete(device: Collection, stage?: string) {
  const result = await syncCollection(device).catch(error => { throw new Error(stage ?? 'Synchronization failed', { cause: error }) })
  expect(result).toMatchObject({ state: 'complete', media: { pending: 0 } })
}

test('image occlusion restoration waits atomically for its generated source restoration on a later HTTP page', async () => {
  const builder = createCollection(`kiroku-io-restoration-${crypto.randomUUID()}`)
  let file: File
  try {
    const deck = await builder.createDeck('Occlusion restoration')
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
    const note = await builder.createImageOcclusionNote(deck.id, { image: new File([png], 'diagram.png', { type: 'image/png' }), imageWidth: 1, imageHeight: 1, header: '骨', backExtra: 'bone', tags: ['diagram'], masks: [{ x: .1, y: .2, width: .3, height: .2 }] })
    await builder.answer((await readCardsForNote(builder, note.id))[0].id, Rating.Good)
    const exported = await exportAnkiPackage(builder, { SQL, scheduling: true, history: true, media: true })
    file = new File([exported.bytes.slice().buffer as ArrayBuffer], 'occlusion-restoration.apkg')
  } finally { await builder.removeLocalCollection() }
  await withPairedCollections(2, async ([owner, observer]) => {
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    const original = await readAnkiExportSnapshot(owner)
    await owner.deleteDeck(original.notes[0].deckId, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await syncComplete(observer)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    const restored = await owner.pendingOperations()
    const media = restored.filter(operation => operation.entityType === 'noteMedia')
    expect(media.every(operation => operation.action === 'restore')).toBe(true)
    await owner.acknowledgeOperations(restored.map(operation => operation.opId))
    for (let index = 0; index < 300; index++) await owner.createDeck(`Restoration filler ${index}`)
    const operations = [...restored.filter(operation => operation.entityType !== 'noteMedia'), ...await owner.pendingOperations(), ...media]
    expect(operations.indexOf(media[0]) - operations.findIndex(operation => operation.entityType === 'note')).toBeGreaterThan(250)
    for (let offset = 0; offset < operations.length; offset += 250) expect(await foregroundSync((await owner.syncSettings())!, operations.slice(offset, offset + 250))).toMatchObject({ state: 'complete' })
    await syncComplete(observer)
    const actual = await readAnkiExportSnapshot(observer)
    const expected = await readAnkiExportSnapshot(owner)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.cards).toEqual(expected.cards.map(card => ({ ...card, suspended: false })))
    expect(actual.reviews).toEqual(expected.reviews)
    expect(actual.references).toEqual(expected.references)
    expect(actual.blobs.map(blob => blob.digest)).toEqual(expected.blobs.map(blob => blob.digest))
    expect(await readSyncProgressCounts(observer)).toMatchObject({ incomingPending: 0, conflicts: 0 })
  })
}, 15_000)

test.each([false, true])('an imported Basic note can convert to image occlusion with later owner/source pages (card precedes owner: %s)', async cardBeforeNote => {
  const builder = createCollection(`kiroku-io-conversion-${crypto.randomUUID()}`)
  let basicFile: File, convertedFile: File, guid: string
  try {
    const deck = await builder.createDeck('Imported conversion', new Date('2026-10-01T12:00:00Z'))
    const basic = await builder.createBasicNote(deck.id, { front: '骨', back: 'bone' }, new Date('2026-10-01T12:00:00Z'))
    guid = basic.id
    const initial = await exportAnkiPackage(builder, { SQL, scheduling: true, history: true, media: true })
    basicFile = new File([initial.bytes.slice().buffer as ArrayBuffer], 'basic-before-conversion.apkg')
    await builder.deleteNote(basic.id)
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
    const image = await builder.createImageOcclusionNote(deck.id, { image: new File([png], 'diagram.png', { type: 'image/png' }), imageWidth: 1, imageHeight: 1, header: '骨', backExtra: 'bone', tags: ['diagram'], masks: [{ x: .1, y: .2, width: .3, height: .2 }] }, new Date('2026-10-02T12:00:00Z'))
    await builder.answer((await readCardsForNote(builder, image.id))[0].id, Rating.Good, new Date('2026-10-02T13:00:00Z'))
    const converted = await exportAnkiPackage(builder, { SQL, scheduling: true, history: true, media: true })
    convertedFile = await editedPackage(new File([converted.bytes.slice().buffer as ArrayBuffer], 'conversion.apkg'), database => {
      // Anki retains a note's GUID when the learner changes its note type.
      database.run('UPDATE notes SET guid = ?', [guid])
    }, 'same-guid-occlusion.apkg')
  } finally { await builder.removeLocalCollection() }
  await withPairedCollections(2, async ([owner, observer]) => {
    await (await prepareAnkiImport(basicFile, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    const beforeConversion = await readAnkiExportSnapshot(observer)
    const prior = beforeConversion.notes[0]
    expect(prior.imageOcclusion).toBeUndefined()
    const preview = await prepareAnkiImport(convertedFile, owner, { SQL })
    expect(preview.issues.filter(issue => issue.severity === 'error')).toEqual([])
    await preview.commit()
    const converted = (await readAnkiExportSnapshot(owner)).notes[0]
    expect(converted.id).toBe(prior.id)
    expect(converted.imageOcclusion?.sourceMediaId).toBe(`${prior.id}:image-occlusion-source`)
    const generated = await owner.pendingOperations()
    expect(generated.find(operation => operation.entityType === 'note' && operation.entityId === prior.id)?.action).toBe('update')
    const sources = generated.filter(operation => operation.entityType === 'noteMedia')
    expect(sources).toHaveLength(1)
    expect(sources[0].action).toBe('create')
    await owner.acknowledgeOperations(generated.map(operation => operation.opId))
    for (let index = 0; index < (cardBeforeNote ? 600 : 300); index++) await owner.createDeck(`Conversion filler ${index}`)
    const fillers = await owner.pendingOperations()
    const maskCards = generated.filter(operation => operation.entityType === 'card' && (operation.payload as { occlusionId?: string }).occlusionId)
    expect(maskCards).toHaveLength(1)
    const early = cardBeforeNote ? maskCards : []
    const earlyIds = new Set(early.map(operation => operation.opId))
    const remainder = generated.filter(operation => operation.entityType !== 'noteMedia' && !earlyIds.has(operation.opId))
    const operations = cardBeforeNote
      ? [...early, ...fillers.slice(0, 300), ...remainder, ...fillers.slice(300), ...sources]
      : [...remainder, ...fillers, ...sources]
    if (cardBeforeNote) expect(operations.findIndex(operation => operation.entityType === 'note') - operations.indexOf(maskCards[0])).toBeGreaterThan(250)
    expect(operations.indexOf(sources[0]) - operations.findIndex(operation => operation.entityType === 'note')).toBeGreaterThan(250)
    for (const blob of (await readAnkiExportSnapshot(owner)).blobs) await uploadMedia((await owner.syncSettings())!, blob.digest, (await owner.verifiedMediaBlob(blob.digest))!.blob)
    expect(await foregroundSync((await owner.syncSettings())!, operations.slice(0, 250))).toMatchObject({ state: 'complete' })
    expect(await syncCollection(observer)).toMatchObject({ state: 'incomplete', remoteChangesPending: false })
    const waiting = await readAnkiExportSnapshot(observer)
    expect(waiting.notes).toEqual(beforeConversion.notes)
    expect(waiting.cards).toEqual(beforeConversion.cards)
    expect(waiting.references).toEqual(beforeConversion.references)
    expect(await readReceivedOperation(observer, maskCards[0].opId)).toBeUndefined()
    expect((await readSyncProgressCounts(observer)).incomingPending).toBeGreaterThan(0)
    for (let offset = 250; offset < operations.length; offset += 250) expect(await foregroundSync((await owner.syncSettings())!, operations.slice(offset, offset + 250))).toMatchObject({ state: 'complete' })
    await syncComplete(observer)
    const actual = await readAnkiExportSnapshot(observer)
    const expected = await readAnkiExportSnapshot(owner)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.cards).toHaveLength(expected.cards.length)
    for (const card of expected.cards) expect(actual.cards).toContainEqual({ ...card, suspended: card.suspended ?? card.templateSuspended ?? false })
    expect(actual.reviews).toEqual(expected.reviews)
    expect(actual.references).toEqual(expected.references)
    expect(await readSyncProgressCounts(observer)).toMatchObject({ incomingPending: 0, conflicts: 0 })
  })
}, 15_000)

test.each([
  { originalKind: 'image occlusion', delayedPriorReview: false },
  { originalKind: 'standard', delayedPriorReview: false },
  { originalKind: 'image occlusion', delayedPriorReview: true },
  { originalKind: 'standard', delayedPriorReview: true },
])('an imported note can convert to another standard card with cross-page history (%j)', async ({ originalKind, delayedPriorReview }) => {
  const builder = createCollection(`kiroku-basic-conversion-${crypto.randomUUID()}`)
  let imageFile: File, basicFile: File, guid: string
  try {
    const deck = await builder.createDeck('Imported reverse conversion', new Date('2026-10-01T12:00:00Z'))
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
    const image = originalKind === 'image occlusion'
      ? await builder.createImageOcclusionNote(deck.id, { image: new File([png], 'diagram.png', { type: 'image/png' }), imageWidth: 1, imageHeight: 1, header: '骨', backExtra: 'bone', tags: ['diagram'], masks: [{ x: .1, y: .2, width: .3, height: .2 }] }, new Date('2026-10-01T12:00:00Z'))
      : await builder.createBasicNote(deck.id, { front: '骨', back: 'bone' }, new Date('2026-10-01T12:00:00Z'))
    guid = image.id
    await builder.answer((await readCardsForNote(builder, image.id))[0].id, Rating.Good, new Date('2026-10-01T13:00:00Z'))
    const initial = await exportAnkiPackage(builder, { SQL, scheduling: true, history: true, media: true })
    imageFile = new File([initial.bytes.slice().buffer as ArrayBuffer], 'occlusion-before-conversion.apkg')
    await builder.deleteNote(image.id)
    if (originalKind === 'image occlusion') await builder.createBasicNote(deck.id, { front: '骨', back: 'bone' }, new Date('2026-10-02T12:00:00Z'))
    else {
      const type = await builder.createNoteType({ name: 'Converted vocabulary', fields: [{ name: 'Word' }, { name: 'Meaning' }], templates: [{ name: 'Converted recognition', front: '{{Word}}', back: '{{Meaning}}', css: '' }] }, new Date('2026-10-02T12:00:00Z'))
      await builder.createNote(deck.id, type.id, { [type.fields[0].id]: '骨', [type.fields[1].id]: 'bone' }, new Date('2026-10-02T12:00:00Z'))
    }
    const converted = await exportAnkiPackage(builder, { SQL, scheduling: true, history: true, media: true })
    basicFile = await editedPackage(new File([converted.bytes.slice().buffer as ArrayBuffer], 'basic-conversion.apkg'), database => {
      database.run('UPDATE notes SET guid = ?', [guid])
    }, 'same-guid-basic.apkg')
  } finally { await builder.removeLocalCollection() }
  await withPairedCollections(2, async ([owner, observer]) => {
    await (await prepareAnkiImport(imageFile, owner, { SQL })).commit()
    const delayed = delayedPriorReview ? (await owner.pendingOperations()).filter(operation => operation.entityType === 'review') : []
    if (delayedPriorReview) {
      expect(delayed).toHaveLength(1)
      await owner.acknowledgeOperations(delayed.map(operation => operation.opId))
    }
    await syncComplete(owner)
    await syncComplete(observer)
    const before = await readAnkiExportSnapshot(observer)
    const prior = before.notes[0]
    if (originalKind === 'image occlusion') expect(prior.imageOcclusion).toBeDefined()
    else expect(prior.imageOcclusion).toBeUndefined()
    const preview = await prepareAnkiImport(basicFile, owner, { SQL })
    expect(preview.issues.filter(issue => issue.severity === 'error')).toEqual([])
    await preview.commit()
    const converted = (await readAnkiExportSnapshot(owner)).notes[0]
    expect(converted.id).toBe(prior.id)
    expect(converted.imageOcclusion).toBeUndefined()
    const basic = (await readCardsForNote(owner, prior.id)).find(card => !card.occlusionId && !card.templateSuspended)!
    expect(basic).toBeDefined()
    await owner.answer(basic.id, Rating.Good, new Date('2026-10-02T13:00:00Z'))
    const generated = await owner.pendingOperations()
    const early = generated.find(operation => operation.entityType === 'card' && operation.action === 'create' && operation.entityId === basic.id)!
    expect(early).toBeDefined()
    expect(generated.find(operation => operation.entityType === 'note' && operation.entityId === prior.id)?.action).toBe('update')
    await owner.acknowledgeOperations(generated.map(operation => operation.opId))
    for (let index = 0; index < 300; index++) await owner.createDeck(`Reverse conversion filler ${index}`)
    const operations = [early, ...await owner.pendingOperations(), ...generated.filter(operation => operation.opId !== early.opId), ...delayed]
    expect(operations.findIndex(operation => operation.entityType === 'note' && operation.entityId === prior.id)).toBeGreaterThan(250)
    expect(await foregroundSync((await owner.syncSettings())!, operations.slice(0, 250))).toMatchObject({ state: 'complete' })
    expect(await syncCollection(observer)).toMatchObject({ state: 'incomplete', remoteChangesPending: false })
    expect(await readReceivedOperation(observer, early.opId)).toBeUndefined()
    const waiting = await readAnkiExportSnapshot(observer)
    expect(waiting.notes).toEqual(before.notes)
    expect(waiting.cards).toEqual(before.cards)
    expect((await readSyncProgressCounts(observer)).incomingPending).toBeGreaterThan(0)
    for (let offset = 250; offset < operations.length; offset += 250) expect(await foregroundSync((await owner.syncSettings())!, operations.slice(offset, offset + 250))).toMatchObject({ state: 'complete' })
    await syncComplete(observer)
    const actual = await readAnkiExportSnapshot(observer)
    const expected = await readAnkiExportSnapshot(owner)
    expect(actual.notes).toEqual(expected.notes)
    expect(actual.cards).toEqual(expected.cards)
    expect(actual.reviews).toEqual(expected.reviews)
    expect(actual.references).toEqual(expected.references)
    expect(await readSyncProgressCounts(observer)).toMatchObject({ incomingPending: 0, conflicts: 0 })
    await syncComplete(observer)
    expect((await readAnkiExportSnapshot(observer)).reviews).toEqual(expected.reviews)
  })
}, 15_000)

test('new content in a restored child can be restored after moving the child to another root', async () => {
  await withPairedCollections(2, async ([owner, observer]) => {
    const file = await restorationPackage(true)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    const original = await readAnkiExportSnapshot(owner)
    const root = original.decks.find(deck => deck.name === 'Restoration root')!
    const child = original.decks.find(deck => deck.parentId === root.id)!
    const other = original.decks.find(deck => deck.name === 'Other root')!
    await syncComplete(owner)
    await syncComplete(observer)
    await owner.deleteDeck(root.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    const newContent = await editedPackage(file, database => {
      const note = database.exec("SELECT * FROM notes WHERE flds LIKE '%a small feline%' LIMIT 1")[0]
      const noteValues = [...note.values[0]]
      for (const [column, value] of Object.entries({ id: 1700000009998, guid: 'post-restore-new-note', flds: 'new vocabulary\u001fadded after restoration', sfld: 'new vocabulary', csum: 0, data: '{}' })) noteValues[note.columns.indexOf(column)] = value
      database.run(`INSERT INTO notes (${note.columns.map(column => `"${column}"`).join(',')}) VALUES (${note.columns.map(() => '?').join(',')})`, noteValues)
      const card = database.exec("SELECT cards.* FROM cards JOIN notes ON notes.id = cards.nid WHERE notes.flds LIKE '%a small feline%' LIMIT 1")[0]
      const cardValues = [...card.values[0]]
      for (const [column, value] of Object.entries({ id: 1700000009999, nid: 1700000009998, data: '{}' })) cardValues[card.columns.indexOf(column)] = value
      database.run(`INSERT INTO cards (${card.columns.map(column => `"${column}"`).join(',')}) VALUES (${card.columns.map(() => '?').join(',')})`, cardValues)
    }, 'post-restoration-content.apkg')
    await (await prepareAnkiImport(newContent, owner, { SQL })).commit()
    await owner.moveDeck(child.id, other.id)
    await syncComplete(owner)
    await syncComplete(observer)
    const before = await readAnkiExportSnapshot(owner)
    const added = before.notes.find(note => Object.values(note.fields).includes('new vocabulary'))!
    expect(added).toBeDefined()
    expect(added.deckId).toBe(child.id)
    const exported = await exportAnkiPackage(owner, { SQL, scheduling: true, history: true, media: true })
    const movedFile = new File([exported.bytes.slice().buffer as ArrayBuffer], 'moved-restoration.apkg')
    await owner.deleteDeck(other.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await syncComplete(observer)
    await (await prepareAnkiImport(movedFile, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    const restored = await readAnkiExportSnapshot(owner)
    for (const key of ['decks', 'notes', 'cards', 'reviews'] as const) expect((await readAnkiExportSnapshot(observer))[key]).toEqual(restored[key])
    expect(restored.notes.map(note => note.id)).toEqual(before.notes.map(note => note.id))
    expect(restored.cards.map(card => card.id)).toEqual(before.cards.map(card => card.id))
    expect(restored.notes.find(note => note.id === added.id)?.fields).toEqual(added.fields)
    expect(restored.decks.find(deck => deck.id === child.id)?.parentId).toBe(other.id)
  })
})

test.each([false, true])('a new card can synchronize and restore after its note moves (previous restoration: %s)', async previousRestoration => {
  let sequence = 999999999999
  const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${sequence--}`)
  try {
    await withPairedCollections(2, async ([owner, observer]) => {
      const file = await restorationPackage(true, true)
      await (await prepareAnkiImport(file, owner, { SQL })).commit()
      const original = await readAnkiExportSnapshot(owner)
      const root = original.decks.find(deck => deck.name === 'Restoration root')!
      const other = original.decks.find(deck => deck.name === 'Other root')!
      const note = original.notes.find(note => Object.values(note.fields).includes('a small feline'))!
      await syncComplete(owner, 'new-card step 1: owner')
      await syncComplete(observer, 'new-card step 2: observer')
      if (previousRestoration) {
        await owner.deleteDeck(root.id, { mode: 'delete-subtree' })
        await syncComplete(owner, 'new-card step 3: owner')
        await (await prepareAnkiImport(file, owner, { SQL })).commit()
        await syncComplete(owner, 'new-card step 4: owner')
      }
      const restoredNote = (await readAnkiExportSnapshot(owner)).notes.find(row => row.id === note.id)!
      const type = (await readAnkiExportSnapshot(owner)).types.find(row => row.id === note.typeId)!
      const extra = type.fields.find(field => field.name === 'extra')!
      await owner.updateNote(note.id, { ...restoredNote.fields, [extra.id]: 'new recognition question' })
      expect((await readAnkiExportSnapshot(owner)).cards.filter(card => card.noteId === note.id)).toHaveLength(2)
      await owner.moveNote(note.id, root.id)
      await owner.moveNote(note.id, other.id)
      if (!previousRestoration) {
        const unchanged = await readAnkiExportSnapshot(observer)
        const unrelated = (await owner.pendingOperations()).map(operation => operation.entityType === 'card' && operation.action === 'update' ? { ...operation, parents: [] } : operation)
        await expect(observer.applyRemoteChanges(unrelated, (await observer.syncSettings())!.cursor)).rejects.toThrow('Synced card deck does not match its note deck')
        expect(await readAnkiExportSnapshot(observer)).toEqual(unchanged)
      }
      await syncComplete(owner, 'new-card step 5: owner')
      await syncComplete(observer, 'new-card step 6: observer')
      const before = await readAnkiExportSnapshot(owner)
      expect(before.cards.filter(card => card.noteId === note.id)).toHaveLength(2)
      const exported = await exportAnkiPackage(owner, { SQL, scheduling: true, history: true, media: true })
      const movedFile = new File([exported.bytes.slice().buffer as ArrayBuffer], 'moved-note-restoration.apkg')
      await owner.deleteDeck(other.id, { mode: 'delete-subtree' })
      await syncComplete(owner, 'new-card step 7: owner')
      await syncComplete(observer, 'new-card step 8: observer')
      const restoration = await prepareAnkiImport(movedFile, owner, { SQL })
      expect(restoration.issues.filter(issue => issue.severity === 'error')).toEqual([])
      await restoration.commit()
      await syncComplete(owner, 'new-card step 9: owner')
      await syncComplete(observer, 'new-card step 10: observer')
      const restored = await readAnkiExportSnapshot(owner)
      for (const key of ['decks', 'notes', 'cards', 'reviews'] as const) expect((await readAnkiExportSnapshot(observer))[key]).toEqual(restored[key])
      expect(restored.cards.filter(card => card.noteId === note.id).map(card => card.id)).toEqual(before.cards.filter(card => card.noteId === note.id).map(card => card.id))
    })
  } finally { uuid.mockRestore() }
})

test('a stale note move received before restoration cannot invalidate its original deletion evidence', async () => {
  await withPairedCollections(3, async ([owner, observer, stale]) => {
    const file = await restorationPackage(true)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    await syncComplete(stale)
    const original = await readAnkiExportSnapshot(owner)
    const root = original.decks.find(deck => deck.name === 'Restoration root')!
    const other = original.decks.find(deck => deck.name === 'Other root')!
    const note = original.notes.find(row => Object.values(row.fields).includes('a small feline'))!
    await stale.moveNote(note.id, other.id)
    await owner.deleteDeck(root.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await syncComplete(stale)
    await syncComplete(owner)
    expect((await readAnkiImportSnapshot(owner)).deletionBarriers.find(barrier => barrier.entityType === 'note' && barrier.entityId === note.id)).toMatchObject({ causes: [{ source: { entityType: 'deck', entityId: note.deckId }, deletedLifetime: [] }] })
    const restoration = await prepareAnkiImport(file, owner, { SQL })
    expect(restoration.issues.filter(issue => issue.severity === 'error')).toEqual([])
    await restoration.commit()
    await syncComplete(owner)
    await syncComplete(observer)
    await syncComplete(stale)
    const restored = await readAnkiExportSnapshot(owner)
    for (const device of [observer, stale]) for (const key of ['decks', 'notes', 'cards', 'reviews'] as const) expect((await readAnkiExportSnapshot(device))[key]).toEqual(restored[key])
    expect(restored.notes.find(row => row.id === note.id)?.deckId).toBe(note.deckId)
    expect(restored.cards.map(card => card.id)).toEqual(original.cards.map(card => card.id))
  })
})

test('a withheld parent restoration stays durable across reopening without claiming sync is complete', async () => {
  await withPairedCollections(2, async ([owner, receiver]) => {
    const file = await restorationPackage()
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(receiver)
    const root = (await readAnkiExportSnapshot(owner)).decks.find(deck => deck.parentId === null)!
    await owner.deleteDeck(root.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await syncComplete(receiver)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    const noteRestore = (await owner.pendingOperations()).find(operation => operation.entityType === 'note' && operation.action === 'restore')!
    expect(await foregroundSync((await owner.syncSettings())!, [noteRestore])).toMatchObject({ state: 'complete', accepted: 1 })
    await owner.acknowledgeOperations([noteRestore.opId])
    const waiting = await syncCollection(receiver)
    expect(waiting).toMatchObject({ state: 'incomplete', pendingOperations: 0, pendingIncomingOperations: 1, remoteChangesPending: false })
    expect((await readAnkiExportSnapshot(receiver)).notes).toHaveLength(0)
    const cursor = (await receiver.syncSettings())!.cursor
    const databaseName = receiver.databaseName
    receiver.closeLocalCollection()
    const reopened = createCollection(databaseName)
    try {
      expect(await readSyncProgressCounts(reopened)).toMatchObject({ incomingPending: 1 })
      expect(await syncCollection(reopened)).toMatchObject({ state: 'incomplete', cursor, pendingIncomingOperations: 1 })
      await syncComplete(owner)
      await syncComplete(reopened)
      expect(await readSyncProgressCounts(reopened)).toMatchObject({ incomingPending: 0 })
      const restored = await readAnkiExportSnapshot(owner)
      for (const key of ['decks', 'notes', 'cards', 'reviews'] as const) expect((await readAnkiExportSnapshot(reopened))[key]).toEqual(restored[key])
    } finally { reopened.closeLocalCollection() }
  })
})

test('a later-dated prior-lifetime schedule command cannot change a current review', async () => {
  await withPairedCollections(3, async ([owner, observer, stale]) => {
    const file = await restorationPackage()
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    await syncComplete(stale)
    const before = await readAnkiExportSnapshot(owner)
    const root = before.decks.find(deck => deck.parentId === null)!
    const cardId = before.cards[0].id
    await stale.rescheduleCard(cardId, new Date('2045-01-01T00:00:00Z'), new Date('2031-01-01T00:00:00Z'))
    await owner.deleteDeck(root.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(stale)
    await syncComplete(owner)
    await owner.answer(cardId, Rating.Good, new Date('2030-01-01T12:00:00Z'), 100, { allowEarly: true, reschedule: true })
    const expected = (await readAnkiExportSnapshot(owner)).cards.find(card => card.id === cardId)!
    await syncComplete(owner)
    await syncComplete(observer)
    for (const device of [owner, observer]) expect((await readAnkiExportSnapshot(device)).cards.find(card => card.id === cardId)).toEqual(expected)
  })
})

for (const relatedLifetimes of [[null], []]) test(`malformed receiver parent references roll back the entire batch (${relatedLifetimes.length ? 'null' : 'missing'})`, async () => {
  const device = createCollection(`kiroku-malformed-receive-${crypto.randomUUID()}`)
  try {
    const deck = await device.createDeck('Keep local work')
    const before = await readAnkiExportSnapshot(device)
    const queued = await device.pendingOperations()
    const valid = { opId: 'valid-before-invalid', entityType: 'deck', entityId: 'new-deck', action: 'create', occurredAt: '2026-10-07T12:00:00Z', payload: { id: 'new-deck', name: 'Must roll back', parentId: null }, lifetime: [], relatedLifetimes: [] }
    const invalid = { ...valid, opId: 'invalid-reference', entityId: 'new-child', payload: { id: 'new-child', name: 'Invalid', parentId: deck.id }, relatedLifetimes }
    await expect(device.applyRemoteChanges([valid, invalid] as unknown as SyncOperation[], 10)).rejects.toThrow(/lifetime reference/i)
    expect(await readAnkiExportSnapshot(device)).toEqual(before)
    expect(await device.pendingOperations()).toEqual(queued)
    expect(await device.syncSettings()).toBeUndefined()
  } finally { await device.removeLocalCollection() }
})

test('verified backup restoration keeps stale work fenced and current lifetime edits usable', async () => {
  await withPairedCollections(3, async ([owner, stale, receiver], service, origin) => {
    const file = await restorationPackage()
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(stale)
    const original = await readAnkiExportSnapshot(owner)
    const deck = original.decks.find(row => row.parentId === null)!
    const note = original.notes[0]
    const field = Object.keys(note.fields)[0]
    await stale.updateNote(note.id, { ...note.fields, [field]: 'prior lifetime edit' })
    await stale.createBasicNote(deck.id, { front: 'prior lifetime new child', back: 'must be suppressed' })
    const queued = await stale.pendingOperations()
    await owner.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    const expected = await readAnkiExportSnapshot(owner)
    const settings = (await owner.syncSettings())!
    const backup = await service.createBackup(settings.token)
    await owner.updateNote(note.id, { ...expected.notes.find(row => row.id === note.id)!.fields, [field]: 'after backup' })
    await syncComplete(owner)
    const restored = await service.restoreBackup(settings.token, backup.id, 'RESTORE')
    expect(await syncCollection(stale)).toMatchObject({ state: 'collection-generation-required' })
    expect(await stale.pendingOperations()).toEqual(queued)
    expect(await pairCollection(receiver, origin, service.createPairingCode())).toMatchObject({ state: 'paired' })
    await syncComplete(receiver)
    const received = await readAnkiExportSnapshot(receiver)
    for (const key of ['decks', 'notes', 'cards', 'reviews', 'references'] as const) expect(received[key]).toEqual(expected[key])
    const response = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 22, collectionGeneration: restored.generation, cursor: 0, operations: queued }) })
    expect(response.status).toBe(200)
    await syncComplete(receiver)
    expect(await readAnkiExportSnapshot(receiver)).toEqual(received)
    const current = (await readAnkiExportSnapshot(receiver)).notes.find(row => row.id === note.id)!
    await receiver.updateNote(note.id, { ...current.fields, [field]: 'current lifetime edit after backup restore' })
    await syncComplete(receiver)
    const name = receiver.databaseName
    receiver.closeLocalCollection()
    const reopened = createCollection(name)
    try {
      await syncComplete(reopened)
      expect((await readAnkiExportSnapshot(reopened)).notes.find(row => row.id === note.id)?.fields[field]).toBe('current lifetime edit after backup restore')
    } finally { reopened.closeLocalCollection() }
  }, 2)
})

  test('offline work cannot change a restored lifetime through paired HTTP', async () => {
    await withPairedCollections(3, async ([owner, observer, stale]) => {
      const file = await restorationPackage()
      await (await prepareAnkiImport(file, owner, { SQL })).commit()
      await syncComplete(owner)
      await syncComplete(observer)
      await syncComplete(stale)
      const before = await readAnkiExportSnapshot(owner)
      const deck = before.decks.find(candidate => candidate.parentId === null)!
      const note = before.notes.find(candidate => Object.values(candidate.fields).includes('cat'))!
      const field = Object.keys(note.fields)[0]
      await stale.updateNote(note.id, { ...note.fields, [field]: 'stale offline edit' })
      await stale.createBasicNote(deck.id, { front: 'old device child', back: 'must stay outside restored lifetime' })
      const card = (await readCardsForNote(stale, note.id))[0]
      await stale.answer(card.id, Rating.Good, new Date('2026-10-07T12:00:00.000Z'), 100, { allowEarly: true, reschedule: true })
      await stale.deleteDeck(deck.id, { mode: 'delete-subtree' })
      const offline = await stale.pendingOperations()
      expect(offline.some(operation => operation.action === 'update')).toBe(true)
      expect(offline.some(operation => operation.entityType === 'review')).toBe(true)
      expect(offline.some(operation => operation.entityType === 'note' && operation.action === 'create')).toBe(true)
      expect(offline.some(operation => operation.action === 'delete')).toBe(true)
      await owner.deleteDeck(deck.id, { mode: 'delete-subtree' })
      await syncComplete(owner)
      await (await prepareAnkiImport(file, owner, { SQL })).commit()
      await syncComplete(owner)
      await syncComplete(observer)
      const restored = await readAnkiExportSnapshot(owner)
      const observed = await readAnkiExportSnapshot(observer)
      for (const key of ['decks', 'notes', 'cards', 'types', 'reviews', 'references'] as const) expect(observed[key]).toEqual(restored[key])
      expect(observed.blobs.map(blob => blob.digest)).toEqual(restored.blobs.map(blob => blob.digest))
      await syncComplete(stale)
      await syncComplete(owner)
      await syncComplete(observer)
      expect(await readAnkiExportSnapshot(owner)).toEqual(restored)
      expect(await readAnkiExportSnapshot(observer)).toEqual(observed)
      await syncComplete(stale)
      await syncComplete(owner)
      expect(await readAnkiExportSnapshot(owner)).toEqual(restored)
    })
  })


test('current-lifetime work and a second delete restore cycle succeed through paired HTTP', async () => {
  await withPairedCollections(2, async ([owner, observer]) => {
    const file = await restorationPackage()
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    await syncComplete(owner)
    await syncComplete(observer)
    const original = await readAnkiExportSnapshot(owner)
    const deck = original.decks.find(candidate => candidate.parentId === null)!
    await owner.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    const firstRestore = (await owner.pendingOperations()).find(operation => operation.entityType === 'note' && operation.action === 'restore')!
    await syncComplete(owner)
    await syncComplete(observer)
    const restored = await readAnkiExportSnapshot(owner)
    const note = restored.notes[0]
    const field = Object.keys(note.fields)[0]
    await owner.updateNote(note.id, { ...note.fields, [field]: 'current lifetime edit' })
    const card = (await readCardsForNote(owner, note.id))[0]
    await owner.answer(card.id, Rating.Good, new Date('2026-10-07T12:00:00.000Z'), 100, { allowEarly: true, reschedule: true })
    const current = await owner.pendingOperations()
    expect(current.find(operation => operation.entityType === 'note')?.lifetime).toEqual(firstRestore.lifetime)
    expect(current.find(operation => operation.entityType === 'review')?.relatedLifetimes).toContainEqual(expect.objectContaining({ entityType: 'card', entityId: card.id, lifetime: firstRestore.lifetime }))
    await syncComplete(owner)
    await syncComplete(observer)
    expect((await readAnkiExportSnapshot(observer)).notes).toEqual((await readAnkiExportSnapshot(owner)).notes)
    expect((await readAnkiExportSnapshot(observer)).reviews).toEqual((await readAnkiExportSnapshot(owner)).reviews)
    expect((await readAnkiExportSnapshot(observer)).cards).toEqual((await readAnkiExportSnapshot(owner)).cards)
    await owner.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await syncComplete(owner)
    await (await prepareAnkiImport(file, owner, { SQL })).commit()
    const secondRestore = (await owner.pendingOperations()).find(operation => operation.entityType === 'note' && operation.entityId === firstRestore.entityId && operation.action === 'restore')!
    expect(secondRestore.lifetime).not.toEqual(firstRestore.lifetime)
    expect(secondRestore.restoreOf?.map(cause => cause.deletedLifetime)).toEqual([firstRestore.lifetime])
    await syncComplete(owner)
    await syncComplete(observer)
    const second = await readAnkiExportSnapshot(owner)
    for (const key of ['notes', 'cards', 'references'] as const) expect(second[key].map(row => row.id).sort()).toEqual(original[key].map(row => row.id).sort())
    for (const key of ['decks', 'notes', 'cards', 'reviews', 'references'] as const) expect((await readAnkiExportSnapshot(observer))[key]).toEqual(second[key])
  })
})

test('same-barrier concurrent restores retain different field versions through paired HTTP', async () => {
  await withPairedCollections(2, async ([left, right]) => {
    const file = await restorationPackage()
    await (await prepareAnkiImport(file, left, { SQL })).commit()
    await syncComplete(left)
    await syncComplete(right)
    const original = await readAnkiExportSnapshot(left)
    const deck = original.decks.find(candidate => candidate.parentId === null)!
    await left.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await syncComplete(left)
    await syncComplete(right)
    const altered = await editedPackage(file, database => {
      const row = database.exec('SELECT id, flds FROM notes ORDER BY id LIMIT 1')[0].values[0]
      const fields = String(row[1]).split('\u001f')
      fields[0] = `alternate restoration ${fields[0]}`
      database.run('UPDATE notes SET flds = ? WHERE id = ?', [fields.join('\u001f'), row[0]])
    }, 'alternate.apkg')
    const now = new Date('2026-10-07T12:00:00.000Z')
    await (await prepareAnkiImport(file, left, { SQL, now })).commit()
    await (await prepareAnkiImport(altered, right, { SQL, now })).commit()
    const leftRestores = (await left.pendingOperations()).filter(operation => operation.action === 'restore')
    const rightRestores = (await right.pendingOperations()).filter(operation => operation.action === 'restore')
    for (const operation of leftRestores) expect(rightRestores.find(candidate => candidate.entityType === operation.entityType && candidate.entityId === operation.entityId)?.lifetime).toEqual(operation.lifetime)
    await syncComplete(left)
    await syncComplete(right)
    await syncComplete(left)
    const conflicts = await readSyncConflicts(left)
    const conflict = conflicts.find(record => record.entityType === 'note')!
    expect(conflict).toBeDefined()
    expect(conflict.versions).toHaveLength(2)
    expect(conflict.versions.map(version => JSON.stringify(version.value)).some(value => value.includes('alternate restoration'))).toBe(true)
    expect(conflict.versions.map(version => JSON.stringify(version.value)).some(value => !value.includes('alternate restoration'))).toBe(true)
    const name = left.databaseName
    left.closeLocalCollection()
    const reopened = createCollection(name)
    try {
      expect(await readSyncConflicts(reopened)).toEqual(conflicts)
      await syncComplete(reopened)
      expect(await readSyncConflicts(reopened)).toEqual(conflicts)
      const received = await readAnkiExportSnapshot(reopened)
      expect(received.notes.map(note => note.id).sort()).toEqual(original.notes.map(note => note.id).sort())
      const history = (await readAnkiImportSnapshot(reopened)).retainedRevisions
      expect(history.filter(revision => revision.entityId === conflict.entityId && revision.action === 'restore')).toHaveLength(2)
    } finally { reopened.closeLocalCollection() }
  })
})
