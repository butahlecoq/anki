import { expect, type Page, type TestInfo } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Collection as AnkiCollection } from 'ankipack'
import { createHash } from 'node:crypto'

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Compare stable supported package content, retaining native and kiroku schedules. */
export async function releaseInventory(bytes: Buffer) {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const data = AnkiCollection.open(bytes, SQL).data
  const stableRows = (values: unknown[]) => values.map(value => Object.fromEntries(
    // Native transport revision stamps are freshly generated at every export.
    // Actual supported note timestamps and review metadata remain in row.data.
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'mod' && key !== 'usn' && key !== 'mtimeSecs'),
  )).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const notes = data.notes.map(note => {
    const metadata = JSON.parse(note.data || '{}')
    // Reference order is not semantic; all properties and original display names stay.
    metadata.kirokuMedia?.sort((a: { name: string; displayName: string }, b: { name: string; displayName: string }) => `${a.name}:${a.displayName}`.localeCompare(`${b.name}:${b.displayName}`))
    return { ...note, data: JSON.stringify(metadata) }
  })
  return {
    // Exchange supports Deck Path and Native Identity. Deck options/description
    // are not emitted by this exporter; fresh ankipack defaults are not local data.
    decks: stableRows(data.decks.map(({ id, name }) => ({ id, name }))),
    notes: stableRows(notes), types: stableRows(data.notetypes), fields: stableRows(data.fields),
    templates: stableRows(data.templates), cards: stableRows(data.cards), reviews: stableRows(data.revlog),
    media: data.media.map(file => ({ name: file.name, digest: sha256(file.data) })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function releaseDiagnostics(serviceURL: string) {
  let phase = 'setup'
  let offline = false
  const events: Array<{ phase: string; kind: string; detail: string; expected: boolean }> = []
  const observed = new WeakSet<Page>()
  const record = (kind: string, detail: string, expected = false) => events.push({ phase, kind, detail, expected })
  return {
    phase(name: string, isOffline = false) { phase = name; offline = isOffline },
    observe(page: Page) {
      if (observed.has(page)) return
      observed.add(page)
      page.on('pageerror', error => record('uncaught', error.message))
      page.on('console', message => {
        if (message.type() !== 'error') return
        const location = message.location().url
        record('console-error', `${message.text()} (${location})`, offline && location.startsWith(serviceURL))
      })
      page.on('requestfailed', request => record('request-failed', `${request.method()} ${request.url()} ${request.failure()?.errorText}`, offline && request.url().startsWith(`${serviceURL}/`)))
      page.on('response', response => {
        if (response.status() >= 400) record('http-error', `${response.status()} ${response.url()}`)
      })
    },
    assertClean() { expect(events.filter(event => !event.expected), `diagnostics in ${phase}`).toEqual([]) },
    async attach(info: TestInfo) { await info.attach('release-diagnostics', { body: JSON.stringify(events, null, 2), contentType: 'application/json' }) },
  }
}

export async function releaseLayout(page: Page) {
  await expect(page.locator('main')).toBeVisible()
  await expect(page.locator('main')).not.toHaveText(/^\s*(?:Loading[\s\S]*|)\s*$/i)
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.getBoundingClientRect().width }))
  expect(geometry.scrollWidth, 'unexpected document overflow').toBeLessThanOrEqual(Math.ceil(geometry.rootWidth))
  // Role/label locators in the journey verify each required control; additionally
  // reject unnamed visible actions in every settled phase.
  const unnamed = await page.locator('button, input, select, textarea').evaluateAll(elements => elements.filter(element => {
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) return false
    if (element.matches('input[type="hidden"], input[type="file"]')) return false
    const labels = (element as HTMLInputElement).labels
    return !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !element.getAttribute('title') && !element.textContent?.trim() && !labels?.length
  }).map(element => element.outerHTML))
  expect(unnamed, 'visible controls need accessible names').toEqual([])
  return geometry
}

export async function releaseMedia(page: Page, browserName: string) {
  const review = page.frameLocator('iframe[title="Review card"]')
  await expect(review.locator('body')).toContainText(/猫|犬|鳥/)
  const image = review.getByRole('img', { name: 'release.png' })
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  const audio = review.locator('audio')
  await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
  if (browserName === 'chromium') await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= 1 && !element.error)).toBe(true)
  // WebKit on Windows lacks a media backend. A source is evidence of retained
  // bytes only; neither metadata nor audible physical playback is inferred.
}
