import { blobBytes, mediaTypeForFilename } from '../anki-interchange'
import type { SqlJsStatic } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { CardRow, CollectionData, RevlogRow } from 'ankipack'
import { DEFAULT_DECK_OPTION_GROUP_ID, State, type CardRecord, type Collection, type Deck, type Note, type NoteMediaReference, type NoteType, type ReviewEntry } from './collection'
import { rowFingerprint as fingerprint } from './import-contract'
import { parseAnkiImageOcclusion, type AnkiImageOcclusionFields } from './image-occlusion-interchange'
import { digestMedia, validateMedia, type MediaKind, type MediaSide } from './media'
import { validateTemplate } from './template-renderer'
import { supportedNavigationTemplate } from './template-navigation'
import { decodeFieldText, sanitizeFieldHtml } from './field-html'
import { ANKI_ARCHIVE_LIMITS, validateAnkiArchive } from './anki-archive'
import { readKirokuSchedule, readKirokuReview } from './anki-scheduling-metadata'
import { derivedNativeId, hasLegacyDeckIdentity, nativeIdentity } from './anki-identity'

/** The Deck Path a deck occupies in the app's own hierarchy. */
function deckPath(deck: Deck, byId: ReadonlyMap<string, Deck>, seen = new Set<string>()): string {
  if (seen.has(deck.id)) return deck.name
  seen.add(deck.id)
  const parent = deck.parentId ? byId.get(deck.parentId) : undefined
  return parent ? `${deckPath(parent, byId, seen)}::${deck.name}` : deck.name
}

/**
 * Which identity a Deck Path resolves to, and which local decks it supersedes.
 *
 * A path the package defines keeps the Native Identity it arrived with. A path
 * it names only inside a longer one has none, so it takes the identity derived
 * from the path - unless the app already holds a deck at that path under an
 * identity of its own, which a repeat import should not disturb. Every other
 * local deck at the path is superseded, whether it carries the legacy identity
 * form or is a duplicate this reconciliation is tidying up.
 */
function resolveDeckIdentity(path: string, matchedId: number | undefined, local: readonly Deck[]) {
  // A deck the learner made is already at this Deck Path under an identity of
  // its own. It stands, and the identity it arrived with - or the one derived
  // from the path - is adopted for it, so a repeat import neither renumbers it
  // nor resets the options chosen for it. Every other local deck here is
  // superseded: either one an earlier import left under the legacy form, or a
  // duplicate of the same path.
  const current = local.find((deck) => !hasLegacyDeckIdentity(deck.id))
  const id = current?.id ?? nativeIdentity('deck', matchedId ?? derivedNativeId(`deck-path:${path}`))
  return { id, adopted: local.filter((deck) => deck !== current) }
}

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

export interface AnkiImportSkippedNote {
  noteId: string
  guid: string
  ankiNoteId: number
  noteType: string
  cardIds: number[]
  reviewIds: number[]
  mediaNames: string[]
  reasons: string[]
}

export interface AnkiDuplicateSummary { create: number; update: number; keepLocal: number; unchanged: number }

export type AnkiImportDecisionAction = 'create' | 'update' | 'keepLocal' | 'unchanged' | 'delete' | 'skip'
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
  /** Review entries whose deck reference moved with a rekeyed deck. */
  updatedReviews: ReviewEntry[]
  references: Array<{ value: NoteMediaReference; action: 'create' | 'update' }>
  deletedReferences: NoteMediaReference[]
  deletedDecks: Deck[]
  /** Undo records whose snapshot names a deck this import superseded. */
  undoSettings: Array<{ key: string; value: unknown }>
  blobs: StoredMedia[]
}

export interface AnkiImportPlan {
  summary: AnkiImportSummary
  duplicates: AnkiDuplicateSummary
  issues: AnkiImportIssue[]
  blocksImport: boolean
  canImportRepresentable: boolean
  requiresPartialChoice: boolean
  skipped: AnkiImportSkippedNote[]
  savedPartialChoice: boolean
  decisions: AnkiImportDecision[]
  writes: {
    decks: ImportWrites['decks']
    noteTypes: ImportWrites['noteTypes']
    notes: ImportWrites['notes']
    cards: ImportWrites['cards']
    reviews: Array<{ value: ReviewEntry; action: 'create' }>
    updatedReviews: Array<{ value: ReviewEntry; action: 'update' }>
    references: ImportWrites['references']
    deletedReferences: NoteMediaReference[]
    deletedDecks: ImportWrites['deletedDecks']
    /** Undo records this import would rewrite, named by their settings key. */
    undoSettings: Array<{ key: string }>
    blobs: Array<Omit<StoredMedia, 'blob'>>
  }
}

export interface AnkiImportCommitOptions { importRepresentableOnly?: boolean }

type Snapshot = { table: 'decks' | 'noteTypes' | 'notes' | 'cards' | 'reviewEntries' | 'noteMedia' | 'mediaBlobs'; id: string; value: string }

export interface PrepareAnkiImportOptions { SQL?: SqlJsStatic; now?: Date; sourceIdentity?: string; sourceFingerprint?: string }

interface PersistedPartialChoice {
  version: 1
  sourceIdentity: string
  sourceFingerprint: string
  selectedAt: string
  excludedNoteGuids: string[]
  skipped: AnkiImportSkippedNote[]
}

let sqlPromise: Promise<SqlJsStatic> | undefined
function browserSql() {
  sqlPromise ??= import('sql.js').then(({ default: initSqlJs }) => initSqlJs({ locateFile: () => sqlWasmUrl }))
  return sqlPromise
}

const textDecoder = new TextDecoder()
const fieldSeparator = '\u001f'
const day = 86_400_000

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

