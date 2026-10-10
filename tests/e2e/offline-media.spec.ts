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
    await expect(async () => {
      // Answer changes navigate srcdoc. Reacquire the image in the resulting document
      // if WebKit destroys the old execution context while the assertion samples it.
      expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    }).toPass({ timeout: 5_000 })
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
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await expectDecoded(images, 2)
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expectDecoded(images, 4)
    await page.getByRole('button', { name: /^Good ·/ }).click()
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('4 reviews recorded')).toBeVisible()
})

const uploadedImage = { name: 'uploaded.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') }

async function createImageDeck(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('Offline uploaded images')
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: 'Open Offline uploaded images' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
}

test('uploaded front and back attachments decode when review starts offline', async ({ page, context }) => {
  await createImageDeck(page)
  await page.getByLabel('Front', { exact: true }).fill('猫')
  await page.getByLabel('Back', { exact: true }).fill('cat')
  await page.getByLabel('Images and audio').setInputFiles([uploadedImage, { ...uploadedImage, name: 'back.png' }])
  await page.getByLabel('Show on').nth(1).selectOption('back')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()
  await expectDecoded(page.locator('.review-card .card-image'), 1)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expectDecoded(page.locator('.review-card .card-image'), 2)
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expectDecoded(page.locator('.review-card .card-image'), 1)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
})

test('occlusion source decodes when the first masked card is rendered offline', async ({ page, context }) => {
  await createImageDeck(page)
  await page.getByRole('combobox', { name: 'Note type' }).selectOption('image-occlusion')
  await page.getByLabel('Source image').setInputFiles(uploadedImage)
  const canvas = page.getByLabel('Draw image occlusion masks')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Occlusion canvas is not measurable')
  await canvas.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: box.x + box.width * .1, clientY: box.y + box.height * .1 })
  await canvas.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: box.x + box.width * .6, clientY: box.y + box.height * .6 })
  await canvas.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: box.x + box.width * .6, clientY: box.y + box.height * .6 })
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()
  const image = page.locator('.occlusion-review-canvas image')
  await expect(image).toHaveAttribute('href', /^data:image\/png;base64,/)
  // SVG image visibility alone does not prove its source decoded.
  await expect.poll(() => image.evaluate(async (element) => {
    const probe = new Image()
    probe.style.display = 'none'
    document.body.append(probe)
    probe.src = element.getAttribute('href') ?? ''
    try {
      // Windows WebKit can reject decode() after successfully loading pixels.
      // The same complete/naturalWidth gate used for visible img elements proves decoding.
      await probe.decode().catch(() => undefined)
      return probe.complete && probe.naturalWidth > 0
    } finally { probe.remove() }
  })).toBe(true)
  await expect(page.locator('.occlusion-mask')).toHaveCount(1)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.locator('.occlusion-revealed-mask')).toHaveCount(1)
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(page.locator('.occlusion-mask')).toHaveCount(1)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
})

test('same-filename uploaded front and back images retain their own decoded pixels offline', async ({ page, context }) => {
  const red = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  const blue = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=='
  await createImageDeck(page)
  await page.getByLabel('Front', { exact: true }).fill('赤')
  await page.getByLabel('Back', { exact: true }).fill('青')
  await page.getByLabel('Images and audio').setInputFiles([red, blue].map((base64) => ({ name: 'picture.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') })))
  await page.getByLabel('Show on').nth(1).selectOption('back')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()
  const images = page.locator('.review-card .card-image')
  await expectDecoded(images, 1)
  await expect(images.first()).toHaveAttribute('src', `data:image/png;base64,${red}`)
  const pixel = (image: Locator) => image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const drawing = canvas.getContext('2d')!
    drawing.drawImage(element, 0, 0)
    return Array.from(drawing.getImageData(0, 0, 1, 1).data)
  })
  await expect.poll(() => pixel(images.first())).toEqual([255, 0, 0, 255])
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expectDecoded(images, 2)
  await expect(images.first()).toHaveAttribute('src', `data:image/png;base64,${red}`)
  await expect(images.nth(1)).toHaveAttribute('src', `data:image/png;base64,${blue}`)
  await expect.poll(() => pixel(images.first())).toEqual([255, 0, 0, 255])
  await expect.poll(() => pixel(images.nth(1))).toEqual([0, 0, 255, 255])
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expectDecoded(page.locator('.review-card .card-image'), 1)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
})
