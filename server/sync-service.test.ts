import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createPairingCode, startSyncServer } from './index.js'
import { createSyncService } from './sync-service.js'
import { createSyncHttpHandler } from './sync-http.js'

let runtimeDirectory: string | undefined
const serviceHealth = (collectionSchemaVersion = 1) => ({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion, maximumCollectionSchemaVersion: 14, store: 'sqlite' as const })

afterEach(async () => {
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
  runtimeDirectory = undefined
})

test('reports a ready durable store and accepts a pairing code only once', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })

  assert.deepEqual(service.health(), serviceHealth())

  const pairingCode = service.createPairingCode(new Date('2026-10-01T12:00:00.000Z'))
  const paired = service.pair({ code: pairingCode, deviceId: 'phone-1' }, new Date('2026-10-01T12:01:00.000Z'))

  assert.equal(paired.deviceId, 'phone-1')
  assert.match(paired.token, /^[a-f0-9]{64}$/)
  assert.throws(() => service.pair({ code: pairingCode, deviceId: 'phone-2' }, new Date('2026-10-01T12:02:00.000Z')))
  service.close()
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
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 15, cursor: 0, operations: [] }), /supports collection schemas through 14/i)
  assert.equal(service.changeCount(), 0)
  service.close()

  const reopened = createSyncService({ databasePath })
  assert.equal(reopened.health().collectionSchemaVersion, 12)
  reopened.close()
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

test('serves health, pairing, and authenticated sync over HTTP', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service, { allowedOrigin: 'http://127.0.0.1:4173' }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  try {

  const health = await fetch(`${origin}/api/health`)
  assert.deepEqual(await health.json(), serviceHealth())

  const preflight = await fetch(`${origin}/api/sync`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4173' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173')
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT/)
  assert.match(preflight.headers.get('access-control-expose-headers') ?? '', /x-content-sha256/)
  const rejectedOrigin = await fetch(`${origin}/api/health`, { headers: { origin: 'https://untrusted.example.test' } })
  assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'), null)

  const code = service.createPairingCode()
  const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: 'phone-1' }) })
  const credential = await paired.json() as { token: string }
  const denied = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [] }) })
  assert.equal(denied.status, 401)
  const legacyProtocol = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [{ opId: 'legacy-write', entityType: 'note', entityId: 'note-1', action: 'update', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'note-1' } }] }) })
  assert.equal(legacyProtocol.status, 409)
  assert.deepEqual(await legacyProtocol.json(), { code: 'protocol-upgrade-required', message: 'This PC sync service and this device use incompatible sync protocols. Update both, then try again.', protocolVersion: 2 })
  assert.equal(service.changeCount(), 0)
  const synced = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: 10, cursor: 0, operations: [] }) })
  assert.deepEqual(await synced.json(), { protocolVersion: 2, collectionSchemaVersion: 10, accepted: 0, cursor: 0, changes: [] })
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
  assert.deepEqual(await health.json(), serviceHealth())
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

test('requires schema 14 for practice reviews and prevents older clients acknowledging them', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })
  const { token } = service.pair({ code: service.createPairingCode(), deviceId: 'practice-phone' })
  const operation = { opId: 'practice-review', entityType: 'review', entityId: 'review-practice', action: 'create', occurredAt: '2026-10-02T12:00:00.000Z', payload: { id: 'review-practice', rescheduled: false } }
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 13, cursor: 0, operations: [operation] }), /declares schema 13/i)
  assert.equal(service.changeCount(), 0)
  assert.equal(service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 14, cursor: 0, operations: [operation] }).accepted, 1)
  assert.throws(() => service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 13, cursor: 0, operations: [] }), /schema/i)
  service.close()
})
