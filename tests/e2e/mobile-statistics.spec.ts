import { expect, test as base, type Locator } from '@playwright/test'

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

function centerIsReachable(date: Locator) {
  return date.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })
}

test('all 84 study dates remain usable at narrow phone widths', async ({ page, hostScale }, testInfo) => {
  test.setTimeout(120_000)
  await page.clock.setFixedTime(new Date('2026-10-07T12:00:00.000Z'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  await page.getByRole('button', { name: 'Show answer', exact: true }).click()
  await page.getByRole('button', { name: /^Good · / }).click()
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Statistics', exact: true }).click()
  const heatmap = page.getByRole('region', { name: 'Study heatmap', exact: true })
  const dates = heatmap.getByRole('button')
  const answers = page.getByRole('region', { name: 'Period totals', exact: true }).locator('article').first().locator('strong')
  const studiedCards = page.getByRole('heading', { name: 'Cards studied in this period', exact: true }).locator('..')
  await expect(dates).toHaveCount(84)
  await expect(dates.last()).toHaveAttribute('aria-label', '2026-10-07: 1 answers')
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
      await date.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }))
      const box = (await date.boundingBox())!
      // Windows WebKit scales injected touch coordinates as well as the canvas.
      // A plain HTML touchstart probe verifies CSS (300,300) needs (375,375)
      // at the measured 1.25 host scale; Chromium's scale is 1.
      await page.touchscreen.tap((box.x + box.width / 2) * hostScale, (box.y + box.height / 2) * hostScale)
      expect(await centerIsReachable(date)).toBe(true)
      await expect(date).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue('day')
      const label = await date.getAttribute('aria-label')
      await expect(page.getByLabel('Date', { exact: true })).toHaveValue(label!.slice(0, 10))
      const count = label!.startsWith('2026-10-07:') ? 1 : 0
      await expect(answers).toHaveText(String(count))
      await expect(studiedCards.getByRole('button')).toHaveCount(count)
      if (count) await expect(studiedCards.getByRole('button')).toContainText(/猫|犬/)
      else await expect(studiedCards).toContainText('Your reviewed cards will appear here.')
    }
    await dates.first().focus()
    for (let index = 1; index < 84; index++) {
      await page.keyboard.press('Tab')
      await expect(dates.nth(index)).toBeFocused()
    }
    await page.keyboard.press('Enter')
    await expect(dates.last()).toHaveAttribute('aria-pressed', 'true')
    await expect(answers).toHaveText('1')
    await expect(studiedCards.getByRole('button')).toHaveCount(1)
    expect(await centerIsReachable(dates.last())).toBe(true)
    await heatmap.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`heatmap-${width}.png`) })
    await page.getByRole('heading', { name: 'Cards studied in this period' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`statistics-lower-${width}.png`) })
  }
})
