import { expect, type Locator, type Page } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'

// An installed iPhone draws its clock and battery across the top of the page.
// --safe-top is injectable so a desktop browser can stand in for that band
// without replacing a browser API or touching application data.
const STATUS_BAR = 47
const HOME_INDICATOR = 34

const test = phoneCanvasTest({ width: 390, height: 844 })

/**
 * Scrolls and waits for the page to hold still.
 *
 * The document scrolls smoothly, and a sticky header only settles after layout
 * has caught up with the new scroll offset, so two frames are read before the
 * position is treated as final.
 */
async function settleScroll(page: Page, top: number): Promise<number> {
  return page.evaluate(async (target) => {
    scrollTo({ top: target, behavior: 'instant' })
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    return scrollY
  }, top)
}

/** Where the link's label sits inside its touch target. */
async function labelGaps(link: Locator) {
  return link.evaluate(element => {
    const box = element.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    return { height: box.height, gapTop: text.top - box.top, gapBottom: box.bottom - text.bottom }
  })
}

/** The alpha a computed colour resolves to, or null when it is not a colour. */
function alphaOf(colour: string): number | null {
  const parts = /^rgba?\(([^)]+)\)$/.exec(colour)?.[1].split(',').map(part => part.trim())
  if (!parts) return null
  return parts.length < 4 ? 1 : Number(parts[3])
}

test('the header keeps the phone status bar over itself rather than over the page', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  await page.addStyleTag({ content: `:root { --safe-top: ${STATUS_BAR}px; --safe-bottom: ${HOME_INDICATOR}px; }` })

  // Precondition, not the fix: the header already reserved the band with
  // padding before this change. It is asserted so a failure below cannot be
  // mistaken for the band never having been reserved at all.
  const appearance = await page.getByRole('combobox', { name: 'Appearance', exact: true }).boundingBox()
  expect(appearance).not.toBeNull()
  expect(appearance!.y, 'the header clears the status bar before any scrolling').toBeGreaterThanOrEqual(STATUS_BAR)

  const scrolled = await settleScroll(page, 400)
  expect(scrolled, 'the page is long enough to scroll').toBeGreaterThan(0)

  const header = await page.evaluate(() => {
    const element = document.querySelector('.topbar')!
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    // Anything in the page that is currently behind the pinned header. If any of
    // it pokes out past the header's own edges, the header is not covering it.
    const uncovered = [...document.querySelectorAll<HTMLElement>('main *')]
      .filter(child => child.getClientRects().length)
      .filter(child => {
        const rect = child.getBoundingClientRect()
        return rect.top < box.bottom && rect.bottom > box.top
      })
      .filter(child => {
        const rect = child.getBoundingClientRect()
        return rect.left < box.left - 0.5 || rect.right > box.right + 0.5
      })
      .map(child => child.className)
    return {
      top: box.top,
      height: box.height,
      left: box.left,
      right: box.right,
      position: style.position,
      background: style.backgroundColor,
      uncovered,
    }
  })

  // Pinned. A header that travelled with the content is what left the clock and
  // battery drawn over the page in the first place.
  expect(header.position).toBe('sticky')
  expect(Math.abs(header.top), 'the header stays pinned while the page scrolls').toBeLessThanOrEqual(1)
  // The band is part of the header, and the header has to hide what passes under
  // it: fully opaque, and wide enough to cover it.
  expect(header.height).toBeGreaterThanOrEqual(STATUS_BAR + 44)
  expect(alphaOf(header.background), `the pinned header is opaque, not tinted: ${header.background}`).toBe(1)
  expect(header.uncovered, 'no page content shows beside the pinned header').toEqual([])

  await testInfo.attach('pinned-header', { body: JSON.stringify({ scrolled, header, appearance }), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath('pinned-header.png') })
})

test('the View progress label sits in the middle of its touch target', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  const link = page.getByRole('link', { name: 'View progress →' })
  await expect(link).toBeVisible()

  // The target is 44px tall so a finger can hit it, and the label has to sit in
  // the middle of that target. A label flush with the top border is the defect:
  // the space below it reads as the button, not as the gap it is.
  const measured = await labelGaps(link)
  await testInfo.attach('view-progress-label', { body: JSON.stringify(measured), contentType: 'application/json' })
  expect(measured.height).toBeGreaterThanOrEqual(43.99)
  expect(Math.abs(measured.gapTop - measured.gapBottom), JSON.stringify(measured)).toBeLessThanOrEqual(1)
})

test.describe('a desktop canvas', () => {
  // `.today-workload > a` is not inside a breakpoint, so the phone canvas above
  // cannot prove it for the width most learners study at.
  test.use({ viewport: { width: 1280, height: 720 }, isMobile: false, deviceScaleFactor: 1 })

  test('the View progress label is centred there too', async ({ page }, testInfo) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
    const link = page.getByRole('link', { name: 'View progress →' })
    await expect(link).toBeVisible()

    const measured = await labelGaps(link)
    await testInfo.attach('view-progress-label-desktop', { body: JSON.stringify(measured), contentType: 'application/json' })
    expect(measured.height).toBeGreaterThanOrEqual(43.99)
    expect(Math.abs(measured.gapTop - measured.gapBottom), JSON.stringify(measured)).toBeLessThanOrEqual(1)
  })
})