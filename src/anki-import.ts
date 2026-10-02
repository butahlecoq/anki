import type { SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { CardRow, CollectionData, RevlogRow } from 'ankipack'
import { DEFAULT_DECK_OPTION_GROUP_ID, State, type CardRecord, type Collection, type Deck, type Note, type NoteMediaReference, type NoteType, type ReviewEntry, type SyncOperation } from './collection'
import { parseAnkiImageOcclusion, type AnkiImageOcclusionFields } from './image-occlusion-interchange'
import { digestMedia, validateMedia, type MediaKind, type MediaSide } from './media'
import { validateTemplate } from './template-renderer'
import { supportedNavigationTemplate } from './template-navigation'
import { ANKI_ARCHIVE_LIMITS, validateAnkiArchive } from './anki-archive'
import { readKirokuSchedule, readKirokuReview } from './anki-scheduling-metadata'

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

export type AnkiImportDecisionAction = 'create' | 'update' | 'keepLocal' | 'unchanged' | 'delete'
export type AnkiImportEntity = 'deck' | 'noteType' | 'note' | 'card' | 'review' | 'mediaReference'
export interface AnkiImportDecision { entity: AnkiImportEntity; id: string; action: AnkiImportDecisionAction }

export interface AnkiImportProjection {
  decks: Deck[]
  noteTypes: NoteType[]
  notes: Note[]
  cards: CardRecord[]
  reviews: ReviewEntry[]
  references: NoteMediaReference[]
}

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

export interface AnkiImportPlan {
  summary: AnkiImportSummary
  duplicates: AnkiDuplicateSummary
  issues: AnkiImportIssue[]
  blocksImport: boolean
  decisions: AnkiImportDecision[]
  writes: {
    decks: ImportWrites['decks']
    noteTypes: ImportWrites['noteTypes']
    notes: ImportWrites['notes']
    cards: ImportWrites['cards']
    reviews: Array<{ value: ReviewEntry; action: 'create' }>
    references: ImportWrites['references']
    deletedReferences: NoteMediaReference[]
    blobs: Array<Omit<StoredMedia, 'blob'>>
  }
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
      const nativeOcclusion = protobufNumber(config, 9) === 6
      if (nativeOcclusion) {
        if (kind !== 'cloze' || fields.map((field) => field.name).join('|') !== 'Occlusion|Image|Header|Back Extra|Comments') throw new Error('Unsupported native image occlusion field layout')
        // Native templates call Anki's own runtime. The app reconstructs its
        // supported geometric renderer from fields and never executes imported
        // template scripts. Do not persist those scripts as editable templates.
        for (const template of templates) { template.front = '{{cloze:Occlusion}}'; template.back = '{{cloze:Occlusion}}'; template.css = '' }
        issues.push({ severity: 'info', code: 'native-occlusion-renderer', subject: row.name, detail: 'Supported native image occlusion fields use the app’s geometric renderer. Native template scripts and styles are not executed or retained.' })
      }
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

export function validateMediaBytes(bytes: Uint8Array, mime: string) {
  const text = (start: number, end: number) => textDecoder.decode(bytes.slice(start, end))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const valid = mime === 'image/png' ? bytes.length >= 45
      && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
      && text(12, 16) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(20) > 0
      && bytes.slice(-8).every((byte, index) => byte === [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82][index])
    : mime === 'image/jpeg' ? bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 && Boolean(imageDimensions(bytes))
      : mime === 'image/webp' ? bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' && view.getUint32(4, true) + 8 <= bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 16)) && 20 + view.getUint32(16, true) <= bytes.length && Boolean(imageDimensions(bytes))
        : mime === 'audio/wav' ? validWav(bytes)
          : mime === 'audio/ogg' ? validOgg(bytes)
            : mime === 'audio/mpeg' ? validMp3(bytes)
              : false
  if (!valid) throw new Error(`“${mime}” bytes do not match the declared media format.`)
}

function validMp3(bytes: Uint8Array) {
  let offset = 0
  if (textDecoder.decode(bytes.slice(0, 3)) === 'ID3') {
    if (bytes.length < 10 || bytes.slice(6, 10).some((byte) => byte > 0x7f)) return false
    offset = 10 + bytes.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0) + (bytes[5] & 0x10 ? 10 : 0)
  }
  let frames = 0
  while (offset < bytes.length) {
    if (bytes.length - offset === 128 && textDecoder.decode(bytes.slice(offset, offset + 3)) === 'TAG') return frames > 0
    const frameLength = mp3FrameLength(bytes, offset)
    if (!frameLength || offset + frameLength > bytes.length) return false
    offset += frameLength
    frames += 1
  }
  return frames > 0
}

function mp3FrameLength(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return 0
  const version = (bytes[offset + 1] >> 3) & 0x03
  const layer = (bytes[offset + 1] >> 1) & 0x03
  const bitrateIndex = bytes[offset + 2] >> 4
  const rateIndex = (bytes[offset + 2] >> 2) & 0x03
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0
  const mpeg1Bitrates = layer === 3
    ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
    : layer === 2
      ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
      : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  const laterBitrates = layer === 3
    ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const bitrate = (version === 3 ? mpeg1Bitrates : laterBitrates)[bitrateIndex] * 1000
  const sampleRate = [44_100, 48_000, 32_000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const padding = (bytes[offset + 2] >> 1) & 1
  return layer === 3
    ? Math.floor((12 * bitrate / sampleRate) + padding) * 4
    : Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate / sampleRate) + padding)
}

