import { expect, test } from '@playwright/test'
import { createServer, request as proxyRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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

// This proxy supplies only synthetic authenticated transport identity. Every
// application/API response comes from the built app or the real SQLite service.
async function privateFixture(webOrigin: string) {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-browser-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  let backendOrigin = ''
  let authorized = true
  let connectionPosts = 0
  const apiRequests: string[] = []
  const proxy = createServer((incoming, response) => {
    const api = incoming.url?.startsWith('/api/') ?? false
    if (api) apiRequests.push(incoming.url!)
    if (incoming.url === '/api/connection' && incoming.method === 'POST') connectionPosts++
    const upstream = new URL(incoming.url ?? '/', api ? backendOrigin : webOrigin)
    const headers = { ...incoming.headers, host: upstream.host }
    delete headers['tailscale-user-login']
    if (api && authorized) headers['tailscale-user-login'] = 'synthetic-owner@example.test'
    const forwarded = proxyRequest(upstream, { method: incoming.method, headers }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.pipe(response)
    })
    forwarded.on('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(forwarded)
  })
  const origin = await listen(proxy)
  const backend = createServer(createSyncHttpHandler(service, { allowedOrigin: origin, trustedProxyUser: 'synthetic-owner@example.test' }))
  backendOrigin = await listen(backend)
  return {
    origin, service, apiRequests,
    posts: () => connectionPosts,
    authorize: (value: boolean) => { authorized = value },
    async close() {
      await close(proxy)
      await close(backend)
      service.close()
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), 'kiroku-private-browser-'))) throw new Error('Unexpected fixture path')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

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
    await expect(page.getByText(/Your private PC connection could not be confirmed/)).toBeVisible()
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
