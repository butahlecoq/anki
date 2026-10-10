import { expect } from '@playwright/test'
import { nativeCanvasTest } from './phone-canvas'
const test = nativeCanvasTest({ width: 390, height: 844 })
test('graduated deck can practice again twice with a clear unchanged schedule mode', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'Show answer', exact: true }).click()
    await page.getByRole('button', { name: /^Easy ·/ }).click()
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to deck' }).click()
  await expect(page.getByRole('button', { name: 'Study now', exact: true })).toBeDisabled()
  for (let pass = 0; pass < 2; pass++) {
    await page.getByRole('button', { name: 'Practice again', exact: true }).click()
    await expect(page.getByText(/Practice: original schedule stays unchanged/)).toBeVisible()
    for (let index = 0; index < 2; index++) {
      await expect(page.frameLocator('iframe[title="Review card"]').locator('ruby')).toContainText(/猫|犬/)
      await page.getByRole('button', { name: 'Show answer', exact: true }).click()
      await page.getByRole('button', { name: /^Good ·/ }).click()
    }
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to custom study' }).click()
    await page.getByRole('link', { name: 'Decks', exact: true }).click()
    await page.getByRole('button', { name: 'Open Sample — Japanese Starter', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Study now', exact: true })).toBeDisabled()
  }
})
