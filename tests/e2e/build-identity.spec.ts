import { expect, test } from '@playwright/test'

test('shows one build identity in the support panel, sync health and web manifest', async ({ page, request }) => {
  await page.goto('/')
  const panel = page.locator('.build-identity summary')
  await panel.click()
  const version = await page.locator('.build-identity dd').nth(0).textContent()
  const commit = await page.locator('.build-identity dd').nth(1).textContent()
  await expect(page.locator('.build-identity')).toContainText('Release build')
  expect(version).toMatch(/^\d+\.\d+\.\d+/)
  expect(commit).toMatch(/^[a-f0-9]{12}$/)

  const health = await request.get(`http://127.0.0.1:${process.env.KIROKU_SYNC_PORT ?? '4174'}/api/health`)
  expect(health.ok()).toBeTruthy()
  expect(await health.json()).toMatchObject({ build: { version, commit, release: true } })

  const manifestPath = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestPath).toBeTruthy()
  const manifest = await (await request.get(new URL(manifestPath!, page.url()).toString())).json()
  expect(manifest.kiroku).toEqual({ version, commit })
})
