import { expect, test } from '@playwright/test'
import { navigateOfflineDocument, openOfflineProfileDocument, WEBKIT_COLD_OFFLINE_LIMITATION } from './offline-navigation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import initSqlJs from 'sql.js'
import { zipSync } from 'fflate'
import { Deck as AnkiDeck, Note as AnkiNote, Notetype as AnkiNotetype, Package as AnkiPackage } from 'ankipack'

const REVIEW_TIME = new Date('2026-09-30T12:00:00.000Z')
const execFile = promisify(execFileCallback)
const WEB_URL = `http://127.0.0.1:${process.env.KIROKU_WEB_PORT ?? '4173'}`
const SYNC_URL = `http://127.0.0.1:${process.env.KIROKU_SYNC_PORT ?? '4174'}`

for (const reopen of [false, true]) {
test(`statistics follow an offline Japanese review, heatmap selection, and undo${reopen ? ' in a fresh document' : ' in the current session'}`, async ({ page, context, browserName }) => {
  test.skip(reopen && browserName === 'webkit', 'Playwright supports service workers only in Chromium; fresh offline navigation needs physical Safari verification. https://playwright.dev/docs/service-workers')
  await context.setOffline(false)
  await page.clock.setFixedTime(REVIEW_TIME)
  await page.goto('/')
  await createDeck(page, '日本語 progress')
  await page.getByRole('button', { name: 'Open 日本語 progress' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Front', { exact: true }).fill('猫')
  await page.getByLabel('Back', { exact: true }).fill('cat')
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
  try {
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Study now' }).click()
    const reviewURL = page.url()
    await page.getByRole('button', { name: 'Show answer' }).click()
    await page.getByRole('button', { name: /^Easy ·/ }).click()
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await page.getByRole('link', { name: 'Statistics', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Every answer adds up' })).toBeVisible()
    await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('1')
    await expect(page.getByText('REVIEW TIME', { exact: true }).locator('..')).toContainText('Measured for 1 of 1 answers')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('statistics.png'), fullPage: true })
    await page.getByRole('button', { name: '2026-09-30: 1 answers' }).click()
    await expect(page.getByLabel('Period', { exact: true })).toHaveValue('day')
    await page.getByRole('button', { name: '猫 · basic' }).click()
    await expect(page.getByRole('dialog', { name: 'Card progress' })).toContainText('Review history')
    await expect(page.getByRole('dialog', { name: 'Card progress' })).toContainText('Easy')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    if (reopen) {
      const statisticsURL = page.url()
      const previousPage = page
      await page.evaluate(() => { Reflect.set(window, 'kirokuStatisticsReloadMarker', true) })
      page = await context.newPage()
      await page.clock.setFixedTime(REVIEW_TIME)
      await openOfflineProfileDocument(page, statisticsURL)
      await expect(page.getByRole('heading', { name: 'Every answer adds up' })).toBeVisible()
      await expect.poll(() => page.evaluate(() => Reflect.has(window, 'kirokuStatisticsReloadMarker'))).toBe(false)
      await previousPage.close()
    }
    await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('1')
    await page.getByRole('link', { name: 'Decks', exact: true }).click()
    await expect(page.getByRole('region', { name: "Today's workload" })).toContainText('STUDIED 1')
    await page.evaluate((url) => { window.location.hash = new URL(url).hash }, reviewURL)
    await page.getByRole('button', { name: 'Undo last review' }).click()
    await page.getByRole('link', { name: 'Statistics', exact: true }).click()
    await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('0')
  } finally { await context.setOffline(false) }
})
}

function wavFixture() {
  const samples = 800
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => [...value].forEach((character, index) => { bytes[offset + index] = character.charCodeAt(0) })
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true)
  view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, samples, true)
  bytes.fill(128, 44)
  return bytes
}

