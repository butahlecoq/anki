import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createSyncService } from './sync-service.js'

type Service = ReturnType<typeof createSyncService>

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const body = async (request: IncomingMessage) => {
  let text = ''
  for await (const chunk of request) text += chunk
  return JSON.parse(text || '{}') as unknown
}

export function createSyncHttpHandler(service: Service) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders)
        response.end()
        return
      }
      if (request.method === 'GET' && request.url === '/api/health') return send(response, 200, service.health())
      if (request.method === 'POST' && request.url === '/api/pair') {
        const payload = await body(request) as { code?: string; deviceId?: string }
        if (!payload.code || !payload.deviceId) return send(response, 400, { error: 'Pairing code and device ID are required.' })
        return send(response, 201, service.pair({ code: payload.code, deviceId: payload.deviceId }))
      }
      if (request.method === 'POST' && request.url === '/api/sync') {
        const authorization = request.headers.authorization
        if (!authorization?.startsWith('Bearer ')) return send(response, 401, { error: 'Authentication required.' })
        const payload = await body(request) as { cursor?: number; operations?: unknown[] }
        if (typeof payload.cursor !== 'number' || !Array.isArray(payload.operations)) return send(response, 400, { error: 'A cursor and operations array are required.' })
        return send(response, 200, service.sync(authorization.slice(7), payload as Parameters<Service['sync']>[1]))
      }
      return send(response, 404, { error: 'Not found.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      return send(response, message === 'Authentication required.' ? 401 : 400, { error: message })
    }
  }
}
