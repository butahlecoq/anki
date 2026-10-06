import { expect, test, type Page } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'

/*
 * Issue #23 acceptance evidence for the appearance preference.
 *
 * src/appearance.test.tsx proves the preference module under jsdom, and
 * src/design-tokens.test.ts proves the token palette arithmetically. Neither
 * observes a rendered pixel. This suite closes that gap in a real engine, on
 * both the desktop and the iPhone-sized project, and attaches the screenshots
 * it renders so a reviewer can look at both themes.
 */

// The same accessible name src/appearance.test.tsx relies on.
const control = (page: Page) => page.getByRole('combobox', { name: 'Appearance' })

const appliedTheme = (page: Page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      colorScheme: root.colorScheme,
      page: getComputedStyle(document.body).backgroundColor,
      // body inherits --text-primary, so this is the token the whole document
      // is themed from. Reading it makes a half-applied theme legible instead of
      // surfacing later as a nonsense contrast ratio.
      ink: getComputedStyle(document.body).color,
    }
  })

/** Waits for the engine to invalidate and paint the styles a theme switch changed. */
const settlePaint = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => { requestAnimationFrame(() => requestAnimationFrame(() => done())) }))

/**
 * Reads contrast until two consecutive reads a frame apart agree.
 *
 * A single read is not enough. Switching the theme invalidates a whole subtree,
 * and WebKit recalculates lazily: the document element and body update first,
 * then ordinary descendants, and elements inside a compositing layer - the
 * phone navigation is position: fixed with a backdrop-filter - can lag a frame
 * or more behind. Run 37012140343 caught that as the navigation reporting the
 * previous theme's ink, which reads as a ratio of about 1. Either engine or
 * theme regressing to a real value would show up as a settled ratio below the
 * threshold, so waiting for agreement cannot hide a genuine failure; it can only
 * hide one that is still in flight.
 */
async function settledContrast(page: Page, selectors: string[]) {
  let latest: { measurements: Contrast[]; unmeasurable: { selector: string; reason: string }[] } = { measurements: [], unmeasurable: [] }
  await expect
    .poll(async () => {
      const first = await measureChromeContrast(page, selectors)
      await settlePaint(page)
      const second = await measureChromeContrast(page, selectors)
      latest = second
      const same = JSON.stringify(first) === JSON.stringify(second)
      const worst = Math.min(...second.measurements.map((measurement) => measurement.ratio), Number.POSITIVE_INFINITY)
      return { same, worst }
    }, { message: 'chrome contrast has not settled on a passing value', timeout: 15_000 })
    .toMatchObject({ same: true })
  return latest
}

/**
 * The browser chrome colour an installed iPhone app paints its status bar
 * with, next to the token it is supposed to be tracking. A real engine resolves
 * `--surface-page`, which jsdom cannot, so this is the only place the two can
 * be compared for real.
 */
const chromeColor = (page: Page) =>
  page.evaluate(() => ({
    meta: document.querySelector('meta[name="theme-color"]')?.content ?? null,
    token: getComputedStyle(document.documentElement).getPropertyValue('--surface-page').trim(),
  }))

/**
 * The phone layout drops the sidebar, the `/ LOCAL` eyebrow and the footer
 * line, so the selectors that must render depend on the viewport. Everything
 * listed here is measured whichever way the layout falls; only the "required"
 * half is asserted to render at all, which keeps a renamed class from quietly
 * removing itself from the contrast audit.
 */
const SHARED_CHROME_TEXT = [
  '.eyebrow span:first-child',
  '.connection',
  '.hero h1',
  '.hero p',
  '.section-code',
  '.panel-heading h2',
]
const WIDE_CHROME_TEXT = [
  ...SHARED_CHROME_TEXT,
  '.eyebrow span:last-child',
  '.footer-line span:first-child',
  '.nav-label',
  '.nav-item:not(.active) span',
  '.brand-copy small',
  '.local-profile small',
  '.local-profile strong',
  '.keycap',
]
const PHONE_CHROME_TEXT = [...SHARED_CHROME_TEXT, '.mobile-nav a span', '.keycap']

