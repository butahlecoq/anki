import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { createPairingCode, listPairedDevices, revokePairedDevice, startSyncServer } from './index.js'
import { createSyncService } from './sync-service.js'
import { createSyncHttpHandler } from './sync-http.js'
import { SERVER_MAX_COLLECTION_SCHEMA_VERSION, SYNC_CHANGE_PAGE_SIZE } from '../sync-capabilities.js'

let runtimeDirectory: string | undefined

test('schema 22 operation lifetime metadata survives service reopen and replay', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const operation = { opId: 'lifetime-deck-created', entityType: 'deck', entityId: 'lifetime-deck', action: 'create', occurredAt: '2026-10-07T00:00:00.000Z', payload: { id: 'lifetime-deck', name: 'Restoration fixture' }, lifetime: [], relatedLifetimes: [] }
  let token = ''
  for (const reopening of [false, true]) {
    const service = createSyncService({ databasePath })
    const server = createServer(createSyncHttpHandler(service))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      if (!reopening) {
        const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: service.createPairingCode(), deviceId: 'restoration-phone' }) })
        assert.equal(paired.status, 201)
        token = (await paired.json() as { token: string }).token
        const incompatible = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 21, cursor: 0, operations: [operation] }) })
        assert.equal(incompatible.status, 409)
        assert.equal((await incompatible.json() as { requiredSchemaVersion: number }).requiredSchemaVersion, 22)
      }
      const result = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 22, cursor: 0, operations: [operation] }) })
      assert.equal(result.status, 200)
      const response = await result.json() as { accepted: number; collectionSchemaVersion: number; changes: Array<typeof operation & { cursor: number; deviceId: string }> }
      assert.equal(response.accepted, reopening ? 0 : 1)
      const { cursor, deviceId, ...received } = response.changes[0]
      assert.equal(cursor, 1)
      assert.equal(deviceId, 'restoration-phone')
      assert.deepEqual(received, operation)
      assert.equal(response.collectionSchemaVersion, 22)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      service.close()
    }
  }
})

for (const scenario of ['unknown restoration cause', 'identity reuse with changed lifecycle metadata'] as const) {
  test(`paired HTTP rejects ${scenario} without acknowledging or changing stored history`, async () => {
    runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-restoration-http-validation-'))
    const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
    const server = createServer(createSyncHttpHandler(service))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      const pairing = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: service.createPairingCode(), deviceId: 'lifecycle-validation-phone' }) })
      assert.equal(pairing.status, 201)
      const { token } = await pairing.json() as { token: string }
      const send = (operations: unknown[]) => fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 22, cursor: 0, operations }) })
      const original = { opId: 'lifecycle-original', entityType: 'deck', entityId: 'lifecycle-deck', action: 'create', occurredAt: '2026-10-07T00:00:00.000Z', payload: { id: 'lifecycle-deck', name: 'Keep original history', parentId: null, optionGroupId: 'default' }, lifetime: [], relatedLifetimes: [] }
      if (scenario === 'unknown restoration cause') {
        const invalid = { ...original, action: 'restore', lifetime: ['missing-delete'], restoreOf: [{ source: { entityType: 'deck', entityId: original.entityId }, opId: 'missing-delete', deletedLifetime: [] }] }
        const response = await send([invalid])
        assert.equal(response.status, 400)
        assert.match((await response.json() as { error: string }).error, /deletion|provenance|restoration/i)
        assert.equal(service.changeCount(), 0)
        assert.equal(service.health().collectionSchemaVersion, 1)
      } else {
        assert.equal((await send([original])).status, 200)
        const response = await send([{ ...original, relatedLifetimes: [{ entityType: 'deck', entityId: 'another-parent', lifetime: ['different-lifetime'] }] }])
        assert.equal(response.status, 400)
        assert.match((await response.json() as { error: string }).error, /identity.*reused/i)
        assert.equal(service.changeCount(), 1)
        const replay = await send([original])
        assert.equal(replay.status, 200)
        assert.equal((await replay.json() as { accepted: number }).accepted, 0)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      service.close()
    }
  })
}

afterEach(async () => {
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
  runtimeDirectory = undefined
})

test('reports a ready durable store and accepts a pairing code only once', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })

  const health = service.health()
  assert.deepEqual({ ...health, collectionGeneration: 'generation' }, { ready: true, schemaVersion: 1, build: { version: 'development', commit: 'development', release: false }, protocolVersion: 2, collectionSchemaVersion: 1, maximumCollectionSchemaVersion: SERVER_MAX_COLLECTION_SCHEMA_VERSION, collectionGeneration: 'generation', requiresCollectionGeneration: false, store: 'sqlite' })

  const pairingCode = service.createPairingCode(new Date('2026-10-01T12:00:00.000Z'))
  const paired = service.pair({ code: pairingCode, deviceId: 'phone-1' }, new Date('2026-10-01T12:01:00.000Z'))

  assert.equal(paired.deviceId, 'phone-1')
  assert.match(paired.token, /^[a-f0-9]{64}$/)
  assert.equal(paired.collectionGeneration, health.collectionGeneration)
  assert.throws(() => service.pair({ code: pairingCode, deviceId: 'phone-2' }, new Date('2026-10-01T12:02:00.000Z')))
  service.close()
})

