import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'

const test = phoneCanvasTest({ width: 390, height: 844 })

test('empty collection actions have equal dimensions on the actual phone canvas', async ({ page, hostScale }, info) => {
  await page.goto('/')
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    const buttons = ['New deck', 'Load sample deck', 'Import Anki package'].map(name => page.getByRole('button', { name, exact: true }))
    const boxes = []
    for (const button of buttons) {
      await expect(button).toBeVisible()
      boxes.push((await button.boundingBox())!)
    }
    for (const box of boxes) {
      expect(box.height).toBeGreaterThanOrEqual(53.99)
      expect(Math.abs(box.height - boxes[0].height)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(1)
    }
    await page.screenshot({ path: info.outputPath(`empty-actions-${width}.png`) })
  }
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  await expect(dialog.getByRole('button', { name: 'Choose package', exact: true })).toBeVisible()
  await expect(dialog.getByText('No package selected', { exact: true })).toBeVisible()
  await expect(dialog.locator('input[type=file]')).toBeHidden()
})
