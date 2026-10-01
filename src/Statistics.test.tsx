import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { App } from './App'
import { Statistics } from './Statistics'
import { collection, Rating } from './collection'
import { localDayKey } from './progress-statistics'

afterEach(() => { cleanup(); window.location.hash = '' })

test('statistics navigation is active and the empty collection explains missing data', async () => {
  window.location.hash = '#statistics'
  render(<App />)
  await screen.findByRole('heading', { name: 'Every answer adds up' })
  const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
  expect(within(navigation).getByRole('link', { name: 'Statistics' })).toHaveAttribute('aria-current', 'page')
  expect(within(navigation).getByRole('link', { name: 'Decks' })).not.toHaveAttribute('aria-current')
  expect(screen.getByText('No timed answers in this period')).toBeVisible()
  expect(screen.getByText(/No answers in this period/)).toBeVisible()
})

test('live offline answers and undo update totals, heatmap selection, and chronological card history', async () => {
  const now = new Date()
  const earlier = new Date(now); earlier.setDate(earlier.getDate() - 1)
  const deck = await collection.createDeck(`Statistics ${crypto.randomUUID()}`, earlier)
  try {
    const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' }, earlier)
    const [card] = await collection.cards.where('noteId').equals(note.id).toArray()
    render(<Statistics />)
    await screen.findByRole('heading', { name: 'Every answer adds up' })
    fireEvent.change(screen.getByLabelText('Statistics deck'), { target: { value: deck.id } })
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'all' } })
    await collection.answer(card.id, Rating.Good, earlier, 5000)
    await collection.answer(card.id, Rating.Good, now, 7000)
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('2'))
    expect(screen.getByText('REVIEW TIME').parentElement).toHaveTextContent('0.2 min')
    fireEvent.click(screen.getByRole('button', { name: `${localDayKey(earlier)}: 1 answers` }))
    expect(screen.getByLabelText('Period')).toHaveValue('day')
    expect(screen.getByLabelText('Date')).toHaveValue(localDayKey(earlier))
    expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: '猫 · basic' }))
    const dialog = screen.getByRole('dialog', { name: 'Card progress' })
    const history = within(dialog).getByRole('region', { name: 'Card review history' })
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(2))
    const dates = [...history.querySelectorAll('time')].map((time) => time.dateTime)
    expect(dates).toEqual([earlier.toISOString(), now.toISOString()])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('1'))
    await collection.undoLastReview()
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('0'))
  } finally { cleanup(); await collection.deleteDeck(deck.id, { mode: 'delete-subtree' }) }
})
