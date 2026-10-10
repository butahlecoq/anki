import { expect, test } from '@playwright/test'
import { createServer, request as proxyRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { preview } from 'vite'
import { createSyncService } from '../../server/sync-service'
import { createSyncHttpHandler } from '../../server/sync-http'
import { openCollectionTools } from './collection-tools'

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
}

async function removeFixture(directory: string) {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), 'kiroku-private-browser-'))) throw new Error('Unexpected fixture path')
  await rm(directory, { recursive: true, force: true })
}

// This proxy supplies only synthetic authenticated transport identity. Every
// application/API response comes from the built app or the real SQLite service.
async function privateFixture(webOrigin: string, { manual = false, holdDiscovery = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-browser-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  let backendOrigin = ''
  let authorized = true
  let connectionPosts = 0
  const apiRequests: string[] = []
  let releaseDiscovery = () => {}
  const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve })
  const proxy = createServer((incoming, response) => {
    const api = incoming.url?.startsWith('/api/') ?? false
    if (api) apiRequests.push(incoming.url!)
    if (incoming.url === '/api/connection' && incoming.method === 'POST') connectionPosts++
    const upstream = new URL(incoming.url ?? '/', api ? backendOrigin : webOrigin)
    const headers = { ...incoming.headers, host: upstream.host }
    delete headers['tailscale-user-login']
    if (api && authorized) headers['tailscale-user-login'] = 'synthetic-owner@example.test'
    const forwarded = proxyRequest(upstream, { method: incoming.method, headers }, result => {
      const reply = () => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.pipe(response)
      }
      if (holdDiscovery && incoming.url === '/api/connection' && incoming.method === 'GET') void discovery.then(reply)
      else reply()
    })
    forwarded.on('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(forwarded)
  })
  const origin = await listen(proxy)
  const backend = createServer(createSyncHttpHandler(service, { allowedOrigin: origin, trustedProxyUser: manual ? undefined : 'synthetic-owner@example.test' }))
  backendOrigin = await listen(backend)
  return {
    origin, service, apiRequests, releaseDiscovery,
    posts: () => connectionPosts,
    authorize: (value: boolean) => { authorized = value },
    async close() {
      releaseDiscovery()
      await close(proxy)
      await close(backend)
      service.close()
      await removeFixture(directory)
    },
  }
}

for (const manual of [true, false]) {
test(`connection discovery keeps the import action in place during a native click (${manual ? 'manual' : 'private'})`, async ({ page, baseURL }) => {
  const fixture = await privateFixture(baseURL!, { manual, holdDiscovery: true })
  try {
    await page.goto(fixture.origin)
    await expect(page.getByText('Connecting to your PC…', { exact: true })).toBeVisible()
    await expect.poll(() => fixture.apiRequests.filter(path => path === '/api/connection').length).toBe(1)
    const action = page.getByRole('button', { name: 'Import Anki package', exact: true })
    await action.scrollIntoViewIfNeeded()
    const before = await action.evaluate(element => element.getBoundingClientRect().top + scrollY)
    await page.exposeFunction('releasePcDiscovery', () => fixture.releaseDiscovery())
    await action.evaluate(element => element.addEventListener('pointerdown', () => {
      void (window as unknown as { releasePcDiscovery: () => Promise<void> }).releasePcDiscovery()
    }, { once: true }))
    await action.click({ delay: 300 })
    if (manual) await expect(page.getByText('Advanced PC connection', { exact: true })).toHaveCount(1)
    else await expect(page.getByText('Connected to your PC.', { exact: true })).toBeVisible()
    const after = await action.evaluate(element => element.getBoundingClientRect().top + scrollY)
    expect(after, 'connection discovery must not move the pressed import action').toBe(before)
    await expect(page.getByRole('dialog', { name: 'Import Anki package', exact: true })).toBeVisible()
  } finally { await fixture.close() }
})
}

