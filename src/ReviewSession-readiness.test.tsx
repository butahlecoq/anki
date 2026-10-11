import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { collection } from './collection'
import * as queries from './collection-queries'
import { ReviewSession } from './ReviewSession'
import { atReviewNoon } from '../tests/helpers/review-clock'

test('does not offer a new card with the previous note while its note query refreshes', () => atReviewNoon(async () => {
  const deck = await collection.createDeck(`Review readiness ${crypto.randomUUID()}`)
  const first = await collection.createBasicNote(deck.id, { front: '猫', back: 'ねこ' })
  const second = await collection.createBasicNote(deck.id, { front: '犬', back: 'いぬ' })
  const queue = await collection.reviewQueue(deck.id, new Date())
  const nextNote = queue[1].noteId === first.id ? first : second
  const originalRead = queries.readNote
  let releaseNote!: () => void
  const heldNote = new Promise<void>((resolve) => { releaseNote = resolve })
  let noteReadStarted = false
  const read = vi.spyOn(queries, 'readNote').mockImplementation((source, id) => {
    const result = originalRead(source, id)
    return id === nextNote.id ? result.then(async (note) => {
      noteReadStarted = true
      await heldNote
      return note
    }) : result
  })
  try {
    render(<ReviewSession deckId={deck.id} onBack={() => {}} />)
    const reveal = await screen.findByRole('button', { name: 'Show answer' })
    await waitFor(() => expect(reveal).toBeEnabled())
    fireEvent.click(reveal)
    const good = await screen.findByRole('button', { name: /^Good ·/ })
    await waitFor(() => expect(good).toBeEnabled())
    fireEvent.click(good)
    await waitFor(() => expect(noteReadStarted).toBe(true))
    expect(screen.queryByRole('button', { name: 'Show answer' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Preparing review')
    fireEvent.keyDown(window, { key: 'e' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { releaseNote() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show answer' })).toBeEnabled())
    expect(screen.getByTitle('Review card')).toHaveAttribute('srcdoc', expect.stringContaining(nextNote.fields.front))
    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }))
    const nextGood = await screen.findByRole('button', { name: /^Good ·/ })
    await waitFor(() => expect(nextGood).toBeEnabled())
    fireEvent.click(nextGood)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show answer' })).toBeEnabled())
    expect(screen.queryByRole('heading', { name: 'Session complete' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2 rated this session')
    const repeatedNote = queue[0].noteId === first.id ? first : second
    await waitFor(() => expect(screen.getByTitle('Review card')).toHaveAttribute('srcdoc', expect.stringContaining(repeatedNote.fields.front)))
    fireEvent.keyDown(window, { key: 'u' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show answer' })).toBeEnabled())
    await waitFor(() => expect(screen.getByTitle('Review card')).toHaveAttribute('srcdoc', expect.stringContaining(nextNote.fields.front)))
  } finally {
    releaseNote()
    cleanup()
    read.mockRestore()
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
}))
