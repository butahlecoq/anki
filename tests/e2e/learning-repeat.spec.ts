import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'

const test = phoneCanvasTest({ width: 390, height: 844 })

test('Hard repeats a learning card as a fresh question and Easy completes the session', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name', { exact: true }).fill('Learning repetition')
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: 'Open Learning repetition', exact: true }).click()
  await page.getByRole('button', { name: 'Add note', exact: true }).click()
  await page.getByLabel('Front', { exact: true }).fill('猫')
  await page.getByLabel('Back', { exact: true }).fill('cat')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  const card = page.frameLocator('iframe[title="Review card"]')
  await expect(card.getByText('猫', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show answer', exact: true }).click()
  await expect(card.getByText('cat')).toBeVisible()
  await page.getByRole('button', { name: /^Hard · / }).click()
  await expect(page.getByRole('heading', { name: 'Session complete', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show answer', exact: true })).toBeVisible()
  await expect(card.getByText('cat')).toBeHidden()
  await page.getByRole('button', { name: 'Show answer', exact: true }).click()
  await page.getByRole('button', { name: /^Easy · / }).click()
  await expect(page.getByRole('heading', { name: 'Session complete', exact: true })).toBeVisible()
  await expect(page.getByText('2 reviews recorded', { exact: true })).toBeVisible()
})
