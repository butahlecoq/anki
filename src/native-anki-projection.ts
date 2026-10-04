import type { CardRow, CollectionData, DeckRow, FieldRow, NoteRow, NotetypeRow, RevlogRow, TemplateRow } from 'ankipack'
import type { Database as SqlDatabase, SqlJsStatic } from 'sql.js'
import type { CardRecord, CardTemplate, Deck, Note, NoteType, NoteTypeField, ReviewEntry } from './collection.js'
import { nativeSnapshotHash } from './native-anki-sync.js'

export interface NativeProjectionMedia { name: string; data: Uint8Array }

/** Native identities and relationships needed to apply app-side deltas back
 * onto the authoritative SQLite base without rebuilding unsupported rows. */
export interface NativeAnkiProjectionManifest {
  version: 1
  snapshotHash: string
  collectionId: number
  schema: 11
  notes: Array<{ id: number; guid: string; notetypeId: number }>
  cards: Array<{ id: number; noteId: number; ordinal: number; deckId: number; originalDeckId: number }>
  reviews: Array<{ id: number; cardId: number }>
  decks: Array<{ id: number }>
  notetypes: Array<{ id: number; fieldOrdinals: number[]; templateOrdinals: number[] }>
}

export interface NativeAnkiProjectionEntities {
  notes: readonly Note[]
  cards: readonly CardRecord[]
  reviews: readonly ReviewEntry[]
  decks: readonly Deck[]
  notetypes: readonly NoteType[]
}

export interface NativeAnkiProjectionEntityMap {
  notes: ReadonlyMap<number, string>
  cards: ReadonlyMap<number, string>
  reviews: ReadonlyMap<number, string>
  decks: ReadonlyMap<number, string>
  notetypes: ReadonlyMap<number, string>
  fields: ReadonlyMap<string, NoteTypeField>
  templates: ReadonlyMap<string, CardTemplate>
  unmapped: {
    notes: number[]
    cards: number[]
    reviews: number[]
    decks: number[]
    notetypes: number[]
  }
}

function invalid(): Error {
  return new Error('The saved Anki collection cannot be projected safely. Its native snapshot is unchanged.')
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid()
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}

function decodeJson(value: unknown): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text(value))
    if (!object(result)) throw invalid()
    return result
  } catch {
    throw invalid()
  }
}

function encodeVarint(value: number): number[] {
  let remaining = BigInt(value)
  const bytes: number[] = []
  while (remaining > 0x7fn) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return bytes
}

function encodeNumber(field: number, value: number): number[] {
  return [...encodeVarint(field << 3), ...encodeVarint(value)]
}

function encodeText(field: number, value: string): number[] {
  const bytes = new TextEncoder().encode(value)
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.byteLength), ...bytes]
}

function notetypeConfig(kind: number, stockKind: number, css: string) {
  return Uint8Array.from([...encodeNumber(1, kind), ...encodeText(3, css), ...(stockKind ? encodeNumber(9, stockKind) : [])])
}

function templateConfig(front: string, back: string) {
  return Uint8Array.from([...encodeText(1, front), ...encodeText(2, back)])
}

function nativeNotetypes(models: Record<string, unknown>): { notetypes: NotetypeRow[]; fields: FieldRow[]; templates: TemplateRow[] } {
  const notetypes: NotetypeRow[] = [], fields: FieldRow[] = [], templates: TemplateRow[] = []
  for (const [key, value] of Object.entries(models)) {
    if (!object(value)) throw invalid()
    const id = integer(value.id)
    if (String(id) !== key || id <= 0) throw invalid()
    const name = text(value.name), kind = integer(value.type), modified = integer(value.mod)
    if (![0, 1].includes(kind) || !Array.isArray(value.flds) || !Array.isArray(value.tmpls)) throw invalid()
    const css = text(value.css)
    const stockKind = value.kind === undefined ? 0 : integer(value.kind)
    notetypes.push({ id, name, mtimeSecs: modified, usn: 0, config: notetypeConfig(kind === 1 ? 1 : 0, stockKind, css) })
    for (const field of value.flds) {
      if (!object(field)) throw invalid()
      fields.push({ ntid: id, ord: integer(field.ord), name: text(field.name), config: new Uint8Array() })
    }
    for (const template of value.tmpls) {
      if (!object(template)) throw invalid()
      templates.push({
        ntid: id,
        ord: integer(template.ord),
        name: text(template.name),
        mtimeSecs: template.mod === undefined ? modified : integer(template.mod),
        usn: 0,
        config: templateConfig(text(template.qfmt), text(template.afmt)),
      })
    }
  }
  return { notetypes, fields, templates }
}