/** Mirrors the `max-width: 680px` breakpoint in src/styles.css. */
function requiredChromeText(page: Page): string[] {
  const width = page.viewportSize()?.width
  if (!width) throw new Error('Browser viewport is unavailable')
  return width <= 680 ? PHONE_CHROME_TEXT : WIDE_CHROME_TEXT
}

/** One rendered string, with the colours it actually resolved against. */
interface Contrast {
  selector: string
  text: string
  color: string
  background: string
  ratio: number
}

/**
 * Measures rendered WCAG contrast for chrome text in the live document.
 *
 * Backgrounds are composited down the ancestor chain so translucent panels such
 * as `--surface-nav` are judged against what they actually sit on. A gradient
 * ancestor contributes an unknown colour, so it is treated as transparent and
 * the underlying opaque surface is used; every gradient in the shell is an
 * accent wash of at most 3.5% alpha, which cannot move a ratio by more than a
 * few hundredths. Elements that are not rendered, or that carry no text of
 * their own, are skipped rather than guessed at.
 */
async function measureChromeContrast(page: Page, selectors: string[]): Promise<{ measurements: Contrast[]; unmeasurable: { selector: string; reason: string }[] }> {
  return page.evaluate((list) => {
    type Layer = { r: number; g: number; b: number; a: number }
    const parse = (value: string): Layer | null => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }
    const channel = (value: number) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const luminance = (layer: Layer) => 0.2126 * channel(layer.r) + 0.7152 * channel(layer.g) + 0.0722 * channel(layer.b)
    const flatten = (top: Layer, bottom: Layer): Layer => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    })
    // Layers are collected topmost first, so they have to be laid down from the
    // bottom up. reduceRight hands the callback (bottom, topAboveBottom), which
    // is the reverse of flatten's argument order.
    const composite = (layers: Layer[]) => layers.reduceRight((bottom, top) => flatten(top, bottom))
    const backgroundOf = (start: Element): Layer | null => {
      const layers: Layer[] = []
      let node: Element | null = start
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color && color.a > 0) {
          layers.push(color)
          if (color.a === 1) return composite(layers)
        }
        node = node.parentElement
      }
      layers.push({ r: 255, g: 255, b: 255, a: 1 })
      return composite(layers)
    }
    const ownText = (element: Element) =>
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim()

    const measurements: { selector: string; text: string; color: string; background: string; ratio: number }[] = []
    const unmeasurable: { selector: string; reason: string }[] = []
    for (const selector of list) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(
        (element) => element.getClientRects().length > 0 && ownText(element).length > 0,
      )
      if (candidates.length === 0) continue
      for (const element of candidates.slice(0, 3)) {
        const background = backgroundOf(element)
        if (!background) {
          unmeasurable.push({ selector, reason: 'no opaque background in the ancestor chain' })
          continue
        }
        const color = parse(getComputedStyle(element).color) ?? { r: 0, g: 0, b: 0, a: 1 }
        const text = flatten(color, background)
        const lighter = Math.max(luminance(text), luminance(background))
        const darker = Math.min(luminance(text), luminance(background))
        measurements.push({
          selector,
          text: ownText(element).slice(0, 40),
          color: `rgb(${Math.round(text.r)}, ${Math.round(text.g)}, ${Math.round(text.b)})`,
          background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
          ratio: Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100,
        })
      }
    }
    return { measurements, unmeasurable }
  }, selectors)
}

