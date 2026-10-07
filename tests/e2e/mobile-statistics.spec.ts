import { expect, test as base } from '@playwright/test'

// Windows WebKit scales its viewport by the host display scale. Measure that
// scale so these tests exercise an actual, rather than nominal, phone canvas.
const test = base.extend<{ hostScale: number }>({
  hasTouch: true,
  hostScale: async ({ browser, browserName }, provide) => {
    if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
    const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
    let scale = 1
    try {
      const page = await probe.newPage()
      scale = await page.evaluate(() => 1000 / innerWidth)
    } finally { await probe.close() }
    await provide(scale)
  },
  viewport: async ({ hostScale }, provide) => provide({ width: Math.round(390 * hostScale), height: Math.round(844 * hostScale) }),
  isMobile: async ({ browserName }, provide) => provide(!(browserName === 'webkit' && process.platform === 'win32')),
  deviceScaleFactor: async ({ hostScale }, provide) => provide(3 / hostScale),
})

test('all 84 study dates remain usable at narrow phone widths', async ({ page, hostScale }, testInfo) => {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Statistics', exact: true }).click()
  const heatmap = page.getByRole('region', { name: 'Study heatmap', exact: true })
  const dates = heatmap.getByRole('button')
  await expect(dates).toHaveCount(84)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    for (const date of await dates.all()) {
      const box = await date.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(43.99)
      expect(box!.height).toBeGreaterThanOrEqual(43.99)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(document.documentElement.getBoundingClientRect().width))).toBe(true)
    for (const date of [dates.first(), dates.last()]) {
      await date.click()
      await expect(date).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue('day')
      const label = await date.getAttribute('aria-label')
      await expect(page.getByLabel('Date', { exact: true })).toHaveValue(label!.slice(0, 10))
    }
    await dates.first().focus()
    await page.keyboard.press('Tab')
    await expect(dates.nth(1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dates.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await heatmap.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`heatmap-${width}.png`) })
    await page.getByRole('heading', { name: 'Cards studied in this period' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`statistics-lower-${width}.png`) })
  }
})
