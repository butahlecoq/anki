import { expect, test } from '@playwright/test'

// The heritage star is drawn with a CSS mask rather than an <img> so the theme's
// accent tokens can colour it. That only holds if the mask resolves and the
// background colour is not transparent, so this is proved in a real browser:
// jsdom never resolves the external stylesheet, and an <img> would silently
// ignore the colour entirely.
test('the Anki heritage star is drawn, themed, and still while the app is idle', async ({ page }) => {
  await page.goto('/')

  const star = page.locator('.heritage-star')
  await expect(star).toBeVisible()

  const painted = await star.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      maskImage: style.maskImage,
      width: element.getBoundingClientRect().width,
    }
  })

  expect(painted.maskImage).toContain('anki-heritage-star.svg')
  expect(painted.width).toBeGreaterThan(0)
  // An unpainted mark would render as nothing at all, which is the exact
  // failure a mask-only element risks in an unsupported browser.
  expect(painted.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(painted.background).not.toBe('transparent')

  // The Kiroku brand is untouched: the star is an addition beside the existing
  // header controls, never a replacement for them. (The brand link itself only
  // exists in the desktop sidebar, which the phone layout swaps for the mobile
  // navigation, so assert on what both layouts share.)
  await expect(page).toHaveTitle(/Kiroku/)
  await expect(page.getByLabel('Support')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toBeVisible()

  // Motion must keep meaning something: an idle, settled app leaves it still.
  await expect(star).not.toHaveClass(/is-turning/)
  const transform = await star.evaluate((element) => getComputedStyle(element).transform)
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform)
})

test('the heritage star is hidden from assistive technology', async ({ page }) => {
  await page.goto('/')

  const star = page.locator('.heritage-star')
  await expect(star).toHaveAttribute('aria-hidden', 'true')
  // Decorative artwork must not be reachable as an image or a labelled node.
  await expect(page.getByRole('img', { name: /heritage/i })).toHaveCount(0)
})
