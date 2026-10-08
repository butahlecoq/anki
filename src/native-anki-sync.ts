import type { Database, SqlJsStatic, SqlValue } from 'sql.js'
import { rebuildNativeNoteCaches } from './native-anki-cache.js'

/** Transport receives a relative official protocol route; account secrets are
 * inside the wire body, never diagnostics or the durable collection snapshot. */
export interface NativeRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export type NativeAnkiTransport = (route: string, body: FormData, hostNumber: number, options: { signal: AbortSignal }) => Promise<Response>
export interface NativeSyncMeta { mod: number; scm: number; usn: number; ts: number; cont: boolean; empty: boolean; hostNum: number; msg: string }
export interface NativeFullSyncPreview { localHash: string; localNotes: number; localCards: number; remote: NativeSyncMeta }
export interface NativeFullSyncDecision extends NativeFullSyncPreview { direction: 'upload' | 'download'; localRevision: number }
export function sameRemoteRevision(left: NativeSyncMeta, right: NativeSyncMeta) { return left.mod === right.mod && left.scm === right.scm && left.usn === right.usn }
export async function nativeSnapshotHash(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
export class NativeSyncError extends Error {
  constructor(public readonly code: 'authentication' | 'service-authentication' | 'protocol' | 'upgrade' | 'unsupported' | 'transfer' | 'conflict' | 'cancelled' | 'timeout', message: string,
    public readonly requestFailure?: { route: string; status?: number; source: 'relay' | 'upstream' | 'unknown'; phase?: 'before-response' | 'response-body' | 'response-status' },
  ) { super(message); this.name = 'NativeSyncError' }
}
export class NativeSyncConflict extends NativeSyncError {
  constructor(public readonly table: 'notes' | 'cards' | 'revlog' | 'models' | 'decks' | 'dconf', public readonly identity: number, public readonly local: Row, public readonly remote: Row | null) {
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
  if (String(db.exec('PRAGMA quick_check')[0]?.values[0]?.[0]) !== 'ok') throw protocolError()
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
    if (isObject(existing) && existing.usn === -1) {
      const content = (value: NativeObject) => canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'mod')))
      if (JSON.stringify(content(existing)) !== JSON.stringify(content(incoming))) throw new NativeSyncConflict(column as 'models' | 'decks' | 'dconf', Number(id), [Number(id), JSON.stringify(existing)], [Number(id), JSON.stringify(incoming)])
    }
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
  for (const id of graves.decks) {
    const deck = decks[String(id)]
    if (isObject(deck) && deck.usn === -1) throw new NativeSyncConflict('decks', id, [id, JSON.stringify(deck)], null)
    delete decks[String(id)]; db.run('INSERT INTO graves(usn,oid,type) VALUES(?,?,2)', [usn, id])
  }
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
      if (existing && table === 'cards' && existing[usnIndex] === -1 && existing.some((cell, index) => ![usnIndex, modIndex].includes(index) && cell !== row[index])) throw new NativeSyncConflict(table, Number(row[0]), existing, row)
      if (existing && table !== 'revlog' && existing[usnIndex] === -1 && Number(existing[modIndex]) > Number(row[modIndex])) continue
      if (existing && table === 'revlog') {
        if (existing.some((cell, index) => index !== usnIndex && cell !== row[index])) throw new NativeSyncConflict(table, Number(row[0]), existing, row)
        continue
      }
      const values = [...row]; values[usnIndex] = usn
      // Protocol note rows omit derived search caches. Preserve a cache only
      // when its original fields are unchanged. Changed fields and note-type
      // sort configuration are rebuilt before returning the finished copy.
      if (table === 'notes' && existing && existing[6] === row[6]) { values[7] = existing[7]; values[8] = existing[8] }
      db.run(`INSERT OR REPLACE INTO ${table}(${columns[table].join(',')}) VALUES(${values.map(() => '?').join(',')})`, values)
    }
  }
}
function sanityCounts(db: Database) {
  return [[scalar(db, 'SELECT count(*) FROM cards WHERE queue=0'), scalar(db, 'SELECT count(*) FROM cards WHERE queue IN(1,3)'), scalar(db, 'SELECT count(*) FROM cards WHERE queue=2')],
    ...['cards', 'notes', 'revlog', 'graves'].map((table) => scalar(db, `SELECT count(*) FROM ${table}`)), ...objectColumns.map((column) => Object.keys(jsonColumn(db, column)).length)]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'usn').sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]))
}
export function nativeContentFingerprint(SQL: SqlJsStatic, snapshot: Uint8Array): string {
  const db = new SQL.Database(snapshot)
  try {
    validateDatabase(db)
    const result: NativeObject = {}
    for (const table of ['cards', 'notes', 'revlog'] as const) {
      const kept = columns[table].filter((column) => column !== 'usn' && !(table === 'notes' && (column === 'sfld' || column === 'csum')))
      result[table] = db.exec(`SELECT ${kept.join(',')} FROM ${table} ORDER BY id`)[0]?.values ?? []
    }
    for (const column of [...objectColumns, 'tags', 'conf']) result[column] = canonical(jsonColumn(db, column))
    result.crt = scalar(db, 'SELECT crt FROM col')
    return JSON.stringify(result)
  } finally { db.close() }
}
export async function prepareNativeUpload(SQL: SqlJsStatic, snapshot: Uint8Array): Promise<Uint8Array> {
  const db = new SQL.Database(snapshot)
  try {
    validateDatabase(db)
    await rebuildNativeNoteCaches(db)
    db.run('DELETE FROM graves')
    for (const table of ['cards', 'notes', 'revlog']) db.run(`UPDATE ${table} SET usn=0 WHERE usn=-1`)
    for (const column of objectColumns) {
      const objects = jsonColumn(db, column)
      for (const object of Object.values(objects)) if (isObject(object) && object.usn === -1) object.usn = 0
      setJson(db, column, objects)
    }
    const tags = jsonColumn(db, 'tags'); for (const key of Object.keys(tags)) tags[key] = 0; setJson(db, 'tags', tags)
    const changed = Math.max(Date.now(), scalar(db, 'SELECT scm FROM col') + 1, scalar(db, 'SELECT mod FROM col') + 1)
    db.run('UPDATE col SET usn=usn+1,scm=?,mod=?,ls=?', [changed, changed, changed])
    if (String(db.exec('PRAGMA quick_check')[0]?.values[0]?.[0]) !== 'ok') throw protocolError()
    return db.export()
  } finally { db.close() }
}