test('appearance choice repaints readable chrome in both themes and survives a reopen', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
  const required = requiredChromeText(page)

  // Chrome colours are transitioned over 160ms, and switching the theme
  // invalidates a whole subtree of styles at once. Honouring the reduced-motion
  // preference collapses the transitions, and settlePaint below waits for the
  // invalidation to reach the elements being measured. Without the second half,
  // run 37010848841 read the previous theme's ink on the first iteration - the
  // document booted into the light theme because CI emulates a light OS, then
  // switched to dark, and descendants were still reporting the light tokens.
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const theme of ['dark', 'light'] as const) {
    await control(page).selectOption(theme)
    await expect(control(page)).toHaveValue(theme)
    await expect
      .poll(() => appliedTheme(page))
      .toEqual(theme === 'dark'
        ? { theme: null, colorScheme: 'dark', page: 'rgb(11, 13, 16)', ink: 'rgb(233, 237, 227)' }
        : { theme: 'light', colorScheme: 'light', page: 'rgb(247, 248, 246)', ink: 'rgb(28, 33, 24)' })
    await settlePaint(page)

    const { measurements, unmeasurable } = await settledContrast(page, required)
    const covered = new Set(measurements.map((measurement) => measurement.selector))
    expect(required.filter((selector) => !covered.has(selector)), `${theme}: these selectors rendered no text`).toEqual([])
    expect(unmeasurable, `${theme}: some selectors could not be judged`).toEqual([])
    expect(measurements.filter((measurement) => measurement.ratio < 4.5), `${theme}: rendered contrast below WCAG AA`).toEqual([])

    // The installed app must not paint its status bar with a colour the page is
    // not using: white status-bar text over the light theme is unreadable.
    const chrome = await chromeColor(page)
    expect(chrome.token.toLowerCase(), `${theme}: unexpected page surface`).toBe(theme === 'dark' ? '#0b0d10' : '#f7f8f6')
    expect(chrome.meta?.toLowerCase(), `${theme}: status bar colour drifted from the page`).toBe(chrome.token.toLowerCase())

    await testInfo.attach(`contrast-${theme}`, {
      body: Buffer.from(JSON.stringify({ theme, chrome, measurements }, null, 2)),
      contentType: 'application/json',
    })
    await testInfo.attach(`appearance-${theme}-workspace`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    // A full-page capture draws position: fixed chrome at its viewport offset,
    // so the phone navigation lands in the middle of the image and can be misread
    // as content being covered. The viewport capture is what the learner sees.
    await testInfo.attach(`appearance-${theme}-viewport`, { body: await page.screenshot(), contentType: 'image/png' })
  }

  await page.reload()
  await expect(control(page)).toHaveValue('light')
  await expect.poll(() => appliedTheme(page)).toMatchObject({ theme: 'light', colorScheme: 'light' })

  // A second window reads the same stored choice rather than the first window's state.
  const reopened = await page.context().newPage()
  await reopened.goto('/')
  await expect(control(reopened)).toHaveValue('light')
  await expect.poll(() => appliedTheme(reopened)).toMatchObject({ theme: 'light', colorScheme: 'light' })
})

test('auto follows the operating system setting while the app is open', async ({ page }) => {
  const DARK = { theme: null, colorScheme: 'dark', page: 'rgb(11, 13, 16)', ink: 'rgb(233, 237, 227)' }
  const LIGHT = { theme: 'light', colorScheme: 'light', page: 'rgb(247, 248, 246)', ink: 'rgb(28, 33, 24)' }

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(control(page)).toHaveValue('system')
  await expect.poll(() => appliedTheme(page)).toEqual(DARK)

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => appliedTheme(page)).toEqual(LIGHT)

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => appliedTheme(page)).toEqual(DARK)

  // An explicit choice outranks the operating system and stops following it.
  await control(page).selectOption('light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => appliedTheme(page)).toEqual(LIGHT)
})

