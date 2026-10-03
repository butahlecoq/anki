import { SUPPORTED_MEDIA_TYPES, blobBytes, maximumBytesFor, toHex, type MediaKind } from '../anki-interchange'

export type { MediaKind }
export type MediaSide = 'front' | 'back'
export type AudioPlayback = 'automatic' | 'manual'

export function validateMedia(file: File) {
  const definition = SUPPORTED_MEDIA_TYPES.find(({ mimeType }) => mimeType === file.type)
  if (!definition) throw new Error(`"${file.name}" is not a supported image or audio file.`)
  if (!file.size) throw new Error(`"${file.name}" is empty.`)
  const maximumBytes = maximumBytesFor(file.type)!
  if (file.size > maximumBytes) throw new Error(`"${file.name}" is larger than the ${maximumBytes / 1024 / 1024} MB limit.`)
  return { kind: definition.kind, maximumBytes }
}

export async function digestMedia(blob: Blob | ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', (await blobBytes(blob)).buffer as ArrayBuffer)
  return toHex(new Uint8Array(digest))
}