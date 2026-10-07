import { expect, test as base } from '@playwright/test'

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

test('zero-answer dates are visible before touch selection across a month transition', async ({ page, hostScale }, testInfo) => {
  test.setTimeout(60_000)
  await page.clock.setFixedTime(new Date('2026-10-07T12:00:00'))
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Statistics', exact: true }).click()
  await expect(page.getByRole('heading', { name: '84 days of practice' })).toBeVisible()
  const heatmap = page.getByRole('region', { name: 'Study heatmap', exact: true })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    for (const theme of ['light', 'dark']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(theme)
      for (const [date, month, day] of [['2026-09-30', 'Sep', '30'], ['2026-10-01', 'Oct', '1']]) {
        const button = heatmap.getByRole('button', { name: `${date}: 0 answers`, exact: true })
        await button.scrollIntoViewIfNeeded()
        await expect(button.getByText(month, { exact: true })).toBeVisible()
        await expect(button.getByText(day, { exact: true })).toBeVisible()
        await button.click()
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByLabel('Date', { exact: true })).toHaveValue(date)
        await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue('day')
      }
      await heatmap.screenshot({ path: testInfo.outputPath(`dates-${width}-${theme}.png`) })
    }
  }
})
