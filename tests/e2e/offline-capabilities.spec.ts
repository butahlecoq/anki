import { expect, test } from '@playwright/test'

test('explains why cold offline review is unavailable when Service Workers are absent', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined })
  })
  await page.goto('/')

  const warning = page.getByTestId('offline-shell-warning')
  await expect(warning).toContainText('Offline review after closing or restarting needs the installed Home Screen app')
  await expect(warning).toContainText('iOS Lockdown Mode can disable it')
  await expect(page.getByRole('status')).toContainText('Offline cache unavailable')
})
