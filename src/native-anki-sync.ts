import type { Database, SqlJsStatic, SqlValue } from 'sql.js'

/** Transport receives a relative official protocol route; account secrets are
 * inside the wire body, never diagnostics or the durable collection snapshot. */
export type NativeAnkiTransport = (route: string, body: FormData, hostNumber: number) => Promise<Response>
export interface NativeSyncMeta { mod: number; scm: number; usn: number; ts: number; cont: boolean; empty: boolean; hostNum: number; msg: string }
export class NativeSyncError extends Error {
  constructor(public readonly code: 'authentication' | 'protocol' | 'upgrade' | 'transfer' | 'conflict', message: string) { super(message); this.name = 'NativeSyncError' }
}
export class NativeSyncConflict extends NativeSyncError {
  constructor(public readonly table: 'notes' | 'cards' | 'revlog', public readonly identity: number, public readonly local: Row, public readonly remote: Row | null) {
    super('conflict', 'Both local and account changes require resolution. Keep both versions before retrying synchronization.')
  }
}
type Row = SqlValue[]
interface Chunk { cards: Row[]; notes: Row[]; revlog: Row[]; done: boolean }
interface Graves { cards: number[]; notes: number[]; decks: number[] }
type NativeObject = Record<string, unknown>
interface Changes { models: NativeObject[]; decks: [NativeObject[], NativeObject[]]; tags: string[]; conf?: NativeObject; crt?: number }
const columns = {
  cards: ['id', 'nid', 'did', 'ord', 'mod', 'usn', 'type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odue', 'odid', 'flags', 'data'],
  notes: ['id', 'guid', 'mid', 'mod', 'usn', 'tags', 'flds', 'sfld', 'csum', 'flags', 'data'],
  revlog: ['id', 'cid', 'usn', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type'],
} as const
const objectColumns = ['models', 'decks', 'dconf'] as const
const cap = 64 * 1024 * 1024
const chunkLimit = 250
const protocolError = () => new NativeSyncError('protocol', 'The Anki sync response is incompatible or incomplete. No local checkpoint was committed.')
const isObject = (value: unknown): value is NativeObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw protocolError(); return value }
function scalar(db: Database, sql: string): number { return Number(db.exec(sql)[0]?.values[0]?.[0]) }
function jsonColumn(db: Database, column: string): NativeObject {
  const value: unknown = JSON.parse(String(db.exec(`SELECT ${column} FROM col`)[0]?.values[0]?.[0]))
  if (!isObject(value)) throw protocolError()
  return value
}
function setJson(db: Database, column: string, value: NativeObject) { db.run(`UPDATE col SET ${column}=?`, [JSON.stringify(value)]) }
function validateDatabase(db: Database) {
  if (scalar(db, 'SELECT count(*) FROM col') !== 1 || scalar(db, 'SELECT ver FROM col') !== 11) throw new NativeSyncError('upgrade', 'Native incremental sync currently requires Anki protocol 10 collection format. Keep this collection and update the app before syncing.')
  for (const [table, names] of Object.entries(columns)) db.exec(`SELECT ${names.join(',')} FROM ${table} LIMIT 1`)
}
function parseGraves(value: unknown): Graves {
  if (!isObject(value)) throw protocolError()
  const result: Graves = { cards: [], notes: [], decks: [] }
  for (const key of ['cards', 'notes', 'decks'] as const) {
    const ids = value[key]
    if (!Array.isArray(ids) || ids.length > 100_000) throw protocolError()
    result[key] = ids.map(integer)
  }
  return result
}
function parseChunk(value: unknown): Chunk {
  if (!isObject(value) || typeof value.done !== 'boolean') throw protocolError()
  const result: Chunk = { cards: [], notes: [], revlog: [], done: value.done }
  for (const table of ['cards', 'notes', 'revlog'] as const) {
    const rows = value[table] ?? []
    if (!Array.isArray(rows) || rows.length > chunkLimit) throw protocolError()
    result[table] = rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns[table].length || row.some((cell) => cell !== null && typeof cell !== 'number' && typeof cell !== 'string')) throw protocolError()
      integer(row[0]); return row as Row
    })
  }
  return result
}
function parseChanges(value: unknown): Changes {
  if (!isObject(value) || !Array.isArray(value.models) || !Array.isArray(value.decks) || value.decks.length !== 2 || !Array.isArray(value.tags)) throw protocolError()
  const objects = (items: unknown): NativeObject[] => {
    if (!Array.isArray(items) || !items.every(isObject)) throw protocolError()
    for (const item of items) integer(item.id)
    return items
  }
  if (!value.tags.every((tag) => typeof tag === 'string')) throw protocolError()
  if (value.conf !== undefined && !isObject(value.conf)) throw protocolError()
  return { models: objects(value.models), decks: [objects(value.decks[0]), objects(value.decks[1])], tags: value.tags, ...(value.conf ? { conf: value.conf as NativeObject } : {}), ...(value.crt !== undefined ? { crt: integer(value.crt) } : {}) }
}
function pendingObjects(db: Database, column: string) { return Object.values(jsonColumn(db, column)).filter((value): value is NativeObject => isObject(value) && value.usn === -1) }
function mergeObjects(db: Database, column: string, values: NativeObject[], usn: number) {
  const local = jsonColumn(db, column)
  for (const incoming of values) {
    const id = String(integer(incoming.id)), existing = local[id]
    if (!isObject(existing) || Number(incoming.mod) >= Number(existing.mod)) local[id] = { ...incoming, usn }
  }
  setJson(db, column, local)
}
function applyGraves(db: Database, graves: Graves, usn: number) {
  for (const table of ['cards', 'notes'] as const) for (const id of graves[table]) {
    const row = db.exec(`SELECT ${columns[table].join(',')} FROM ${table} WHERE id=? AND usn=-1`, [id])[0]?.values[0]
    if (row) throw new NativeSyncConflict(table, id, row, null)
  }
  // Native Anki retains review history after deletion. Cards and notes each
  // have their own tombstones; applying one must not invent another deletion.
  for (const id of graves.cards) { db.run('DELETE FROM cards WHERE id=?', [id]); db.run('INSERT INTO graves(usn,oid,type) VALUES(?,?,0)', [usn, id]) }
  for (const id of graves.notes) { db.run('DELETE FROM notes WHERE id=?', [id]); db.run('INSERT INTO graves(usn,oid,type) VALUES(?,?,1)', [usn, id]) }
  const decks = jsonColumn(db, 'decks')
  for (const id of graves.decks) { delete decks[String(id)]; db.run('INSERT INTO graves(usn,oid,type) VALUES(?,?,2)', [usn, id]) }
  setJson(db, 'decks', decks)
}
function insertChunk(db: Database, chunk: Chunk, usn: number) {
  for (const table of ['revlog', 'notes', 'cards'] as const) {
    const usnIndex = columns[table].indexOf('usn' as never)
    const modIndex = table === 'notes' ? 3 : 4
    for (const row of chunk[table]) {
      const existing = db.exec(`SELECT ${columns[table].join(',')} FROM ${table} WHERE id=?`, [row[0]])[0]?.values[0]
      // Retain divergent dirty notes rather than silently replacing offline work.
      if (existing && table === 'notes' && existing[usnIndex] === -1 && existing.some((cell, index) => ![usnIndex, modIndex, 7, 8].includes(index) && cell !== row[index])) throw new NativeSyncConflict(table, Number(row[0]), existing, row)
      if (existing && table !== 'revlog' && existing[usnIndex] === -1 && Number(existing[modIndex]) > Number(row[modIndex])) continue
      if (existing && table === 'revlog') {
        if (existing.some((cell, index) => index !== usnIndex && cell !== row[index])) throw new NativeSyncConflict(table, Number(row[0]), existing, row)
        continue
      }
      const values = [...row]; values[usnIndex] = usn
      // Protocol note rows omit derived search caches. Preserve a cache only
      // when its original fields are unchanged. Rebuilding caches for changed
      // fields remains required before this engine can back the account UI.
      if (table === 'notes' && existing && existing[6] === row[6]) { values[7] = existing[7]; values[8] = existing[8] }
      db.run(`INSERT OR REPLACE INTO ${table}(${columns[table].join(',')}) VALUES(${values.map(() => '?').join(',')})`, values)
    }
  }
}
function sanityCounts(db: Database) {
  return [[scalar(db, 'SELECT count(*) FROM cards WHERE queue=0'), scalar(db, 'SELECT count(*) FROM cards WHERE queue IN(1,3)'), scalar(db, 'SELECT count(*) FROM cards WHERE queue=2')],
    ...['cards', 'notes', 'revlog', 'graves'].map((table) => scalar(db, `SELECT count(*) FROM ${table}`)), ...objectColumns.map((column) => Object.keys(jsonColumn(db, column)).length)]
}

