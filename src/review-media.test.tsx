import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { collection, type MediaBytes, type NoteMediaReference } from './collection'
import { prepareReviewMedia } from './review-media'
import { useReviewMedia } from './use-review-media'
import * as reviewMedia from './review-media'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const reference = (digest: string, displayName: string): NoteMediaReference => ({
  id: displayName, digest, displayName, kind: 'image', mimeType: 'image/png', noteId: 'note', side: 'front', playback: 'manual', createdAt: '2026-10-01', updatedAt: '2026-10-01',
})
const stored = (digest: string): MediaBytes => ({ digest, bytes: new Uint8Array([1, 2, 3]).buffer, byteLength: 3, mimeType: 'image/png', verifiedAt: '2026-10-01' })

test('prepares multiple images and aliases from verified bytes without blob network requests', async () => {
  const load = vi.fn(async (digest: string) => stored(digest))
  const media = await prepareReviewMedia([reference('one', '猫.png'), reference('one', 'cat.png'), reference('two', '犬.png')], new AbortController().signal, load)
  expect(media['猫.png'].url).toBe('data:image/png;base64,AQID')
  expect(media['cat.png'].url).toBe(media['猫.png'].url)
  expect(media['犬.png'].url).toMatch(/^data:image\/png;base64,/)
  expect(load.mock.calls.map(([digest]) => digest)).toEqual(['one', 'two'])
})

test('base64 preserves binary bytes across chunk boundaries and final padding', async () => {
  const bytes = Uint8Array.from({ length: 49_153 }, (_, index) => index % 256)
  const media = await prepareReviewMedia([reference('one', 'large.png')], new AbortController().signal, async (digest) => ({ ...stored(digest), bytes: bytes.buffer, byteLength: bytes.byteLength }))
  const decoded = atob(media['large.png'].url.split(',')[1])
  expect(Uint8Array.from(decoded, (character) => character.charCodeAt(0))).toEqual(bytes)
})

test('audio also encodes offline from stored bytes and retains playback policy', async () => {
  const audio: NoteMediaReference = { ...reference('audio', '猫.wav'), kind: 'audio', mimeType: 'audio/wav', playback: 'automatic' }
  const media = await prepareReviewMedia([audio], new AbortController().signal, async (digest) => ({ ...stored(digest), mimeType: 'audio/wav' }))
  expect(media['猫.wav']).toEqual({ kind: 'audio', url: 'data:audio/wav;base64,AQID', automatic: true })
})

test('rejects the aggregate budget with actionable copy before encoding the next attachment', async () => {
  const read = vi.spyOn(window, 'btoa')
  await expect(prepareReviewMedia([reference('one', '猫.png'), reference('two', '犬.png')], new AbortController().signal, async (digest) => stored(digest), 5)).rejects.toThrow('Remove attachments or split the note')
  expect(read).toHaveBeenCalledTimes(1)
})

test('cancellation after a database read prevents further allocations', async () => {
  const controller = new AbortController()
  const read = vi.spyOn(window, 'btoa')
  await expect(prepareReviewMedia([reference('one', '猫.png')], controller.signal, async (digest) => {
    controller.abort()
    return stored(digest)
  })).rejects.toHaveProperty('name', 'AbortError')
  expect(read).not.toHaveBeenCalled()
})

test('a synced oversized image is rejected before allocating a data URL', async () => {
  const read = vi.spyOn(window, 'btoa')
  await expect(prepareReviewMedia([reference('one', 'oversized.png')], new AbortController().signal, async (digest) => ({
    ...stored(digest), bytes: new Uint8Array(10 * 1024 * 1024 + 1).buffer,
  }))).rejects.toThrow('10 MB limit')
  expect(read).not.toHaveBeenCalled()
})

function Preview({ media, answer = false }: { media: NoteMediaReference[]; answer?: boolean }) {
  const { sources, error } = useReviewMedia(media)
  return <div>{error && <p role="alert">{error}</p>}<span>{answer ? 'Answer' : 'Question'}</span>{Object.entries(sources).map(([name, source]) => <img key={name} alt={name} src={source.url} />)}</div>
}

test('a preparation budget failure reaches the reviewer as an actionable alert', async () => {
  vi.spyOn(reviewMedia, 'prepareReviewMedia').mockRejectedValue(new Error('This card exceeds the 64 MiB review media limit. Remove attachments or split the note into smaller notes.'))
  render(<Preview media={[reference('one', '猫.png')]} />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Remove attachments or split the note'))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('question and answer reuse sources, while a new card prepares only its own attachments', async () => {
  const load = vi.spyOn(collection, 'verifiedMediaBytes').mockImplementation(async (digest) => stored(digest))
  const media = [reference('one', '猫.png')]
  const { rerender, unmount } = render(<Preview key="cat" media={media} />)
  await waitFor(() => expect(screen.getByRole('img', { name: '猫.png' })).toHaveAttribute('src', 'data:image/png;base64,AQID'))
  rerender(<Preview key="cat" media={[...media]} answer />)
  expect(screen.getByText('Answer')).toBeVisible()
  expect(load).toHaveBeenCalledTimes(1)
  rerender(<Preview key="dog" media={[reference('two', '犬.png')]} />)
  await waitFor(() => expect(screen.getByRole('img', { name: '犬.png' })).toHaveAttribute('src', 'data:image/png;base64,AQID'))
  expect(screen.queryByRole('img', { name: '猫.png' })).not.toBeInTheDocument()
  expect(load.mock.calls.map(([digest]) => digest)).toEqual(['one', 'two'])
  unmount()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('unmount aborts an in-flight media read and cannot populate the following card', async () => {
  let resolveRead: ((value: MediaBytes) => void) | undefined
  vi.spyOn(collection, 'verifiedMediaBytes').mockImplementation(() => new Promise((resolve) => { resolveRead = resolve }))
  const encode = vi.spyOn(window, 'btoa')
  const { unmount } = render(<Preview media={[reference('one', '猫.png')]} />)
  await waitFor(() => expect(resolveRead).toBeDefined())
  unmount()
  resolveRead!(stored('one'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(encode).not.toHaveBeenCalled()
})
