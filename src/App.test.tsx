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
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
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

test('the add-note chooser opens the dedicated image occlusion editor', async () => {
  const deck = await collection.createDeck(`Occlusion editor ${crypto.randomUUID()}`)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Add note' }))
    await screen.findByRole('option', { name: 'Image Occlusion' })
    const type = screen.getByRole('combobox', { name: 'Note type' })
    fireEvent.change(type, { target: { value: 'image-occlusion' } })
    expect(await screen.findByRole('heading', { name: 'Add image occlusion note' })).toBeVisible()
    expect(screen.getByLabelText('Source image')).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp')
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a learner creates a child deck from its parent', async () => {
  const parent = await collection.createDeck(`Parent ${crypto.randomUUID()}`)
  window.location.hash = `#deck/${parent.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Create child deck' }))
    fireEvent.change(screen.getByLabelText('Deck name'), { target: { value: 'Verbs' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Create a child deck' })).getByRole('button', { name: 'Create child deck' }))
    await waitFor(async () => expect(await collection.decks.where('parentId').equals(parent.id).first()).toMatchObject({ name: 'Verbs' }))
  } finally {
    await collection.deleteDeck(parent.id, { mode: 'delete-subtree' })
  }
})

test('a learner creates and assigns reusable scheduling options', async () => {
  const deck = await collection.createDeck(`Options ${crypto.randomUUID()}`)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Scheduling options' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scheduling options' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create option group' }))
    fireEvent.change(within(dialog).getByLabelText('Option group name'), { target: { value: 'Short sessions' } })
    fireEvent.change(within(dialog).getByLabelText('Daily new limit'), { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save options' }))
    await waitFor(async () => {
      const updated = await collection.decks.get(deck.id)
      const group = updated && await collection.deckOptionGroups.get(updated.optionGroupId)
      expect(group).toMatchObject({ name: 'Short sessions', dailyNewLimit: 1 })
    })
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a learner moves a deck under a different parent', async () => {
  const firstParent = await collection.createDeck(`First ${crypto.randomUUID()}`)
  const secondParent = await collection.createDeck(`Second ${crypto.randomUUID()}`)
  const child = await collection.createDeck('Child', { parentId: firstParent.id })
  window.location.hash = `#deck/${child.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Move deck' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move deck' })
    await waitFor(() => expect(within(dialog).getByRole('option', { name: secondParent.name })).toBeVisible())
    fireEvent.change(within(dialog).getByLabelText('New parent deck'), { target: { value: secondParent.id } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move deck' }))
    await waitFor(async () => expect(await collection.decks.get(child.id)).toMatchObject({ parentId: secondParent.id }))
  } finally {
    await collection.deleteDeck(firstParent.id, { mode: 'delete-subtree' })
    await collection.deleteDeck(secondParent.id, { mode: 'delete-subtree' })
  }
})

test('the deck list presents nested decks with parent aggregate counts', async () => {
  const parent = await collection.createDeck(`Japanese ${crypto.randomUUID()}`)
  const child = await collection.createDeck('Reading', { parentId: parent.id })
  await collection.createBasicNote(child.id, { front: '読む', back: 'read' })
  window.location.hash = '#decks'
  render(<CollectionWorkspace />)
  try {
    const hierarchy = await screen.findByRole('tree', { name: 'Deck hierarchy' })
    expect(within(hierarchy).getByText(parent.name)).toBeVisible()
    expect(within(hierarchy).getByText('Reading')).toBeVisible()
    expect(within(hierarchy).getAllByText('NEW')[0]).toHaveTextContent('1')
  } finally {
    await collection.deleteDeck(parent.id, { mode: 'delete-subtree' })
  }
})

test('a learner relocates a deck through an explicit delete choice', async () => {
  const source = await collection.createDeck(`Source ${crypto.randomUUID()}`)
  const destination = await collection.createDeck(`Destination ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(source.id, { front: '移す', back: 'move' })
  window.location.hash = `#deck/${source.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Delete deck' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete deck' })
    fireEvent.click(within(dialog).getByLabelText('Relocate contents and child decks'))
    await waitFor(() => expect(within(dialog).getByRole('option', { name: destination.name })).toBeVisible())
    fireEvent.change(within(dialog).getByLabelText('Destination deck'), { target: { value: destination.id } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Relocate and delete deck' }))
    await waitFor(async () => expect(await collection.notes.get(note.id)).toMatchObject({ deckId: destination.id }))
  } finally {
    await collection.deleteDeck(destination.id, { mode: 'delete-subtree' })
  }
})

test('a learner moves a note without replacing its card', async () => {
  const source = await collection.createDeck(`Notes ${crypto.randomUUID()}`)
  const destination = await collection.createDeck(`Target ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(source.id, { front: '動かす', back: 'move' })
  const card = await collection.cards.where('noteId').equals(note.id).first()
  window.location.hash = `#deck/${source.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Move note' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move note' })
    await waitFor(() => expect(within(dialog).getByRole('option', { name: destination.name })).toBeVisible())
    fireEvent.change(within(dialog).getByLabelText('Destination deck'), { target: { value: destination.id } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move note' }))
    await waitFor(async () => {
      expect(await collection.notes.get(note.id)).toMatchObject({ deckId: destination.id })
      expect(await collection.cards.get(card!.id)).toMatchObject({ id: card!.id, deckId: destination.id })
    })
  } finally {
    await collection.deleteDeck(source.id, { mode: 'delete-subtree' })
    await collection.deleteDeck(destination.id, { mode: 'delete-subtree' })
  }
})

test('study availability follows the deck daily limit', async () => {
  const deck = await collection.createDeck(`Limited ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '一', back: 'one' })
  const group = (await collection.deckOptionGroups.get(deck.optionGroupId))!
  await collection.updateDeckOptionGroup(group.id, { ...group, dailyNewLimit: 0 })
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    expect(await screen.findByRole('button', { name: 'Study now' })).toBeDisabled()
  } finally {
    await collection.updateDeckOptionGroup(group.id, group)
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
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
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await collection.deleteNoteType(type.id)
  }
})