function validOgg(bytes: Uint8Array) {
  let offset = 0
  let sawEnd = false
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || textDecoder.decode(bytes.slice(offset, offset + 4)) !== 'OggS' || bytes[offset + 4] !== 0) return false
    const segments = bytes[offset + 26]
    if (offset + 27 + segments > bytes.length) return false
    const payload = bytes.slice(offset + 27, offset + 27 + segments).reduce((total, byte) => total + byte, 0)
    if (offset + 27 + segments + payload > bytes.length) return false
    sawEnd ||= Boolean(bytes[offset + 5] & 0x04)
    offset += 27 + segments + payload
  }
  return offset === bytes.length && sawEnd
}

function validWav(bytes: Uint8Array) {
  if (bytes.length < 12 || textDecoder.decode(bytes.slice(0, 4)) !== 'RIFF' || textDecoder.decode(bytes.slice(8, 12)) !== 'WAVE') return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 > bytes.length) return false
  let offset = 12
  let format = false
  let audio = false
  while (offset + 8 <= bytes.length) {
    const name = textDecoder.decode(bytes.slice(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    const end = offset + 8 + size
    if (end > bytes.length) return false
    if (name === 'fmt ' && size >= 16) format = true
    if (name === 'data' && size > 0) audio = true
    offset = end + (size % 2)
  }
  return format && audio && offset >= bytes.length
}

function validateSupportedTemplateMarkup(front: string, back: string, css: string) {
  const html = `${front}\n${back}`
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const element of document.querySelectorAll('*')) {
    if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'FORM'].includes(element.tagName) || [...element.attributes].some((attribute) => attribute.name.toLocaleLowerCase().startsWith('on'))) throw new Error('Executable or embedded template markup is unsupported')
    for (const attribute of ['src', 'href', 'srcset', 'poster']) {
      const value = element.getAttribute(attribute)?.trim()
      if (attribute === 'href' && element.tagName === 'A' && value) {
        if (!supportedNavigationTemplate(value)) throw new Error('Navigation links must use HTTPS URLs without credentials')
        continue
      }
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
  /** A detached description of the proposed changes. It deliberately contains
   * no collection handle and omits binary media payloads. */
  readonly plan: AnkiImportPlan
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
    private readonly projection: AnkiImportProjection,
    decisions: AnkiImportDecision[],
  ) {
    this.filename = filename
    this.summary = summary
    this.duplicates = duplicates
    this.issues = issues
    this.plan = structuredClone({
      summary,
      duplicates,
      issues,
      blocksImport: issues.some((issue) => issue.severity === 'error'),
      decisions,
      writes: {
        decks: writes.decks,
        noteTypes: writes.noteTypes,
        notes: writes.notes,
        cards: writes.cards,
        reviews: writes.reviews.map((value) => ({ value, action: 'create' as const })),
        references: writes.references,
        deletedReferences: writes.deletedReferences,
        blobs: writes.blobs.map(({ digest, byteLength, mimeType, verifiedAt }) => ({ digest, byteLength, mimeType, verifiedAt })),
      },
    })
  }

  /** Returns the normalized app projection without applying it to the target
   * collection. Account writeback uses this as the comparable native base. */
  projectedEntities(): AnkiImportProjection {
    return structuredClone(this.projection)
  }

  async commit(): Promise<void> {
    if (this.committed) throw new Error('This package has already been imported')
    if (this.issues.some((issue) => issue.severity === 'error')) throw new Error('Resolve package errors before importing')
    const collection = this.collection
    await collection.transaction('rw', [collection.decks, collection.noteTypes, collection.notes, collection.cards, collection.reviewEntries, collection.noteMedia, collection.mediaBlobs, collection.outbox, collection.syncRevisions], async () => {
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
      if (operations.length) await collection.enqueueOperations(operations)
    })
    this.committed = true
  }
}

