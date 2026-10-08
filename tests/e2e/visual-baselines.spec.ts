import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Collection, Deck, DeckConfig, Note, Notetype, Package } from 'ankipack'
import { unzipSync, zipSync } from 'fflate'
import { nativeCanvasTest } from './phone-canvas'
import { openCollectionTools } from './collection-tools'
import { verifyVisualEnvironment } from './visual-environment'

const test = nativeCanvasTest().extend({
  viewport: async ({ viewport, browserName, hostScale }, provide) => {
    await provide(browserName === 'webkit'
      ? { width: Math.round(390 * hostScale), height: Math.round(844 * hostScale) }
      : viewport)
  },
})
const deckName = '日本語 — Visual vocabulary'
const expression = '猫'
const fixedTime = new Date('2026-10-07T12:00:00Z')

test.use({ locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' })

async function vocabularyPackage() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({
    id: 1700000077001, name: 'Visual Japanese vocabulary',
    fields: [{ name: 'Expression' }, { name: 'Meaning' }],
    templates: [{ name: 'Recognition', questionFormat: '{{Expression}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }],
  })
  const deck = new Deck({
    id: 1700000077002, name: deckName,
    config: new DeckConfig({ id: 1700000077005, name: 'Visual vocabulary config' }),
  })
  deck.addNote(new Note({ notetype: type, guid: 'visual-baseline-cat', fields: [expression, 'cat · ねこ'], tags: ['visual'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  // The package builder runs in Node, outside page.clock's fixed browser time.
  // Normalize its clock-derived identities and timestamps through the public
  // document API so the imported fixture is independent of capture time.
  const data = await pkg.toCollection()
  expect(data.notes).toHaveLength(1)
  expect(data.cards).toHaveLength(1)
  const seconds = fixedTime.getTime() / 1000
  Object.assign(data.col, { crt: seconds, mod: fixedTime.getTime(), scm: fixedTime.getTime() })
  Object.assign(data.notes[0], { id: 1700000077003, mod: seconds })
  Object.assign(data.cards[0], { id: 1700000077004, nid: 1700000077003, mod: seconds })
  for (const rows of [data.decks, data.notetypes, data.templates, data.deckConfig, data.config]) {
    for (const row of rows) row.mtimeSecs = seconds
  }
  const bytes = await Collection.fromData(data).toUint8Array(SQL)
  return Buffer.from(zipSync(unzipSync(bytes), { level: 6, mtime: fixedTime }))
}

async function importVocabulary(page: Page) {
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package', exact: true })
  await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({
    name: 'visual-vocabulary.apkg', mimeType: 'application/octet-stream', buffer: await vocabularyPackage(),
  })
  await expect(dialog.getByRole('region', { name: 'Package summary' }).getByText('1 note', { exact: true })).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Import package', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: `Open ${deckName}`, exact: true })).toBeVisible()
}

async function settle(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    for (const frame of document.querySelectorAll('iframe')) await frame.contentDocument?.fonts.ready
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
  })
  const theme = await page.getByRole('combobox', { name: 'Appearance', exact: true }).inputValue()
  expect(['light', 'dark'], 'A baseline must use an explicit appearance.').toContain(theme)
  const colors = theme === 'light'
    ? { primary: 'rgb(28, 33, 24)', strong: 'rgb(16, 20, 14)', secondary: 'rgb(58, 68, 51)' }
    : { primary: 'rgb(233, 237, 227)', strong: 'rgb(241, 244, 236)', secondary: 'rgb(174, 181, 173)' }
  // WebKit can resolve root/body before descendants after a theme change.
  // Canonical theme ink checks are deliberately independent of the possibly
  // stale inherited body value, and run after each viewport scroll.
  await expect(page.locator('body')).toHaveCSS('color', colors.primary)
  // These exact fixtures have canonical heading/form ink. Broad action-button
  // classes can intentionally use danger/study/hover/disabled colors, so they
  // are checked by pixels rather than mistaken for unsettled theme state.
  const checks = [
    ['.hero h1, .compact-hero h1, .deck-detail-header h1', colors.strong],
    ['.empty-card h3, .panel-heading h2, .deck-tile > h2, .export-dialog > h2, .statistics-panel[aria-label="Study heatmap"] > h2, .statistics-panel:has(.studied-cards) > h2', colors.primary],
    ['.review-heatmap button[aria-pressed="false"] .heatmap-date', colors.primary],
    ['.appearance-control select', colors.secondary],
    ['.export-dialog select:not(:disabled), .statistics-controls select:not(:disabled), .statistics-controls input:not(:disabled), .browser-search input, .browser-controls select', colors.primary],
  ] as const
  for (const [selector, color] of checks) {
    for (const element of await page.locator(selector).all()) {
      if (await element.isVisible() && await element.evaluate(node => {
        const box = node.getBoundingClientRect()
        return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
      })) await expect(element).toHaveCSS('color', color, { timeout: 15_000 })
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'horizontal page overflow').toBeLessThanOrEqual(1)
  for (const dialog of await page.getByRole('dialog').all()) {
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth), 'horizontal dialog overflow').toBeLessThanOrEqual(1)
  }
}

async function capture(page: Page, info: TestInfo, name: string, panel?: Locator, hostScale = 1) {
  if (panel) await panel.scrollIntoViewIfNeeded()
  await settle(page)
  await info.attach(`${name}-geometry`, {
    body: JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY, fonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })),
      decoration: [...document.querySelectorAll('.hero, .kana-field, .orbit')].map(element => {
        const style = getComputedStyle(element)
        return { classes: element.className, rect: element.getBoundingClientRect().toJSON(), border: style.borderColor, opacity: style.opacity, transform: style.transform }
      }),
    }))), contentType: 'application/json',
  })
  const comparison = {
    threshold: 0, maxDiffPixels: 0, animations: 'disabled', caret: 'hide',
  } as const
  if (info.project.name === 'desktop-chromium') {
    // Fresh Chromium contexts can rasterize fractional borders differently
    // before and after captureBeyondViewport. The retained Windows/Linux
    // control produces identical viewport pixels after this standard capture.
    // Final comparisons still use the measured viewport or stable panel.
    await info.attach(`${name}-raster-preparation`, {
      body: await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' }),
      contentType: 'image/png',
    })
  }
  if (panel) {
    const box = await panel.boundingBox()
    expect(box, 'The stable panel must have a visible screenshot rectangle.').not.toBeNull()
    const canvas = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(canvas.height)
    // Windows WebKit clips in its host-scaled backing canvas, whereas the DOM
    // reports calibrated CSS coordinates. A synthetic colored-box control
    // verifies this conversion; ordinary locator crops omit stable content.
    const scale = process.platform === 'win32' && info.project.name === 'iphone-webkit' ? hostScale : 1
    await expect(page).toHaveScreenshot(`${name}.png`, {
      ...comparison, fullPage: false,
      clip: { x: box!.x * scale, y: box!.y * scale, width: box!.width * scale, height: box!.height * scale },
    })
    return
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    ...comparison,
    // Viewport images preserve the learner's fixed mobile navigation position.
    fullPage: false,
  })
}

