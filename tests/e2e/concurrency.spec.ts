import { expect, test, type Page } from '@playwright/test'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'

const execFile = promisify(execFileCallback)
const webURL = `http://127.0.0.1:${process.env.KIROKU_WEB_PORT ?? '4173'}`
async function isolatedSyncService() {
  const runtime = mkdtempSync(join(tmpdir(), 'kiroku-concurrency-e2e-'))
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => reservation.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve an isolated sync port')
  const port = address.port
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  const url = `http://127.0.0.1:${port}`
  const service = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, PORT: String(port), KIROKU_RUNTIME_DIRECTORY: runtime, KIROKU_ALLOWED_ORIGIN: webURL },
    stdio: 'ignore', windowsHide: true,
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (service.exitCode !== null) throw new Error('The isolated sync service exited before becoming ready')
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })
        if (response.ok) { ready = true; break }
      } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    if (!ready) throw new Error('The isolated sync service did not become ready')
  } catch (error) {
    service.kill()
    rmSync(runtime, { recursive: true, force: true })
    throw error
  }
  return {
    url,
    runtime,
    async close() {
      if (service.exitCode === null) {
        const exited = new Promise<void>((resolve) => service.once('exit', () => resolve()))
        service.kill()
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
      }
      rmSync(runtime, { recursive: true, force: true })
    },
  }
}

async function pair(page: Page, syncURL: string, runtime: string) {
  const { stdout } = await execFile(process.execPath, ['dist-server/server/index.js', '--pairing-code'], { env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: runtime } })
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  await page.getByLabel('PC service address').fill(syncURL)
  await page.getByLabel('One-time pairing code').fill(stdout.trim())
  await page.getByRole('button', { name: 'Connect device', exact: true }).click()
  await expect(page.getByText('PC connected. Your collections are ready to sync.', { exact: true })).toBeVisible()
}

async function sync(page: Page) {
  const region = page.getByRole('region', { name: 'PC sync', exact: true })
  await region.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect(region).toContainText('Sync complete.', { timeout: 20_000 })
}

async function edit(page: Page, front: string, back: string) {
  await page.getByRole('button', { name: 'Edit note', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Basic note', exact: true })
  await dialog.getByRole('textbox').nth(0).fill(front)
  await dialog.getByRole('textbox').nth(1).fill(back)
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByTestId('note-front')).toHaveText(front)
}

async function addNote(page: Page, front: string, back: string) {
  await page.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByLabel('Front', { exact: true }).fill(front)
  await page.getByLabel('Back', { exact: true }).fill(back)
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('note-front').filter({ hasText: front })).toBeVisible()
}

