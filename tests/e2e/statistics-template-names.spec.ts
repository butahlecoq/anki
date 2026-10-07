import { expect, test as base } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'

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

const expression = '猫の鳴き声を聞きながら日本語の語彙を練習する'.repeat(3)
const recognition = 'Recognition — 日本語の意味を思い出す練習'.repeat(3)
const recall = 'Recall — 英語から日本語を思い出す練習'.repeat(3)

async function vocabularyPackage() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000000201, name: 'Template names', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [
    { name: recognition, questionFormat: '{{Expression}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' },
    { name: recall, questionFormat: '{{Meaning}}', answerFormat: '{{FrontSide}}<hr>{{Expression}}' },
  ] })
  const deck = new Deck({ id: 1700000000202, name: 'Statistics vocabulary' })
  deck.addNote(new Note({ notetype: type, guid: 'statistics-template-cat', fields: [expression, 'cat'], tags: [] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  return Buffer.from(await pkg.toUint8Array(SQL))
}

test('studied-card links name both templates and retain the correct histories on a narrow phone', async ({ page, hostScale }, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.setFixedTime(new Date('2026-10-07T12:00:00'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'template-names.apkg', mimeType: 'application/octet-stream', buffer: await vocabularyPackage() })
  await expect(page.getByRole('region', { name: 'Package summary' }).getByText('1 note', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open Statistics vocabulary', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  const review = page.frameLocator('iframe[title="Review card"]').locator('body')
  for (let card = 0; card < 2; card++) {
    await expect(review).toContainText(/猫|cat/)
    const isRecognition = (await review.innerText()).includes('猫')
    await page.getByRole('button', { name: 'Show answer', exact: true }).click()
    await page.getByRole('button', { name: isRecognition ? /^Good ·/ : /^Easy ·/ }).click()
    if (card === 0) await expect(review).toHaveText(isRecognition ? 'cat' : expression)
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to deck', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Statistics', exact: true }).click()
  const studied = page.getByRole('heading', { name: 'Cards studied in this period', exact: true }).locator('..')
  await expect(studied.getByRole('button')).toHaveCount(2)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    for (const appearance of ['light', 'dark']) {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(appearance)
      await studied.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }))
      await info.attach(`studied-geometry-${width}-${appearance}`, { body: JSON.stringify(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.getBoundingClientRect().width, buttons: [...document.querySelectorAll('.studied-cards button')].map(button => button.getBoundingClientRect().toJSON()) }))), contentType: 'application/json' })
      await page.screenshot({ path: info.outputPath(`studied-templates-${width}-${appearance}.png`) })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(document.documentElement.getBoundingClientRect().width))).toBe(true)
      for (const button of await studied.getByRole('button').all()) {
        const box = await button.boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(43.99)
        expect(box!.width).toBeGreaterThanOrEqual(43.99)
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
      }
    }
  }
  for (const [template, rating, otherRating] of [[recognition, 'Good', 'Easy'], [recall, 'Easy', 'Good']]) {
    const link = studied.getByRole('button', { name: `${expression} · ${template}`, exact: true })
    await expect(link).toBeVisible()
    await link.focus()
    await link.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Card progress', exact: true })
    const history = dialog.getByRole('region', { name: 'Card review history', exact: true })
    await expect(history.getByRole('listitem')).toHaveCount(1)
    await expect(history).toContainText(rating)
    await expect(history).not.toContainText(otherRating)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  expect(errors).toEqual([])
})