test('rotates a device credential atomically and rejects its previous token', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token: previousToken } = service.pair({ code: service.createPairingCode(), deviceId: 'phone-1' })
  const rotated = service.rotateCredential(previousToken)

  assert.match(rotated.token, /^[a-f0-9]{64}$/)
  assert.notEqual(rotated.token, previousToken)
  assert.throws(() => service.sync(previousToken, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }), /authentication required/i)
  assert.equal(service.sync(rotated.token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }).accepted, 0)
  assert.throws(() => service.rotateCredential(previousToken), /authentication required/i)
  service.close()
})

test('revokes a lost device through local administration without listing credentials', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'lost-phone' })

  assert.deepEqual(service.listDevices(), [{ id: 'lost-phone', status: 'active' }])
  assert.deepEqual(service.revokeDevice('lost-phone', new Date('2026-10-03T12:00:00.000Z')), { deviceId: 'lost-phone', status: 'revoked' })
  assert.deepEqual(service.listDevices(), [{ id: 'lost-phone', status: 'revoked' }])
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }), /authentication required/i)
  assert.throws(() => service.revokeDevice('unknown-phone'), /device was not found/i)
  service.close()
})

test('local device-management commands persist a revocation across service restart', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'kiroku-sync.sqlite')
  const service = createSyncService({ databasePath })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'phone-to-remove' })
  service.close()

  assert.deepEqual(await listPairedDevices({ runtimeDirectory }), [{ id: 'phone-to-remove', status: 'active' }])
  assert.deepEqual(await revokePairedDevice({ runtimeDirectory, deviceId: 'phone-to-remove' }), { deviceId: 'phone-to-remove', status: 'revoked' })
  assert.deepEqual(await listPairedDevices({ runtimeDirectory }), [{ id: 'phone-to-remove', status: 'revoked' }])
  const reopened = createSyncService({ databasePath })
  assert.throws(() => reopened.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }), /authentication required/i)
  reopened.close()
})

test('accepts a review mutation once when the request is delivered twice', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const code = service.createPairingCode(new Date('2026-10-01T12:00:00.000Z'))
  const { token } = service.pair({ code, deviceId: 'phone-1' }, new Date('2026-10-01T12:01:00.000Z'))
  const request = {
    protocolVersion: 2,
    collectionSchemaVersion: 10,
    cursor: 0,
    operations: [{ opId: 'review-1', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-01T12:02:00.000Z', payload: { cardId: 'card-1', rating: 'good' } }],
  }

  assert.equal(service.sync(token, request).accepted, 1)
  assert.equal(service.sync(token, request).accepted, 0)
  assert.equal(service.reviewCount(), 1)
  const pulled = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [] })
  assert.equal(pulled.changes.length, 1)
  assert.equal(pulled.cursor, 1)
  service.close()
})

test('resumes the durable operation log after a PC service restart without accepting a replay twice', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  let service = createSyncService({ databasePath })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  const request = { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [{ opId: 'restart-op', entityType: 'note', entityId: 'note-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1', fields: { front: '猫' } } }] }
  try {
    assert.equal(service.sync(token, request).accepted, 1)
    service.close()
    service = createSyncService({ databasePath })
    const resumed = service.sync(token, request)
    assert.equal(resumed.accepted, 0)
    assert.equal(resumed.changes.length, 1)
    assert.equal(resumed.changes[0].opId, 'restart-op')
    assert.equal(resumed.cursor, 1)
    assert.equal(resumed.hasMore, false)
  } finally { service.close() }
})

test('returns bounded durable change pages and safely replays operations after the first page', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  const operations = Array.from({ length: SYNC_CHANGE_PAGE_SIZE + 3 }, (_, index) => ({
    opId: `change-${index}`, entityType: 'setting', entityId: `setting-${index}`, action: 'update',
    occurredAt: new Date(1_800_000_000_000 + index).toISOString(), payload: { value: index },
  }))

  try {
    const first = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations })
    assert.equal(first.accepted, SYNC_CHANGE_PAGE_SIZE + 3)
    assert.equal(first.changes.length, SYNC_CHANGE_PAGE_SIZE)
    assert.equal(first.cursor, SYNC_CHANGE_PAGE_SIZE)
    assert.equal(first.hasMore, true)

    const second = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: first.cursor, operations })
    assert.equal(second.accepted, 0)
    assert.equal(second.changes.length, 3)
    assert.equal(second.cursor, SYNC_CHANGE_PAGE_SIZE + 3)
    assert.equal(second.hasMore, false)
    assert.equal(service.changeCount(), SYNC_CHANGE_PAGE_SIZE + 3)
  } finally { service.close() }
})

