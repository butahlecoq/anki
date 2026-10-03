import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const source = (file: string) => readFileSync(join(process.cwd(), 'src', file), 'utf8')

/**
 * The undo seam is only a seam if nothing reaches past it. These assertions read
 * the source, because the property is about which keys and properties callers
 * may name - something no runtime test can observe once the damage is done.
 */
const sources = ['collection.ts', 'custom-study.ts', 'browser-maintenance.ts', 'CollectionWorkspace.tsx', 'CustomStudy.tsx', 'Statistics.tsx', 'sync-client.ts']

test('no module outside the collection names an undo record by key', () => {
  const legacyKeys = ['reviewUndo', 'noteDeletionUndo', 'cardMaintenanceUndo']
  const offenders: string[] = []
  for (const file of sources) {
    const text = source(file)
    for (const key of legacyKeys) if (text.includes(`'${key}'`) || text.includes(`"${key}"`)) offenders.push(`${file}: ${key}`)
  }
  expect(offenders).toEqual([])
})

test('the undo record is written and read only through the collection seam', () => {
  const seam = source('collection.ts')
  // One key, and the only writes to it go through recordUndo/clearUndo.
  expect([...seam.matchAll(/UNDO_KEY/g)].length).toBeGreaterThan(0)
  expect(seam).toMatch(/private async recordUndo\(/)
  expect(seam).toMatch(/private async readUndo\(/)
  // The only writes to the key are inside recordUndo and clearUndo.
  expect([...seam.matchAll(/settings\.put\(\{ key: UNDO_KEY/g)].length).toBe(1)
  expect([...seam.matchAll(/settings\.delete\(UNDO_KEY/g)].length).toBe(1)
})