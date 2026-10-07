import { expect, test as base, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import initSqlJs from 'sql.js'
import { Collection as AnkiCollection, Deck, Note, Notetype, Package } from 'ankipack'
import { createHash } from 'node:crypto'
import { createSyncService } from '../../server/sync-service'
import { createSyncHttpHandler } from '../../server/sync-http'

const test = base.extend<{ hostScale: number }>({
  hostScale: async ({ browser, browserName }, provide) => {
    if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
    const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
    let scale = 1
    try { scale = await (await probe.newPage()).evaluate(() => 1000 / innerWidth) }
    finally { await probe.close() }
    await provide(scale)
  },
  viewport: async ({ hostScale }, provide) => provide({ width: Math.round(390 * hostScale), height: Math.round(844 * hostScale) }),
  isMobile: async ({ browserName }, provide) => provide(!(browserName === 'webkit' && process.platform === 'win32')),
  deviceScaleFactor: async ({ hostScale }, provide) => provide(3 / hostScale),
  hasTouch: true,
})

async function fixture() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000000101, name: 'Restoration Japanese', fields: [{ name: 'Expression' }, { name: 'Meaning' }, { name: 'Media' }], templates: [{ name: 'Recognition', questionFormat: '{{Expression}}{{Media}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }] })
  const root = new Deck({ id: 1700000000102, name: 'Restoration' })
  const child = new Deck({ id: 1700000000103, name: 'Restoration::Japanese' })
  child.addNote(new Note({ notetype: type, guid: 'restoration-browser-cat', fields: ['猫', 'cat', '<img src="cat.png">[sound:cat.wav]'], tags: ['restoration'] }))
  const pkg = new Package()
  pkg.addDeck(root); pkg.addDeck(child)
  pkg.addMedia('cat.png', Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64')))
  const wav = new Uint8Array(844)
  wav.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
  wav.fill(128, 44)
  pkg.addMedia('cat.wav', wav)
  return Buffer.from(await pkg.toUint8Array(SQL))
}

async function plan(page: Page, buffer: Buffer) {
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'restoration.apkg', mimeType: 'application/octet-stream', buffer })
  await expect(page.getByRole('region', { name: 'Package summary' }).getByText('1 note', { exact: true })).toBeVisible()
}

async function sync(page: Page) {
  await page.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect(page.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible({ timeout: 15000 })
}

async function exportPackage(page: Page) {
  await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Anki package' })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download package', exact: true }).click()
  const path = await (await download).path()
  expect(path).not.toBeNull()
  const bytes = await readFile(path!)
  await dialog.getByRole('button', { name: 'Close export' }).click()
  return bytes
}

