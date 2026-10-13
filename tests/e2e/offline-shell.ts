import { expect, type Page } from '@playwright/test'

/** Wait for the cached app shell without relying on a healthy-state badge. */
export async function expectOfflineShellReady(page: Page) {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable')
    await navigator.serviceWorker.ready
  })
  await expect(page.getByTestId('offline-shell-warning')).toHaveCount(0)
  await expect(page.locator('.connection')).toHaveCount(0)
}

/** Successful offline use stays quiet in the header; failures remain announced. */
export async function expectNoOfflineStatus(page: Page) {
  await expect(page.locator('.connection')).toHaveCount(0)
}
