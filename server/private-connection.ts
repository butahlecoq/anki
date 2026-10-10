import type { IncomingMessage } from 'node:http'

export function privateConnectionAuthorized(request: IncomingMessage, allowedOrigin: string | undefined, trustedProxyUser: string | undefined) {
  if (!allowedOrigin || !trustedProxyUser) return false
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false
  if (request.headers['tailscale-user-login'] !== trustedProxyUser) return false
  // Same-origin GET discovery may omit Origin; credential issuance never may.
  return request.headers.origin === allowedOrigin || (request.method === 'GET' && request.headers.origin === undefined)
}
