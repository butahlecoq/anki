import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createSyncService } from './sync-service.js'
import { createSyncHttpHandler } from './sync-http.js'
import { startSyncServer } from './index.js'

test('the authenticated private owner connects without a code and receives a working device credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-connect-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  const options = { allowedOrigin: 'https://owner.example.test', trustedProxyUser: 'owner@example.test' }
  const server = createServer(createSyncHttpHandler(service, options))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const headers = { origin: options.allowedOrigin, 'tailscale-user-login': options.trustedProxyUser, 'content-type': 'application/json' }
    const discovery = await fetch(`${endpoint}/api/connection`, { headers })
    assert.equal(discovery.status, 200)
    assert.deepEqual(await discovery.json(), { automatic: true })
    const connected = await fetch(`${endpoint}/api/connection`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'owner-browser' }) })
    assert.equal(connected.status, 201)
    const credential = await connected.json() as { token: string; collectionGeneration: string }
    assert.ok(credential.token && credential.collectionGeneration)
    assert.equal((await fetch(`${endpoint}/api/backups`, { headers })).status, 401)
    const backups = await fetch(`${endpoint}/api/backups`, { headers: { authorization: `Bearer ${credential.token}` } })
    assert.equal(backups.status, 200)
    service.revokeDevice('owner-browser')
    assert.equal((await fetch(`${endpoint}/api/backups`, { headers: { authorization: `Bearer ${credential.token}` } })).status, 401)
    assert.equal((await fetch(`${endpoint}/api/connection`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'owner-browser' }) })).status, 401)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('automatic connection remains disabled unless the owner and app origin are both configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-disabled-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  try {
    for (const options of [{}, { allowedOrigin: 'https://owner.example.test' }, { trustedProxyUser: 'owner@example.test' }]) {
      const server = createServer(createSyncHttpHandler(service, options))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const endpoint = `http://127.0.0.1:${address.port}/api/connection`
      try {
        assert.deepEqual(await (await fetch(endpoint)).json(), { automatic: false })
        assert.equal((await fetch(endpoint, { method: 'POST', headers: { origin: 'https://owner.example.test', 'tailscale-user-login': 'owner@example.test' }, body: JSON.stringify({ deviceId: 'must-not-connect' }) })).status, 403)
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    }
    assert.deepEqual(service.listDevices(), [])
  } finally {
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('automatic connection rejects unsafe network binding even when a proxy identity is configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-bind-'))
  try {
    const options = { runtimeDirectory: directory, host: '0.0.0.0', port: 0, allowedOrigin: 'https://owner.example.test', trustedProxyUser: 'owner@example.test' }
    await assert.rejects(startSyncServer(options), /Automatic connection requires a loopback backend/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('automatic connection cannot grant a credential without the configured identity and exact app origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiroku-private-reject-'))
  const service = createSyncService({ databasePath: join(directory, 'collection.sqlite') })
  const options = { allowedOrigin: 'https://owner.example.test', trustedProxyUser: 'owner@example.test' }
  const server = createServer(createSyncHttpHandler(service, options))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}`
  const valid = { origin: options.allowedOrigin, 'tailscale-user-login': options.trustedProxyUser, 'content-type': 'application/json' }
  try {
    const rejectedHeaders: Record<string, string>[] = [
      { origin: options.allowedOrigin },
      { ...valid, 'tailscale-user-login': 'other@example.test' },
      { 'tailscale-user-login': options.trustedProxyUser },
      { ...valid, origin: 'https://untrusted.example.test' },
    ]
    for (const headers of rejectedHeaders) {
      const response = await fetch(`${endpoint}/api/connection`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'must-not-connect' }) })
      assert.equal(response.status, 403)
    }
    for (const deviceId of ['', 'x'.repeat(129), 'bad\u0000id', 4]) {
      assert.equal((await fetch(`${endpoint}/api/connection`, { method: 'POST', headers: valid, body: JSON.stringify({ deviceId }) })).status, 400)
    }
    assert.equal((await fetch(`${endpoint}/api/connection`, { method: 'POST', headers: valid, body: JSON.stringify({ deviceId: 'x'.repeat(5000) }) })).status, 413)
    assert.deepEqual(service.listDevices(), [])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
