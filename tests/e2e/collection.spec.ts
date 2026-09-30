import { expect, test } from '@playwright/test'

const REVIEW_TIME = new Date('2026-09-30T12:00:00.000Z')

async function createDeck(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New deck' }).click()
  await expect(page.getByRole('dialog', { name: 'Create a deck' })).toBeVisible()
  await page.getByLabel('Deck name').fill(name)
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(REVIEW_TIME)
  await page.goto('/')
})

test('learner creates, edits, and reviews a Japanese card offline', async ({ browserName, context, page }) => {
  await createDeck(page, 'Japanese Core')

  await page.getByRole('button', { name: 'Open Japanese Core' }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByRole('dialog', { name: 'Add a Basic note' })).toBeVisible()
  await page.getByLabel('Front').fill('猫')
  await page.getByLabel('Back').fill('ねこ · cat')
  await page.getByRole('button', { name: 'Save note' }).click()

  await expect(page.getByText('猫')).toBeVisible()
  await page.getByRole('button', { name: 'Edit note' }).click()
  await page.getByLabel('Back').fill('ねこ · cat · feline')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('ねこ · cat · feline')).toBeVisible()

  await page.getByRole('button', { name: 'Study now' }).click()
  await expect(page.getByRole('heading', { name: '猫' })).toBeVisible()
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.getByText('ねこ · cat · feline')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Again · / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Hard · / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Good · / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Easy · / })).toBeVisible()
  await page.getByRole('button', { name: /^Good · / }).click()

  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('1 review recorded')).toBeVisible()
  await page.getByRole('button', { name: 'Back to deck' }).click()
  await expect(page.getByText('NEW 0')).toBeVisible()
  await expect(page.getByText('LEARNING 1')).toBeVisible()
  await expect(page.getByText('REVIEWS 1')).toBeVisible()

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable')
    await navigator.serviceWorker.ready
  })
  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } catch (error) {
    if (browserName !== 'webkit' || !(error instanceof Error) || !error.message.includes('internal error')) throw error
  }

  await expect(page.getByRole('heading', { name: 'Japanese Core' })).toBeVisible()
  await expect(page.getByText('NEW 0')).toBeVisible()
  await expect(page.getByText('LEARNING 1')).toBeVisible()
  await expect(page.getByText('REVIEWS 1')).toBeVisible()
  await expect(page.getByText('Offline shell active')).toBeVisible()
})

test('learner renames and deletes a deck', async ({ page }) => {
  await createDeck(page, 'Draft deck')
  await page.getByRole('button', { name: 'Open Draft deck' }).click()

  await page.getByRole('button', { name: 'Rename deck' }).click()
  await page.getByLabel('Deck name').fill('JLPT N5')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { name: 'JLPT N5' })).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete deck' }).click()
  await expect(page.getByRole('heading', { name: 'Start with one deck' })).toBeVisible()
  await expect(page.getByText('JLPT N5')).not.toBeVisible()
})
