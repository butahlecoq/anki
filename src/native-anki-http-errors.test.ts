import { expect, it } from 'vitest'
import { NativeAnkiClient } from './native-anki-sync'
import { handlePairedAnkiWebRelay } from '../server/ankiweb-gateway'

it('checks account metadata through the paired relay with an accepted client family and Kiroku identification', async () => {
  const upstream: typeof fetch = async (url, init) => {
    const request = new Request(url, init)
    const form = await request.formData()
    if (new URL(request.url).pathname === '/sync/hostKey') return Response.json({ key: 'generated-account-key' })
    const payload = JSON.parse(String(form.get('data'))) as { v: number; cv: string }
    expect(payload.v).toBe(10)
    // An authenticated production comparison returns 400 for the unknown
    // "kiroku" family and 200 for the "anki" family at the same protocol.
    if (payload.cv.split(',')[0] !== 'anki') return new Response('400', { status: 400 })
    expect(payload.cv).toBe('anki,0.1.0 (kiroku),web')
    return Response.json({ mod: 1, scm: 1, usn: 0, ts: 1, cont: true, empty: false, hostNum: 2, msg: '' })
  }
  const transport = async (route: string, body: FormData) => handlePairedAnkiWebRelay(
    new Request(`https://pc.example/api/ankiweb/${route}`, {
      method: 'POST', headers: { origin: 'https://app.example', authorization: `Bearer ${'b'.repeat(64)}` }, body,
    }), { PWA_ORIGIN: 'https://app.example' }, () => true, upstream,
  )
  const client = await NativeAnkiClient.login(transport, 'generated-user', 'generated-password')
  await expect(client.metadata()).resolves.toMatchObject({ cont: true, empty: false, hostNum: 2 })
})

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
    message: expect.stringContaining('rejected this app origin'),
  })
})

it('keeps an unclassified HTTP 403 distinct from confirmed AnkiWeb credential rejection', async () => {
  await expect(NativeAnkiClient.login(async () => new Response(null, { status: 403 }), 'user', 'password')).rejects.toMatchObject({
    code: 'transfer', requestFailure: { route: 'sync/hostKey', status: 403, source: 'unknown' },
  })
})

it('exposes only safe route and phase details when the transport fails before a response', async () => {
  const error = await NativeAnkiClient.login(async () => { throw new TypeError('private-token private-password private-body') }, 'private-user', 'private-password').catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'transfer', requestFailure: { route: 'sync/hostKey', source: 'unknown', phase: 'before-response' } })
  expect(JSON.stringify(error)).not.toMatch(/private-token|private-password|private-body|private-user/)
})

it('does not retain private stream error content in response-body diagnostics', async () => {
  const error = await NativeAnkiClient.login(async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new TypeError('private-account-content private-token')) },
  })), 'private-user', 'private-password').catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'transfer', requestFailure: { route: 'sync/hostKey', status: 200, phase: 'response-body' } })
  expect(JSON.stringify(error)).not.toMatch(/private-account-content|private-token|private-password|private-user/)
})

it('preserves the transfer limit instead of relabeling it as an interrupted body', async () => {
  await expect(NativeAnkiClient.login(async () => new Response(null, { headers: { 'content-length': String(65 * 1024 * 1024) } }), 'user', 'password')).rejects.toMatchObject({
    code: 'transfer', message: expect.stringContaining('64 MiB transfer limit'),
  })
})

it('preserves a request deadline while reading a successful response', async () => {
  await expect(NativeAnkiClient.login(async () => new Response(new ReadableStream({ start() { /* body never completes */ } })), 'user', 'password', { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' })
})

it('preserves explicit cancellation while reading a successful response', async () => {
  const abort = new AbortController()
  await expect(NativeAnkiClient.login(async () => new Response(new ReadableStream({ pull() { abort.abort() } })), 'user', 'password', { signal: abort.signal })).rejects.toMatchObject({ code: 'cancelled' })
})
