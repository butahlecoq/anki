import { expect, test } from '@playwright/test'

test('learner can inspect offline storage protection and local completeness', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('offline-storage-summary').click()
  await expect(page.getByText(/Persistent storage is enabled|The browser may clear this app’s local data|cannot protect local storage/)).toBeVisible()
  await expect(page.getByText(/notes · .* cards · .* media files/)).toBeVisible()
})
