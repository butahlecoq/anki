import type { SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Deck as NativeDeck, Notetype as NativeNotetype } from 'ankipack'
import { State, type Collection, type CardRecord } from './collection'
import { serializeAnkiImageOcclusion } from './image-occlusion-interchange'
import { validateAnkiArchive } from './anki-archive'
import { nativeScheduleFingerprint, nativeReviewFingerprint } from './anki-scheduling-metadata'
import { validateMediaBytes } from './anki-import'

export interface AnkiExportOptions { deckId?: string; scheduling: boolean; history: boolean; media: boolean; SQL?: SqlJsStatic }
let sqlPromise: Promise<SqlJsStatic> | undefined
const day = 86_400_000
// Deterministic safe integer IDs retain relationships across repeated exports.
function numericId(value: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return Number(hash % 700_000_000_000n) + 1_000_000_000_000
}
function sourceId(value: string, prefix: string) {
  const native = value.startsWith(prefix) ? Number(value.slice(prefix.length)) : NaN
  return Number.isSafeInteger(native) && native > 0 ? native : numericId(value)
}
function escape(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
function guid(value: string) { return value.startsWith('anki-note:') ? value.slice(10) : value }
// Independently written template invoking the official image occlusion runtime.
// A plain cloze template only hides the shape description, leaving the image
// exposed; native mask rendering needs these runtime container identities.
const nativeOcclusionBody = '{{Header}}<div hidden>{{cloze:Occlusion}}</div><div id="image-occlusion-container">{{Image}}<canvas id="image-occlusion-canvas"></canvas></div><p id="kiroku-occlusion-error"></p><script>try { anki.imageOcclusion.setup(); } catch (error) { document.getElementById("kiroku-occlusion-error").textContent = "Image occlusion requires a supported Anki version."; }</script>'

export async function exportAnkiPackage(collection: Collection, options: AnkiExportOptions) {
  const { Collection: AnkiCollection, Deck: AnkiDeck, Note: AnkiNote, Notetype, Package } = await import('ankipack')
  const snapshot = await collection.transaction('r', [collection.decks, collection.notes, collection.noteTypes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs], async () => ({
    decks: await collection.decks.toArray(), notes: await collection.notes.toArray(), types: await collection.noteTypes.toArray(), cards: await collection.cards.toArray(), reviews: await collection.reviewEntries.toArray(), references: await collection.noteMedia.toArray(), blobs: await collection.mediaBlobs.toArray(),
  }))
  const decksById = new Map(snapshot.decks.map((deck) => [deck.id, deck]))
  function path(id: string, seen = new Set<string>()): string {
    const deck = decksById.get(id)
    if (!deck || seen.has(id)) throw new Error('A deck relationship is missing or cyclic.')
    seen.add(id)
    return deck.parentId ? `${path(deck.parentId, seen)}::${deck.name}` : deck.name
  }
  const selectedPath = options.deckId ? path(options.deckId) : undefined
  const selected = new Set(snapshot.decks.filter((deck) => !selectedPath || path(deck.id) === selectedPath || path(deck.id).startsWith(`${selectedPath}::`)).map((deck) => deck.id))
  const notes = snapshot.notes.filter((note) => selected.has(note.deckId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  if (!notes.length) throw new Error('There are no notes to export in this selection.')
  const noteIds = new Set(notes.map((note) => note.id))
  for (const card of snapshot.cards.filter((card) => noteIds.has(card.noteId))) selected.add(card.deckId)
  const references = snapshot.references.filter((reference) => noteIds.has(reference.noteId))
  const names = new Map<string, string>()
  const media = new Map<string, Uint8Array>()
  if (options.media) for (const reference of references) {
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' } as Record<string, string>)[reference.mimeType]
    if (!extension) throw new Error(`Unsupported media: ${reference.displayName}`)
    const name = `${reference.digest}.${extension}`
    names.set(reference.id, name)
    if (media.has(name)) continue
    const stored = snapshot.blobs.find((blob) => blob.digest === reference.digest)
    if (!stored) throw new Error(`Missing media: ${reference.displayName}. Sync or restore it before exporting.`)
    const isBuffer = Object.prototype.toString.call(stored.blob) === '[object ArrayBuffer]'
    const blob = stored.blob as Blob
    const bytes = isBuffer ? stored.blob as ArrayBuffer : typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob) })
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (digest !== reference.digest) throw new Error(`Damaged media: ${reference.displayName}`)
    validateMediaBytes(new Uint8Array(bytes), reference.mimeType)
    media.set(name, new Uint8Array(bytes))
  }
  const packageFile = new Package()
  const exportedTypes = new Map<string, NativeNotetype>()
  for (const local of snapshot.types.filter((type) => notes.some((note) => note.typeId === type.id))) {
    if (new Set(local.templates.map((template) => template.css)).size > 1) throw new Error(`Note type ${local.name} uses different CSS per template, which Anki cannot represent. Use shared CSS before exporting.`)
    const occlusion = local.kind === 'image-occlusion'
    exportedTypes.set(local.id, new Notetype({ id: sourceId(local.id, 'anki-note-type:'), name: local.name, type: local.kind === 'standard' ? 'normal' : 'cloze', css: local.templates[0]?.css ?? '',
      fields: occlusion ? ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'].map((name) => ({ name })) : local.fields.map((field) => ({ name: field.name })),
      templates: occlusion ? [{ name: 'Hide one, reveal one', questionFormat: nativeOcclusionBody, answerFormat: `${nativeOcclusionBody}<hr>{{Back Extra}}` }] : local.templates.map((template) => ({ name: template.name, questionFormat: template.front, answerFormat: template.back })),
    }))
  }
  const exportedDecks = new Map<string, NativeDeck>()
  for (const id of selected) {
    const deck = new AnkiDeck({ id: sourceId(id, 'anki-deck:'), name: path(id) })
    exportedDecks.set(id, deck)
    packageFile.addDeck(deck)
  }
  for (const note of notes) {
    const localType = snapshot.types.find((type) => type.id === note.typeId)
    const type = exportedTypes.get(note.typeId)
    if (!localType || !type) throw new Error('A note type is missing.')
    if (note.retiredFields && Object.keys(note.retiredFields).length) throw new Error(`Note ${note.id} contains retired fields. Restore or remove them before exporting.`)
    let fields = localType.fields.map((field) => (note.fields[field.id] ?? '').split(/(\[\[kiroku-media:[^\]]+\]\])/g).map((part) => {
      const token = part.match(/^\[\[kiroku-media:([^\]]+)\]\]$/)
      if (!token) return escape(part)
      if (!options.media) return ''
      const reference = references.find((reference) => reference.noteId === note.id && reference.displayName === token[1])
      if (!reference) throw new Error(`Missing media reference: ${token[1]}`)
      const name = names.get(reference.id)!
      return reference.kind === 'image' ? `<img src="${name}">` : `[sound:${name}]`
    }).join(''))
    if (note.imageOcclusion) {
      if (!options.media) throw new Error('Image occlusion requires its image. Enable media inclusion.')
      const imageName = names.get(note.imageOcclusion.sourceMediaId)
      if (!imageName) throw new Error('The image occlusion source media is missing.')
      fields = Object.values(serializeAnkiImageOcclusion({ imageName, header: note.fields.header ?? '', backExtra: note.fields.backExtra ?? '', comments: '', masks: note.imageOcclusion.masks }))
    } else if (options.media) {
      for (const reference of references.filter((reference) => reference.noteId === note.id && !reference.inline)) {
        const template = localType.templates.find((template) => !reference.templateId || template.id === reference.templateId)
        const content = reference.side === 'front' ? template?.front : template?.back
        const index = localType.fields.findIndex((field) => content?.includes(`{{${field.name}}}`))
        if (index < 0) throw new Error(`Media ${reference.displayName} cannot be placed in its ${reference.side} template. Add a field to that side before exporting.`)
        const name = names.get(reference.id)!
        fields[index] += reference.kind === 'image' ? `<img src="${name}">` : `[sound:${name}]`
      }
    }
    exportedDecks.get(note.deckId)!.addNote(new AnkiNote({ notetype: type, fields, tags: note.tags ?? [], guid: guid(note.id) }))
  }
  for (const [name, bytes] of media) packageFile.addMedia(name, bytes)
  const data = await packageFile.toCollection()
  for (const row of data.notetypes) if (snapshot.types.find((type) => sourceId(type.id, 'anki-note-type:') === row.id)?.kind === 'image-occlusion') {
    // Native Notetype.Config original_stock_kind is protobuf field 9, enum 6.
    // The final occurrence overrides an existing default emitted by ankipack.
    row.config = new Uint8Array([...row.config, 0x48, 0x06])
  }
  data.col.crt = Math.floor(Date.now() / day) * 86_400
  // An empty schedVer identifies the historical three-button scheduler and
  // makes native Anki upgrade Good learning answers to Easy during import.
  data.col.conf = JSON.stringify({ schedVer: 2 })
  data.config.push({ key: 'schedVer', usn: -1, mtimeSecs: Math.floor(Date.now() / 1000), val: new TextEncoder().encode('2') })
  const localByGuid = new Map(notes.map((note) => [guid(note.id), note]))
  for (const row of data.notes) {
    const note = localByGuid.get(row.guid)!
    const type = snapshot.types.find((type) => type.id === note.typeId)!
    row.data = JSON.stringify({ kirokuNoteTimes: { createdAt: note.createdAt, updatedAt: note.updatedAt }, ...(options.media ? { kirokuMedia: references.filter((reference) => reference.noteId === note.id).map((reference) => ({ name: names.get(reference.id), displayName: reference.displayName, side: reference.side, inline: Boolean(reference.inline), playback: reference.playback, templateOrd: reference.templateId ? type.templates.findIndex((template) => template.id === reference.templateId) : null })) } : {}) })
  }
  for (const note of notes) {
    const nativeNote = data.notes.find((row) => row.guid === guid(note.id))!
    const type = snapshot.types.find((type) => type.id === note.typeId)!
    for (const card of snapshot.cards.filter((card) => card.noteId === note.id)) {
      const ord = type.kind === 'standard' ? type.templates.findIndex((template) => template.id === card.templateId) : (card.clozeOrdinal ?? card.occlusionOrdinal ?? 0) - 1
      if (ord < 0) throw new Error(`Card ${card.id} has no exportable template or ordinal.`)
      if (!data.cards.some((row) => row.nid === nativeNote.id && row.ord === ord)) data.cards.push({ id: numericId(`card:${card.id}`), nid: nativeNote.id, did: sourceId(card.deckId, 'anki-deck:'), ord, mod: Math.floor(Date.now() / 1000), usn: -1, type: 0, queue: 0, due: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' })
    }
  }
  const cardsByExport = new Map<number, CardRecord>()
  data.cards = data.cards.filter((row) => {
    const sourceNote = data.notes.find((note) => note.id === row.nid)!
    const localNote = localByGuid.get(sourceNote.guid)!
    const type = snapshot.types.find((type) => type.id === localNote.typeId)!
    const card = snapshot.cards.find((card) => card.noteId === localNote.id && (type.kind === 'standard' ? card.templateId === type.templates[row.ord]?.id : (card.clozeOrdinal ?? card.occlusionOrdinal) === row.ord + 1))
    if (!card) return false
    row.id = card.ankiId ?? numericId(`card:${card.id}`)
    row.did = sourceId(card.deckId, 'anki-deck:')
    cardsByExport.set(row.id, card)
    row.flags = card.flag ?? 0
    if (options.scheduling) {
      row.type = card.state === State.New ? 0 : card.state === State.Learning ? 1 : card.state === State.Review ? 2 : 3
      row.queue = card.manualSuspended || card.templateSuspended || card.suspended ? -1 : row.type === 3 ? 1 : row.type
      row.due = row.type === 0 ? row.due : row.type === 1 || row.type === 3 ? Math.floor(Date.parse(card.due) / 1000) : Math.floor((Date.parse(card.due) - data.col.crt * 1000) / day)
      row.ivl = card.scheduledDays; row.reps = card.reps; row.lapses = card.lapses; row.left = card.learningSteps; row.factor = Math.round(card.difficulty * 100)
      const { due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview, manualSuspended, templateSuspended, buriedUntil } = card
      row.data = JSON.stringify({ s: stability, d: difficulty, kiroku: { version: 1, native: nativeScheduleFingerprint(row), due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview, manualSuspended, templateSuspended, buriedUntil } })
    }
    return true
  })
  if (data.cards.length !== snapshot.cards.filter((card) => noteIds.has(card.noteId)).length) throw new Error('Some card relationships cannot be represented in this package.')
  const noteMapping = new Map(data.notes.map((row) => [row.id, localByGuid.get(row.guid)!.ankiId ?? numericId(`note:${row.guid}`)]))
  for (const row of data.cards) row.nid = noteMapping.get(row.nid)!
  for (const row of data.notes) row.id = noteMapping.get(row.id)!
  for (const [subject, values] of [['notes', data.notes], ['cards', data.cards]] as const) {
    if (new Set(values.map((row) => row.id)).size !== values.length) throw new Error(`Native ${subject} IDs collide; the package was not created.`)
  }
  if (options.history) {
    const used = new Set<number>()
    for (const [cid, card] of cardsByExport) {
      const historyEntries = snapshot.reviews.filter((review) => review.cardId === card.id).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id))
      for (const [index, review] of historyEntries.entries()) {
      let id = review.id.startsWith('anki-review:') ? Number(review.id.slice(12)) : Date.parse(review.reviewedAt)
      while (used.has(id)) id += 1
      used.add(id)
      const next = historyEntries[index + 1] ?? card
      const resultingInterval = review.afterScheduledDays ?? next.scheduledDays
      const interval = resultingInterval || -Math.max(1, Math.round((Date.parse(review.afterDue ?? next.due) - Date.parse(review.reviewedAt)) / 1000))
      const previous = historyEntries[index - 1]
      const lastInterval = review.scheduledDays || (previous ? -Math.max(1, Math.round((Date.parse(review.due) - Date.parse(previous.reviewedAt)) / 1000)) : 0)
      const practice = 'rescheduled' in review && review.rescheduled === false
      data.revlog.push({ id, cid, usn: -1, ease: review.rating, ivl: practice ? 0 : interval, lastIvl: lastInterval, factor: Math.round(review.difficulty * 100), time: review.durationMs ?? 0, type: practice ? 3 : review.state === State.New || review.state === State.Learning ? 0 : review.state === State.Relearning ? 2 : 1 })
      const row = data.cards.find((row) => row.id === cid)!
      const metadata = JSON.parse(row.data || '{}') as Record<string, unknown>
      const history = (metadata.kirokuReviews ?? {}) as Record<string, unknown>
      const { rating, state, due, stability, difficulty, elapsedDays, lastElapsedDays, scheduledDays, learningSteps, reviewedAt, durationMs } = review
      history[id] = { native: nativeReviewFingerprint(data.revlog.at(-1)!), rating, state, due, stability, difficulty, elapsedDays, lastElapsedDays, scheduledDays, learningSteps, reviewedAt, durationMs, afterState: review.afterState, afterDue: review.afterDue, afterStability: review.afterStability, afterDifficulty: review.afterDifficulty, afterElapsedDays: review.afterElapsedDays, afterScheduledDays: review.afterScheduledDays, afterLearningSteps: review.afterLearningSteps, ...(practice ? { rescheduled: false } : {}) }
      row.data = JSON.stringify({ ...metadata, kirokuReviews: history })
      }
    }
  }
  const SQL = options.SQL ?? await (sqlPromise ??= import('sql.js').then(({ default: init }) => init({ locateFile: () => sqlWasmUrl })))
  const bytes = await AnkiCollection.fromData(data).toUint8Array(SQL)
  validateAnkiArchive(bytes)
  return { bytes, filename: `${selectedPath ? 'kiroku-deck' : 'kiroku-collection'}-${new Date().toISOString().slice(0, 10)}.apkg`, notes: notes.length, cards: data.cards.length, media: media.size, reviews: data.revlog.length }
}

