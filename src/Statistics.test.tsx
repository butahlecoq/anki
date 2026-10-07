import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { App } from './App'
import { Statistics, TodayWorkload } from './Statistics'
import { collection, Rating, State } from './collection'
import { localDayKey } from './progress-statistics'
import { readCardsForNote } from './collection-queries'
import { deleteIndexedDbFixtureRow } from '../tests/helpers/damage-indexeddb-media'

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
    const [card] = await readCardsForNote(collection, note.id)
    render(<Statistics />)
    await screen.findByRole('heading', { name: 'Every answer adds up' })
    fireEvent.change(screen.getByLabelText('Statistics deck'), { target: { value: deck.id } })
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'all' } })
    const firstAnswer = await collection.answer(card.id, Rating.Good, earlier, 5000)
    const secondAnswer = await collection.answer(card.id, Rating.Good, now, 7000)
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('2'))
    expect(screen.getByText('REVIEW TIME').parentElement).toHaveTextContent('0.2 min')
    fireEvent.click(screen.getByRole('button', { name: `${localDayKey(earlier)}: 1 answers` }))
    expect(screen.getByLabelText('Period')).toHaveValue('day')
    expect(screen.getByLabelText('Date')).toHaveValue(localDayKey(earlier))
    expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: '猫 · Basic' }))
    const dialog = screen.getByRole('dialog', { name: 'Card progress' })
    const history = within(dialog).getByRole('region', { name: 'Card review history' })
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(2))
    const rows = within(history).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(State[firstAnswer.afterState!])
    expect(rows[1]).toHaveTextContent(State[secondAnswer.afterState!])
    const dates = [...history.querySelectorAll('time')].map((time) => time.dateTime)
    expect(dates).toEqual([earlier.toISOString(), now.toISOString()])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('1'))
    await collection.undo()
    await waitFor(() => expect(screen.getByText('ANSWERS').parentElement).toHaveTextContent('0'))
  } finally { cleanup(); await collection.deleteDeck(deck.id, { mode: 'delete-subtree' }) }
})

test('studied-card names identify each template and open its own history after a rename', async () => {
  const deck = await collection.createDeck(`Template names ${crypto.randomUUID()}`)
  const type = await collection.createNoteType({ name: 'Two directions', fields: [{ name: 'Word' }], templates: [
    { name: 'Recognition', front: '{{Word}}', back: '{{Word}}', css: '' },
    { name: 'Recall', front: '{{Word}}', back: '{{Word}}', css: '' },
  ] })
  try {
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '猫' })
    const cards = await readCardsForNote(collection, note.id)
    await collection.answer(cards.find(card => card.templateId === type.templates[0].id)!.id, Rating.Good)
    await collection.answer(cards.find(card => card.templateId === type.templates[1].id)!.id, Rating.Easy)
    render(<Statistics />)
    await screen.findByRole('heading', { name: 'Every answer adds up' })
    fireEvent.change(screen.getByLabelText('Statistics deck'), { target: { value: deck.id } })
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'all' } })
    for (const [name, rating, otherRating] of [['Recognition', 'Good', 'Easy'], ['Recall', 'Easy', 'Good']]) {
      fireEvent.click(await screen.findByRole('button', { name: `猫 · ${name}` }))
      const dialog = screen.getByRole('dialog', { name: 'Card progress' })
      const history = within(dialog).getByRole('region', { name: 'Card review history' })
      await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(1))
      expect(history).toHaveTextContent(rating)
      expect(history).not.toHaveTextContent(otherRating)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    }
    await collection.updateNoteType(type.id, { templates: type.templates.map(template => ({ ...template, name: template.name === 'Recall' ? 'Production' : template.name })) })
    expect(await screen.findByRole('button', { name: '猫 · Production' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '猫 · Recall' })).not.toBeInTheDocument()
  } finally { cleanup(); await collection.deleteDeck(deck.id, { mode: 'delete-subtree' }); await collection.deleteNoteType(type.id) }
})

test('unavailable template metadata has a readable fallback without losing card history', async () => {
  const deck = await collection.createDeck(`Missing template ${crypto.randomUUID()}`)
  const type = await collection.createNoteType({ name: 'Unavailable metadata', fields: [{ name: 'Word' }], templates: [
    { name: 'Recognition', front: '{{Word}}', back: '{{Word}}', css: '' },
  ] })
  try {
    const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '犬' })
    const [card] = await readCardsForNote(collection, note.id)
    await collection.answer(card.id, Rating.Good)
    // Deliberate missing-metadata fixture, using the existing corruption seam.
    await deleteIndexedDbFixtureRow(collection.databaseName, 'noteTypes', type.id)
    render(<Statistics />)
    await screen.findByRole('heading', { name: 'Every answer adds up' })
    fireEvent.change(screen.getByLabelText('Statistics deck'), { target: { value: deck.id } })
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'all' } })
    fireEvent.click(await screen.findByRole('button', { name: '犬 · Card' }))
    const history = within(screen.getByRole('dialog', { name: 'Card progress' })).getByRole('region', { name: 'Card review history' })
    await waitFor(() => expect(history).toHaveTextContent('Good'))
  } finally { cleanup(); await collection.deleteDeck(deck.id, { mode: 'delete-subtree' }) }
})

test('a selected deck workload excludes answers and cards from unrelated decks', async () => {
  const now = new Date()
  const selected = await collection.createDeck(`Selected ${crypto.randomUUID()}`, now)
  const other = await collection.createDeck(`Other ${crypto.randomUUID()}`, now)
  try {
    await collection.createBasicNote(selected.id, { front: '猫', back: 'cat' }, now)
    const otherNote = await collection.createBasicNote(other.id, { front: '犬', back: 'dog' }, now)
    const [otherCard] = await readCardsForNote(collection, otherNote.id)
    await collection.answer(otherCard.id, Rating.Easy, now, 1000)
    render(<TodayWorkload deckId={selected.id} showLink={false} />)
    const workload = screen.getByRole('region', { name: "Today's workload" })
    await waitFor(() => expect(workload).toHaveTextContent('NEW 1'))
    expect(workload).toHaveTextContent('STUDIED 0')
    expect(within(workload).queryByRole('link')).not.toBeInTheDocument()
  } finally { cleanup(); await collection.deleteDeck(selected.id, { mode: 'delete-subtree' }); await collection.deleteDeck(other.id, { mode: 'delete-subtree' }) }
})
