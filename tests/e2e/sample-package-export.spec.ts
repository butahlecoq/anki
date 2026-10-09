import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { nativeCanvasTest } from './phone-canvas'
import { openCollectionTools } from './collection-tools'
import { releaseInventory, sha256 } from './release-oracles'

const test = nativeCanvasTest()

async function exportedSample(page: Page, info: TestInfo, filename: string) {
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Anki package', exact: true })
  await expect(dialog).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await dialog.getByRole('button', { name: 'Download package', exact: true }).click()
      await expect(dialog.getByRole('status')).toContainText('Package ready: 2 notes, 2 cards, 0 reviews, 2 media files.')
    })(),
  ])
  const path = info.outputPath(filename)
  await download.saveAs(path)
  const bytes = await readFile(path)
  await dialog.getByRole('button', { name: 'Close export', exact: true }).click()
  await expect(dialog).toBeHidden()
  return bytes
}

test('Japanese sample retains both media files through native export and clean reimport', async ({ page, browser, viewport, isMobile, deviceScaleFactor, hasTouch, userAgent }, info) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true })).toBeVisible()
  const bytes = await exportedSample(page, info, 'sample.apkg')
  const inventory = await releaseInventory(bytes)
  expect(inventory.notes).toHaveLength(2)
  expect(inventory.cards).toHaveLength(2)
  const digests = await Promise.all(['cat.wav', 'garden.png'].map(async filename => sha256(await readFile(`public/sample-deck/${filename}`))))
  expect(inventory.media.map(file => file.digest).sort()).toEqual(digests.sort())

  const clean = await browser.newContext({ baseURL: String(info.project.use.baseURL), viewport, isMobile, deviceScaleFactor, hasTouch, userAgent })
  try {
    const restored = await clean.newPage()
    await restored.goto('/')
    await restored.getByRole('button', { name: 'Import Anki package', exact: true }).click()
    await restored.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'sample.apkg', mimeType: 'application/octet-stream', buffer: bytes })
    await expect(restored.getByRole('region', { name: 'Package summary' })).toContainText('2 notes')
    await restored.getByRole('button', { name: 'Import package', exact: true }).click()
    await expect(restored.getByRole('dialog', { name: /Import/ })).toBeHidden()
    await expect(restored.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true })).toBeVisible()
    const roundtrip = await exportedSample(restored, info, 'sample-roundtrip.apkg')
    expect(await releaseInventory(roundtrip)).toEqual(inventory)
  } finally {
    await clean.close()
  }
})
