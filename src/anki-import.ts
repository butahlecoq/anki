import type { SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { CardRow, Collection as AnkiCollection, CollectionData, RevlogRow } from 'ankipack'
import { State, type CardRecord, type Collection, type Deck, type Note, type NoteMediaReference, type NoteType, type ReviewEntry, type SyncOperation } from './collection'
import { parseAnkiImageOcclusion, type AnkiImageOcclusionFields } from './image-occlusion-interchange'
import { digestMedia, validateMedia, type MediaKind, type MediaSide } from './media'
import { validateTemplate } from './template-renderer'

export interface AnkiImportIssue {
  severity: 'info' | 'warning' | 'error'
  code: string
  subject: string
  detail: string
}

export interface AnkiImportSummary {
  decks: number
  noteTypes: number
  notes: number
  cards: number
  reviews: number
  media: number
}

export interface AnkiDuplicateSummary { create: number; update: number; keepLocal: number; unchanged: number }

interface StoredMedia { digest: string; blob: ArrayBuffer; byteLength: number; mimeType: string; verifiedAt: string }
interface ImportWrites {
  decks: Array<{ value: Deck; action: 'create' | 'update' }>
  noteTypes: Array<{ value: NoteType; action: 'create' | 'update' }>
  notes: Array<{ value: Note; action: 'create' | 'update' }>
  cards: Array<{ value: CardRecord; action: 'create' | 'update' }>
  reviews: ReviewEntry[]
  references: Array<{ value: NoteMediaReference; action: 'create' | 'update' }>
  deletedReferences: NoteMediaReference[]
  blobs: StoredMedia[]
}

type Snapshot = { table: 'decks' | 'noteTypes' | 'notes' | 'cards' | 'reviewEntries' | 'noteMedia' | 'mediaBlobs'; id: string; value: string }

export interface PrepareAnkiImportOptions { SQL?: SqlJsStatic; now?: Date }

let sqlPromise: Promise<SqlJsStatic> | undefined
function browserSql() {
  sqlPromise ??= import('sql.js').then(({ default: initSqlJs }) => initSqlJs({ locateFile: () => sqlWasmUrl }))
  return sqlPromise
}

const textDecoder = new TextDecoder()
const fieldSeparator = '\u001f'
const day = 86_400_000

function stableId(kind: string, source: string | number) {
  return `anki-${kind}:${source}`
}

function isoFromSeconds(seconds: number, fallback: Date) {
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString()
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0n
  let shift = 0n
  let offset = start
  for (let count = 0; offset < bytes.length && count < 10; count += 1) {
    const byte = bytes[offset++]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return { value: Number(value), next: offset }
    shift += 7n
  }
  throw new Error('Malformed protobuf value')
}

function protobufFields(bytes: Uint8Array) {
  const fields = new Map<number, Array<number | Uint8Array>>()
  let offset = 0
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    offset = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8
    let value: number | Uint8Array
    if (wire === 0) {
      const decoded = readVarint(bytes, offset)
      value = decoded.value
      offset = decoded.next
    } else if (wire === 2) {
      const length = readVarint(bytes, offset)
      offset = length.next
      if (length.value < 0 || offset + length.value > bytes.length) throw new Error('Malformed protobuf length')
      value = bytes.slice(offset, offset + length.value)
      offset += length.value
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error('Malformed protobuf fixed64')
      value = bytes.slice(offset, offset + 8)
      offset += 8
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw new Error('Malformed protobuf fixed32')
      value = bytes.slice(offset, offset + 4)
      offset += 4
    } else throw new Error(`Unsupported protobuf wire type ${wire}`)
    const values = fields.get(field) ?? []
    values.push(value)
    fields.set(field, values)
  }
  return fields
}

function protobufNumber(fields: Map<number, Array<number | Uint8Array>>, field: number) {
  const value = fields.get(field)?.[0]
  return typeof value === 'number' ? value : 0
}

function protobufText(fields: Map<number, Array<number | Uint8Array>>, field: number) {
  const value = fields.get(field)?.[0]
  return value instanceof Uint8Array ? textDecoder.decode(value) : ''
}

interface SourceType {
  id: number
  localId: string
  name: string
  kind: 'standard' | 'cloze'
  stockKind: number
  fields: Array<{ id: string; name: string }>
  templates: Array<{ id: string; name: string; front: string; back: string; css: string }>
  createdAt: string
  updatedAt: string
}

