import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { navigateOfflineDocument, WEBKIT_COLD_OFFLINE_LIMITATION } from './offline-navigation'

const source = JSON.parse(readFileSync(new URL('../../third-party/inventory.json', import.meta.url), 'utf8')) as { dependencies: { name: string; version: string; notices: { file: string; sha256: string }[] }[] }

test('release dependency notices preserve exact served and cached publisher texts', async ({ page, browserName }, info) => {
  await page.goto('/')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await page.getByLabel('Support', { exact: true }).click()
  await page.getByRole('link', { name: 'Dependency notices', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Kiroku dependency notices', level: 1 })).toBeVisible()
  for (const dependency of source.dependencies) await expect(page.getByRole('heading', { name: `${dependency.name} — ${dependency.version}`, exact: true, level: 2 })).toBeVisible()
  // Keep visual evidence within WebKit's full-page pixel limit; all published text is asserted below.
  await page.screenshot({ path: info.outputPath('dependency-notices-online.png') })
  const expected = source.dependencies.flatMap(dependency => dependency.notices)
  const readDelivered = (fromCache: boolean) => page.evaluate(async ({ notices, fromCache }) => {
      const load = async (file: string) => {
        const url = new URL(file, location.href)
        // Workbox precache keys contain a revision query. This native cache
        // control proves retained bytes, not WebKit service-worker delivery.
        const response = fromCache ? await caches.match(url, { ignoreSearch: true }) : await fetch(url)
        if (!response) throw new Error(`Missing cached notice ${file}`)
        return response
      }
      const inventory = await load('inventory.json')
      if (!inventory.ok) throw new Error(`Offline inventory returned ${inventory.status}`)
      const document = await inventory.json()
      const files = []
      for (const notice of notices) {
        const response = await load(notice.file)
        if (!response.ok) throw new Error(`Offline notice ${notice.file} returned ${response.status}`)
        const bytes = await response.arrayBuffer()
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
        files.push({ file: notice.file, sha256: hash })
      }
      return { dependencies: document.dependencies.map((item: { name: string; version: string }) => ({ name: item.name, version: item.version })), files }
    }, { notices: expected, fromCache })
  const assertDelivered = (delivered: Awaited<ReturnType<typeof readDelivered>>) => {
    expect(delivered.dependencies).toEqual(source.dependencies.map(({ name, version }) => ({ name, version })))
    expect(delivered.files).toEqual(expected.map(({ file, sha256 }) => ({ file, sha256 })))
  }
  assertDelivered(await readDelivered(false))
  await page.context().setOffline(true)
  try {
    if (browserName === 'chromium') await navigateOfflineDocument(page)
    await expect(page.getByRole('heading', { name: 'Kiroku dependency notices', level: 1 })).toBeVisible()
    const delivered = await readDelivered(browserName === 'webkit')
    assertDelivered(delivered)
    await info.attach('offline-dependency-notice-evidence', { body: JSON.stringify({ mode: browserName === 'webkit' ? 'native-cache-retention-in-existing-document' : 'fresh-service-worker-document-and-fetch', limitation: browserName === 'webkit' ? WEBKIT_COLD_OFFLINE_LIMITATION : null, ...delivered }, null, 2), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath('dependency-notices-offline.png') })
  } finally { await page.context().setOffline(false) }
})
