import { expect, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { nativeCanvasTest } from './phone-canvas'

const test = nativeCanvasTest()
const deckNames = [
  '日本語の長いデッキ名を最後まで読みやすく表示する'.repeat(4),
  'Очень длинное название колоды для ежедневного изучения японского языка '.repeat(2).trim().slice(0, 120),
]

// Catch fixed-width text/controls, clipped long names, and a lost heading hierarchy.
// Screenshots and measured type sizes remain evidence for a separate visual judgment.
async function capture(page: Page, testInfo: TestInfo, name: string, theme: 'light' | 'dark') {
  // WebKit can paint an offscreen descendant with the preceding theme's
  // inherited ink while the root has already changed. The body can also lag,
  // so comparing descendants with the body alone is insufficient. Use the
  // established appearance oracle's body ink for the requested theme.
  const ink = theme === 'dark' ? 'rgb(233, 237, 227)' : 'rgb(28, 33, 24)'
  await expect.poll(() => page.evaluate(() => {
    return [document.body, ...document.querySelectorAll('.deck-tile h2, .empty-card h3')]
      .map(element => getComputedStyle(element).color)
  }), { message: 'inherited text ink follows the requested theme', timeout: 15_000 })
    .toEqual([ink, ...Array(await page.locator('.deck-tile h2, .empty-card h3').count()).fill(ink)])
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const geometry = await page.evaluate(() => {
    const box = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom })
    const elements = [...document.querySelectorAll<HTMLElement>(
      '.hero h1, .hero p, .compact-hero h1, .compact-hero p, .empty-actions button, .collection-actions button, .deck-tile h2',
    )].map(element => {
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(element)
      const textRects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      const clippedBy = []
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor)
        const ancestorBounds = ancestor.getBoundingClientRect()
        if (textRects.some(rect =>
          (ancestorStyle.overflowX !== 'visible' && (rect.x < ancestorBounds.x - 1 || rect.right > ancestorBounds.right + 1)) ||
          (ancestorStyle.overflowY !== 'visible' && (rect.y < ancestorBounds.y - 1 || rect.bottom > ancestorBounds.bottom + 1)),
        )) clippedBy.push({ tag: ancestor.tagName, className: ancestor.className, bounds: box(ancestorBounds) })
      }
      return {
        tag: element.tagName, text: element.textContent, bounds: box(bounds),
        fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), lineHeight: style.lineHeight,
        fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, color: style.color,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        textRects: textRects.map(box), clippedBy,
      }
    })
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, visualWidth: visualViewport?.width },
      theme: getComputedStyle(document.documentElement).colorScheme,
      rootWidth: document.documentElement.getBoundingClientRect().width,
      documentScrollWidth: document.documentElement.scrollWidth,
      elements,
    }
  })
  const path = testInfo.outputPath(`${name}-geometry.json`)
  await writeFile(path, JSON.stringify({ configuredViewport: page.viewportSize(), ...geometry }, null, 2))
  await testInfo.attach(`${name}-geometry`, { path, contentType: 'application/json' })
  const screenshot = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
  expect(geometry.documentScrollWidth, `${name}: page horizontal overflow`).toBeLessThanOrEqual(Math.ceil(geometry.rootWidth))
  const heading = geometry.elements.find(element => element.tag === 'H1')!
  const subtitle = geometry.elements.find(element => element.tag === 'P')!
  expect(heading.fontSize, `${name}: heading retains its visual hierarchy`).toBeGreaterThan(subtitle.fontSize)
  for (const element of geometry.elements) {
    expect(element.bounds.x, `${name}: ${element.text}`).toBeGreaterThanOrEqual(-1)
    expect(element.bounds.right, `${name}: ${element.text}`).toBeLessThanOrEqual(geometry.viewport.width + 1)
    expect(element.clippedBy, `${name}: clipped text in ${element.text}`).toEqual([])
    for (const rect of element.textRects) {
      expect(rect.x, `${name}: text exceeds its container in ${element.text}`).toBeGreaterThanOrEqual(element.bounds.x - 1)
      expect(rect.right, `${name}: text exceeds its container in ${element.text}`).toBeLessThanOrEqual(element.bounds.right + 1)
    }
    if (element.tag === 'BUTTON') {
      expect(element.bounds.height, `${name}: action touch height`).toBeGreaterThanOrEqual(43.99)
      expect(element.bounds.width, `${name}: action touch width`).toBeGreaterThanOrEqual(43.99)
    }
  }
  return geometry
}

for (const width of [320, 390, 1280]) {
  test(`Collection text and primary actions remain readable at actual ${width}px in both themes`, async ({ page, browser, browserName, hostScale }, testInfo) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await testInfo.attach('browser-environment', { contentType: 'application/json', body: JSON.stringify({
      browserName, browserVersion: browser.version(), project: testInfo.project.name, hostScale,
      platform: process.platform, configuredViewport: page.viewportSize(),
    }, null, 2) })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
    const appearance = page.getByRole('combobox', { name: 'Appearance' })
    for (const theme of ['light', 'dark'] as const) {
      await appearance.selectOption(theme)
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
      const measured = await capture(page, testInfo, `empty-${width}-${theme}`, theme)
      expect(measured.viewport.width).toBe(width)
      await page.locator('.empty-actions').scrollIntoViewIfNeeded()
      await capture(page, testInfo, `empty-actions-${width}-${theme}`, theme)
    }

    for (const name of deckNames) {
      await page.getByRole('button', { name: 'New deck', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Create a deck' })
      await dialog.getByLabel('Deck name', { exact: true }).fill(name)
      await dialog.getByRole('button', { name: 'Create deck', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    for (const theme of ['light', 'dark'] as const) {
      await appearance.selectOption(theme)
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
      const measured = await capture(page, testInfo, `collection-${width}-${theme}`, theme)
      expect(measured.viewport.width).toBe(width)
      for (const [index, name] of deckNames.entries()) {
        await page.getByRole('heading', { name, exact: true }).scrollIntoViewIfNeeded()
        await capture(page, testInfo, `long-deck-${index}-${width}-${theme}`, theme)
      }
      if (width === 320) {
        // A moderate Cyrillic word should fit the proportional deck heading
        // without being broken into separate lines by full-width glyphs.
        const word = 'ежедневного'
        const heading = page.getByRole('heading', { name: deckNames[1], exact: true })
        await expect(heading).toContainText(word)
        const layout = await heading.evaluate((element, word) => {
          const text = element.firstChild!
          const start = text.textContent!.indexOf(word)
          const range = document.createRange()
          range.setStart(text, start)
          range.setEnd(text, start + word.length)
          const rectangles = [...range.getClientRects()]
            .filter(rectangle => rectangle.width > 0)
            .map(rectangle => ({ x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height }))
          return { word, availableWidth: element.getBoundingClientRect().width, rectangles }
        }, word)
        await testInfo.attach(`cyrillic-word-${width}-${theme}`, {
          contentType: 'application/json', body: JSON.stringify(layout, null, 2),
        })
        expect(layout.rectangles.reduce((advance, rectangle) => advance + rectangle.width, 0),
          `${theme}: ${word} fits the available deck-heading width`).toBeLessThanOrEqual(layout.availableWidth + 1)
        expect(layout.rectangles, `${theme}: ${word} remains readable on one line`).toHaveLength(1)
      }
    }
    expect(errors).toEqual([])
  })
}
