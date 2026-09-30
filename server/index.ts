import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSyncHttpHandler } from './sync-http.js'
import { createSyncService } from './sync-service.js'

export async function createPairingCode({ runtimeDirectory }: { runtimeDirectory: string }) {
  await mkdir(runtimeDirectory, { recursive: true })
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'kiroku-sync.sqlite') })
  try {
    return service.createPairingCode()
  } finally {
    service.close()
  }
}

type TlsOptions = { keyPath: string; certificatePath: string }
type StartOptions = { runtimeDirectory: string; host: string; port: number; allowedOrigin?: string; tls?: TlsOptions }

const isLoopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host)

export async function startSyncServer({ runtimeDirectory, host, port, allowedOrigin, tls }: StartOptions) {
  if (!isLoopback(host) && !tls) throw new Error('TLS key and certificate paths are required before binding the sync service to a network interface.')
  await mkdir(runtimeDirectory, { recursive: true })
  const service = createSyncService({ databasePath: join(runtimeDirectory, 'kiroku-sync.sqlite') })
  const handler = createSyncHttpHandler(service, { allowedOrigin })
  const server = tls
    ? createSecureServer({ key: await readFile(tls.keyPath), cert: await readFile(tls.certificatePath) }, handler)
    : createServer(handler)
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

async function runCommand() {
  const runtimeDirectory = process.env.KIROKU_RUNTIME_DIRECTORY ?? join(process.cwd(), 'runtime')
  if (process.argv.includes('--pairing-code')) {
    process.stdout.write(`${await createPairingCode({ runtimeDirectory })}\n`)
    return
  }
  const port = Number(process.env.PORT ?? '4174')
  const keyPath = process.env.KIROKU_TLS_KEY_PATH
  const certificatePath = process.env.KIROKU_TLS_CERT_PATH
  if (Boolean(keyPath) !== Boolean(certificatePath)) throw new Error('Set both KIROKU_TLS_KEY_PATH and KIROKU_TLS_CERT_PATH to enable TLS.')
  await startSyncServer({ runtimeDirectory, host: process.env.KIROKU_HOST ?? '127.0.0.1', port, allowedOrigin: process.env.KIROKU_ALLOWED_ORIGIN, tls: keyPath && certificatePath ? { keyPath, certificatePath } : undefined }).then(({ port: boundPort }) => {
    process.stdout.write(`Kiroku sync service listening on ${boundPort}\n`)
  })
}

if (process.argv[1]?.endsWith('index.js')) {
  void runCommand()
}
