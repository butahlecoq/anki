import { expect, it } from 'vitest'
import { NativeAnkiClient } from './native-anki-sync'
import { handlePairedAnkiWebRelay } from '../server/ankiweb-gateway'

it('identifies an upstream login rejection without exposing the response body or credentials', async () => {
  const transport = async (_route: string, body: FormData) => handlePairedAnkiWebRelay(
    new Request('https://pc.example/api/ankiweb/sync/hostKey', {
      method: 'POST', headers: { origin: 'https://app.example', authorization: `Bearer ${'b'.repeat(64)}` }, body,
    }), { PWA_ORIGIN: 'https://app.example' }, () => true,
    async () => new Response('sensitive upstream details', { status: 400 }),
  )
  await expect(NativeAnkiClient.login(transport, 'private username', 'private password')).rejects.toMatchObject({
    code: 'transfer',
    requestFailure: { route: 'sync/hostKey', status: 400, source: 'upstream' },
    message: expect.stringContaining('sign-in'),
  })
  try { await NativeAnkiClient.login(transport, 'private username', 'private password') } catch (error) {
    expect(JSON.stringify(error)).not.toMatch(/sensitive upstream|private username|private password/)
  }
})

it('does not describe a relay origin rejection as incorrect AnkiWeb credentials', async () => {
  const transport = async (_route: string, body: FormData) => handlePairedAnkiWebRelay(
    new Request('https://pc.example/api/ankiweb/sync/hostKey', {
      method: 'POST', headers: { origin: 'https://other.example', authorization: `Bearer ${'b'.repeat(64)}` }, body,
    }), { PWA_ORIGIN: 'https://app.example' }, () => true,
    async () => { throw new Error('Must not reach upstream') },
  )
  await expect(NativeAnkiClient.login(transport, 'user', 'password')).rejects.toMatchObject({
    code: 'transfer', requestFailure: { route: 'sync/hostKey', status: 403, source: 'relay' },
    message: expect.stringContaining('PC relay'),
  })
})

it('keeps an unclassified HTTP 403 distinct from confirmed AnkiWeb credential rejection', async () => {
  await expect(NativeAnkiClient.login(async () => new Response(null, { status: 403 }), 'user', 'password')).rejects.toMatchObject({
    code: 'transfer', requestFailure: { route: 'sync/hostKey', status: 403, source: 'unknown' },
  })
})
