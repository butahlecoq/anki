import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

const workflow = readFileSync(resolve('.github/workflows/native-anki-latest-wheel.yml'), 'utf8')

test('schedules the latest-wheel oracle as a non-blocking compatibility monitor', () => {
  expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/)
  expect(workflow).toMatch(/jobs:[\s\S]*?oracle:[\s\S]*?continue-on-error:\s*true/)
  expect(workflow).toContain('https://pypi.org/pypi/anki/json')
  expect(workflow).toContain('node scripts/verify-native-anki-sync.mjs')
})

test('failure report includes the wheel version and upstream boundary diff', () => {
  expect(workflow).toContain('## Failing checks')
  expect(workflow).toContain('Anki wheel version: ${VERSION}')
  expect(workflow).toContain('## Upstream boundary constant diff')
  expect(workflow).toContain('nativeAnkiBoundaryReport')
  expect(workflow).toContain('gh issue create')
})
