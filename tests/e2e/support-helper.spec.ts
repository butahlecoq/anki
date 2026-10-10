import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'

const test = phoneCanvasTest({ width: 390, height: 844 })

test('Support helper matches the theme selector and opens build details on phones', async ({ page, hostScale }, info) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    await page.goto('/')
    const helper = page.locator('summary[aria-label="Support"]')
    await expect(helper).toBeVisible()
    await expect(helper.locator('[aria-hidden]')).toHaveText('?')
    await helper.focus()
    await expect(page.getByRole('tooltip')).toBeVisible()
    const sizes = await page.evaluate(() => {
      const support = document.querySelector('.build-identity summary')!.getBoundingClientRect()
      const theme = document.querySelector('.appearance-control select')!.getBoundingClientRect()
      return { support: support.height, theme: theme.height, width: support.width, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    expect(sizes.support).toBe(sizes.theme)
    expect(sizes.support).toBeGreaterThanOrEqual(44)
    expect(sizes.width).toBeGreaterThanOrEqual(44)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await helper.press('Enter')
    await expect(page.getByText('Version', { exact: true })).toBeVisible()
    await expect(page.getByText('Commit', { exact: true })).toBeVisible()
    await expect(page.getByText('Channel', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Dependency notices' })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`support-${width}.png`) })
    await helper.click()
    await expect(page.getByText('Commit', { exact: true })).not.toBeVisible()
    await helper.click()
    await expect(page.getByText('Commit', { exact: true })).toBeVisible()
  }
})
