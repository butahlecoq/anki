import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSyncHttpHandler } from './sync-http.js'
import { createSyncService } from './sync-service.js'

export async function startSyncServer({ runtimeDirectory, host, port }: { runtimeDirectory: string; host: string; port: number }) {
  await mkdir(runtimeDirectory, { recursive: true })
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'kiroku-sync.sqlite') })
  const server = createServer(createSyncHttpHandler(service))
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Service did not bind a TCP port.')
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      service.close()
    },
  }
}

if (process.argv[1]?.endsWith('index.js')) {
  const runtimeDirectory = process.env.KIROKU_RUNTIME_DIRECTORY ?? join(process.cwd(), 'runtime')
  const port = Number(process.env.PORT ?? '4174')
  void startSyncServer({ runtimeDirectory, host: '0.0.0.0', port }).then(({ port: boundPort }) => {
    process.stdout.write(`Kiroku sync service listening on ${boundPort}\n`)
  })
}
