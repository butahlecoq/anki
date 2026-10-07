import { openCollectionTools } from './collection-tools'
import { expect, test } from '@playwright/test'

test('learner can inspect offline storage protection and local completeness', async ({ page }) => {
  await page.goto('/')
  await openCollectionTools(page)
  await page.getByTestId('offline-storage-summary').click()
  await expect(page.getByText(/Persistent storage is enabled|The browser may clear this app’s local data|cannot protect local storage/)).toBeVisible()
  await expect(page.getByText(/notes · .* cards · .* media files/)).toBeVisible()
  await expect(page.getByTestId('backup-receipt')).toContainText('No PC backup has been received and verified on this device yet.')
})

test('learner can prepare a deck and review its saved card offline', async ({ context, page }) => {
  const deckName = `Offline deck ${Date.now()}`
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill(deckName)
  await page.getByRole('button', { name: 'Create deck' }).click()
  await page.getByRole('button', { name: `Open ${deckName}` }).click()
  await expect(page.getByRole('heading', { name: deckName })).toBeVisible()
  await page.getByRole('button', { name: 'Add note' }).click()
  const noteDialog = page.getByRole('dialog', { name: 'Add a Basic note' })
  await noteDialog.getByLabel('Front').fill('準備')
  await noteDialog.getByLabel('Back').fill('ready')
  await noteDialog.getByRole('button', { name: 'Save note' }).click()
  await page.getByRole('button', { name: 'Prepare this deck for offline use' }).click()
  await expect(page.getByText(/This deck is ready for offline review/)).toBeVisible()
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText('準備')
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText('ready')
})
