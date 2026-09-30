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
      return reply(404, { error: 'Not found.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      return reply(message === 'Authentication required.' ? 401 : 400, { error: message })
    }
  }
}
