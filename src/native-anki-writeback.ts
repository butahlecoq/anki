import type { SqlJsStatic } from 'sql.js'
import { State, type Collection, type Note } from './collection'
import { prepareAnkiDataImport, type AnkiImportIssue } from './anki-import'
import { nativeAnkiProjectionData, nativeAnkiProjectionEntityMap, type NativeAnkiProjectionManifest, type NativeProjectionMedia } from './native-anki-projection'
import { rebuildNativeNoteCaches } from './native-anki-cache'
import { nativeSnapshotHash } from './native-anki-sync'

export interface NativeWritebackChange {
  noteId: number
  fields: number[]
  tags: boolean
}

export type NativeWritebackPlan =
  | { status: 'unchanged'; changes: []; blocked: [] }
  | { status: 'ready'; snapshot: Uint8Array; changes: NativeWritebackChange[]; blocked: [] }
  | { status: 'blocked'; changes: []; blocked: string[] }

export interface NativeWritebackOptions {
  media?: readonly NativeProjectionMedia[]
  now?: Date
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function same(left: unknown, right: unknown) { return stable(left) === stable(right) }

function hasMediaToken(value: string) { return /\[\[kiroku-media:/i.test(value) }

function nativeHtml(value: string) {
  return value.replace(/\r\n?/g, '\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')
}

function changedTags(note: Note, base: Note) {
  return !same(note.tags ?? [], base.tags ?? [])
}

function issueLabel(issue: AnkiImportIssue) { return `${issue.code}:${issue.subject}` }

/** Builds an in-memory delta over the exact native SQLite base. This function
 * never commits to the app collection or changes the supplied snapshot. */
export async function prepareNativeAnkiWriteback(
  SQL: SqlJsStatic,
  snapshot: Uint8Array,
  manifest: NativeAnkiProjectionManifest,
  collection: Collection,
  options: NativeWritebackOptions = {},
): Promise<NativeWritebackPlan> {
  if (await nativeSnapshotHash(snapshot) !== manifest.snapshotHash) {
    return { status: 'blocked', changes: [], blocked: ['The native snapshot no longer matches its saved projection manifest.'] }
  }

  let prepared
  try {
    const data = nativeAnkiProjectionData(SQL, snapshot, options.media ?? [])
    prepared = await prepareAnkiDataImport(data, collection, { SQL, now: options.now })
  } catch (error) {
    return { status: 'blocked', changes: [], blocked: [error instanceof Error ? error.message : 'The native account cannot be projected safely.'] }
  }
  if (prepared.issues.some((issue) => issue.severity === 'error')) {
    return { status: 'blocked', changes: [], blocked: prepared.issues.filter((issue) => issue.severity === 'error').map(issueLabel) }
  }

  const base = prepared.projectedEntities()
  let current
  try {
    current = await collection.transaction('r', [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia], async () => ({
      decks: await collection.decks.toArray(),
      notetypes: await collection.noteTypes.toArray(),
      notes: await collection.notes.toArray(),
      cards: await collection.cards.toArray(),
      reviews: await collection.reviewEntries.toArray(),
      references: await collection.noteMedia.toArray(),
    }))
  } catch {
    return { status: 'blocked', changes: [], blocked: ['The app collection could not be read consistently.'] }
  }

  let baseMap, currentMap
  try {
    baseMap = nativeAnkiProjectionEntityMap(manifest, { ...base, notetypes: base.noteTypes })
    currentMap = nativeAnkiProjectionEntityMap(manifest, current)
  } catch (error) {
    return { status: 'blocked', changes: [], blocked: [error instanceof Error ? error.message : 'The app entities do not match the native identity map.'] }
  }

  const blocked = new Set<string>()
  for (const kind of ['notes', 'cards', 'reviews', 'decks', 'notetypes'] as const) {
    for (const id of baseMap[kind].keys()) if (!currentMap[kind].has(id)) blocked.add(`A projected ${kind} record was deleted or lost (${id}).`)
  }
  for (const note of current.notes) if (note.ankiId === undefined || !baseMap.notes.has(note.ankiId)) blocked.add('The app contains a new or unmapped note; adding notes is not enabled yet.')
  for (const card of current.cards) if (card.ankiId === undefined || !baseMap.cards.has(card.ankiId)) blocked.add('The app contains a new or unmapped card; card creation is not enabled yet.')
  for (const review of current.reviews) {
    if (!review.id.startsWith('anki-review:') || !baseMap.reviews.has(Number(review.id.slice('anki-review:'.length)))) blocked.add('The app contains a new or unmapped review; review writeback is not enabled yet.')
  }
  const projectedDeckIds = new Set(base.decks.map(({ id }) => id))
  for (const deck of current.decks) if (!projectedDeckIds.has(deck.id) && deck.id !== 'default') blocked.add('The app contains a new local deck; deck writeback is not enabled yet.')
  for (const type of current.notetypes) {
    if (type.id !== 'basic' && type.id !== 'image-occlusion' && !type.id.startsWith('anki-note-type:')) blocked.add('The app contains a new local note type; note type writeback is not enabled yet.')
    if (type.id.startsWith('anki-note-type:') && !baseMap.notetypes.has(Number(type.id.slice('anki-note-type:'.length)))) blocked.add('The app contains a new or unmapped Anki note type; note type writeback is not enabled yet.')
  }

  const baselineNotes = new Map(base.notes.map((note) => [note.ankiId!, note]))
  const currentNotes = new Map(current.notes.map((note) => [note.ankiId!, note]))
  const noteChanges: NativeWritebackChange[] = []
  for (const [nativeId, baseline] of baselineNotes) {
    const local = currentNotes.get(nativeId)
    if (!local) continue
    const changedOrdinals: number[] = []
    const fieldIds = new Set([...Object.keys(baseline.fields), ...Object.keys(local.fields)])
    for (const fieldId of fieldIds) {
      const before = baseline.fields[fieldId]
      const after = local.fields[fieldId]
      if (before === after) continue
      const prefix = `anki-field:${manifest.notes.find((note) => note.id === nativeId)?.notetypeId}:`
      const ordinal = fieldId.startsWith(prefix) ? Number(fieldId.slice(prefix.length)) : NaN
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || hasMediaToken(before ?? '') || hasMediaToken(after ?? '') || (after ?? '').includes('\u001f')) {
        blocked.add(`Note ${nativeId} contains an unsupported field change.`)
        continue
      }
      changedOrdinals.push(ordinal)
    }
    const tagsChanged = changedTags(local, baseline)
    if (tagsChanged && (local.tags ?? []).some((tag) => !tag || /\s/.test(tag))) blocked.add(`Note ${nativeId} contains tags Anki cannot represent safely.`)

    const baseOther: Record<string, unknown> = { ...baseline }
    const localOther: Record<string, unknown> = { ...local }
    delete baseOther.fields
    delete baseOther.tags
    delete baseOther.updatedAt
    delete localOther.fields
    delete localOther.tags
    delete localOther.updatedAt
    if (!same(baseOther, localOther)) blocked.add(`Note ${nativeId} has a structural change outside plain fields and tags.`)
    if (changedOrdinals.length || tagsChanged) noteChanges.push({ noteId: nativeId, fields: changedOrdinals.sort((a, b) => a - b), tags: tagsChanged })
  }

  const baselineCards = new Map(base.cards.map((card) => [card.ankiId!, card]))
  const currentCards = new Map(current.cards.map((card) => [card.ankiId!, card]))
  for (const [id, baseline] of baselineCards) {
    const local = currentCards.get(id)
    if (!local) continue
    const before = { ...baseline, elapsedDays: 0, ...(baseline.state === State.New ? { due: '' } : {}) }
    const after = { ...local, elapsedDays: 0, ...(baseline.state === State.New ? { due: '' } : {}) }
    if (!same(before, after)) blocked.add(`Card ${id} has a scheduling, deck, flag, or suspension change.`)
  }

  const baselineReviews = new Map(base.reviews.map((review) => [review.id, review]))
  const currentReviews = new Map(current.reviews.map((review) => [review.id, review]))
  for (const [id, baseline] of baselineReviews) {
    const local = currentReviews.get(id)
    if (local && !same(baseline, local)) blocked.add(`Review ${id} was modified; review writeback is not enabled yet.`)
  }
  const projectedNoteTypeIds = new Set(base.noteTypes.map(({ id }) => id))
  if (!same([...base.decks].sort((a, b) => a.id.localeCompare(b.id)), current.decks.filter((deck) => projectedDeckIds.has(deck.id)).sort((a, b) => a.id.localeCompare(b.id)))) blocked.add('An Anki deck changed; deck writeback is not enabled yet.')
  if (!same([...base.noteTypes].sort((a, b) => a.id.localeCompare(b.id)), current.notetypes.filter((type) => projectedNoteTypeIds.has(type.id)).sort((a, b) => a.id.localeCompare(b.id)))) blocked.add('An Anki note type changed; note type writeback is not enabled yet.')

  const ankiNoteIds = new Set([...baseMap.notes.values()])
  const baseReferences = base.references.filter((reference) => ankiNoteIds.has(reference.noteId))
  const currentReferences = current.references.filter((reference) => ankiNoteIds.has(reference.noteId))
  if (!same([...baseReferences].sort((a, b) => a.id.localeCompare(b.id)), [...currentReferences].sort((a, b) => a.id.localeCompare(b.id)))) blocked.add('Media references changed; media writeback is not enabled yet.')

  if (blocked.size) return { status: 'blocked', changes: [], blocked: [...blocked].sort() }
  if (!noteChanges.length) return { status: 'unchanged', changes: [], blocked: [] }

  let db
  try { db = new SQL.Database(snapshot) } catch { return { status: 'blocked', changes: [], blocked: ['The native snapshot could not be reopened for writeback.'] } }
  try {
    const fieldsById = new Map(base.notes.map((note) => [note.ankiId!, note.fields]))
    const typesByNote = new Map(manifest.notes.map((note) => [note.id, note.notetypeId]))
    for (const change of noteChanges) {
      const note = currentNotes.get(change.noteId)!
      const fields = fieldsById.get(change.noteId)!
      const raw = db.exec('SELECT flds FROM notes WHERE id = ?', [change.noteId])[0]?.values[0]?.[0]
      if (typeof raw !== 'string') throw new Error('Native note row is missing.')
      const nativeFields = raw.split('\u001f')
      const typeId = typesByNote.get(change.noteId)
      const fieldCount = manifest.notetypes.find((type) => type.id === typeId)?.fieldOrdinals.length ?? -1
      if (nativeFields.length !== fieldCount) throw new Error('Native field layout changed after projection.')
      for (const ordinal of change.fields) {
        const fieldId = `anki-field:${typeId}:${ordinal}`
        if (!(fieldId in fields) || !(fieldId in note.fields) || ordinal >= nativeFields.length) throw new Error('Native field identity is ambiguous.')
        nativeFields[ordinal] = nativeHtml(note.fields[fieldId])
      }
      const tagText = change.tags ? (note.tags?.length ? ` ${note.tags.join(' ')} ` : '') : undefined
      db.run('UPDATE notes SET flds=?, tags=?, mod=?, usn=-1 WHERE id=?', [nativeFields.join('\u001f'), tagText ?? String(db.exec('SELECT tags FROM notes WHERE id = ?', [change.noteId])[0]?.values[0]?.[0] ?? ''), Math.floor((options.now ?? new Date()).getTime() / 1000), change.noteId])
    }
    await rebuildNativeNoteCaches(db)
    return { status: 'ready', snapshot: db.export(), changes: noteChanges, blocked: [] }
  } catch (error) {
    return { status: 'blocked', changes: [], blocked: [error instanceof Error ? error.message : 'The native note update could not be prepared safely.'] }
  } finally {
    db.close()
  }
}