test('persists a collection schema watermark and rejects an incompatible client before accepting mutations', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const service = createSyncService({ databasePath })
  const code = service.createPairingCode(new Date('2026-10-01T12:00:00.000Z'))
  const { token } = service.pair({ code, deviceId: 'phone-1' }, new Date('2026-10-01T12:01:00.000Z'))

  assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [] }).accepted, 0)
  assert.throws(() => service.sync(token, {
    protocolVersion: 2,
    collectionSchemaVersion: 6,
    cursor: 0,
    operations: [{ opId: 'lost-change', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:02:00.000Z', payload: { id: 'note-1' } }],
  }), /update kiroku on this device/i)
  assert.equal(service.changeCount(), 0)
  assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 12, cursor: 0, operations: [] }).accepted, 0)
  assert.equal(service.health().collectionSchemaVersion, 12)
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: SERVER_MAX_COLLECTION_SCHEMA_VERSION + 1, cursor: 0, operations: [] }), new RegExp(`supports collection schemas through ${SERVER_MAX_COLLECTION_SCHEMA_VERSION}`, 'i'))
  assert.equal(service.changeCount(), 0)
  service.close()

  const reopened = createSyncService({ databasePath })
  assert.equal(reopened.health().collectionSchemaVersion, 12)
  reopened.close()
})

test('manual PC backups contain a consistent verified SQLite history and every media byte', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-backup-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const mediaDirectory = join(runtimeDirectory, 'media')
  const service = createSyncService({ databasePath, mediaDirectory })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'backup-phone' })
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7])
  const mediaDigest = createHash('sha256').update(image).digest('hex')
  await service.putMedia(token, mediaDigest, 'image/png', image)
  service.sync(token, {
    protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0,
    operations: [{ opId: 'saved-note', entityType: 'note', entityId: 'note-1', action: 'create', occurredAt: '2026-10-03T10:00:00.000Z', payload: { id: 'note-1', front: '猫', back: 'cat' }, parents: [] }],
  })

  await assert.rejects(service.listBackups('wrong-token'), /authentication required/i)
  const manifest = await service.createBackup(token)
  assert.equal(manifest.reason, 'manual')
  assert.equal(manifest.collectionGeneration, service.health().collectionGeneration)
  assert.equal(manifest.changeCount, 1)
  assert.equal(manifest.latestCursor, 1)
  assert.deepEqual(manifest.media, [{ digest: mediaDigest, byteLength: image.byteLength, mimeType: 'image/png' }])
  assert.equal(manifest.databaseSha256.length, 64)
  assert.equal(manifest.archiveSha256.length, 64)

  const { bytes } = await service.downloadBackup(token, manifest.id)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.archiveSha256)
  const archive = unzipSync(bytes)
  assert.deepEqual([...archive[`media/${mediaDigest}`]], [...image])
  const backupPath = join(runtimeDirectory, 'backup-check.sqlite')
  await writeFile(backupPath, archive['collection.sqlite'])
  const snapshot = new DatabaseSync(backupPath, { readOnly: true })
  try {
    assert.equal((snapshot.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    assert.equal((snapshot.prepare('SELECT op_id FROM changes').get() as { op_id: string }).op_id, 'saved-note')
  } finally { snapshot.close() }

  assert.deepEqual(await service.listBackups(token), [manifest])
  const preview = await service.previewBackupRestore(token, manifest.id)
  assert.equal(preview.changeCount, 1)
  assert.equal(preview.mediaBytes, image.byteLength)
  assert.equal(preview.restoreAvailable, true)
  const damaged = new Uint8Array(bytes)
  damaged[damaged.length - 4] ^= 1
  await writeFile(join(runtimeDirectory, 'backups', `backup-${manifest.id}.zip`), damaged)
  assert.deepEqual(await service.listBackups(token), [])
  await assert.rejects(service.downloadBackup(token, manifest.id), /verified backup not found/i)
  service.close()
})

