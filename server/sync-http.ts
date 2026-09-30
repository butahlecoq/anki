import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createSyncService } from './sync-service.js'

type Service = ReturnType<typeof createSyncService>

type HttpOptions = { allowedOrigin?: string }

const corsHeaders = (origin: string | undefined, allowedOrigin: string | undefined): Record<string, string> => origin && allowedOrigin === origin ? {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-expose-headers': 'content-length, x-content-sha256',
} : {}

const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const body = async (request: IncomingMessage) => {
  let text = ''
  for await (const chunk of request) text += chunk
  return JSON.parse(text || '{}') as unknown
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

export function createSyncHttpHandler(service: Service, { allowedOrigin }: HttpOptions = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const headers = corsHeaders(request.headers.origin, allowedOrigin)
    const reply = (status: number, responseBody: unknown) => send(response, status, responseBody, headers)
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers)
        response.end()
        return
      }
      if (request.method === 'GET' && request.url === '/api/health') return reply(200, service.health())
      if (request.method === 'POST' && request.url === '/api/pair') {
        const payload = await body(request) as { code?: string; deviceId?: string }
        if (!payload.code || !payload.deviceId) return reply(400, { error: 'Pairing code and device ID are required.' })
        return reply(201, service.pair({ code: payload.code, deviceId: payload.deviceId }))
      }
      if (request.method === 'POST' && request.url === '/api/sync') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        const payload = await body(request) as { cursor?: number; operations?: unknown[] }
        if (typeof payload.cursor !== 'number' || !Array.isArray(payload.operations)) return reply(400, { error: 'A cursor and operations array are required.' })
        return reply(200, service.sync(authorization.slice(7), payload as Parameters<Service['sync']>[1]))
      }
      const media = request.url?.match(/^\/api\/media\/([a-f0-9]{64})$/)
      if (request.method === 'PUT' && media) {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ') || !request.headers['content-type']) return reply(401, { error: 'Authentication required.' })
        const declaredLength = Number(request.headers['content-length'] ?? 0)
        if (declaredLength > 20 * 1024 * 1024) return reply(413, { error: 'Media upload is too large.' })
        const mimeType = request.headers['content-type'].split(';', 1)[0].trim()
        return reply(200, await service.putMedia(authorization.slice(7), media[1], mimeType, await bytes(request)))
      }
      if (request.method === 'GET' && media) {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Authentication required.' })
        const result = await service.getMedia(authorization.slice(7), media[1])
        response.writeHead(200, { ...headers, 'content-type': result.mimeType, 'content-length': String(result.byteLength), 'x-content-sha256': result.digest, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
        response.end(result.bytes)
        return
      }
      return reply(404, { error: 'Not found.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      return reply(message === 'Authentication required.' ? 401 : message === 'Media upload is too large.' ? 413 : 400, { error: message })
    }
  }
}