/** Works on a private SQLite copy. Callers persist the result atomically only
 * after success; exceptions never mutate the supplied durable snapshot. */
export class NativeAnkiClient {
  #key: string
  #hostNumber = 0
  private constructor(private readonly transport: NativeAnkiTransport, key: string) { this.#key = key }
  static async login(transport: NativeAnkiTransport, username: string, password: string) {
    const client = new NativeAnkiClient(transport, '')
    const value = await client.json('sync/hostKey', { u: username, p: password })
    if (!isObject(value) || typeof value.key !== 'string' || !value.key) throw protocolError()
    client.#key = value.key
    return client
  }
  private async request(route: string, data: unknown, session?: string): Promise<Uint8Array> {
    const form = new FormData()
    form.append('data', JSON.stringify(data)); form.append('c', '0')
    if (this.#key) form.append('k', this.#key)
    if (session) form.append('s', session)
    const response = await this.transport(route, form, this.#hostNumber)
    if (response.status === 401 || response.status === 403) throw new NativeSyncError('authentication', 'Anki account authentication expired or was rejected. Sign in again; the local collection is unchanged.')
    if (!response.ok) throw new NativeSyncError('transfer', `Anki account transfer failed (HTTP ${response.status}). Retry without discarding local work.`)
    if (Number(response.headers.get('content-length')) > cap) throw new NativeSyncError('transfer', 'The Anki account response exceeds the 64 MiB transfer limit.')
    const reader = response.body?.getReader()
    if (!reader) throw protocolError()
    const parts: Uint8Array[] = []; let total = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > cap) throw new NativeSyncError('transfer', 'The Anki account response exceeds the 64 MiB transfer limit.')
        parts.push(chunk.value)
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error }
    const bytes = new Uint8Array(total); let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    return bytes
  }
  private async json(route: string, data: unknown, session?: string): Promise<unknown> {
    const bytes = await this.request(route, data, session)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw protocolError() }
  }
  async metadata(): Promise<NativeSyncMeta> {
    const value = await this.json('sync/meta', { v: 10, cv: 'kiroku,0.1,web' })
    if (!isObject(value) || typeof value.cont !== 'boolean' || typeof value.empty !== 'boolean') throw protocolError()
    const meta = { mod: integer(value.mod), scm: integer(value.scm), usn: integer(value.usn), ts: integer(value.ts), cont: value.cont, empty: value.empty, hostNum: integer(value.hostNum ?? 0), msg: typeof value.msg === 'string' ? value.msg.slice(0, 1000) : '' }
    if (meta.usn < 0 || meta.hostNum < 0) throw protocolError()
    this.#hostNumber = meta.hostNum
    if (!meta.cont) throw new NativeSyncError('upgrade', 'AnkiWeb requested that synchronization stop. Update the app before retrying; local work is preserved.')
    return meta
  }
  async downloadCollection(SQL: SqlJsStatic): Promise<Uint8Array> {
    const meta = await this.metadata()
    const bytes = await this.request('sync/download', {})
    if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw protocolError()
    const db = new SQL.Database(bytes)
    try {
      validateDatabase(db)
      const after = await this.metadata()
      // The official full download itself advances the server mod/usn. Check
      // the delivered snapshot against metadata obtained after that operation.
      if (scalar(db, 'SELECT scm FROM col') !== meta.scm || after.scm !== meta.scm || scalar(db, 'SELECT mod FROM col') !== after.mod || scalar(db, 'SELECT usn FROM col') !== after.usn) throw new NativeSyncError('transfer', 'The account changed during download. Retry before replacing local data.')
      db.run('UPDATE col SET ls=?', [after.mod])
      return db.export()
    } finally { db.close() }
  }
  async syncCollection(SQL: SqlJsStatic, snapshot: Uint8Array): Promise<{ outcome: 'synced' | 'unchanged'; collection: Uint8Array } | { outcome: 'full-sync-required'; localEmpty: boolean; remoteEmpty: boolean }> {
    const db = new SQL.Database(snapshot)
    let session: string | undefined
    try {
      validateDatabase(db)
      const remote = await this.metadata()
      const localMod = scalar(db, 'SELECT mod FROM col'), localUsn = scalar(db, 'SELECT usn FROM col')
      const localEmpty = scalar(db, 'SELECT count(*) FROM cards') === 0
      if (scalar(db, 'SELECT scm FROM col') !== remote.scm) return { outcome: 'full-sync-required', localEmpty, remoteEmpty: remote.empty }
      if (Math.abs(Date.now() / 1000 - remote.ts) > 300) throw new NativeSyncError('protocol', 'Device and Anki sync clocks differ by more than five minutes. Correct the clock before syncing.')
      const pending = { cards: db.exec('SELECT oid FROM graves WHERE usn=-1 AND type=0')[0]?.values.flat().map(Number) ?? [], notes: db.exec('SELECT oid FROM graves WHERE usn=-1 AND type=1')[0]?.values.flat().map(Number) ?? [], decks: db.exec('SELECT oid FROM graves WHERE usn=-1 AND type=2')[0]?.values.flat().map(Number) ?? [] }
      const tables = { cards: db.exec(`SELECT ${columns.cards.join(',')} FROM cards WHERE usn=-1 ORDER BY id`)[0]?.values ?? [], notes: db.exec(`SELECT ${columns.notes.join(',')} FROM notes WHERE usn=-1 ORDER BY id`)[0]?.values ?? [], revlog: db.exec(`SELECT ${columns.revlog.join(',')} FROM revlog WHERE usn=-1 ORDER BY id`)[0]?.values ?? [] }
      const newer = localMod > remote.mod
      const localChanges: Changes = { models: pendingObjects(db, 'models'), decks: [pendingObjects(db, 'decks'), pendingObjects(db, 'dconf')], tags: Object.entries(jsonColumn(db, 'tags')).filter(([, usn]) => usn === -1).map(([tag]) => tag), ...(newer ? { conf: jsonColumn(db, 'conf'), crt: scalar(db, 'SELECT crt FROM col') } : {}) }
      if (localMod === remote.mod && Object.values(tables).every((rows) => !rows.length) && Object.values(pending).every((ids) => !ids.length) && !localChanges.models.length && localChanges.decks.every((list) => !list.length) && !localChanges.tags.length) return { outcome: 'unchanged', collection: snapshot }
      session = crypto.randomUUID().replaceAll('-', '')
      const graves = parseGraves(await this.json('sync/start', { minUsn: localUsn, lnewer: newer }, session))
      applyGraves(db, graves, remote.usn)
      for (let at = 0; at < Math.max(1, ...Object.values(pending).map((ids) => ids.length)); at += 1000) await this.json('sync/applyGraves', { chunk: { cards: pending.cards.slice(at, at + 1000), notes: pending.notes.slice(at, at + 1000), decks: pending.decks.slice(at, at + 1000) } }, session)
      const wireChanges = { ...localChanges, models: localChanges.models.map((value) => ({ ...value, usn: remote.usn })), decks: localChanges.decks.map((list) => list.map((value) => ({ ...value, usn: remote.usn }))) }
      const changes = parseChanges(await this.json('sync/applyChanges', { changes: wireChanges }, session))
      mergeObjects(db, 'models', changes.models, remote.usn); mergeObjects(db, 'decks', changes.decks[0], remote.usn); mergeObjects(db, 'dconf', changes.decks[1], remote.usn)
      const tags = jsonColumn(db, 'tags'); for (const tag of changes.tags) Object.defineProperty(tags, tag, { value: remote.usn, enumerable: true, configurable: true, writable: true }); setJson(db, 'tags', tags)
      if (changes.conf) setJson(db, 'conf', changes.conf)
      if (changes.crt !== undefined) db.run('UPDATE col SET crt=?', [changes.crt])
      for (let count = 0;; count++) {
        if (count >= 4000) throw new NativeSyncError('transfer', 'The account has too many changes for this sync. Keep local work and use the recovery flow.')
        const chunk = parseChunk(await this.json('sync/chunk', {}, session)); insertChunk(db, chunk, remote.usn)
        if (chunk.done) break
      }
      for (const table of ['revlog', 'notes', 'cards'] as const) for (let at = 0; at < tables[table].length; at += chunkLimit) {
        const liveRows = tables[table].slice(at, at + chunkLimit).flatMap((row) => db.exec(`SELECT ${columns[table].join(',')} FROM ${table} WHERE id=? AND usn=-1`, [row[0]])[0]?.values ?? [])
        const chunk = { cards: [], notes: [], revlog: [], [table]: liveRows.map((row) => row.map((cell, index) => index === columns[table].indexOf('usn' as never) ? remote.usn : table === 'notes' && (index === 7 || index === 8) ? '' : cell)) }
        await this.json('sync/applyChunk', { chunk }, session)
      }
      const sanity = await this.json('sync/sanityCheck2', { client: sanityCounts(db) }, session)
      if (!isObject(sanity) || sanity.status !== 'ok') throw protocolError()
      const mod = integer(await this.json('sync/finish', {}, session)); session = undefined
      for (const table of ['cards', 'notes', 'revlog', 'graves']) db.run(`UPDATE ${table} SET usn=? WHERE usn=-1`, [remote.usn])
      for (const column of objectColumns) { const values = jsonColumn(db, column); for (const value of Object.values(values)) if (isObject(value) && value.usn === -1) value.usn = remote.usn; setJson(db, column, values) }
      const allTags = jsonColumn(db, 'tags'); for (const [tag, usn] of Object.entries(allTags)) if (usn === -1) allTags[tag] = remote.usn; setJson(db, 'tags', allTags)
      // Official finish increments the server revision. The next client cursor
      // must use that incremented value, rather than replaying its own batch.
      db.run('UPDATE col SET usn=?, mod=?, ls=?', [remote.usn + 1, mod, mod])
      return { outcome: 'synced', collection: db.export() }
    } finally {
      if (session) await this.json('sync/abort', {}, session).catch(() => undefined)
      db.close()
    }
  }
}




