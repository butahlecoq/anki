/** Private browser transport only. Collection/protocol sync is implemented separately. */
export interface GatewayEnvironment {
  PWA_ORIGIN: string
  GATEWAY_KEY: string
}
export interface PairedGatewayEnvironment { PWA_ORIGIN: string }

const routes = new Set([
  'sync/hostKey', 'sync/meta', 'sync/start', 'sync/applyGraves', 'sync/applyChanges',
  'sync/chunk', 'sync/applyChunk', 'sync/sanityCheck2', 'sync/finish', 'sync/abort',
  'sync/upload', 'sync/download', 'msync/begin', 'msync/mediaChanges',
  'msync/downloadFiles', 'msync/uploadChanges', 'msync/mediaSanity',
])
const gatewayHeaders = ['content-type', 'anki-sync', 'authorization', 'x-kiroku-gateway-key', 'x-ankiweb-host']
const pairedHeaders = ['authorization', 'content-type', 'x-ankiweb-host']
const transferLimit = 64 * 1024 * 1024
const timeoutMs = 300_000

async function matchesSecret(actual: string, expected: string) {
  const hash = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const [a, b] = await Promise.all([hash(actual), hash(expected)])
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function validOrigin(value: string, allowLoopbackHttp: boolean) {
  let origin: URL
  try { origin = new URL(value) } catch { return false }
  const loopbackHttp = allowLoopbackHttp && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  return origin.origin === value && (origin.protocol === 'https:' || loopbackHttp)
}

function boundedBody(body: ReadableStream<Uint8Array> | null, abort: AbortController, deadline: number) {
  if (!body) return null
  const reader = body.getReader()
  let count = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('Transfer timed out')
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Transfer timed out')), remaining) }),
        ])
        if (chunk.done) { controller.close(); return }
        count += chunk.value.byteLength
        if (count > transferLimit) throw new Error('Transfer exceeds 64 MiB limit')
        controller.enqueue(chunk.value)
      } catch {
        abort.abort()
        await reader.cancel().catch(() => undefined)
        controller.error(new Error('Account transfer interrupted or exceeded its limits'))
      } finally { clearTimeout(timer) }
    },
    async cancel() { abort.abort(); await reader.cancel().catch(() => undefined) },
  })
}

