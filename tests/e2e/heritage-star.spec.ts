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

test('the Anki heritage star keeps its five-point outline', async ({ page }) => {
  await page.goto('/')

  const silhouette = await page.locator('.heritage-star').evaluate(async () => {
    const image = new Image()
    image.src = new URL('/anki-heritage-star.svg', window.location.href).href
    await image.decode()

    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(image, 0, 0, 64, 64)
    const { data } = context.getImageData(0, 0, 64, 64)
    const alphaAt = (x: number, y: number) => data[(y * 64 + x) * 4 + 3]

    const reachesOuterRing = Array.from({ length: 360 }, (_, degrees) => {
      const radians = degrees * Math.PI / 180
      for (let radius = 29; radius >= 24; radius -= 0.5) {
        const x = Math.round(32 + Math.sin(radians) * radius)
        const y = Math.round(32 - Math.cos(radians) * radius)
        if (alphaAt(x, y) > 100) return true
      }
      return false
    })
    const tips = reachesOuterRing.filter((present, index) => present && !reachesOuterRing[(index + 359) % 360]).length

    return { tips, centerAlpha: alphaAt(32, 32) }
  })

  expect(silhouette.tips).toBe(5)
  expect(silhouette.centerAlpha).toBe(0)
})