function decodeTypes(data: CollectionData, fallback: Date, issues: AnkiImportIssue[]): Map<number, SourceType> {
  const result = new Map<number, SourceType>()
  for (const row of data.notetypes) {
    try {
      const config = protobufFields(row.config)
      const fields = data.fields.filter((field) => field.ntid === row.id).sort((a, b) => a.ord - b.ord)
        .map((field) => ({ id: `anki-field:${row.id}:${field.ord}`, name: field.name }))
      const templates = data.templates.filter((template) => template.ntid === row.id).sort((a, b) => a.ord - b.ord).map((template) => {
        const decoded = protobufFields(template.config)
        return { id: `anki-template:${row.id}:${template.ord}`, name: template.name, front: protobufText(decoded, 1), back: protobufText(decoded, 2), css: protobufText(config, 3) }
      })
      const kind = protobufNumber(config, 1) === 1 ? 'cloze' as const : 'standard' as const
      if (!fields.length || !templates.length) throw new Error('note type has no fields or templates')
      if (kind === 'cloze' && templates.length !== 1) throw new Error('cloze note type does not have exactly one template')
      for (const template of templates) {
        validateTemplate(template.front, fields.map((field) => field.name), 'front', kind)
        validateTemplate(template.back, fields.map((field) => field.name), 'back', kind)
        validateSupportedTemplateMarkup(template.front, template.back, template.css)
      }
      result.set(row.id, {
        id: row.id,
        localId: stableId('note-type', row.id),
        name: row.name,
        kind,
        stockKind: protobufNumber(config, 9),
        fields,
        templates,
        createdAt: isoFromSeconds(row.mtimeSecs, fallback),
        updatedAt: isoFromSeconds(row.mtimeSecs, fallback),
      })
    } catch (reason) {
      issues.push({ severity: 'error', code: 'unsupported-note-type', subject: row.name, detail: reason instanceof Error ? reason.message : 'Unable to decode note type' })
    }
  }
  return result
}

function mimeType(name: string): string | undefined {
  const extension = name.toLocaleLowerCase().split('.').pop()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' } as Record<string, string>)[extension ?? '']
}

function validateMediaBytes(bytes: Uint8Array, mime: string) {
  const text = (start: number, end: number) => textDecoder.decode(bytes.slice(start, end))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const valid = mime === 'image/png' ? bytes.length >= 45
      && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
      && text(12, 16) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(20) > 0
      && bytes.slice(-8).every((byte, index) => byte === [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82][index])
    : mime === 'image/jpeg' ? bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 && Boolean(imageDimensions(bytes))
      : mime === 'image/webp' ? bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' && view.getUint32(4, true) + 8 <= bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 16)) && 20 + view.getUint32(16, true) <= bytes.length
        : mime === 'audio/wav' ? bytes.length >= 45 && text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE' && view.getUint32(4, true) + 8 <= bytes.length && text(12, 16) === 'fmt ' && text(36, 40) === 'data' && view.getUint32(40, true) <= bytes.length - 44
          : mime === 'audio/ogg' ? bytes.length >= 28 && text(0, 4) === 'OggS' && bytes[4] === 0 && 27 + bytes[26] + bytes.slice(27, 27 + bytes[26]).reduce((total, byte) => total + byte, 0) <= bytes.length
            : mime === 'audio/mpeg' ? validMp3(bytes)
              : false
  if (!valid) throw new Error(`“${mime}” bytes do not match the declared media format.`)
}

function validMp3(bytes: Uint8Array) {
  let offset = 0
  if (textDecoder.decode(bytes.slice(0, 3)) === 'ID3') {
    if (bytes.length < 10 || bytes.slice(6, 10).some((byte) => byte > 0x7f)) return false
    offset = 10 + bytes.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0)
  }
  return offset + 24 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0 && (bytes[offset + 2] & 0xf0) !== 0xf0 && (bytes[offset + 2] & 0x0c) !== 0x0c
}

