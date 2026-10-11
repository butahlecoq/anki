import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createBackupStore } from './backups.js'
import { readBuildIdentity } from './build-identity.js'
import { SERVER_MAX_COLLECTION_SCHEMA_VERSION, SYNC_CHANGE_PAGE_SIZE, SYNC_PROTOCOL_VERSION, type IncompatibleSync, type SyncCapabilities, type SyncHealth } from '../sync-capabilities.js'
import { restoredLifetime, validateRestorationEvidence, validateLifetimeMetadata, type EntityLifetimeMetadata, type EntityLifetimeOperation } from '../entity-lifetimes.js'
import { schemaRequiredByOperation } from '../schema-ladder.js'
import { isSupportedMediaType } from '../anki-interchange.js'
import { collectionGeneration as getCollectionGeneration, requiresCollectionGeneration } from './collection-generation.js'

type ServiceOptions = { databasePath: string; mediaDirectory?: string }
type PairRequest = { code: string; deviceId: string }
type SyncOperation = EntityLifetimeMetadata & {
  opId: string
  entityType: string
  entityId: string
  action: string
  occurredAt: string
  payload: unknown
  parents?: string[]
  reviewId?: string
}
type SyncRequest = SyncCapabilities & { collectionGeneration?: string; cursor: number; operations: SyncOperation[] }

type PersistedChange = { entity_type: string; action: string; payload: string; parents: string | null; review_id: string | null; lifetime: string | null; related_lifetimes: string | null; restore_of: string | null }


export class SyncCompatibilityError extends Error {
  constructor(readonly incompatibility: IncompatibleSync) {
    super(incompatibility.message)
  }
}

export class SyncBackupError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : 'The automatic backup failed; no sync changes were accepted.')
  }
}

/** Check causal edges before storing any row so a malformed batch cannot poison future syncs. */
function validateRevisionParents(operations: SyncOperation[], database: DatabaseSync) {
  const batch = new Map<string, SyncOperation>()
  for (const operation of operations) {
    const prior = batch.get(operation.opId)
    if (prior && (prior.entityType !== operation.entityType || prior.entityId !== operation.entityId || JSON.stringify(prior.parents ?? []) !== JSON.stringify(operation.parents ?? []))) throw new Error('Sync operation identity was reused with different revision parents')
    batch.set(operation.opId, operation)
  }
  const graph = new Map<string, string[]>()
  for (const operation of batch.values()) {
    const parents = operation.parents ?? []
    if (!Array.isArray(parents) || parents.some((parent) => typeof parent !== 'string' || !parent || parent === operation.opId) || new Set(parents).size !== parents.length) throw new Error('Invalid sync revision parents')
    for (const parentId of parents) {
      const inBatch = batch.get(parentId)
      const stored = inBatch ? undefined : database.prepare('SELECT entity_type, entity_id FROM changes WHERE op_id = ?').get(parentId) as { entity_type: string; entity_id: string } | undefined
      if (inBatch ? inBatch.entityType !== operation.entityType || inBatch.entityId !== operation.entityId : !stored || stored.entity_type !== operation.entityType || stored.entity_id !== operation.entityId) throw new Error('Sync revision parent is missing or belongs to another record')
    }
    graph.set(operation.opId, parents.filter((parentId) => batch.has(parentId)))
  }
  const complete = new Set<string>()
  const visiting = new Set<string>()
  for (const start of graph.keys()) {
    if (complete.has(start)) continue
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }]
    visiting.add(start)
    while (stack.length) {
      const frame = stack.at(-1)!
      const parents = graph.get(frame.id) ?? []
      if (frame.next === parents.length) {
        stack.pop(); visiting.delete(frame.id); complete.add(frame.id); continue
      }
      const parent = parents[frame.next++]
      if (visiting.has(parent)) throw new Error('Cyclic sync revision history')
      if (!complete.has(parent)) { visiting.add(parent); stack.push({ id: parent, next: 0 }) }
    }
  }
}

