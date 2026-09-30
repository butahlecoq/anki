import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createSyncService } from './sync-service.js'

type Service = ReturnType<typeof createSyncService>

type HttpOptions = { allowedOrigin?: string }

const corsHeaders = (origin: string | undefined, allowedOrigin: string | undefined): Record<string, string> => origin && allowedOrigin === origin ? {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
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

const bytes = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
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
        return reply(200, await service.putMedia(authorization.slice(7), media[1], request.headers['content-type'], await bytes(request)))
      }
      return reply(404, { error: 'Not found.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      return reply(message === 'Authentication required.' ? 401 : 400, { error: message })
    }
  }
}
