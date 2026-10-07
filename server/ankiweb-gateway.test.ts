import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleAnkiWebGateway, handlePairedAnkiWebRelay, type GatewayEnvironment } from './ankiweb-gateway.js'

const env: GatewayEnvironment = { PWA_ORIGIN: 'https://study.example', GATEWAY_KEY: 'a'.repeat(64) }
function request(path = '/ankiweb/sync/meta', overrides: RequestInit = {}) {
  return new Request(`https://gateway.example${path}`, {
    method: 'POST', body: Uint8Array.of(0, 255, 17), ...overrides,
    headers: { origin: env.PWA_ORIGIN, 'x-kiroku-gateway-key': env.GATEWAY_KEY, ...overrides.headers },
  })
}

test('rejects unauthorized callers and unsafe destinations before contacting upstream', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return new Response('unexpected') }
  const cases: [Request, GatewayEnvironment, number][] = [
    [request(), { ...env, GATEWAY_KEY: 'short' }, 503],
    [request(), { ...env, PWA_ORIGIN: 'http://study.example' }, 503],
    [request('/ankiweb/sync/meta', { headers: { origin: 'https://evil.example' } }), env, 403],
    [request('/ankiweb/sync/meta', { headers: { 'x-kiroku-gateway-key': 'b'.repeat(64) } }), env, 401],
    [request('/ankiweb/sync/meta', { headers: { 'x-ankiweb-host': 'sync.ankiweb.net.evil.example' } }), env, 400],
    [request('/ankiweb/sync/meta', { headers: { 'x-ankiweb-host': 'localhost:4174' } }), env, 400],
    [request('/ankiweb/sync/meta?url=https://evil.example'), env, 404],
    [request('/ankiweb/sync/unknown'), env, 404],
    [request('/ankiweb/sync/meta', { method: 'PUT' }), env, 405],
    [request('/ankiweb/sync/meta', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }), env, 413],
  ]
  for (const [input, configuration, status] of cases) assert.equal((await handleAnkiWebGateway(input, configuration, fetcher)).status, status)
  assert.equal(calls, 0)
})

test('private CORS preflight allows only the configured origin, POST and protocol headers', async () => {
  const valid = await handleAnkiWebGateway(request('/ankiweb/msync/begin', {
    method: 'OPTIONS', body: null, headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'Anki-Sync, X-Kiroku-Gateway-Key' },
  }), env)
  assert.equal(valid.status, 204)
  assert.equal(valid.headers.get('access-control-allow-origin'), env.PWA_ORIGIN)
  assert.equal(valid.headers.get('cache-control'), 'no-store')
  const bad = await handleAnkiWebGateway(request('/ankiweb/msync/begin', {
    method: 'OPTIONS', body: null, headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Unknown' },
  }), env)
  assert.equal(bad.status, 403)
})

test('streams binary protocol bytes and isolates gateway credentials from the official host', async () => {
  let calls = 0
  const response = await handleAnkiWebGateway(request('/ankiweb/sync/upload', {
    headers: { 'content-type': 'application/octet-stream', 'anki-sync': '{"k":"fake-account-key"}', 'x-ankiweb-host': 'sync2.ankiweb.net', cookie: 'do-not-forward' },
  }), env, async (url, init) => {
    calls++
    assert.equal(url, 'https://sync2.ankiweb.net/sync/upload')
    assert.equal(init?.redirect, 'manual')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('anki-sync'), '{"k":"fake-account-key"}')
    assert.equal(headers.get('x-kiroku-gateway-key'), null)
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('origin'), null)
    assert.equal(headers.get('accept-encoding'), 'identity')
    assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()), Uint8Array.of(0, 255, 17))
    return new Response(Uint8Array.of(255, 0, 128), { headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'do-not-forward' } })
  })
  assert.equal(calls, 1)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(255, 0, 128))
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
})

test('upstream redirects and failures return bounded generic errors without disclosing content', async () => {
  const redirect = await handleAnkiWebGateway(request(), env, async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))
  assert.equal(redirect.status, 502)
  assert.equal(redirect.headers.get('location'), null)
  const failed = await handleAnkiWebGateway(request(), env, async () => { throw new Error('private credential must not appear') })
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /private credential/)
  const auth = await handleAnkiWebGateway(request(), env, async () => new Response('Auth failed', { status: 403 }))
  assert.equal(auth.status, 403)
  const encoded = await handleAnkiWebGateway(request(), env, async () => new Response('encoded bytes', { headers: { 'content-encoding': 'gzip' } }))
  assert.equal(encoded.status, 502)
})

test('collection download survives an upstream response that does not consume its request body', async () => {
  const expected = Uint8Array.of(83, 81, 76, 0, 255)
  const response = await handleAnkiWebGateway(request('/ankiweb/sync/download'), env, async (_url, init) => {
    // An upstream download endpoint can answer immediately, without consuming
    // the upload stream. Fetch then cancels the unused request body.
    if (init?.body instanceof ReadableStream) await init.body.cancel()
    return new Response(new ReadableStream({
      start(controller) {
        if (init?.signal?.aborted) controller.error(new Error('Download was aborted with the unused request body'))
        else { controller.enqueue(expected); controller.close() }
      },
    }), { headers: { 'content-type': 'application/octet-stream' } })
  })
  assert.equal(response.status, 200)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected)
})

test('oversized collection download requests stop before contacting upstream', async () => {
  let chunks = 0
  let contacted = false
  const input = request('/ankiweb/sync/download', {
    body: new ReadableStream({
      pull(controller) { if (chunks++ < 65) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close() },
    }),
    duplex: 'half',
  } as RequestInit)
  const response = await handleAnkiWebGateway(input, env, async () => { contacted = true; return new Response('unexpected') })
  assert.equal(response.status, 502)
  assert.equal(contacted, false)
})

test('declared and actual oversized upstream bodies fail without a successful partial transfer', async () => {
  const declared = await handleAnkiWebGateway(request(), env, async () => new Response('x', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }))
  assert.equal(declared.status, 413)
  let chunks = 0
  const actual = await handleAnkiWebGateway(request(), env, async () => new Response(new ReadableStream({
    pull(controller) { if (chunks++ < 65) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close() },
  })))
  await assert.rejects(actual.arrayBuffer(), /interrupted or exceeded/)
})

test('paired relay authenticates each route and never forwards the paired-device token', async () => {
  const token = 'b'.repeat(64)
  let calls = 0
  const input = new Request('https://pc.example/api/ankiweb/sync/meta', { method: 'POST', headers: { origin: env.PWA_ORIGIN, authorization: `Bearer ${token}`, 'x-ankiweb-host': 'sync3.ankiweb.net' }, body: 'metadata' })
  const result = await handlePairedAnkiWebRelay(input, { PWA_ORIGIN: env.PWA_ORIGIN }, (candidate) => candidate === token, async (url, init) => {
    calls++
    assert.equal(url, 'https://sync3.ankiweb.net/sync/meta')
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    return new Response('ok')
  })
  assert.equal(result.status, 200)
  assert.equal(calls, 1)
  for (const [origin, authorization, status] of [[env.PWA_ORIGIN, '', 401], ['https://evil.example', `Bearer ${token}`, 403]] as const) {
    const denied = await handlePairedAnkiWebRelay(new Request(input.url, { method: 'POST', headers: { origin, authorization }, body: 'metadata' }), { PWA_ORIGIN: env.PWA_ORIGIN }, () => true, async () => { calls++; return new Response('unexpected') })
    assert.equal(denied.status, status)
  }
  assert.equal(calls, 1)
})