async function inventory(bytes: Buffer) {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const data = AnkiCollection.open(bytes, SQL).data
  const rows = (values: unknown[]) => values.map(value => Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !['mod', 'usn', 'mtimeSecs'].includes(key)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const cards = data.cards.map(card => {
    const metadata = JSON.parse(card.data || '{}')
    // Native new cards store queue position, not a scheduled calendar instant.
    if (card.type === 0 && metadata.kiroku?.state === 0) metadata.kiroku.due = null
    return { ...card, data: JSON.stringify(metadata) }
  })
  const notes = data.notes.map(note => {
    const metadata = JSON.parse(note.data || '{}')
    metadata.kirokuMedia?.sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name))
    return { ...note, data: JSON.stringify(metadata) }
  })
  return {
    // ankipack generates fresh deck option protobuf defaults for each export.
    decks: rows(data.decks.map(({ id, name }) => ({ id, name }))), notes: rows(notes), types: rows(data.notetypes), fields: rows(data.fields), templates: rows(data.templates), cards: rows(cards), reviews: rows(data.revlog),
    media: data.media.map(file => ({ name: file.name, digest: createHash('sha256').update(file.data).digest('hex') })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

test('a deleted nested deck can be imported again and studied on a second device', async ({ page, browser, browserName, hostScale }, info) => {
  test.setTimeout(120000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const runtime = await mkdtemp(join(tmpdir(), 'kiroku-restoration-browser-'))
  const service = createSyncService({ databasePath: join(runtime, 'collection.sqlite') })
  const baseURL = String(info.project.use.baseURL)
  const server = createServer(createSyncHttpHandler(service, { allowedOrigin: new URL(baseURL).origin }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Restoration service has no address')
  const origin = `http://127.0.0.1:${address.port}`
  const contextOptions = { ...info.project.use, baseURL, viewport: page.viewportSize()!, isMobile: !(browserName === 'webkit' && process.platform === 'win32'), deviceScaleFactor: 3 / hostScale, hasTouch: true }
  const receiverContext = await browser.newContext(contextOptions)
  const roundtripContext = await browser.newContext(contextOptions)
  const pair = async (target: Page) => {
    await target.getByRole('button', { name: 'Connect a PC' }).click()
    await target.getByLabel('PC service address').fill(origin)
    await target.getByLabel('One-time pairing code').fill(service.createPairingCode())
    await target.getByRole('button', { name: 'Connect device' }).click()
    await expect(target.getByText('PC connected. Your collections are ready to sync.')).toBeVisible()
  }
  try {
    const buffer = await fixture()
    await page.goto('/')
    expect(await page.evaluate(() => innerWidth)).toBe(390)
    await plan(page, buffer)
    await page.getByRole('button', { name: 'Import package', exact: true }).click()
    await pair(page)
    await sync(page)
    const originalInventory = await inventory(await exportPackage(page))
    await page.getByRole('button', { name: 'Open Restoration', exact: true }).click()
    const originalURL = page.url()
    await page.getByRole('button', { name: 'Delete deck', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete deck' }).getByRole('button', { name: 'Delete deck subtree' }).click()
    await sync(page)
    await page.reload()
    await plan(page, buffer)
    const restorePlan = page.getByRole('region', { name: 'Restore deleted content' })
    await expect(restorePlan).toContainText('2 decks, 1 note and 1 card')
    await restorePlan.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }))
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.getBoundingClientRect().width, dialog: document.querySelector('[role="dialog"]')!.getBoundingClientRect().toJSON() }))
    await info.attach('restore-plan-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' })
    expect(geometry.scrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.rootWidth))
    expect(geometry.dialog.left).toBeGreaterThanOrEqual(0)
    expect(geometry.dialog.right).toBeLessThanOrEqual(geometry.width + 1)
    await page.screenshot({ path: info.outputPath('restore-import-plan.png') })
    await page.getByRole('button', { name: 'Import package', exact: true }).click()
    await expect(restorePlan).toBeHidden()
    await sync(page)
    expect(await inventory(await exportPackage(page))).toEqual(originalInventory)
    await page.getByRole('button', { name: 'Open Restoration', exact: true }).click()
    expect(page.url()).toBe(originalURL)
    const receiver = await receiverContext.newPage()
    receiver.on('pageerror', error => errors.push(error.message))
    await receiver.goto('/')
    await pair(receiver)
    await sync(receiver)
    await receiver.getByRole('button', { name: 'Open Japanese', exact: true }).click()
    await receiver.getByRole('button', { name: 'Study now', exact: true }).click()
    const review = receiver.frameLocator('iframe[title="Review card"]')
    await expect(review.locator('body')).toContainText('猫')
    const image = review.getByRole('img', { name: 'cat.png' })
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    await expect(review.locator('audio')).toHaveAttribute('src', /^data:audio\/wav;base64,/)
    if (browserName === 'chromium') await expect.poll(() => review.locator('audio').evaluate((element: HTMLAudioElement) => element.readyState >= 1)).toBe(true)
    await receiver.screenshot({ path: info.outputPath('restored-second-device-front.png') })
    await receiver.getByRole('button', { name: 'Show answer', exact: true }).click()
    await expect(review.locator('body')).toContainText('cat')
    await receiver.getByRole('button', { name: /^Good ·/ }).click()
    await expect(receiver.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await receiver.getByRole('button', { name: 'Back to deck' }).click()
    await sync(receiver)
    await sync(page)
    const exported = await exportPackage(page)
    const reviewedInventory = await inventory(exported)
    expect(reviewedInventory.reviews).toHaveLength(1)
    const roundtrip = await roundtripContext.newPage()
    roundtrip.on('pageerror', error => errors.push(error.message))
    await roundtrip.goto('/')
    await plan(roundtrip, exported)
    await roundtrip.getByRole('button', { name: 'Import package', exact: true }).click()
    expect(await inventory(await exportPackage(roundtrip))).toEqual(reviewedInventory)
    expect(errors).toEqual([])
  } finally {
    await receiverContext.close()
    await roundtripContext.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await rm(runtime, { recursive: true, force: true })
  }
})
