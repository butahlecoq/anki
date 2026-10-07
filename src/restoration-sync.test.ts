// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { decompress } from 'fzstd'
import { unzipSync, zipSync } from 'fflate'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { createSyncService } from '../server/sync-service'
import { createSyncHttpHandler } from '../server/sync-http'
import { pairCollection, syncCollection } from './sync-client'
import { createCollection, Rating, type Collection, type SyncOperation } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'
import { readAnkiExportSnapshot, readAnkiImportSnapshot, readCardsForNote, readSyncConflicts } from './collection-queries'

let SQL: SqlJsStatic
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })

async function restorationPackage() {
  const owner = createCollection(`kiroku-restoration-fixture-${crypto.randomUUID()}`)
  try {
  const root = await owner.createDeck('Restoration root')
  const child = await owner.createDeck('Restoration child', { parentId: root.id })
  const note = await owner.createBasicNote(child.id, { front: 'cat', back: 'a small feline' })
  await owner.createBasicNote(child.id, { front: 'dog', back: 'a canine' })
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
  await owner.attachMedia(note.id, { file: new File([png], 'cat.png', { type: 'image/png' }), side: 'front' })
  const exported = await exportAnkiPackage(owner, { SQL, scheduling: true, history: true, media: true })
  return new File([exported.bytes.slice().buffer as ArrayBuffer], 'restoration.apkg', { type: 'application/octet-stream' })
  } finally { await owner.removeLocalCollection() }
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

async function syncComplete(device: Collection) {
  const result = await syncCollection(device)
  expect(result).toMatchObject({ state: 'complete', media: { pending: 0 } })
}

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
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const databaseEntry = Object.keys(archive).find(name => name.startsWith('collection.anki'))!
    const packed = archive[databaseEntry]
    const sqlite = new SQL.Database(packed[0] === 0x28 ? decompress(packed) : packed)
    const row = sqlite.exec('SELECT id, flds FROM notes ORDER BY id LIMIT 1')[0].values[0]
    const fields = String(row[1]).split('\u001f')
    fields[0] = `alternate restoration ${fields[0]}`
    sqlite.run('UPDATE notes SET flds = ? WHERE id = ?', [fields.join('\u001f'), row[0]])
    const bytes = sqlite.export()
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
    sqlite.close()
    const altered = new File([zipSync(archive).slice().buffer as ArrayBuffer], 'alternate.apkg')
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
