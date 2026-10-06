import { expect, test, type Page } from '@playwright/test'

async function createPairDeck(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: `Open ${name}` }).click()
  for (const [front, back] of [['猫', 'cat'], ['犬', 'dog']]) {
    await page.getByRole('button', { name: 'Add note' }).click()
    await page.getByLabel('Front', { exact: true }).fill(front)
    await page.getByLabel('Back', { exact: true }).fill(back)
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
  }
}

test('matching reports compatible cards, separates match feedback from grades, and reviews each card once', async ({ page, context }) => {
  await createPairDeck(page, 'Matching practice')

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await expect(page.getByText('2 compatible pairs · 0 excluded')).toBeVisible()
  await page.getByRole('button', { name: 'Start matching' }).click()

  await page.getByRole('button', { name: 'Choose prompt 1' }).click()
  await page.getByRole('button', { name: 'Choose answer 2' }).click()
  await expect(page.getByText('That answer does not match. Try another answer.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Again ·/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Choose answer 1' }).click()
  await expect(page.getByText(/Correct match for Prompt 1/)).toBeVisible()
  await page.getByRole('button', { name: /^Good / }).click()
  await expect(page.getByText('1 pairs remaining. Select a prompt, then its answer.')).toBeVisible()

  await page.getByRole('button', { name: 'Choose prompt 1' }).click()
  await page.getByRole('button', { name: 'Choose answer 1' }).click()
  await expect(page.getByText(/Correct match for Prompt 1/)).toBeVisible()
  await page.getByRole('button', { name: /^Easy / }).click()
  await expect(page.getByRole('heading', { name: 'Matching complete' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo last review' }).click()
  await expect(page.getByText('1 compatible pair · 0 excluded')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start matching' })).toBeDisabled()
})

test('matching uses the ordered custom-study session and preserves practice scheduling offline', async ({ page, context }) => {
  await createPairDeck(page, 'Custom matching')
  await context.setOffline(true)
  await page.getByRole('link', { name: 'Study', exact: true }).click()
  await page.getByLabel('Session name', { exact: true }).fill('Matching session')
  await page.getByLabel('Session search', { exact: true }).fill('deck:*')
  await page.getByRole('button', { name: 'Preview session' }).click()
  await expect(page.getByRole('heading', { name: '2 cards selected from 2 matches' })).toBeVisible()
  await page.getByRole('button', { name: 'Create session' }).click()
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await expect(page.getByText('2 compatible pairs · 0 excluded')).toBeVisible()
  await page.getByRole('button', { name: 'Start matching' }).click()

  for (const [answer, gradeName] of [['1', 'Good'], ['1', 'Easy']]) {
    await page.getByRole('button', { name: 'Choose prompt 1' }).click()
    await page.getByRole('button', { name: `Choose answer ${answer}` }).click()
    await page.getByRole('button', { name: new RegExp(`^${gradeName} · No schedule change$`) }).click()
  }
  await expect(page.getByRole('heading', { name: 'Matching complete' })).toBeVisible()
  await expect(page.getByText(/Matching session · Practice: original schedule stays unchanged/)).toBeVisible()
})
