import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFile = promisify(execFileCallback)

/** Owns only a synthetic runtime and its child; stopping never deletes history. */
export async function releaseService(allowedOrigin: string, commit: string) {
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-release-service-'))
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No release-service port')
  const port = address.port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const url = `http://127.0.0.1:${port}`
  const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  const env = { ...process.env, PORT: String(port), KIROKU_HOST: '127.0.0.1', KIROKU_TLS_KEY_PATH: '', KIROKU_TLS_CERT_PATH: '', KIROKU_RUNTIME_DIRECTORY: runtime, KIROKU_ALLOWED_ORIGIN: allowedOrigin, KIROKU_BUILD_COMMIT: commit, KIROKU_BUILD_VERSION: version, KIROKU_BUILD_RELEASE: 'true' }
  let child: ChildProcess | undefined
  let logs = ''
  const stop = async () => {
    if (!child) return
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { child = undefined; return }
    const owned = child
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Owned release service did not stop')), 10_000)
      owned.once('exit', () => { clearTimeout(deadline); resolve() })
      owned.kill()
    })
    child = undefined
  }
  const start = async () => {
    if (child) throw new Error('Release service is already running')
    child = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let launchError: Error | undefined
    child.on('error', error => { launchError = error })
    child.stdout?.on('data', chunk => { logs += String(chunk) })
    child.stderr?.on('data', chunk => { logs += String(chunk) })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error(`Release service exited: ${logs}`)
      try {
        const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })
        if (health.ok) return health.json() as Promise<{ build: { commit: string; version: string; release: boolean } }>
      } catch { /* Wait only for this owned service to bind. */ }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Release service did not become ready: ${logs}`)
  }
  return {
    url, runtime, start, stop,
    async pairingCode() {
      const { stdout } = await execFile(process.execPath, ['dist-server/server/index.js', '--pairing-code'], { env, windowsHide: true })
      return stdout.trim()
    },
    logs: () => logs,
    async dispose() {
      await stop()
      await rm(runtime, { recursive: true, force: true })
    },
  }
}
