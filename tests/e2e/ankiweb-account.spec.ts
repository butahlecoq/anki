import { expect, test, type Page } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'

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
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64')
  const otherImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOrkAAAAASUVORK5CYII=', 'base64')
  const wav = Buffer.from([0x52,0x49,0x46,0x46,0x25,0,0,0,0x57,0x41,0x56,0x45,0x66,0x6d,0x74,0x20,16,0,0,0,1,0,1,0,0x40,0x1f,0,0,0x40,0x1f,0,0,1,0,8,0,0x64,0x61,0x74,0x61,1,0,0,0,0x80])
  const media = new Map([['cat.png', image], ['template.png', image], ['answer.png', image], ['template-bg.png', otherImage], ['cat.wav', wav]])
  const changes = [...media].map(([name, bytes], index) => [name, index + 1, createHash('sha1').update(bytes).digest('hex')])
  let mediaChangesRead = false
  let downloadIndex = 0
  let metadataFailurePending = true
  const http = createHttpServer(createSyncHttpHandler(service, {
    allowedOrigin: webURL,
    ankiWebUpstream: async (url, init) => {
      const route = new URL(String(url)).pathname.slice(1)
      if (route === 'msync/begin') return Response.json({ data: { usn: changes.length } })
      if (route === 'msync/mediaChanges') {
        if (mediaChangesRead) return Response.json({ data: [] })
        mediaChangesRead = true
        return Response.json({ data: changes })
      }
      if (route === 'msync/downloadFiles') {
        const [name, bytes] = [...media][downloadIndex++] ?? []
        if (!name || !bytes) return new Response('Missing fixture media', { status: 404 })
        const zip = zipSync({ '0': new Uint8Array(bytes), _meta: strToU8(JSON.stringify({ 0: name })) }, { level: 0 })
        return new Response(zip, { headers: { 'content-type': 'application/zip' } })
      }
      if (route === 'msync/mediaSanity') return Response.json({ data: 'OK' })
      if (route === 'msync/uploadChanges') return Response.json({ data: [0, changes.length] })
      if (route === 'sync/meta') {
        const request = new Request(`${syncURL}${route}`, init)
        const form = await request.clone().formData()
        const payload = JSON.parse(String(form.get('data'))) as { cv: string }
        // Production rejects an unrecognized client family; the official
        // self-hosted fixture alone does not enforce that requirement.
        if (payload.cv.split(',')[0] !== 'anki') return new Response('400', { status: 400 })
        if (metadataFailurePending) {
          metadataFailurePending = false
          return new Response('metadata temporarily unavailable', { status: 400 })
        }
        return fetch(request)
      }
      return fetch(`${syncURL}${route}`, init)
    },
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

for (const launch of ['current session', 'fresh document']) {
  test(`downloads an official account snapshot, reviews its Import Plan, and studies the copied collection offline in the ${launch}`, async ({ page, context }, testInfo) => {
    test.skip(launch === 'fresh document' && test.info().project.name === 'iphone-webkit', 'AnkiWeb cold-offline media persistence is currently verified in desktop Chromium; WebKit is recorded as a skip, not a pass')
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
from base64 import b64decode
collection = Collection(sys.argv[1])
auth = collection.sync_login(sys.argv[3], sys.argv[4], sys.argv[2])
auth.endpoint = sys.argv[2]
deck = collection.decks.id('語彙::JLPT N5')
image = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==')
other_image = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOrkAAAAASUVORK5CYII=')
wav = bytes([0x52,0x49,0x46,0x46,0x25,0,0,0,0x57,0x41,0x56,0x45,0x66,0x6d,0x74,0x20,16,0,0,0,1,0,1,0,0x40,0x1f,0,0,0x40,0x1f,0,0,1,0,8,0,0x64,0x61,0x74,0x61,1,0,0,0,0x80])
collection.media.write_data('cat.png', image)
collection.media.write_data('template.png', image)
collection.media.write_data('answer.png', image)
collection.media.write_data('template-bg.png', other_image)
collection.media.write_data('cat.wav', wav)
basic = collection.models.by_name('Basic')
basic['tmpls'][0]['qfmt'] = '<img src="template.png">{{Front}}'
basic['tmpls'][0]['afmt'] = '{{FrontSide}}<img src="answer.png">{{Back}}'
basic['css'] += '\\n.card { background-image: url("template-bg.png"); }'
collection.models.update(basic)
note = collection.new_note(collection.models.by_name('Basic'))
note.fields = ['<img src="cat.png">猫', '[sound:cat.wav] cat']
collection.add_note(note, deck)
unsupported_type = collection.models.copy(collection.models.by_name('Basic'), add=False)
unsupported_type['name'] = 'Unsupported custom filters'
unsupported_type['tmpls'][0]['qfmt'] = '<script>ignored()</script>{{Front}}'
collection.models.add(unsupported_type)
unsupported_note = collection.new_note(unsupported_type)
unsupported_note.fields = ['unsafe template front', 'answer not imported']
collection.add_note(unsupported_note, deck)
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
collection.sync_media(auth)
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
      await page.getByRole('button', { name: 'New deck', exact: true }).click()
      await page.getByLabel('Deck name', { exact: true }).fill('Local work')
      await page.getByRole('button', { name: 'Create deck', exact: true }).click()
      await page.getByRole('button', { name: 'Open Local work', exact: true }).click()
      await page.getByRole('button', { name: 'Add note', exact: true }).click()
      const localNote = page.getByRole('dialog', { name: 'Add a Basic note', exact: true })
      await localNote.getByLabel('Front', { exact: true }).fill('Retain me')
      await localNote.getByLabel('Back', { exact: true }).fill('Non-sensitive local work')
      await localNote.getByRole('button', { name: 'Save note', exact: true }).click()
      await expect(localNote).not.toBeVisible()
      await page.getByRole('link', { name: 'Browse', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Retain me', exact: true })).toBeVisible()
      const localCardIdentity = await page.getByRole('checkbox', { name: /^Select card / }).getAttribute('aria-label')
      await pair(page, pc.url, pc.runtime)
      await page.getByTestId('offline-storage-summary').click()
      const inventory = page.getByText(/notes · .* cards · .* media files.*changes waiting to sync/)
      await expect(inventory).toBeVisible()
      const pendingLocalWork = await inventory.innerText()
      await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Connect AnkiWeb' })
      await dialog.getByLabel('AnkiWeb username').fill(username)
      await dialog.getByLabel('AnkiWeb password').fill(password)
      await dialog.getByRole('button', { name: 'Connect account' }).click()
      await expect(dialog.getByRole('status')).toContainText('collection check')
      await expect(dialog.getByRole('status')).toContainText('HTTP 400; sync/meta')
      await expect(dialog.getByRole('status')).toContainText('AnkiWeb rejected collection check')
      await expect(dialog.getByRole('status')).toContainText('App build:')
      await expect(dialog.getByRole('status')).not.toContainText(password)
      await expect(dialog.getByLabel('AnkiWeb password')).toHaveValue('')
      await dialog.getByRole('status').scrollIntoViewIfNeeded()
      await expect(dialog.getByRole('status')).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath('account-metadata-failure.png') })
      await testInfo.attach('account-ui-viewport', {
        contentType: 'application/json',
        body: JSON.stringify({ configured: page.viewportSize(), ...await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })) }),
      })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(inventory).toHaveText(pendingLocalWork)
      await page.reload()
      await expect(page.getByRole('button', { name: 'Retain me', exact: true })).toBeVisible()
      await expect(page.getByRole('checkbox', { name: localCardIdentity!, exact: true })).toBeVisible()
      await page.getByTestId('offline-storage-summary').click()
      await expect(inventory).toHaveText(pendingLocalWork)
      await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
      await dialog.getByLabel('AnkiWeb username').fill(username)
      await dialog.getByLabel('AnkiWeb password').fill(password)
      await dialog.getByRole('button', { name: 'Connect account' }).click()
      await expect(dialog.getByRole('region', { name: 'AnkiWeb account decks' })).toContainText('語彙::JLPT N5', { timeout: 30_000 })
      await expect(inventory).toHaveText(pendingLocalWork)
      await expect(dialog.getByText('No notes, cards, or study history were uploaded.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Download and verify account media' }).click()
      await expect(dialog.getByRole('region', { name: 'Account media' })).toContainText('5 verified files stored on this device')
      await dialog.getByRole('button', { name: 'Preview account collection' }).click()
      const plan = dialog.getByRole('region', { name: 'Account Import Plan' })
      await expect(plan).toContainText('Account Import Plan · revision 1')
      await expect(plan).toContainText('2 Decks')
      await expect(plan).toContainText('1 note types')
      await expect(plan).toContainText('1 notes')
      await expect(plan).toContainText('1 cards')
      await expect(plan).toContainText('1 review entries')
      await expect(plan).toContainText('3 media files')
      await expect(plan).toContainText('Unsupported custom filters')
      await expect(plan.getByRole('button', { name: 'Import reviewed collection to this device' })).toBeDisabled()
      await expect(plan.getByRole('region', { name: 'Skipped import rows' })).toContainText('Executable or embedded template markup is unsupported')
      await plan.getByText(/Review all \d+ planned row changes/).click()
      await expect(plan).toContainText('note · create · anki-note:')
      await expect(plan).toContainText('card · create · anki-note:')
      await expect(plan).toContainText('review · create · anki-review:')
      await plan.getByText(/Import 1 representable notes and skip 1 unsupported notes/).click()
      await expect(plan.getByRole('button', { name: 'Import representable notes to this device' })).toBeEnabled()
      await plan.getByRole('button', { name: 'Import representable notes to this device' }).click()
      await expect(dialog.getByText(/The representable portion is available in this device’s offline collection/i)).toBeVisible()
      await dialog.getByText(/The representable portion is available in this device’s offline collection/i).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('account-copy-retained-local-work.png') })
      await expect(plan.getByText(/no changes were uploaded/i)).toBeVisible()
      await expect(dialog.getByRole('region', { name: 'Skipped import rows' })).toContainText('Executable or embedded template markup is unsupported')
      await dialog.getByRole('button', { name: 'Preview account collection' }).click()
      const refreshedPlan = dialog.getByRole('region', { name: 'Account Import Plan' })
      await expect(refreshedPlan).toContainText('saved representable-only choice')
      await expect(refreshedPlan.getByRole('region', { name: 'Skipped import rows' })).toContainText('Executable or embedded template markup is unsupported')
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
      await expect(dialog).not.toBeVisible()
      await expect(page.getByRole('button', { name: 'Retain me', exact: true })).toBeVisible()
      await expect(page.getByRole('checkbox', { name: localCardIdentity!, exact: true })).toBeVisible()
      await page.getByRole('link', { name: 'Decks', exact: true }).click()
      await page.getByRole('button', { name: /Open .*JLPT N5/ }).click()
      await expect(page.getByRole('button', { name: 'Study now' })).toBeEnabled()
      await expect(page.getByRole('group', { name: 'Deck counts' })).toContainText('REVIEW 1')
      await expect(page.getByRole('group', { name: 'Deck counts' })).toContainText('REVIEWS 1')
      await pc.close()
      pc = undefined
      await context.setOffline(true)
      await page.getByRole('button', { name: 'Study now' }).click()
      await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
      const card = page.frameLocator('iframe[title="Review card"]')
      await expect(card.locator('body')).toContainText('猫')
      await expect(card.locator('img').first()).toHaveAttribute('src', /^data:image\/png;base64,/)
      await page.getByRole('button', { name: 'Show answer' }).click()
      await expect(card.locator('audio').first()).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      if (launch === 'fresh document') {
        await page.reload()
        await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible()
        const restartedCard = page.frameLocator('iframe[title="Review card"]')
        await expect(restartedCard.locator('img').first()).toHaveAttribute('src', /^data:image\/png;base64,/)
        await page.getByRole('button', { name: 'Show answer' }).click()
        await expect(restartedCard.locator('audio').first()).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      }
      await page.getByRole('link', { name: 'Statistics', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Every answer adds up' })).toBeVisible()
      await page.getByLabel('Period', { exact: true }).selectOption('all')
      await expect(page.getByText('ANSWERS', { exact: true }).locator('..').locator('strong')).toHaveText('1')
      await page.getByRole('link', { name: 'Browse', exact: true }).click()
      await page.getByLabel('Collection search', { exact: true }).fill('猫')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(page.getByRole('button', { name: /猫/ }).first()).toBeVisible()
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
}
