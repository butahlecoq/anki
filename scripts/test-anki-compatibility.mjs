import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const packagePath = resolve('.runtime/compatibility/anki-26.09.3.colpkg')

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('uv', ['run', '--with', 'anki==26.09.3', 'python', 'scripts/generate-anki-compatibility-package.py', '--output', packagePath])
const env = { ...process.env, KIROKU_ANKI_COMPAT_PACKAGE: packagePath }
const npmArgs = process.env.npm_execpath
  ? [process.env.npm_execpath, 'exec', '--']
  : []
const npmCommand = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx')
run(npmCommand, [...npmArgs, 'vitest', 'run', 'src/anki-import.test.ts', '-t', 'Anki 26.09.3 official export'], env)
run(npmCommand, [...npmArgs, 'playwright', 'test', 'tests/e2e/anki-release-compatibility.spec.ts', '--project=desktop-chromium'], env)
