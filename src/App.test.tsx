import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { State } from 'ts-fsrs'
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

test('rotates a paired device key from the visible sync controls', async () => {
  const priorFetch = globalThis.fetch
  const fetcher = vi.fn((input: RequestInfo | URL) => String(input).endsWith('/api/backups')
    ? Promise.resolve(Response.json({ backups: [], retention: { maximum: 14, days: 30 } }))
    : Promise.resolve(Response.json({ token: 'rotated-device-key' })))
  globalThis.fetch = fetcher as typeof fetch
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'old-device-key', cursor: 6 })
  try {
    render(<CollectionWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate device key' }))
    await waitFor(async () => expect(await collection.syncSettings()).toEqual({ endpoint: 'https://pc.example.test', token: 'rotated-device-key', cursor: 6 }))
    expect(await screen.findByText(/previous key can no longer sync this collection/i)).toBeVisible()
    expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/credential/rotate', expect.objectContaining({ method: 'POST' }))
  } finally {
    globalThis.fetch = priorFetch
    await collection.settings.delete('sync')
  }
})

test('does not claim the old key is unchanged after a lost rotation response', async () => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('connection dropped')) as typeof fetch
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'old-device-key', cursor: 6 })
  try {
    render(<CollectionWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate device key' }))
    expect(await screen.findByText(/may have rotated this device key, but confirmation was lost/i)).toBeVisible()
    expect(screen.getByText(/pair this device again before syncing/i)).toBeVisible()
  } finally {
    globalThis.fetch = priorFetch
    await collection.settings.delete('sync')
  }
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
    expect(within(navigation).getByRole('link', { name: 'Study' })).not.toHaveAttribute('aria-disabled')
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

test('explains the Lockdown Mode offline limit and disables sync when service workers are absent', async () => {
  Reflect.deleteProperty(navigator, 'serviceWorker')
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'test-token', cursor: 0 })
  render(<App />)
  expect(screen.getByTestId('offline-shell-warning')).toHaveTextContent(/installed Home Screen app/)
  expect(screen.getByTestId('offline-shell-warning')).toHaveTextContent(/iOS Lockdown Mode can disable it/)
  expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Pair another device' })).toBeEnabled()
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

test('a learner configures interday ordering, sibling burial, and leech handling', async () => {
  const deck = await collection.createDeck(`Policy controls ${crypto.randomUUID()}`)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Scheduling options' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scheduling options' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create option group' }))
    fireEvent.change(within(dialog).getByLabelText('Option group name'), { target: { value: 'Focused policy' } })
    fireEvent.change(within(dialog).getByLabelText('Interday learning order'), { target: { value: 'after-reviews' } })
    fireEvent.click(within(dialog).getByLabelText('Bury new siblings'))
    fireEvent.click(within(dialog).getByLabelText('Bury review siblings'))
    fireEvent.change(within(dialog).getByLabelText('Leech threshold'), { target: { value: '3' } })
    fireEvent.change(within(dialog).getByLabelText('Leech action'), { target: { value: 'tag-only' } })
    fireEvent.change(within(dialog).getByLabelText('Leech tag'), { target: { value: 'Needs attention' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save options' }))
    await waitFor(async () => {
      const updated = await collection.decks.get(deck.id)
      const group = updated && await collection.deckOptionGroups.get(updated.optionGroupId)
      expect(group).toMatchObject({
        name: 'Focused policy',
        interdayLearningOrder: 'after-reviews',
        buryNewSiblings: true,
        buryReviewSiblings: true,
        leechThreshold: 3,
        leechAction: 'tag-only',
        leechTag: 'Needs attention',
      })
    })
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a learner resumes, unburies, and reschedules a card from its deck', async () => {
  const deck = await collection.createDeck(`Card controls ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '再開', back: 'resume' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  await collection.suspendCard(card.id)
  await collection.buryCard(card.id)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Manage cards' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage cards' })
    fireEvent.click(await within(dialog).findByRole('button', { name: /Resume card 1, template / }))
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({ manualSuspended: false }))
    fireEvent.click(await within(dialog).findByRole('button', { name: /Unbury card 1, template / }))
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({ buriedUntil: null }))
    fireEvent.change(await within(dialog).findByLabelText(/Reschedule due for card 1, template /), { target: { value: '2026-11-02T09:30' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Reschedule card 1, template / }))
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({
      manualSuspended: false,
      buriedUntil: null,
      due: new Date('2026-11-02T09:30').toISOString(),
    }))
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a learner can suspend or bury the current review card and the queue refreshes', async () => {
  const deck = await collection.createDeck(`Review controls ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '隠す', back: 'hide' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend card' }))
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({ manualSuspended: true }))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a failed reviewer action keeps the card available for retry and announces the error', async () => {
  const deck = await collection.createDeck(`Review failure ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '失敗', back: 'failure' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  const suspend = vi.spyOn(collection, 'suspendCard').mockRejectedValueOnce(new Error('Storage unavailable'))
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend card' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable')
    expect(screen.getByRole('button', { name: 'Suspend card' })).toBeEnabled()
    expect(await collection.cards.get(card.id)).toMatchObject({ manualSuspended: false })
  } finally {
    suspend.mockRestore()
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a synced reschedule removes the current reviewer card when it is no longer due', async () => {
  const deck = await collection.createDeck(`Synced reschedule ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '予定', back: 'schedule' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  await collection.cards.update(card.id, { due: new Date(Date.now() - 60 * 1000).toISOString(), state: State.Review })
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    await screen.findByRole('button', { name: 'Suspend card' })
    await collection.rescheduleCard(card.id, new Date(Date.now() + 60 * 60 * 1000))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a synced reschedule in a child deck removes the current parent review card', async () => {
  const parent = await collection.createDeck(`Parent reschedule ${crypto.randomUUID()}`)
  const child = await collection.createDeck('Child', { parentId: parent.id })
  const note = await collection.createBasicNote(child.id, { front: '子', back: 'child' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  await collection.cards.update(card.id, { due: new Date(Date.now() - 60 * 1000).toISOString(), state: State.Review })
  window.location.hash = `#review/${parent.id}`
  render(<CollectionWorkspace />)
  try {
    await screen.findByRole('button', { name: 'Suspend card' })
    await collection.rescheduleCard(card.id, new Date(Date.now() + 60 * 60 * 1000))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
  } finally {
    await collection.deleteDeck(parent.id, { mode: 'delete-subtree' })
  }
})

test('card management gives every control a distinct card and template name', async () => {
  const deck = await collection.createDeck(`Accessible card controls ${crypto.randomUUID()}`)
  const type = await collection.createNoteType({
    name: `Accessible templates ${crypto.randomUUID()}`,
    kind: 'standard',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [
      { name: 'First template', front: '{{Front}}', back: '{{Back}}', css: '' },
      { name: 'Second template', front: '{{Back}}', back: '{{Front}}', css: '' },
    ],
  })
  const note = await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '一', [type.fields[1].id]: '二' })
  const [firstCard, secondCard] = await collection.cards.where('noteId').equals(note.id).sortBy('templateId')
  await collection.suspendCard(firstCard.id)
  await collection.buryCard(secondCard.id)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Manage cards' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage cards' })
    const rescheduleInputs = await within(dialog).findAllByLabelText(/Reschedule due for card \d+, template /)
    const rescheduleButtons = within(dialog).getAllByRole('button', { name: /Reschedule card \d+, template / })
    const lifecycleButtons = [
      within(dialog).getByRole('button', { name: /Resume card \d+, template / }),
      within(dialog).getByRole('button', { name: /Bury card \d+, template / }),
      within(dialog).getByRole('button', { name: /Suspend card \d+, template / }),
      within(dialog).getByRole('button', { name: /Unbury card \d+, template / }),
    ]
    expect(rescheduleInputs).toHaveLength(2)
    expect(new Set(rescheduleInputs.map((input) => input.getAttribute('aria-label'))).size).toBe(2)
    expect(new Set(rescheduleButtons.map((button) => button.getAttribute('aria-label'))).size).toBe(2)
    expect(new Set(lifecycleButtons.map((button) => button.getAttribute('aria-label'))).size).toBe(4)
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await collection.deleteNoteType(type.id)
  }
})

test('answering a card refreshes queued siblings that the policy buries', async () => {
  const deck = await collection.createDeck(`Sibling refresh ${crypto.randomUUID()}`)
  const type = await collection.createNoteType({
    name: `Two cards ${crypto.randomUUID()}`,
    kind: 'standard',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [
      { name: 'Front card', front: '{{Front}}', back: '{{Back}}', css: '' },
      { name: 'Back card', front: '{{Back}}', back: '{{Front}}', css: '' },
    ],
  })
  const group = (await collection.deckOptionGroups.get(deck.optionGroupId))!
  await collection.updateDeckOptionGroup(group.id, { ...group, buryNewSiblings: true })
  await collection.createNote(deck.id, type.id, { [type.fields[0].id]: '表', [type.fields[1].id]: '裏' })
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Show answer' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /^Good ·/ }))[0])
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
    await waitFor(async () => expect((await collection.cards.where('deckId').equals(deck.id).toArray()).some((card) => card.buriedUntil)).toBe(true))
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
    await collection.deleteNoteType(type.id)
  }
})

test('editing and moving the current note work without leaving the reviewer', async () => {
  const source = await collection.createDeck(`Reviewer source ${crypto.randomUUID()}`)
  const destination = await collection.createDeck(`Reviewer target ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(source.id, { front: '古い', back: 'old' })
  window.location.hash = `#review/${source.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Card info' }))
    expect(within(await screen.findByRole('dialog', { name: 'Card info' })).getAllByText('Basic')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit Basic note' })
    fireEvent.change(within(editor).getByLabelText('Front'), { target: { value: '新しい' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await collection.notes.get(note.id)).toMatchObject({ fields: { front: '新しい', back: 'old' } }))
    expect(screen.getByRole('button', { name: 'Show answer' })).toBeVisible()
    await waitFor(() => expect(screen.getByTitle('Review card')).toHaveAttribute('srcdoc', expect.stringContaining('新しい')))

    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }))
    const tags = await screen.findByRole('dialog', { name: 'Edit tags' })
    fireEvent.change(within(tags).getByLabelText('Tags'), { target: { value: 'kanji, sentence, kanji' } })
    fireEvent.click(within(tags).getByRole('button', { name: 'Save tags' }))
    await waitFor(async () => expect(await collection.notes.get(note.id)).toMatchObject({ tags: ['kanji', 'sentence'] }))
    expect((await collection.pendingOperations()).some((operation) => operation.entityType === 'note' && operation.entityId === note.id && (operation.payload as { tags?: string[] }).tags?.includes('sentence'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Move note' }))
    const mover = await screen.findByRole('dialog', { name: 'Move note' })
    await waitFor(() => expect(within(mover).getByRole('option', { name: destination.name })).toBeVisible())
    fireEvent.change(within(mover).getByLabelText('Destination deck'), { target: { value: destination.id } })
    fireEvent.click(within(mover).getByRole('button', { name: 'Move note' }))
    await waitFor(async () => expect(await collection.notes.get(note.id)).toMatchObject({ deckId: destination.id }))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
  } finally {
    await collection.deleteDeck(source.id, { mode: 'delete-subtree' })
    await collection.deleteDeck(destination.id, { mode: 'delete-subtree' })
  }
})

test('review keyboard shortcuts use the same answer and rating actions as touch controls', async () => {
  const deck = await collection.createDeck(`Keyboard review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '聞く', back: 'listen' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    await screen.findByRole('button', { name: 'Show answer' })
    fireEvent.keyDown(window, { key: 'e' })
    const editor = await screen.findByRole('dialog', { name: 'Edit Basic note' })
    fireEvent.keyDown(window, { key: '3' })
    expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(0)
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: ' ' })
    const good = await screen.findByRole('button', { name: /^Good ·/ })
    expect(good).toBeVisible()
    fireEvent.keyDown(good, { key: '3' })
    await waitFor(async () => expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(1))
    await screen.findByRole('heading', { name: 'Session complete' })
    const undo = await screen.findByRole('button', { name: 'Undo last review' })
    await waitFor(() => expect(undo).toBeEnabled())
    fireEvent.click(undo)
    await waitFor(async () => expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(0))
    expect(await screen.findByRole('button', { name: 'Show answer' })).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('review shortcuts stay silent while a control owns the press', async () => {
  const deck = await collection.createDeck(`Typing review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '書く', back: 'write' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    // The guard reads event.target, so dispatching on window would never reach
    // it - and the reviewer state flags would mask a broken guard anyway. The
    // flag select is a real control in the review view that a shortcut must not
    // reach through.
    const flag = await screen.findByRole('combobox', { name: 'Card flag' })
    for (const key of ['e', 'd', 'm', 't', 'i', 's', 'b', 'f', 'k', ' ', '3']) fireEvent.keyDown(flag, { key })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await collection.reviewEntries.where('cardId').equals(card.id).count()).toBe(0)
    expect(await collection.cards.get(card.id)).toMatchObject({ flag: 0 })
    expect((await collection.notes.get(note.id))?.tags ?? []).not.toContain('marked')
    expect(flag).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a shortcut cannot reach through a dialog that kept focus on its trigger', async () => {
  const deck = await collection.createDeck(`Guard review ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '飲む', back: 'drink' })
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    await screen.findByRole('button', { name: 'Show answer' })
    // The export trigger is rendered outside ReviewSession and the dialog takes
    // no initial focus, so in a real browser focus is still on the trigger.
    const trigger = await screen.findByRole('button', { name: 'Export Anki package' })
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: 'Export Anki package' })
    trigger.focus()
    expect(trigger).toHaveFocus()

    for (const key of ['e', 'd', 'm', 't', 'i']) fireEvent.keyDown(trigger, { key })
    // Only the export dialog may exist; a second modal would be stacked on it.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('the deck panel keycap advertises a shortcut that works', async () => {
  render(<CollectionWorkspace />)
  const keycap = await screen.findByText('N')
  // The keycap sits in the panel heading of the panel whose action is New deck,
  // so it only means something if that is the action it opens.
  expect(keycap.closest('.empty-panel')).toContainElement(screen.getByRole('button', { name: /new deck/i }))

  fireEvent.keyDown(window, { key: 'n' })
  expect(await screen.findByRole('dialog', { name: 'Create a deck' })).toBeVisible()
})

test('card actions announce what happened', async () => {
  const deck = await collection.createDeck(`Announce review ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '話す', back: 'speak' })
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    // Rating a card removes it from view without moving focus, so this is the
    // only signal a screen-reader user gets that anything happened. The text is
    // not enough on its own: without the live-region role nothing is spoken.
    fireEvent.click(await screen.findByRole('button', { name: 'Show answer' }))
    expect(await screen.findByText(/Answer shown\. Rate the card with 1 to 4\./)).toHaveAttribute('role', 'status')

    fireEvent.click(await screen.findByRole('button', { name: /^Good ·/ }))
    expect(await screen.findByText(/^Recorded Good\. 1 rated this session\.$/)).toHaveAttribute('role', 'status')
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('maintenance actions announce what happened', async () => {
  const deck = await collection.createDeck(`Announce maintenance ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '帰る', back: 'go home' })
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Mark note' }))
    expect(await screen.findByText('Marked.')).toHaveAttribute('role', 'status')

    fireEvent.click(screen.getByRole('button', { name: 'Suspend card' }))
    // Suspending empties the queue, so the announcement has to survive the
    // session-complete branch that replaces the reviewer markup.
    expect(await screen.findByText('Card suspended.')).toHaveAttribute('role', 'status')
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('a learner can skip the navigation with the keyboard', () => {
  render(<App />)
  const skip = screen.getByRole('link', { name: 'Skip to main content' })
  expect(skip).toHaveAttribute('href', '#decks')
  // The link is the first focusable element, ahead of the sidebar, and the
  // target has to be able to receive focus for the jump to mean anything.
  expect(document.querySelector('a.app-shell > a, .app-shell > a')).toBe(skip)
  expect(document.getElementById('decks')).toHaveAttribute('tabindex', '-1')
})

test('labelled groups expose their label to assistive technology', async () => {
  const deck = await collection.createDeck(`Counted deck ${crypto.randomUUID()}`)
  window.location.hash = '#decks'
  render(<App />)
  try {
    // aria-label on a plain div is ignored, so these need a role to be exposed.
    await waitFor(() => expect(screen.getByRole('group', { name: 'Deck counts' })).toBeInTheDocument())
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('reviewer flag control and keyboard shortcut update the current card', async () => {
  const deck = await collection.createDeck(`Flag review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '旗', back: 'flag' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    const flagControl = await screen.findByRole('combobox', { name: 'Card flag' })
    fireEvent.change(flagControl, { target: { value: '1' } })
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({ flag: 1 }))
    expect(screen.getByRole('button', { name: 'Show answer' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'f' })
    await waitFor(async () => expect(await collection.cards.get(card.id)).toMatchObject({ flag: 2 }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark note' }))
    await waitFor(async () => expect(await collection.notes.get(note.id)).toMatchObject({ tags: ['marked'] }))
    expect(await screen.findByRole('button', { name: 'Unmark note' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Card info' }))
    expect(within(await screen.findByRole('dialog', { name: 'Card info' })).getByText('Orange')).toBeVisible()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('reviewer deletion can restore the note and card before sync', async () => {
  const deck = await collection.createDeck(`Delete review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '消す', back: 'delete' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    await screen.findByRole('button', { name: 'Delete note' })
    fireEvent.keyDown(window, { key: 'd' })
    const dialog = await screen.findByRole('dialog', { name: 'Delete note' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note and cards' }))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
    expect(await collection.notes.get(note.id)).toBeUndefined()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo note deletion' }))
    expect(await screen.findByRole('button', { name: 'Show answer' })).toBeVisible()
    expect(await collection.cards.get(card.id)).toBeDefined()
  } finally {
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test('reviewer can undo a suspension from the completed session', async () => {
  const deck = await collection.createDeck(`Suspend review ${crypto.randomUUID()}`)
  const note = await collection.createBasicNote(deck.id, { front: '待つ', back: 'wait' })
  const card = (await collection.cards.where('noteId').equals(note.id).first())!
  window.location.hash = `#review/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend card' }))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeVisible()
    // The queue can empty before the maintenance transaction finishes. The
    // shortcut is available once the visible undo control becomes enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo card action' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'v' })
    expect(await screen.findByRole('button', { name: 'Show answer' })).toBeVisible()
    expect(await collection.cards.get(card.id)).toMatchObject({ manualSuspended: false })
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
