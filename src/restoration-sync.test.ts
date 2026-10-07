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
import { createCollection, Rating, type Collection } from './collection'
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

async function withPairedCollections(count: number, run: (devices: Collection[]) => Promise<void>) {
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-restoration-client-'))
  const service = createSyncService({ databasePath: join(runtime, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  const devices = Array.from({ length: count }, () => createCollection(`kiroku-real-restoration-${crypto.randomUUID()}`))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test service did not bind its isolated loopback port')
  try {
    for (const device of devices) expect(await pairCollection(device, `http://127.0.0.1:${address.port}`, service.createPairingCode())).toMatchObject({ state: 'paired' })
    await run(devices)
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
