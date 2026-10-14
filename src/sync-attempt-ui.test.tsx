import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { collection } from './collection'
import { CollectionWorkspace } from './CollectionWorkspace'
import { CLIENT_COLLECTION_SCHEMA_VERSION } from '../sync-capabilities.js'

afterEach(async () => {
  cleanup()
  window.location.hash = ''
  vi.unstubAllGlobals()
  await collection.removeLocalCollection()
})

test('Sync now and Prepare offline share one held PC exchange in the visible Deck view', async () => {
  await collection.openLocalCollection()
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  const deck = await collection.createDeck('Japanese')
  const note = await collection.createBasicNote(deck.id, { front: '猫', back: 'cat' })
  const media = await collection.attachMedia(note.id, { file: new File(['cat image'], 'cat.png', { type: 'image/png' }), side: 'front' })
  await collection.evictCachedMedia(media.digest)
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} })
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const fetcher = vi.fn(async (input: string) => {
    if (input.endsWith('/api/connection')) return new Response(JSON.stringify({ automatic: false }))
    if (input.endsWith('/api/health')) return new Response(JSON.stringify({ ready: true, schemaVersion: 1, protocolVersion: 2, collectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, maximumCollectionSchemaVersion: CLIENT_COLLECTION_SCHEMA_VERSION, collectionGeneration: '11111111-1111-4111-8111-111111111111', requiresCollectionGeneration: false, store: 'sqlite' }))
    if (input.endsWith('/api/sync')) { entered(); await held; return new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [], hasMore: false })) }
    if (input.endsWith(`/api/media/${media.digest}`)) return new Response('cat image', { headers: { 'x-content-sha256': media.digest, 'content-type': 'image/png' } })
    throw new Error(`Unexpected request: ${input}`)
  })
  vi.stubGlobal('fetch', fetcher)
  window.location.hash = `#deck/${deck.id}`
  render(<CollectionWorkspace />)
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
    await started
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare this deck for offline use' }))
    await screen.findByText(/Syncing the collection to download this deck’s missing media/)
    release()
    expect(await screen.findByText(/This deck is ready for offline review/)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('region', { name: 'PC sync' })).toHaveTextContent('Sync complete.'))
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/sync'))).toHaveLength(1)
  } finally { release() }
})
