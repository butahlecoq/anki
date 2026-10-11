import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'
import { assertDateGeometry, readDateGeometry } from './mobile-readiness'

const test = phoneCanvasTest({ width: 390, height: 844 })
const dates = Array.from({ length: 84 }, (_, index) => new Date(Date.UTC(2026, 6, 16 + index)).toISOString().slice(0, 10))
const fixture = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}main{display:grid;grid-template-columns:repeat(7,44px)}button{box-sizing:border-box;width:44px;height:44px;padding:0}</style><main>${dates.map(date => `<button aria-label="${date}: 0 answers"><time datetime="${date}">${date.slice(-2)}</time></button>`).join('')}</main>`

for (const width of [320, 390]) {
  test(`batched observation preserves every original date bounding box at ${width}px`, async ({ page, hostScale }, info) => {
    await page.setViewportSize({ width: Math.round(width * hostScale), height: Math.round(844 * hostScale) })
    await page.setContent(fixture)
    expect(await page.evaluate(() => innerWidth)).toBe(width)
    const buttons = page.getByRole('button', { includeHidden: true })
    const records = await readDateGeometry(buttons)
    expect(records).toHaveLength(84)
    for (const [index, button] of (await buttons.all()).entries()) {
      const original = await button.boundingBox()
      expect(original).not.toBeNull()
      expect(records[index].visible).toBe(true)
      expect(records[index].width).toBeCloseTo(original!.width, 2)
      expect(records[index].height).toBeCloseTo(original!.height, 2)
      expect(records[index].date).toBe(dates[index])
      expect(records[index].label).toBe(`${dates[index]}: 0 answers`)
    }
    await assertDateGeometry(buttons, dates)
    await info.attach('all-date-observations', { body: JSON.stringify({ width, originalBoundingBoxes: 84, records }), contentType: 'application/json' })
  })
}

for (const change of ['hidden', 'invisible', 'zero-size', 'narrow', 'short', 'missing', 'duplicate-date'] as const) {
  test(`date measurement rejects ${change} without discarding a failed observation`, async ({ page }) => {
    await page.setContent(fixture)
    await page.getByRole('button').nth(1).evaluate((element, { mutation, firstDate }) => {
      const button = element as HTMLButtonElement
      if (mutation === 'hidden') button.style.display = 'none'
      if (mutation === 'invisible') button.style.visibility = 'hidden'
      if (mutation === 'zero-size') { button.style.width = '0'; button.style.height = '0'; button.style.border = '0' }
      if (mutation === 'narrow') button.style.width = '43px'
      if (mutation === 'short') button.style.height = '43px'
      if (mutation === 'missing') button.remove()
      if (mutation === 'duplicate-date') button.querySelector('time')!.setAttribute('datetime', firstDate)
    }, { mutation: change, firstDate: dates[0] })
    const buttons = page.getByRole('button', { includeHidden: true })
    if (change === 'hidden' || change === 'invisible') {
      const records = await readDateGeometry(buttons)
      expect(records).toHaveLength(84)
      expect(records[1].visible).toBe(false)
      const original = await buttons.nth(1).boundingBox()
      if (change === 'hidden') expect(original).toBeNull()
      else {
        expect(original).not.toBeNull()
        expect(records[1].width).toBeCloseTo(original!.width, 2)
        expect(records[1].height).toBeCloseTo(original!.height, 2)
      }
    }
    await expect(assertDateGeometry(buttons, dates)).rejects.toThrow()
  })
}
