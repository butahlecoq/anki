import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createServer } from 'node:http'
import { createPairingCode, startSyncServer } from './index.js'
import { createSyncService } from './sync-service.js'
import { createSyncHttpHandler } from './sync-http.js'

let runtimeDirectory: string | undefined

afterEach(async () => {
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
  runtimeDirectory = undefined
})

test('reports a ready durable store and accepts a pairing code only once', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite') })

  assert.deepEqual(service.health(), { ready: true, schemaVersion: 1, store: 'sqlite' })

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
    cursor: 0,
    operations: [{ opId: 'review-1', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-01T12:02:00.000Z', payload: { cardId: 'card-1', rating: 'good' } }],
  }

  assert.equal(service.sync(token, request).accepted, 1)
  assert.equal(service.sync(token, request).accepted, 0)
  assert.equal(service.reviewCount(), 1)
  const pulled = service.sync(token, { cursor: 0, operations: [] })
  assert.equal(pulled.changes.length, 1)
  assert.equal(pulled.cursor, 1)
  service.close()
})

test('reserves durable media metadata by verified digest', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'collection.sqlite'), mediaDirectory: join(runtimeDirectory, 'media') })
  const code = service.createPairingCode()
  const { token } = service.pair({ code, deviceId: 'phone-1' })
  assert.equal(typeof service.putMedia, 'function')
  await assert.rejects(service.putMedia(token, 'invalid', 'image/png', new Uint8Array([1])), /digest/i)
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

  const health = await fetch(`${origin}/api/health`)
  assert.deepEqual(await health.json(), { ready: true, schemaVersion: 1, store: 'sqlite' })

  const preflight = await fetch(`${origin}/api/sync`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4173' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173')
  const rejectedOrigin = await fetch(`${origin}/api/health`, { headers: { origin: 'https://untrusted.example.test' } })
  assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'), null)

  const code = service.createPairingCode(new Date('2026-10-01T12:00:00.000Z'))
  const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: 'phone-1' }) })
  const credential = await paired.json() as { token: string }
  const denied = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [] }) })
  assert.equal(denied.status, 401)
  const synced = await fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 0, operations: [] }) })
  assert.deepEqual(await synced.json(), { accepted: 0, cursor: 0, changes: [] })

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  service.close()
})

test('starts a loopback service with a durable runtime directory', async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'kiroku-sync-'))
  const running = await startSyncServer({ runtimeDirectory, host: '127.0.0.1', port: 0 })

  const health = await fetch(`http://127.0.0.1:${running.port}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ready: true, schemaVersion: 1, store: 'sqlite' })
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
