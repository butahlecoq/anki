import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'

const test = phoneCanvasTest({ width: 390, height: 844 })

test('mobile Browse exposes card and note results without sideways scrolling', async ({ page, hostScale }, testInfo) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  await page.getByRole('link', { name: 'Browse', exact: true }).click()
  const results = page.locator('.browser-table-scroll')
  await expect(page.getByRole('table')).toBeVisible()
  await results.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('browse-initial.png') })

  // The existing document-width checks miss an overflowing nested result region.
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height: 844 })
    const geometry = await results.evaluate(element => ({ visible: element.clientWidth, content: element.scrollWidth }))
    expect(geometry.content, `Browse results at ${width}px`).toBeLessThanOrEqual(geometry.visible + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  }

  const selected = page.getByRole('checkbox', { name: /^Select card / }).first()
  const identity = await selected.getAttribute('aria-label')
  await selected.check()
  await page.getByRole('button', { name: /^Expression/ }).click()
  await expect(page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: /^Expression/ }) })).toHaveAttribute('aria-sort', 'descending')
  await expect(page.getByRole('checkbox', { name: identity!, exact: true })).toBeChecked()
  const expression = page.locator('tbody .browser-expression').first()
  await expression.click()
  const editor = page.getByRole('dialog', { name: 'Edit note fields' })
  const longExpression = '日本語の長い表現を折り返して読みやすく表示する'.repeat(6)
  await editor.locator('textarea').first().fill(longExpression)
  await editor.getByRole('button', { name: 'Save fields', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: 'Select all results', exact: true }).click()
  await page.getByRole('button', { name: 'Tag selection', exact: true }).click()
  await page.getByLabel('Tags', { exact: true }).fill('長い日本語タグ'.repeat(12))
  await page.getByRole('button', { name: 'Apply to selection', exact: true }).click()
  const longDeck = '日本語の長いデッキ名'.repeat(8)
  await page.getByRole('link', { name: 'Decks', exact: true }).click()
  await page.getByRole('button', { name: 'New deck', exact: true }).click()
  await page.getByLabel('Deck name', { exact: true }).fill(longDeck)
  await page.getByRole('button', { name: 'Create deck', exact: true }).click()
  await page.getByRole('link', { name: 'Browse', exact: true }).click()
  await page.getByRole('button', { name: 'Move selection', exact: true }).click()
  await page.getByLabel('Destination deck', { exact: true }).selectOption({ label: longDeck })
  await page.getByRole('button', { name: 'Apply to selection', exact: true }).click()
  const search = page.getByLabel('Collection search', { exact: true })
  await search.fill('日本語の長い表現')
  await expect(search).toHaveValue('日本語の長い表現')
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  for (const view of ['cards', 'notes']) {
    await page.getByLabel('Result view', { exact: true }).selectOption(view)
    for (const width of [320, 390]) {
      await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
      expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height: 844 })
      const row = page.locator('tbody tr').first()
      await expect(row).toContainText(longExpression.slice(0, 100))
      await expect(row).toContainText(longDeck)
      if (view === 'notes') await expect(row).toContainText('長い日本語タグ'.repeat(12))
      for (const cell of await row.locator('td').all()) {
        const box = await cell.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(-1)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
      }
      expect(await results.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      await row.scrollIntoViewIfNeeded()
      await testInfo.attach(`browse-${view}-${width}-geometry`, {
        body: JSON.stringify(await results.evaluate(element => ({ viewport: { width: innerWidth, height: innerHeight }, visible: element.clientWidth, content: element.scrollWidth, document: document.documentElement.scrollWidth }))),
        contentType: 'application/json',
      })
      await page.screenshot({ path: testInfo.outputPath(`browse-${view}-${width}.png`) })
    }
    const clearSelection = page.getByRole('button', { name: 'Clear selection', exact: true })
    if (await clearSelection.isEnabled()) await clearSelection.click()
    const checkbox = page.getByRole('checkbox', { name: new RegExp(`^Select ${view === 'cards' ? 'card' : 'note'} `) }).first()
    await checkbox.focus()
    await expect(checkbox).toBeFocused()
    await page.keyboard.press('Space')
    await expect(checkbox).toBeChecked()
    await page.getByRole('button', { name: /^Deck/ }).click()
    await page.locator('tbody .browser-expression').first().focus()
    await page.keyboard.press('Enter')
    await expect(editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).not.toBeVisible()
  }
})
