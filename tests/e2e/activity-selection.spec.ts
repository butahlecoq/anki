import { expect, test } from '@playwright/test'

test('a selected built-in activity is kept in normal and custom study routes', async ({ page }) => {
  await page.goto('/#activity/deck/deck%2Fone')
  await expect(page.getByRole('heading', { name: 'Choose how to study' })).toBeVisible()
  await page.getByRole('button', { name: 'Start Review cards', exact: true }).click()
  await expect(page).toHaveURL(/#review\/deck%2Fone\/review$/)

  await page.goto('/#activity/deck/deck%2Fone')
  await page.getByRole('button', { name: 'Start Match cards', exact: true }).click()
  await expect(page).toHaveURL(/#review\/deck%2Fone\/matching$/)

  await page.goto('/#activity/session/session%2Fone')
  await expect(page.getByRole('heading', { name: 'Choose how to study' })).toBeVisible()
  await page.getByRole('button', { name: 'Start Review cards', exact: true }).click()
  await expect(page).toHaveURL(/#custom-review\/session%2Fone\/review$/)
})
