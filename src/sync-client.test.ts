import { expect, test, vi } from 'vitest'
import { foregroundSync, syncCollection } from './sync-client'
import { createCollection } from './collection'

test('sends pending operations with the local pairing credential', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: 2, cursor: 2, changes: [] }), { status: 200 }))
  const result = await foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [{ opId: 'one' }], fetcher)

  expect(result).toEqual({ state: 'complete', accepted: 2, cursor: 2, changes: [] })
  expect(fetcher).toHaveBeenCalledWith('https://pc.example.test/api/sync', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer token' }) }))
})

test('distinguishes authentication and unreachable service failures', async () => {
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockResolvedValue(new Response('', { status: 401 })))).resolves.toEqual({ state: 'authentication-required' })
  await expect(foregroundSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 }, [], vi.fn().mockRejectedValue(new TypeError('network')))).resolves.toEqual({ state: 'unreachable' })
})

test('syncs a configured collection, applies remote reviews, and clears acknowledged operations', async () => {
  const collection = createCollection(`kiroku-test-${crypto.randomUUID()}`)
  await collection.configureSync({ endpoint: 'https://pc.example.test', token: 'token', cursor: 0 })
  await collection.createDeck('Japanese foundations')
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: 0, cursor: 1, changes: [{ opId: 'review-1', entityType: 'review', entityId: 'review-1', action: 'create', occurredAt: '2026-10-01T12:00:00.000Z', payload: { id: 'review-1', cardId: 'card-1', deckId: 'deck-1', rating: 3, state: 0, due: '2026-10-01T12:00:00.000Z', stability: 1, difficulty: 1, elapsedDays: 0, lastElapsedDays: 0, scheduledDays: 0, learningSteps: 0, reviewedAt: '2026-10-01T12:00:00.000Z' } }] }), { status: 200 }))
  await expect(syncCollection(collection, fetcher)).resolves.toMatchObject({ state: 'complete', cursor: 1 })
  await expect(collection.reviewEntries.count()).resolves.toBe(1)
  await expect(collection.pendingOperations()).resolves.toHaveLength(0)
  await collection.delete()
})
