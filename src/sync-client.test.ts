import { describe, expect, test, vi } from 'vitest'
import { foregroundSync } from './sync-client'

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