test.beforeEach(async ({ page, browser, hostScale }, info) => {
  test.setTimeout(120_000)
  expect(['win32', 'linux'], 'Visual baselines are verified only on Windows and Linux; record and review a new platform before regenerating its images.').toContain(process.platform)
  await page.clock.setFixedTime(fixedTime)
  // ReviewSession reads this monotonic input for elapsed review time. Keep
  // timers and animation frames live while making the visible time total fixed.
  await page.addInitScript(() => Object.defineProperty(performance, 'now', { value: () => 0 }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your Japanese study system', exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({ wall: Date.now(), elapsed: performance.now() })), 'deterministic visual time inputs').toEqual({ wall: fixedTime.getTime(), elapsed: 0 })
  await expect(page.locator('.connection')).not.toContainText('Preparing offline shell')
  const canvas = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  const expected = info.project.name === 'iphone-webkit' ? { width: 390, height: 844 } : { width: 1280, height: 720 }
  expect({ width: canvas.width, height: canvas.height }, 'measured baseline canvas').toEqual(expected)
  await verifyVisualEnvironment(page, browser, hostScale, info)
})

for (const appearance of ['light', 'dark'] as const) {
  test.describe(`${appearance} @visual`, () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(appearance)
      await expect(page.locator('html')).toHaveCSS('color-scheme', appearance)
    })

    test('empty deck workspace', async ({ page }, info) => {
      await page.evaluate(() => scrollTo(0, 0))
      await capture(page, info, `empty-workspace-${appearance}`)
    })

    test('Browse with a selected note', async ({ page, hostScale }, info) => {
      await importVocabulary(page)
      await page.getByRole('link', { name: 'Browse', exact: true }).click()
      await page.getByLabel('Result view', { exact: true }).selectOption('notes')
      const selected = page.getByRole('checkbox', { name: /^Select note / })
      await expect(selected).toHaveCount(1)
      await selected.check()
      await expect(selected).toBeChecked()
      await expect(page.locator('tbody .browser-expression')).toContainText(expression)
      expect(await page.locator('.browser-table-scroll').evaluate(element => element.scrollWidth - element.clientWidth), 'Browse result overflow').toBeLessThanOrEqual(1)
      await page.evaluate(() => scrollTo(0, 0))
      await capture(page, info, `browse-${appearance}`)
      await selected.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }))
      await capture(page, info, `browse-selected-note-${appearance}`, page.locator('.browser-table-scroll'), hostScale)
    })

    test('populated Statistics', async ({ page, hostScale }, info) => {
      await importVocabulary(page)
      await page.getByRole('button', { name: `Open ${deckName}`, exact: true }).click()
      await page.getByRole('button', { name: 'Study now', exact: true }).click()
      await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText(expression)
      await page.getByRole('button', { name: 'Show answer', exact: true }).click()
      await page.getByRole('button', { name: /^Easy ·/ }).click()
      await expect(page.getByRole('heading', { name: 'Session complete', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Back to deck', exact: true }).click()
      await page.getByRole('link', { name: 'Statistics', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Period totals' })).toContainText('1 distinct cards')
      await expect(page.getByRole('region', { name: 'Period totals' })).toContainText('0.0 min')
      await page.evaluate(() => scrollTo(0, 0))
      await capture(page, info, `statistics-${appearance}`)
      const heatmap = page.getByRole('region', { name: 'Study heatmap', exact: true })
      const activeDay = heatmap.getByRole('button', { name: '2026-10-07: 1 answers', exact: true })
      await expect(activeDay).toBeAttached()
      await activeDay.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }))
      await heatmap.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }))
      await expect(activeDay).toBeInViewport()
      await capture(page, info, `statistics-heatmap-${appearance}`)
      const studied = page.getByRole('button', { name: `${expression} · Recognition`, exact: true })
      await expect(studied).toBeVisible()
      await studied.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }))
      // The changing build identifier in the app footer is outside this stable
      // panel. Capture the panel itself without masking or faking build data.
      const studiedPanel = page.getByRole('heading', { name: 'Cards studied in this period', exact: true }).locator('..')
      await capture(page, info, `statistics-studied-cards-${appearance}`, studiedPanel, hostScale)
    })

    test('export dialog', async ({ page }, info) => {
      await importVocabulary(page)
      await openCollectionTools(page)
      await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Export Anki package', exact: true })
      await dialog.getByLabel('Export scope').selectOption({ label: deckName })
      await expect(dialog.getByLabel('Include scheduling and card suspension')).toBeChecked()
      await expect(dialog.getByLabel('Include review history')).toBeChecked()
      await expect(dialog.getByLabel('Include images and audio')).toBeChecked()
      await expect(dialog.getByRole('button', { name: 'Download package', exact: true })).toBeEnabled()
      await capture(page, info, `export-dialog-${appearance}`)
    })
  })
}
