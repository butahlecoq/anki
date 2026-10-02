import { useEffect, useState } from 'react'
import type { NoteMediaReference } from './collection'
import { prepareReviewMedia, type ReviewMediaSources } from './review-media'

export function useReviewMedia(media: NoteMediaReference[], owner = ''): { sources: ReviewMediaSources; error?: string; pending: boolean } {
  // Query results produce new array identities on ordinary reviewer renders.
  // Stable metadata keeps the question and answer on the same prepared sources.
  const key = JSON.stringify([owner, media])
  const [state, setState] = useState<{ key: string; sources: ReviewMediaSources; error?: string }>()
  // Adjust state before committing a changed card/attachment list. In particular,
  // a hanging replacement read must not retain the previous card's strings.
  if (state && state.key !== key) setState(undefined)
  useEffect(() => {
    const controller = new AbortController()
    const [, references]: [string, NoteMediaReference[]] = JSON.parse(key)
    void prepareReviewMedia(references, controller.signal).then((sources) => {
      if (!controller.signal.aborted) setState({ key, sources })
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setState({ key, sources: {}, error: reason instanceof Error ? reason.message : 'Unable to prepare review media.' })
    })
    // Cancel outstanding reads and release the active card's sources on unmount
    // or changed attachments. No data URLs are retained in a shared cache.
    return () => controller.abort()
  }, [key])
  return state?.key === key ? { ...state, pending: false } : { sources: {}, pending: media.length > 0 }
}
