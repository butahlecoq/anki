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
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  const card = page.frameLocator('iframe[title="Review card"]').locator('ruby')
  await expect(card).toContainText(/猫|犬/)
  const firstWord = await card.innerText()
  await page.getByRole('button', { name: 'Show answer', exact: true }).click()
  await page.getByRole('button', { name: /^Easy ·/ }).click()
  await expect(card).toContainText(firstWord.includes('猫') ? '犬' : '猫')
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Statistics', exact: true }).click()
  await expect(page.getByRole('heading', { name: '84 days of practice' })).toBeVisible()
  const heatmap = page.getByRole('region', { name: 'Study heatmap', exact: true })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      rootWidth: document.documentElement.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll<HTMLElement>('.statistics-controls label, .statistics-controls select, .statistics-controls input')].map(element => ({
        tag: element.tagName,
        name: element.getAttribute('aria-label'),
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
        grid: getComputedStyle(element).gridTemplateColumns,
      })),
    }))
    expect(viewport.width, JSON.stringify(viewport)).toBe(width)
    expect(viewport.scrollWidth, JSON.stringify(viewport)).toBeLessThanOrEqual(Math.ceil(viewport.rootWidth))
    const deckChoice = page.getByRole('combobox', { name: 'Statistics deck', exact: true })
    await deckChoice.selectOption({ label: 'Sample — Japanese Starter (with children)' })
    await expect(deckChoice).not.toHaveValue('')
    await deckChoice.selectOption('')
    await expect(page.getByRole('heading', { name: '84 days of practice' })).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(theme)
      for (const [date, month, day] of [['2026-09-30', 'Sep', '30'], ['2026-10-01', 'Oct', '1']]) {
        const button = heatmap.getByRole('button', { name: `${date}: 0 answers`, exact: true })
        await button.scrollIntoViewIfNeeded()
        await expect(button.getByText(month, { exact: true })).toBeVisible()
        await expect(button.getByText(day, { exact: true })).toBeVisible()
        await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
        await expect(button).toBeInViewport()
        await page.screenshot({ path: testInfo.outputPath(`date-${date}-${width}-${theme}.png`) })
        await button.click()
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByLabel('Date', { exact: true })).toHaveValue(date)
        await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue('day')
      }
      const active = heatmap.getByRole('button', { name: '2026-10-07: 1 answers', exact: true })
      await active.scrollIntoViewIfNeeded()
      await expect(active.getByText('Oct', { exact: true })).toBeVisible()
      await expect(active.getByText('7', { exact: true })).toBeVisible()
      const empty = heatmap.getByRole('button', { name: '2026-10-01: 0 answers', exact: true })
      expect(await active.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(await empty.evaluate(element => getComputedStyle(element).backgroundColor))
      for (const date of [active, empty]) {
        const contrast = await date.locator('time').evaluate(element => {
          const style = getComputedStyle(element)
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const luminance = (color: string) => {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data
            const linear = [r, g, b].map(value => { const unit = value / 255; return unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4 })
            return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
          }
          const ink = luminance(style.color)
          const surface = luminance(style.backgroundColor)
          return (Math.max(ink, surface) + .05) / (Math.min(ink, surface) + .05)
        })
        expect(contrast, `${theme} date contrast at ${width}px`).toBeGreaterThanOrEqual(4.5)
      }
      await active.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
      await page.screenshot({ path: testInfo.outputPath(`active-date-${width}-${theme}.png`) })
    }
  }
})
