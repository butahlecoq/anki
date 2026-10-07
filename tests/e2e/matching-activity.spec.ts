import { expect, test, type Page } from '@playwright/test'

async function createPairDeck(page: Page, name: string, noteTypeName?: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('button', { name: `Open ${name}` }).click()
  for (const [front, back] of [['猫', 'cat'], ['犬', 'dog']]) {
    await page.getByRole('button', { name: 'Add note' }).click()
    if (noteTypeName) await page.getByRole('combobox', { name: 'Note type' }).selectOption({ label: noteTypeName })
    await page.getByLabel('Front', { exact: true }).fill(front)
    await page.getByLabel('Back', { exact: true }).fill(back)
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
  }
}

test('matching uses the same reversible card color choice as review', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark')
  await page.getByRole('link', { name: 'Note types', exact: true }).click()
  await page.getByRole('button', { name: 'Create note type' }).click()
  await page.getByLabel('Note type name').fill('Colored pairs')
  await page.getByLabel('Field 1 name').fill('Front')
  await page.getByLabel('Field 2 name').fill('Back')
  await page.getByLabel('Template 1 front').fill('{{Front}}')
  await page.getByLabel('Template 1 back').fill('{{Back}}')
  await page.getByLabel('Template 1 CSS').fill('body { background: white; color: black; }')
  await page.getByRole('button', { name: 'Save note type' }).click()
  await expect(page.getByRole('heading', { name: 'Colored pairs', exact: true })).toBeVisible()
  await createPairDeck(page, 'Colored matching', 'Colored pairs')
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await page.getByRole('button', { name: 'Start matching' }).click()
  const prompt = page.frameLocator('iframe[title="Matching prompt 1"]').locator('body')
  await expect(prompt).toHaveCSS('background-color', 'rgb(16, 19, 23)')
  await page.getByText('More actions', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Card colors' }).selectOption('deck')
  await expect(prompt).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await page.getByRole('combobox', { name: 'Card colors' }).selectOption('app')
  await expect(prompt).toHaveCSS('background-color', 'rgb(16, 19, 23)')
  await page.keyboard.press('Escape')
})

test('matching reports compatible cards, separates match feedback from grades, and reviews each card once', async ({ page, context }) => {
  await createPairDeck(page, 'Matching practice')

  await context.setOffline(true)
  await page.getByRole('button', { name: 'Choose activity', exact: true }).click()
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await expect(page.getByText('2 compatible pairs · 0 excluded')).toBeVisible()
  await page.getByRole('button', { name: 'Start matching' }).click()
  if (test.info().project.use.hasTouch) {
    const scrolling = await page.locator('.review-session').evaluate(element => ({
      overflow: getComputedStyle(element).overflowY,
      needsScroll: element.scrollHeight > element.clientHeight,
    }))
    if (scrolling.needsScroll) expect(['auto', 'scroll']).toContain(scrolling.overflow)
  }

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