async function forwardAnkiWebRequest(
  request: Request,
  pwaOrigin: string,
  authenticate: () => Promise<boolean>,
  upstream: typeof fetch,
  allowedHeaders: string[],
  forwardAuthorization: boolean,
  authErrorHeader?: string,
): Promise<Response> {
  if (!validOrigin(pwaOrigin, true)) return new Response('Relay is not configured', { status: 503 })
  const cors = new Headers({
    'access-control-allow-origin': pwaOrigin,
    'vary': 'Origin',
    'cache-control': 'no-store',
    'access-control-expose-headers': 'Content-Type, Content-Length, Retry-After, X-Kiroku-Relay-Error, X-Kiroku-Response-Source',
    'x-kiroku-response-source': 'relay',
  })
  const reply = (message: string, status: number) => new Response(message, { status, headers: cors })
  if (request.headers.get('origin') !== pwaOrigin) {
    cors.set('x-kiroku-relay-error', 'origin-rejected')
    return reply('Origin not allowed', 403)
  }
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/api\/ankiweb\//, '').replace(/^\/ankiweb\//, '')
  if (!url.pathname.startsWith('/api/ankiweb/') && !url.pathname.startsWith('/ankiweb/')) return reply('Unknown account route', 404)
  if (!routes.has(route) || url.search) return reply('Unknown account route', 404)
  if (request.method === 'OPTIONS') {
    const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map((header) => header.trim()).filter(Boolean)
    if (request.headers.get('access-control-request-method') !== 'POST' || requested.some((header) => !allowedHeaders.includes(header))) return reply('Preflight not allowed', 403)
    cors.set('access-control-allow-methods', 'POST')
    cors.set('access-control-allow-headers', allowedHeaders.join(', '))
    return new Response(null, { status: 204, headers: cors })
  }
  if (request.method !== 'POST') return reply('Use POST', 405)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > transferLimit)) return reply('Transfer exceeds 64 MiB limit', 413)
  if (!await authenticate()) {
    if (authErrorHeader) cors.set('x-kiroku-relay-error', authErrorHeader)
    return reply('Authentication required', 401)
  }
  const host = request.headers.get('x-ankiweb-host') ?? 'sync.ankiweb.net'
  if (!/^sync(?:[1-9][0-9]*)?\.ankiweb\.net$/.test(host)) return reply('Upstream host not allowed', 400)
  const headers = new Headers()
  for (const name of ['content-type', 'anki-sync', ...(forwardAuthorization ? ['authorization'] : [])]) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('accept-encoding', 'identity')
  const abort = new AbortController()
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const incoming = boundedBody(request.body, abort, deadline)
    // Download endpoints may answer before reading their small protocol form.
    // Fetch cancels an unused streaming upload, which would also abort the
    // collection response through the shared controller. Finish this bounded
    // request first; binary collection uploads and downloads still stream.
    const upstreamBody = route === 'sync/download' ? await new Response(incoming).arrayBuffer() : incoming
    const response = await upstream(`https://${host}/${route}`, {
      method: 'POST', headers, body: upstreamBody,
      signal: abort.signal, redirect: 'manual', duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return reply('Upstream redirect rejected', 502) }
    const encoding = response.headers.get('content-encoding')
    if (encoding && encoding.toLowerCase() !== 'identity') { await response.body?.cancel(); return reply('Unexpected upstream HTTP encoding', 502) }
    const responseLength = response.headers.get('content-length')
    if (responseLength !== null && (!/^\d+$/.test(responseLength) || Number(responseLength) > transferLimit)) { await response.body?.cancel(); return reply('Upstream transfer exceeds 64 MiB limit', 413) }
    for (const name of ['content-type', 'content-length', 'retry-after']) {
      const value = response.headers.get(name)
      if (value !== null) cors.set(name, value)
    }
    cors.set('x-kiroku-response-source', 'upstream')
    return new Response(boundedBody(response.body, abort, deadline), { status: response.status, headers: cors })
  } catch { return reply('Account service unavailable or transfer interrupted', 502) }
  finally { clearTimeout(timer) }
}

/** Standalone transport for the optional personal gateway deployment. */
export async function handleAnkiWebGateway(request: Request, env: GatewayEnvironment, upstream: typeof fetch = fetch): Promise<Response> {
  if (!validOrigin(env.PWA_ORIGIN, false) || !/^[a-f0-9]{64}$/i.test(env.GATEWAY_KEY ?? '')) return new Response('Gateway is not configured', { status: 503 })
  return forwardAnkiWebRequest(request, env.PWA_ORIGIN, async () => {
    const key = request.headers.get('x-kiroku-gateway-key') ?? ''
    return /^[a-f0-9]{64}$/i.test(key) && await matchesSecret(key, env.GATEWAY_KEY)
  }, upstream, gatewayHeaders, true)
}

/** PC relay: the paired-device Bearer credential authorizes access to this
 * service only and is never forwarded to the upstream AnkiWeb request. */
export async function handlePairedAnkiWebRelay(
  request: Request,
  env: PairedGatewayEnvironment,
  authenticateDevice: (token: string) => boolean | Promise<boolean>,
  upstream: typeof fetch = fetch,
): Promise<Response> {
  if (!validOrigin(env.PWA_ORIGIN, true)) return new Response('Relay is not configured', { status: 503 })
  return forwardAnkiWebRequest(request, env.PWA_ORIGIN, async () => {
    const authorization = request.headers.get('authorization') ?? ''
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(authorization)
    return Boolean(match && await authenticateDevice(match[1]))
  }, upstream, pairedHeaders, false, 'paired-authentication')
}

export default { fetch: (request: Request, env: GatewayEnvironment) => handleAnkiWebGateway(request, env) }
