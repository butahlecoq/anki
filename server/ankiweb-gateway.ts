/** Private browser transport only. Collection/protocol sync is implemented separately. */
export interface GatewayEnvironment {
  PWA_ORIGIN: string
  GATEWAY_KEY: string
}

const routes = new Set([
  'sync/hostKey', 'sync/meta', 'sync/start', 'sync/applyGraves', 'sync/applyChanges',
  'sync/chunk', 'sync/applyChunk', 'sync/sanityCheck2', 'sync/finish', 'sync/abort',
  'sync/upload', 'sync/download', 'msync/begin', 'msync/mediaChanges',
  'msync/downloadFiles', 'msync/uploadChanges', 'msync/mediaSanity',
])
const requestHeaders = ['content-type', 'anki-sync', 'authorization']
const allowedHeaders = [...requestHeaders, 'x-kiroku-gateway-key', 'x-ankiweb-host']
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

export async function handleAnkiWebGateway(request: Request, env: GatewayEnvironment, upstream: typeof fetch = fetch): Promise<Response> {
  // Invalid configuration fails closed; never derive caller origin from the request.
  let origin: URL
  try { origin = new URL(env.PWA_ORIGIN) } catch { return new Response('Gateway is not configured', { status: 503 }) }
  if (origin.origin !== env.PWA_ORIGIN || origin.protocol !== 'https:' || !/^[a-f0-9]{64}$/i.test(env.GATEWAY_KEY ?? '')) return new Response('Gateway is not configured', { status: 503 })
  if (request.headers.get('origin') !== env.PWA_ORIGIN) return new Response('Origin not allowed', { status: 403 })
  const cors = new Headers({
    'access-control-allow-origin': env.PWA_ORIGIN, 'vary': 'Origin', 'cache-control': 'no-store',
    'access-control-expose-headers': 'Content-Type, Retry-After',
  })
  const reply = (message: string, status: number) => new Response(message, { status, headers: cors })
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/ankiweb\//, '')
  if (!url.pathname.startsWith('/ankiweb/') || !routes.has(route) || url.search) return reply('Unknown account route', 404)
  if (request.method === 'OPTIONS') {
    const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map((header) => header.trim()).filter(Boolean)
    if (request.headers.get('access-control-request-method') !== 'POST' || requested.some((header) => !allowedHeaders.includes(header))) return reply('Preflight not allowed', 403)
    cors.set('access-control-allow-methods', 'POST')
    cors.set('access-control-allow-headers', allowedHeaders.join(', '))
    return new Response(null, { status: 204, headers: cors })
  }
  if (request.method !== 'POST') return reply('Use POST', 405)
  const key = request.headers.get('x-kiroku-gateway-key') ?? ''
  if (!/^[a-f0-9]{64}$/i.test(key) || !await matchesSecret(key, env.GATEWAY_KEY)) return reply('Gateway authentication required', 401)
  const host = request.headers.get('x-ankiweb-host') ?? 'sync.ankiweb.net'
  if (!/^sync(?:[1-9][0-9]*)?\.ankiweb\.net$/.test(host)) return reply('Upstream host not allowed', 400)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > transferLimit)) return reply('Transfer exceeds 64 MiB limit', 413)
  const headers = new Headers()
  for (const name of requestHeaders) { const value = request.headers.get(name); if (value !== null) headers.set(name, value) }
  // Avoid runtime-specific HTTP decompression. Zstd inside the protocol payload
  // remains untouched; HTTP content encoding is a separate transport layer.
  headers.set('accept-encoding', 'identity')
  const abort = new AbortController()
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await upstream(`https://${host}/${route}`, {
      method: 'POST', headers, body: boundedBody(request.body, abort, deadline),
      signal: abort.signal, redirect: 'manual', duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return reply('Upstream redirect rejected', 502) }
    const encoding = response.headers.get('content-encoding')
    if (encoding && encoding.toLowerCase() !== 'identity') { await response.body?.cancel(); return reply('Unexpected upstream HTTP encoding', 502) }
    const responseLength = response.headers.get('content-length')
    if (responseLength !== null && (!/^\d+$/.test(responseLength) || Number(responseLength) > transferLimit)) { await response.body?.cancel(); return reply('Upstream transfer exceeds 64 MiB limit', 413) }
    for (const name of ['content-type', 'retry-after']) { const value = response.headers.get(name); if (value !== null) cors.set(name, value) }
    return new Response(boundedBody(response.body, abort, deadline), { status: response.status, headers: cors })
  } catch { return reply('Account service unavailable or transfer interrupted', 502) }
  finally { clearTimeout(timer) }
}

export default { fetch: (request: Request, env: GatewayEnvironment) => handleAnkiWebGateway(request, env) }
