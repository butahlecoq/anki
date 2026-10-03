/**
 * The media types an Exchange accepts, in one table.
 *
 * The browser validated uploads against this list and the sync service
 * re-typed it, so adding a format meant two edits that could disagree: the
 * browser would accept a file the service then refused.
 */
export type MediaKind = 'image' | 'audio'

export interface MediaTypeDefinition {
  mimeType: string
  kind: MediaKind
  /** Extensions used when a package carries a media reference by filename. */
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

const byExtension = new Map(SUPPORTED_MEDIA_TYPES.flatMap((definition) => definition.extensions.map((extension) => [`.${extension}`, definition])))

/** The media type a filename denotes, or undefined when it is not supported. */
export function mediaTypeForFilename(filename: string) {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? undefined : byExtension.get(filename.slice(dot).toLowerCase())
}

/** The media type the service accepts. Reads the same table as the browser. */
export function isSupportedMediaType(mimeType: string) {
  return SUPPORTED_MEDIA_TYPES.some((definition) => definition.mimeType === mimeType)
}