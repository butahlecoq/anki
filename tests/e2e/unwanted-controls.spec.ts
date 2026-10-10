import { expect } from '@playwright/test'
import { nativeCanvasTest } from './phone-canvas'
import { openCollectionTools } from './collection-tools'

const test = nativeCanvasTest({ width: 390, height: 844 })

test('collection and review omit removed tools while package transfer remains available', async ({ page }) => {
  await page.goto('/')
  await openCollectionTools(page)
  await expect(page.getByRole('button', { name: 'Rotate device key' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import / export text' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect a PC' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export Anki package' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import Anki package' })).toBeVisible()
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await page.getByText('More actions', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Import / export text' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export Anki package' })).toBeVisible()
})
