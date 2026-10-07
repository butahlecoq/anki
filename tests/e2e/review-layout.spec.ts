import { expect, test } from '@playwright/test'
import { expectFixedReview, reviewGeometry } from './review-geometry'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

test('card and answer area stay fixed through reveal and the next sample card', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  const tile = page.getByRole('treeitem').filter({ hasText: 'Sample — Japanese Starter' })
  await expect(tile).toContainText('02 NOTES')
  await tile.getByRole('button', { name: 'Open Sample — Japanese Starter' }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  const content = page.frameLocator('iframe[title="Review card"]')
  await expect(content.locator('ruby')).toContainText(/猫|犬/)
  const word = await content.locator('ruby').innerText()
  const front = await reviewGeometry(page)

  await page.getByRole('button', { name: 'Show answer', exact: true }).click()
  await expect(content.locator('body')).toContainText(/The cat eats fish|The dog plays in the garden/)
  const answer = await reviewGeometry(page)
  const textLayout = await content.locator('body').evaluate(body => ({
    scale: new DOMMatrix(getComputedStyle(body).transform).a,
  }))
  expect(textLayout.scale, 'ordinary sample text keeps its readable size').toBeGreaterThanOrEqual(.9)
  expectFixedReview(front, answer)
  const nav = await page.getByRole('navigation', { name: 'Mobile navigation' }).boundingBox()
  expect(answer.answers.y + answer.answers.height).toBeLessThanOrEqual(nav!.y)

  await page.getByRole('button', { name: /^Good ·/ }).click()
  await expect(content.locator('ruby')).toContainText(word.includes('猫') ? '犬' : '猫')
  const next = await reviewGeometry(page)
  expectFixedReview(front, next)
})

test('secondary review actions are reachable by keyboard and return focus to their menu', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  const tile = page.getByRole('treeitem').filter({ hasText: 'Sample — Japanese Starter' })
  await expect(tile).toContainText('02 NOTES')
  await tile.getByRole('button', { name: 'Open Sample — Japanese Starter' }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit note', exact: true })).toBeHidden()
  const menu = page.getByText('More actions', { exact: true })
  await menu.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Edit note', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Card info', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Card info' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Edit note', exact: true })).toBeHidden()
  await expect(menu).toBeFocused()
  await expect(page.getByRole('button', { name: 'End session' })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Export Anki package' })).toBeVisible()
})

test('package dialog action pair shares one baseline and a consistent touch size', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  const chooser = dialog.getByRole('button', { name: 'Choose package' })
  await expect(chooser).toBeFocused()
  const fileChooser = page.waitForEvent('filechooser')
  await chooser.click()
  const filename = `${'日本語の練習用デッキ'.repeat(12)}.apkg`
  await (await fileChooser).setFiles({ name: filename, mimeType: 'application/octet-stream', buffer: Buffer.from('intentionally invalid package for filename layout') })
  await expect(dialog.locator('.package-file-picker span')).toHaveText(filename)
  const picker = await dialog.locator('.package-file-picker').boundingBox()
  const filenameBox = await dialog.locator('.package-file-picker span').boundingBox()
  expect(filenameBox!.x + filenameBox!.width).toBeLessThanOrEqual(picker!.x + picker!.width + 1)
  await expect(chooser).toBeEnabled()
  const cancel = await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()
  const submit = await dialog.getByRole('button', { name: 'Import package', exact: true }).boundingBox()
  expect(Math.abs(cancel!.y - submit!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(cancel!.width - submit!.width)).toBeLessThanOrEqual(1)
  expect(cancel!.height).toBeGreaterThanOrEqual(44)
  expect(Math.abs(cancel!.height - submit!.height)).toBeLessThanOrEqual(1)
})

test('deck counts keep the same separator spacing for short and wrapped titles', async ({ page }) => {
  await page.goto('/')
  const names = ['Кана', 'Очень длинное название колоды для изучения японской фонетики и полезных повседневных выражений']
  const gaps: number[] = []
  for (const name of names) {
    await page.getByRole('button', { name: 'New deck', exact: true }).click()
    await page.getByLabel('Deck name', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Create deck', exact: true }).click()
    const tile = page.getByRole('treeitem').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(tile).toBeVisible()
    const counts = await tile.locator('.count-strip span').last().boundingBox()
    const action = await tile.getByRole('button', { name: `Open ${name}`, exact: true }).boundingBox()
    gaps.push(action!.y - counts!.y - counts!.height)
  }
  expect(Math.abs(gaps[0] - gaps[1])).toBeLessThanOrEqual(1)
  expect(gaps[0]).toBeGreaterThanOrEqual(16)
})

test('top controls and dialogs respect simulated iPhone safe areas and a short viewport', async ({ page }) => {
  await page.goto('/')
  // Injectable inset tokens simulate standalone iPhone chrome without changing
  // application data or replacing any browser APIs.
  await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; }' })
  const appearance = await page.getByRole('combobox', { name: 'Appearance', exact: true }).boundingBox()
  expect(appearance!.y).toBeGreaterThanOrEqual(47)
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect to your PC' })
  let bounds = await dialog.boundingBox()
  const rootHeight = await page.evaluate(() => document.documentElement.getBoundingClientRect().height)
  expect(bounds!.y).toBeGreaterThanOrEqual(47)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(rootHeight - 34)
  await page.setViewportSize({ width: 390, height: 400 })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded()
  bounds = await dialog.boundingBox()
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  // Windows WebKit scales the real canvas; use the layout viewport height.
  const layoutHeight = await page.evaluate(() => document.querySelector('.dialog-backdrop')!.getBoundingClientRect().height)
  expect(viewportHeight).toBeGreaterThan(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(47)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(layoutHeight - 34)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport()
})
