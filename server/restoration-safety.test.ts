import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSyncService } from './sync-service.js'
import { createSyncHttpHandler } from './sync-http.js'

const original = { opId: 'created', entityType: 'deck', entityId: 'deck', action: 'create', occurredAt: '2026-10-07T12:00:00Z', payload: { id: 'deck', name: 'Restoration safety', parentId: null }, lifetime: [], relatedLifetimes: [] }
const deletion = { ...original, opId: 'deleted', action: 'delete', payload: { id: 'deck' }, parents: ['created'] }
const restoration = { ...original, opId: 'restored', action: 'restore', parents: ['deleted'], lifetime: ['deleted'], restoreOf: [{ source: { entityType: 'deck', entityId: 'deck' }, opId: 'deleted', deletedLifetime: [] }] }

async function withService(run: (service: ReturnType<typeof createSyncService>, token: string, origin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-restoration-safety-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const response = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: service.createPairingCode(), deviceId: 'safety-device' }) })
    assert.equal(response.status, 201)
    const { token } = await response.json() as { token: string }
    await run(service, token, origin)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const request = (origin: string, token: string, operations: unknown[], schema = 22, generation?: string) => fetch(`${origin}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2, collectionSchemaVersion: schema, cursor: 0, operations, ...(generation ? { collectionGeneration: generation } : {}) }) })

test('schema 21 cannot acknowledge a schema 22 restored collection', async () => {
  await withService(async (service, token, origin) => {
    assert.equal((await request(origin, token, [original, deletion, restoration])).status, 200)
    for (const operations of [[], [{ ...original, opId: 'old-client-work', entityId: 'other', payload: { id: 'other' }, lifetime: undefined, relatedLifetimes: undefined }]]) {
      const response = await request(origin, token, operations, 21)
      assert.equal(response.status, 409)
      assert.equal((await response.json() as { requiredSchemaVersion: number }).requiredSchemaVersion, 22)
      assert.equal(service.changeCount(), 3)
    }
  })
})

test('verified backup restoration retains all lifecycle columns and generation fences', async () => {
  await withService(async (service, token, origin) => {
    assert.equal((await request(origin, token, [original, deletion, restoration])).status, 200)
    const before = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 22, cursor: 0, operations: [] })
    const backup = await service.createBackup(token)
    assert.equal(backup.collectionSchemaVersion, 22)
    assert.equal((await request(origin, token, [{ ...original, opId: 'later', entityId: 'other', payload: { id: 'other' } }])).status, 200)
    const restored = await service.restoreBackup(token, backup.id, 'RESTORE')
    assert.notEqual(restored.generation, before.collectionGeneration)
    assert.equal((await request(origin, token, [restoration], 22, before.collectionGeneration)).status, 409)
    assert.equal(service.changeCount(), 3)
    const replay = await request(origin, token, [restoration], 22, restored.generation)
    assert.equal(replay.status, 200)
    const after = await replay.json() as { accepted: number; changes: unknown[]; collectionSchemaVersion: number }
    assert.equal(after.accepted, 0)
    assert.equal(after.collectionSchemaVersion, 22)
    assert.deepEqual(after.changes, before.changes)
    assert.equal((await request(origin, token, [], 21, restored.generation)).status, 409)
  })
})

test('cyclic restoration cannot acknowledge its own deletion as an earlier lifetime', async () => {
  await withService(async (service, token, origin) => {
    const futureDeletion = { ...deletion, lifetime: ['deleted'] }
    assert.equal((await request(origin, token, [original, futureDeletion])).status, 200)
    const cyclic = { ...restoration, restoreOf: [{ ...restoration.restoreOf[0], deletedLifetime: ['deleted'] }] }
    const response = await request(origin, token, [cyclic])
    assert.equal(response.status, 400)
    assert.match((await response.json() as { error: string }).error, /cyclic.*provenance/i)
    assert.equal(service.changeCount(), 2)
  })
})

const malformed: Array<[string, unknown]> = [
  ['non-string lifetime', { ...restoration, lifetime: [7] }],
  ['non-canonical related lifetime', { ...restoration, relatedLifetimes: [{ entityType: 'deck', entityId: 'parent', lifetime: ['z', 'a'] }] }],
  ['null related reference', { ...restoration, relatedLifetimes: [null] }],
  ['unknown related entity kind', { ...restoration, relatedLifetimes: [{ entityType: 'alien', entityId: 'parent', lifetime: [] }] }],
  ['non-array deleted lifetime', { ...restoration, restoreOf: [{ ...restoration.restoreOf[0], deletedLifetime: 'initial' }] }],
  ['null deletion source', { ...restoration, restoreOf: [{ ...restoration.restoreOf[0], source: null }] }],
  ['cyclic deleted lifetime', { ...restoration, restoreOf: [{ ...restoration.restoreOf[0], deletedLifetime: ['deleted'] }] }],
  ['unrelated deletion identity', { ...restoration, entityId: 'unrelated', payload: { id: 'unrelated' }, parents: [] }],
  ['wrong direct deleted lifetime', { ...restoration, restoreOf: [{ ...restoration.restoreOf[0], deletedLifetime: ['unrelated-delete'] }] }],
  ['missing parent lifetime', { ...original, opId: 'unsafe-child', entityId: 'child', payload: { id: 'child', parentId: 'deck' } }],
  ['malformed ordinary lifetime', { ...original, opId: 'unsafe-ordinary', lifetime: ['z', 'a'] }],
]

for (const [name, invalid] of malformed) test(`malformed ${name} is refused atomically before acknowledgment`, async () => {
  await withService(async (service, token, origin) => {
    assert.equal((await request(origin, token, [original, deletion])).status, 200)
    const valid = { ...original, opId: 'must-rollback', entityId: 'other', payload: { id: 'other' } }
    const response = await request(origin, token, [valid, invalid])
    assert.equal(response.status, 400)
    assert.match((await response.json() as { error: string }).error, /lifetime|provenance|reference|restoration/i)
    assert.equal(service.changeCount(), 2)
    const retained = service.sync(token, { protocolVersion: 2, collectionSchemaVersion: 22, cursor: 0, operations: [] })
    assert.deepEqual(retained.changes.map(change => change.opId), ['created', 'deleted'])
  })
})
