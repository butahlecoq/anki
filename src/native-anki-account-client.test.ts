import { expect, it } from 'vitest'
import { createPairedAnkiWebTransport } from './native-anki-account-client'

it('routes numbered AnkiWeb hosts through the paired PC and keeps that token out of protocol data', async () => {
  const calls: Array<[RequestInfo | URL, RequestInit?]> = []
  const fetcher: typeof fetch = async (input, init) => { calls.push([input, init]); return new Response('ok') }
  const token = 'c'.repeat(64)
  const transport = createPairedAnkiWebTransport({ endpoint: 'https://pc.example.test/', token, cursor: 0 }, fetcher)
  const body = new FormData()
  body.set('data', JSON.stringify({ u: 'temporary-user', p: 'temporary-password' }))
  await transport('sync/hostKey', body, 7, { signal: new AbortController().signal })

  expect(calls).toHaveLength(1)
  const [url, init] = calls[0]!
  if (!init) throw new Error('AnkiWeb transport omitted request options')
  expect(url).toBe('https://pc.example.test/api/ankiweb/sync/hostKey')
  expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`)
  expect(new Headers(init.headers).get('x-ankiweb-host')).toBe('sync7.ankiweb.net')
  expect(init.credentials).toBe('omit')
  expect(init.redirect).toBe('error')
  expect(await new Response(init.body).text()).toContain('temporary-password')
  expect(await new Response(init.body).text()).not.toContain(token)
})
