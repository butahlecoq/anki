import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const REVIEW_TIME = new Date('2026-09-30T12:00:00.000Z')
const execFile = promisify(execFileCallback)

async function createDeck(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await expect(page.getByRole('dialog', { name: 'Create a deck' })).toBeVisible()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function pairingCode() {
  const runtimeDirectory = process.env.KIROKU_RUNTIME_DIRECTORY ?? join(tmpdir(), 'kiroku-e2e-sync')
  const { stdout } = await execFile(process.execPath, ['dist-server/server/index.js', '--pairing-code'], {
    env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: runtimeDirectory },
  })
  return stdout.trim()
}

async function pair(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Connect a PC' }).click()
  await page.getByLabel('PC service address').fill('http://127.0.0.1:4174')
  await page.getByLabel('One-time pairing code').fill(await pairingCode())
  await page.getByRole('button', { name: 'Connect device' }).click()
  await expect(page.getByText('PC connected. Your collections are ready to sync.')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(REVIEW_TIME)
  await page.goto('/')
})

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
  await page.getByLabel('Note type', { exact: true }).selectOption({ label: 'Japanese vocabulary' })
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
  await page.getByLabel('Note type', { exact: true }).selectOption({ label: 'Glyph' })
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
  await expect(page.getByText(/1 saved note uses this type/)).toBeVisible()
  await page.getByLabel('Replacement note type').selectOption({ label: 'Basic' })
  await page.getByLabel('Map Character').selectOption({ label: 'front' })
  await page.getByRole('button', { name: 'Delete note type' }).click()
  await expect(page.getByRole('heading', { name: 'Glyph' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Decks' }).click()
  await page.getByRole('button', { name: 'Open Glyphs' }).click()
  await page.getByRole('button', { name: 'Edit note' }).click()
  await expect(page.getByLabel('Front')).toHaveValue('猫')
})

test('learner creates, edits, and reviews a Japanese card offline', async ({ browserName, context, page }) => {
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

  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.getByRole('heading', { name: '猫' })).toBeVisible()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.getByText('ねこ · cat · feline')).toBeVisible()
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
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } catch (error) {
    if (browserName !== 'webkit' || !(error instanceof Error) || !error.message.includes('internal error')) throw error
  }

  await expect(page.getByRole('heading', { name: 'Japanese Core' })).toBeVisible()
  await expect(page.getByText('NEW 0')).toBeVisible()
  await expect(page.getByText('LEARNING 1')).toBeVisible()
  await expect(page.getByText('REVIEWS 1')).toBeVisible()
  await expect(page.getByText('Offline shell active')).toBeVisible()
})

test('persistent profile reopens offline and continues a remaining Japanese review', async ({ browserName, browser }) => {
  test.skip(browserName === 'webkit', 'The WebKit runner discards IndexedDB when a persistent profile is reopened.')
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-profile-'))
  let firstContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined

  try {
    firstContext = await browser.browserType().launchPersistentContext(profile)
    const firstPage = firstContext.pages()[0] ?? await firstContext.newPage()
    await firstPage.clock.setFixedTime(REVIEW_TIME)
    await firstPage.goto('http://127.0.0.1:4173/')
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
    await firstPage.getByRole('button', { name: 'Show answer' }).click()
    await firstPage.getByRole('button', { name: /^Good · / }).click()
    await expect(firstPage.getByRole('heading', { name: '犬' })).toBeVisible()
    await firstPage.evaluate(async () => { await navigator.serviceWorker.ready })

    await firstContext.close()
    firstContext = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile)
    await reopenedContext.setOffline(true)

    const reopenedPage = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await reopenedPage.clock.setFixedTime(REVIEW_TIME)
    try {
      await reopenedPage.goto(`http://127.0.0.1:4173/#deck/${deckId}`, { waitUntil: 'domcontentloaded' })
    } catch (error) {
      if (browserName !== 'webkit' || !(error instanceof Error) || !error.message.includes('internal error')) throw error
    }

    await expect(reopenedPage.getByRole('heading', { name: 'Offline Japanese' })).toBeVisible()
    await expect(reopenedPage.getByText('NEW 1')).toBeVisible()
    await expect(reopenedPage.getByText('LEARNING 1')).toBeVisible()
    await reopenedPage.getByRole('button', { name: 'Study now' }).click()
    await expect(reopenedPage.getByRole('heading', { name: /猫|犬/ })).toBeVisible()
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

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete deck' }).click()
  await expect(page.getByRole('heading', { name: 'Start with one deck' })).toBeVisible()
  await expect(page.getByText('JLPT N5')).not.toBeVisible()
})

test('PC and phone contexts exchange a collection and an FSRS review through the sync service', async ({ browser, page: pc }, testInfo) => {
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const deckName = `Shared Japanese ${testInfo.project.name} ${Date.now()}`
  try {
    const phone = await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto('http://127.0.0.1:4173/')

    await createDeck(pc, deckName)
    await pc.getByRole('button', { name: `Open ${deckName}` }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByLabel('Front').fill('犬')
    await pc.getByLabel('Back').fill('いぬ · dog')
    await pc.getByRole('button', { name: 'Save note' }).click()

    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByRole('button', { name: `Open ${deckName}` })).toBeVisible()

    await phone.getByRole('button', { name: `Open ${deckName}` }).click()
    await phone.getByRole('button', { name: 'Study now' }).click()
    await phone.getByRole('button', { name: 'Show answer' }).click()
    await phone.getByRole('button', { name: /^Good · / }).click()
    await expect(phone.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible()

    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText('LEARNING 1')).toBeVisible()
    await expect(pc.getByText('REVIEWS 1')).toBeVisible()
  } finally {
    await phoneContext.close()
  }
})

test('a phone keeps verified synced media after a cold offline reload', async ({ browserName, browser, page: pc }, testInfo) => {
  test.skip(browserName === 'webkit', 'The WebKit runner discards IndexedDB when a persistent profile is reopened.')
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-media-profile-'))
  const deckName = `Media Japanese ${testInfo.project.name} ${Date.now()}`
  let phoneContext: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined
  try {
    phoneContext = await browser.browserType().launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = phoneContext.pages()[0] ?? await phoneContext.newPage()
    await phone.clock.setFixedTime(REVIEW_TIME)
    await phone.goto('http://127.0.0.1:4173/')

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
    await expect(pc.getByText(/2 uploaded and 0 downloaded/)).toBeVisible()
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
    await reopened.goto(`http://127.0.0.1:4173/#deck/${deckId}`, { waitUntil: 'domcontentloaded' })
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