function nativeDecks(decks: Record<string, unknown>): DeckRow[] {
  return Object.entries(decks).map(([key, value]) => {
    if (!object(value)) throw invalid()
    const id = integer(value.id)
    if (String(id) !== key || id <= 0) throw invalid()
    return {
      id,
      name: text(value.name).replaceAll('::', '\u001f'),
      mtimeSecs: integer(value.mod),
      usn: 0,
      common: new Uint8Array(),
      kind: new Uint8Array(),
    }
  })
}

function rows<T>(db: SqlDatabase, query: string): T[] {
  try {
    return (db.exec(query)[0]?.values ?? []) as T[]
  } catch {
    throw invalid()
  }
}

/** Reads schema-11 SQLite into the app's supported projection input. The caller
 * keeps the native snapshot and media database authoritative; this function
 * only creates an in-memory view for the existing importer/projection rules. */
export function nativeAnkiProjectionData(SQL: SqlJsStatic, snapshot: Uint8Array, media: readonly NativeProjectionMedia[] = []): CollectionData {
  let db: SqlDatabase
  try {
    db = new SQL.Database(snapshot)
  } catch {
    throw invalid()
  }
  try {
    const check = rows<unknown[]>(db, 'PRAGMA quick_check')[0]?.[0]
    if (check !== 'ok') throw invalid()
    const colRows = rows<unknown[]>(db, 'SELECT id,crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags FROM col')
    if (colRows.length !== 1) throw invalid()
    const [id, crt, mod, scm, ver, dty, usn, ls, conf, modelsJson, decksJson, dconf, tags] = colRows[0]
    if (integer(ver) !== 11) throw new Error('This account snapshot uses an unsupported Anki collection schema. Its native backup remains available.')
    const models = decodeJson(modelsJson), decks = decodeJson(decksJson)
    const nativeTypes = nativeNotetypes(models)
    const nativeDeckRows = nativeDecks(decks)
    const names = new Set<string>()
    let totalMediaBytes = 0
    for (const file of media) {
      if (!file.name || file.name.normalize('NFC') !== file.name || names.has(file.name) || !(file.data instanceof Uint8Array)) throw invalid()
      names.add(file.name)
      totalMediaBytes += file.data.byteLength
      if (!Number.isSafeInteger(totalMediaBytes)) throw invalid()
    }
    const noteRows = rows<unknown[]>(db, 'SELECT id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data FROM notes ORDER BY id')
    const cardRows = rows<unknown[]>(db, 'SELECT id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data FROM cards ORDER BY id')
    const reviewRows = rows<unknown[]>(db, 'SELECT id,cid,usn,ease,ivl,lastIvl,factor,time,type FROM revlog ORDER BY id')
    const validatedNotes = noteRows.map((row): NoteRow => {
      if (row.length !== 11) throw invalid()
      for (const index of [0, 2, 3, 4, 8, 9]) integer(row[index])
      for (const index of [1, 5, 6, 10]) text(row[index])
      if (typeof row[7] !== 'string' && typeof row[7] !== 'number') throw invalid()
      const [noteId, guid, mid, modified, noteUsn, noteTags, fields, sortField, checksum, flags, data] = row
      return { id: integer(noteId), guid: text(guid), mid: integer(mid), mod: integer(modified), usn: integer(noteUsn), tags: text(noteTags), flds: text(fields), sfld: sortField as string | number, csum: integer(checksum), flags: integer(flags), data: text(data) }
    })
    const validatedCards = cardRows.map((row): CardRow => {
      if (row.length !== 18) throw invalid()
      const [cardId, nid, did, ord, modified, cardUsn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data] = row
      return { id: integer(cardId), nid: integer(nid), did: integer(did), ord: integer(ord), mod: integer(modified), usn: integer(cardUsn), type: integer(type), queue: integer(queue), due: integer(due), ivl: integer(ivl), factor: integer(factor), reps: integer(reps), lapses: integer(lapses), left: integer(left), odue: integer(odue), odid: integer(odid), flags: integer(flags), data: text(data) }
    })
    const validatedReviews = reviewRows.map((row): RevlogRow => {
      if (row.length !== 9) throw invalid()
      const [reviewId, cid, reviewUsn, ease, ivl, lastIvl, factor, time, type] = row
      return { id: integer(reviewId), cid: integer(cid), usn: integer(reviewUsn), ease: integer(ease), ivl: integer(ivl), lastIvl: integer(lastIvl), factor: integer(factor), time: integer(time), type: integer(type) }
    })
    // The durable media store is the owner. The projection and importer only
    // read these bytes; avoid doubling the entire account's media footprint.
    const nativeMedia = media.map(({ name, data }) => ({ name, data }))
    return {
      col: {
        id: integer(id), crt: integer(crt), mod: integer(mod), scm: integer(scm), ver: 11,
        dty: integer(dty), usn: integer(usn), ls: integer(ls), conf: text(conf),
        models: text(modelsJson), decks: text(decksJson), dconf: text(dconf), tags: text(tags),
      },
      notes: validatedNotes,
      cards: validatedCards,
      revlog: validatedReviews,
      graves: [], deckConfig: [], config: [], tags: [],
      ...nativeTypes,
      decks: nativeDeckRows,
      media: nativeMedia,
    }
  } finally {
    db.close()
  }
}

