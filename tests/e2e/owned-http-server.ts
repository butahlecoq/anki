import type { Server } from 'node:http'

export function closeOwnedHttpServer(server: Server): Promise<void> {
  const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  // Stop accepting connections before releasing this fixture's sockets,
  // including browser preconnections that have not sent an HTTP request.
  server.closeAllConnections()
  return stopped
}
