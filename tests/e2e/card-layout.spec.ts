import { expect, test } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'
import { expectFixedReview, reviewGeometry } from './review-geometry'

test('oversized imported cards fit the frame on both sides and after resizing', async ({ page }) => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({
    id: 1700000000801,
    name: 'Oversized kanji',
    fields: [{ name: 'Kanji' }, { name: 'Meaning' }],
    templates: [{
      name: 'Kanji',
      questionFormat: '<div class="q"><div class="kanji">{{Kanji}}</div></div>',
      answerFormat: '<div class="columns"><div class="kanji">{{Kanji}}</div><div class="meaning">{{Meaning}}</div></div><div class="extra">{{Meaning}}</div>',
    }],
    css: '.card{font-size:20px;background:white;color:black}.q,.columns{width:100%;overflow:auto}.kanji{font-size:200px}.columns .kanji{float:left;width:45%}.meaning{float:right;width:45%}.extra{height:450px}',
  })
  const deck = new Deck({ id: 1700000000802, name: 'Layout regression' })
  deck.addNote(new Note({ notetype: type, guid: 'layout-regression', fields: ['木', 'tree'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package' }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'layout.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from(await pkg.toUint8Array(SQL)) })
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open Layout regression' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()
  const frame = page.locator('iframe[title="Review card"]')
  const body = page.frameLocator('iframe[title="Review card"]').locator('body')
  const fits = async () => {
    await expect.poll(() => body.evaluate((element) => {
      const frame = window.frameElement as HTMLIFrameElement
      const rect = element.getBoundingClientRect()
      return {
        bodyRect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        bodyNatural: { scrollHeight: element.scrollHeight, offsetHeight: element.offsetHeight, computedHeight: getComputedStyle(element).height, transform: getComputedStyle(element).transform },
        frame: { clientHeight: frame.clientHeight, offsetHeight: frame.offsetHeight, inlineHeight: frame.style.height, inlineMinHeight: frame.style.minHeight, inlineMarginBottom: frame.style.marginBottom },
        fitsWidth: rect.right <= frame.clientWidth + 2,
        fitsHeight: rect.bottom <= frame.clientHeight + 1,
        overflowing: [...element.querySelectorAll<HTMLElement>('*')].filter((child) => child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1).map((child) => ({ className: child.className, width: child.clientWidth, scrollWidth: child.scrollWidth })),
      }
    }), { timeout: 5000 }).toMatchObject({ fitsWidth: true, fitsHeight: true, overflowing: [] })
  }
  await expect(body).toContainText('木')
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark')
  await expect.poll(() => body.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(16, 19, 23)')
  await page.getByText('More actions', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Card colors' }).selectOption('deck')
  await expect.poll(() => body.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
  await page.getByRole('combobox', { name: 'Card colors' }).selectOption('app')
  await page.keyboard.press('Escape')
  await fits()
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
  const frontGeometry = await reviewGeometry(page)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(body).toContainText('tree')
  await fits()
  expectFixedReview(frontGeometry, await reviewGeometry(page))
  expect(await frame.evaluate((element) => element.clientHeight)).toBeGreaterThan(260)
  await page.setViewportSize({ width: 320, height: 720 })
  await fits()
  const narrowScale = await body.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a)
  expect(narrowScale).toBeLessThan(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await fits()
  await expect.poll(() => body.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1)

  const heightBeforeImage = await frame.evaluate((element) => element.clientHeight)
  // Deliver intrinsic dimensions after the initial front/back measurement.
  await body.evaluate((element) => {
    const image = document.createElement('img')
    image.id = 'late-image'
    image.alt = 'Late loading diagram'
    element.append(image)
  })
  await fits()
  await frame.evaluate((element: HTMLIFrameElement) => {
    const image = element.contentDocument?.getElementById('late-image') as HTMLImageElement
    image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="600"><rect width="160" height="600" fill="green"/></svg>')}`
  })
  const image = page.frameLocator('iframe[title="Review card"]').locator('#late-image')
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalHeight === 600)).toBe(true)
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBeGreaterThan(heightBeforeImage)
  await fits()
})
