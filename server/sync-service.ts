import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

type ServiceOptions = { databasePath: string }
type PairRequest = { code: string; deviceId: string }
type SyncOperation = {
  opId: string
  entityType: string
  entityId: string
  action: string
  occurredAt: string
  payload: unknown
}
type SyncRequest = { cursor: number; operations: SyncOperation[] }

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('hex')

export function createSyncService({ databasePath }: ServiceOptions) {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true })
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS pairing_codes (hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, FOREIGN KEY(device_id) REFERENCES devices(id));
    CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
  `)

  const service = {
    health() {
      return { ready: true, schemaVersion: 1, store: 'sqlite' as const }
    },

    createPairingCode(now = new Date()) {
      const code = token().slice(0, 12)
      database.prepare('INSERT INTO pairing_codes (hash, expires_at) VALUES (?, ?)').run(hash(code), new Date(now.getTime() + 10 * 60_000).toISOString())
      return code
    },

    pair({ code, deviceId }: PairRequest, now = new Date()) {
      const pairing = database.prepare('SELECT expires_at, consumed_at FROM pairing_codes WHERE hash = ?').get(hash(code)) as { expires_at: string; consumed_at: string | null } | undefined
      if (!pairing || pairing.consumed_at || pairing.expires_at <= now.toISOString()) throw new Error('Pairing code is invalid or expired.')
      const issuedToken = token()
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare('UPDATE pairing_codes SET consumed_at = ? WHERE hash = ? AND consumed_at IS NULL').run(now.toISOString(), hash(code))
        database.prepare('INSERT OR IGNORE INTO devices (id) VALUES (?)').run(deviceId)
        database.prepare('INSERT INTO tokens (hash, device_id) VALUES (?, ?)').run(hash(issuedToken), deviceId)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return { deviceId, token: issuedToken }
    },

    sync(accessToken: string, request: SyncRequest) {
      const device = database.prepare('SELECT devices.id FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.hash = ? AND devices.revoked_at IS NULL').get(hash(accessToken)) as { id: string } | undefined
      if (!device) throw new Error('Authentication required.')
      let accepted = 0
      database.exec('BEGIN IMMEDIATE')
      try {
        const insert = database.prepare('INSERT OR IGNORE INTO changes (op_id, device_id, entity_type, entity_id, action, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
        for (const operation of request.operations) {
          const result = insert.run(operation.opId, device.id, operation.entityType, operation.entityId, operation.action, operation.occurredAt, JSON.stringify(operation.payload))
          accepted += Number(result.changes)
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return { accepted }
    },

    reviewCount() {
      return Number((database.prepare("SELECT COUNT(*) AS count FROM changes WHERE entity_type = 'review'").get() as { count: number }).count)
    },

    close() { database.close() },
  }
  return service
}
