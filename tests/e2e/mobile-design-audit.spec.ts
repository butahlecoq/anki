import { expect, test as base } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

// The Windows WebKit embedder applies host display scaling to its viewport.
// This audit uses touch and the Safari UA, with desktop viewport interpretation
// on that host so a compensated viewport produces an actual 390 × 844 canvas.
// Normal iPhone emulation remains covered by the other browser tests.
const test = base.extend<{ hostScale: number }>({
  hasTouch: true,
  hostScale: async ({ browser, browserName }, provide) => {
    if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
    const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
    let scale = 1
    try {
      const page = await probe.newPage()
      scale = await page.evaluate(() => 1000 / innerWidth)
    } finally { await probe.close() }
    await provide(scale)
  },
  viewport: async ({ hostScale }, provide) => provide({ width: Math.round(390 * hostScale), height: Math.round(844 * hostScale) }),
  isMobile: async ({ browserName }, provide) => provide(!(browserName === 'webkit' && process.platform === 'win32')),
  deviceScaleFactor: async ({ hostScale }, provide) => provide(3 / hostScale),
})

test('Study controls and preview avoid horizontal overflow on small screens', async ({ page, hostScale }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Study', exact: true }).click()
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    const scheduling = page.getByRole('combobox', { name: 'Review scheduling', exact: true })
    for (const mode of ['practice', 'reschedule']) {
      await scheduling.selectOption(mode)
      await expect(scheduling).toHaveValue(mode)
      const geometry = await page.evaluate(() => ({ root: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }))
      await page.screenshot({ path: testInfo.outputPath(`study-${width}-${mode}.png`) })
      expect(geometry.scroll).toBeLessThanOrEqual(Math.ceil(geometry.root))
    }
    await page.getByLabel('Session name', { exact: true }).fill('Small screen practice')
    await page.getByLabel('Session search', { exact: true }).fill('deck:*')
    await page.getByRole('button', { name: 'Preview session', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Create session', exact: true })).toBeEnabled()
    const geometry = await page.evaluate(() => ({ root: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }))
    expect(geometry.scroll).toBeLessThanOrEqual(Math.ceil(geometry.root))
  }
})

test('audit every route and its main dialogs on an iPhone sized screen', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const observations: unknown[] = []
  async function capture(name: string) {
    console.log(`Capturing ${name}`)
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 10_000 })
    for (const frame of await page.locator('iframe').all()) {
      await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => element.contentDocument?.readyState)).toBe('complete')
      await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument?.fonts.ready.then(() => undefined))
    }
    await page.evaluate(async () => {
      for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame)
    })
    observations.push({ name, configuredViewport: page.viewportSize(), ...await page.evaluate(() => {
      const root = document.documentElement.getBoundingClientRect()
      const controls = [...document.querySelectorAll<HTMLElement>('button, a, summary, select, input, textarea')]
        .filter(element => element.getClientRects().length && !element.closest('.sidebar, .visually-hidden'))
        .map(element => {
          const box = element.getBoundingClientRect()
          return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || element.getAttribute('type'), x: box.x, y: box.y, width: box.width, height: box.height }
        })
      return { actualViewport: { innerWidth, innerHeight, devicePixelRatio, visualWidth: visualViewport?.width, visualHeight: visualViewport?.height }, rootWidth: root.width, scrollWidth: document.documentElement.scrollWidth, controls }
    }) })
    await writeFile(testInfo.outputPath('mobile-design-observations.json'), JSON.stringify(observations, null, 2))
    const documentWidth = await page.evaluate(() => ({ root: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }))
    expect(documentWidth.scroll, `${name} has no page-level horizontal overflow`).toBeLessThanOrEqual(Math.ceil(documentWidth.root))
    console.log(`Measured ${name}; taking screenshot`)
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled', timeout: 10_000 })
    if (/^08-|^10-|^21-|^26-/.test(name)) {
      // The Windows WebKit fullPage capture crops the right side under display
      // scaling. Capture ordinary viewports at overlapping scroll positions.
      const originalScroll = await page.evaluate(() => scrollY)
      const maximumScroll = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight))
      const step = Math.floor((await page.evaluate(() => innerHeight)) * .75)
      let segment = 0
      for (let y = 0; y <= maximumScroll; y = Math.min(y + step, maximumScroll)) {
        await page.evaluate(async position => {
          scrollTo(0, position)
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
        }, y)
        await page.screenshot({ path: testInfo.outputPath(`${name}-scroll-${segment++}.png`), animations: 'disabled', timeout: 10_000 })
        if (y === maximumScroll) break
      }
      await page.evaluate(position => scrollTo(0, position), originalScroll)
    }
  }
  async function dialog(button: string, name: string) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    if (button === 'Add note') await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Front', exact: true })).toBeVisible()
    await capture(name)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  }
  async function destination(name: string) {
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name, exact: true }).click()
  }
  await page.goto('/')
  expect(await page.evaluate(() => innerWidth)).toBe(390)
  expect(await page.evaluate(() => innerHeight)).toBe(844)
  await expect(page.getByRole('button', { name: 'Load sample deck' })).toBeVisible()
  await capture('01-empty-collection')
  await dialog('Import Anki package', '02-package-picker')
  await dialog('Connect a PC', '03-pairing')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await expect(page.getByRole('treeitem')).toContainText('02 NOTES')
  await capture('04-collection')
  await dialog('New deck', '05-new-deck')
  await dialog('Export Anki package', '06-export')
  await dialog('Import / export text', '07-text-transfer')
  for (const name of ['Note types', 'Study', 'Browse', 'Statistics']) {
    await destination(name)
    await expect(page.locator('main h1')).toBeVisible()
    await capture(`08-${name.toLowerCase().replaceAll(' ', '-')}`)
  }
  await destination('Note types')
  await dialog('Create note type', '09-new-note-type')
  await destination('Decks')
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sample — Japanese Starter', exact: true })).toBeVisible()
  await capture('10-deck-detail')
  for (const [button, name] of [
    ['Add note', '11-add-note'], ['Create child deck', '12-child-deck'], ['Move deck', '13-move-deck'],
    ['Scheduling options', '14-options'], ['Rename deck', '15-rename'], ['Remove sample deck', '16-delete-deck'],
  ]) await dialog(button, name)
  await page.getByRole('button', { name: 'Edit note', exact: true }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Context', exact: true })).toBeVisible()
  await capture('17-edit-note')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Manage cards', exact: true }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await capture('18-manage-cards')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose how to study' })).toBeVisible()
  await capture('19-activity-selection')
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start matching' })).toBeVisible()
  await capture('20-matching-setup')
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await destination('Decks')
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name', { exact: true }).fill('Audit matching')
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: 'Open Audit matching', exact: true }).click()
  for (const [front, back] of [['猫', 'cat'], ['犬', 'dog']]) {
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill(front)
    await page.getByLabel('Back', { exact: true }).fill(back)
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await page.getByRole('button', { name: 'Start matching' }).click()
  await expect(page.getByRole('button', { name: 'Choose prompt 1' })).toBeVisible()
  await capture('21-matching')
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await destination('Decks')
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await capture('22-review-front')
  await page.getByText('More actions', { exact: true }).click()
  await capture('23-review-menu')
  await page.getByRole('button', { name: 'Card info', exact: true }).click()
  await capture('24-card-info')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText(/The cat eats fish|The dog plays in the garden/)
  await capture('25-review-answer')
  await page.getByRole('button', { name: /^Easy ·/ }).click()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await page.getByRole('button', { name: /^Easy ·/ }).click()
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await capture('26-completion')
  await destination('Study')
  await page.getByLabel('Session name', { exact: true }).fill('Mobile design practice')
  await page.getByLabel('Session search', { exact: true }).fill('deck:*')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create session', exact: true })).toBeEnabled()
  await capture('27-custom-study-preview')
  await page.getByRole('button', { name: 'Create session', exact: true }).click()
  await page.getByRole('button', { name: 'Study Mobile design practice', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await capture('28-custom-review')
  await destination('Decks')
  const runtime = testInfo.config.metadata.syncRuntimeDirectory
  if (typeof runtime !== 'string') throw new Error('Missing isolated PC runtime')
  const code = execFileSync(process.execPath, ['dist-server/server/index.js', '--pairing-code'], { env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: runtime }, windowsHide: true, stdio: 'pipe' }).toString().trim()
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  await page.getByLabel('PC service address').fill(`http://127.0.0.1:${process.env.KIROKU_SYNC_PORT ?? '4174'}`)
  await page.getByLabel('One-time pairing code').fill(code)
  await page.getByRole('button', { name: 'Connect device', exact: true }).click()
  await expect(page.getByText('PC connected. Your collections are ready to sync.', { exact: true })).toBeVisible()
  await dialog('Connect AnkiWeb account', '29-ankiweb-account')
  await writeFile(testInfo.outputPath('mobile-design-observations.json'), JSON.stringify(observations, null, 2))
  expect(errors).toEqual([])
})
