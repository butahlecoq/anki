import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { SyncBackupError, SyncCompatibilityError, type createSyncService } from './sync-service.js'
import { handlePairedAnkiWebRelay } from './ankiweb-gateway.js'

type Service = ReturnType<typeof createSyncService>

const DEFAULT_JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024
type HttpOptions = { allowedOrigin?: string; jsonBodyLimitBytes?: number; ankiWebUpstream?: typeof fetch }

const corsHeaders = (origin: string | undefined, allowedOrigin: string | undefined): Record<string, string> => origin && allowedOrigin === origin ? {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-ankiweb-host, x-collection-generation',
  'access-control-expose-headers': 'content-length, x-content-sha256',
} : {}

const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const body = async (request: IncomingMessage, maximumBytes: number) => {
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (declaredLength > maximumBytes) throw new Error('JSON request body is too large.')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.byteLength
    if (length > maximumBytes) throw new Error('JSON request body is too large.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
}

const bytes = async (request: IncomingMessage, maximum = 20 * 1024 * 1024) => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.byteLength
    if (length > maximum) throw new Error('Media upload is too large.')
    chunks.push(buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function relayAnkiWeb(request: IncomingMessage, response: ServerResponse, service: Service, allowedOrigin: string | undefined, upstream: typeof fetch) {
  const headers = new Headers()
  for (const name of ['origin', 'authorization', 'content-type', 'content-length', 'x-ankiweb-host', 'access-control-request-method', 'access-control-request-headers']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  const options: RequestInit & { duplex?: 'half' } = { method: request.method ?? 'GET', headers }
  if (request.method === 'POST') {
    options.body = Readable.toWeb(request) as ReadableStream<Uint8Array>
    options.duplex = 'half'
  }
  let relayResponse: Response
  try {
    const relayRequest = new Request(`http://kiroku.local${request.url ?? '/'}`, options)
    relayResponse = await handlePairedAnkiWebRelay(relayRequest, { PWA_ORIGIN: allowedOrigin ?? '' }, (token) => service.authenticateDevice(token), upstream)
  } catch {
    request.resume()
    response.writeHead(502, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    response.end('Account service unavailable or transfer interrupted')
    return
  }
  response.writeHead(relayResponse.status, Object.fromEntries(relayResponse.headers.entries()))
  if (!relayResponse.body) {
    request.resume()
    response.end()
    return
  }
  Readable.fromWeb(relayResponse.body as never).on('error', () => response.destroy()).pipe(response)
}

export function createSyncHttpHandler(service: Service, { allowedOrigin, jsonBodyLimitBytes = DEFAULT_JSON_BODY_LIMIT_BYTES, ankiWebUpstream = fetch }: HttpOptions = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const headers = corsHeaders(request.headers.origin, allowedOrigin)
    const reply = (status: number, responseBody: unknown) => send(response, status, responseBody, headers)
    try {
      if (request.url?.startsWith('/api/ankiweb/')) return await relayAnkiWeb(request, response, service, allowedOrigin, ankiWebUpstream)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers)
        response.end()
        return
      }
      if (request.method === 'GET' && request.url === '/api/health') return reply(200, service.health())
      if (request.method === 'POST' && request.url === '/api/pair') {
        const payload = await body(request, jsonBodyLimitBytes) as { code?: string; deviceId?: string }
        if (!payload.code || !payload.deviceId) return reply(400, { error: 'Pairing code and device ID are required.' })
        return reply(201, service.pair({ code: payload.code, deviceId: payload.deviceId }))
      }
      if (request.method === 'POST' && request.url === '/api/credential/rotate') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        return reply(200, service.rotateCredential(authorization.slice(7)))
      }
      if (request.method === 'POST' && request.url === '/api/sync') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        const payload = await body(request, jsonBodyLimitBytes) as { protocolVersion?: unknown; collectionSchemaVersion?: unknown; collectionGeneration?: unknown; cursor?: number; operations?: unknown[] }
        if (typeof payload.cursor !== 'number' || !Array.isArray(payload.operations)) return reply(400, { error: 'A cursor and operations array are required.' })
        try { return reply(200, await service.syncWithBackup(authorization.slice(7), payload as Parameters<Service['sync']>[1])) }
        catch (error) {
          if (error instanceof SyncBackupError) return reply(507, { code: 'backup-failed', error: error.message })
          throw error
        }
      }
      if (request.method === 'GET' && request.url === '/api/backups') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        return reply(200, { backups: await service.listBackups(authorization.slice(7)), retention: { maximum: 14, days: 30 } })
      }
      if (request.method === 'POST' && request.url === '/api/backups') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        return reply(201, await service.createBackup(authorization.slice(7)))
      }
      const backup = request.url?.match(/^\/api\/backups\/([a-f0-9-]{36})(?:\/(download|restore-preview|restore))?$/)
      if (backup) {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        if (request.method === 'GET' && backup[2] === 'download') {
          const { manifest, bytes } = await service.downloadBackup(authorization.slice(7), backup[1])
          response.writeHead(200, { ...headers, 'content-type': 'application/vnd.kiroku.backup+zip', 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename="kiroku-backup-${manifest.createdAt.slice(0, 10)}.zip"`, 'x-content-sha256': manifest.archiveSha256, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
          response.end(bytes)
          return
        }
        if (request.method === 'POST' && backup[2] === 'restore-preview') return reply(200, await service.previewBackupRestore(authorization.slice(7), backup[1]))
        if (request.method === 'POST' && backup[2] === 'restore') {
          const payload = await body(request, jsonBodyLimitBytes) as { confirmation?: string }
          return reply(200, await service.restoreBackup(authorization.slice(7), backup[1], payload.confirmation ?? ''))
        }
      }
      const media = request.url?.match(/^\/api\/media\/([a-f0-9]{64})$/)
      if (request.method === 'PUT' && media) {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ') || !request.headers['content-type']) return reply(401, { error: 'Authentication required.' })
        const declaredLength = Number(request.headers['content-length'] ?? 0)
        if (declaredLength > 20 * 1024 * 1024) return reply(413, { error: 'Media upload is too large.' })
        const mimeType = request.headers['content-type'].split(';', 1)[0].trim()
        const generationHeader = request.headers['x-collection-generation']
        return reply(200, await service.putMedia(authorization.slice(7), media[1], mimeType, await bytes(request), typeof generationHeader === 'string' && generationHeader ? generationHeader : undefined))
      }
      if (request.method === 'GET' && media) {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        const generationHeader = request.headers['x-collection-generation']
        const result = await service.getMedia(authorization.slice(7), media[1], typeof generationHeader === 'string' && generationHeader ? generationHeader : undefined)
        response.writeHead(200, { ...headers, 'content-type': result.mimeType, 'content-length': String(result.byteLength), 'x-content-sha256': result.digest, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
        response.end(result.bytes)
        return
      }
      return reply(404, { error: 'Not found.' })
    } catch (error) {
      if (error instanceof SyncCompatibilityError) return reply(409, error.incompatibility)
      const message = error instanceof Error ? error.message : 'Request failed.'
      return reply(message === 'Authentication required.' ? 401 : message === 'Media upload is too large.' || message === 'JSON request body is too large.' ? 413 : 400, { error: message })
    }
  }
}
