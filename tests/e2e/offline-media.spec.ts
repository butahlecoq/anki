import { expect, test, type Locator } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'

async function packageWithImages() {
  const sql = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({
    id: 1_700_000_000_601, name: 'Offline images',
    fields: [{ name: 'Word' }, { name: 'Meaning' }, { name: 'Images' }],
    templates: [{ name: 'Recognition', questionFormat: '{{Word}}{{Images}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}{{Images}}' }],
  })
  const deck = new Deck({ id: 1_700_000_000_602, name: 'Offline Japanese images' })
  for (const [word, meaning, guid] of [['猫', 'cat', 'offline-cat'], ['犬', 'dog', 'offline-dog']]) {
    deck.addNote(new Note({ notetype: type, guid, fields: [word, meaning, '<img src="cat.png"><img src="dog.png">'] }))
  }
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('cat.png', Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64')))
  pkg.addMedia('dog.png', Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOrkAAAAASUVORK5CYII=', 'base64')))
  return Buffer.from(await pkg.toUint8Array(sql))
}

async function expectDecoded(images: Locator, count: number) {
  await expect(images).toHaveCount(count)
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  }
}

test('new Japanese cards and answer images decode throughout a warm offline review', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'offline-images.apkg', mimeType: 'application/octet-stream', buffer: await packageWithImages() })
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open Offline Japanese images' }).click()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  // Nothing in the reviewer, including either image, has rendered yet.
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()
  const review = page.frameLocator('iframe[title="Review card"]')
  const images = review.locator('img')
  await expectDecoded(images, 2)
  const firstWord = (await review.locator('body').textContent())?.trim()
  expect(['猫', '犬']).toContain(firstWord)
  const source = await images.first().getAttribute('src')
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expectDecoded(images, 4)
  await expect(images.first()).toHaveAttribute('src', source!)
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expectDecoded(images, 2)
  await expect(review.locator('body')).toHaveText(firstWord === '猫' ? '犬' : '猫')
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expectDecoded(images, 4)
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('2 reviews recorded')).toBeVisible()
})
