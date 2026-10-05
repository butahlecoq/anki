import { expect, test, type Page } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'

const python = process.env.ANKI_TEST_PYTHON
const webURL = `http://127.0.0.1:${process.env.KIROKU_WEB_PORT ?? '4173'}`

async function port() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function ready(url: string, process: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error('AnkiWeb fixture exited before becoming ready')
    try { await fetch(url, { signal: AbortSignal.timeout(500) }); return } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  throw new Error('AnkiWeb fixture did not become ready')
}

async function localPcService(syncURL: string) {
  const runtime = mkdtempSync(join(tmpdir(), 'kiroku-account-e2e-'))
  const [{ createSyncService }, { createSyncHttpHandler }] = await Promise.all([
    import('../../dist-server/server/sync-service.js'), import('../../dist-server/server/sync-http.js'),
  ])
  const service = createSyncService({ databasePath: join(runtime, 'kiroku-sync.sqlite'), mediaDirectory: join(runtime, 'media') })
  const http = createHttpServer(createSyncHttpHandler(service, {
    allowedOrigin: webURL,
    ankiWebUpstream: (url, init) => fetch(`${syncURL}${new URL(String(url)).pathname.slice(1)}`, init),
  }))
  await new Promise<void>((resolve, reject) => http.listen(0, '127.0.0.1', () => resolve()).once('error', reject))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('PC service did not bind')
  return { url: `http://127.0.0.1:${address.port}`, runtime, async close() {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    service.close()
    rmSync(runtime, { recursive: true, force: true })
  } }
}

async function pair(page: Page, url: string, runtime: string) {
  const code = execFileSync(process.execPath, ['dist-server/server/index.js', '--pairing-code'], { env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: runtime }, windowsHide: true, stdio: 'pipe' }).toString().trim()
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  await page.getByLabel('PC service address').fill(url)
  await page.getByLabel('One-time pairing code').fill(code)
  await page.getByRole('button', { name: 'Connect device', exact: true }).click()
  await expect(page.getByText('PC connected. Your collections are ready to sync.', { exact: true })).toBeVisible()
}

