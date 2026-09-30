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
  const runtimeDirectory = join(tmpdir(), 'kiroku-e2e-sync')
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

test('learner creates, edits, and reviews a Japanese card offline', async ({ browserName, context, page }) => {
  await createDeck(page, 'Japanese Core')

  await page.getByRole('button', { name: 'Open Japanese Core' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByRole('dialog', { name: 'Add a Basic note' })).toBeVisible()
  await page.getByLabel('Front').fill('猫')
  await page.getByLabel('Back').fill('ねこ · cat')
  await page.getByRole('button', { name: 'Save note' }).click()

  await expect(page.getByText('猫')).toBeVisible()
  await page.getByRole('button', { name: 'Edit note' }).click()
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

test('PC and phone contexts exchange a collection and an FSRS review through the sync service', async ({ browser }) => {
  const pcContext = await browser.newContext()
  const phoneContext = await browser.newContext()
  try {
    const pc = await pcContext.newPage()
    const phone = await phoneContext.newPage()
    await Promise.all([pc.clock.setFixedTime(REVIEW_TIME), phone.clock.setFixedTime(REVIEW_TIME)])
    await Promise.all([pc.goto('/'), phone.goto('/')])

    await createDeck(pc, 'Shared Japanese')
    await pc.getByRole('button', { name: 'Open Shared Japanese' }).click()
    await pc.getByRole('button', { name: 'Add note' }).click()
    await pc.getByLabel('Front').fill('犬')
    await pc.getByLabel('Back').fill('いぬ · dog')
    await pc.getByRole('button', { name: 'Save note' }).click()

    await pair(pc)
    await pair(phone)
    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText('Sync complete. 3 local changes sent.')).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByRole('button', { name: 'Open Shared Japanese' })).toBeVisible()

    await phone.getByRole('button', { name: 'Open Shared Japanese' }).click()
    await phone.getByRole('button', { name: 'Study now' }).click()
    await phone.getByRole('button', { name: 'Show answer' }).click()
    await phone.getByRole('button', { name: /^Good · / }).click()
    await expect(phone.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await phone.getByRole('button', { name: 'Sync now' }).click()
    await expect(phone.getByText('Sync complete. 2 local changes sent.')).toBeVisible()

    await pc.getByRole('button', { name: 'Sync now' }).click()
    await expect(pc.getByText('LEARNING 1')).toBeVisible()
    await expect(pc.getByText('REVIEWS 1')).toBeVisible()
  } finally {
    await pcContext.close()
    await phoneContext.close()
  }
})
