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
    expect(screen.queryByRole('button', { name: 'Practice again', exact: true })).not.toBeInTheDocument()
    await act(async () => { finish(queued); await pending })
    expect(await screen.findByRole('heading', { name: deck.name, exact: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Study now', exact: true })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Practice again', exact: true })).not.toBeInTheDocument()
  } finally { finish(queued) }
})
