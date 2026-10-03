/**
 * Shared vocabulary for Anki package interchange.
 *
 * Import and export are the two directions of one Exchange, and each used to
 * re-derive the same mappings independently: which extension a media type
 * writes, which media type a filename implies, how a blob becomes bytes, how
 * bytes become a hex digest, and which native type number means which Anki
 * state. Five of those concepts had three or four copies across the browser and
 * the sync server, so a new media format or a changed state mapping meant
 * finding every copy.
 *
 * This module is the model those two directions read. It holds no I/O and no
 * app types; `anki-scheduling-metadata` is the shape it follows.
 */

export type MediaKind = 'image' | 'audio'

export interface MediaTypeDefinition {
  mimeType: string
  kind: MediaKind
  /** Extensions the package format uses. The first is canonical for writing. */
  extensions: string[]
  maximumBytes: number
}

export const SUPPORTED_MEDIA_TYPES: readonly MediaTypeDefinition[] = [
  { mimeType: 'image/png', kind: 'image', extensions: ['png'], maximumBytes: 10 * 1024 * 1024 },
  { mimeType: 'image/jpeg', kind: 'image', extensions: ['jpg', 'jpeg'], maximumBytes: 10 * 1024 * 1024 },
  { mimeType: 'image/webp', kind: 'image', extensions: ['webp'], maximumBytes: 10 * 1024 * 1024 },
  { mimeType: 'audio/mpeg', kind: 'audio', extensions: ['mp3'], maximumBytes: 20 * 1024 * 1024 },
  { mimeType: 'audio/ogg', kind: 'audio', extensions: ['ogg', 'oga'], maximumBytes: 20 * 1024 * 1024 },
  { mimeType: 'audio/wav', kind: 'audio', extensions: ['wav'], maximumBytes: 20 * 1024 * 1024 },
]

const byExtension = new Map<string, MediaTypeDefinition>(SUPPORTED_MEDIA_TYPES.flatMap((definition) => definition.extensions.map((extension) => [`.${extension}`, definition])))
const byMimeType = new Map(SUPPORTED_MEDIA_TYPES.map((definition) => [definition.mimeType, definition]))

/** The canonical extension for a media type, as package filenames write it. */
export function extensionForMediaType(mimeType: string) {
  return byMimeType.get(mimeType)?.extensions[0]
}

/** The media type a filename denotes, or undefined when it is not supported. */
export function mediaTypeForFilename(filename: string) {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? undefined : byExtension.get(filename.slice(dot).toLowerCase())?.mimeType
}

/** Whether the sync service accepts this media type. Reads the same table. */
export function isSupportedMediaType(mimeType: string) {
  return byMimeType.has(mimeType)
}

export function mediaKindFor(mimeType: string): MediaKind | undefined {
  return byMimeType.get(mimeType)?.kind
}

export function maximumBytesFor(mimeType: string) {
  return byMimeType.get(mimeType)?.maximumBytes
}

/** Bytes as lowercase hex. One definition, so a digest means one thing. */
export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A blob's bytes, whichever shape it arrives in. IndexedDB stores an
 * ArrayBuffer; a freshly attached File is a Blob; the FileReader path remains
 * for environments without `Blob.arrayBuffer`.
 */
export async function blobBytes(blob: Blob | ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  // IndexedDB hands back an ArrayBuffer from another realm, so `instanceof` is
  // not a reliable test for one.
  if (typeof (blob as Blob).arrayBuffer === 'function') return new Uint8Array(await (blob as Blob).arrayBuffer())
  if (Object.prototype.toString.call(blob) === '[object ArrayBuffer]') return new Uint8Array(blob as ArrayBuffer)
  return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read blob bytes.'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(blob as Blob)
  })
}

/** Anki's native card `type` field. Read in both directions. */
export const NATIVE_CARD_TYPE = {
  new: 0,
  learning: 1,
  review: 2,
  relearning: 3,
} as const

/** Anki's native review-log `type` field, which records the answer's context. */
export const NATIVE_REVIEW_TYPE = {
  learning: 0,
  review: 1,
  relearning: 2,
  filtered: 3,
} as const

export type NativeCardState = keyof typeof NATIVE_CARD_TYPE
export type NativeReviewState = keyof typeof NATIVE_REVIEW_TYPE

/**
 * The native type number for a card state. `Relearning` is Anki's 3, distinct
 * from `Review`; getting this backwards moves a card out of the relearning
 * queue on every round trip.
 */
export function nativeCardType(state: NativeCardState): number {
  return NATIVE_CARD_TYPE[state]
}

export function nativeReviewType(state: NativeReviewState): number {
  return NATIVE_REVIEW_TYPE[state]
}

/** Anki's `crt` collection creation time divides review intervals from due dates. */
export const DAY_MILLISECONDS = 86_400_000