async function importFixture() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new AnkiNotetype({
    id: 1_700_000_000_101,
    name: 'Imported Japanese',
    fields: [{ name: 'Expression' }, { name: 'Reading' }, { name: 'Meaning' }, { name: 'Media' }],
    templates: [{ name: 'Recognition', questionFormat: '<b>{{Expression}}</b><br>{{furigana:Reading}}{{Media}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }],
    css: '.card { color: rgb(30, 40, 50); }',
  })
  const deck = new AnkiDeck({ id: 1_700_000_000_102, name: 'Imported::Japanese' })
  deck.addNote(new AnkiNote({ notetype: type, guid: 'e2e-import-guid', fields: ['猫', '猫[ねこ]', 'cat', '<img src="cat.png">[sound:cat.wav]'], tags: ['jlpt::n5'] }))
  const pkg = new AnkiPackage()
  pkg.addDeck(deck)
  pkg.addMedia('cat.png', Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64')))
  pkg.addMedia('cat.wav', wavFixture())
  return Buffer.from(await pkg.toUint8Array(SQL))
}

async function createDeck(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await expect(page.getByRole('dialog', { name: 'Create a deck' })).toBeVisible()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

function configuredSyncRuntimeDirectory() {
  const runtimeDirectory = test.info().config.metadata.syncRuntimeDirectory
  if (typeof runtimeDirectory !== 'string' || !runtimeDirectory.trim()) {
    throw new Error('Playwright did not provide the sync runtime directory to this worker')
  }
  return runtimeDirectory
}

async function pairingCode() {
  const runtimeDirectory = configuredSyncRuntimeDirectory()
  const { stdout } = await execFile(process.execPath, ['dist-server/server/index.js', '--pairing-code'], {
    env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: runtimeDirectory },
  })
  return stdout.trim()
}

async function pair(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Connect a PC' }).click()
  await page.getByLabel('PC service address').fill(SYNC_URL)
  await page.getByLabel('One-time pairing code').fill(await pairingCode())
  await page.getByRole('button', { name: 'Connect device' }).click()
  await expect(page.getByText('PC connected. Your collections are ready to sync.')).toBeVisible()
}

async function expectAudioReady(audio: import('@playwright/test').Locator, browserName: string) {
  await expect(audio).toHaveCount(1)
  await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
  // Playwright's Windows WebKit port has no functional audio backend; Chromium proves decode.
  if (browserName === 'chromium') await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
}

async function drawOcclusionMask(canvas: import('@playwright/test').Locator, pointerId: number, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Image occlusion canvas was not measurable')
  const coordinates = (point: { x: number; y: number }) => ({ clientX: box.x + box.width * point.x, clientY: box.y + box.height * point.y })
  await canvas.dispatchEvent('pointerdown', { pointerId, pointerType: 'touch', ...coordinates(from) })
  await canvas.dispatchEvent('pointermove', { pointerId, pointerType: 'touch', ...coordinates(to) })
  await canvas.dispatchEvent('pointerup', { pointerId, pointerType: 'touch', ...coordinates(to) })
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(REVIEW_TIME)
  await page.goto('/')
})

test('unsafe archive previews keep existing Japanese material intact', async ({ page }) => {
  await createDeck(page, 'Protected import')
  await page.getByRole('button', { name: 'Open Protected import' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Front').fill('守る')
  await page.getByLabel('Back').fill('protect')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.goto('/#decks')
  const archive = Buffer.from(zipSync({ '../media': new Uint8Array() }))
  for (const extension of ['apkg', 'colpkg']) {
    await page.getByRole('button', { name: 'Import Anki package' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
    await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: `unsafe.${extension}`, mimeType: 'application/octet-stream', buffer: archive })
    await expect(dialog.getByRole('alert')).toContainText('unsafe entry name')
    await expect(dialog.getByRole('button', { name: 'Import package' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  }
  await page.getByRole('button', { name: 'Open Protected import' }).click()
  await expect(page.getByText('守る', { exact: true })).toBeVisible()
  await expect(page.getByText('NEW 1', { exact: true })).toBeVisible()
})

for (const reopen of [false, true]) {
  test(`learner previews and imports an Anki package before studying its media offline${reopen ? ' in a fresh document' : ' in the current session'}`, async ({ page, browserName }) => {
    test.skip(reopen && browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
    await page.getByRole('button', { name: 'Import Anki package' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
    await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'japanese.apkg', mimeType: 'application/octet-stream', buffer: await importFixture() })
    await expect(dialog.getByText('2 decks')).toBeVisible()
    await expect(dialog.getByText('1 note type')).toBeVisible()
    await expect(dialog.getByText('1 note', { exact: true })).toBeVisible()
    await expect(dialog.getByText('1 card')).toBeVisible()
    await expect(dialog.getByText('2 media files')).toBeVisible()
    await expect(dialog.getByText(/Stable Anki note identities/)).toBeVisible()
    await expect(dialog.getByText(/Preserved nested deck path Imported::Japanese/)).toBeVisible()
    await page.getByRole('button', { name: 'Import package' }).click()

    await page.getByRole('button', { name: 'Open Japanese' }).click()
    await expect(page.getByText('猫', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Study now' }).click()
    const review = page.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('ruby')).toHaveText('猫ねこ')
    await expect(review.locator('body')).toHaveCSS('color', 'rgb(30, 40, 50)')
    const image = review.getByRole('img', { name: 'cat.png' })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    const audio = review.locator('audio')
    await expectAudioReady(audio, browserName)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.context().setOffline(true)
    if (reopen) await navigateOfflineDocument(page)
    else await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(page.frameLocator('iframe[title="Review card"]').locator('ruby')).toHaveText('猫ねこ')
    const offlineReview = page.frameLocator('iframe[title="Review card"]')
    const offlineImage = offlineReview.getByRole('img', { name: 'cat.png' })
    await expect(offlineImage).toBeVisible()
    await expect.poll(() => offlineImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    const offlineAudio = offlineReview.locator('audio')
    await expectAudioReady(offlineAudio, browserName)
    await page.getByRole('button', { name: 'Replay audio' }).click()
    // Windows Playwright WebKit has no functional audio backend, so it cannot
    // prove audible playback. Chromium checks the replay result; iPhone Safari
    // playback remains part of physical-device verification.
    if (browserName === 'chromium') await expect(page.getByText('Audio replayed.', { exact: true })).toBeVisible()
    await expect(page.getByText('Offline shell active')).toBeVisible()
  })
}

for (const reopen of [false, true]) {
  test(`a clean phone syncs imported package media and keeps it offline${reopen ? ' in a fresh document' : ' in the current session'}`, async ({ browser, browserName, page: pc }) => {
    test.skip(reopen && browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    try {
      const phone = await phoneContext.newPage()
      await phone.clock.setFixedTime(REVIEW_TIME)
      await phone.goto(`${WEB_URL}/`)

      await pc.getByRole('button', { name: 'Import Anki package' }).click()
      const dialog = pc.getByRole('dialog', { name: 'Import Anki package' })
      await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'japanese.apkg', mimeType: 'application/octet-stream', buffer: await importFixture() })
      await pc.getByRole('button', { name: 'Import package' }).click()
      await pair(pc)
      await pair(phone)
      await pc.getByRole('button', { name: 'Sync now' }).click()
      await expect(pc.getByText(/2 uploaded and \d+ downloaded/)).toBeVisible()
      await phone.getByRole('button', { name: 'Sync now' }).click()
      await phone.getByRole('button', { name: 'Open Japanese' }).click()
      await phone.getByRole('button', { name: 'Study now' }).click()

      const review = phone.frameLocator('iframe[title="Review card"]')
      const image = review.getByRole('img', { name: 'cat.png' })
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
      const audio = review.locator('audio')
      await expectAudioReady(audio, browserName)
      await phone.evaluate(async () => { await navigator.serviceWorker.ready })
      await phoneContext.setOffline(true)
      if (reopen) await navigateOfflineDocument(phone)
      else await phone.getByRole('button', { name: 'Show answer' }).click()
      const offlineReview = phone.frameLocator('iframe[title="Review card"]')
      const offlineImage = offlineReview.getByRole('img', { name: 'cat.png' })
      await expect(offlineImage).toBeVisible()
      await expect.poll(() => offlineImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
      const offlineAudio = offlineReview.locator('audio')
      await expectAudioReady(offlineAudio, browserName)
      await expect(phone.getByText('Offline shell active')).toBeVisible()
    } finally {
      await phoneContext.close()
    }
  })
}

test('learner manages a note type and previews a second card in isolation', async ({ page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Japanese vocabulary')
  await page.getByLabel('Field 1 name').fill('Word')
  await page.getByLabel('Field 2 name').fill('Meaning')
  await page.getByLabel('Template 1 front').fill('<strong>{{Word}}</strong>')
  await page.getByLabel('Template 1 back').fill('{{Meaning}}')
  await page.getByRole('button', { name: 'Add field' }).click()
  await page.getByLabel('Field 3 name').fill('Reading')
  await page.getByRole('button', { name: 'Move Reading up' }).click()
  await page.getByRole('button', { name: 'Add template' }).click()
  await page.getByLabel('Template 2 name').fill('Reading card')
  await page.getByLabel('Template 2 front').fill('{{Reading}}')
  await page.getByLabel('Template 2 back').fill('{{Word}}')
  await page.getByLabel('Template 1 CSS').fill('body { background: rgb(255, 0, 0); }')
  await page.getByRole('button', { name: 'Save note type' }).click()
  await expect(page.getByRole('heading', { name: 'Japanese vocabulary' })).toBeVisible()

  await createDeck(page, 'Vocabulary')
  await page.getByRole('button', { name: 'Open Vocabulary' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Images and audio').setInputFiles({ name: 'unused.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') })
  await expect(page.getByText('unused.png')).toBeVisible()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Japanese vocabulary' })
  await expect(page.getByText('unused.png')).toHaveCount(0)
  await page.getByLabel('Word').fill('<script>parent.pwned = true</script>猫')
  await page.getByLabel('Meaning').fill('cat')
  await page.getByLabel('Reading').fill('ねこ')
  await expect(page.getByText('2 cards will be created.')).toBeVisible()
  await page.getByRole('button', { name: 'Save note' }).click()

  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Edit Japanese vocabulary' }).click()
  const preview = page.frameLocator('iframe[title="Card preview"]')
  await expect(preview.getByText(/猫/)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined()
  expect(await preview.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).toBe('rgb(255, 0, 0)')
  expect(await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).not.toBe('rgb(255, 0, 0)')
  await page.getByLabel('Template 1 front').fill('<script>parent.pwned = true</script><strong>{{Word}}</strong>')
  await expect(preview.getByText(/猫/)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined()
  await page.getByLabel('Template 1 front').fill('<strong>{{Word}}</strong>')
  await page.getByLabel('Preview template').selectOption({ label: 'Reading card' })
  await expect(preview.getByText('ねこ')).toBeVisible()
  await page.getByLabel('Template 2 front').fill('{{Reading}}')
  await page.getByRole('button', { name: 'Save changes' }).click()
})

test('learner draws an image occlusion and reveals only its active mask in review', async ({ page }) => {
  await createDeck(page, 'Image occlusion deck')
  await page.getByRole('button', { name: 'Open Image occlusion deck' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption('image-occlusion')
  await page.getByLabel('Source image').setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') })
  const canvas = page.getByLabel('Draw image occlusion masks')
  await expect(canvas).toBeVisible()
  await drawOcclusionMask(canvas, 1, { x: .1, y: .1 }, { x: .4, y: .4 })
  await drawOcclusionMask(canvas, 2, { x: .6, y: .6 }, { x: .9, y: .9 })
  await expect(page.getByRole('button', { name: 'Remove mask 2' })).toBeVisible()
  await page.getByLabel('Header').fill('Skull bones')
  await page.getByLabel('Back Extra').fill('Identify the highlighted bone.')
  await page.getByLabel('Tags').fill('anatomy, skull')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.getByLabel('Image occlusion card')).toBeVisible()
  await expect(page.locator('.occlusion-mask')).toHaveCount(2)
  await expect(page.getByText('Skull bones')).toBeVisible()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.locator('.occlusion-revealed-mask')).toHaveCount(1)
  await expect(page.locator('.occlusion-mask')).toHaveCount(1)
  await expect(page.getByText('Identify the highlighted bone.')).toBeVisible()
})

test('learner organizes a child deck and persists a shared daily study limit', async ({ page }) => {
  await createDeck(page, 'Japanese')
  await page.getByRole('button', { name: 'Open Japanese' }).click()
  await page.getByRole('button', { name: 'Create child deck' }).click()
  const childDialog = page.getByRole('dialog', { name: 'Create a child deck' })
  await childDialog.getByLabel('Deck name').fill('Reading')
  await childDialog.getByRole('button', { name: 'Create child deck' }).click()
  await expect(childDialog).toBeHidden()

  await page.getByRole('button', { name: 'Scheduling options' }).click()
  const options = page.getByRole('dialog', { name: 'Scheduling options' })
  await expect(options).toContainText('Japanese')
  await options.getByRole('button', { name: 'Create option group' }).click()
  await options.getByLabel('Option group name').fill('One at a time')
  await options.getByLabel('Daily new limit').fill('1')
  await options.getByRole('button', { name: 'Save options' }).click()
  await expect(options).toBeHidden()

  for (const [front, back] of [['一', 'one'], ['二', 'two']]) {
    await page.getByRole('button', { name: 'Add note' }).click()
    await page.getByLabel('Front').fill(front)
    await page.getByLabel('Back').fill(back)
    await page.getByRole('button', { name: 'Save note' }).click()
  }
  await page.getByRole('button', { name: 'Study now' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /Easy ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to deck' }).click()
  await expect(page.getByRole('button', { name: 'Study now' })).toBeDisabled()

  await page.getByRole('button', { name: '← All decks' }).click()
  const hierarchy = page.getByRole('tree', { name: 'Deck hierarchy' })
  await expect(hierarchy.getByText('Japanese')).toBeVisible()
  await expect(hierarchy.getByText('Reading')).toBeVisible()
})

test('learner saves scheduling policies and manages a card lifecycle', async ({ page }) => {
  await createDeck(page, 'Policy controls')
  await page.getByRole('button', { name: 'Open Policy controls' }).click()
  await page.getByRole('button', { name: 'Scheduling options' }).click()
  const options = page.getByRole('dialog', { name: 'Scheduling options' })
  await options.getByRole('button', { name: 'Create option group' }).click()
  await options.getByLabel('Option group name').fill('Focused scheduling')
  await options.getByLabel('Interday learning order').selectOption('after-reviews')
  await options.getByLabel('Bury new siblings').check()
  await options.getByLabel('Bury review siblings').check()
  await options.getByLabel('Leech threshold').fill('3')
  await options.getByLabel('Leech action').selectOption('tag-only')
  await options.getByLabel('Leech tag').fill('needs-attention')
  await options.getByRole('button', { name: 'Save options' }).click()
  await expect(options).toBeHidden()

  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Front').fill('管理')
  await page.getByLabel('Back').fill('manage')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Manage cards' }).click()
  const cards = page.getByRole('dialog', { name: 'Manage cards' })
  await expect(cards.getByText('Available for scheduling')).toBeVisible()
  await cards.getByRole('button', { name: 'Suspend card' }).click()
  await expect(cards.getByRole('button', { name: 'Resume card' })).toBeVisible()
  await cards.getByRole('button', { name: 'Resume card' }).click()
  await expect(cards.getByRole('button', { name: 'Suspend card' })).toBeVisible()
  await cards.getByRole('button', { name: 'Bury card' }).click()
  await expect(cards.getByRole('button', { name: 'Unbury card' })).toBeVisible()
  await cards.getByRole('button', { name: 'Done' }).click()
  await expect(cards).toBeHidden()
})

test('learner maintains and undoes the current card without leaving review', async ({ page }) => {
  await createDeck(page, 'Reviewer maintenance')
  await page.getByRole('button', { name: 'Open Reviewer maintenance' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Front').fill('古い')
  await page.getByLabel('Back').fill('old')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()
  await page.getByRole('button', { name: 'Edit note' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit Basic note' })
  await editor.getByLabel('Front').fill('新しい')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  await expect(page.frameLocator('iframe[title="Review card"]').getByText('新しい')).toBeVisible()
  await page.getByRole('combobox', { name: 'Card flag' }).selectOption('1')
  await expect(page.getByRole('combobox', { name: 'Card flag' })).toHaveValue('1')
  await page.getByRole('button', { name: 'Mark note' }).click()
  await expect(page.getByRole('button', { name: 'Unmark note' })).toBeVisible()
  await page.getByRole('button', { name: 'Card info' }).click()
  const info = page.getByRole('dialog', { name: 'Card info' })
  await expect(info.getByText('Red', { exact: true })).toBeVisible()
  await expect(info.getByText('marked', { exact: true })).toBeVisible()
  await info.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'Suspend card' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo card action' }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Good · / }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo last review' }).click()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()

  await page.getByRole('button', { name: 'Delete note' }).click()
  await page.getByRole('dialog', { name: 'Delete note' }).getByRole('button', { name: 'Delete note and cards' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo note deletion' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').getByText('新しい')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Card flag' })).toHaveValue('1')
  await expect(page.getByRole('button', { name: 'Unmark note' })).toBeVisible()
})

test('review uses each generated template, isolates its CSS, and skips an empty template', async ({ page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Two directions')
  await page.getByLabel('Field 1 name').fill('Word')
  await page.getByLabel('Field 2 name').fill('Meaning')
  await page.getByRole('button', { name: 'Add field' }).click()
  await page.getByLabel('Field 3 name').fill('Reading')
  await page.getByLabel('Template 1 front').fill('<strong>{{Word}}</strong>')
  await page.getByLabel('Template 1 back').fill('{{FrontSide}}<hr>{{Meaning}}')
  await page.getByLabel('Template 1 CSS').fill('body { background: rgb(255, 0, 0); }')
  await page.getByRole('button', { name: 'Add template' }).click()
  await page.getByLabel('Template 2 name').fill('Reverse')
  await page.getByLabel('Template 2 front').fill('{{Meaning}}')
  await page.getByLabel('Template 2 back').fill('{{Word}}')
  await page.getByLabel('Template 2 CSS').fill('body { background: rgb(0, 0, 255); }')
  await page.getByRole('button', { name: 'Add template' }).click()
  await page.getByLabel('Template 3 name').fill('Reading')
  await page.getByLabel('Template 3 front').fill('{{Reading}}')
  await page.getByLabel('Template 3 back').fill('{{Word}}')
  await page.getByRole('button', { name: 'Save note type' }).click()

  await createDeck(page, 'Directions')
  await page.getByRole('button', { name: 'Open Directions' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Two directions' })
  await page.getByLabel('Word').fill('<b>猫</b>')
  await page.getByLabel('Meaning').fill('cat')
  await expect(page.getByText('2 cards will be created.')).toBeVisible()
  await expect(page.getByText(/Reading: Front has no visible field content/)).toBeVisible()
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('NEW 2')).toBeVisible()

  await page.getByRole('button', { name: 'Study now' }).click()
  const review = page.frameLocator('iframe[title="Review card"]')
  const seen = new Set<string>()
  for (let index = 0; index < 2; index += 1) {
    await expect(review.locator('body')).toContainText(/cat|猫/)
    const wordFirst = await review.getByText('<b>猫</b>').isVisible()
    const direction = wordFirst ? 'word' : 'meaning'
    expect(seen.has(direction)).toBe(false)
    seen.add(direction)
    if (wordFirst) {
      await expect(review.locator('b')).toHaveCount(0)
      await expect(review.locator('body')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
    } else {
      await expect(review.getByText('cat')).toBeVisible()
      await expect(review.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 255)')
    }
    expect(await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).not.toBe(wordFirst ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)')
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(review.getByText('<b>猫</b>')).toBeVisible()
    if (wordFirst) await expect(review.getByText('cat')).toBeVisible()
    await page.getByRole('button', { name: /^Good · / }).click()
    if (index === 0) await expect(review.locator('body')).toHaveCSS('background-color', wordFirst ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)')
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('2 reviews recorded')).toBeVisible()
})

test('a card emptied during review leaves the session and cannot reenter until restored', async ({ context, page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Mutable type')
  await page.getByLabel('Field 1 name').fill('Word')
  await page.getByLabel('Field 2 name').fill('Meaning')
  await page.getByLabel('Template 1 front').fill('{{Word}}')
  await page.getByLabel('Template 1 back').fill('{{Meaning}}')
  await page.getByRole('button', { name: 'Save note type' }).click()
  await createDeck(page, 'Mutable')
  await page.getByRole('button', { name: 'Open Mutable' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Mutable type' })
  await page.getByLabel('Word').fill('猫')
  await page.getByLabel('Meaning').fill('cat')
  await page.getByRole('button', { name: 'Save note' }).click()
  const deckUrl = page.url()
  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').getByText('猫')).toBeVisible()

  const editor = await context.newPage()
  await editor.goto(deckUrl)
  await editor.getByRole('button', { name: 'Edit note' }).click()
  await editor.getByLabel('Word').fill('')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('0 reviews recorded')).toBeVisible()
  await page.getByRole('button', { name: 'Back to deck' }).click()
  await expect(page.getByRole('button', { name: 'Study now' })).toBeDisabled()

  await editor.getByRole('button', { name: 'Edit note' }).click()
  await editor.getByLabel('Word').fill('犬')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('button', { name: 'Study now' })).toBeEnabled()
  await editor.close()
})

test('deleting the active card in another tab ends the review session', async ({ context, page }) => {
  await createDeck(page, 'Temporary')
  await page.getByRole('button', { name: 'Open Temporary' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByLabel('Front').fill('猫')
  await page.getByLabel('Back').fill('cat')
  await page.getByRole('button', { name: 'Save note' }).click()
  const deckUrl = page.url()
  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').getByText('猫')).toBeVisible()

  const editor = await context.newPage()
  await editor.goto(deckUrl)
  await editor.getByRole('button', { name: 'Delete deck' }).click()
  await editor.getByRole('dialog', { name: 'Delete deck' }).getByRole('button', { name: 'Delete deck subtree' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('0 reviews recorded')).toBeVisible()
  await editor.close()
})

test('empty card warning and type deletion preserve mapped note values', async ({ page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Glyph')
  await page.getByLabel('Field 1 name').fill('Character')
  await page.getByLabel('Field 2 name').fill('Meaning')
  await page.getByLabel('Template 1 front').fill('{{Character}}')
  await page.getByLabel('Template 1 back').fill('{{Meaning}}')
  await page.getByRole('button', { name: 'Save note type' }).click()
  await createDeck(page, 'Glyphs')
  await page.getByRole('button', { name: 'Open Glyphs' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  const noteDialog = page.getByRole('dialog', { name: 'Add a Basic note' })
  await expect(noteDialog).toBeVisible()
  const noteType = noteDialog.getByRole('combobox', { name: 'Note type' })
  await expect(noteType.getByRole('option', { name: 'Glyph' })).toHaveCount(1)
  await noteType.selectOption({ label: 'Glyph' })
  await page.getByLabel('Meaning').fill('cat')
  await expect(page.getByText('0 cards will be created.')).toBeVisible()
  await expect(page.getByText(/Front has no visible field content/)).toBeVisible()
  await page.getByLabel('Character').fill('猫')
  await expect(page.getByText('1 card will be created.')).toBeVisible()
  await page.getByRole('button', { name: 'Save note' }).click()

  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Edit Glyph' }).click()
  await page.getByRole('button', { name: 'Remove Meaning' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert')).toContainText('Choose how to handle each removed field')
  await page.getByLabel('Removed Meaning').selectOption('keep-as-extra')
  await page.getByLabel('Template 1 back').fill('{{Character}}')
  await page.getByRole('button', { name: 'Save changes' }).click()

  await page.getByRole('button', { name: 'Delete Glyph' }).click()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(page.getByText(/1 saved note uses this type/)).toBeVisible()
  await page.getByLabel('Replacement note type').selectOption({ label: 'Basic' })
  await page.getByLabel('Map Character').selectOption({ label: 'front' })
  await page.getByRole('button', { name: 'Delete note type' }).click()
  await expect(page.getByRole('heading', { name: 'Glyph' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Decks' }).click()
  await page.getByRole('button', { name: 'Open Glyphs' }).click()
  await page.getByRole('button', { name: 'Edit note' }).click()
  await expect(page.getByLabel('Front')).toHaveValue('猫')
  const retired = page.getByRole('region', { name: 'Retired fields' })
  await expect(retired.getByText('cat')).toBeVisible()
  await expect(retired.getByText(/Retired field · [\da-f-]{36}/)).toBeVisible()
})

for (const reopen of [false, true]) {
  test(`learner creates, edits, and reviews a Japanese card offline${reopen ? ' in a fresh document' : ' in the current session'}`, async ({ browserName, context, page }) => {
    test.skip(reopen && browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
    await createDeck(page, 'Japanese Core')

    await page.getByRole('button', { name: 'Open Japanese Core' }).click()
    await page.getByRole('button', { name: 'Add note' }).click()
    await expect(page.getByRole('dialog', { name: 'Add a Basic note' })).toBeVisible()
    await page.getByLabel('Front').fill('猫')
    await page.getByLabel('Back').fill('ねこ · cat')
    await page.getByRole('button', { name: 'Save note' }).click()

    await expect(page.getByText('猫')).toBeVisible()
    const editNote = page.getByRole('button', { name: 'Edit note' })
    await editNote.evaluate((button) => button.scrollIntoView({ block: 'center' }))
    await editNote.click()
    await page.getByLabel('Back').fill('ねこ · cat · feline')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('ねこ · cat · feline')).toBeVisible()

    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Study now' }).click()
    const review = page.frameLocator('iframe[title="Review card"]')
    await expect(review.getByText('猫')).toBeVisible()
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(review.getByText('ねこ · cat · feline')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Again · / })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Hard · / })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Good · / })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Easy · / })).toBeVisible()
    await page.getByRole('button', { name: /^Good · / }).click()

    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await expect(page.getByText('1 review recorded')).toBeVisible()
    await page.getByRole('button', { name: 'Back to deck' }).click()
    await expect(page.getByText('NEW 0')).toBeVisible()
    await expect(page.getByText('LEARNING 1')).toBeVisible()
    await expect(page.getByText('REVIEWS 1')).toBeVisible()

    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable')
      await navigator.serviceWorker.ready
    })
    await context.setOffline(true)
    if (reopen) await navigateOfflineDocument(page)

    await expect(page.getByRole('heading', { name: 'Japanese Core' })).toBeVisible()
    await expect(page.getByText('NEW 0')).toBeVisible()
    await expect(page.getByText('LEARNING 1')).toBeVisible()
    await expect(page.getByText('REVIEWS 1')).toBeVisible()
    await expect(page.getByText('Offline shell active')).toBeVisible()
  })
}

test('persistent profile reopens offline and continues a remaining Japanese review', async ({ browserName, browser }) => {
  test.skip(browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-profile-'))
  let firstContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined

  try {
    firstContext = await browser.browserType().launchPersistentContext(profile)
    const firstPage = firstContext.pages()[0] ?? await firstContext.newPage()
    await firstPage.clock.setFixedTime(REVIEW_TIME)
    await firstPage.goto(`${WEB_URL}/`)
    await createDeck(firstPage, 'Offline Japanese')
    await firstPage.getByRole('button', { name: 'Open Offline Japanese' }).click()

    for (const [front, back] of [['猫', 'ねこ · cat'], ['犬', 'いぬ · dog']]) {
      await firstPage.getByRole('button', { name: 'Add note' }).click()
      await firstPage.getByLabel('Front').fill(front)
      await firstPage.getByLabel('Back').fill(back)
      await firstPage.getByRole('button', { name: 'Save note' }).click()
    }

    const deckId = await firstPage.evaluate(() => window.location.hash.split('/')[1])
    await firstPage.getByRole('button', { name: 'Study now' }).click()
    const firstReview = firstPage.frameLocator('iframe[title="Review card"]').locator('body')
    await expect(firstReview).toHaveText(/^(猫|犬)$/)
    const firstFront = (await firstReview.textContent())?.trim()
    const remainingFront = firstFront === '猫' ? '犬' : '猫'
    await firstPage.getByRole('button', { name: 'Show answer' }).click()
    await firstPage.getByRole('button', { name: /^Good · / }).click()
    await expect(firstReview).toHaveText(remainingFront)
    await firstPage.evaluate(async () => { await navigator.serviceWorker.ready })

    await firstContext.close()
    firstContext = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile)
    await reopenedContext.setOffline(true)

    const reopenedPage = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopenedPage.clock.setFixedTime(REVIEW_TIME)
    await openOfflineProfileDocument(reopenedPage, `${WEB_URL}/#deck/${deckId}`)

    await expect(reopenedPage.getByRole('heading', { name: 'Offline Japanese' })).toBeVisible()
    await expect(reopenedPage.getByText('NEW 1')).toBeVisible()
    await expect(reopenedPage.getByText('LEARNING 1')).toBeVisible()
    await reopenedPage.getByRole('button', { name: 'Study now' }).click()
    await expect(reopenedPage.frameLocator('iframe[title="Review card"]').locator('body')).toHaveText(remainingFront)
    await reopenedPage.getByRole('button', { name: 'Show answer' }).click()
    await expect(reopenedPage.getByRole('button', { name: /^Good · / })).toBeVisible()
    await reopenedPage.getByRole('button', { name: /^Good · / }).click()
    await expect(reopenedPage.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await expect(reopenedPage.getByText('1 review recorded')).toBeVisible()
  } finally {
    await firstContext?.close()
    await reopenedContext?.close()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('learner renames and deletes a deck', async ({ page }) => {
  await createDeck(page, 'Draft deck')
  await page.getByRole('button', { name: 'Open Draft deck' }).click()

  await page.getByRole('button', { name: 'Rename deck' }).click()
  await page.getByLabel('Deck name').fill('JLPT N5')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { name: 'JLPT N5' })).toBeVisible()

  await page.getByRole('button', { name: 'Delete deck' }).click()
  await page.getByRole('dialog', { name: 'Delete deck' }).getByRole('button', { name: 'Delete deck subtree' }).click()
  await expect(page.getByRole('heading', { name: 'Start with one deck' })).toBeVisible()
  await expect(page.getByText('JLPT N5')).not.toBeVisible()
})

test('PC and phone contexts exchange a collection and an FSRS review through the sync service', async ({ browser, page: pc }, testInfo) => {
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const deckName = `Shared Japanese ${testInfo.project.name} ${Date.now()}`
  try {
    const phone = await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto(`${WEB_URL}/`)

    await createDeck(pc, deckName)
    await pc.getByRole('button', { name: `Open ${deckName}` }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByLabel('Front').fill('犬')
    await pc.getByLabel('Back').fill('いぬ · dog')
    await pc.getByRole('button', { name: 'Save note' }).click()

    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible({ timeout: 15_000 })
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByRole('button', { name: `Open ${deckName}` })).toBeVisible({ timeout: 15_000 })

    await phone.getByRole('button', { name: `Open ${deckName}` }).click()
    await phone.getByRole('button', { name: 'Study now' }).click()
    await phone.getByRole('button', { name: 'Show answer' }).click()
    await phone.getByRole('button', { name: /^Good · / }).click()
    await expect(phone.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible({ timeout: 15_000 })

    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText('LEARNING 1')).toBeVisible()
    await expect(pc.getByText('REVIEWS 1')).toBeVisible()
  } finally {
    await phoneContext.close()
  }
})

test('a phone keeps verified synced media after a cold offline profile restart', async ({ browserName, browser, page: pc }, testInfo) => {
  test.skip(browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-media-profile-'))
  const deckName = `Media Japanese ${testInfo.project.name} ${Date.now()}`
  let phoneContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined
  try {
    phoneContext = await browser.browserType().launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = phoneContext.pages()[0] ?? await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto(`${WEB_URL}/`)

    await createDeck(pc, deckName)
    await pc.getByRole('button', { name: `Open ${deckName}` }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByLabel('Front').fill('猫')
    await pc.getByLabel('Back').fill('cat')
    await pc.getByLabel('Images and audio').setInputFiles([
      { name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') },
      { name: 'cat.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x25, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0, 0x64, 0x61, 0x74, 0x61, 1, 0, 0, 0, 0x80]) },
    ])
    await expect(pc.getByText('cat.png')).toBeVisible()
    await pc.getByRole('button', { name: 'Save note' }).click()
    const deckId = await pc.evaluate(() => window.location.hash.split('/')[1])

    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText(/2 uploaded and \d+ downloaded/)).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await phone.getByRole('button', { name: `Open ${deckName}` }).click()
    await phone.getByRole('button', { name: 'Study now' }).click()
    const image = phone.getByRole('img', { name: 'cat.png' })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    const audio = phone.locator('audio')
    await expect(audio).toHaveCount(1)
    await expect(audio).toHaveJSProperty('controls', true)
    await expect(audio).toHaveJSProperty('autoplay', true)
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
    await phone.evaluate(async () => { await navigator.serviceWorker.ready })

    await phoneContext.close()
    phoneContext = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await reopenedContext.setOffline(true)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopened.clock.setFixedTime(REVIEW_TIME)
    await openOfflineProfileDocument(reopened, `${WEB_URL}/#deck/${deckId}`)
    await reopened.getByRole('button', { name: 'Study now' }).click()
    const offlineImage = reopened.getByRole('img', { name: 'cat.png' })
    await expect(offlineImage).toBeVisible()
    await expect.poll(() => offlineImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    const offlineAudio = reopened.locator('audio')
    await expect(offlineAudio).toHaveCount(1)
    await expect(offlineAudio).toHaveJSProperty('controls', true)
    await expect.poll(() => offlineAudio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
  } finally {
    await phoneContext?.close()
    await reopenedContext?.close()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('a phone reopens a synced image occlusion source offline', async ({ browserName, browser, page: pc }, testInfo) => {
  test.skip(browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-occlusion-profile-'))
  const deckName = `Occlusion sync ${testInfo.project.name} ${Date.now()}`
  let phoneContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined
  try {
    phoneContext = await browser.browserType().launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = phoneContext.pages()[0] ?? await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto(`${WEB_URL}/`)

    await createDeck(pc, deckName)
    await pc.getByRole('button', { name: `Open ${deckName}` }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByRole('combobox', { name: 'Note type' }).selectOption('image-occlusion')
    await pc.getByLabel('Source image').setInputFiles({ name: 'synced-diagram.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64') })
    const editorCanvas = pc.getByLabel('Draw image occlusion masks')
    await expect(editorCanvas).toBeVisible()
    await drawOcclusionMask(editorCanvas, 1, { x: .1, y: .1 }, { x: .4, y: .4 })
    await drawOcclusionMask(editorCanvas, 2, { x: .6, y: .6 }, { x: .9, y: .9 })
    await pc.getByRole('button', { name: 'Save note' }).click()
    const deckId = await pc.evaluate(() => window.location.hash.split('/')[1])

    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByRole('region', { name: 'PC sync' }).getByText(/Sync complete\./)).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await phone.getByRole('button', { name: `Open ${deckName}` }).click()
    await phone.getByRole('button', { name: 'Study now' }).click()
    await expect(phone.getByLabel('Image occlusion card')).toBeVisible()
    await expect(phone.locator('.occlusion-review-canvas image')).toHaveAttribute('href', /^data:image\/png;base64,/)
    await expect(phone.locator('.occlusion-mask')).toHaveCount(2)
    await phone.getByRole('button', { name: 'Show answer' }).click()
    await expect(phone.locator('.occlusion-revealed-mask')).toHaveCount(1)
    await expect(phone.locator('.occlusion-mask')).toHaveCount(1)
    await phone.evaluate(async () => { await navigator.serviceWorker.ready })

    await phoneContext.close()
    phoneContext = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await reopenedContext.setOffline(true)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopened.clock.setFixedTime(REVIEW_TIME)
    await openOfflineProfileDocument(reopened, `${WEB_URL}/#deck/${deckId}`)
    await reopened.getByRole('button', { name: 'Study now' }).click()
    await expect(reopened.getByLabel('Image occlusion card')).toBeVisible()
    await expect(reopened.locator('.occlusion-review-canvas image')).toHaveAttribute('href', /^data:image\/png;base64,/)
    await expect(reopened.locator('.occlusion-mask')).toHaveCount(2)
    await reopened.getByRole('button', { name: 'Show answer' }).click()
    await expect(reopened.locator('.occlusion-revealed-mask')).toHaveCount(1)
    await expect(reopened.locator('.occlusion-mask')).toHaveCount(1)
  } finally {
    await phoneContext?.close()
    await reopenedContext?.close()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('cloze editor previews ordinals and reviewer shows furigana and typed differences', async ({ page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Cloze Japanese')
  await page.getByLabel('Card generation').selectOption('cloze')
  await page.getByLabel('Template 1 front').fill('{{cloze:Text}}<br>{{furigana:Extra}}{{type:cloze:Text}}')
  await page.getByLabel('Sample Extra').fill('猫[ねこ]')
  await page.getByLabel('Preview ordinal').selectOption('2')
  const preview = page.frameLocator('iframe[title="Card preview"]')
  await expect(preview.getByText('東京に[…]')).toBeVisible()
  await expect(preview.locator('ruby')).toHaveText('猫ねこ')
  await page.getByRole('button', { name: 'Save note type' }).click()

  await createDeck(page, 'Cloze deck')
  await page.getByRole('button', { name: 'Open Cloze deck' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Cloze Japanese' })
  await page.getByLabel('Text').fill('東京に行く')
  await page.getByLabel('Text').evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2))
  await page.getByRole('button', { name: 'Make cloze' }).click()
  await expect(page.getByLabel('Text')).toHaveValue('{{c1::東京}}に行く')
  await page.getByLabel('Text').evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 8))
  await page.getByRole('button', { name: 'Make cloze' }).click()
  await expect(page.getByRole('alert')).toContainText('outside existing deletions')
  await expect(page.getByLabel('Text')).toHaveValue('{{c1::東京}}に行く')
  await page.getByLabel('Text').fill('{{c1::東京::city}}に{{c2::行く}}')
  await page.getByLabel('Extra').fill('猫[ねこ]')
  await expect(page.getByText('2 cards will be created.')).toBeVisible()
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()
  const review = page.frameLocator('iframe[title="Review card"]')
  await expect(review.getByText('[city]に行く')).toBeVisible()
  await expect(review.locator('ruby')).toHaveText('猫ねこ')
  await page.getByRole('textbox', { name: 'Type your answer' }).fill('東亰')
  await page.getByRole('textbox', { name: 'Type your answer' }).press('Enter')
  await expect(page.getByLabel('Typed answer comparison')).toContainText('Expected: 東京')
  await expect(page.getByRole('status', { name: 'Typed answer comparison' })).toBeFocused()
  await expect(page.getByLabel('Incorrect: 亰')).toBeVisible()
  await expect(page.getByLabel('Missing: 京')).toBeVisible()
  await expect(review.getByText('東京に行く')).toBeVisible()
  await page.getByRole('button', { name: /^Good · / }).click()
  await expect(review.getByText('東京に[…]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Type your answer' })).toHaveValue('')
})

test('a typed-only front creates a card and announces the comparison after Enter', async ({ page }) => {
  await page.getByRole('link', { name: 'Note types' }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Type the word')
  await page.getByLabel('Field 1 name').fill('Word')
  await page.getByLabel('Template 1 front').fill('{{type:Word}}')
  await page.getByLabel('Template 1 back').fill('{{Word}}')
  await page.getByRole('button', { name: 'Save note type' }).click()
  await createDeck(page, 'Typing deck')
  await page.getByRole('button', { name: 'Open Typing deck' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Type the word' })
  await page.getByRole('textbox', { name: 'Word', exact: true }).fill('猫')
  await expect(page.getByText('1 card will be created.')).toBeVisible()
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()
  const input = page.getByRole('textbox', { name: 'Type your answer' })
  await expect(input).toBeVisible()
  await input.fill('犬')
  await input.press('Enter')
  const result = page.getByRole('status', { name: 'Typed answer comparison' })
  await expect(result).toContainText('Expected: 猫')
  await expect(result).toBeFocused()
  await expect(page.getByRole('button', { name: /^Good · / })).toBeVisible()
})

test('a cloze review survives a cold offline profile restart', async ({ browserName, browser }) => {
  test.skip(browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-cloze-profile-'))
  let firstContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined
  try {
    firstContext = await browser.browserType().launchPersistentContext(profile)
    const first = firstContext.pages()[0] ?? await firstContext.newPage()
    await first.clock.setFixedTime(REVIEW_TIME)
    await first.goto(`${WEB_URL}/`)
    await first.getByRole('link', { name: 'Note types' }).click()
    await first.getByRole('button', { name: 'Create note type' }).click()
    await first.getByLabel('Note type name').fill('Offline cloze')
    await first.getByLabel('Card generation').selectOption('cloze')
    await first.getByRole('button', { name: 'Save note type' }).click()
    await createDeck(first, 'Offline cloze deck')
    await first.getByRole('button', { name: 'Open Offline cloze deck' }).click()
    await first.getByRole('button', { name: 'Add note' }).click()
    await first.getByRole('combobox', { name: 'Note type' }).selectOption({ label: 'Offline cloze' })
    await first.getByLabel('Text').fill('{{c1::猫}}と{{c2::犬}}')
    await first.getByRole('button', { name: 'Save note' }).click()
    const deckId = await first.evaluate(() => window.location.hash.split('/')[1])
    await first.getByRole('button', { name: 'Study now' }).click()
    await first.getByRole('button', { name: 'Show answer' }).click()
    await first.getByRole('button', { name: /^Good · / }).click()
    await expect(first.frameLocator('iframe[title="Review card"]').getByText('猫と[…]')).toBeVisible()
    await first.evaluate(async () => { await navigator.serviceWorker.ready })
    await firstContext.close()
    firstContext = undefined

    reopenedContext = await browser.browserType().launchPersistentContext(profile)
    await reopenedContext.setOffline(true)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopened.clock.setFixedTime(REVIEW_TIME)
    await openOfflineProfileDocument(reopened, `${WEB_URL}/#deck/${deckId}`)
    await expect(reopened.getByText('NEW 1')).toBeVisible()
    await expect(reopened.getByText('LEARNING 1')).toBeVisible()
    await reopened.getByRole('button', { name: 'Study now' }).click()
    await expect(reopened.frameLocator('iframe[title="Review card"]').getByText('猫と[…]')).toBeVisible()
  } finally {
    await firstContext?.close()
    await reopenedContext?.close()
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('two clients sync cloze ordinals and review history', async ({ browser, page: pc }, testInfo) => {
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const deckName = `Shared cloze ${testInfo.project.name} ${Date.now()}`
  try {
    const phone = await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto(`${WEB_URL}/`)
    await pc.getByRole('link', { name: 'Note types' }).click()
    await pc.getByRole('button', { name: 'Create note type' }).click()
    await pc.getByLabel('Note type name').fill(deckName)
    await pc.getByLabel('Card generation').selectOption('cloze')
    await pc.getByRole('button', { name: 'Save note type' }).click()
    await createDeck(pc, deckName)
    await pc.getByRole('button', { name: `Open ${deckName}` }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByRole('combobox', { name: 'Note type' }).selectOption({ label: deckName })
    await pc.getByLabel('Text').fill('{{c1::猫}}と{{c2::犬}}')
    await pc.getByRole('button', { name: 'Save note' }).click()
    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await phone.getByRole('button', { name: `Open ${deckName}` }).click()
    await expect(phone.getByRole('button', { name: 'Study now' })).toBeEnabled()
    await phone.getByRole('button', { name: 'Study now' }).click()
    await expect(phone.frameLocator('iframe[title="Review card"]').getByText('[…]と犬')).toBeVisible()
    await phone.getByRole('button', { name: 'Show answer' }).click()
    await phone.getByRole('button', { name: /^Good · / }).click()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText('NEW 1')).toBeVisible()
    await expect(pc.getByText('LEARNING 1')).toBeVisible()
    await expect(pc.getByText('REVIEWS 1')).toBeVisible()
  } finally {
    await phoneContext.close()
  }
})
