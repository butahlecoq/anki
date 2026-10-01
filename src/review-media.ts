import { collection, type NoteMediaReference, type MediaBytes } from './collection'
import { validateMedia } from './media'
import type { RenderOptions } from './template-renderer'

export const REVIEW_MEDIA_BYTE_BUDGET = 64 * 1024 * 1024
export type ReviewMediaSources = NonNullable<RenderOptions['media']>

function dataUrl(bytes: ArrayBuffer, mimeType: string, signal: AbortSignal) {
  const view = new Uint8Array(bytes)
  const chunks: string[] = []
  // Every nonfinal chunk is divisible by three, so only the last needs padding.
  // Bound spread arguments and temporary strings regardless of attachment size.
  for (let offset = 0; offset < view.length; offset += 24_576) {
    signal.throwIfAborted()
    chunks.push(btoa(String.fromCharCode(...view.subarray(offset, offset + 24_576))))
  }
  return `data:${mimeType};base64,${chunks.join('')}`
}

/** Only the active card owns these strings; duplicate references share one read. */
export async function prepareReviewMedia(
  references: NoteMediaReference[],
  signal: AbortSignal,
  load: (digest: string) => Promise<MediaBytes | undefined> = (digest) => collection.verifiedMediaBytes(digest),
  byteBudget = REVIEW_MEDIA_BYTE_BUDGET,
): Promise<ReviewMediaSources> {
  const byDigest = new Map<string, string>()
  const sources: ReviewMediaSources = {}
  let preparedBytes = 0
  // Read sequentially to avoid concurrently allocating each attachment's bytes.
  for (const reference of references) {
    signal.throwIfAborted()
    let url = byDigest.get(reference.digest)
    if (!url) {
      const stored = await load(reference.digest)
      signal.throwIfAborted()
      if (!stored) continue
      validateMedia(new File([stored.bytes], reference.displayName, { type: stored.mimeType }))
      preparedBytes += stored.bytes.byteLength
      if (preparedBytes > byteBudget) {
        throw new Error('This card exceeds the 64 MiB review media limit. Remove attachments or split the note into smaller notes.')
      }
      url = dataUrl(stored.bytes, stored.mimeType, signal)
      byDigest.set(reference.digest, url)
    }
    sources[reference.displayName] = { kind: reference.kind, url, automatic: reference.playback === 'automatic' }
  }
  return sources
}