test('restore replaces sync history atomically, keeps a pre-restore recovery backup, and fences previous-generation devices', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-restore-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const mediaDirectory = join(runtimeDirectory, 'media')
  const service = createSyncService({ databasePath, mediaDirectory })
  const { token, collectionGeneration: oldGeneration } = service.pair({ code: service.createPairingCode(), deviceId: 'restore-phone' })
  const originalMedia = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9])
  const originalDigest = createHash('sha256').update(originalMedia).digest('hex')
  await service.putMedia(token, originalDigest, 'image/png', originalMedia)
  service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [
    { opId: 'backup-note', entityType: 'note', entityId: 'note-1', action: 'create', occurredAt: '2026-10-03T10:00:00.000Z', payload: { id: 'note-1', front: '猫' } },
  ] })
  const backup = await service.createBackup(token)
  service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 1, operations: [
    { opId: 'after-backup', entityType: 'note', entityId: 'note-2', action: 'create', occurredAt: '2026-10-03T11:00:00.000Z', payload: { id: 'note-2', front: '犬' } },
  ] })
  assert.equal(service.changeCount(), 2)
  const preview = await service.previewBackupRestore(token, backup.id)
  assert.equal(preview.restoreAvailable, true)
  assert.match(preview.restoreBlocker, /new sync generation/i)
  assert.equal(service.health().collectionGeneration, oldGeneration)

  await assert.rejects(service.restoreBackup(token, backup.id, 'no'), /type restore/i)
  const restored = await service.restoreBackup(token, backup.id, 'RESTORE')
  assert.notEqual(restored.generation, oldGeneration)
  assert.equal(restored.changeCount, 1)
  assert.equal(service.changeCount(), 1)
  assert.equal(service.health().collectionGeneration, restored.generation)
  assert.equal(service.health().requiresCollectionGeneration, true)
  assert.ok((await service.listBackups(token)).some((item) => item.reason === 'before-restore'))
  const restoredMedia = await service.getMedia(token, originalDigest, restored.generation)
  assert.equal(restoredMedia.digest, originalDigest)
  assert.equal(restoredMedia.byteLength, originalMedia.byteLength)
  assert.equal(restoredMedia.mimeType, 'image/png')
  assert.deepEqual([...restoredMedia.bytes], [...originalMedia])
  await assert.rejects(service.getMedia(token, originalDigest, oldGeneration), /replaced from a backup/i)
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }), /replaced from a backup/i)
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, collectionGeneration: oldGeneration, cursor: 0, operations: [] }), /replaced from a backup/i)
  const replay = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, collectionGeneration: restored.generation, cursor: 0, operations: [] })
  assert.deepEqual(replay.changes.map((change) => change.opId), ['backup-note'])
  assert.equal(service.listDevices()[0].status, 'active')
  service.close()
  const reopened = createSyncService({ databasePath, mediaDirectory })
  assert.equal(reopened.health().collectionGeneration, restored.generation)
  assert.equal(reopened.health().requiresCollectionGeneration, true)
  assert.throws(() => reopened.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, collectionGeneration: oldGeneration, cursor: 0, operations: [] }), /replaced from a backup/i)
  assert.equal(reopened.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, collectionGeneration: restored.generation, cursor: 0, operations: [] }).changes.length, 1)
  reopened.close()
})

test('retains no more than fourteen verified backups and removes the oldest archive pair', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-backup-retention-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'backup-phone' })
  const created: Array<Awaited<ReturnType<typeof service.createBackup>>> = []
  for (let index = 0; index < 15; index += 1) created.push(await service.createBackup(token))
  const retained = await service.listBackups(token)
  assert.equal(retained.length, 14)
  assert.equal(retained.some(({ id }) => id === created[0].id), false)
  assert.equal(retained.some(({ id }) => id === created.at(-1)!.id), true)
  await assert.rejects(service.downloadBackup(token, created[0].id), /verified backup not found/i)
  service.close()
})

test('failed backup verification creates no artifact and blocks automatic backup before a risky sync write', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-backup-failure-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const mediaDirectory = join(runtimeDirectory, 'media')
  const service = createSyncService({ databasePath, mediaDirectory })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'backup-phone' })
  const content = new Uint8Array([1, 2, 3, 4])
  const mediaDigest = createHash('sha256').update(content).digest('hex')
  await service.putMedia(token, mediaDigest, 'image/png', content)
  await rm(join(mediaDirectory, mediaDigest.slice(0, 2), mediaDigest))

  await assert.rejects(service.syncWithBackup(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [{ opId: 'risky-write', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-03T10:00:00.000Z', payload: { id: 'note-1' } }] }), /backup before syncing/i)
  assert.equal(service.changeCount(), 0)
  assert.deepEqual(await service.listBackups(token), [])
  service.close()
})

test('serializes automatic backup plus sync so each later backup contains the prior accepted write', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-backup-serial-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'backup-phone' })
  const media = new Uint8Array(16 * 1024 * 1024).fill(42)
  const mediaDigest = createHash('sha256').update(media).digest('hex')
  await service.putMedia(token, mediaDigest, 'image/png', media)
  const request = (id: string) => ({
    protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0,
    operations: [{ opId: id, entityType: 'note', entityId: id, action: 'create', occurredAt: '2026-10-03T10:00:00.000Z', payload: { id } }],
  })

  const results = await Promise.all([service.syncWithBackup(token, request('first-write')), service.syncWithBackup(token, request('second-write'))])
  assert.deepEqual(results.map(({ accepted }) => accepted), [1, 1])
  assert.equal(service.changeCount(), 2)
  const backups = await service.listBackups(token)
  assert.equal(backups.length, 2)
  assert.deepEqual(backups.map(({ changeCount }) => changeCount).sort(), [0, 1])
  const laterBackup = backups.find(({ changeCount }) => changeCount === 1)!
  const { bytes } = await service.downloadBackup(token, laterBackup.id)
  const sqliteImage = unzipSync(bytes)['collection.sqlite']
  assert.ok(sqliteImage)
  const capturedPath = join(runtimeDirectory, 'captured-later-backup.sqlite')
  await writeFile(capturedPath, sqliteImage)
  const captured = new DatabaseSync(capturedPath, { readOnly: true })
  try {
    assert.deepEqual((captured.prepare('SELECT op_id FROM changes ORDER BY op_id').all() as Array<{ op_id: string }>).map(({ op_id }) => op_id), ['first-write'])
  } finally { captured.close() }
  service.close()
})

