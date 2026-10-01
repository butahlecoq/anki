import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'
import { collection } from './collection'
import { CollectionWorkspace } from './CollectionWorkspace'

const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')

afterEach(() => {
  cleanup()
  window.location.hash = ''
  if (serviceWorkerDescriptor) Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
})

test('navigation marks the note-type manager as the current page', () => {
  render(<App />)
  window.location.hash = '#note-types'
  fireEvent(window, new Event('hashchange'))
  const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
  expect(within(navigation).getByRole('link', { name: 'Note types' })).toHaveAttribute('aria-current', 'page')
  expect(within(navigation).getByRole('link', { name: 'Decks' })).not.toHaveAttribute('aria-current')
})

describe('application shell', () => {
  test('presents the local-first study workspace with accessible primary navigation', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation).toBeVisible()
    expect(within(navigation).getByRole('link', { name: 'Decks' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).getByRole('link', { name: 'Note types' })).toHaveAttribute('href', '#note-types')
    expect(within(navigation).getByRole('link', { name: 'Study' })).toBeVisible()
    expect(within(navigation).getByRole('link', { name: 'Study' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Offline cache unavailable')
    expect(screen.getByRole('button', { name: /new deck/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Connect a PC' })).toBeEnabled()
  })
})

test('waits for service-worker readiness before claiming the offline shell is ready', () => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: new Promise(() => undefined) },
  })

  render(<App />)

  expect(screen.getByRole('status')).toHaveTextContent('Preparing offline shell')
  expect(screen.queryByText('Offline shell ready')).not.toBeInTheDocument()
})

test('a stale queue entry whose card was deleted completes review', async () => {
  const deck = await collection.createDeck(`Deleted card ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const [card] = await collection.cards.where('noteId').equals(note.id).toArray()
  await collection.cards.delete(card.id)
  const dueCards = vi.spyOn(collection, 'dueCards').mockResolvedValueOnce([card])
  try {
    window.location.hash = `#review/${deck.id}`
    render(<CollectionWorkspace />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Session complete' })).toBeVisible())
    expect(screen.getByText('0 reviews recorded')).toBeVisible()
  } finally {
    dueCards.mockRestore()
    await collection.deleteDeck(deck.id)
  }
})

test('the note-type editor offers a cloze type with per-ordinal preview', async () => {
  window.location.hash = '#note-types'
  render(<CollectionWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Create note type' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Card generation' }), { target: { value: 'cloze' } })
  expect(screen.getByLabelText('Template 1 front')).toHaveValue('{{cloze:Text}}')
  expect(screen.getByLabelText('Template 1 back')).toHaveValue('{{cloze:Text}}<hr>{{Extra}}')
  expect(screen.getByRole('combobox', { name: 'Preview ordinal' })).toHaveTextContent('c2')
})

test('a malformed synced template shows a card error without crashing review', async () => {
  const deck = await collection.createDeck(`Malformed review ${crypto.randomUUID()}`)
  const type = await collection.createNoteType({ name: 'Cloze review', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
  await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '{{c1::猫}}' })
  await collection.noteTypes.put({ ...type, templates: [{ ...type.templates[0], front: '{{cloze:Text' }] })
  try {
    window.location.hash = `#review/${deck.id}`
    render(<CollectionWorkspace />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/template delimiter/i)
    fireEvent.click(screen.getByRole('button', { name: 'Skip card' }))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id)
    await collection.deleteNoteType(type.id)
  }
})