/** Creates a compact crosswalk tied to one exact native snapshot. The
 * checkpoint remains the source of truth for opaque/native values; this map
 * records identities and original per-card deck bindings for safe delta work. */
export async function nativeAnkiProjectionManifest(SQL: SqlJsStatic, snapshot: Uint8Array): Promise<NativeAnkiProjectionManifest> {
  const data = nativeAnkiProjectionData(SQL, snapshot)
  const unique = <T>(values: T[], key: (value: T) => number): Map<number, T> => {
    const result = new Map<number, T>()
    for (const value of values) {
      const id = key(value)
      if (result.has(id)) throw invalid()
      result.set(id, value)
    }
    return result
  }
  const notes = unique(data.notes, (row) => row.id)
  const cards = unique(data.cards, (row) => row.id)
  const reviews = unique(data.revlog, (row) => row.id)
  const decks = unique(data.decks, (row) => row.id)
  const notetypes = unique(data.notetypes, (row) => row.id)
  const guids = new Set<string>()
  for (const note of notes.values()) {
    if (!note.guid || guids.has(note.guid) || !notetypes.has(note.mid)) throw invalid()
    guids.add(note.guid)
  }
  const cardOrdinals = new Set<string>()
  for (const card of cards.values()) {
    if (!notes.has(card.nid) || !decks.has(card.did) || (card.odid > 0 && !decks.has(card.odid))) throw invalid()
    const identity = `${card.nid}:${card.ord}`
    if (card.ord < 0 || cardOrdinals.has(identity)) throw invalid()
    cardOrdinals.add(identity)
  }
  for (const review of reviews.values()) if (!cards.has(review.cid)) throw invalid()
  for (const notetype of notetypes.values()) {
    for (const values of [data.fields.filter((field) => field.ntid === notetype.id).map((field) => field.ord), data.templates.filter((template) => template.ntid === notetype.id).map((template) => template.ord)]) {
      if (values.some((ordinal) => ordinal < 0) || new Set(values).size !== values.length) throw invalid()
    }
  }
  return {
    version: 1,
    snapshotHash: await nativeSnapshotHash(snapshot),
    collectionId: data.col.id,
    schema: 11,
    notes: [...notes.values()].map(({ id, guid, mid }) => ({ id, guid, notetypeId: mid })),
    cards: [...cards.values()].map(({ id, nid, ord, did, odid }) => ({ id, noteId: nid, ordinal: ord, deckId: did, originalDeckId: odid })),
    reviews: [...reviews.values()].map(({ id, cid }) => ({ id, cardId: cid })),
    decks: [...decks.keys()].map((id) => ({ id })),
    notetypes: [...notetypes.values()].map(({ id }) => ({
      id,
      fieldOrdinals: data.fields.filter((field) => field.ntid === id).map((field) => field.ord).sort((a, b) => a - b),
      templateOrdinals: data.templates.filter((template) => template.ntid === id).map((template) => template.ord).sort((a, b) => a - b),
    })),
  }
}

