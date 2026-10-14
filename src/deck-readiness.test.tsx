import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { collection } from './collection'
import { readDeckWorkspaceSnapshot } from './collection-queries'
import { CollectionWorkspace } from './CollectionWorkspace'

afterEach(() => { cleanup(); window.location.hash = ''; vi.restoreAllMocks() })

test('a pending due queue does not present an empty deck or repeat-practice controls', async () => {
  const deck = await collection.createDeck(`Pending queue ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '待つ', back: 'wait' })
  const queued = await collection.reviewQueue(deck.id, new Date())
  expect(queued).toHaveLength(1)
  let finish!: (value: typeof queued) => void
  const pending = new Promise<typeof queued>(resolve => { finish = resolve })
  const queries = [vi.spyOn(collection, 'reviewQueue').mockReturnValue(pending), vi.spyOn(collection, 'dueCards').mockReturnValue(pending)]
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    await waitFor(() => expect(queries.reduce((count, query) => count + query.mock.calls.length, 0)).toBeGreaterThan(0))
    // Drain the independent real workspace/summary reads while only the public
    // due-queue request remains pending.
    await act(async () => {
      await readDeckWorkspaceSnapshot(collection, deck.id)
      await collection.summaries()
    })
    expect(screen.getByRole('status')).toHaveTextContent('Loading local deck')
    expect(screen.queryByRole('button', { name: 'Practice again' })).not.toBeInTheDocument()
    await act(async () => { finish(queued); await pending })
    expect(await screen.findByRole('heading', { name: deck.name })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Study now' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Practice again' })).not.toBeInTheDocument()
  } finally { finish(queued) }
})

test('a pending preparation from another Deck cannot replace the current Deck readiness', async () => {
  const first = await collection.createDeck(`Preparing ${crypto.randomUUID()}`)
  const second = await collection.createDeck(`Current ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(first.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.evictCachedMedia(media.digest)
  let release!: () => void
  let began!: () => void
  const held = new Promise<undefined>((resolve) => { release = () => resolve(undefined) })
  const started = new Promise<void>((resolve) => { began = resolve })
  window.location.hash = `#deck/${first.id}`
  render(<CollectionWorkspace />)
  try {
    const prepare = await screen.findByRole('button', { name: 'Prepare this deck for offline use' })
    await waitFor(() => expect(prepare).toBeEnabled())
    vi.spyOn(collection, 'verifiedMediaBlob').mockImplementation(async () => { began(); return held })
    prepare.click()
    await started
    await act(async () => { window.location.hash = `#deck/${second.id}`; window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByRole('heading', { name: second.name })).toBeVisible()
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(screen.getByText('Offline ready · 0 referenced media files available.')).toBeVisible()
    expect(screen.queryByText(/needs 1 media file from the paired PC/)).not.toBeInTheDocument()
  } finally { release(); cleanup(); await collection.deleteDeck(first.id, { mode: 'delete-subtree' }); await collection.deleteDeck(second.id, { mode: 'delete-subtree' }) }
})
