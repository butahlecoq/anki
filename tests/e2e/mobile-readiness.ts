import { expect, type Locator } from '@playwright/test'

export async function clickReachable(control: Locator): Promise<void> {
  await expect(control).toBeVisible()
  await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && hit !== null && element.contains(hit)
  }), { message: 'The intended control center receives pointer events' }).toBe(true)
  await control.click()
}

export interface DateGeometry {
  label: string | null
  date: string | null
  visible: boolean
  width: number
  height: number
}

export async function readDateGeometry(dates: Locator): Promise<DateGeometry[]> {
  return dates.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    const visibility = getComputedStyle(element).visibility
    return {
      label: element.getAttribute('aria-label'),
      date: element.querySelector('time')?.getAttribute('datetime') ?? null,
      visible: element.getClientRects().length > 0 && visibility !== 'hidden' && visibility !== 'collapse' && box.width > 0 && box.height > 0,
      width: box.width,
      height: box.height,
    }
  }))
}

export async function assertDateGeometry(dates: Locator, expectedDates: string[]): Promise<void> {
  await expect(dates).toHaveCount(expectedDates.length)
  const records = await readDateGeometry(dates)
  expect(records).toHaveLength(expectedDates.length)
  expect(new Set(records.map(record => record.date)).size).toBe(expectedDates.length)
  expect(records.map(record => record.date)).toEqual(expectedDates)
  for (const [index, record] of records.entries()) {
    const label = record.label ?? expectedDates[index]
    expect(record.visible, label).toBe(true)
    expect(record.label?.startsWith(`${expectedDates[index]}:`), label).toBe(true)
    expect(record.width, label).toBeGreaterThanOrEqual(43.99)
    expect(record.height, label).toBeGreaterThanOrEqual(43.99)
  }
}