/** Builds the native-to-app crosswalk from stable importer identities. Native
 * entities unsupported by the app are reported as unmapped so a writer can
 * preserve them byte-for-byte in the authoritative SQLite snapshot. */
export function nativeAnkiProjectionEntityMap(manifest: NativeAnkiProjectionManifest, entities: NativeAnkiProjectionEntities): NativeAnkiProjectionEntityMap {
  const invalidMap = () => new Error('The imported Anki entities do not match their native identity map.')
  const unique = <T>(items: readonly T[], identity: (item: T) => number | undefined): Map<number, T> => {
    const result = new Map<number, T>()
    for (const item of items) {
      const id = identity(item)
      if (id === undefined) continue
      if (!Number.isSafeInteger(id) || id <= 0 || result.has(id)) throw invalidMap()
      result.set(id, item)
    }
    return result
  }

  const appNotes = unique(entities.notes, (note) => note.ankiId)
  const appCards = unique(entities.cards, (card) => card.ankiId)
  const appReviews = new Map<number, ReviewEntry>()
  for (const review of entities.reviews) {
    if (!review.id.startsWith('anki-review:')) continue
    const id = Number(review.id.slice('anki-review:'.length))
    if (!Number.isSafeInteger(id) || id <= 0 || appReviews.has(id)) throw invalidMap()
    appReviews.set(id, review)
  }
  const notes = new Map<number, string>()
  const cards = new Map<number, string>()
  const reviews = new Map<number, string>()
  const decks = new Map<number, string>()
  const notetypes = new Map<number, string>()
  const fields = new Map<string, NoteTypeField>()
  const templates = new Map<string, CardTemplate>()

  for (const native of manifest.notes) {
    const app = appNotes.get(native.id)
    if (!app) continue
    if (app.id !== `anki-note:${native.guid}` || app.typeId !== `anki-note-type:${native.notetypeId}` && app.typeId !== 'image-occlusion') throw invalidMap()
    notes.set(native.id, app.id)
  }
  for (const native of manifest.cards) {
    const app = appCards.get(native.id)
    if (!app) continue
    const noteId = notes.get(native.noteId)
    if (!noteId || app.noteId !== noteId) throw invalidMap()
    cards.set(native.id, app.id)
  }
  for (const native of manifest.reviews) {
    const cardId = cards.get(native.cardId)
    const app = appReviews.get(native.id)
    if (!app) continue
    if (app.cardId !== cardId) throw invalidMap()
    reviews.set(native.id, app.id)
  }
  for (const native of manifest.decks) {
    const id = `anki-deck:${native.id}`
    if (entities.decks.some((deck) => deck.id === id)) decks.set(native.id, id)
  }
  for (const native of manifest.notetypes) {
    const id = `anki-note-type:${native.id}`
    const app = entities.notetypes.find((notetype) => notetype.id === id)
    if (!app) continue
    notetypes.set(native.id, id)
    for (const ordinal of native.fieldOrdinals) {
      const fieldId = `anki-field:${native.id}:${ordinal}`
      const field = app.fields.find((candidate) => candidate.id === fieldId)
      if (!field) throw invalidMap()
      fields.set(`${native.id}:${ordinal}`, field)
    }
    for (const ordinal of native.templateOrdinals) {
      const templateId = `anki-template:${native.id}:${ordinal}`
      const template = app.templates.find((candidate) => candidate.id === templateId)
      if (!template) throw invalidMap()
      templates.set(`${native.id}:${ordinal}`, template)
    }
  }

  return {
    notes, cards, reviews, decks, notetypes, fields, templates,
    unmapped: {
      notes: manifest.notes.filter(({ id }) => !notes.has(id)).map(({ id }) => id),
      cards: manifest.cards.filter(({ id }) => !cards.has(id)).map(({ id }) => id),
      reviews: manifest.reviews.filter(({ id }) => !reviews.has(id)).map(({ id }) => id),
      decks: manifest.decks.filter(({ id }) => !decks.has(id)).map(({ id }) => id),
      notetypes: manifest.notetypes.filter(({ id }) => !notetypes.has(id)).map(({ id }) => id),
    },
  }
}