test('migrates a representative legacy sync database while preserving its rows', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-migration-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const previous = new DatabaseSync(databasePath)
  previous.exec(`
    CREATE TABLE changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
    INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES ('legacy-note', 'old-phone', 'note', 'note-1', 'create', '2026-10-01T00:00:00.000Z', '{"id":"note-1"}');
  `)
  previous.close()

  const service = createSyncService({ databasePath })
  try {
    const current = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal((current.prepare('SELECT op_id FROM changes').get() as { op_id: string }).op_id, 'legacy-note')
      assert.deepEqual((current.prepare('PRAGMA table_info(changes)').all() as Array<{ name: string }>).map(({ name }) => name).slice(-5), ['parents', 'review_id', 'lifetime', 'related_lifetimes', 'restore_of'])
      assert.equal((current.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    } finally { current.close() }
    assert.equal(service.changeCount(), 1)
  } finally { service.close() }
})

test('a failed schema migration rolls back every DDL change and retains the legacy database', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-migration-failure-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const previous = new DatabaseSync(databasePath)
  previous.exec(`
    CREATE TABLE changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
    INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES ('legacy-note', 'old-phone', 'note', 'note-1', 'create', '2026-10-01T00:00:00.000Z', '{"id":"note-1"}');
    CREATE TABLE collection_metadata (unexpected TEXT);
  `)
  previous.close()

  assert.throws(() => createSyncService({ databasePath }), /migration failed safely/i)
  const retained = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const names = new Set((retained.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name))
    assert.deepEqual([...names].sort(), ['changes', 'collection_metadata', 'sqlite_sequence'])
    assert.equal((retained.prepare('SELECT op_id FROM changes').get() as { op_id: string }).op_id, 'legacy-note')
    assert.deepEqual((retained.prepare('PRAGMA table_info(changes)').all() as Array<{ name: string }>).map(({ name }) => name).slice(-1), ['payload'])
    assert.equal((retained.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  } finally { retained.close() }
})

test('re-reads the durable watermark under the write lock before accepting a stale request', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const staleService = createSyncService({ databasePath })
  const code = staleService.createPairingCode()
  const { token } = staleService.pair({ code, deviceId: 'phone-1' })
  // This second service simulates another sync process ratcheting the shared
  // collection after staleService has already read its initial watermark.
  const newerService = createSyncService({ databasePath })
  assert.equal(newerService.sync(token, { protocolVersion: 2, collectionSchemaVersion: 12, cursor: 0, operations: [] }).accepted, 0)

  assert.throws(() => staleService.sync(token, {
    protocolVersion: 2,
    collectionSchemaVersion: 10,
    cursor: 0,
    operations: [{ opId: 'stale-write', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1' } }],
  }), /requires schema 12/i)
  assert.equal(staleService.changeCount(), 0)
  newerService.close()
  staleService.close()
})

test('infers a schema watermark from a legacy change log and refuses a malformed higher-schema batch without mutation', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`CREATE TABLE changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);`)
  legacy.prepare('INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)').run('nested-deck', 'old-device', 'deck', 'deck-1', 'update', '2026-10-01T12:00:00.000Z', JSON.stringify({ id: 'deck-1', parentId: 'parent', optionGroupId: 'default' }))
  legacy.close()

  const service = createSyncService({ databasePath })
  assert.equal(service.health().collectionSchemaVersion, 9)
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  assert.throws(() => service.sync(token, {
    protocolVersion: 2,
    collectionSchemaVersion: 10,
    cursor: 0,
    operations: [{ opId: 'policy-card', entityType: 'card', entityId: 'card-1', action: 'update', occurredAt: '2026-10-01T12:01:00.000Z', payload: { id: 'card-1', manualSuspended: true } }],
  }), /declares schema 10/i)
  assert.equal(service.changeCount(), 1)
  service.close()
})

test('infers v12 interday learning ordering from a legacy deck-option change log', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`CREATE TABLE changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);`)
  legacy.prepare('INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)').run('interday-order', 'old-device', 'deckOptionGroup', 'group-1', 'update', '2026-10-01T12:00:00.000Z', JSON.stringify({ id: 'group-1', interdayLearningOrder: 'due' }))
  legacy.close()

  const service = createSyncService({ databasePath })
  assert.equal(service.health().collectionSchemaVersion, 12)
  service.close()
})

test('infers v10 scheduling options from a legacy deck-option change log', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const databasePath = join(runtimeDirectory, 'collection.sqlite')
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`CREATE TABLE changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);`)
  legacy.prepare('INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)').run('schedule-options', 'old-device', 'deckOptionGroup', 'group-1', 'update', '2026-10-01T12:00:00.000Z', JSON.stringify({ id: 'group-1', dailyNewLimit: 20, dailyReviewLimit: 200, desiredRetention: 0.9, learningSteps: ['1m'], relearningSteps: ['10m'], newCardOrder: 'added', reviewCardOrder: 'due' }))
  legacy.close()

  const service = createSyncService({ databasePath })
  assert.equal(service.health().collectionSchemaVersion, 10)
  service.close()
})