/** Works on a private SQLite copy. Callers persist the result atomically only
 * after success; exceptions never mutate the supplied durable snapshot. */
export class NativeAnkiClient {
  #key: string
  #hostNumber = 0
  private constructor(private readonly transport: NativeAnkiTransport, key: string) { this.#key = key }
  static async login(transport: NativeAnkiTransport, username: string, password: string, options: NativeRequestOptions = {}) {
    const client = new NativeAnkiClient(transport, '')
    const value = await client.json('sync/hostKey', { u: username, p: password }, undefined, options)
    if (isObject(value) && typeof value.err === 'string' && value.err) throw new NativeSyncError('authentication', 'AnkiWeb rejected the username or password. Check them and try again.')
    if (!isObject(value) || typeof value.key !== 'string' || !value.key) throw protocolError()
    client.#key = value.key
    return client
  }
  private async request(route: string, data: unknown, session?: string, options: NativeRequestOptions = {}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? 300_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new NativeSyncError('protocol', 'Native request deadlines must be between zero and five minutes.')
    const controller = new AbortController()
    const cancelled = () => controller.abort(new NativeSyncError('cancelled', 'Anki synchronization was cancelled. Keep the checkpoint and use recovery before retrying.'))
    if (options.signal?.aborted) cancelled()
    else options.signal?.addEventListener('abort', cancelled, { once: true })
    const timer = setTimeout(() => controller.abort(new NativeSyncError('timeout', 'Anki synchronization timed out. Keep the checkpoint and use recovery before retrying.')), timeoutMs)
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    void aborted.catch(() => undefined)
    const reject = () => rejectAbort(controller.signal.reason)
    controller.signal.addEventListener('abort', reject, { once: true })
    if (controller.signal.aborted) reject()
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, aborted])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      controller.signal.throwIfAborted()
      const form = new FormData()
      if (data instanceof Uint8Array) form.append('data', new Blob([data.slice().buffer]), 'data')
      else form.append('data', JSON.stringify(data))
      form.append('c', '0')
      if (this.#key) form.append('k', this.#key)
      if (session) form.append('s', session)
      let response: Response
      try { response = await wait(this.transport(route, form, this.#hostNumber, { signal: controller.signal })) }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof NativeSyncError) throw error
        throw new NativeSyncError('transfer', 'The PC service could not be reached or the browser blocked the request. Check that the PC service is running, the private network, and its trusted application origin setting, then retry. The browser did not provide a response, so the cause could not be confirmed. Your local work is preserved.', { route, source: 'unknown', phase: 'before-response' })
      }
      if (response.headers.get('x-kiroku-relay-error') === 'paired-authentication') throw new NativeSyncError('service-authentication', 'This device is no longer paired with the PC service. Reconnect it, then try again.')
      if (response.status === 403 && response.headers.get('x-kiroku-response-source') === 'relay' && response.headers.get('x-kiroku-relay-error') === 'origin-rejected') throw new NativeSyncError('transfer', 'The PC service rejected this app origin. Check its trusted application origin setting, then retry. Your local work is preserved.', { route, status: response.status, source: 'relay', phase: 'response-status' })
      if (!response.ok) {
        const origin = response.headers.get('x-kiroku-response-source')
        const source = origin === 'relay' || origin === 'upstream' ? origin : 'unknown'
        const failure = { route, status: response.status, source } as const
        if (source === 'upstream' && (response.status === 401 || response.status === 403)) throw new NativeSyncError('authentication', 'AnkiWeb rejected the account credentials. Check them and try again.', failure)
        const phase = route === 'sync/hostKey' ? 'sign-in' : route === 'sync/meta' ? 'collection check' : route === 'sync/download' ? 'collection download' : route.startsWith('msync/') ? 'media transfer' : 'collection synchronization'
        const service = source === 'relay' ? 'The PC relay' : source === 'upstream' ? 'AnkiWeb' : 'The account service'
        const action = source === 'relay' ? 'Check the PC service configuration and update the app and service together.' : source === 'unknown' && (response.status === 401 || response.status === 403) ? 'Check PC pairing and service configuration. The response source is unknown; update the app and PC service together.' : response.status === 400 ? 'Update the app and PC service together. If this continues, report these request details.' : 'Check connectivity and try again.'
        throw new NativeSyncError('transfer', `${service} rejected ${phase} (HTTP ${response.status}; ${route}). ${action} Your local work is preserved.`, failure)
      }
      if (Number(response.headers.get('content-length')) > cap) throw new NativeSyncError('transfer', 'The Anki account response exceeds the 64 MiB transfer limit.')
      const parts: Uint8Array[] = []; let total = 0
      try {
        reader = response.body?.getReader()
        if (!reader) throw protocolError()
        for (;;) {
          const chunk = await wait(reader.read())
          if (chunk.done) break
          total += chunk.value.byteLength
          if (total > cap) throw new NativeSyncError('transfer', 'The Anki account response exceeds the 64 MiB transfer limit.')
          parts.push(chunk.value)
        }
      } catch (error) {
        if (reader) void reader.cancel().catch(() => undefined)
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof NativeSyncError) throw error
        const phase = route === 'sync/download' ? 'collection download' : route.startsWith('msync/') ? 'media transfer' : 'account response transfer'
        throw new NativeSyncError('transfer', `The ${phase} was interrupted while reading the response. Check connectivity and retry. Your local work is preserved.`, { route, status: response.status, source: 'unknown', phase: 'response-body' })
      }
      const bytes = new Uint8Array(total); let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.length }
      return bytes
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancelled)
      controller.signal.removeEventListener('abort', reject)
      if (controller.signal.aborted && reader) void reader.cancel().catch(() => undefined)
      controller.abort()
    }
  }
  private async json(route: string, data: unknown, session?: string, options: NativeRequestOptions = {}): Promise<unknown> {
    const bytes = await this.request(route, data, session, options)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw protocolError() }
  }
  async metadata(options: NativeRequestOptions = {}): Promise<NativeSyncMeta> {
    // AnkiWeb accepts the Anki protocol family here. Keep the actual app
    // version and Kiroku marker instead of claiming an official Anki build.
    const value = await this.json('sync/meta', { v: 10, cv: 'anki,0.1.0 (kiroku),web' }, undefined, options)
    if (!isObject(value) || typeof value.cont !== 'boolean' || typeof value.empty !== 'boolean') throw protocolError()
    const meta = { mod: integer(value.mod), scm: integer(value.scm), usn: integer(value.usn), ts: integer(value.ts), cont: value.cont, empty: value.empty, hostNum: integer(value.hostNum ?? 0), msg: typeof value.msg === 'string' ? value.msg.slice(0, 1000) : '' }
    if (meta.usn < 0 || meta.hostNum < 0 || meta.mod < 0 || meta.scm < 0 || meta.ts < 0) throw protocolError()
    this.#hostNumber = meta.hostNum
    if (!meta.cont) throw new NativeSyncError('upgrade', 'AnkiWeb requested that synchronization stop. Update the app before retrying; local work is preserved.')
    return meta
  }
  /** Authenticated media operations keep the session/account key private. */
  async mediaRequest(method: 'begin' | 'mediaChanges' | 'downloadFiles' | 'uploadChanges' | 'mediaSanity', data: unknown, options: NativeRequestOptions = {}): Promise<unknown | Uint8Array> {
    const bytes = await this.request(`msync/${method}`, data, undefined, options)
    if (method === 'downloadFiles') return bytes
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw protocolError() }
    if (!isObject(value) || value.err || !('data' in value)) throw protocolError()
    return value.data
  }
  async downloadCollection(SQL: SqlJsStatic, options: NativeRequestOptions = {}): Promise<Uint8Array> {
    return (await this.downloadWithRevision(SQL, undefined, options)).collection
  }
  async downloadWithRevision(SQL: SqlJsStatic, expected?: NativeSyncMeta, options: NativeRequestOptions = {}): Promise<{ collection: Uint8Array; remote: NativeSyncMeta }> {
    const meta = await this.metadata(options)
    if (expected && !sameRemoteRevision(meta, expected)) throw new NativeSyncError('conflict', 'The account changed since the full-sync preview. Preview its current revision before choosing a direction again.')
    const bytes = await this.request('sync/download', {}, undefined, options)
    if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw protocolError()
    const db = new SQL.Database(bytes)
    try {
      validateDatabase(db)
      const after = await this.metadata(options)
      // The official full download itself advances the server mod/usn. Check
      // the delivered snapshot against metadata obtained after that operation.
      if (scalar(db, 'SELECT scm FROM col') !== meta.scm || after.scm !== meta.scm || scalar(db, 'SELECT mod FROM col') !== after.mod || scalar(db, 'SELECT usn FROM col') !== after.usn) throw new NativeSyncError('transfer', 'The account changed during download. Retry before replacing local data.')
      db.run('UPDATE col SET ls=?', [after.mod])
      await rebuildNativeNoteCaches(db)
      return { collection: db.export(), remote: after }
    } finally { db.close() }
  }
  async previewFullSync(SQL: SqlJsStatic, snapshot: Uint8Array, options: NativeRequestOptions = {}): Promise<NativeFullSyncPreview> {
    const db = new SQL.Database(snapshot)
    try {
      validateDatabase(db)
      return { localHash: await nativeSnapshotHash(snapshot), localNotes: scalar(db, 'SELECT count(*) FROM notes'), localCards: scalar(db, 'SELECT count(*) FROM cards'), remote: await this.metadata(options) }
    } finally { db.close() }
  }
  /** Upload operates only on an explicitly prepared snapshot, after durable
   * backups. The state boundary supplies those backups and revision checks. */
  async uploadPreparedCollection(SQL: SqlJsStatic, prepared: Uint8Array, expected: NativeSyncMeta, options: NativeRequestOptions = {}): Promise<Uint8Array> {
    if (prepared.length >= cap) throw new NativeSyncError('transfer', 'The native collection exceeds the 64 MiB upload boundary. Keep its backup before using another Anki client.')
    if (!sameRemoteRevision(await this.metadata(options), expected)) throw new NativeSyncError('conflict', 'The account changed before upload. Its durable backup and the local checkpoint were preserved; preview again.')
    const response = await this.request('sync/upload', prepared, undefined, options)
    if (new TextDecoder('utf-8', { fatal: true }).decode(response) !== 'OK') throw new NativeSyncError('transfer', 'Anki rejected the full collection upload. Backups and the original checkpoint are preserved.')
    return this.verifyUploadedCollection(SQL, prepared, options)
  }
  async verifyUploadedCollection(SQL: SqlJsStatic, prepared: Uint8Array, options: NativeRequestOptions = {}): Promise<Uint8Array> {
    const verified = await this.downloadCollection(SQL, options)
    if (nativeContentFingerprint(SQL, prepared) !== nativeContentFingerprint(SQL, verified)) throw new NativeSyncError('conflict', 'The account collection differs from the prepared upload. Keep both backups and preview again before replacing a checkpoint.')
    return verified
  }
  async syncCollection(SQL: SqlJsStatic, snapshot: Uint8Array, options: NativeRequestOptions = {}): Promise<{ outcome: 'synced' | 'unchanged'; collection: Uint8Array } | { outcome: 'full-sync-required'; localEmpty: boolean; remoteEmpty: boolean }> {
    const db = new SQL.Database(snapshot)
    let session: string | undefined
    try {
      validateDatabase(db)
      const remote = await this.metadata(options)
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
      const graves = parseGraves(await this.json('sync/start', { minUsn: localUsn, lnewer: newer }, session, options))
      applyGraves(db, graves, remote.usn)
      for (let at = 0; at < Math.max(1, ...Object.values(pending).map((ids) => ids.length)); at += 1000) await this.json('sync/applyGraves', { chunk: { cards: pending.cards.slice(at, at + 1000), notes: pending.notes.slice(at, at + 1000), decks: pending.decks.slice(at, at + 1000) } }, session, options)
      const wireChanges = { ...localChanges, models: localChanges.models.map((value) => ({ ...value, usn: remote.usn })), decks: localChanges.decks.map((list) => list.map((value) => ({ ...value, usn: remote.usn }))) }
      const changes = parseChanges(await this.json('sync/applyChanges', { changes: wireChanges }, session, options))
      mergeObjects(db, 'models', changes.models, remote.usn); mergeObjects(db, 'decks', changes.decks[0], remote.usn); mergeObjects(db, 'dconf', changes.decks[1], remote.usn)
      const tags = jsonColumn(db, 'tags'); for (const tag of changes.tags) Object.defineProperty(tags, tag, { value: remote.usn, enumerable: true, configurable: true, writable: true }); setJson(db, 'tags', tags)
      if (changes.conf) setJson(db, 'conf', changes.conf)
      if (changes.crt !== undefined) db.run('UPDATE col SET crt=?', [changes.crt])
      for (let count = 0;; count++) {
        if (count >= 4000) throw new NativeSyncError('transfer', 'The account has too many changes for this sync. Keep local work and use the recovery flow.')
        const chunk = parseChunk(await this.json('sync/chunk', {}, session, options)); insertChunk(db, chunk, remote.usn)
        if (chunk.done) break
      }
      for (const table of ['revlog', 'notes', 'cards'] as const) for (let at = 0; at < tables[table].length; at += chunkLimit) {
        const liveRows = tables[table].slice(at, at + chunkLimit).flatMap((row) => db.exec(`SELECT ${columns[table].join(',')} FROM ${table} WHERE id=? AND usn=-1`, [row[0]])[0]?.values ?? [])
        const chunk = { cards: [], notes: [], revlog: [], [table]: liveRows.map((row) => row.map((cell, index) => index === columns[table].indexOf('usn' as never) ? remote.usn : table === 'notes' && (index === 7 || index === 8) ? '' : cell)) }
        await this.json('sync/applyChunk', { chunk }, session, options)
      }
      const sanity = await this.json('sync/sanityCheck2', { client: sanityCounts(db) }, session, options)
      if (!isObject(sanity) || sanity.status !== 'ok') throw protocolError()
      const mod = integer(await this.json('sync/finish', {}, session, options)); session = undefined
      await rebuildNativeNoteCaches(db)
      for (const table of ['cards', 'notes', 'revlog', 'graves']) db.run(`UPDATE ${table} SET usn=? WHERE usn=-1`, [remote.usn])
      for (const column of objectColumns) { const values = jsonColumn(db, column); for (const value of Object.values(values)) if (isObject(value) && value.usn === -1) value.usn = remote.usn; setJson(db, column, values) }
      const allTags = jsonColumn(db, 'tags'); for (const [tag, usn] of Object.entries(allTags)) if (usn === -1) allTags[tag] = remote.usn; setJson(db, 'tags', allTags)
      // Official finish increments the server revision. The next client cursor
      // must use that incremented value, rather than replaying its own batch.
      db.run('UPDATE col SET usn=?, mod=?, ls=?', [remote.usn + 1, mod, mod])
      return { outcome: 'synced', collection: db.export() }
    } finally {
      if (session) await this.json('sync/abort', {}, session, { timeoutMs: 5000 }).catch(() => undefined)
      db.close()
    }
  }
}