test('downloads an official account snapshot, reviews its Import Plan, and studies the copied collection offline', async ({ page, context }) => {
  test.skip(!python, 'Set ANKI_TEST_PYTHON to an isolated Python environment with pinned anki==26.9.3')
  test.setTimeout(120_000)
  const fixture = mkdtempSync(join(tmpdir(), 'ankiweb-official-fixture-'))
  const syncPort = await port()
  const syncURL = `http://127.0.0.1:${syncPort}/`
  const username = `kiroku-${process.pid}-${Date.now()}`
  const password = 'generated-local-only'
  const seed = join(fixture, 'seed.py')
  writeFileSync(seed, `from anki.collection import Collection
from anki.scheduler_pb2 import CardAnswer
from datetime import datetime, timezone, timedelta
import sys
collection = Collection(sys.argv[1])
auth = collection.sync_login(sys.argv[3], sys.argv[4], sys.argv[2])
auth.endpoint = sys.argv[2]
deck = collection.decks.id('語彙::JLPT N5')
note = collection.new_note(collection.models.by_name('Basic'))
note.fields = ['猫', 'cat']
collection.add_note(note, deck)
card = collection.get_card(collection.db.scalar('select id from cards where nid = ?', note.id))
card.start_timer()
states = collection._backend.get_scheduling_states(card.id)
answer = collection.sched.build_answer(card=card, states=states, rating=CardAnswer.EASY)
answer.answered_at_millis = int((datetime.now(timezone.utc) - timedelta(days=8)).timestamp() * 1000)
collection.sched.answer_card(answer)
card = collection.get_card(card.id)
card.due = collection.sched.today
collection.update_card(card, skip_undo_entry=True)
collection.sync_collection(auth, False)
collection.full_upload_or_download(auth=auth, server_usn=None, upload=True)
collection.close()
`)
  const anki = spawn(python!, ['-m', 'anki.syncserver'], {
    env: { ...process.env, SYNC_USER1: `${username}:${password}`, SYNC_HOST: '127.0.0.1', SYNC_PORT: String(syncPort), SYNC_BASE: join(fixture, 'server') },
    stdio: 'ignore', windowsHide: true,
  })
  let pc: Awaited<ReturnType<typeof localPcService>> | undefined
  try {
    await ready(syncURL, anki)
    execFileSync(python!, [seed, join(fixture, 'seed.anki2'), syncURL, username, password], { windowsHide: true, stdio: 'pipe' })
    pc = await localPcService(syncURL)
    await page.goto(webURL)
    await pair(page, pc.url, pc.runtime)
    await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connect AnkiWeb' })
    await dialog.getByLabel('AnkiWeb username').fill(username)
    await dialog.getByLabel('AnkiWeb password').fill(password)
    await dialog.getByRole('button', { name: 'Connect account' }).click()
    await expect(dialog.getByRole('region', { name: 'AnkiWeb account decks' })).toContainText('語彙::JLPT N5', { timeout: 30_000 })
    await expect(dialog.getByText('No notes, cards, or study history were uploaded.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Preview account collection' }).click()
    const plan = dialog.getByRole('region', { name: 'Account Import Plan' })
    await expect(plan).toContainText('Account Import Plan · revision 1')
    await expect(plan).toContainText('2 Decks')
    await expect(plan).toContainText('1 note types')
    await expect(plan).toContainText('1 notes')
    await expect(plan).toContainText('1 cards')
    await expect(plan).toContainText('1 review entries')
    await plan.getByText(/Review all \d+ planned row changes/).click()
    await expect(plan).toContainText('note · create · anki-note:')
    await expect(plan).toContainText('card · create · anki-note:')
    await expect(plan).toContainText('review · create · anki-review:')
    await plan.getByRole('button', { name: 'Import reviewed collection to this device' }).click()
    await expect(dialog.getByRole('status')).toContainText('offline collection')
    await expect(dialog.getByRole('status')).toContainText(/no changes were uploaded/i)
    const persisted = await page.evaluate(async () => {
      const databases = await indexedDB.databases?.() ?? []
      const local = `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`
      const records: string[] = []
      let recordCount = 0
      const collect = (value: unknown) => {
        if (typeof value === 'string') records.push(value)
        else if (value instanceof ArrayBuffer) records.push(new TextDecoder().decode(value))
        else if (ArrayBuffer.isView(value)) records.push(new TextDecoder().decode(value as ArrayBufferView))
        else if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === 'object') Object.values(value).forEach(collect)
      }
      for (const { name } of databases) {
        if (!name) continue
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        for (const storeName of Array.from(database.objectStoreNames)) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const request = database.transaction(storeName).objectStore(storeName).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          recordCount += values.length
          values.forEach(collect)
        }
        database.close()
      }
      const scripts = await Promise.all(Array.from(document.scripts).filter((script) => script.src).map(async (script) => {
        try { return await (await fetch(script.src)).text() } catch { return '' }
      }))
      return { names: databases.map((database) => database.name ?? ''), recordCount, local, records: records.join('\n'), scripts: scripts.join('\n') }
    })
    expect(`${persisted.names.join('\n')}\n${persisted.local}\n${persisted.records}`).not.toContain(password)
    expect(`${persisted.names.join('\n')}\n${persisted.local}\n${persisted.records}`).not.toContain(username)
    expect(persisted.scripts).not.toContain(password)
    expect(persisted.scripts).not.toContain(username)
    expect(persisted.recordCount).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Disconnect' }).click()
    await expect(dialog.getByRole('status')).toContainText('downloaded account collection remains')
    const retainedStores = await page.evaluate(async () => (await indexedDB.databases?.() ?? []).map((database) => database.name ?? ''))
    expect(retainedStores).toEqual(persisted.names)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: /Open .*JLPT N5/ }).click()
    await expect(page.getByRole('button', { name: 'Study now' })).toBeEnabled()
    await expect(page.getByRole('group', { name: 'Deck counts' })).toContainText('REVIEW 1')
    await expect(page.getByRole('group', { name: 'Deck counts' })).toContainText('REVIEWS 1')
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Study now' }).click()
    await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
    await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText('猫')
    await page.getByRole('link', { name: 'Statistics', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Every answer adds up' })).toBeVisible()
    await page.getByLabel('Period', { exact: true }).selectOption('all')
    await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('1')
    await page.getByRole('link', { name: 'Browse', exact: true }).click()
    await page.getByLabel('Collection search', { exact: true }).fill('猫')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
  } finally {
    await pc?.close()
    if (anki.exitCode === null) {
      const exited = new Promise<void>((resolve) => anki.once('exit', () => resolve()))
      anki.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
    rmSync(fixture, { recursive: true, force: true })
  }
})