test('reserves durable media metadata by verified digest', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite'), mediaDirectory: join(runtimeDirectory, 'media') })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  assert.equal(typeof service.putMedia, 'function')
  await assert.rejects(service.putMedia(token, 'invalid', 'image/png', new Uint8Array([1])), /digest/i)
  const bytes = new Uint8Array([137, 80, 78, 71])
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(await service.putMedia(token, digest, 'image/png', bytes), { digest, byteLength: bytes.byteLength, mimeType: 'image/png', deduplicated: false })
  assert.deepEqual(await service.putMedia(token, digest, 'image/jpeg', bytes), { digest, byteLength: bytes.byteLength, mimeType: 'image/png', deduplicated: true })
  assert.deepEqual((await service.getMedia(token, digest)).bytes, Buffer.from(bytes))
  await writeFile(join(runtimeDirectory, 'media', digest.slice(0, 2), digest), 'corrupt')
  await assert.rejects(service.getMedia(token, digest), /verification/i)
  service.close()
})

for (const entityType of ['noteMedia', 'noteType', 'deckOptionGroup']) {
  for (const metadata of [{ parents: [] as string[] }, { reviewId: 'review-1' }]) {
    test(`requires schema 15 for ${entityType} with ${Object.keys(metadata)[0]} before accepting any batch row`, async () => {
      runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
      const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
      try {
        const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'phone-1' })
        const ordinary = { opId: 'ordinary', entityType: 'deck', entityId: 'deck-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'deck-1' } }
        const causal = { ...ordinary, opId: 'causal', entityType, entityId: 'entity-1', payload: { id: 'entity-1' }, ...metadata }
        assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 14, cursor: 0, operations: [ordinary, causal] }), /schema 15.*declares schema 14/i)
        assert.equal(service.changeCount(), 0)
        assert.equal(service.health().collectionSchemaVersion, 1)
        assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0, operations: [causal] }).accepted, 1)
        assert.equal(service.health().collectionSchemaVersion, 15)
        assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 14, cursor: 0, operations: [] }), /requires schema 15/i)
      } finally { service.close() }
    })
  }
}

test('rejects cyclic, dangling, and cross-entity revision parents without storing any part of the batch', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  try {
    const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'phone-1' })
    const operation = (opId: string, entityId: string, parents: string[]) => ({ opId, entityType: 'note' as const, entityId, action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: entityId }, parents })
    const ordinary = { opId: 'ordinary', entityType: 'deck' as const, entityId: 'deck-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'deck-1' } }
    const send = (operations: Parameters<typeof service.sync>[1]['operations']) => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0, operations })
    assert.throws(() => send([ordinary, operation('cycle-a', 'note-1', ['cycle-b']), operation('cycle-b', 'note-1', ['cycle-a'])]), /cyclic/i)
    assert.throws(() => send([ordinary, operation('dangling', 'note-1', ['missing-parent'])]), /parent is missing/i)
    assert.throws(() => send([ordinary, { ...ordinary, opId: 'other-deck' }, operation('cross-record', 'note-1', ['other-deck'])]), /another record/i)
    assert.equal(service.changeCount(), 0)
    assert.equal(service.health().collectionSchemaVersion, 1)
  } finally { service.close() }
})

