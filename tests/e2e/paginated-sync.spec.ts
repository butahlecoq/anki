import { chromium, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'
import { createSyncService } from '../../server/sync-service'
import { createSyncHttpHandler } from '../../server/sync-http'
import { nativeCanvasTest } from './phone-canvas'
import { openCollectionTools } from './collection-tools'

const test = nativeCanvasTest()

async function unrelatedPackage() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000000901, name: 'Pagination filler', fields: [{ name: 'Front' }, { name: 'Back' }], templates: [{ name: 'Recognition', questionFormat: '{{Front}}', answerFormat: '{{FrontSide}}<hr>{{Back}}' }] })
  const deck = new Deck({ id: 1700000000902, name: 'Unrelated cards' })
  for (let index = 0; index < 130; index++) deck.addNote(new Note({ notetype: type, guid: `pagination-filler-${index}`, fields: [`Synthetic ${index}`, 'Filler'], tags: [] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  return Buffer.from(await pkg.toUint8Array(SQL))
}

test('a second browser downloads and studies a child whose parent is beyond the first sync page', async ({ page: receiverCanvas, browser, browserName, baseURL, hostScale }, info) => {
  test.setTimeout(300000)
  // The uploading PC uses Chromium; each project exercises its own receiver.
  const pcBrowser = browserName === 'webkit' ? await chromium.launch() : undefined
  const page = pcBrowser ? await pcBrowser.newPage({ baseURL }) : receiverCanvas
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-browser-pagination-'))
  const service = createSyncService({ databasePath: join(runtime, 'collection.sqlite') })
  const server = createServer(createSyncHttpHandler(service, { allowedOrigin: baseURL }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Pagination service has no address')
  const origin = `http://127.0.0.1:${address.port}`
  const receiverContext = await browser.newContext({ ...info.project.use, baseURL, viewport: receiverCanvas.viewportSize()!, isMobile: browserName === 'webkit' && process.platform === 'win32' ? false : info.project.use.isMobile, deviceScaleFactor: (info.project.use.deviceScaleFactor ?? 1) / hostScale })
  const errors: string[] = []
  const downloaded: Array<{ cursor: number; payload: { name?: string } }> = []
  const responseReads: Promise<void>[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.url() === `${origin}/api/sync` && response.ok()) responseReads.push(response.json().then(body => { downloaded.push(...body.changes) }))
  })
  const pair = async (target: Page) => {
    await openCollectionTools(target)
    await target.getByRole('button', { name: 'Connect a PC' }).click()
    await target.getByLabel('PC service address').fill(origin)
    await target.getByLabel('One-time pairing code').fill(service.createPairingCode())
    await target.getByRole('button', { name: 'Connect device' }).click()
    await expect(target.getByText('PC connected. Your collections are ready to sync.')).toBeVisible()
  }
  const sync = async (target: Page) => {
    await openCollectionTools(target)
    await target.getByRole('button', { name: 'Sync now', exact: true }).click()
    await expect(target.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible({ timeout: 180000 })
  }
  try {
    // Equal operation times and phased valid IDs put the child first and parent
    // last, while unrelated cards retain normal order. Use the actual owner UI
    // and HTTP service, without seeding collection tables.
    await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'))
    await page.addInitScript(() => {
      let counter = 0
      crypto.randomUUID = () => {
        const phase = (window as Window & { paginationUUIDPhase?: string }).paginationUUIDPhase
        const prefix = phase === 'parent' ? 0xf0000000 : phase === 'filler' ? 0x80000000 : 0
        return `${(prefix + counter++).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
      }
    })
    await page.goto('/')
    await page.evaluate(() => { (window as Window & { paginationUUIDPhase?: string }).paginationUUIDPhase = 'parent' })
    await page.getByRole('button', { name: 'New deck' }).click()
    await page.getByLabel('Deck name').fill('Japanese')
    await page.getByRole('button', { name: 'Create deck', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create a deck' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open Japanese', exact: true })).toBeVisible()
    await page.evaluate(() => { (window as Window & { paginationUUIDPhase?: string }).paginationUUIDPhase = 'filler' })
    await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
    await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'pagination.apkg', mimeType: 'application/octet-stream', buffer: await unrelatedPackage() })
    await expect(page.getByRole('region', { name: 'Package summary' })).toContainText('130 notes')
    await page.getByRole('button', { name: 'Import package', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Import Anki package', exact: true })).toBeHidden()
    await page.evaluate(() => { (window as Window & { paginationUUIDPhase?: string }).paginationUUIDPhase = 'child' })
    await page.getByRole('button', { name: 'Open Japanese', exact: true }).click()
    await page.getByRole('button', { name: 'Create child deck', exact: true }).click()
    await page.getByLabel('Deck name').fill('Verbs')
    await page.getByRole('dialog', { name: 'Create a child deck' }).getByRole('button', { name: 'Create child deck', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create a child deck' })).toBeHidden({ timeout: 15000 })
    await page.getByRole('link', { name: 'Decks', exact: true }).click()
    await page.getByRole('button', { name: 'Open Verbs', exact: true }).click()
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill('食べる')
    await page.getByLabel('Back', { exact: true }).fill('to eat')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add a Basic note', exact: true })).toBeHidden()
    await pair(page)
    await sync(page)
    await Promise.all(responseReads)
    const parent = downloaded.find(change => change.payload.name === 'Japanese')!
    const child = downloaded.find(change => change.payload.name === 'Verbs')!
    expect(parent.cursor - child.cursor).toBeGreaterThan(250)
    await info.attach('cross-page-cursors', { body: JSON.stringify({ parent: parent.cursor, child: child.cursor }), contentType: 'application/json' })
    const receiver = await receiverContext.newPage()
    receiver.on('pageerror', error => errors.push(error.message))
    await receiver.goto('/')
    await pair(receiver)
    await sync(receiver)
    const hierarchy = receiver.getByRole('tree', { name: 'Deck hierarchy' })
    await expect(hierarchy.getByRole('treeitem').filter({ hasText: 'Verbs' })).toHaveAttribute('aria-level', '2')
    await receiver.screenshot({ path: info.outputPath('second-browser-hierarchy.png') })
    await receiver.getByRole('button', { name: 'Open Verbs', exact: true }).click()
    await receiver.getByRole('button', { name: 'Study now', exact: true }).click()
    const review = receiver.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('body')).toContainText('食べる')
    await receiver.screenshot({ path: info.outputPath('second-browser-question.png') })
    await receiver.getByRole('button', { name: 'Show answer', exact: true }).click()
    await expect(review.locator('body')).toContainText('to eat')
    await receiver.getByRole('button', { name: /^Good ·/ }).click()
    await expect(receiver.getByRole('button', { name: 'Show answer' })).toBeVisible()
    await receiver.getByRole('button', { name: 'End session', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await receiverContext.close()
    await pcBrowser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await rm(runtime, { recursive: true, force: true })
  }
})