function compatibilityError(code: IncompatibleSync['code'], message: string, details: Omit<IncompatibleSync, 'code' | 'message' | 'protocolVersion'> = {}) {
  return new SyncCompatibilityError({ code, message, protocolVersion: SYNC_PROTOCOL_VERSION, ...details })
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('hex')

export function createSyncService({ databasePath, mediaDirectory: configuredMediaDirectory }: ServiceOptions) {
  const mediaDirectory = configuredMediaDirectory ?? join(dirname(databasePath), 'media')
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true })
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
  let collectionSchemaVersion = 1
  try {
    database.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, FOREIGN KEY(device_id) REFERENCES devices(id));
    CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_blobs (digest TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, mime_type TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const changeColumns = database.prepare('PRAGMA table_info(changes)').all() as Array<{ name: string }>
    if (!changeColumns.some((column) => column.name === 'parents')) database.exec('ALTER TABLE changes ADD COLUMN parents TEXT')
    if (!changeColumns.some((column) => column.name === 'review_id')) database.exec('ALTER TABLE changes ADD COLUMN review_id TEXT')
    for (const column of ['lifetime', 'related_lifetimes', 'restore_of']) {
      if (!changeColumns.some((existing) => existing.name === column)) database.exec(`ALTER TABLE changes ADD COLUMN ${column} TEXT`)
    }
    const storedWatermark = database.prepare("SELECT value FROM collection_metadata WHERE key = 'collection_schema_version'").get() as { value: string } | undefined
    const persistedWatermark = storedWatermark && Number.parseInt(storedWatermark.value, 10)
    const inferredWatermark = (database.prepare('SELECT entity_type, action, payload, parents, review_id, lifetime, related_lifetimes, restore_of FROM changes').all() as PersistedChange[]).reduce((maximum, change) => {
      try {
        return Math.max(maximum, schemaRequiredByOperation({
          entityType: change.entity_type, action: change.action, payload: JSON.parse(change.payload),
          ...(change.parents !== null ? { parents: JSON.parse(change.parents) as string[] } : {}),
          ...(change.review_id !== null ? { reviewId: change.review_id } : {}),
          ...(change.lifetime !== null ? { lifetime: JSON.parse(change.lifetime) } : {}),
          ...(change.related_lifetimes !== null ? { relatedLifetimes: JSON.parse(change.related_lifetimes) } : {}),
          ...(change.restore_of !== null ? { restoreOf: JSON.parse(change.restore_of) } : {}),
        }))
      } catch {
        // Corrupt historic payloads still require the newest service/client pair.
        return SERVER_MAX_COLLECTION_SCHEMA_VERSION
      }
    }, 1)
    collectionSchemaVersion = Math.max(1, typeof persistedWatermark === 'number' && Number.isSafeInteger(persistedWatermark) ? persistedWatermark : 1, inferredWatermark)
    if (!storedWatermark || collectionSchemaVersion !== persistedWatermark) database.prepare("INSERT INTO collection_metadata (key, value) VALUES ('collection_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(collectionSchemaVersion))
    getCollectionGeneration(database)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* A failed begin leaves no transaction to roll back. */ }
    database.close()
    throw new Error(`Sync service schema migration failed safely; the previous database state was retained. ${error instanceof Error ? error.message : 'Unknown migration failure.'}`)
  }

  const persistedCollectionSchemaVersion = () => {
    const metadata = database.prepare("SELECT value FROM collection_metadata WHERE key = 'collection_schema_version'").get() as { value: string } | undefined
    const value = metadata && Number.parseInt(metadata.value, 10)
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1
  }

  const backups = createBackupStore({
    database, mediaDirectory, backupDirectory: join(dirname(databasePath), 'backups'), collectionSchemaVersion: persistedCollectionSchemaVersion,
    prepareRestoredDatabase(path) { const restored = createSyncService({ databasePath: path, mediaDirectory }); restored.close() },
  })
  const authenticatedDevice = (accessToken: string) => database.prepare('SELECT devices.id FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.hash = ? AND devices.revoked_at IS NULL').get(hash(accessToken)) as { id: string } | undefined
  let collectionQueue: Promise<void> = Promise.resolve()
  function withCollectionLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = collectionQueue
    let release!: () => void
    collectionQueue = new Promise<void>((resolve) => { release = resolve })
    return (async () => {
      await previous
      try { return await operation() }
      finally { release() }
    })()
  }

  const assertCapabilities = (request: SyncRequest, currentCollectionSchemaVersion: number) => {
    if (request.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      throw compatibilityError('protocol-upgrade-required', 'This PC sync service and this device use incompatible sync protocols. Update both, then try again.')
    }
    assertCollectionGeneration(request.collectionGeneration)
    if (!Number.isSafeInteger(request.collectionSchemaVersion) || request.collectionSchemaVersion < 1) {
      throw compatibilityError('client-upgrade-required', 'This device did not declare a supported collection schema. Update Kiroku on this device, then try again.', { requiredSchemaVersion: currentCollectionSchemaVersion })
    }
    if (request.collectionSchemaVersion > SERVER_MAX_COLLECTION_SCHEMA_VERSION) {
      throw compatibilityError('server-upgrade-required', `This PC sync service supports collection schemas through ${SERVER_MAX_COLLECTION_SCHEMA_VERSION}. Update the PC service, then try again.`, { maximumSchemaVersion: SERVER_MAX_COLLECTION_SCHEMA_VERSION })
    }
    if (request.collectionSchemaVersion < currentCollectionSchemaVersion) {
      throw compatibilityError('client-upgrade-required', `This collection requires schema ${currentCollectionSchemaVersion}; this device declares schema ${request.collectionSchemaVersion}. Update Kiroku on this device, then try again.`, { requiredSchemaVersion: currentCollectionSchemaVersion })
    }
    const requestedSchema = request.operations.reduce((maximum, operation) => Math.max(maximum, schemaRequiredByOperation(operation)), 1)
    if (requestedSchema > SERVER_MAX_COLLECTION_SCHEMA_VERSION) {
      throw compatibilityError('server-upgrade-required', `This change requires collection schema ${requestedSchema}, but this PC sync service supports schemas through ${SERVER_MAX_COLLECTION_SCHEMA_VERSION}. Update the PC service, then try again.`, { requiredSchemaVersion: requestedSchema, maximumSchemaVersion: SERVER_MAX_COLLECTION_SCHEMA_VERSION })
    }
    if (requestedSchema > request.collectionSchemaVersion) {
      throw compatibilityError('client-upgrade-required', `This request contains schema ${requestedSchema} data but declares schema ${request.collectionSchemaVersion}. Update Kiroku on this device, then try again.`, { requiredSchemaVersion: requestedSchema })
    }
    return Math.max(currentCollectionSchemaVersion, request.collectionSchemaVersion, requestedSchema)
  }

  const assertCollectionGeneration = (generation?: string) => {
    const current = getCollectionGeneration(database)
    if ((requiresCollectionGeneration(database) || generation !== undefined) && generation !== current) throw compatibilityError('collection-generation-required', 'The PC collection was replaced from a backup. This device was not changed; export its offline collection and recover or reset it explicitly before syncing.', { collectionGeneration: current })
  }

  const issueDeviceCredential = (deviceId: string, code?: string, now = new Date()) => {
    const issuedToken = token()
    database.exec('BEGIN IMMEDIATE')
    try {
      if (code) database.prepare('UPDATE pairing_codes SET consumed_at = ? WHERE hash = ? AND consumed_at IS NULL').run(now.toISOString(), hash(code))
      database.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(deviceId)
      database.prepare('INSERT INTO tokens (hash, device_id) VALUES (?, ?)').run(hash(issuedToken), deviceId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return { deviceId, token: issuedToken, collectionGeneration: getCollectionGeneration(database) }
  }

  const service = {
    authenticateDevice(accessToken: string) {
      return Boolean(authenticatedDevice(accessToken))
    },

    health() {
      return { ready: true, schemaVersion: 1, build: readBuildIdentity(), protocolVersion: SYNC_PROTOCOL_VERSION, collectionSchemaVersion, maximumCollectionSchemaVersion: SERVER_MAX_COLLECTION_SCHEMA_VERSION, collectionGeneration: getCollectionGeneration(database), requiresCollectionGeneration: requiresCollectionGeneration(database), store: 'sqlite' as const } satisfies SyncHealth & { schemaVersion: number }
    },

    createPairingCode(now = new Date()) {
      const code = token().slice(0, 12)
      database.prepare('INSERT INTO pairing_codes (hash, expires_at) VALUES (?, ?)').run(hash(code), new Date(now.getTime() + 10 * 60_000).toISOString())
      return code
    },

    async createBackup(accessToken: string) {
      if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
      return withCollectionLock(() => backups.create('manual'))
    },

    async listBackups(accessToken: string) {
      if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
      return backups.list()
    },

    async downloadBackup(accessToken: string, backupId: string) {
      if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
      return backups.download(backupId)
    },

    async previewBackupRestore(accessToken: string, backupId: string) {
      if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
      return backups.previewRestore(backupId)
    },

    async restoreBackup(accessToken: string, backupId: string, confirmation: string) {
      if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
      if (confirmation !== 'RESTORE') throw new Error('Type RESTORE to replace the active PC collection from this backup.')
      return withCollectionLock(async () => {
        if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
        const result = await backups.restore(backupId)
        collectionSchemaVersion = persistedCollectionSchemaVersion()
        return result
      })
    },

    async syncWithBackup(accessToken: string, request: SyncRequest) {
      return withCollectionLock(async () => {
        if (!authenticatedDevice(accessToken)) throw new Error('Authentication required.')
        if (request.operations.length) {
          try { await backups.create('before-sync') }
          catch (error) { throw new SyncBackupError(error) }
        }
        return this.sync(accessToken, request)
      })
    },

    listDevices() {
      const rows = database.prepare('SELECT id, revoked_at FROM devices ORDER BY id').all() as Array<{ id: string; revoked_at: string | null }>
      return rows.map(({ id, revoked_at }) => ({ id, status: revoked_at === null ? 'active' as const : 'revoked' as const }))
    },

    revokeDevice(deviceId: string, now = new Date()) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const device = database.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId) as { id: string } | undefined
        if (!device) throw new Error('Device was not found.')
        database.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now.toISOString(), deviceId)
        database.prepare('DELETE FROM tokens WHERE device_id = ?').run(deviceId)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return { deviceId, status: 'revoked' as const }
    },

    pair({ code, deviceId }: PairRequest, now = new Date()) {
      const pairing = database.prepare('SELECT expires_at, consumed_at FROM pairing_codes WHERE hash = ?').get(hash(code)) as { expires_at: string; consumed_at: string | null } | undefined
      if (!pairing || pairing.consumed_at || pairing.expires_at <= now.toISOString()) throw new Error('Pairing code is invalid or expired.')
      return issueDeviceCredential(deviceId, code, now)
    },

    connectTrustedDevice(deviceId: string) {
      const device = database.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId) as { revoked_at: string | null } | undefined
      if (device?.revoked_at) throw new Error('Authentication required.')
      return issueDeviceCredential(deviceId)
    },

    rotateCredential(accessToken: string) {
      const issuedToken = token()
      database.exec('BEGIN IMMEDIATE')
      try {
        const device = database.prepare('SELECT devices.id FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.hash = ? AND devices.revoked_at IS NULL').get(hash(accessToken)) as { id: string } | undefined
        if (!device) throw new Error('Authentication required.')
        database.prepare('DELETE FROM tokens WHERE device_id = ?').run(device.id)
        database.prepare('INSERT INTO tokens (hash, device_id) VALUES (?, ?)').run(hash(issuedToken), device.id)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return { token: issuedToken }
    },

    sync(accessToken: string, request: SyncRequest) {
      const device = authenticatedDevice(accessToken)
      if (!device) throw new Error('Authentication required.')
      let accepted = 0
      database.exec('BEGIN IMMEDIATE')
      try {
        // BEGIN IMMEDIATE serializes the watermark check with insertion. A
        // second service cannot ratchet the collection between this read and
        // the first accepted operation.
        const currentWatermark = persistedCollectionSchemaVersion()
        const nextWatermark = assertCapabilities(request, currentWatermark)
        validateRevisionParents(request.operations, database)
        for (const operation of request.operations) validateLifetimeMetadata(operation as EntityLifetimeOperation)
        if (request.operations.some(operation => operation.action === 'restore')) {
          const retained = database.prepare('SELECT op_id, entity_type, entity_id, action, payload, parents, lifetime, related_lifetimes, restore_of FROM changes').all() as Array<PersistedChange & { op_id: string; entity_id: string }>
          const evidence = [...retained.map(row => ({ opId: row.op_id, entityType: row.entity_type, entityId: row.entity_id, action: row.action, payload: JSON.parse(row.payload), parents: row.parents !== null ? JSON.parse(row.parents) : undefined, lifetime: row.lifetime !== null ? JSON.parse(row.lifetime) : undefined, relatedLifetimes: row.related_lifetimes !== null ? JSON.parse(row.related_lifetimes) : undefined, restoreOf: row.restore_of !== null ? JSON.parse(row.restore_of) : undefined })), ...request.operations] as EntityLifetimeOperation[]
          for (const operation of request.operations.filter(operation => operation.action === 'restore')) {
            if (!Array.isArray(operation.restoreOf) || !operation.restoreOf.length || !Array.isArray(operation.lifetime) || !Array.isArray(operation.relatedLifetimes)) throw new Error('Restoration requires deletion provenance and original lifetime references.')
            if (JSON.stringify(operation.lifetime) !== JSON.stringify(restoredLifetime(operation.restoreOf))) throw new Error('Restoration lifetime does not match its deletion provenance.')
            validateRestorationEvidence(operation as EntityLifetimeOperation, operation.restoreOf, evidence)
          }
        }
        const insert = database.prepare('INSERT OR IGNORE INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload, parents, review_id, lifetime, related_lifetimes, restore_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const operation of request.operations) {
          const previous = database.prepare('SELECT entity_type, entity_id, action, occurred_at, payload, parents, review_id, lifetime, related_lifetimes, restore_of FROM changes WHERE op_id = ?').get(operation.opId) as { entity_type: string; entity_id: string; action: string; occurred_at: string; payload: string; parents: string | null; review_id: string | null; lifetime: string | null; related_lifetimes: string | null; restore_of: string | null } | undefined
          if (previous && (previous.entity_type !== operation.entityType || previous.entity_id !== operation.entityId || previous.action !== operation.action || previous.occurred_at !== operation.occurredAt || previous.payload !== JSON.stringify(operation.payload) || previous.parents !== (operation.parents ? JSON.stringify(operation.parents) : null) || previous.review_id !== (operation.reviewId ?? null) || previous.lifetime !== (operation.lifetime !== undefined ? JSON.stringify(operation.lifetime) : null) || previous.related_lifetimes !== (operation.relatedLifetimes !== undefined ? JSON.stringify(operation.relatedLifetimes) : null) || previous.restore_of !== (operation.restoreOf !== undefined ? JSON.stringify(operation.restoreOf) : null))) throw new Error('Sync operation identity was reused with different content')
          const result = insert.run(operation.opId, device.id, operation.entityType, operation.entityId, operation.action, operation.occurredAt, JSON.stringify(operation.payload), operation.parents ? JSON.stringify(operation.parents) : null, operation.reviewId ?? null, operation.lifetime !== undefined ? JSON.stringify(operation.lifetime) : null, operation.relatedLifetimes !== undefined ? JSON.stringify(operation.relatedLifetimes) : null, operation.restoreOf !== undefined ? JSON.stringify(operation.restoreOf) : null)
          accepted += Number(result.changes)
        }
        if (nextWatermark > currentWatermark) {
          database.prepare("INSERT INTO collection_metadata (key, value) VALUES ('collection_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(nextWatermark))
        }
        database.exec('COMMIT')
        collectionSchemaVersion = Math.max(collectionSchemaVersion, nextWatermark)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      const rows = database.prepare('SELECT cursor, op_id, device_id, entity_type, entity_id, action, occurred_at, payload, parents, review_id, lifetime, related_lifetimes, restore_of FROM changes WHERE cursor > ? ORDER BY cursor LIMIT ?').all(request.cursor, SYNC_CHANGE_PAGE_SIZE + 1) as Array<{ cursor: number; op_id: string; device_id: string; entity_type: string; entity_id: string; action: string; occurred_at: string; payload: string; parents: string | null; review_id: string | null; lifetime: string | null; related_lifetimes: string | null; restore_of: string | null }>
      const hasMore = rows.length > SYNC_CHANGE_PAGE_SIZE
      const changes = hasMore ? rows.slice(0, SYNC_CHANGE_PAGE_SIZE) : rows
      const cursor = changes.at(-1)?.cursor ?? request.cursor
      return {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        collectionSchemaVersion,
        collectionGeneration: getCollectionGeneration(database),
        accepted,
        cursor,
        hasMore,
        changes: changes.map((change) => ({
          cursor: change.cursor,
          opId: change.op_id,
          deviceId: change.device_id,
          entityType: change.entity_type,
          entityId: change.entity_id,
          action: change.action,
          occurredAt: change.occurred_at,
          payload: JSON.parse(change.payload) as unknown,
          ...(change.parents !== null ? { parents: JSON.parse(change.parents) as string[] } : {}),
          ...(change.review_id !== null ? { reviewId: change.review_id } : {}),
          ...(change.lifetime !== null ? { lifetime: JSON.parse(change.lifetime) } : {}),
          ...(change.related_lifetimes !== null ? { relatedLifetimes: JSON.parse(change.related_lifetimes) } : {}),
          ...(change.restore_of !== null ? { restoreOf: JSON.parse(change.restore_of) } : {}),
        })),
      }
    },

    reviewCount() {
      return Number((database.prepare("SELECT COUNT(*) AS count FROM changes WHERE entity_type = 'review'").get() as { count: number }).count)
    },

    changeCount() {
      return Number((database.prepare('SELECT COUNT(*) AS count FROM changes').get() as { count: number }).count)
    },

    async putMedia(accessToken: string, digest: string, mimeType: string, bytes: Uint8Array, generation?: string) {
      return withCollectionLock(async () => {
      const device = database.prepare('SELECT devices.id FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.hash = ? AND devices.revoked_at IS NULL').get(hash(accessToken))
      if (!device) throw new Error('Authentication required.')
      assertCollectionGeneration(generation)
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Media digest is invalid.')
      if (!isSupportedMediaType(mimeType)) throw new Error('Media type is unsupported.')
      if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Media size is invalid.')
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Media digest does not match its bytes.')
      await mkdir(join(mediaDirectory, digest.slice(0, 2)), { recursive: true })
      await writeFile(join(mediaDirectory, digest.slice(0, 2), digest), bytes)
      const result = database.prepare('INSERT OR IGNORE INTO media_blobs (digest, byte_length, mime_type, created_at) VALUES (?, ?, ?, ?)').run(digest, bytes.byteLength, mimeType, new Date().toISOString())
      const metadata = database.prepare('SELECT byte_length, mime_type FROM media_blobs WHERE digest = ?').get(digest) as { byte_length: number; mime_type: string }
      return { digest, byteLength: metadata.byte_length, mimeType: metadata.mime_type, deduplicated: !Number(result.changes) }
      })
    },

    async getMedia(accessToken: string, digest: string, generation?: string) {
      return withCollectionLock(async () => {
      const device = database.prepare('SELECT devices.id FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.hash = ? AND devices.revoked_at IS NULL').get(hash(accessToken))
      if (!device) throw new Error('Authentication required.')
      assertCollectionGeneration(generation)
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Media digest is invalid.')
      const metadata = database.prepare('SELECT byte_length, mime_type FROM media_blobs WHERE digest = ?').get(digest) as { byte_length: number; mime_type: string } | undefined
      if (!metadata) throw new Error('Media not found.')
      const bytes = await readFile(join(mediaDirectory, digest.slice(0, 2), digest))
      if (bytes.byteLength !== metadata.byte_length || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Media bytes failed verification.')
      return { digest, byteLength: metadata.byte_length, mimeType: metadata.mime_type, bytes }
      })
    },

    close() { database.close() },
  }
  return service
}