for (const metadataColumn of ['parents', 'review_id']) {
  for (const watermark of [null, '14']) {
    test(`infers causal schema 15 from persisted ${metadataColumn} with ${watermark ?? 'missing'} watermark`, async () => {
      runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
      const databasePath = join(runtimeDirectory, 'collection.sqlite')
      let service = createSyncService({ databasePath })
      service.close()
      const stored = new DatabaseSync(databasePath)
      stored.prepare(`INSERT INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload, ${metadataColumn}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('causal', 'old-device', 'noteMedia', 'entity-1', 'create', '2026-10-01T12:00:00.000Z', '{"id":"entity-1"}', metadataColumn === 'parents' ? '[]' : 'review-1')
      if (watermark === null) stored.exec('DELETE FROM collection_metadata')
      else stored.prepare("UPDATE collection_metadata SET value = ? WHERE key = 'collection_schema_version'").run(watermark)
      stored.close()
      service = createSyncService({ databasePath })
      try {
        assert.equal(service.health().collectionSchemaVersion, 15)
        const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'phone-1' })
        assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 14, cursor: 0, operations: [] }), /requires schema 15/i)
        assert.equal(service.changeCount(), 1)
      } finally { service.close() }
    })
  }
}

test('serves health, pairing, and authenticated sync over HTTP', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service, { allowedOrigin: 'http://127.0.0.1:4173', jsonBodyLimitBytes: 4096 }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  try {

  const health = await fetch(`${origin}/api/health`)
  assert.deepEqual(await health.json(), service.health())

  const preflight = await fetch(`${origin}/api/sync`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4173' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173')
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT/)
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-collection-generation/)
  assert.match(preflight.headers.get('access-control-expose-headers') ?? '', /x-content-sha256/)
  const rejectedOrigin = await fetch(`${origin}/api/health`, { headers: { origin: 'https://untrusted.example.test' } })
  assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'), null)

  const oversizedCode = service.createPairingCode()
  const oversizedPairing = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: oversizedCode, deviceId: 'x'.repeat(5000) }) })
  assert.equal(oversizedPairing.status, 413)
  const streamedOversizedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    request.on('error', reject)
    request.end(JSON.stringify({ code: oversizedCode, deviceId: 'x'.repeat(5000) }))
  })
  assert.equal(streamedOversizedStatus, 413)
  const pairingAfterRejection = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: oversizedCode, deviceId: 'phone-after-rejection' }) })
  assert.equal(pairingAfterRejection.status, 201)

  const code = service.createPairingCode()
  const protectedBackupId = randomUUID()
  const protectedMediaDigest = 'a'.repeat(64)
  const protectedRequests: Array<Promise<Response>> = [
    fetch(`${origin}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [] }) }),
    fetch(`${origin}/api/credential/rotate`, { method: 'POST' }),
    fetch(`${origin}/api/backups`),
    fetch(`${origin}/api/backups`, { method: 'POST' }),
    fetch(`${origin}/api/backups/${protectedBackupId}/download`),
    fetch(`${origin}/api/backups/${protectedBackupId}/restore-preview`, { method: 'POST' }),
    fetch(`${origin}/api/backups/${protectedBackupId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'RESTORE' }) }),
    fetch(`${origin}/api/media/${protectedMediaDigest}`),
    fetch(`${origin}/api/media/${protectedMediaDigest}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([1]) }),
  ]
  const protectedResponses = await Promise.all(protectedRequests)
  assert.deepEqual(protectedResponses.map((response) => response.status), Array(protectedRequests.length).fill(401))
  const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: 'phone-1' }) })
  const credential = await paired.json() as { token: string }
  const denied = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [] }) })
  assert.equal(denied.status, 401)
  const legacyProtocol = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [{ opId: 'legacy-write', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1' } }] }) })
  assert.equal(legacyProtocol.status, 409)
  assert.deepEqual(await legacyProtocol.json(), { code: 'protocol-upgrade-required', message: 'This PC sync service and this device use incompatible sync protocols. Update both, then try again.', protocolVersion: 2 })
  assert.equal(service.changeCount(), 0)
  const synced = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [] }) })
  assert.deepEqual(await synced.json(), { protocolVersion: 2, collectionSchemaVersion: 10, collectionGeneration: service.health().collectionGeneration, accepted: 0, cursor: 0, hasMore: false, changes: [] })
  const rejected = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 6, cursor: 0, operations: [{ opId: 'stale-write', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1' } }] }) })
  assert.equal(rejected.status, 409)
  assert.deepEqual(await rejected.json(), { code: 'client-upgrade-required', message: 'This collection requires schema 10; this device declares schema 6. Update Kiroku on this device, then try again.', protocolVersion: 2, requiredSchemaVersion: 10 })
  assert.equal(service.changeCount(), 0)
  const mediaBytes = new Uint8Array([137, 80, 78, 71])
  const mediaDigest = createHash('sha256').update(mediaBytes).digest('hex')
  const uploaded = await fetch(`${origin}/api/media/${mediaDigest}`, { method: 'PUT', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'image/png' }, body: mediaBytes })
  assert.equal(uploaded.status, 200)
  const downloaded = await fetch(`${origin}/api/media/${mediaDigest}`, { headers: { authorization: `Bearer ${credential.token}`, origin: 'http://127.0.0.1:4173' } })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('x-content-sha256'), mediaDigest)
  assert.match(downloaded.headers.get('access-control-expose-headers') ?? '', /x-content-sha256/)
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), mediaBytes)

  const rotated = await fetch(`${origin}/api/credential/rotate`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}` } })
  assert.equal(rotated.status, 200)
  const nextCredential = await rotated.json() as { token: string }
  assert.match(nextCredential.token, /^[a-f0-9]{64}$/)
  const oldCredentialDenied = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }) })
  assert.equal(oldCredentialDenied.status, 401)
  const newCredentialAccepted = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${nextCredential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [] }) })
  assert.equal(newCredentialAccepted.status, 200)
  const unauthenticatedRotation = await fetch(`${origin}/api/credential/rotate`, { method: 'POST' })
  assert.equal(unauthenticatedRotation.status, 401)

  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    service.close()
  }
})

test('rate limits unsuccessful pairing attempts by peer and then allows a valid code after the window', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-pair-rate-limit-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service, { pairingAttemptLimit: 2, pairingWindowMs: 1_000 }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const oversized = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong-code', deviceId: 'x'.repeat(5000) }) })
    assert.equal(oversized.status, 413)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong-code', deviceId: `phone-${attempt}` }) })
      assert.equal(response.status, 400)
    }
    const limited = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong-code', deviceId: 'phone-limited' }) })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '1')
    const code = service.createPairingCode()
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: 'phone-after-window' }) })
    assert.equal(paired.status, 201)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    service.close()
  }
})

test('exposes manual backup download and verified preview and snapshots before an HTTP sync mutation', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-backup-http-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const code = service.createPairingCode()
    const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: 'backup-http-phone' }) })
    const { token } = await paired.json() as { token: string }
    const unauthorized = await fetch(`${origin}/api/backups`)
    assert.equal(unauthorized.status, 401)

    const manual = await fetch(`${origin}/api/backups`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    assert.equal(manual.status, 201)
    const manifest = await manual.json() as { id: string; reason: string; archiveSha256: string }
    assert.equal(manifest.reason, 'manual')
    const file = await fetch(`${origin}/api/backups/${manifest.id}/download`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('x-content-sha256'), manifest.archiveSha256)
    assert.match(file.headers.get('content-disposition') ?? '', /kiroku-backup-/)
    const preview = await fetch(`${origin}/api/backups/${manifest.id}/restore-preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    assert.equal(preview.status, 200)
    assert.equal((await preview.json() as { restoreAvailable: boolean }).restoreAvailable, true)

    const sync = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [{ opId: 'before-sync-backup', entityType: 'note', entityId: 'note-1', action: 'create', occurredAt: '2026-10-03T10:00:00.000Z', payload: { id: 'note-1' } }] }) })
    assert.equal(sync.status, 200)
    const listed = await fetch(`${origin}/api/backups`, { headers: { authorization: `Bearer ${token}` } })
    const backups = (await listed.json() as { backups: Array<{ reason: string; changeCount: number }> }).backups
    assert.deepEqual(backups.map(({ reason, changeCount }) => ({ reason, changeCount })), [{ reason: 'before-sync', changeCount: 0 }, { reason: 'manual', changeCount: 0 }])
    const unconfirmed = await fetch(`${origin}/api/backups/${manifest.id}/restore`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'no' }) })
    assert.equal(unconfirmed.status, 400)
    assert.equal(service.changeCount(), 1)
    const restoredResponse = await fetch(`${origin}/api/backups/${manifest.id}/restore`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'RESTORE' }) })
    assert.equal(restoredResponse.status, 200)
    const restored = await restoredResponse.json() as { generation: string; before: { reason: string } }
    assert.match(restored.generation, /^[a-f0-9-]{36}$/)
    assert.equal(restored.before.reason, 'before-restore')
    assert.equal(service.changeCount(), 0)
    const rejectedOldClient = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [{ opId: 'stale-device-write', entityType: 'note', entityId: 'note-2', action: 'create', occurredAt: '2026-10-03T12:00:00.000Z', payload: { id: 'note-2' } }] }) })
    assert.equal(rejectedOldClient.status, 409)
    assert.equal((await rejectedOldClient.json() as { code: string }).code, 'collection-generation-required')
    assert.equal(service.changeCount(), 0)
    const activeGeneration = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const acceptedCurrentClient = await fetch(`${origin}/api/sync`, { method: 'POST', headers: activeGeneration, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 16, collectionGeneration: restored.generation, cursor: 0, operations: [] }) })
    assert.equal(acceptedCurrentClient.status, 200)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    service.close()
  }
})

