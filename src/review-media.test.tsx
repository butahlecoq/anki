import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { collection, type MediaBytes, type NoteMediaReference } from './collection'
import { prepareReviewMedia } from './review-media'
import { useReviewMedia } from './use-review-media'
import * as reviewMedia from './review-media'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const reference = (digest: string, displayName: string): NoteMediaReference => ({
  id: `${digest}:${displayName}`, inline: true, digest, displayName, kind: 'image', mimeType: 'image/png', noteId: 'note', side: 'front', playback: 'manual', createdAt: '2026-10-01', updatedAt: '2026-10-01',
})
const stored = (digest: string): MediaBytes => ({ digest, bytes: new Uint8Array([1, 2, 3]).buffer, byteLength: 3, mimeType: 'image/png', verifiedAt: '2026-10-01' })

test('prepares multiple images and aliases from verified bytes without blob network requests', async () => {
  const load = vi.fn(async (digest: string) => stored(digest))
  const media = await prepareReviewMedia([reference('one', '猫.png'), reference('one', 'cat.png'), reference('two', '犬.png')], new AbortController().signal, load)
  expect(media.byName['猫.png'].url).toBe('data:image/png;base64,AQID')
  expect(media.byName['cat.png'].url).toBe(media.byName['猫.png'].url)
  expect(media.byName['犬.png'].url).toMatch(/^data:image\/png;base64,/)
  expect(load.mock.calls.map(([digest]) => digest)).toEqual(['one', 'two'])
})

test('base64 preserves binary bytes across chunk boundaries and final padding', async () => {
  const bytes = Uint8Array.from({ length: 49_153 }, (_, index) => index % 256)
  const media = await prepareReviewMedia([reference('one', 'large.png')], new AbortController().signal, async (digest) => ({ ...stored(digest), bytes: bytes.buffer, byteLength: bytes.byteLength }))
  const decoded = atob(media.byName['large.png'].url.split(',')[1])
  expect(Uint8Array.from(decoded, (character) => character.charCodeAt(0))).toEqual(bytes)
})

test('audio also encodes offline from stored bytes and retains playback policy', async () => {
  const audio: NoteMediaReference = { ...reference('audio', '猫.wav'), kind: 'audio', mimeType: 'audio/wav', playback: 'automatic' }
  const media = await prepareReviewMedia([audio], new AbortController().signal, async (digest) => ({ ...stored(digest), mimeType: 'audio/wav' }))
  expect(media.byName['猫.wav']).toEqual({ kind: 'audio', url: 'data:audio/wav;base64,AQID', automatic: true })
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
  return <div>{error && <p role="alert">{error}</p>}<span>{answer ? 'Answer' : 'Question'}</span>{Object.entries(sources.byName).map(([name, source]) => <img key={name} alt={name} src={source.url} />)}</div>
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

test('a failed attachment reports an error without blocking the card body', async () => {
  // A media failure must stay non-fatal: the reviewer reports it and keeps the
  // card answerable, so one corrupt attachment cannot wedge a session.
  vi.spyOn(reviewMedia, 'prepareReviewMedia').mockRejectedValue(new Error('This card exceeds the 64 MiB review media limit. Remove attachments or split the note into smaller notes.'))
  render(<Preview media={[reference('one', '猫.png')]} />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Remove attachments or split the note'))
  // The question body is still rendered, so the learner can reveal and rate.
  expect(screen.getByText('Question')).toBeVisible()
})

test('pending state is reported while attachments load and clears once sources exist', async () => {
  vi.spyOn(collection, 'verifiedMediaBytes').mockImplementation(async (digest) => stored(digest))
  const pendingStates: boolean[] = []
  function PendingProbe({ media }: { media: NoteMediaReference[] }) {
    const { sources, pending } = useReviewMedia(media, 'card-1')
    pendingStates.push(pending)
    return <span>{Object.keys(sources.byName).length === 0 ? 'preparing' : 'ready'}</span>
  }
  render(<PendingProbe media={[reference('one', '猫.png')]} />)
  await waitFor(() => expect(screen.getByText('ready')).toBeVisible())
  // Pending must be true before sources arrive and false afterwards.
  expect(pendingStates[0]).toBe(true)
  expect(pendingStates.at(-1)).toBe(false)
})

test('a card with no attachments is never pending', () => {
  const states: boolean[] = []
  function EmptyProbe() {
    const { pending } = useReviewMedia([], 'card-1')
    states.push(pending)
    return null
  }
  render(<EmptyProbe />)
  expect(states.every((value) => value === false)).toBe(true)
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

test('a changed owner clears previous sources even while its replacement read hangs', async () => {
  const load = vi.spyOn(collection, 'verifiedMediaBytes').mockImplementation(async (digest) => stored(digest))
  function OwnerProbe({ owner }: { owner: string }) {
    const { sources, pending } = useReviewMedia([reference('one', '猫.png')], owner)
    return <span>{pending ? 'preparing replacement' : sources.byName['猫.png']?.url}</span>
  }
  const { rerender } = render(<OwnerProbe owner="first-card" />)
  await waitFor(() => expect(screen.getByText('data:image/png;base64,AQID')).toBeVisible())
  load.mockImplementation(() => new Promise(() => {}))
  rerender(<OwnerProbe owner="second-card" />)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  expect(screen.getByText('preparing replacement')).toBeVisible()
  expect(screen.queryByText('data:image/png;base64,AQID')).not.toBeInTheDocument()
})

test('same-name attachments keep distinct reference sources and ambiguous inline names are reported', async () => {
  const first = reference('red', 'picture.png')
  const second = reference('blue', 'picture.png')
  const load = async (digest: string) => ({ ...stored(digest), bytes: new Uint8Array(digest === 'red' ? [255, 0, 0] : [0, 0, 255]).buffer })
  const attachments = await prepareReviewMedia([{ ...first, inline: false }, { ...second, inline: false }], new AbortController().signal, load)
  expect(attachments.byReference[first.id].url).toBe('data:image/png;base64,/wAA')
  expect(attachments.byReference[second.id].url).toBe('data:image/png;base64,AAD/')
  expect(Object.keys(attachments.byName)).toEqual([])
  expect(attachments.warnings).toEqual([])
  const inline = await prepareReviewMedia([first, second, first], new AbortController().signal, load)
  expect(inline.byName['picture.png']).toBeUndefined()
  expect(inline.byReference[first.id].url).not.toBe(inline.byReference[second.id].url)
  expect(inline.warnings).toEqual([expect.stringContaining('refers to different attachments')])
})
