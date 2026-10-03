import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { openOfflineProfileDocument, WEBKIT_COLD_OFFLINE_LIMITATION } from './offline-navigation'

const contentTypes: Record<string, string> = {
  '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
}

async function countCollectionRows(page: import('@playwright/test').Page, storeName: string) {
  return page.evaluate((name) => new Promise<number>((resolveCount, rejectCount) => {
    const request = indexedDB.open('kiroku-collection')
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(name, 'readonly')
      const count = transaction.objectStore(name).count()
      count.onsuccess = () => resolveCount(count.result)
      count.onerror = () => rejectCount(count.error)
      transaction.oncomplete = () => database.close()
      transaction.onerror = () => { database.close(); rejectCount(transaction.error) }
    }
    request.onerror = () => rejectCount(request.error)
  }), storeName)
}

async function startVersionedServer(original: string, updated: string) {
  let serveUpdatedVersion = false
  const server: Server = createServer(async (request, response) => {
    try {
      const root = serveUpdatedVersion ? updated : original
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      let filepath = resolve(root, `.${pathname}`)
      if (filepath !== root && !filepath.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end()
        return
      }
      try {
        if ((await stat(filepath)).isDirectory()) filepath = join(filepath, 'index.html')
      } catch {
        filepath = join(root, 'index.html')
      }
      const body = await readFile(filepath)
      response.writeHead(200, { 'Content-Type': contentTypes[extname(filepath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The test server did not receive a TCP port.')
  return {
    url: `http://127.0.0.1:${address.port}`,
    publishUpdatedVersion() { serveUpdatedVersion = true },
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  }
}

test('activating a new service-worker version preserves the collection and media for a cold offline reopen', async ({ browserName, browser }) => {
  test.skip(browserName === 'webkit', WEBKIT_COLD_OFFLINE_LIMITATION)
  const temporary = await mkdtemp(join(tmpdir(), 'kiroku-worker-update-'))
  const profile = join(temporary, 'profile')
  const updatedBuild = join(temporary, 'updated-build')
  let context: import('@playwright/test').BrowserContext | undefined
  let reopenedContext: import('@playwright/test').BrowserContext | undefined
  let server: Awaited<ReturnType<typeof startVersionedServer>> | undefined

  try {
    const buildDirectory = resolve(process.cwd(), 'dist')
    await cp(buildDirectory, updatedBuild, { recursive: true })
    const workerScript = await readFile(join(updatedBuild, 'sw.js'), 'utf8')
    await writeFile(join(updatedBuild, 'sw.js'), `${workerScript}\nself.addEventListener('message', event => { if (event.data === 'kiroku-version-check') event.ports[0]?.postMessage('v2') })\n`)
    server = await startVersionedServer(buildDirectory, updatedBuild)

    context = await browser.browserType().launchPersistentContext(profile)
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(`${server.url}/`)
    await page.getByRole('button', { name: 'New deck' }).click()
    const createDeckDialog = page.getByRole('dialog', { name: 'Create a deck' })
    await expect(createDeckDialog).toBeVisible()
    await page.getByLabel('Deck name').fill('Worker update')
    await createDeckDialog.getByRole('button', { name: 'Create deck' }).click()
    await page.getByRole('button', { name: 'Open Worker update' }).click()
    await page.getByRole('button', { name: 'Add note' }).click()
    await page.getByLabel('Front').fill('猫')
    await page.getByLabel('Back').fill('cat')
    await page.getByLabel('Images and audio').setInputFiles({
      name: 'cat.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'),
    })
    await page.getByRole('button', { name: 'Save note' }).click()
    await expect(page.getByText('cat', { exact: true })).toBeVisible()
    await expect.poll(() => countCollectionRows(page, 'notes')).toBe(1)
    await expect.poll(() => countCollectionRows(page, 'cards')).toBe(1)
    const deckId = await page.evaluate(() => window.location.hash.split('/')[1])
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

    await page.evaluate(() => { Reflect.set(window, 'kirokuBeforeWorkerUpdate', true) })
    server.publishUpdatedVersion()
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) throw new Error('The app service worker is not registered.')
      await registration.update()
    })
    await expect(page.locator('.update-toast')).toContainText('A new version is ready.')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Update app' }).click(),
    ])
    expect(await page.evaluate(() => Reflect.has(window, 'kirokuBeforeWorkerUpdate'))).toBe(false)
    await expect(page.getByRole('heading', { name: 'Worker update' })).toBeVisible()
    await expect.poll(() => countCollectionRows(page, 'notes')).toBe(1)
    await expect.poll(() => countCollectionRows(page, 'cards')).toBe(1)
    await expect(page.getByText('cat', { exact: true })).toBeVisible()
    const activeWorkerVersion = await page.evaluate(() => new Promise<string>((resolveVersion, rejectVersion) => {
      const channel = new MessageChannel()
      const timeout = window.setTimeout(() => rejectVersion(new Error('The activated worker did not answer its version probe.')), 5_000)
      channel.port1.onmessage = (event: MessageEvent<string>) => {
        window.clearTimeout(timeout)
        channel.port1.close()
        resolveVersion(event.data)
      }
      navigator.serviceWorker.controller?.postMessage('kiroku-version-check', [channel.port2])
    }))
    expect(activeWorkerVersion).toBe('v2')

    await context.close()
    context = undefined
    reopenedContext = await browser.browserType().launchPersistentContext(profile)
    await reopenedContext.setOffline(true)
    const reopened = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
    await openOfflineProfileDocument(reopened, `${server.url}/#deck/${deckId}`)
    await expect(reopened.getByRole('heading', { name: 'Worker update' })).toBeVisible()
    await expect(reopened.getByText('cat', { exact: true })).toBeVisible()
    await reopened.getByRole('button', { name: 'Study now' }).click()
    const image = reopened.getByRole('img', { name: 'cat.png' })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 1)).toBe(true)
  } finally {
    await context?.close()
    await reopenedContext?.close()
    await server?.close().catch(() => undefined)
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
})
