import { expect } from '@playwright/test'
import { phoneCanvasTest } from './phone-canvas'
import { assertDateGeometry, clickReachable, readDateGeometry } from './mobile-readiness'

const test = phoneCanvasTest({ width: 390, height: 844 })

test('pointer readiness rejects fixed navigation covering the intended center', async ({ page }, info) => {
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}button{position:fixed;top:50%;left:20px;width:200px;height:44px}nav{position:fixed;inset:0;z-index:2}</style><button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Intended action</button><nav aria-label="Covering navigation"></nav>`)
  const control = page.getByRole('button', { name: 'Intended action' })
  await expect(clickReachable(control)).rejects.toThrow()
  await expect(control).not.toHaveAttribute('data-clicks')
  await info.attach('covered-pointer', { body: JSON.stringify(await control.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { bounds: box.toJSON(), hitTarget: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.outerHTML }
  })), contentType: 'application/json' })
  await page.getByRole('navigation', { name: 'Covering navigation' }).evaluate(element => element.remove())
  await clickReachable(control)
  await expect(control).toHaveAttribute('data-clicks', '1')
})
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
