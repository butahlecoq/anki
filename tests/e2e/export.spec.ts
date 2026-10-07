import { openCollectionTools } from './collection-tools'
import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'
import { readFile } from 'node:fs/promises'

const test = phoneCanvasTest({ width: 390, height: 664 })

test('save a user-owned Japanese package offline and import it into an independent clean client', async ({ page, context, browser, browserName, hostScale }, testInfo) => {
  await page.goto('/')
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 390, height: 664 })
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name').fill('日本語 backup')
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: 'Open 日本語 backup', exact: true }).click()
  await page.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByLabel('Front', { exact: true }).fill('猫')
  await page.getByLabel('Back', { exact: true }).fill('cat · ねこ')
  await page.getByLabel(/^Images and audio/).setInputFiles({ name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') })
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  // Warm the export WASM before taking connectivity away, as an installed PWA
  // gets this asset from its precache on subsequent starts.
  await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Anki package' })
  await dialog.getByLabel('Export scope').selectOption({ label: '日本語 backup' })
  const scheduling = dialog.getByLabel('Include scheduling and card suspension')
  await expect(scheduling).toBeInViewport()
  await testInfo.attach('export-controls-canvas', { body: JSON.stringify({ configured: page.viewportSize(), ...await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), scheduling: await scheduling.boundingBox(), dialog: await dialog.boundingBox() }), contentType: 'application/json' })
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await scheduling.uncheck()
  await dialog.getByLabel('Include review history').uncheck()
  await page.screenshot({ path: test.info().outputPath('export-options.png') })
  const warmDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download package', exact: true }).click()
  await warmDownload
  await expect(dialog.getByRole('status')).toContainText('Package ready')
  await context.setOffline(true)
  let file: string | null = null
  try {
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download package', exact: true }).click()
    file = await (await download).path()
    await expect(dialog.getByRole('status')).toContainText('1 notes, 1 cards, 0 reviews, 1 media files')
    await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('export-saved.png') })
  } finally { await context.setOffline(false) }
  expect(file).not.toBeNull()
  const clean = await browser.newContext({ ...testInfo.project.use, viewport: page.viewportSize()!, isMobile: !(browserName === 'webkit' && process.platform === 'win32'), hasTouch: true, deviceScaleFactor: 3 / hostScale })
  try {
    const target = await clean.newPage()
    await target.goto(test.info().project.use.baseURL ?? page.url().split('#')[0])
    expect(await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 390, height: 664 })
    await target.getByRole('button', { name: 'Import Anki package', exact: true }).click()
    await target.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'backup.apkg', mimeType: 'application/octet-stream', buffer: await readFile(file!) })
    await target.getByRole('button', { name: 'Import package', exact: true }).click()
    await target.getByRole('button', { name: 'Open 日本語 backup', exact: true }).click()
    await target.getByRole('button', { name: 'Study now', exact: true }).click()
    await expect(target.frameLocator('iframe').locator('body')).toContainText('猫')
    await expect(target.getByRole('img', { name: 'cat.png', exact: true })).toBeVisible()
    await expect.poll(() => target.getByRole('img', { name: 'cat.png', exact: true }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
    await target.getByRole('button', { name: 'Show answer', exact: true }).click()
    await expect(target.frameLocator('iframe').locator('body')).toContainText('cat · ねこ')
  } finally { await clean.close() }
})