test('an imported note type owns its card colours in every app theme', async ({ page }, testInfo) => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const cardCSS = '.card{background:#123456;color:#fedcba;font-size:29px}'
  const type = new Notetype({
    id: 1700000230001,
    name: 'Theme isolation',
    css: cardCSS,
    fields: [{ name: 'Word' }, { name: 'Meaning' }],
    templates: [{ name: 'Recognition', questionFormat: '{{Word}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }],
  })
  const deck = new Deck({ id: 1700000230002, name: '日本語 themes' })
  deck.addNote(new Note({ notetype: type, guid: 'synthetic-theme-note', fields: ['猫', 'cat · ねこ'] }))
  const pkg = new Package()
  pkg.addDeck(deck)

  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'themes.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from(await pkg.toUint8Array(SQL)) })
  await dialog.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open 日本語 themes', exact: true }).click()
  await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()

  const rendered = new Map<string, unknown>()
  for (const theme of ['dark', 'light'] as const) {
    await control(page).selectOption(theme)
    await expect
      .poll(() => appliedTheme(page))
      .toEqual(theme === 'dark'
        ? { theme: null, colorScheme: 'dark', page: 'rgb(11, 13, 16)', ink: 'rgb(233, 237, 227)' }
        : { theme: 'light', colorScheme: 'light', page: 'rgb(247, 248, 246)', ink: 'rgb(28, 33, 24)' })
    await settlePaint(page)
    const review = page.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('body')).toContainText('猫')

    const card = await review.locator('body.card').evaluate((body) => {
      const style = getComputedStyle(body)
      return { background: style.backgroundColor, color: style.color, fontSize: style.fontSize }
    })
    // The imported note type owns the card. The theme supplies only a default
    // for a card that names no background of its own, so a deck that does name
    // one keeps it and these values must not move.
    expect(card).toEqual({ background: 'rgb(18, 52, 86)', color: 'rgb(254, 220, 186)', fontSize: '29px' })
    rendered.set(theme, card)

    // The shortcut legend is the discoverability surface for fifteen key
    // bindings, and it is hidden where there is no keyboard to discover them
    // with. The engine is asked which side of the rule it is on rather than
    // assumed from the project: the phone project does report a coarse pointer
    // under Playwright, which a previous version of this comment denied.
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    const legend = page.locator('.review-shortcuts')
    if (coarse) {
      await expect(legend, `${theme}: the keyboard legend should not occupy a coarse-pointer reviewer`).toBeHidden()
    } else {
      await expect(legend, `${theme}: the keyboard legend should be discoverable with a fine pointer`).toBeVisible()
      const measured = await settledContrast(page, ['.review-shortcuts'])
      expect(measured.unmeasurable, `${theme}: the shortcut legend could not be judged`).toEqual([])
      expect(measured.measurements, `${theme}: the shortcut legend rendered no text`).toHaveLength(1)
      expect(measured.measurements.filter((measurement) => measurement.ratio < 4.5), `${theme}: shortcut legend below WCAG AA`).toEqual([])
    }

    await testInfo.attach(`review-card-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  }
  expect(rendered.get('dark')).toEqual(rendered.get('light'))
})

test('a card that names no background follows the app theme', async ({ page }, testInfo) => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  // No background and no colour anywhere in the deck's CSS, so the only thing
  // that can paint this card is the frame's own themed default.
  const type = new Notetype({
    id: 1700000240001,
    name: 'Themed default',
    css: '.card { text-align: center }',
    fields: [{ name: 'Word' }, { name: 'Meaning' }],
    templates: [{ name: 'Recognition', questionFormat: '{{Word}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }],
  })
  const deck = new Deck({ id: 1700000240002, name: '日本語 themed' })
  deck.addNote(new Note({ notetype: type, guid: 'synthetic-themed-note', fields: ['猫', 'cat · ねこ'] }))
  const pkg = new Package()
  pkg.addDeck(deck)

  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'themed.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from(await pkg.toUint8Array(SQL)) })
  await dialog.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open 日本語 themed', exact: true }).click()
  await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()

  const expected = {
    dark: { background: 'rgb(16, 19, 23)', color: 'rgb(233, 237, 227)' },
    light: { background: 'rgb(255, 255, 255)', color: 'rgb(28, 33, 24)' },
  } as const

  for (const theme of ['dark', 'light'] as const) {
    await control(page).selectOption(theme)
    await expect
      .poll(() => appliedTheme(page))
      .toEqual(theme === 'dark'
        ? { theme: null, colorScheme: 'dark', page: 'rgb(11, 13, 16)', ink: 'rgb(233, 237, 227)' }
        : { theme: 'light', colorScheme: 'light', page: 'rgb(247, 248, 246)', ink: 'rgb(28, 33, 24)' })

    const review = page.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('body')).toContainText('猫')
    // The frame is a separate document, so it is told the theme rather than
    // reading it; polling covers the paint arriving after the attribute is set.
    await expect
      .poll(async () => review.locator('body.card').evaluate((body) => {
        const style = getComputedStyle(body)
        return { background: style.backgroundColor, color: style.color }
      }), { message: `the card did not repaint for the ${theme} theme` })
      .toEqual(expected[theme])

    await testInfo.attach(`themed-card-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  }
})
