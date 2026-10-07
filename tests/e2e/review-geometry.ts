import { expect, type Page } from '@playwright/test'

export async function reviewGeometry(page: Page) {
  for (const frame of await page.locator('.review-card iframe').all()) {
    await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument?.fonts.ready.then(() => undefined))
  }
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.querySelectorAll<HTMLImageElement>('.review-card img')].map(image => image.decode()))
    for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame)
  })
  const card = await page.locator('.review-card').boundingBox()
  const answers = await page.locator('.review-answer-controls').boundingBox()
  expect(card).not.toBeNull()
  expect(answers).not.toBeNull()
  return { card: card!, answers: answers!, scroll: await page.evaluate(() => scrollY) }
}

export function expectFixedReview(before: Awaited<ReturnType<typeof reviewGeometry>>, after: Awaited<ReturnType<typeof reviewGeometry>>) {
  for (const area of ['card', 'answers'] as const) {
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(after[area][dimension] - before[area][dimension]), `${area} ${dimension}`).toBeLessThanOrEqual(1)
    }
  }
  expect(after.scroll, 'page scroll stays fixed').toBe(before.scroll)
}