test('independent offline clients merge fields, retain conflicts through reload, and converge after an offline choice', async ({ page: pc, context, browser }) => {
  test.setTimeout(120_000)
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  const syncService = await isolatedSyncService()
  const deckName = 'Concurrent practice deck'
  const errors: string[] = []
  await pc.emulateMedia({ reducedMotion: 'reduce' })
  await phone.emulateMedia({ reducedMotion: 'reduce' })
  for (const page of [pc, phone]) page.on('pageerror', (error) => errors.push(error.message))
  try {
    await pc.clock.setFixedTime(new Date('2026-10-02T12:00:00Z'))
    await phone.clock.setFixedTime(new Date('2026-10-02T12:00:00Z'))
    await pc.goto(webURL); await phone.goto(webURL)
    await pc.getByRole('button', { name: 'New deck', exact: true }).click()
    await pc.getByLabel('Deck name').fill(deckName)
    await pc.getByRole('button', { name: 'Create deck', exact: true }).click()
    await pc.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()
    await pc.getByRole('button', { name: 'Add note', exact: true }).click()
    await pc.getByLabel('Front', { exact: true }).fill('猫')
    await pc.getByLabel('Back', { exact: true }).fill('cat')
    await pc.getByRole('button', { name: 'Save note', exact: true }).click()
    await pair(pc, syncService.url, syncService.runtime); await pair(phone, syncService.url, syncService.runtime)
    await sync(pc); await sync(phone)
    const phoneDeckAction = phone.getByRole('button', { name: `Open ${deckName}`, exact: true })
    await phoneDeckAction.click()
    await context.setOffline(true); await phoneContext.setOffline(true)
    await edit(pc, 'ねこ', 'cat'); await edit(phone, '猫', 'кот')
    await context.setOffline(false); await phoneContext.setOffline(false)
    await sync(pc); await sync(phone); await sync(pc)
    for (const page of [pc, phone]) {
      await expect(page.getByTestId('note-front')).toHaveText('ねこ')
      await expect(page.getByTestId('note-back')).toHaveText('кот')
      await expect(page.getByRole('button', { name: 'Review note conflict', exact: true })).toHaveCount(0)
    }
    await context.setOffline(true); await phoneContext.setOffline(true)
    await edit(pc, 'ねこ office', 'кот · feline'); await edit(phone, 'ネコ home', 'кот')
    await context.setOffline(false); await phoneContext.setOffline(false)
    await sync(pc); await sync(phone); await sync(pc)
    await phone.reload()
    await phone.getByRole('button', { name: 'Review note conflict', exact: true }).click()
    const dialog = phone.getByRole('dialog', { name: 'Choose the saved version' })
    await expect(dialog).toContainText('ねこ office')
    await expect(dialog).toContainText('ネコ home')
    await expect(dialog).toContainText('кот · feline')
    await expect(dialog).toContainText(`Deck: ${deckName}`)
    await expect(dialog).toContainText('Conflicting properties: front')
    await expect.poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await expect.poll(() => phone.evaluate(() => document.documentElement.scrollWidth <= screen.width + 1)).toBe(true)
    await phone.screenshot({ path: test.info().outputPath('offline-conflict-choice.png'), fullPage: true })
    await phoneContext.setOffline(true)
    await dialog.locator('fieldset').filter({ hasText: 'ネコ home' }).getByRole('radio').check()
    await dialog.getByRole('button', { name: 'Save choice', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // Choosing the conflicting front must preserve the independently merged back.
    await expect(phone.getByTestId('note-front')).toHaveText('ネコ home')
    await expect(phone.getByTestId('note-back')).toHaveText('кот · feline')
    await phoneContext.setOffline(false)
    await phone.reload()
    await expect(phone.getByTestId('note-front')).toHaveText('ネコ home')
    // Leave the durable offline choice unsent while the PC creates a newer edit.
    await context.setOffline(true)
    await pc.getByRole('button', { name: 'Review note conflict', exact: true }).click()
    const pcDialog = pc.getByRole('dialog', { name: 'Choose the saved version' })
    await pcDialog.locator('fieldset').filter({ hasText: 'ねこ office' }).getByRole('radio').check()
    await pcDialog.getByRole('button', { name: 'Save choice', exact: true }).click()
    await expect(pcDialog).toHaveCount(0)
    await edit(pc, 'ねこ peer after choice', 'кот · feline')
    await phoneContext.setOffline(false)
    await context.setOffline(false)
    await sync(pc)
    await sync(phone)
    await phone.getByRole('button', { name: 'Review note conflict', exact: true }).click()
    const resumedDialog = phone.getByRole('dialog', { name: 'Choose the saved version' })
    await expect(resumedDialog).toContainText('ねこ peer after choice')
    await expect(resumedDialog).toContainText('ネコ home')
    await phoneContext.setOffline(true)
    await resumedDialog.locator('fieldset').filter({ hasText: 'ねこ peer after choice' }).getByRole('radio').check()
    await resumedDialog.getByRole('button', { name: 'Save choice', exact: true }).click()
    await expect(resumedDialog).toHaveCount(0)
    await expect(phone.getByTestId('note-front')).toHaveText('ねこ peer after choice')
    await phoneContext.setOffline(false)
    await sync(phone); await sync(pc); await sync(phone)
    for (const page of [pc, phone]) {
      await expect(page.getByTestId('note-front')).toHaveText('ねこ peer after choice')
      await expect(page.getByTestId('note-back')).toHaveText('кот · feline')
      await expect(page.getByRole('button', { name: 'Review note conflict', exact: true })).toHaveCount(0)
    }
    // Both clients now review the same previously-new card independently.
    await pc.clock.setFixedTime(new Date('2026-10-02T12:00:10Z'))
    await phone.clock.setFixedTime(new Date('2026-10-02T12:00:20Z'))
    await context.setOffline(true); await phoneContext.setOffline(true)
    for (const [page, rating] of [[pc, 'Good'], [phone, 'Easy']] as const) {
      await page.getByRole('button', { name: 'Study now', exact: true }).click()
      await page.getByRole('button', { name: 'Show answer', exact: true }).click()
      await page.getByRole('button', { name: new RegExp(`^${rating} ·`) }).click()
      await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
      await page.getByRole('button', { name: 'Back to deck', exact: true }).click()
    }
    await context.setOffline(false); await phoneContext.setOffline(false)
    await sync(phone); await sync(pc); await sync(phone); await sync(pc)
    for (const page of [pc, phone]) {
      await page.getByRole('link', { name: 'Statistics', exact: true }).click()
      await page.getByLabel('Statistics deck', { exact: true }).selectOption({ label: `${deckName} (with children)` })
      await page.getByLabel('Period', { exact: true }).selectOption('all')
      await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('2')
      const studiedCards = page.getByRole('heading', { name: 'Cards studied in this period' }).locator('..')
      await expect(studiedCards.getByRole('button')).toHaveCount(1)
      const historyButton = studiedCards.getByRole('button')
      // The statistics panel is tall enough that Chromium repeatedly scrolls
      // this nested control while waiting for a stable pointer hit target.
      // Exercise the real keyboard activation path used by accessible buttons.
      await historyButton.focus()
      await expect(historyButton).toBeFocused()
      await page.keyboard.press('Enter')
      const history = page.getByRole('region', { name: 'Card review history' })
      await expect(history.getByRole('listitem')).toHaveCount(2)
      await expect(history).toContainText('Good'); await expect(history).toContainText('Easy')
    }
    expect(errors).toEqual([])
  } finally {
    await Promise.allSettled([context.setOffline(false), phoneContext.close()])
    await syncService.close()
  }
})

test('queued offline writes converge after a network interruption', async ({ page: pc, context, browser }) => {
  test.setTimeout(120_000)
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  const syncService = await isolatedSyncService()
  const deckName = `Restart recovery ${Date.now()}`
  const errors: string[] = []
  for (const page of [pc, phone]) page.on('pageerror', (error) => errors.push(error.message))
  try {
    await pc.goto(webURL)
    await phone.goto(webURL)
    await pc.getByRole('button', { name: 'New deck', exact: true }).click()
    await pc.getByLabel('Deck name').fill(deckName)
    await pc.getByRole('button', { name: 'Create deck', exact: true }).click()
    await pc.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()
    await addNote(pc, '猫', 'cat')
    await pair(pc, syncService.url, syncService.runtime)
    await pair(phone, syncService.url, syncService.runtime)
    await sync(pc)
    await sync(phone)
    await phone.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()

    let networkAvailable = true
    await context.route(`${syncService.url}/api/**`, (route) => networkAvailable ? route.continue() : route.abort('failed'))
    await phoneContext.route(`${syncService.url}/api/**`, (route) => networkAvailable ? route.continue() : route.abort('failed'))
    networkAvailable = false
    await addNote(pc, '鳥', 'bird')
    await addNote(phone, '魚', 'fish')
    for (const page of [pc, phone]) {
      const region = page.getByRole('region', { name: 'PC sync', exact: true })
      await region.getByRole('button', { name: 'Sync now', exact: true }).click()
      await expect(region).toContainText(/could not be reached|retry/i)
    }
    await expect(pc.getByTestId('note-front').filter({ hasText: '鳥' })).toBeVisible()
    await expect(phone.getByTestId('note-front').filter({ hasText: '魚' })).toBeVisible()

    networkAvailable = true
    await sync(pc)
    await sync(phone)
    await sync(pc)
    for (const [page, fronts] of [[pc, ['猫', '鳥', '魚']], [phone, ['猫', '鳥', '魚']]] as const) {
      for (const front of fronts) await expect(page.getByTestId('note-front').filter({ hasText: front })).toBeVisible()
    }
    expect(errors).toEqual([])
  } finally {
    await Promise.allSettled([context.setOffline(false), phoneContext.close()])
    await syncService.close()
  }
})

test('learner downloads and previews a verified PC backup that remains known after going offline', async ({ page, context }) => {
  test.setTimeout(120_000)
  const syncService = await isolatedSyncService()
  const deckName = `Backup Japanese ${test.info().project.name} ${Date.now()}`
  try {
    await page.goto(webURL)
    await page.getByRole('button', { name: 'New deck', exact: true }).click()
    await page.getByLabel('Deck name').fill(deckName)
    await page.getByRole('button', { name: 'Create deck', exact: true }).click()
    await page.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill('猫')
    await page.getByLabel('Back', { exact: true }).fill('cat')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await pair(page, syncService.url, syncService.runtime)
    await sync(page)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download PC backup', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^kiroku-backup-\d{4}-\d{2}-\d{2}\.zip$/)
    const archive = unzipSync(new Uint8Array(await readFile(await download.path())))
    expect(archive['collection.sqlite']).toBeDefined()
    expect(Object.keys(archive).some((name) => name.startsWith('media/'))).toBe(false)
    await expect(page.getByText(/Verified backup downloaded · \d+ sync changes · 0 media files/)).toBeVisible()
    const receipt = page.getByTestId('backup-receipt')
    await expect(receipt).toContainText(/Last PC backup received and verified on this device:/)
    await context.setOffline(true)
    await expect(receipt).toContainText(/Last PC backup received and verified on this device:/)
    await context.setOffline(false)
    await expect(page.getByText(/Latest backup currently listed by the PC:/)).toContainText(/manual/)

    await page.getByRole('button', { name: 'Preview latest backup', exact: true }).click()
    const preview = page.getByRole('status').filter({ hasText: /sync changes through cursor/ })
    await expect(preview).toContainText(/verified media files/)
    await expect(preview).toContainText(/new sync generation/)
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill('犬')
    await page.getByLabel('Back', { exact: true }).fill('dog')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await sync(page)
    await page.getByLabel('Type RESTORE to replace the active PC collection').fill('RESTORE')
    await page.getByRole('button', { name: 'Restore this PC collection', exact: true }).click()
    await expect(page.getByText(/PC collection restored from verified backup/)).toBeVisible()
    const region = page.getByRole('region', { name: 'PC sync', exact: true })
    await region.getByRole('button', { name: 'Sync now', exact: true }).click()
    await expect(region).toContainText(/replaced from a backup/)
    await expect(page.getByText('犬', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= screen.width + 1)).toBe(true)
  } finally { await syncService.close() }
})
