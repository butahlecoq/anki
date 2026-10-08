import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { validateNoticeInventory } from './dependency-notices.ts'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kiroku-notices-'))
  const inventory = JSON.parse(readFileSync(join(source, 'third-party/inventory.json'), 'utf8'))
  cpSync(join(source, 'third-party'), join(root, 'third-party'), { recursive: true })
  const paths = new Set(['package-lock.json', ...inventory.sourceChecks.map(item => item.path), ...inventory.dependencies.filter(item => !item.includedBy).map(item => `node_modules/${item.name}/package.json`), ...inventory.dependencies.flatMap(item => item.notices.flatMap(notice => notice.installedPath ? [notice.installedPath] : []))])
  for (const path of paths) { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(source, path), join(root, path)) }
  return { root, inventory, cleanup() {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert(basename(root).startsWith('kiroku-notices-'))
    rmSync(root, { recursive: true })
  } }
}

test('exact current publisher texts and installed sources qualify', () => {
  const { root, inventory, cleanup } = fixture()
  try { assert.deepEqual(validateNoticeInventory(root), inventory) } finally { cleanup() }
})

test('a missing publisher notice refuses qualification', () => {
  const { root, inventory, cleanup } = fixture()
  try {
    unlinkSync(join(root, 'third-party/notices', inventory.dependencies[0].notices[0].file))
    assert.throws(() => validateNoticeInventory(root), /ENOENT/)
  } finally { cleanup() }
})

test('a changed publisher notice refuses qualification', () => {
  const { root, inventory, cleanup } = fixture()
  try {
    writeFileSync(join(root, 'third-party/notices', inventory.dependencies[0].notices[0].file), 'Changed publisher text')
    assert.throws(() => validateNoticeInventory(root), /Dependency notice source changed/)
  } finally { cleanup() }
})

test('a changed resolved dependency version refuses qualification', () => {
  const { root, cleanup } = fixture()
  try {
    const path = join(root, 'package-lock.json')
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    lock.packages['node_modules/react'].version = '0.0.0-unreviewed'
    writeFileSync(path, JSON.stringify(lock))
    assert.throws(() => validateNoticeInventory(root), /inventory is stale for react/)
  } finally { cleanup() }
})