async function prepareAnkiImportInternal(file: File | undefined, collection: Collection, options: PrepareAnkiImportOptions, sourceData?: CollectionData): Promise<PreparedAnkiImport> {
  if (!sourceData && (!file || !/\.(apkg|colpkg)$/i.test(file.name))) throw new Error('Choose an Anki .apkg or .colpkg package')
  if (!sourceData && !file?.size) throw new Error('The selected Anki package is empty')
  if (!sourceData && file!.size > ANKI_ARCHIVE_LIMITS.compressedBytes) throw new Error('The selected Anki package is larger than the 128 MiB compressed import limit')
  const now = options.now ?? new Date()
  const importedAt = now.toISOString()
  let data: CollectionData
  if (sourceData) data = sourceData
  else {
    try {
      const bytes = new Uint8Array(await blobBytes(file!))
      validateAnkiArchive(bytes)
      const SQL = options.SQL ?? await browserSql()
      const { Collection: AnkiPackageCollection } = await import('ankipack')
      data = AnkiPackageCollection.open(bytes, SQL).data
    } catch (reason) {
      console.error('Anki package preview failed', reason)
      throw new Error(`Unable to read “${file!.name}”: ${reason instanceof Error ? reason.message : 'invalid Anki package'}`)
    }
  }
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
  const sourceDeckById = new Map(data.decks.map((deck) => [deck.id, deck]))
  const sourceDeckByName = new Map(data.decks.map((deck) => [deck.name.replaceAll(fieldSeparator, '::'), deck]))
  const deckRecords = new Map<string, Deck>()
  const deckBySource = new Map<number, string>()
  for (const sourceDeckId of usedDeckIds) {
    const sourceDeck = sourceDeckById.get(sourceDeckId)
    if (!sourceDeck) continue
    const fullName = sourceDeck.name.replaceAll(fieldSeparator, '::')
    const segments = fullName.split('::')
    if (segments.some((segment) => !segment.trim())) {
      issues.push({ severity: 'error', code: 'deck-hierarchy-malformed', subject: fullName, detail: 'Deck hierarchy contains an empty name segment.' })
      continue
    }
    let parentId: string | null = null
    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join('::')
      const matched = sourceDeckByName.get(path)
      const id = matched ? stableId('deck', matched.id) : `anki-deck-path:${encodeURIComponent(path)}`
      const timestamps = matched ?? sourceDeck
      if (!deckRecords.has(id)) deckRecords.set(id, {
        id,
        name: segments[index],
        parentId,
        optionGroupId: DEFAULT_DECK_OPTION_GROUP_ID,
        createdAt: isoFromSeconds(timestamps.mtimeSecs, now),
        updatedAt: isoFromSeconds(timestamps.mtimeSecs, now),
      })
      parentId = id
    }
    deckBySource.set(sourceDeckId, parentId!)
    if (segments.length > 1) issues.push({ severity: 'info', code: 'deck-hierarchy', subject: fullName, detail: `Preserved nested deck path ${fullName}.` })
  }
  const decks = [...deckRecords.values()]
  const sourceMedia = new Map(data.media.map((media) => [media.name, media]))
  const noteTypes: NoteType[] = [...types.values()].map((type) => ({ id: type.localId, name: type.name, kind: type.kind, fields: type.fields, templates: type.templates, protected: false, createdAt: type.createdAt, updatedAt: type.updatedAt }))
  const notes: Note[] = []
  const cards: CardRecord[] = []
  const reviews: ReviewEntry[] = []
  const references: NoteMediaReference[] = []
  const nativeReferencedNames = new Set<string>()
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
    const note: Note = { id: noteId, ankiId: row.id, deckId, type: noteTypeId === 'basic' ? 'basic' : 'custom', typeId: noteTypeId, fields, tags: row.tags.trim() ? row.tags.trim().split(/\s+/) : [], ...(imageOcclusion ? { imageOcclusion } : {}), createdAt: noteCreatedAt, updatedAt: noteUpdatedAt }
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
    for (const reference of references.filter((reference) => reference.noteId === noteId)) nativeReferencedNames.add(reference.displayName)
    // Native markup remains portable; Kiroku exports also retain attachment
    // placement/playback so a clean re-import restores the original editor data.
    try {
      const metadata: unknown = JSON.parse(row.data || '{}')
      if (metadata && typeof metadata === 'object' && 'kirokuNoteTimes' in metadata) {
        const times = metadata.kirokuNoteTimes as Record<string, unknown>
        if (!times || typeof times.createdAt !== 'string' || typeof times.updatedAt !== 'string' || !Number.isFinite(Date.parse(times.createdAt)) || !Number.isFinite(Date.parse(times.updatedAt))) throw new Error('Invalid exported note timestamps')
        note.createdAt = new Date(times.createdAt).toISOString()
        note.updatedAt = new Date(times.updatedAt).toISOString()
      }
      if (metadata && typeof metadata === 'object' && 'kirokuMedia' in metadata) {
        if (!Array.isArray(metadata.kirokuMedia)) throw new Error('Invalid exported media metadata')
        for (const hint of metadata.kirokuMedia as unknown[]) {
          if (!hint || typeof hint !== 'object') throw new Error('Invalid exported media placement')
          const value = hint as Record<string, unknown>
          if (typeof value.name !== 'string' || typeof value.displayName !== 'string' || !value.displayName || (value.inline && /[<>[\]\r\n]/.test(value.displayName)) || !['front', 'back'].includes(String(value.side)) || typeof value.inline !== 'boolean' || !['manual', 'automatic'].includes(String(value.playback)) || !(value.templateOrd === null || (typeof value.templateOrd === 'number' && Number.isInteger(value.templateOrd) && value.templateOrd >= 0 && value.templateOrd < sourceType.templates.length))) throw new Error('Invalid exported media placement')
          for (const reference of references.filter((reference) => reference.noteId === noteId && reference.displayName === value.name && reference.side === value.side && (value.templateOrd === null || reference.templateId === sourceType.templates[value.templateOrd as number]?.id))) {
            reference.displayName = value.displayName
            reference.inline = value.inline
            reference.playback = value.playback as 'manual' | 'automatic'
            if (value.templateOrd === null) delete reference.templateId
          }
          for (const key of Object.keys(note.fields)) note.fields[key] = note.fields[key].split(`[[kiroku-media:${value.name}]]`).join(value.inline ? `[[kiroku-media:${value.displayName}]]` : '')
        }
      }
    } catch (reason) {
      // Opaque native note data is permitted; our explicit metadata is checked.
      if (row.data.includes('kirokuMedia') || row.data.includes('kirokuNoteTimes')) issues.push({ severity: 'error', code: 'invalid-export-media', subject: row.guid, detail: reason instanceof Error ? reason.message : 'Invalid exported media metadata' })
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
      let exportedSchedule: Partial<CardRecord> = {}
      try { exportedSchedule = readKirokuSchedule(sourceCard) } catch (reason) {
        issues.push({ severity: 'error', code: 'invalid-export-schedule', subject: String(sourceCard.id), detail: reason instanceof Error ? reason.message : 'Invalid exported schedule' })
      }
      const lastReviewMs = latestReviewByCard.get(sourceCard.id)
      cards.push({
        id: cardId,
        ankiId: sourceCard.id,
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
        flag: sourceCard.flags & 7,
        ...exportedSchedule,
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
    let exportedReview: Partial<ReviewEntry> = {}
    try { exportedReview = readKirokuReview(data.cards.find((card) => card.id === row.cid)?.data ?? '', row) } catch (reason) {
      issues.push({ severity: 'error', code: 'invalid-export-review', subject: String(row.id), detail: reason instanceof Error ? reason.message : 'Invalid exported review' })
    }
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
      ...(Number.isFinite(row.time) && row.time >= 0 ? { durationMs: row.time } : {}),
      ...(row.type === 3 ? { rescheduled: false } : {}),
      ...exportedReview,
    })
    previousReviewByCard.set(row.cid, { reviewedAt: row.id, elapsedDays })
    if (!previous) issues.push({ severity: 'warning', code: 'first-review-approximation', subject: String(row.id), detail: 'Anki does not retain the original due and FSRS memory state before the first review log; its review time and prior interval are used as the supported approximation.' })
    if (row.type > 2) issues.push({ severity: 'warning', code: 'review-kind-fallback', subject: String(row.id), detail: 'Filtered or manual review kind was retained as review history without its special queue semantics.' })
  }

  for (const typeId of imageOcclusionTypes) {
    const index = noteTypes.findIndex((type) => type.id === stableId('note-type', typeId))
    if (index >= 0) noteTypes.splice(index, 1)
  }
  const referencedNames = new Set([...references.map((reference) => reference.displayName), ...nativeReferencedNames])
  for (const media of data.media) if (!referencedNames.has(media.name)) issues.push({ severity: 'warning', code: 'media-unreferenced', subject: media.name, detail: 'Unreferenced or template-static media is reported but not attached to a note.' })

  const writes: ImportWrites = { decks: [], noteTypes: [], notes: [], cards: [], reviews: [], references: [], deletedReferences: [], blobs: [] }
  const snapshots: Snapshot[] = []
  const decisions: AnkiImportDecision[] = []
  const recordDecision = (entity: AnkiImportEntity, id: string, action: AnkiImportDecisionAction) => decisions.push({ entity, id, action })
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
    recordDecision('deck', value.id, action)
    if (action === 'create' || action === 'update') writes.decks.push({ value, action })
  }
  const noteTypeDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  for (const value of noteTypes) {
    const action = await decide('noteTypes', value)
    recordDecision('noteType', value.id, action)
    noteTypeDecisions.set(value.id, action)
    if (action === 'create' || action === 'update') writes.noteTypes.push({ value, action })
  }
  const noteDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  const keptAggregateNoteIds = new Set<string>()
  for (const value of notes) {
    const proposedAction = await decide('notes', value)
    const localTypeWins = noteTypeDecisions.get(value.typeId) === 'keepLocal'
    const existing = localTypeWins ? await collection.notes.get(value.id) : undefined
    const action = localTypeWins ? 'keepLocal' as const : proposedAction
    if (localTypeWins) {
      keptAggregateNoteIds.add(value.id)
      issues.push({
        severity: existing ? 'warning' : 'error',
        code: 'local-note-type-wins',
        subject: value.id,
        detail: existing ? 'Kept the local note, cards, and media because its locally newer note type is incompatible with this package version.' : 'A package note cannot be created against a locally newer, incompatible note type.',
      })
    }
    noteDecisions.set(value.id, action)
    recordDecision('note', value.id, action)
    duplicates[action] += 1
    if (action === 'create' || action === 'update') writes.notes.push({ value, action })
  }
  for (const value of cards) {
    if (keptAggregateNoteIds.has(value.noteId)) { recordDecision('card', value.id, 'keepLocal'); continue }
    const existing = await collection.cards.get(value.id)
    snapshots.push({ table: 'cards', id: value.id, value: fingerprint(existing) })
    if (!existing) { writes.cards.push({ value, action: 'create' }); recordDecision('card', value.id, 'create') }
    else {
      const incomingModified = Date.parse(value.sourceModifiedAt ?? '')
      const previousSourceModified = Date.parse(existing.sourceModifiedAt ?? '')
      const localReview = Date.parse(existing.lastReview ?? '')
      const sourceIsNewer = Number.isFinite(incomingModified) && (!Number.isFinite(previousSourceModified) || incomingModified > previousSourceModified)
      const localScheduleIsNotNewer = !Number.isFinite(localReview) || localReview <= incomingModified
      if ((sourceIsNewer && localScheduleIsNotNewer) || (!existing.lastReview && value.lastReview)) {
        writes.cards.push({ value, action: 'update' })
        recordDecision('card', value.id, 'update')
      } else recordDecision('card', value.id, 'keepLocal')
    }
  }
  const incomingCardIds = new Set(cards.map(({ id }) => id))
  const reconcilableNoteIds = new Set(notes.filter((note) => noteDecisions.get(note.id) !== 'keepLocal' && noteTypeDecisions.get(note.typeId) !== 'keepLocal').map(({ id }) => id))
  for (const noteId of reconcilableNoteIds) {
    for (const existing of await collection.cards.where('noteId').equals(noteId).toArray()) {
      if (incomingCardIds.has(existing.id) || existing.suspended) continue
      snapshots.push({ table: 'cards', id: existing.id, value: fingerprint(existing) })
      writes.cards.push({ value: { ...existing, suspended: true }, action: 'update' })
      recordDecision('card', existing.id, 'update')
    }
  }
  for (const value of reviews) {
    const importedCard = cards.find((card) => card.id === value.cardId)
    if (importedCard && keptAggregateNoteIds.has(importedCard.noteId)) { recordDecision('review', value.id, 'keepLocal'); continue }
    const existing = await collection.reviewEntries.get(value.id)
    snapshots.push({ table: 'reviewEntries', id: value.id, value: fingerprint(existing) })
    if (!existing) { writes.reviews.push(value); recordDecision('review', value.id, 'create') }
    else recordDecision('review', value.id, 'unchanged')
  }
  const mediaReconcileNoteIds = new Set(notes.filter((note) => {
    const noteAction = noteDecisions.get(note.id)
    return noteAction === 'create' || noteAction === 'update' || (noteAction === 'unchanged' && noteTypeDecisions.get(note.typeId) === 'update')
  }).map(({ id }) => id))
  for (const value of references) {
    const noteAction = noteDecisions.get(value.noteId)
    if (!mediaReconcileNoteIds.has(value.noteId) || noteAction === 'keepLocal') { recordDecision('mediaReference', value.id, 'keepLocal'); continue }
    const action = await decide('noteMedia', value)
    recordDecision('mediaReference', value.id, action)
    if (action === 'create' || action === 'update') writes.references.push({ value, action })
  }
  const incomingReferenceIds = new Set(references.map(({ id }) => id))
  for (const noteId of mediaReconcileNoteIds) {
    for (const existing of await collection.noteMedia.where('noteId').equals(noteId).toArray()) {
      const importedReference = existing.id.startsWith(`${noteId}:media:`) || existing.id === `${noteId}:image-occlusion-source`
      if (!importedReference || incomingReferenceIds.has(existing.id)) continue
      snapshots.push({ table: 'noteMedia', id: existing.id, value: fingerprint(existing) })
      writes.deletedReferences.push(existing)
      recordDecision('mediaReference', existing.id, 'delete')
    }
  }
  const eligibleMediaDigests = new Set(references.filter((reference) => !keptAggregateNoteIds.has(reference.noteId)).map((reference) => reference.digest))
  for (const value of blobs.values()) {
    if (!eligibleMediaDigests.has(value.digest)) continue
    const existing = await collection.mediaBlobs.get(value.digest)
    snapshots.push({ table: 'mediaBlobs', id: value.digest, value: fingerprint(existing) })
    if (!existing) writes.blobs.push(value)
  }

  return new PreparedAnkiImport(file?.name ?? 'AnkiWeb account', {
    decks: decks.length,
    noteTypes: noteTypes.length + imageOcclusionTypes.size,
    notes: notes.length,
    cards: cards.length,
    reviews: reviews.length,
    media: data.media.length,
  }, duplicates, issues, collection, writes, snapshots, importedAt, { decks, noteTypes, notes, cards, reviews, references }, decisions)
}

export function prepareAnkiImport(file: File, collection: Collection, options: PrepareAnkiImportOptions = {}) {
  return prepareAnkiImportInternal(file, collection, options)
}

/** Reuses the supported entity/media/scheduling projection without packaging a
 * native account snapshot through an `.apkg` archive. The native SQLite and
 * media databases remain authoritative outside this app-facing preview. */
export function prepareAnkiDataImport(data: CollectionData, collection: Collection, options: PrepareAnkiImportOptions = {}) {
  return prepareAnkiImportInternal(undefined, collection, options, data)
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 20 && textDecoder.decode(bytes.slice(0, 4)) === 'RIFF' && textDecoder.decode(bytes.slice(8, 12)) === 'WEBP') {
    const kind = textDecoder.decode(bytes.slice(12, 16))
    if (kind === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) return { width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10) }
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

