import { expect, test as base } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

const test = base.extend<{ hostScale: number }>({
  hasTouch: true,
  hostScale: async ({ browser, browserName }, provide) => {
    if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
    const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
    let scale = 1
    try { scale = await (await probe.newPage()).evaluate(() => 1000 / innerWidth) }
    finally { await probe.close() }
    await provide(scale)
  },
  viewport: async ({ hostScale }, provide) => provide({ width: Math.round(390 * hostScale), height: Math.round(844 * hostScale) }),
  isMobile: async ({ browserName }, provide) => provide(!(browserName === 'webkit' && process.platform === 'win32')),
  deviceScaleFactor: async ({ hostScale }, provide) => provide(3 / hostScale),
})

test('Browse and Study put their first task above mobile navigation', async ({ page, hostScale }, testInfo) => {
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' })
  for (const [width, height] of [[390, 844], [320, 568]]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(height * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    expect(await page.evaluate(() => innerHeight)).toBe(height)
    for (const destination of ['Browse', 'Study']) {
      await navigation.getByRole('link', { name: destination, exact: true }).click()
      await page.evaluate(() => scrollTo(0, 0))
      const task = destination === 'Browse'
        ? page.getByRole('textbox', { name: 'Collection search', exact: true })
        : page.getByRole('textbox', { name: 'Session name', exact: true })
      await expect(task).toBeVisible()
      const taskBox = await task.boundingBox()
      const navigationBox = await navigation.boundingBox()
      const geometryPath = testInfo.outputPath(`${destination.toLowerCase()}-${width}-geometry.json`)
      await writeFile(geometryPath, JSON.stringify({ taskBox, navigationBox, ...await page.evaluate(() => ({
          innerWidth, innerHeight,
          rootWidth: document.documentElement.getBoundingClientRect().width,
          scrollWidth: document.documentElement.scrollWidth,
          overflowingContent: [...document.querySelectorAll<HTMLElement>('.custom-study, .custom-study *')]
            .filter(element => element.scrollWidth > element.clientWidth + 1)
            .map(element => ({ tag: element.tagName, className: element.className, text: element.tagName === 'LABEL' ? element.childNodes[0]?.textContent : undefined, width: element.clientWidth, scroll: element.scrollWidth })),
          overflowing: [...document.querySelectorAll<HTMLElement>('main *')]
            .filter(element => element.getClientRects().length && !element.closest('select, .dialog-backdrop'))
            .filter(element => element.getBoundingClientRect().right > Math.ceil(document.documentElement.getBoundingClientRect().width))
            .map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })),
        })) }))
      await testInfo.attach(`${destination.toLowerCase()}-${width}-geometry`, { contentType: 'application/json', path: geometryPath })
      expect(taskBox!.y).toBeGreaterThanOrEqual(0)
      expect(taskBox!.y + taskBox!.height).toBeLessThanOrEqual(navigationBox!.y)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(document.documentElement.getBoundingClientRect().width))).toBe(true)
      if (destination === 'Study') {
        const scheduling = page.getByRole('combobox', { name: 'Review scheduling', exact: true })
        await scheduling.selectOption('reschedule')
        await expect(page.getByText(/Every rating updates the home card/)).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(document.documentElement.getBoundingClientRect().width))).toBe(true)
        await scheduling.selectOption('practice')
        await expect(page.getByText(/Every rating is recorded as practice/)).toBeVisible()
      }
      await page.screenshot({ path: testInfo.outputPath(`${destination.toLowerCase()}-${width}.png`) })
    }
  }
})

test('Collection tools expose utilities with keyboard access and safe focus return', async ({ page }) => {
  await page.goto('/')
  const tools = page.getByText('Collection tools', { exact: true })
  const pairing = page.getByRole('button', { name: 'Connect a PC', exact: true })
  await expect(pairing).toBeHidden()
  await tools.focus()
  await page.keyboard.press('Enter')
  await expect(pairing).toBeVisible()
  for (const name of ['Connect a PC', 'Export Anki package', 'Import / export text']) {
    const button = page.getByRole('button', { name, exact: true })
    const box = await button.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(43.99)
    expect(box!.height).toBeGreaterThanOrEqual(43.99)
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(button).toBeFocused()
  }
  await page.keyboard.press('Escape')
  await expect(pairing).toBeHidden()
  await expect(tools).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Offline storage and local collection', { exact: true })).toBeVisible()
})
