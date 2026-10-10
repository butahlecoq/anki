import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CollectionWorkspace } from './CollectionWorkspace'
import { collection } from './collection'
import { createCustomStudy, changeCustomStudy } from './custom-study'
import { ReviewSession } from './ReviewSession'

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  window.location.hash = ''
  await collection.clearSyncConfiguration()
})

test.each([false, true])('review omits text transfer when custom=%s', async (custom) => {
  const deck = await collection.createDeck(`Controls ${crypto.randomUUID()}`)
  await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const session = custom ? await createCustomStudy(collection, { name: 'Controls', search: `deck:"${deck.name}"`, limit: 20, order: 'due', reschedule: false }) : undefined
  try {
    render(<ReviewSession deckId={deck.id} sessionId={session?.id} onBack={() => undefined} onExport={() => undefined} />)
    expect(await screen.findByRole('button', { name: 'Show answer' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /import.*export text/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export Anki package' })).toBeInTheDocument()
  } finally {
    cleanup()
    if (session) await changeCustomStudy(collection, session.id, 'delete')
    await collection.deleteDeck(deck.id, { mode: 'delete-subtree' })
  }
})

test.each([false, true])('collection controls omit unwanted actions when paired=%s', async (paired) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ backups: [], retention: { maximum: 14, days: 30 } })))
  const settings = { endpoint: 'https://pc.example.test', token: 'existing-device-key', cursor: 6 }
  if (paired) await collection.configureSync(settings)
  else await collection.clearSyncConfiguration()
  render(<CollectionWorkspace />)
  await waitFor(() => expect(screen.getByText(paired ? 'SYNC // PAIRED' : 'SYNC // LOCAL ONLY')).toBeVisible())
  expect(screen.queryByRole('button', { name: 'Rotate device key' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /import.*export text/i })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export Anki package' })).toBeVisible()
  expect(await collection.syncSettings()).toEqual(paired ? settings : undefined)
})