test('requires schema 13 before accepting a flagged card operation', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  const operation = { opId: 'card-flag', entityType: 'card', entityId: 'card-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'card-1', flag: 1 } }
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 12, cursor: 0, operations: [operation] }), /declares schema 12/i)
  assert.equal(service.changeCount(), 0)
  assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 13, cursor: 0, operations: [operation] }).accepted, 1)
  assert.equal(service.health().collectionSchemaVersion, 13)
  service.close()
})

test('starts a loopback service with a durable runtime directory', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const running = await startSyncServer({ runtimeDirectory, host: '127.0.0.1', port: 0 })

  const health = await fetch(`http://127.0.0.1:${running.port}/api/health`)
  assert.equal(health.status, 200)
  const status = await health.json() as { collectionGeneration?: string; requiresCollectionGeneration?: boolean }
  assert.match(status.collectionGeneration ?? '', /^[a-f0-9-]{36}$/)
  assert.equal(status.requiresCollectionGeneration, false)
  await running.close()
})

test('requires TLS before binding the service to a network interface', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  await assert.rejects(startSyncServer({ runtimeDirectory, host: '0.0.0.0', port: 0 }), /TLS/)
})

test('issues a one-time pairing code against the running service store', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const running = await startSyncServer({ runtimeDirectory, host: '127.0.0.1', port: 0 })
  const code = await createPairingCode({ runtimeDirectory })
  const paired = await fetch(`http://127.0.0.1:${running.port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceId: 'phone-1' }),
  })

  assert.equal(paired.status, 201)
  await running.close()
})

test('requires schema 16 for explicit post-answer review schedules and prevents older clients acknowledging them', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'practice-phone' })
  const operation = { opId: 'after-review', entityType: 'review', entityId: 'review-after', action: 'create', occurredAt: '2026-10-02T12:00:00.000Z', payload: { id: 'review-after', afterState: 2 } }
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0, operations: [operation] }), /declares schema 15/i)
  assert.equal(service.changeCount(), 0)
  assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 16, cursor: 0, operations: [operation] }).accepted, 1)
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0, operations: [] }), /schema/i)
  service.close()
})
