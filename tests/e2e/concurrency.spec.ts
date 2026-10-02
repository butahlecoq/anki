import { expect, test, type Page } from '@playwright/test'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

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
  await page.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect(page.getByRole('region', { name: 'PC sync', exact: true })).toContainText('Sync complete.', { timeout: 20_000 })
}

async function edit(page: Page, front: string, back: string) {
  await page.getByRole('button', { name: 'Edit note', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Basic note', exact: true })
  await dialog.getByRole('textbox').nth(0).fill(front)
  await dialog.getByRole('textbox').nth(1).fill(back)
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.note-row strong')).toHaveText(front)
}

test('independent offline clients merge fields, retain conflicts through reload, and converge after an offline choice', async ({ page: pc, context, browser }) => {
  test.setTimeout(120_000)
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  const syncService = await isolatedSyncService()
  const deckName = `Concurrent Japanese ${test.info().project.name} ${Date.now()}`
  const errors: string[] = []
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
    await phone.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()
    await context.setOffline(true); await phoneContext.setOffline(true)
    await edit(pc, 'ねこ', 'cat'); await edit(phone, '猫', 'кот')
    await context.setOffline(false); await phoneContext.setOffline(false)
    await sync(pc); await sync(phone); await sync(pc)
    for (const page of [pc, phone]) {
      await expect(page.locator('.note-row strong')).toHaveText('ねこ')
      await expect(page.locator('.note-row p')).toHaveText('кот')
      await expect(page.getByRole('region', { name: 'Sync conflicts' })).toHaveCount(0)
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
    await expect.poll(() => phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await phone.screenshot({ path: test.info().outputPath('offline-conflict-choice.png'), fullPage: true })
    await phoneContext.setOffline(true)
    await dialog.locator('fieldset').filter({ hasText: 'ネコ home' }).getByRole('radio').check()
    await dialog.getByRole('button', { name: 'Save choice', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // Choosing the conflicting front must preserve the independently merged back.
    await expect(phone.locator('.note-row strong')).toHaveText('ネコ home')
    await expect(phone.locator('.note-row p')).toHaveText('кот · feline')
    await phoneContext.setOffline(false)
    await phone.reload()
    await expect(phone.locator('.note-row strong')).toHaveText('ネコ home')
    await sync(phone); await sync(pc); await sync(phone)
    for (const page of [pc, phone]) {
      await expect(page.locator('.note-row strong')).toHaveText('ネコ home')
      await expect(page.locator('.note-row p')).toHaveText('кот · feline')
      await expect(page.getByRole('region', { name: 'Sync conflicts' })).toHaveCount(0)
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
      await studiedCards.getByRole('button').click()
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
