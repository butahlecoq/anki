import { spawnSync } from 'node:child_process'

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'ignore'],
})

if (root.status !== 0 || !root.stdout.trim()) {
  console.log('Git hooks were not configured because this install is outside a Git checkout.')
  process.exit(0)
}

const configured = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: root.stdout.trim(),
  windowsHide: true,
  stdio: 'inherit',
})

if (configured.status !== 0) {
  process.exit(configured.status ?? 1)
}

console.log('Configured Git hooks from .githooks.')
