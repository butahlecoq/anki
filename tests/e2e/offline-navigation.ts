import { expect, type Page } from '@playwright/test'

export const WEBKIT_COLD_OFFLINE_LIMITATION = 'Playwright supports service workers only in Chromium; installed Safari cold offline reopening requires physical iPhone verification. https://playwright.dev/docs/service-workers'

/** A failed navigation must never let assertions inspect the previous document. */
export async function navigateOfflineDocument(page: Page, url = page.url()) {
  await page.evaluate(() => { Reflect.set(window, 'kirokuPreviousDocument', true) })
  // A real reload requires a fresh main document even when the URL includes a hash.
  const response = await page.reload({ waitUntil: 'domcontentloaded' })
  expect(response, 'offline navigation must return a document response').not.toBeNull()
  expect(response!.ok(), 'offline document response must be successful').toBe(true)
  expect(response!.fromServiceWorker(), 'offline document must be served by the installed service worker').toBe(true)
  await expect.poll(() => page.evaluate(() => Reflect.has(window, 'kirokuPreviousDocument'))).toBe(false)
  await expect(page).toHaveURL(url)
}

/** A restarted profile starts at about:blank, so it cannot retain the app DOM. */
export async function openOfflineProfileDocument(page: Page, url: string) {
  await expect(page).toHaveURL('about:blank')
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  expect(response, 'offline profile navigation must return a document response').not.toBeNull()
  expect(response!.ok(), 'offline profile document response must be successful').toBe(true)
  expect(response!.fromServiceWorker(), 'offline profile document must come from its persisted service worker').toBe(true)
  await expect(page).toHaveURL(url)
}
