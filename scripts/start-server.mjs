import { spawnSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const revision = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' })
const commit = revision.status === 0 ? revision.stdout.trim() : 'unknown'
const child = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, KIROKU_BUILD_VERSION: packageJson.version, KIROKU_BUILD_COMMIT: commit, KIROKU_BUILD_RELEASE: 'true' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