test('the ordinary app preview cannot forward a spoofed private owner identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-browser-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  const backend = createServer(createSyncHttpHandler(service, { allowedOrigin: 'https://owner.example.test', trustedProxyUser: 'synthetic-owner@example.test' }))
  const origin = await listen(backend)
  const previousPort = process.env.KIROKU_SYNC_PORT
  let app: Awaited<ReturnType<typeof preview>> | undefined
  try {
    process.env.KIROKU_SYNC_PORT = new URL(origin).port
    app = await preview({ configFile: 'vite.config.ts', preview: { host: '127.0.0.1', port: 0, strictPort: true } })
    const address = app.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Preview did not bind')
    const headers = { 'tailscale-user-login': 'synthetic-owner@example.test' }
    expect((await fetch(`${origin}/api/connection`, { headers })).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${address.port}/api/connection`, { headers })).status).toBe(403)
    expect(service.listDevices()).toEqual([])
  } finally {
    if (previousPort === undefined) delete process.env.KIROKU_SYNC_PORT
    else process.env.KIROKU_SYNC_PORT = previousPort
    if (app) await close(app.httpServer)
    await close(backend)
    service.close()
    await removeFixture(directory)
  }
})

test('private app connects and reopens without any address or code, then opens AnkiWeb login', async ({ page, context, baseURL }, info) => {
  const fixture = await privateFixture(baseURL!)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(fixture.origin)
    await expect(page.getByText('Connected to your PC.', { exact: true })).toBeVisible()
    await openCollectionTools(page)
    await expect(page.getByText('Advanced PC connection', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Connect a PC', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('PC service address')).toHaveCount(0)
    await expect(page.getByLabel('One-time pairing code')).toHaveCount(0)
    expect(fixture.posts()).toBe(1)
    expect(fixture.service.listDevices()).toHaveLength(1)
    expect(fixture.apiRequests).not.toContain('/api/sync')
    await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
    await expect(page.getByLabel('AnkiWeb username')).toBeVisible()
    await expect(page.getByLabel('AnkiWeb username')).toBeFocused()
    await expect(page.getByLabel('AnkiWeb password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect account', exact: true })).toBeEnabled()
    await page.screenshot({ path: info.outputPath('automatic-pc-ankiweb-login.png'), fullPage: true })
    const reopened = await context.newPage()
    await reopened.goto(fixture.origin)
    await expect(reopened.getByText('Connected to your PC.', { exact: true })).toBeVisible()
    expect(fixture.posts()).toBe(1)
    expect(errors).toEqual([])
    await reopened.close()
  } finally { await fixture.close() }
})

test('private identity failure retries without losing local work or AnkiWeb fields', async ({ page, baseURL }) => {
  const fixture = await privateFixture(baseURL!)
  fixture.authorize(false)
  try {
    await page.goto(fixture.origin)
    await expect(page.getByText('Connect your private network, then retry.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New deck', exact: true }).click()
    await page.getByLabel('Deck name').fill('Local words')
    await page.getByRole('button', { name: 'Create deck', exact: true }).click()
    await page.getByRole('button', { name: 'Open Local words', exact: true }).click()
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill('猫')
    await page.getByLabel('Back', { exact: true }).fill('cat')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await page.getByRole('link', { name: 'Decks', exact: true }).click()
    await openCollectionTools(page)
    await expect(page.locator('.offline-storage-status')).toContainText(/[1-9]\d* changes waiting to sync/)
    const pending = (await page.locator('.offline-storage-status').textContent())!.match(/\d+ changes waiting to sync/)![0]
    await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
    await expect(page.getByRole('dialog').getByText(/Your private PC connection could not be confirmed/)).toBeVisible()
    await page.getByLabel('AnkiWeb username').fill('synthetic-account')
    await page.getByLabel('AnkiWeb password').fill('synthetic-password')
    await expect(page.getByRole('button', { name: 'Connect account', exact: true })).toBeDisabled()
    fixture.authorize(true)
    await page.getByRole('dialog').getByRole('button', { name: 'Retry PC connection', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect account', exact: true })).toBeEnabled()
    await expect(page.getByLabel('AnkiWeb username')).toHaveValue('synthetic-account')
    await expect(page.getByLabel('AnkiWeb password')).toHaveValue('synthetic-password')
    await expect(page.getByLabel('PC service address')).toHaveCount(0)
    await expect(page.getByLabel('One-time pairing code')).toHaveCount(0)
    expect(fixture.posts()).toBe(1)
    expect(fixture.apiRequests).not.toContain('/api/sync')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.offline-storage-status')).toContainText(pending)
    await page.getByRole('button', { name: 'Open Local words', exact: true }).click()
    await page.getByRole('link', { name: 'Browse', exact: true }).click()
    await expect(page.getByText('猫', { exact: true }).first()).toBeVisible()
  } finally { await fixture.close() }
})
