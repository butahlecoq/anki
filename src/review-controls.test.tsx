import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { collection } from './collection'
import { readNote, readCardsForNote } from './collection-queries'
import { ReviewSession } from './ReviewSession'
import { createCustomStudy, changeCustomStudy } from './custom-study'

test.each([false, true])('review removes maintenance controls and shortcuts when custom=%s', async (custom) => {
  const deck = await collection.createDeck(`Simple review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const session = custom ? await createCustomStudy(collection, { name: `Practice ${crypto.randomUUID()}`, search: `deck:"${deck.name}"`, limit: 20, order: 'due', reschedule: false }) : undefined
  try {
    const beforeNote = await readNote(collection, note.id)
    const beforeCards = await readCardsForNote(collection, note.id)
    render(<ReviewSession deckId={deck.id} sessionId={session?.id} onBack={() => undefined} />)
    await screen.findByRole('button', { name: 'Show answer' })
    for (const name of ['Edit note', 'Move note', 'Edit tags', 'Mark note', 'Card info', 'Replay audio', 'Suspend card', 'Bury card', 'Delete note']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Card flag' })).not.toBeInTheDocument()
    for (const key of ['e', 'm', 't', 'k', 'i', 'f', 'r', 's', 'b', 'd']) fireEvent.keyDown(window, { key })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await readNote(collection, note.id)).toEqual(beforeNote)
    expect(await readCardsForNote(collection, note.id)).toEqual(beforeCards)
    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }))
    for (const name of ['Again', 'Hard', 'Good', 'Easy']) expect(screen.getByRole('button', { name: new RegExp(name) })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'End session' })).toBeEnabled()
  } finally {
    cleanup()
    if (session) await changeCustomStudy(collection, session.id, 'delete')
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})