function decodeTypes(data: CollectionData, fallback: Date, issues: AnkiImportIssue[], referencedTypeIds: ReadonlySet<number>, media: ReadonlyMap<string, CollectionData['media'][number]>): Map<number, SourceType> {
  const result = new Map<number, SourceType>()
  for (const row of data.notetypes) {
    if (!referencedTypeIds.has(row.id)) continue
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
        validateSupportedTemplateMarkup(template.front, template.back, template.css, media)
        template.front = rewriteTemplateMedia(template.front)
        template.back = rewriteTemplateMedia(template.back)
        template.css = rewriteTemplateCssMedia(template.css)
      }
      result.set(row.id, {
        id: row.id,
        localId: nativeIdentity('note-type', row.id),
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
  while (textDecoder.decode(bytes.slice(offset, offset + 3)) === 'ID3') {
    if (offset + 10 > bytes.length) return false
    const header = bytes.slice(offset, offset + 10)
    if (header.slice(6, 10).some((byte) => byte > 0x7f)) return false
    const tagSize = header.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0)
    offset += 10 + tagSize + (header[5] & 0x10 ? 10 : 0)
    if (offset > bytes.length) return false
  }
  const end = mp3AudioEnd(bytes)
  if (offset > end) return false
  const frameLength = mp3FrameLength(bytes, offset)
  if (!frameLength || offset + frameLength + 4 > end) return false
  const format = mp3FrameFormat(bytes, offset)
  const nextOffset = offset + frameLength
  if (format !== mp3FrameFormat(bytes, nextOffset)) return false

  let frameOffset = offset
  let frames = 0
  while (frameOffset + 4 <= end) {
    const length = mp3FrameLength(bytes, frameOffset)
    if (!length || frameOffset + length > end || mp3FrameFormat(bytes, frameOffset) !== format) break
    frameOffset += length
    frames += 1
  }
  const padding = bytes.subarray(frameOffset, end)
  return frames >= 2 && padding.length <= 8 && padding.every((byte) => byte === 0)
}

function mp3AudioEnd(bytes: Uint8Array) {
  let end = bytes.length
  let changed = true
  while (changed) {
    changed = false
    if (end >= 128 && textDecoder.decode(bytes.slice(end - 128, end - 125)) === 'TAG') {
      end -= 128
      changed = true
      continue
    }
    if (end >= 227 && textDecoder.decode(bytes.slice(end - 227, end - 223)) === 'TAG+') {
      end -= 227
      changed = true
      continue
    }
    if (end >= 32 && textDecoder.decode(bytes.slice(end - 32, end - 24)) === 'APETAGEX') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const tagSize = view.getUint32(end - 20, true)
      if (tagSize < 32 || tagSize > end) return end
      let tagStart = end - tagSize
      if (tagStart >= 32 && textDecoder.decode(bytes.slice(tagStart - 32, tagStart - 24)) === 'APETAGEX') tagStart -= 32
      end = tagStart
      changed = true
      continue
    }
    if (end >= 10 && textDecoder.decode(bytes.slice(end - 10, end - 7)) === '3DI') {
      const footer = bytes.slice(end - 10, end)
      if (footer.slice(6, 10).some((byte) => byte > 0x7f)) return end
      const tagSize = footer.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0)
      const totalSize = tagSize + 20
      if (totalSize > end) return end
      end -= totalSize
      changed = true
    }
  }
  return end
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

