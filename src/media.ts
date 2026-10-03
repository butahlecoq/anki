import { SUPPORTED_MEDIA_TYPES, type MediaKind } from '../media-types'

export type { MediaKind }
export type MediaSide = 'front' | 'back'
export type AudioPlayback = 'automatic' | 'manual'

const supported = new Map(SUPPORTED_MEDIA_TYPES.map(({ mimeType, kind, maximumBytes }) => [mimeType, { kind, maximumBytes }]))

export function validateMedia(file: File) {
  const definition = supported.get(file.type)
  if (!definition) throw new Error(`"${file.name}" is not a supported image or audio file.`)
  if (!file.size) throw new Error(`"${file.name}" is empty.`)
  if (file.size > definition.maximumBytes) throw new Error(`"${file.name}" is larger than the ${definition.maximumBytes / 1024 / 1024} MB limit.`)
  return definition
}

export async function digestMedia(blob: Blob) {
  const bytes = 'arrayBuffer' in blob && typeof blob.arrayBuffer === 'function'
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read media bytes.'))
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob)
    })
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}
