import { expect, test } from '@playwright/test'
import { navigateOfflineDocument, WEBKIT_COLD_OFFLINE_LIMITATION } from './offline-navigation'

test('learner can open the production study workspace', async ({ page }, testInfo) => {
  const pageErrors: Error[] = []
  const assetFailures: string[] = []
  const requiredAssetTypes = new Set(['font', 'image', 'manifest', 'script', 'stylesheet'])
  page.on('pageerror', (error) => pageErrors.push(error))
  page.on('requestfailed', (request) => {
    if (requiredAssetTypes.has(request.resourceType())) {
      assetFailures.push(`${request.resourceType()} ${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`)
    }
  })
  page.on('response', (response) => {
    const request = response.request()
    if (requiredAssetTypes.has(request.resourceType()) && response.status() >= 400) {
      assetFailures.push(`${request.resourceType()} ${response.status()} ${response.url()}`)
    }
  })

  await page.goto('/')

  const navigationLabel = testInfo.project.name === 'iphone-webkit' ? 'Mobile navigation' : 'Primary navigation'

  await expect(page).toHaveTitle(/Kiroku/)
  await expect(page.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
  await expect(page.getByText('Offline shell ready')).toBeVisible()
  await expect(page.getByRole('navigation', { name: navigationLabel })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Decks' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Study' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Study/ })).not.toHaveAttribute('aria-disabled')

  const viewportWidth = page.viewportSize()?.width
  if (!viewportWidth) throw new Error('Browser viewport is unavailable')
  const layout = await page.evaluate((expectedViewportWidth) => {
    const overflowingElements = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((element) => ({
        selector: `${element.tagName.toLowerCase()}.${element.className}`,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }))
      .filter(({ left, right }) => left < -1 || right > expectedViewportWidth + 1)
    return {
      viewportWidth: expectedViewportWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowingElements,
    }
  }, viewportWidth)
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(viewportWidth + 1)
  expect(layout.overflowingElements, JSON.stringify(layout)).toEqual([])
  expect(assetFailures).toEqual([])
  expect(pageErrors).toEqual([])

  await testInfo.attach('workspace', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('manifest advertises an installable standalone app', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest')
  expect(response.ok()).toBe(true)

  const manifest = await response.json()
  expect(manifest.name).toBe('Kiroku — Japanese Study')
  expect(manifest.display).toBe('standalone')
  expect(manifest.background_color).toBe('#0b0d10')
  expect(manifest.theme_color).toBe('#0b0d10')
  expect(manifest.start_url).toBe('/')
  expect(manifest.scope).toBe('/')
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ sizes: '512x512', type: 'image/png' }),
    ]),
  )

  const faviconResponse = await request.get('/favicon.svg')
  expect(faviconResponse.ok(), 'favicon must be available').toBe(true)
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src)
    expect(iconResponse.ok(), `${icon.src} must be available`).toBe(true)
  }
})

for (const reopen of [false, true]) {
test(`shell works without a network${reopen ? ' in a fresh document' : ' in the current session'}`, async ({ browserName, context, page }) => {
  test.skip(reopen && browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable')
    await navigator.serviceWorker.ready
  })

  await context.setOffline(true)
  if (reopen) await navigateOfflineDocument(page)

  await expect(page.getByRole('heading', { name: 'Your Japanese study system' })).toBeVisible()
  await expect(page.getByText('Offline shell active')).toBeVisible()
})

}
