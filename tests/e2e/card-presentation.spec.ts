import { expect } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'
import { readFile } from 'node:fs/promises'
import { navigationPNG } from '../fixtures/secure-navigation'
import { nativeCanvasTest } from './phone-canvas'

const test = nativeCanvasTest({ width: 390, height: 844 })

test('phone study preserves rich Japanese and media with readable Cyrillic and no footer links', async ({ page, hostScale }, testInfo) => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000000307, name: 'Synthetic presentation', fields: ['Reading', 'Translation', 'Media'].map(name => ({ name })), templates: [{ name: 'Recognition', questionFormat: '{{furigana:Reading}}<div>{{Translation}}</div>{{Media}}<div class="bottomlink"><a href="https://example.org/report">Report mistake</a></div>', answerFormat: '{{FrontSide}}<hr>Answer' }], css: '.card{font-family:serif;font-size:44px;text-align:center}.bottomlink{font-size:12px}' })
  const deck = new Deck({ id: 1700000000407, name: 'Presentation fixture' })
  deck.addNote(new Note({ notetype: type, guid: 'synthetic-presentation', fields: ['<b>猫[ねこ]</b>', 'Жестокий; ужасный; сильный', '<img src="cat.png">[sound:cat.wav]'], tags: [] }))
  const pkg = new Package(); pkg.addDeck(deck); pkg.addMedia('cat.png', navigationPNG); pkg.addMedia('cat.wav', new Uint8Array(await readFile('public/sample-deck/cat.wav')))
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'synthetic-presentation.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from(await pkg.toUint8Array(SQL)) })
  await expect(page.getByRole('button', { name: 'Import package', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open Presentation fixture', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  const card = page.frameLocator('iframe[title="Review card"]')
  await expect(card.locator('b ruby rt')).toHaveText('ねこ')
  await expect(card.locator('a, .bottomlink')).toHaveCount(0)
  await expect(card.locator('audio')).toHaveCount(1)
  await expect.poll(() => card.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    const translation = card.locator('.kiroku-translation')
    await expect(translation).toHaveText('Жестокий; ужасный; сильный')
    const geometry = await translation.evaluate(element => ({ size: parseFloat(getComputedStyle(element).fontSize), spacing: getComputedStyle(element).letterSpacing, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))
    expect(geometry.size).toBeGreaterThanOrEqual(18)
    expect(geometry.size).toBeLessThanOrEqual(22)
    expect(geometry.spacing).toBe('normal')
    await expect.poll(() => card.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`presentation-${width}.png`) })
  }
})