function mp3FrameFormat(bytes: Uint8Array, offset: number) {
  const version = (bytes[offset + 1] >> 3) & 0x03
  const layer = (bytes[offset + 1] >> 1) & 0x03
  const sampleRate = (bytes[offset + 2] >> 2) & 0x03
  return `${version}:${layer}:${sampleRate}`
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

function templateMediaNames(front: string, back: string, css: string) {
  const markup = `${front}\n${back}`
  const found = [
    ...[...markup.matchAll(/<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["'][^>]*>/gi)].map((match) => match[1]),
    ...[...markup.matchAll(/\[sound:([^\]]+)\]/gi)].map((match) => match[1]),
    ...[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((match) => match[1].trim()),
  ].filter((name) => name && !name.startsWith('data:'))
  return [...new Set(found)]
}

function rewriteTemplateMedia(value: string) {
  return value
    .replace(/<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*(["'])([^"'<>]+)\1[^>]*>/gi, (_tag, _quote: string, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
    .replace(/\[sound:([^\]]+)\]/gi, (_tag, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
}

function rewriteTemplateCssMedia(css: string) {
  return css.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*))\s*\)/gi, (whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
    const name = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim()
    return !name || name.startsWith('data:') ? whole : `url("kiroku-media:${encodeURIComponent(name)}")`
  })
}

function rewrittenTemplateMediaNames(value: string, css = false) {
  const pattern = css ? /kiroku-media:([^\s)"']+)/g : /\[\[kiroku-media:([^\]]+)]]/g
  return [...value.matchAll(pattern)].flatMap((match) => {
    try { return [decodeURIComponent(match[1])] } catch { return [] }
  })
}

function validateSupportedTemplateMarkup(front: string, back: string, css: string, media: ReadonlyMap<string, CollectionData['media'][number]>) {
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
      if (value && !value.toLocaleLowerCase().startsWith('data:')) {
        if (attribute !== 'src' || !['IMG', 'AUDIO', 'SOURCE'].includes(element.tagName) || !media.has(value)) {
          throw new Error('Template-static or remote resources must name a verified local image or audio file')
        }
        const asset = media.get(value)!
        const mime = mediaTypeForFilename(asset.name)
        if (!mime) throw new Error(`Template media “${value}” has an unsupported file type`)
        validateMedia(new File([ownedBuffer(asset.data)], asset.name, { type: mime }))
        validateMediaBytes(asset.data, mime)
      }
    }
    if (/url\s*\(/i.test(element.getAttribute('style') ?? '')) throw new Error('Inline style resource URLs are unsupported')
  }
  if (/@import/i.test(css)) throw new Error('Template CSS imports are unsupported')
  for (const name of templateMediaNames(front, back, css)) {
    const asset = media.get(name)
    if (!asset) throw new Error(`Template media “${name}” is missing from the collection`)
    const mime = mediaTypeForFilename(name)
    if (!mime) throw new Error(`Template media “${name}” has an unsupported file type`)
    validateMedia(new File([ownedBuffer(asset.data)], name, { type: mime }))
    validateMediaBytes(asset.data, mime)
  }
}

function mediaKind(mime: string): MediaKind { return mime.startsWith('image/') ? 'image' : 'audio' }

function mediaNames(value: string): string[] {
  const found = [
    ...[...value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["'][^>]*>/gi)].map((match) => match[1]),
    ...[...value.matchAll(/\[sound:([^\]]+)\]/gi)].map((match) => match[1]),
  ]
  return [...new Set(found)]
}

function importedField(value: string) {
  const withMedia = value
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["'][^>]*>/gi, (_tag, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
    .replace(/\[sound:([^\]]+)\]/gi, (_tag, name: string) => `[[kiroku-media:${encodeURIComponent(name)}]]`)
  if (!/[<&]/.test(withMedia)) {
    const text = withMedia.trim() ? withMedia : ''
    return { html: text || (mediaNames(value).length ? '\u200b' : ''), hadMarkup: false, preservedMarkup: false, removed: [] }
  }
  const sanitized = sanitizeFieldHtml(withMedia)
  if (!sanitized.hadMarkup) sanitized.html = decodeFieldText(withMedia)
  if (!sanitized.html.trim() && mediaNames(value).length) sanitized.html = '\u200b'
  return sanitized
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

function resultingReviewState(next: RevlogRow | undefined, card: CardRecord): State {
  // The next revlog's review type identifies the state the card had reached
  // before its next answer. For the last row, the current cards table is authoritative.
  return next ? reviewState(next) : card.state
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function partialChoiceSettingKey(sourceIdentity: string) {
  return `ankiPartialImport:${sourceIdentity}`
}

export class PreparedAnkiImport {
  readonly summary: AnkiImportSummary
  readonly duplicates: AnkiDuplicateSummary
  readonly issues: readonly AnkiImportIssue[]
  readonly filename: string
  readonly skipped: readonly AnkiImportSkippedNote[]
  readonly canImportRepresentable: boolean
  private readonly savedPartialChoice: PersistedPartialChoice | undefined
  private readonly sourceIdentity: string | undefined
  private readonly sourceFingerprint: string | undefined
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
    skipped: AnkiImportSkippedNote[],
    canImportRepresentable: boolean,
    savedPartialChoice: PersistedPartialChoice | undefined,
    sourceIdentity: string | undefined,
    sourceFingerprint: string | undefined,
  ) {
    this.filename = filename
    this.summary = summary
    this.duplicates = duplicates
    this.issues = issues
    this.skipped = skipped
    this.canImportRepresentable = canImportRepresentable
    this.savedPartialChoice = savedPartialChoice
    this.sourceIdentity = sourceIdentity
    this.sourceFingerprint = sourceFingerprint
    this.plan = structuredClone({
      summary,
      duplicates,
      issues,
      blocksImport: issues.some((issue) => issue.severity === 'error') && (!savedPartialChoice || !canImportRepresentable),
      canImportRepresentable,
      requiresPartialChoice: issues.some((issue) => issue.severity === 'error') && !savedPartialChoice,
      skipped,
      savedPartialChoice: Boolean(savedPartialChoice),
      sourceIdentity,
      sourceFingerprint,
      decisions,
      writes: {
        decks: writes.decks,
        noteTypes: writes.noteTypes,
        notes: writes.notes,
        cards: writes.cards,
        reviews: writes.reviews.map((value) => ({ value, action: 'create' as const })),
        updatedReviews: writes.updatedReviews.map((value) => ({ value, action: 'update' as const })),
        references: writes.references,
        deletedReferences: writes.deletedReferences,
        deletedDecks: writes.deletedDecks,
        undoSettings: writes.undoSettings.map(({ key }) => ({ key })),
        blobs: writes.blobs.map(({ digest, byteLength, mimeType, verifiedAt }) => ({ digest, byteLength, mimeType, verifiedAt })),
      },
    })
  }

  /** Returns the normalized app projection without applying it to the target
   * collection. Account writeback uses this as the comparable native base. */
  projectedEntities(): AnkiImportProjection {
    return structuredClone(this.projection)
  }

  async commit(options: AnkiImportCommitOptions = {}): Promise<void> {
    if (this.committed) throw new Error('This package has already been imported')
    const hasErrors = this.issues.some((issue) => issue.severity === 'error')
    if (hasErrors && !this.savedPartialChoice && !options.importRepresentableOnly) throw new Error('Resolve package errors before importing by explicitly choosing whether to import only the representable rows')
    if (hasErrors && !this.canImportRepresentable) throw new Error('Some unsupported rows cannot be isolated safely. Nothing was imported.')
    if (options.importRepresentableOnly && !this.canImportRepresentable) throw new Error('The representable portion cannot be imported safely. Nothing was imported.')
    if (this.skipped.length && !this.sourceIdentity) throw new Error('This source has no stable identity to retain its partial-import choice. Nothing was imported.')
    const partialChoice = this.skipped.length && this.sourceIdentity ? {
      key: partialChoiceSettingKey(this.sourceIdentity),
      value: {
        version: 1,
        sourceIdentity: this.sourceIdentity,
        sourceFingerprint: this.sourceFingerprint ?? '',
        selectedAt: this.importedAt,
        excludedNoteGuids: this.skipped.map(({ guid }) => guid),
        skipped: [...this.skipped],
      } satisfies PersistedPartialChoice,
    } : undefined
    // The Collection owns the whole write: the stale-preview check, the
    // invariant checks and the multi-table write share one transaction, so a row
    // cannot move between the check and the write. Import names no table.
    await this.collection.applyImportedPackage(this.writes, this.importedAt, this.snapshots, partialChoice)
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
  let sourceFingerprint = options.sourceFingerprint
  if (sourceData) data = sourceData
  else {
    try {
      const bytes = await blobBytes(file!)
      sourceFingerprint ??= await digestMedia(new Blob([ownedBuffer(bytes)]))
      validateAnkiArchive(bytes)
      const SQL = options.SQL ?? await browserSql()
      const { Collection: AnkiPackageCollection } = await import('ankipack')
      data = AnkiPackageCollection.open(bytes, SQL).data
    } catch (reason) {
      console.error('Anki package preview failed', reason)
      throw new Error(`Unable to read “${file!.name}”: ${reason instanceof Error ? reason.message : 'invalid Anki package'}`)
    }
  }
  const sourceIdentity = options.sourceIdentity ?? sourceFingerprint
  const storedChoice = sourceIdentity ? await collection.settings.get(partialChoiceSettingKey(sourceIdentity)) : undefined
  const candidateChoice = storedChoice?.value as Partial<PersistedPartialChoice> | undefined
  const savedPartialChoice = candidateChoice?.version === 1
    && candidateChoice.sourceIdentity === sourceIdentity
    && Array.isArray(candidateChoice.excludedNoteGuids)
    && Array.isArray(candidateChoice.skipped)
    ? candidateChoice as PersistedPartialChoice
    : undefined
  const issues: AnkiImportIssue[] = []
  const sourceMedia = new Map(data.media.map((media) => [media.name, media]))
  const referencedTypeIds = new Set(data.notes.map((note) => note.mid))
  const types = decodeTypes(data, now, issues, referencedTypeIds, sourceMedia)

  const sourceCardsByNote = new Map<number, CardRow[]>()
  for (const card of data.cards) {
    const cards = sourceCardsByNote.get(card.nid) ?? []
    cards.push(card)
    sourceCardsByNote.set(card.nid, cards)
  }
  const usedDeckIds = new Set(data.cards.map((card) => card.odid || card.did))
  const sourceDeckById = new Map(data.decks.map((deck) => [deck.id, deck]))
  const sourceDeckByName = new Map(data.decks.map((deck) => [deck.name.replaceAll(fieldSeparator, '::'), deck]))
  // Local decks already occupy Deck Paths. Matching them here keeps a repeat
  // import from writing a second deck of the same path, and is where a deck
  // still carrying the legacy identity form is adopted and rekeyed.
  const localDecks = await collection.decks.toArray()
  const localDecksById = new Map(localDecks.map((deck) => [deck.id, deck]))
  const localDecksByPath = new Map<string, Deck[]>()
  for (const deck of localDecks) {
    const path = deckPath(deck, localDecksById)
    localDecksByPath.set(path, [...(localDecksByPath.get(path) ?? []), deck])
  }
  const rekeyedDecks: Array<{ from: string; to: string }> = []
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
      const { id, adopted } = resolveDeckIdentity(path, matched?.id, localDecksByPath.get(path) ?? [])
      // One path is walked once per card referencing it, so record each superseded
      // deck - and tell the learner about it - only the first time.
      for (const superseded of adopted) {
        if (superseded.id === id || rekeyedDecks.some(({ from }) => from === superseded.id)) continue
        rekeyedDecks.push({ from: superseded.id, to: id })
        issues.push({ severity: 'info', code: 'deck-identity-normalised', subject: path, detail: `Deck identity ${superseded.id} was brought into the package scheme as ${id}.` })
      }
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
  let decks = [...deckRecords.values()]
  let noteTypes: NoteType[] = [...types.values()].map((type) => ({ id: type.localId, name: type.name, kind: type.kind, fields: type.fields, templates: type.templates, protected: false, createdAt: type.createdAt, updatedAt: type.updatedAt }))
  let notes: Note[] = []
  let cards: CardRecord[] = []
  let reviews: ReviewEntry[] = []
  let references: NoteMediaReference[] = []
  const referencesByNoteId = new Map<string, NoteMediaReference[]>()
  const addReference = (reference: NoteMediaReference) => {
    references.push(reference)
    const noteReferences = referencesByNoteId.get(reference.noteId) ?? []
    noteReferences.push(reference)
    referencesByNoteId.set(reference.noteId, noteReferences)
  }
  const nativeReferencedNames = new Set<string>()
  const blobs = new Map<string, StoredMedia>()
  const sourceCardIds = new Map<number, string>()
  const sourceCardsById = new Map(data.cards.map((card) => [card.id, card]))
  const latestReviewByCard = new Map<number, number>()
  for (const review of data.revlog) latestReviewByCard.set(review.cid, Math.max(latestReviewByCard.get(review.cid) ?? 0, review.id))
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
    const importedFields = rawFields.map(importedField)
    importedFields.forEach((field, index) => {
      const subject = `${row.guid} · ${sourceType.fields[index].name}`
      if (field.hadMarkup && field.preservedMarkup && !field.removed.length) issues.push({ severity: 'info', code: 'field-html-preserved', subject, detail: 'Supported field HTML was preserved for safe rendering inside the card.' })
      if (field.removed.length) issues.push({ severity: 'warning', code: 'field-html-sanitized', subject, detail: `Unsupported or unsafe field HTML was removed: ${field.removed.join(', ')}. ${field.preservedMarkup ? 'Supported markup remains preserved.' : 'Remaining content was imported as text.'}` })
    })
    const noteId = nativeIdentity('note', row.guid)
    const noteCreatedAt = isoFromSeconds(Math.floor(row.id / 1000), now)
    const noteUpdatedAt = isoFromSeconds(row.mod, now)
    const referenceUpdatedAt = sourceType.updatedAt > noteUpdatedAt ? sourceType.updatedAt : noteUpdatedAt
    let noteTypeId = sourceType.localId
    let fields = Object.fromEntries(sourceType.fields.map((field, index) => [field.id, importedFields[index]?.html ?? '']))
    let imageOcclusion: Note['imageOcclusion']
    const fieldByName = Object.fromEntries(sourceType.fields.map((field, index) => [field.name, rawFields[index] ?? '']))
    if (sourceType.stockKind === 6 || ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'].every((name) => name in fieldByName)) {
      try {
        const parsed = parseAnkiImageOcclusion(fieldByName as unknown as AnkiImageOcclusionFields)
        const media = sourceMedia.get(parsed.imageName)
        const mime = media && mediaTypeForFilename(media.name)
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
        addReference({ id: referenceId, noteId, digest, kind: 'image', mimeType: mime, displayName: media.name, side: 'front', playback: 'manual', createdAt: noteCreatedAt, updatedAt: referenceUpdatedAt })
        blobs.set(digest, { digest, blob: ownedBuffer(media.data), byteLength: media.data.byteLength, mimeType: mime, verifiedAt: importedAt })
        imageOcclusionTypes.add(sourceType.id)
      } catch (reason) {
        issues.push({ severity: 'error', code: 'unsupported-image-occlusion', subject: row.guid, detail: reason instanceof Error ? reason.message : 'Unable to import image occlusion' })
        continue
      }
    }
    const renderedHtmlFields = sourceType.fields.flatMap((field, index) => importedFields[index]?.preservedMarkup ? [field.id] : [])
    const note: Note = { id: noteId, ankiId: row.id, deckId, type: noteTypeId === 'basic' ? 'basic' : 'custom', typeId: noteTypeId, fields, ...(renderedHtmlFields.length ? { renderedHtmlFields } : {}), tags: row.tags.trim() ? row.tags.trim().split(/\s+/) : [], ...(imageOcclusion ? { imageOcclusion } : {}), createdAt: noteCreatedAt, updatedAt: noteUpdatedAt }
    notes.push(note)

    if (!imageOcclusion) {
      for (let fieldIndex = 0; fieldIndex < rawFields.length; fieldIndex += 1) {
        const names = mediaNames(rawFields[fieldIndex] ?? '')
        const fieldName = sourceType.fields[fieldIndex]?.name
        for (const name of names) {
          const media = sourceMedia.get(name)
          const mime = media && mediaTypeForFilename(media.name)
          if (!media || !mime) {
            issues.push({ severity: 'error', code: 'media-unsupported', subject: name, detail: media ? 'Media type is not supported by the offline reviewer; the containing note cannot be imported whole.' : 'Referenced media is missing from the package; the containing note cannot be imported whole.' })
            continue
          }
          const mediaFile = new File([ownedBuffer(media.data)], media.name, { type: mime })
          try { validateMedia(mediaFile) } catch (reason) {
            issues.push({ severity: 'error', code: 'media-unsupported', subject: name, detail: `${reason instanceof Error ? reason.message : 'Media is unsupported'} The containing note cannot be imported whole.` })
            continue
          }
          try { validateMediaBytes(media.data, mime) } catch {
            issues.push({ severity: 'error', code: 'media-malformed', subject: name, detail: 'Referenced media failed format validation; the containing note cannot be imported whole.' })
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
          for (const { side, templateId } of placements) addReference({
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
    const staticPlacements = new Map<string, { name: string; side: MediaSide; templateId: string }>()
    for (const template of sourceType.templates) {
      for (const name of rewrittenTemplateMediaNames(template.front)) staticPlacements.set(`${template.id}:front:${name}`, { name, side: 'front', templateId: template.id })
      for (const name of rewrittenTemplateMediaNames(template.back)) staticPlacements.set(`${template.id}:back:${name}`, { name, side: 'back', templateId: template.id })
      for (const name of rewrittenTemplateMediaNames(template.css, true)) {
        staticPlacements.set(`${template.id}:front:${name}`, { name, side: 'front', templateId: template.id })
        staticPlacements.set(`${template.id}:back:${name}`, { name, side: 'back', templateId: template.id })
      }
    }
    for (const { name, side, templateId } of staticPlacements.values()) {
      const media = sourceMedia.get(name)
      const mime = media && mediaTypeForFilename(media.name)
      if (!media || !mime) {
        issues.push({ severity: 'error', code: 'template-media-missing', subject: row.guid, detail: `Template media “${name}” is missing or unsupported; the containing note cannot be imported whole.` })
        continue
      }
      const digest = await digestMedia(new Blob([ownedBuffer(media.data)], { type: mime }))
      blobs.set(digest, { digest, blob: ownedBuffer(media.data), byteLength: media.data.byteLength, mimeType: mime, verifiedAt: importedAt })
      addReference({
        id: `${noteId}:template-media:${templateId}:${side}:${encodeURIComponent(name)}`,
        noteId,
        digest,
        kind: mediaKind(mime),
        mimeType: mime,
        displayName: name,
        side,
        templateId,
        inline: true,
        playback: mime.startsWith('audio/') ? 'automatic' : 'manual',
        createdAt: note.createdAt,
        updatedAt: referenceUpdatedAt,
      })
    }
    const noteReferences = referencesByNoteId.get(noteId) ?? []
    for (const reference of noteReferences) nativeReferencedNames.add(reference.displayName)
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
          for (const reference of noteReferences) {
            if (reference.displayName !== value.name || reference.side !== value.side || (value.templateOrd !== null && reference.templateId !== sourceType.templates[value.templateOrd as number]?.id)) continue
            reference.displayName = value.displayName
            reference.inline = value.inline
            reference.playback = value.playback as 'manual' | 'automatic'
            if (value.templateOrd === null) delete reference.templateId
          }
          for (const key of Object.keys(note.fields)) note.fields[key] = note.fields[key].split(`[[kiroku-media:${value.name}]]`).join(value.inline ? `[[kiroku-media:${encodeURIComponent(value.displayName)}]]` : '')
        }
      }
    } catch (reason) {
      // Opaque native note data is permitted; our explicit metadata is checked.
      if (row.data.includes('kirokuMedia') || row.data.includes('kirokuNoteTimes')) issues.push({ severity: 'error', code: 'invalid-export-media', subject: row.guid, detail: reason instanceof Error ? reason.message : 'Invalid exported media metadata' })
    }

    for (const sourceCard of sourceCards) {
      if (![0, 1, 2, 3].includes(sourceCard.type)) {
        issues.push({ severity: 'error', code: 'unsupported-card-state', subject: String(sourceCard.id), detail: `Card type ${sourceCard.type} is not supported.` })
        continue
      }
      const deck = deckBySource.get(sourceCard.odid || sourceCard.did)
      if (!deck) {
        issues.push({ severity: 'error', code: 'card-deck-missing', subject: String(sourceCard.id), detail: `Card references deck ${sourceCard.odid || sourceCard.did}, which has no supported row in the package.` })
        continue
      }
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
        ...(sourceCard.type === 0 ? { newPosition: Math.max(0, sourceCard.due) } : {}),
        templateOrdinal: Math.max(0, sourceCard.ord),
        due: cardDue(sourceCard, data, now),
        stability: memory.stability ?? (sourceCard.type === 2 ? Math.max(0, sourceCard.ivl) : 0),
        // Legacy Anki ease factors are outside FSRS' 1–10 difficulty range.
        // Use neutral difficulty for those cards so an imported Review card is
        // valid input to the app's FSRS scheduler instead of storing 0.
        difficulty: memory.difficulty ?? (sourceCard.factor >= 100 && sourceCard.factor <= 1100 ? sourceCard.factor / 100 : sourceCard.type === 2 ? 5 : 0),
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
  const orderedReviewRows = [...data.revlog].sort((left, right) => left.id - right.id)
  const nextReviewById = new Map<number, typeof orderedReviewRows[number]>()
  const nextReviewForCard = new Map<number, typeof orderedReviewRows[number]>()
  for (let index = orderedReviewRows.length - 1; index >= 0; index -= 1) {
    const row = orderedReviewRows[index]
    const next = nextReviewForCard.get(row.cid)
    if (next) nextReviewById.set(row.id, next)
    nextReviewForCard.set(row.cid, row)
  }
  const importedCardsById = new Map(cards.map((card) => [card.id, card]))
  for (const row of orderedReviewRows) {
    const cardId = sourceCardIds.get(row.cid)
    const card = cardId ? importedCardsById.get(cardId) : undefined
    if (!cardId || !card || row.ease < 1 || row.ease > 4) {
      issues.push({ severity: 'error', code: 'review-unsupported', subject: String(row.id), detail: card ? 'Manual or malformed review entry cannot be represented; the containing note cannot be imported whole.' : 'Review belongs to a card that could not be imported.' })
      continue
    }
    const reviewedAt = new Date(row.id).toISOString()
    const previous = previousReviewByCard.get(row.cid)
    const elapsedDays = previous ? Math.max(0, Math.floor((row.id - previous.reviewedAt) / day)) : 0
    const scheduledDays = intervalDays(row.lastIvl)
    let exportedReview: Partial<ReviewEntry> = {}
    try { exportedReview = readKirokuReview(sourceCardsById.get(row.cid)?.data ?? '', row) } catch (reason) {
      issues.push({ severity: 'error', code: 'invalid-export-review', subject: String(row.id), detail: reason instanceof Error ? reason.message : 'Invalid exported review' })
    }
    reviews.push({
      id: nativeIdentity('review', row.id),
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
      afterState: resultingReviewState(nextReviewById.get(row.id), card),
      afterDue: new Date(row.id + intervalMilliseconds(row.ivl)).toISOString(), afterScheduledDays: intervalDays(row.ivl),
      ...exportedReview,
    })
    previousReviewByCard.set(row.cid, { reviewedAt: row.id, elapsedDays })
    if (!previous) issues.push({ severity: 'warning', code: 'first-review-approximation', subject: String(row.id), detail: 'Anki does not retain the original due and FSRS memory state before the first review log; its review time and prior interval are used as the supported approximation.' })
    if (row.type > 2) issues.push({ severity: 'warning', code: 'review-kind-fallback', subject: String(row.id), detail: 'Filtered or manual review kind was retained as review history without its special queue semantics.' })
  }

  for (const typeId of imageOcclusionTypes) {
    const index = noteTypes.findIndex((type) => type.id === nativeIdentity('note-type', typeId))
    if (index >= 0) noteTypes.splice(index, 1)
  }

  const sourceNotesByGuid = new Map(data.notes.map((note) => [note.guid, note]))
  const sourceNoteTypeNames = new Map(data.notetypes.map((type) => [type.id, type.name]))
  const sourceCardsByNativeId = new Map(data.cards.map((card) => [String(card.id), card]))
  const sourceCardsByNativeNoteId = new Map(data.cards.map((card) => [card.id, card.nid]))
  const sourceNotesByNativeId = new Map(data.notes.map((note) => [note.id, note]))
  const sourceReviewToNativeNoteId = new Map(data.revlog.flatMap((review) => {
    const nativeNoteId = sourceCardsByNativeNoteId.get(review.cid)
    return nativeNoteId === undefined ? [] : [[String(review.id), nativeNoteId] as const]
  }))
  const errorIssuesByGuid = new Map<string, AnkiImportIssue[]>()
  const excludedNoteGuids = new Set(savedPartialChoice?.excludedNoteGuids ?? [])
  const skippableCodes = new Set(['media-unsupported', 'media-malformed', 'review-unsupported'])
  let hasUnmappedBlockingIssue = false
  for (const issue of issues) {
    if (issue.severity !== 'error' && !skippableCodes.has(issue.code)) continue
    const guids = new Set<string>()
    const directNote = sourceNotesByGuid.get(issue.subject)
    if (directNote) guids.add(directNote.guid)
    const sourceCard = sourceCardsByNativeId.get(issue.subject)
    if (sourceCard) {
      const note = sourceNotesByNativeId.get(sourceCard.nid)
      if (note) guids.add(note.guid)
    }
    const reviewNoteId = sourceReviewToNativeNoteId.get(issue.subject)
    if (reviewNoteId !== undefined) {
      const note = sourceNotesByNativeId.get(reviewNoteId)
      if (note) guids.add(note.guid)
    }
    const unsupportedType = data.notetypes.find((type) => type.name === issue.subject)
    if (unsupportedType) for (const note of data.notes) if (note.mid === unsupportedType.id) guids.add(note.guid)
    if (issue.code === 'deck-hierarchy-malformed') {
      const badDeckIds = new Set(data.decks.filter((deck) => {
        const path = deck.name.replaceAll(fieldSeparator, '::')
        return path === issue.subject || path.startsWith(`${issue.subject}::`)
      }).map((deck) => deck.id))
      for (const card of data.cards) if (badDeckIds.has(card.odid || card.did)) {
        const note = sourceNotesByNativeId.get(card.nid)
        if (note) guids.add(note.guid)
      }
    }
    if (skippableCodes.has(issue.code) && issue.code.startsWith('media-')) {
      for (const note of data.notes) if (mediaNames(note.flds).includes(issue.subject)) guids.add(note.guid)
    }
    if (!guids.size) {
      if (issue.severity === 'error') hasUnmappedBlockingIssue = true
      continue
    }
    for (const guid of guids) {
      excludedNoteGuids.add(guid)
      errorIssuesByGuid.set(guid, [...(errorIssuesByGuid.get(guid) ?? []), issue])
    }
  }

  const skipped: AnkiImportSkippedNote[] = []
  for (const guid of excludedNoteGuids) {
    const sourceNote = sourceNotesByGuid.get(guid)
    if (!sourceNote) {
      const previous = savedPartialChoice?.skipped.find((entry) => entry.guid === guid)
      if (previous) skipped.push(previous)
      continue
    }
    const nativeCardIds = (sourceCardsByNote.get(sourceNote.id) ?? []).map((card) => card.id)
    const nativeCardIdSet = new Set(nativeCardIds)
    const previous = savedPartialChoice?.skipped.find((entry) => entry.guid === guid)
    const reasons = [...new Set([
      ...(errorIssuesByGuid.get(guid) ?? []).map((issue) => `${issue.subject}: ${issue.detail}`),
      ...(previous && !(errorIssuesByGuid.get(guid)?.length) ? ['Omitted under the previously saved representable-only import choice.'] : []),
    ])]
    const noteType = sourceNoteTypeNames.get(sourceNote.mid) ?? previous?.noteType ?? `Note type ${sourceNote.mid}`
    skipped.push({
      noteId: nativeIdentity('note', guid),
      guid,
      ankiNoteId: sourceNote.id,
      noteType,
      cardIds: nativeCardIds,
      reviewIds: data.revlog.filter((review) => nativeCardIdSet.has(review.cid)).map((review) => review.id),
      mediaNames: [...new Set(mediaNames(sourceNote.flds))].sort(),
      reasons: reasons.length ? reasons : ['Omitted under the previously saved representable-only import choice.'],
    })
  }
  const skippedNoteIds = new Set(skipped.map(({ noteId }) => noteId))
  notes = notes.filter((note) => !skippedNoteIds.has(note.id))
  const representedNoteIds = new Set(notes.map(({ id }) => id))
  cards = cards.filter((card) => representedNoteIds.has(card.noteId))
  const representedCardIds = new Set(cards.map(({ id }) => id))
  reviews = reviews.filter((review) => representedCardIds.has(review.cardId))
  references = references.filter((reference) => representedNoteIds.has(reference.noteId))
  noteTypes = noteTypes.filter((noteType) => notes.some((note) => note.typeId === noteType.id))
  const representedDeckIds = new Set(cards.map(({ deckId }) => deckId))
  const deckById = new Map(decks.map((deck) => [deck.id, deck]))
  for (const deckId of [...representedDeckIds]) {
    let deck = deckById.get(deckId)
    while (deck?.parentId) {
      representedDeckIds.add(deck.parentId)
      deck = deckById.get(deck.parentId)
    }
  }
  decks = decks.filter((deck) => representedDeckIds.has(deck.id))
  const referencedNames = new Set(references.map((reference) => reference.displayName))
  for (const media of data.media) if (!referencedNames.has(media.name)) issues.push({ severity: 'warning', code: 'media-unreferenced', subject: media.name, detail: 'Unreferenced or template-static media is reported but not attached to a note.' })

  const localNotes = await collection.notes.toArray()
  const localCards = await collection.cards.toArray()
  const localReviews = await collection.reviewEntries.toArray()
  const localNoteTypes = await collection.noteTypes.toArray()
  const localReferences = await collection.noteMedia.toArray()
  const localRowsByTable = {
    decks: new Map(localDecks.map((value) => [value.id, value])),
    noteTypes: new Map(localNoteTypes.map((value) => [value.id, value])),
    notes: new Map(localNotes.map((value) => [value.id, value])),
    cards: new Map(localCards.map((value) => [value.id, value])),
    reviewEntries: new Map(localReviews.map((value) => [value.id, value])),
    noteMedia: new Map(localReferences.map((value) => [value.id, value])),
  }
  const localCardsByNoteId = new Map<string, CardRecord[]>()
  for (const card of localCards) {
    const noteCards = localCardsByNoteId.get(card.noteId) ?? []
    noteCards.push(card)
    localCardsByNoteId.set(card.noteId, noteCards)
  }
  const localReferencesByNoteId = new Map<string, NoteMediaReference[]>()
  for (const reference of localReferences) {
    const noteReferences = localReferencesByNoteId.get(reference.noteId) ?? []
    noteReferences.push(reference)
    localReferencesByNoteId.set(reference.noteId, noteReferences)
  }
  const writes: ImportWrites = { decks: [], noteTypes: [], notes: [], cards: [], reviews: [], updatedReviews: [], references: [], deletedReferences: [], deletedDecks: [], undoSettings: [], blobs: [] }
  const snapshots: Snapshot[] = []
const decisions: AnkiImportDecision[] = []
  const recordDecision = (entity: AnkiImportEntity, id: string, action: AnkiImportDecisionAction) => decisions.push({ entity, id, action })
  // A deck reconciled away leaves its row behind, and everything pointing at it
  // still does. References move whatever the local timestamps say, because a
  // reference to a row about to be deleted is not a conflict the learner could
  // sensibly win.
  const superseded = new Set(rekeyedDecks.map(({ from }) => from))
  for (const { from, to } of rekeyedDecks) {
    const existing = localDecksById.get(from)
    if (existing) {
      snapshots.push({ table: 'decks', id: from, value: fingerprint(existing) })
      writes.deletedDecks.push(existing)
      recordDecision('deck', from, 'delete')
    }
    for (const child of localDecks.filter((deck) => deck.parentId === from && !superseded.has(deck.id))) {
      snapshots.push({ table: 'decks', id: child.id, value: fingerprint(child) })
      const incoming = deckRecords.get(child.id)
      const value = { ...(incoming ?? child), parentId: to, updatedAt: now.toISOString() }
      writes.decks.push({ value, action: 'update' })
      recordDecision('deck', child.id, 'update')
      deckRecords.set(child.id, value)
    }
    // A Synthesised Deck is an empty container, but a deck reconciled away for
    // duplicating the same Deck Path might not be. Carry its notes, cards and
    // reviews across rather than orphaning them on a deleted identity.
    for (const note of localNotes.filter((note) => note.deckId === from)) {
      snapshots.push({ table: 'notes', id: note.id, value: fingerprint(note) })
      writes.notes.push({ value: { ...note, deckId: to, updatedAt: now.toISOString() }, action: 'update' })
      recordDecision('note', note.id, 'update')
    }
    for (const card of localCards.filter((card) => card.deckId === from)) {
      snapshots.push({ table: 'cards', id: card.id, value: fingerprint(card) })
      writes.cards.push({ value: { ...card, deckId: to }, action: 'update' })
      recordDecision('card', card.id, 'update')
    }
    for (const review of localReviews.filter((review) => review.deckId === from)) {
      snapshots.push({ table: 'reviewEntries', id: review.id, value: fingerprint(review) })
      writes.updatedReviews.push({ ...review, deckId: to })
      recordDecision('review', review.id, 'update')
    }
    // An undo record holds a copy of the note it deleted, deck reference and
    // all, and restoring it insists that deck still exists. Left pointing at a
    // superseded identity it would fail permanently, so the copy follows too.
    for (const key of ['noteDeletionUndo'] as const) {
      const stored = await collection.settings.get(key)
      const undo = stored?.value as { note?: { deckId?: string }; cards?: Array<{ deckId?: string }>; reviews?: Array<{ deckId?: string }> } | undefined
      if (!undo) continue
      const notes = undo.note?.deckId === from ? [undo.note] : []
      const cards = (undo.cards ?? []).filter((card) => card.deckId === from)
      const reviews = (undo.reviews ?? []).filter((review) => review.deckId === from)
      if (!notes.length && !cards.length && !reviews.length) continue
      writes.undoSettings.push({ key, value: {
        ...undo,
        ...(notes.length ? { note: { ...undo.note, deckId: to } } : {}),
        ...(cards.length ? { cards: cards.map((card) => ({ ...card, deckId: to })) } : {}),
        ...(reviews.length ? { reviews: reviews.map((review) => ({ ...review, deckId: to })) } : {}),
      } })
    }
  }
  const duplicates: AnkiDuplicateSummary = { create: 0, update: 0, keepLocal: 0, unchanged: 0 }
  function decide<T extends { id: string; updatedAt?: string }>(table: 'decks' | 'noteTypes' | 'notes' | 'noteMedia', value: T) {
    const existing = localRowsByTable[table].get(value.id) as T | undefined
    snapshots.push({ table, id: value.id, value: fingerprint(existing) })
    if (!existing) return 'create' as const
    if (fingerprint(existing) === fingerprint(value)) return 'unchanged' as const
    return Date.parse(value.updatedAt ?? '') > Date.parse(existing.updatedAt ?? '') ? 'update' as const : 'keepLocal' as const
  }
  // A deck already reparented above is written by that step, not decided here:
  // its parent reference had to move regardless of the local timestamp.
  const reparented = new Set(writes.decks.map(({ value }) => value.id))
  for (const value of decks) {
    if (reparented.has(value.id)) continue
    const action = decide('decks', value)
    recordDecision('deck', value.id, action)
    if (action === 'create' || action === 'update') writes.decks.push({ value, action })
  }
  const noteTypeDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  for (const value of noteTypes) {
    const action = decide('noteTypes', value)
    recordDecision('noteType', value.id, action)
    noteTypeDecisions.set(value.id, action)
    if (action === 'create' || action === 'update') writes.noteTypes.push({ value, action })
  }
  const noteDecisions = new Map<string, 'create' | 'update' | 'keepLocal' | 'unchanged'>()
  const keptAggregateNoteIds = new Set<string>()
  for (const value of notes) {
    const proposedAction = decide('notes', value)
    const localTypeWins = noteTypeDecisions.get(value.typeId) === 'keepLocal'
    const existing = localTypeWins ? localRowsByTable.notes.get(value.id) : undefined
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
    const existing = localRowsByTable.cards.get(value.id)
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
    for (const existing of localCardsByNoteId.get(noteId) ?? []) {
      if (incomingCardIds.has(existing.id) || existing.suspended) continue
      snapshots.push({ table: 'cards', id: existing.id, value: fingerprint(existing) })
      writes.cards.push({ value: { ...existing, suspended: true, templateSuspended: true }, action: 'update' })
      recordDecision('card', existing.id, 'update')
    }
  }
  for (const value of reviews) {
    const importedCard = importedCardsById.get(value.cardId)
    if (importedCard && keptAggregateNoteIds.has(importedCard.noteId)) { recordDecision('review', value.id, 'keepLocal'); continue }
    const existing = localRowsByTable.reviewEntries.get(value.id)
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
    const action = decide('noteMedia', value)
    recordDecision('mediaReference', value.id, action)
    if (action === 'create' || action === 'update') writes.references.push({ value, action })
  }
  const incomingReferenceIds = new Set(references.map(({ id }) => id))
  for (const noteId of mediaReconcileNoteIds) {
    for (const existing of localReferencesByNoteId.get(noteId) ?? []) {
      const importedReference = existing.id.startsWith(`${noteId}:media:`) || existing.id === `${noteId}:image-occlusion-source`
      if (!importedReference || incomingReferenceIds.has(existing.id)) continue
      snapshots.push({ table: 'noteMedia', id: existing.id, value: fingerprint(existing) })
      writes.deletedReferences.push(existing)
      recordDecision('mediaReference', existing.id, 'delete')
    }
  }
  const eligibleMediaDigests = new Set(references.filter((reference) => !keptAggregateNoteIds.has(reference.noteId)).map((reference) => reference.digest))
  const eligibleBlobs = [...blobs.values()].filter((value) => eligibleMediaDigests.has(value.digest))
  const existingBlobs = await collection.mediaBlobs.bulkGet(eligibleBlobs.map((value) => value.digest))
  for (const [index, value] of eligibleBlobs.entries()) {
    const existing = existingBlobs[index]
    snapshots.push({ table: 'mediaBlobs', id: value.digest, value: fingerprint(existing) })
    if (!existing) writes.blobs.push(value)
  }

  for (const item of skipped) {
    decisions.push({ entity: 'note', id: item.noteId, action: 'skip' })
    for (const cardId of item.cardIds) decisions.push({ entity: 'card', id: `anki-card:${cardId}`, action: 'skip' })
    for (const reviewId of item.reviewIds) decisions.push({ entity: 'review', id: nativeIdentity('review', reviewId), action: 'skip' })
    for (const reference of [...(referencesByNoteId.get(item.noteId) ?? [])]) decisions.push({ entity: 'mediaReference', id: reference.id, action: 'skip' })
    const sourceNote = sourceNotesByGuid.get(item.guid)
    const sourceType = sourceNote && data.notetypes.find((type) => type.id === sourceNote.mid)
    if (sourceType && !types.has(sourceType.id)) decisions.push({ entity: 'noteType', id: nativeIdentity('note-type', sourceType.id), action: 'skip' })
  }
  const canImportRepresentable = skipped.length > 0 && Boolean(sourceIdentity) && !hasUnmappedBlockingIssue && (notes.length > 0 || Boolean(savedPartialChoice))

  return new PreparedAnkiImport(file?.name ?? 'AnkiWeb account', {
    decks: decks.length,
    noteTypes: noteTypes.length + imageOcclusionTypes.size,
    notes: notes.length,
    cards: cards.length,
    reviews: reviews.length,
    media: eligibleBlobs.length,
  }, duplicates, issues, collection, writes, snapshots, importedAt, { decks, noteTypes, notes, cards, reviews, references }, decisions, skipped, canImportRepresentable, savedPartialChoice, sourceIdentity, sourceFingerprint)
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