function validateSupportedTemplateMarkup(front: string, back: string, css: string) {
  const html = `${front}\n${back}`
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const element of document.querySelectorAll('*')) {
    if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'FORM'].includes(element.tagName) || [...element.attributes].some((attribute) => attribute.name.toLocaleLowerCase().startsWith('on'))) throw new Error('Executable or embedded template markup is unsupported')
    for (const attribute of ['src', 'href', 'srcset', 'poster']) {
      const value = element.getAttribute(attribute)?.trim()
      if (value && !value.toLocaleLowerCase().startsWith('data:')) throw new Error('Template-static or remote resource references are unsupported; media must come from note fields')
    }
    if (/url\s*\(/i.test(element.getAttribute('style') ?? '')) throw new Error('Inline style resource URLs are unsupported')
  }
  if (/@import/i.test(css) || /url\s*\(\s*["']?(?!data:)/i.test(css)) throw new Error('Template CSS resource URLs are unsupported unless embedded as data')
}

function mediaKind(mime: string): MediaKind { return mime.startsWith('image/') ? 'image' : 'audio' }

function mediaNames(value: string): string[] {
  const found = [
    ...[...value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["'][^>]*>/gi)].map((match) => match[1]),
    ...[...value.matchAll(/\[sound:([^\]]+)\]/gi)].map((match) => match[1]),
  ]
  return [...new Set(found)]
}

function plainField(value: string): string {
  const withoutMedia = value
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["'][^>]*>/gi, (_tag, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
    .replace(/\[sound:([^\]]+)\]/gi, (_tag, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
    .replace(/<br\s*\/?>/gi, '\n')
  const document = new DOMParser().parseFromString(withoutMedia, 'text/html')
  const text = document.body.textContent ?? ''
  return text.trim() ? text : mediaNames(value).length ? '\u200b' : ''
}

function fieldUsed(template: string, name: string) {
  return [...template.matchAll(/{{\s*(?:[#^/]\s*)?([^{}]+?)\s*}}/g)].some((match) => (match[1].split(':').at(-1) ?? '').trim() === name)
}

function cardState(type: number): State {
  if (type === 0) return State.New
  if (type === 1) return State.Learning
  if (type === 2) return State.Review
  return State.Relearning
}

function cardDue(card: CardRow, data: CollectionData, now: Date) {
  const due = card.odid && card.odue ? card.odue : card.due
  if (card.type === 0) return now.toISOString()
  if (!card.odid && (card.queue === 1 || card.queue === 4) && due > 1_000_000_000) return isoFromSeconds(due, now)
  return new Date(data.col.crt * 1000 + Math.max(0, due) * day).toISOString()
}

function memoryState(card: CardRow) {
  try {
    const parsed = JSON.parse(card.data || '{}') as { s?: unknown; d?: unknown }
    return {
      stability: typeof parsed.s === 'number' && Number.isFinite(parsed.s) ? parsed.s : undefined,
      difficulty: typeof parsed.d === 'number' && Number.isFinite(parsed.d) ? parsed.d : undefined,
    }
  } catch {
    return {}
  }
}

function intervalDays(interval: number) {
  return interval >= 0 ? interval : Math.max(0, Math.round(Math.abs(interval) / 86_400))
}

function intervalMilliseconds(interval: number) {
  return interval >= 0 ? interval * day : Math.abs(interval) * 1000
}

function reviewState(review: RevlogRow): State {
  if (review.type === 0) return State.Learning
  if (review.type === 2) return State.Relearning
  return State.Review
}

function fingerprint(value: unknown) {
  if (value === undefined) return 'missing'
  if (value && typeof value === 'object' && 'blob' in value) {
    const media = value as { digest?: unknown; byteLength?: unknown; mimeType?: unknown }
    return JSON.stringify({ digest: media.digest, byteLength: media.byteLength, mimeType: media.mimeType })
  }
  return JSON.stringify(value)
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if ('arrayBuffer' in blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read package bytes'))
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

function operation(entityType: SyncOperation['entityType'], entityId: string, action: 'create' | 'update', payload: unknown, occurredAt: string): SyncOperation {
  return { opId: crypto.randomUUID(), entityType, entityId, action, payload, occurredAt }
}

export class PreparedAnkiImport {
  readonly summary: AnkiImportSummary
  readonly duplicates: AnkiDuplicateSummary
  readonly issues: readonly AnkiImportIssue[]
  readonly filename: string
  private committed = false

  constructor(
    filename: string,
    summary: AnkiImportSummary,
    duplicates: AnkiDuplicateSummary,
    issues: AnkiImportIssue[],
    private readonly collection: Collection,
    private readonly writes: ImportWrites,
    private readonly snapshots: Snapshot[],
    private readonly importedAt: string,
  ) {
    this.filename = filename
    this.summary = summary
    this.duplicates = duplicates
    this.issues = issues
  }

  async commit(): Promise<void> {
    if (this.committed) throw new Error('This package has already been imported')
    if (this.issues.some((issue) => issue.severity === 'error')) throw new Error('Resolve package errors before importing')
    const collection = this.collection
    await collection.transaction('rw', [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs, collection.outbox], async () => {
      for (const snapshot of this.snapshots) {
        const current = await collection[snapshot.table].get(snapshot.id as never)
        if (fingerprint(current) !== snapshot.value) throw new Error('The collection changed after this preview. Please preview again before importing.')
      }
      if (this.writes.decks.length) await collection.decks.bulkPut(this.writes.decks.map(({ value }) => value))
      if (this.writes.noteTypes.length) await collection.noteTypes.bulkPut(this.writes.noteTypes.map(({ value }) => value))
      if (this.writes.notes.length) await collection.notes.bulkPut(this.writes.notes.map(({ value }) => value))
      if (this.writes.cards.length) await collection.cards.bulkPut(this.writes.cards.map(({ value }) => value))
      if (this.writes.reviews.length) await collection.reviewEntries.bulkAdd(this.writes.reviews)
      if (this.writes.references.length) await collection.noteMedia.bulkPut(this.writes.references.map(({ value }) => value))
      if (this.writes.deletedReferences.length) await collection.noteMedia.bulkDelete(this.writes.deletedReferences.map(({ id }) => id))
      if (this.writes.blobs.length) await collection.mediaBlobs.bulkPut(this.writes.blobs)
      const operations: SyncOperation[] = [
        ...this.writes.decks.map(({ value, action }) => operation('deck', value.id, action, value, this.importedAt)),
        ...this.writes.noteTypes.map(({ value, action }) => operation('noteType', value.id, action, value, this.importedAt)),
        ...this.writes.notes.map(({ value, action }) => operation('note', value.id, action, value, this.importedAt)),
        ...this.writes.cards.map(({ value, action }) => operation('card', value.id, action, value, this.importedAt)),
        ...this.writes.reviews.map((value) => operation('review', value.id, 'create', value, this.importedAt)),
        ...this.writes.references.map(({ value, action }) => operation('noteMedia', value.id, action, value, this.importedAt)),
        ...this.writes.deletedReferences.map((value) => ({ opId: crypto.randomUUID(), entityType: 'noteMedia' as const, entityId: value.id, action: 'delete' as const, payload: { id: value.id }, occurredAt: this.importedAt })),
      ]
      if (operations.length) await collection.outbox.bulkAdd(operations)
    })
    this.committed = true
  }
}

export async function prepareAnkiImport(file: File, collection: Collection, options: PrepareAnkiImportOptions = {}): Promise<PreparedAnkiImport> {
  if (!/\.(apkg|colpkg)$/i.test(file.name)) throw new Error('Choose an Anki .apkg or .colpkg package')
  if (!file.size) throw new Error('The selected Anki package is empty')
  if (file.size > 512 * 1024 * 1024) throw new Error('The selected Anki package is larger than the 512 MB import limit')
  const now = options.now ?? new Date()
  const importedAt = now.toISOString()
  const SQL = options.SQL ?? await browserSql()
  let source: AnkiCollection
  try {
    const { Collection: AnkiPackageCollection } = await import('ankipack')
    source = AnkiPackageCollection.open(new Uint8Array(await blobBytes(file)), SQL)
  } catch (reason) {
    console.error('Anki package preview failed', reason)
    throw new Error(`Unable to read “${file.name}”: ${reason instanceof Error ? reason.message : 'invalid Anki package'}`)
  }
  const data = source.data
  const issues: AnkiImportIssue[] = []
  const types = decodeTypes(data, now, issues)
  const referencedTypeIds = new Set(data.notes.map((note) => note.mid))
  for (const typeId of [...types.keys()]) if (!referencedTypeIds.has(typeId)) types.delete(typeId)

  const sourceCardsByNote = new Map<number, CardRow[]>()
  for (const card of data.cards) {
    const cards = sourceCardsByNote.get(card.nid) ?? []
    cards.push(card)
    sourceCardsByNote.set(card.nid, cards)
  }
  const usedDeckIds = new Set(data.cards.map((card) => card.odid || card.did))
  const decks = data.decks.filter((deck) => usedDeckIds.has(deck.id)).map((deck): Deck => ({
    id: stableId('deck', deck.id),
    name: deck.name.replaceAll(fieldSeparator, '::'),
    createdAt: isoFromSeconds(deck.mtimeSecs, now),
    updatedAt: isoFromSeconds(deck.mtimeSecs, now),
  }))
  for (const deck of decks.filter((candidate) => candidate.name.includes('::'))) {
    issues.push({ severity: 'info', code: 'deck-hierarchy', subject: deck.name, detail: `Preserved nested deck path ${deck.name}.` })
  }
  const deckBySource = new Map(data.decks.map((deck) => [deck.id, stableId('deck', deck.id)]))
  const sourceMedia = new Map(data.media.map((media) => [media.name, media]))
  const noteTypes: NoteType[] = [...types.values()].map((type) => ({ id: type.localId, name: type.name, kind: type.kind, fields: type.fields, templates: type.templates, protected: false, createdAt: type.createdAt, updatedAt: type.updatedAt }))
  const notes: Note[] = []
  const cards: CardRecord[] = []
  const reviews: ReviewEntry[] = []
  const references: NoteMediaReference[] = []
  const blobs = new Map<string, StoredMedia>()
  const sourceCardIds = new Map<number, string>()
  const imageOcclusionTypes = new Set<number>()

  for (const row of data.notes) {
    const sourceType = types.get(row.mid)
    if (!sourceType) {
      issues.push({ severity: 'error', code: 'note-skipped', subject: row.guid, detail: `Note uses unsupported note type ${row.mid}.` })
      continue
    }
    const sourceCards = sourceCardsByNote.get(row.id) ?? []
    const firstCard = sourceCards[0]
    const deckId = firstCard ? deckBySource.get(firstCard.odid || firstCard.did) : undefined
    if (!deckId) {
      issues.push({ severity: 'error', code: 'deck-missing', subject: row.guid, detail: 'Note has no supported home deck.' })
      continue
    }
    const rawFields = row.flds.split(fieldSeparator)
    if (rawFields.length !== sourceType.fields.length) {
      issues.push({ severity: 'error', code: 'malformed-field-count', subject: row.guid, detail: `Note has ${rawFields.length} fields but ${sourceType.name} requires ${sourceType.fields.length}.` })
      continue
    }
    rawFields.forEach((value, index) => {
      const unsupportedHtml = value.replace(/<img\b[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '').match(/<[^>]+>/)
      if (unsupportedHtml) issues.push({ severity: 'warning', code: 'field-html-normalized', subject: `${row.guid} · ${sourceType.fields[index].name}`, detail: `Field HTML ${unsupportedHtml[0]} was converted to plain text because imported field markup is outside the supported template subset.` })
    })
    const noteId = stableId('note', row.guid)
    const noteCreatedAt = isoFromSeconds(Math.floor(row.id / 1000), now)
    const noteUpdatedAt = isoFromSeconds(row.mod, now)
    const referenceUpdatedAt = sourceType.updatedAt > noteUpdatedAt ? sourceType.updatedAt : noteUpdatedAt
    let noteTypeId = sourceType.localId
    let fields = Object.fromEntries(sourceType.fields.map((field, index) => [field.id, plainField(rawFields[index] ?? '')]))
    let imageOcclusion: Note['imageOcclusion']
    const fieldByName = Object.fromEntries(sourceType.fields.map((field, index) => [field.name, rawFields[index] ?? '']))
    if (sourceType.stockKind === 6 || ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'].every((name) => name in fieldByName)) {
      try {
        const parsed = parseAnkiImageOcclusion(fieldByName as unknown as AnkiImageOcclusionFields)
        const media = sourceMedia.get(parsed.imageName)
        const mime = media && mimeType(media.name)
        if (!media || !mime || !mime.startsWith('image/')) throw new Error(`Image occlusion source “${parsed.imageName}” is missing or unsupported`)
        validateMedia(new File([ownedBuffer(media.data)], media.name, { type: mime }))
        validateMediaBytes(media.data, mime)
        const dimensions = imageDimensions(media.data)
        if (!dimensions) throw new Error(`Image dimensions for “${parsed.imageName}” could not be read`)
        const digest = await digestMedia(new Blob([ownedBuffer(media.data)], { type: mime }))
        const referenceId = `${noteId}:image-occlusion-source`
        noteTypeId = 'image-occlusion'
        fields = { header: parsed.header, backExtra: [parsed.backExtra, parsed.comments].filter(Boolean).join('\n') }
        imageOcclusion = { version: 1, sourceMediaId: referenceId, imageWidth: dimensions.width, imageHeight: dimensions.height, nextOrdinal: Math.max(...parsed.masks.map((mask) => mask.ordinal)) + 1, masks: parsed.masks }
        references.push({ id: referenceId, noteId, digest, kind: 'image', mimeType: mime, displayName: media.name, side: 'front', playback: 'manual', createdAt: noteCreatedAt, updatedAt: referenceUpdatedAt })
        blobs.set(digest, { digest, blob: ownedBuffer(media.data), byteLength: media.data.byteLength, mimeType: mime, verifiedAt: importedAt })
        imageOcclusionTypes.add(sourceType.id)
      } catch (reason) {
        issues.push({ severity: 'error', code: 'unsupported-image-occlusion', subject: row.guid, detail: reason instanceof Error ? reason.message : 'Unable to import image occlusion' })
        continue
      }
    }
    const note: Note = { id: noteId, deckId, type: noteTypeId === 'basic' ? 'basic' : 'custom', typeId: noteTypeId, fields, tags: row.tags.trim() ? row.tags.trim().split(/\s+/) : [], ...(imageOcclusion ? { imageOcclusion } : {}), createdAt: noteCreatedAt, updatedAt: noteUpdatedAt }
    notes.push(note)

    if (!imageOcclusion) {
      for (let fieldIndex = 0; fieldIndex < rawFields.length; fieldIndex += 1) {
        const names = mediaNames(rawFields[fieldIndex] ?? '')
        const fieldName = sourceType.fields[fieldIndex]?.name
        for (const name of names) {
          const media = sourceMedia.get(name)
          const mime = media && mimeType(media.name)
          if (!media || !mime) {
            issues.push({ severity: 'warning', code: 'media-unsupported', subject: name, detail: media ? 'Media type is not supported by the offline reviewer.' : 'Referenced media is missing from the package.' })
            continue
          }
          const mediaFile = new File([ownedBuffer(media.data)], media.name, { type: mime })
          try { validateMedia(mediaFile) } catch (reason) {
            issues.push({ severity: 'warning', code: 'media-unsupported', subject: name, detail: reason instanceof Error ? reason.message : 'Media is unsupported' })
            continue
          }
          try { validateMediaBytes(media.data, mime) } catch (reason) {
            issues.push({ severity: 'error', code: 'media-malformed', subject: name, detail: reason instanceof Error ? reason.message : 'Media bytes are malformed' })
            continue
          }
          const digest = await digestMedia(mediaFile)
          blobs.set(digest, { digest, blob: ownedBuffer(media.data), byteLength: media.data.byteLength, mimeType: mime, verifiedAt: importedAt })
          const placements: Array<{ side: MediaSide; templateId?: string }> = []
          for (const template of sourceType.templates) {
            if (fieldName && fieldUsed(template.front, fieldName)) placements.push({ side: 'front', templateId: template.id })
            if (fieldName && fieldUsed(template.back, fieldName)) placements.push({ side: 'back', templateId: template.id })
          }
          if (!placements.length) placements.push({ side: 'front' })
          for (const { side, templateId } of placements) references.push({
            id: `${noteId}:media:${templateId ?? 'all'}:${side}:${encodeURIComponent(name)}`,
            noteId,
            digest,
            kind: mediaKind(mime),
            mimeType: mime,
            displayName: name,
            side,
            ...(templateId ? { templateId } : {}),
            inline: true,
            playback: mime.startsWith('audio/') ? 'automatic' : 'manual',
            createdAt: note.createdAt,
            updatedAt: referenceUpdatedAt,
          })
        }
      }
    }

    const latestReviewByCard = new Map<number, number>()
    for (const review of data.revlog) latestReviewByCard.set(review.cid, Math.max(latestReviewByCard.get(review.cid) ?? 0, review.id))
    for (const sourceCard of sourceCards) {
      if (![0, 1, 2, 3].includes(sourceCard.type)) {
        issues.push({ severity: 'error', code: 'unsupported-card-state', subject: String(sourceCard.id), detail: `Card type ${sourceCard.type} is not supported.` })
        continue
      }
      const deck = deckBySource.get(sourceCard.odid || sourceCard.did)
      if (!deck) continue
      const isOcclusion = Boolean(imageOcclusion)
      const template = isOcclusion ? { id: 'image-occlusion' } : sourceType.kind === 'cloze' ? sourceType.templates[0] : sourceType.templates[sourceCard.ord]
      if (!template) {
        issues.push({ severity: 'error', code: 'card-template-missing', subject: String(sourceCard.id), detail: `Card ordinal ${sourceCard.ord} has no template.` })
        continue
      }
      const ordinal = sourceCard.ord + 1
      const mask = imageOcclusion?.masks.find((candidate) => candidate.ordinal === ordinal)
      if (isOcclusion && !mask) {
        issues.push({ severity: 'error', code: 'occlusion-card-missing', subject: String(sourceCard.id), detail: `No supported rectangular mask exists for card ordinal ${sourceCard.ord}.` })
        continue
      }
      const cardId = isOcclusion ? `${noteId}:image-occlusion:m${mask!.id}` : sourceType.kind === 'cloze' ? `${noteId}:${template.id}:c${ordinal}` : `${noteId}:${template.id}`
      sourceCardIds.set(sourceCard.id, cardId)
      const memory = memoryState(sourceCard)
      const lastReviewMs = latestReviewByCard.get(sourceCard.id)
      cards.push({
        id: cardId,
        deckId: deck,
        noteId,
        templateId: template.id,
        ...(sourceType.kind === 'cloze' && !isOcclusion ? { clozeOrdinal: ordinal } : {}),
        ...(mask ? { occlusionId: mask.id, occlusionOrdinal: mask.ordinal } : {}),
        ...(sourceCard.queue < 0 ? { suspended: true } : {}),
        due: cardDue(sourceCard, data, now),
        stability: memory.stability ?? (sourceCard.type === 2 ? Math.max(0, sourceCard.ivl) : 0),
        difficulty: memory.difficulty ?? (sourceCard.factor >= 100 && sourceCard.factor <= 1100 ? sourceCard.factor / 100 : 0),
        elapsedDays: lastReviewMs ? Math.max(0, Math.floor((now.getTime() - lastReviewMs) / day)) : 0,
        scheduledDays: Math.max(0, sourceCard.ivl),
        learningSteps: Math.max(0, sourceCard.left % 1000),
        reps: Math.max(0, sourceCard.reps),
        lapses: Math.max(0, sourceCard.lapses),
        state: cardState(sourceCard.type),
        lastReview: lastReviewMs ? new Date(lastReviewMs).toISOString() : null,
        sourceModifiedAt: isoFromSeconds(sourceCard.mod, now),
      })
      if (sourceCard.queue < -1) issues.push({ severity: 'warning', code: 'buried-as-suspended', subject: String(sourceCard.id), detail: 'Buried card imported as suspended because temporary bury state is not represented locally.' })
      if (sourceCard.reps > 0 && memory.stability === undefined) issues.push({ severity: 'warning', code: 'scheduler-fallback', subject: String(sourceCard.id), detail: 'No FSRS memory state was present; the Anki interval was retained as fallback stability.' })
      if (memory.stability !== undefined && memory.difficulty !== undefined) issues.push({ severity: 'info', code: 'scheduling-mapped', subject: String(sourceCard.id), detail: 'Preserved due state, counters, and FSRS memory state.' })
    }
  }

  const previousReviewByCard = new Map<number, { reviewedAt: number; elapsedDays: number }>()
  for (const row of [...data.revlog].sort((left, right) => left.id - right.id)) {
    const cardId = sourceCardIds.get(row.cid)
    const card = cards.find((candidate) => candidate.id === cardId)
    if (!cardId || !card || row.ease < 1 || row.ease > 4) {
      issues.push({ severity: 'warning', code: 'review-unsupported', subject: String(row.id), detail: card ? 'Manual or malformed review entry was not imported.' : 'Review belongs to a card that could not be imported.' })
      continue
    }
    const reviewedAt = new Date(row.id).toISOString()
    const previous = previousReviewByCard.get(row.cid)
    const elapsedDays = previous ? Math.max(0, Math.floor((row.id - previous.reviewedAt) / day)) : 0
    const scheduledDays = intervalDays(row.lastIvl)
    reviews.push({
      id: stableId('review', row.id),
      cardId,
      deckId: card.deckId,
      rating: row.ease,
      state: reviewState(row),
      due: new Date(previous ? previous.reviewedAt + intervalMilliseconds(row.lastIvl) : row.id).toISOString(),
      stability: scheduledDays,
      difficulty: row.factor >= 100 && row.factor <= 1100 ? row.factor / 100 : card.difficulty,
      elapsedDays,
      lastElapsedDays: previous?.elapsedDays ?? 0,
      scheduledDays,
      learningSteps: 0,
      reviewedAt,
    })
    previousReviewByCard.set(row.cid, { reviewedAt: row.id, elapsedDays })
    if (!previous) issues.push({ severity: 'warning', code: 'first-review-approximation', subject: String(row.id), detail: 'Anki does not retain the original due and FSRS memory state before the first review log; its review time and prior interval are used as the supported approximation.' })
    if (row.type > 2) issues.push({ severity: 'warning', code: 'review-kind-fallback', subject: String(row.id), detail: 'Filtered or manual review kind was retained as review history without its special queue semantics.' })
  }

  for (const typeId of imageOcclusionTypes) {
    const index = noteTypes.findIndex((type) => type.id === stableId('note-type', typeId))
    if (index >= 0) noteTypes.splice(index, 1)
  }
  const referencedNames = new Set(references.map((reference) => reference.displayName))
  for (const media of data.media) if (!referencedNames.has(media.name)) issues.push({ severity: 'warning', code: 'media-unreferenced', subject: media.name, detail: 'Unreferenced or template-static media is reported but not attached to a note.' })

  const writes: ImportWrites = { decks: [], noteTypes: [], notes: [], cards: [], reviews: [], references: [], deletedReferences: [], blobs: [] }
  const snapshots: Snapshot[] = []
  const duplicates: AnkiDuplicateSummary = { create: 0, update: 0, keepLocal: 0, unchanged: 0 }
  async function decide<T extends { id: string; updatedAt?: string }>(table: 'decks' | 'noteTypes' | 'notes' | 'noteMedia', value: T) {
    const existing = await collection[table].get(value.id as never) as T | undefined
    snapshots.push({ table, id: value.id, value: fingerprint(existing) })
    if (!existing) return 'create' as const
    if (fingerprint(existing) === fingerprint(value)) return 'unchanged' as const
    return Date.parse(value.updatedAt ?? '') > Date.parse(existing.updatedAt ?? '') ? 'update' as const : 'keepLocal' as const
  }
  for (const value of decks) {
    const action = await decide('decks', value)
    if (action === 'create' || action === 'update') writes.decks.push({ value, action })
  }
  const noteTypeDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  for (const value of noteTypes) {
    const action = await decide('noteTypes', value)
    noteTypeDecisions.set(value.id, action)
    if (action === 'create' || action === 'update') writes.noteTypes.push({ value, action })
  }
  const noteDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  for (const value of notes) {
    const action = await decide('notes', value)
    noteDecisions.set(value.id, action)
    duplicates[action] += 1
    if (action === 'create' || action === 'update') writes.notes.push({ value, action })
  }
  for (const value of cards) {
    const existing = await collection.cards.get(value.id)
    snapshots.push({ table: 'cards', id: value.id, value: fingerprint(existing) })
    if (!existing) writes.cards.push({ value, action: 'create' })
    else {
      const incomingModified = Date.parse(value.sourceModifiedAt ?? '')
      const previousSourceModified = Date.parse(existing.sourceModifiedAt ?? '')
      const localReview = Date.parse(existing.lastReview ?? '')
      const sourceIsNewer = Number.isFinite(incomingModified) && (!Number.isFinite(previousSourceModified) || incomingModified > previousSourceModified)
      const localScheduleIsNotNewer = !Number.isFinite(localReview) || localReview <= incomingModified
      if ((sourceIsNewer && localScheduleIsNotNewer) || (!existing.lastReview && value.lastReview)) writes.cards.push({ value, action: 'update' })
    }
  }
  const incomingCardIds = new Set(cards.map(({ id }) => id))
  const reconcilableNoteIds = new Set(notes.filter((note) => noteDecisions.get(note.id) !== 'keepLocal' && noteTypeDecisions.get(note.typeId) !== 'keepLocal').map(({ id }) => id))
  for (const noteId of reconcilableNoteIds) {
    for (const existing of await collection.cards.where('noteId').equals(noteId).toArray()) {
      if (incomingCardIds.has(existing.id) || existing.suspended) continue
      snapshots.push({ table: 'cards', id: existing.id, value: fingerprint(existing) })
      writes.cards.push({ value: { ...existing, suspended: true }, action: 'update' })
    }
  }
  for (const value of reviews) {
    const existing = await collection.reviewEntries.get(value.id)
    snapshots.push({ table: 'reviewEntries', id: value.id, value: fingerprint(existing) })
    if (!existing) writes.reviews.push(value)
  }
  const mediaReconcileNoteIds = new Set(notes.filter((note) => {
    const noteAction = noteDecisions.get(note.id)
    return noteAction === 'create' || noteAction === 'update' || (noteAction === 'unchanged' && noteTypeDecisions.get(note.typeId) === 'update')
  }).map(({ id }) => id))
  for (const value of references) {
    const noteAction = noteDecisions.get(value.noteId)
    if (!mediaReconcileNoteIds.has(value.noteId) || noteAction === 'keepLocal') continue
    const action = await decide('noteMedia', value)
    if (action === 'create' || action === 'update') writes.references.push({ value, action })
  }
  const incomingReferenceIds = new Set(references.map(({ id }) => id))
  for (const noteId of mediaReconcileNoteIds) {
    for (const existing of await collection.noteMedia.where('noteId').equals(noteId).toArray()) {
      const importedReference = existing.id.startsWith(`${noteId}:media:`) || existing.id === `${noteId}:image-occlusion-source`
      if (!importedReference || incomingReferenceIds.has(existing.id)) continue
      snapshots.push({ table: 'noteMedia', id: existing.id, value: fingerprint(existing) })
      writes.deletedReferences.push(existing)
    }
  }
  for (const value of blobs.values()) {
    const existing = await collection.mediaBlobs.get(value.digest)
    snapshots.push({ table: 'mediaBlobs', id: value.digest, value: fingerprint(existing) })
    if (!existing) writes.blobs.push(value)
  }

  return new PreparedAnkiImport(file.name, {
    decks: decks.length,
    noteTypes: noteTypes.length + imageOcclusionTypes.size,
    notes: notes.length,
    cards: cards.length,
    reviews: reviews.length,
    media: data.media.length,
  }, duplicates, issues, collection, writes, snapshots, importedAt)
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 30 && textDecoder.decode(bytes.slice(0, 4)) === 'RIFF' && textDecoder.decode(bytes.slice(8, 12)) === 'WEBP') {
    const kind = textDecoder.decode(bytes.slice(12, 16))
    if (kind === 'VP8X') return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3]
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: (bytes[offset + 5] << 8) + bytes[offset + 6], width: (bytes[offset + 7] << 8) + bytes[offset + 8] }
      if (length < 2) break
      offset += 2 + length
    }
  }
  return undefined
}
