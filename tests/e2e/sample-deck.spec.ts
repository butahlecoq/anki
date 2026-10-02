import { expect, test } from '@playwright/test'

test('load, review, and remove the Japanese sample deck without changing other decks', async ({ page, browserName }) => {
  await page.goto('/')
  if (browserName === 'chromium') {
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  }
  await expect(page.getByRole('button', { name: 'Load sample deck' })).toBeVisible()
  await page.getByRole('button', { name: 'Load sample deck' }).click()

  const sampleTile = page.getByRole('treeitem').filter({ hasText: 'Sample — Japanese Starter' })
  await expect(sampleTile).toContainText('SAMPLE DECK')
  if (browserName === 'chromium') await page.context().setOffline(true)
  await sampleTile.getByRole('button', { name: 'Open Sample — Japanese Starter' }).click()
  await expect(page.getByText('A small sample collection for trying Japanese review.')).toBeVisible()
  if (browserName === 'webkit') await page.context().setOffline(true)
  await page.getByRole('button', { name: 'Study now' }).click()

  let sawFurigana = false
  let sawCloze = false
  let sawAudio = false
  let sawImage = false
  for (let card = 0; card < 2; card++) {
    const review = page.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('body')).toBeVisible()
    if (await review.locator('ruby').count()) {
      sawFurigana = true
      await expect(review.locator('ruby')).toContainText(/ねこ|いぬ/)
    }
    if (await review.getByText('[…]', { exact: true }).count()) sawCloze = true

    const audio = page.locator('.review-card audio')
    if (await audio.count()) {
      sawAudio = true
      await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      if (browserName === 'chromium') await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
    }
    const image = page.locator('.review-card img.card-image')
    if (await image.count()) {
      sawImage = true
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    }

    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(review.locator('body')).toContainText(/The cat eats fish\.|The dog plays in the garden\./)
    await page.getByRole('button', { name: /^Good · / }).click()
  }

  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  expect(sawFurigana).toBe(true)
  expect(sawCloze).toBe(true)
  expect(sawAudio).toBe(true)
  expect(sawImage).toBe(true)

  await page.getByRole('button', { name: 'Back to deck' }).click()
  await page.getByRole('button', { name: 'All decks' }).click()
  await page.getByRole('button', { name: 'New deck' }).click()
  await page.getByLabel('Deck name').fill('My notes')
  await page.getByRole('button', { name: 'Create deck' }).click()
  await page.getByRole('button', { name: 'Open Sample — Japanese Starter' }).click()
  await page.getByRole('button', { name: 'Remove sample deck' }).click()
  const removal = page.getByRole('dialog', { name: 'Remove sample deck?' })
  await expect(removal).toContainText('Your other decks stay as they are.')
  await removal.getByRole('button', { name: 'Remove sample deck' }).click()
  await expect(page.getByRole('treeitem')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Open My notes' })).toBeVisible()
  await expect(page.getByText('Sample — Japanese Starter')).toHaveCount(0)
})
