import { expect, type BrowserContext, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'
import { nativeCanvasTest } from './phone-canvas'
import { openCollectionTools } from './collection-tools'
import { openOfflineProfileDocument, WEBKIT_COLD_OFFLINE_LIMITATION } from './offline-navigation'
import { releaseService } from './release-service'
import { releaseDiagnostics, releaseInventory, releaseLayout, releaseMedia, sha256 } from './release-oracles'

const test = nativeCanvasTest()
// DOM snapshot injection attempts scripts in deliberately script-free card frames.
test.use({ trace: { mode: 'on', snapshots: false, screenshots: true, sources: true } })

async function japaneseFixture() {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000260001, name: 'Release Japanese', fields: [{ name: 'Expression' }, { name: 'Meaning' }, { name: 'Media' }], templates: [{ name: 'Recognition', questionFormat: '{{Expression}}{{Media}}', answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }] })
  const root = new Deck({ id: 1700000260002, name: 'Release' })
  const child = new Deck({ id: 1700000260003, name: 'Release::日本語' })
  for (const [index, [front, back]] of [['猫', 'cat'], ['犬', 'dog'], ['鳥', 'bird']].entries()) child.addNote(new Note({ notetype: type, guid: `release-japanese-${index}`, fields: [front, back, '<img src="release.png">[sound:release.wav]'], tags: ['release', '日本語'] }))
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64')
  const audio = new Uint8Array(844)
  audio.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
  audio.fill(128, 44)
  const pkg = new Package()
  pkg.addDeck(root); pkg.addDeck(child)
  pkg.addMedia('release.png', image); pkg.addMedia('release.wav', audio)
  return { bytes: Buffer.from(await pkg.toUint8Array(SQL)), mediaDigests: [sha256(image), sha256(audio)].sort() }
}

async function importPackage(page: Page, buffer: Buffer, notes: number) {
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  await page.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'synthetic-release.apkg', mimeType: 'application/octet-stream', buffer })
  await expect(page.getByRole('region', { name: 'Package summary' })).toContainText(`${notes} notes`, { timeout: 15000 })
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Import/ })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open 日本語', exact: true })).toBeVisible()
}

async function navigate(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).filter({ visible: true }).first().click()
}

async function exportPackage(page: Page, info: TestInfo, phase: string) {
  await navigate(page, 'Decks')
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Export Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Anki package' })
  const started = Date.now()
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    console.log(`release-export ${JSON.stringify({ project: info.project.name, phase, event, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, ...detail })}`)
  }
  record('started')
  try {
    // Observe native delivery before clicking, and require the public result
    // independently. A missing event alone cannot identify preparation failure.
    const [download] = await Promise.all([
      page.waitForEvent('download').then(value => {
        record('download-created', { filename: value.suggestedFilename() })
        return value
      }),
      (async () => {
        await dialog.getByRole('button', { name: 'Download package', exact: true }).click()
        await expect(dialog.getByRole('status')).toContainText('Package ready:')
        record('package-ready', { message: await dialog.getByRole('status').innerText() })
      })(),
    ])
    const path = await download.path()
    expect(path).not.toBeNull()
    const bytes = await readFile(path!)
    record('download-read', { bytes: bytes.length, sha256: sha256(bytes) })
    await dialog.getByRole('button', { name: 'Close export' }).click()
    return bytes
  } catch (error) {
    const state = await dialog.evaluate(element => {
      const button = [...element.querySelectorAll('button')].find(candidate => ['Download package', 'Preparing package…'].includes(candidate.textContent?.trim() ?? ''))
      return {
        busy: button?.disabled ?? null,
        button: button?.textContent?.trim() ?? null,
        status: element.querySelector('[role="status"]')?.textContent ?? null,
        alerts: [...element.querySelectorAll('[role="alert"]')].map(alert => alert.textContent ?? ''),
      }
    }).catch(observationError => ({ unavailable: String(observationError), pageClosed: page.isClosed() }))
    // A closed/ended page may prevent this secondary observation. Preserve
    // that limit in the log and always rethrow the original export failure.
    record('failed', { error: String(error), dialog: state })
    throw error
  }
}

test('production release collection survives two offline reopenings and converges after restoration', async ({ browser, browserName, viewport, isMobile, deviceScaleFactor, hasTouch, userAgent }, info) => {
  test.setTimeout(240000)
  const started = Date.now()
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
  const baseURL = String(info.project.use.baseURL)
  const origin = new URL(baseURL).origin
  const service = await releaseService(origin, commit)
  const diagnostics = releaseDiagnostics(service.url)
  const profile = await mkdtemp(join(tmpdir(), 'kiroku-release-profile-'))
  const options = { baseURL, viewport, isMobile, deviceScaleFactor, hasTouch, userAgent, acceptDownloads: true }
  const contexts = new Set<BrowserContext>()
  const phases: Array<{ name: string; geometry: unknown; elapsedMs: number; screenshotFullPage: boolean }> = []
  const limitation = browserName === 'webkit' ? [WEBKIT_COLD_OFFLINE_LIMITATION, 'WebKit warm offline coverage aborts HTTP(S) requests while the actual PC service is stopped. setOffline(true) incorrectly rejects local SVG blob icons in native audio controls; no global network-disable or physical-iPhone result is inferred.', 'Automated audio source retention does not establish audible physical-iPhone playback. Windows WebKit has no audio backend.'] : []
  const networkRequests = /^https?:/
  const rejectNetwork = (route: Route) => route.abort('internetdisconnected')
  let active: BrowserContext | undefined
  const createClient = async (persistent = false, offline = false) => {
    const context = persistent
      ? await browser.browserType().launchPersistentContext(profile, { ...options, offline })
      : await browser.newContext({ ...options, offline })
    contexts.add(context)
    const page = context.pages()[0] ?? await context.newPage()
    diagnostics.observe(page)
    return { context, page }
  }
  const closeClient = async (context: BrowserContext) => {
    try { await context.close() }
    finally { contexts.delete(context) }
  }
  const checkpoint = async (page: Page, name: string, offline = false) => {
    diagnostics.phase(name, offline)
    const geometry = await releaseLayout(page)
    // Windows WebKit's full-page clip uses CSS bounds in a host-scaled backing
    // canvas. The colored-marker control loses the right marker in fullPage
    // and retains it in a calibrated viewport capture, with no layout resize.
    const screenshotFullPage = process.platform !== 'win32' || browserName !== 'webkit'
    phases.push({ name, geometry, elapsedMs: Date.now() - started, screenshotFullPage })
    if (await page.locator('iframe[title="Review card"]').count()) {
      // DOM/media assertions can precede the card's fitted, painted frame.
      // Observe readiness from the parent: callbacks inside the script-free
      // child's realm do not complete in the retained negative control.
      await expect.poll(() => page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Review card"]')
        return !!frame?.style.height && frame.contentDocument?.readyState === 'complete' && frame.contentDocument.fonts.status === 'loaded'
      })).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      // Retain a close-up using the native locator capture, which also waits
      // for the actual frame bounds to settle before the whole-page image.
      if (browserName === 'chromium') await page.locator('iframe[title="Review card"]').screenshot({ path: info.outputPath(`${name}-card.png`) })
    }
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: screenshotFullPage })
    await diagnostics.assertClean()
  }
  const pair = async (page: Page) => {
    await navigate(page, 'Decks')
    await openCollectionTools(page)
    await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
    await page.getByLabel('PC service address').fill(service.url)
    await page.getByLabel('One-time pairing code').fill(await service.pairingCode())
    await page.getByRole('button', { name: 'Connect device', exact: true }).click()
    await expect(page.getByText('PC connected. Your collections are ready to sync.')).toBeVisible()
  }
  const sync = async (page: Page) => {
    await navigate(page, 'Decks')
    await openCollectionTools(page)
    await page.getByRole('button', { name: 'Sync now', exact: true }).click()
    await expect(page.getByRole('region', { name: 'PC sync' }).getByText(/complete\./i)).toBeVisible({ timeout: 20000 })
  }
  const openJapanese = async (page: Page) => {
    await navigate(page, 'Decks')
    await page.getByRole('button', { name: 'Open 日本語', exact: true }).click()
    await expect(page.getByRole('heading', { name: '日本語', exact: true, level: 1 })).toBeVisible()
  }
  const search = async (page: Page, query: string) => {
    await navigate(page, 'Browse')
    await page.getByLabel('Collection search', { exact: true }).fill(query)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
  }
  try {
    const health = await service.start()
    expect(health.build).toMatchObject({ commit, release: true })
    let client = await createClient(browserName === 'chromium')
    active = client.context
    let page = client.page
    await page.goto('/')
    await diagnostics.retainNativeFrames(page)
    await expect(page.getByRole('heading', { name: 'Start with one deck' })).toBeVisible()
    await checkpoint(page, '01-onboarding')
    await page.locator('.build-identity summary').click()
    await expect(page.locator('.build-identity dd').nth(1)).toHaveText(commit)
    await expect(page.locator('.build-identity')).toContainText('Release build')
    await checkpoint(page, '01-build-identity')
    await page.locator('.build-identity summary').click()
    const manifestPath = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifestPath).toBeTruthy()
    const manifest = await (await page.request.get(new URL(manifestPath!, page.url()).href)).json()
    expect(manifest.kiroku).toEqual({ version: health.build.version, commit })
    const fixture = await japaneseFixture()
    await importPackage(page, fixture.bytes, 3)
    await page.getByRole('button', { name: 'Open 日本語', exact: true }).scrollIntoViewIfNeeded()
    await checkpoint(page, '02-decks')
    // A learner-created note goes through the ordinary editor, then is reviewed
    // before export so every card has a real, preserved scheduling instant.
    await page.getByRole('button', { name: 'New deck', exact: true }).click()
    await page.getByLabel('Deck name', { exact: true }).fill('手作り')
    await page.getByRole('button', { name: 'Create deck', exact: true }).click()
    await page.getByRole('button', { name: 'Open 手作り', exact: true }).click()
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await page.getByLabel('Front', { exact: true }).fill('学ぶ')
    await page.getByLabel('Back', { exact: true }).fill('learn')
    await checkpoint(page, '02-editor')
    if (browserName === 'webkit') {
      await page.getByRole('button', { name: 'Save note', exact: true }).scrollIntoViewIfNeeded()
      await checkpoint(page, '02-editor-actions')
    }
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await page.getByRole('button', { name: 'Study now', exact: true }).click()
    await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText('学ぶ')
    await page.getByRole('button', { name: 'Show answer', exact: true }).click()
    await page.getByRole('button', { name: /^Good ·/ }).click()
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to deck' }).click()
    await pair(page)
    await sync(page)
    await checkpoint(page, '03-sync')
    const second = await createClient()
    await second.page.goto('/')
    await diagnostics.retainNativeFrames(second.page)
    await pair(second.page)
    await sync(second.page)
    await openJapanese(page)
    const deckURL = page.url()
    await page.getByRole('button', { name: 'Study now', exact: true }).click()
    await releaseMedia(page, browserName)
    await checkpoint(page, '04-question')
    await page.getByRole('button', { name: 'Show answer', exact: true }).click()
    await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText(/cat|dog|bird/)
    await checkpoint(page, '05-answer')
    await page.getByRole('button', { name: /^Good ·/ }).click()
    await page.getByRole('button', { name: 'End session', exact: true }).click()
    await sync(page)
    await sync(second.page)
    await openJapanese(page)
    await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
    // Warm the actual export module before WebKit's supported warm offline stage;
    // Chromium also verifies these bytes again after its second cold reopening.
    const beforeOffline = await releaseInventory(await exportPackage(page, info, 'online-warm-up'))
    expect(beforeOffline.media.map(media => media.digest).sort()).toEqual(fixture.mediaDigests)
    await openJapanese(page)
    if (browserName === 'chromium') await page.evaluate(async () => { await navigator.serviceWorker.ready })
    diagnostics.phase('offline-first-reopening', true)
    await service.stop()
    await expect.poll(async () => {
      try { await fetch(`${service.url}/api/health`, { signal: AbortSignal.timeout(500) }); return false } catch { return true }
    }, { message: 'test-owned service must actually be unavailable' }).toBe(true)
    if (browserName === 'chromium') {
      await closeClient(active)
      client = await createClient(true, true); active = client.context; page = client.page
      await openOfflineProfileDocument(page, deckURL)
    } else {
      // The reduced native-widget control reproduces WebKit's setOffline blob
      // failure without the app. Abort network transport, preserving local
      // icon blobs; every application/media failure remains a fatal diagnostic.
      await active.route(networkRequests, rejectNetwork)
    }
    const japaneseDeckCounts = page.getByRole('heading', { name: '日本語', exact: true, level: 1 })
      .locator('xpath=..')
      .getByRole('group', { name: 'Deck counts' })
    await expect(japaneseDeckCounts.getByText('NEW 2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Study now', exact: true }).click()
    for (let index = 0; index < 2; index++) {
      await releaseMedia(page, browserName)
      await page.getByRole('button', { name: 'Show answer', exact: true }).click()
      await page.getByRole('button', { name: /^Good ·/ }).click()
    }
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to deck' }).click()
    await search(page, '猫')
    await expect(page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: /^Select card / }).check()
    await page.getByRole('button', { name: 'Find / replace / edit', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Find, replace, or edit fields' })
    await editor.getByLabel('Field', { exact: true }).selectOption({ label: 'Release Japanese · Meaning' })
    await editor.getByLabel('Find', { exact: true }).fill('cat')
    await editor.getByLabel('Replacement', { exact: true }).fill('cat · ねこ · offline edit')
    await editor.getByRole('button', { name: 'Preview changes', exact: true }).click()
    await expect(editor.getByRole('textbox', { name: 'After', exact: true })).toHaveValue('cat · ねこ · offline edit')
    await editor.getByRole('checkbox', { name: 'I reviewed this preview and want to apply these field changes.' }).check()
    await editor.getByRole('button', { name: 'Apply field changes' }).click()
    await search(page, '"offline edit"')
    await expect(page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '猫', exact: true }).scrollIntoViewIfNeeded()
    await checkpoint(page, '06-offline-browse', true)
    await navigate(page, 'Statistics')
    const answers = page.getByRole('region', { name: 'Period totals', exact: true }).locator('article').first().locator('strong')
    await expect(answers).toHaveText('4')
    await answers.scrollIntoViewIfNeeded()
    await checkpoint(page, '07-offline-statistics', true)
    const offlineInventory = await releaseInventory(await exportPackage(page, info, 'offline-first-reopening'))
    expect(offlineInventory.reviews).toHaveLength(4)
    expect(offlineInventory.media.map(media => media.digest).sort()).toEqual(fixture.mediaDigests)
    if (browserName === 'chromium') {
      await closeClient(active)
      client = await createClient(true, true); active = client.context; page = client.page
      await openOfflineProfileDocument(page, `${baseURL}/#statistics`)
      await expect(page.getByRole('region', { name: 'Period totals', exact: true }).locator('article').first().locator('strong')).toHaveText('4')
      await search(page, '"offline edit"')
      await expect(page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
      // Browse's edit dialog has no rendered-media preview. Use the visible
      // custom-practice surface to view the retained card without changing its
      // schedule or adding a review. This happens while both transports are down.
      await navigate(page, 'Study')
      await page.getByLabel('Session name', { exact: true }).fill('Second reopening media')
      await page.getByLabel('Session search', { exact: true }).fill('猫')
      await page.getByRole('button', { name: 'Preview session', exact: true }).click()
      await expect(page.getByRole('heading', { name: '1 cards selected from 1 matches' })).toBeVisible()
      await page.getByRole('button', { name: 'Create session', exact: true }).click()
      await page.getByRole('button', { name: 'Study Second reopening media', exact: true }).click()
      await releaseMedia(page, browserName)
      await page.getByRole('button', { name: 'Show answer', exact: true }).click()
      await expect(page.frameLocator('iframe[title="Review card"]').locator('body')).toContainText('cat · ねこ · offline edit')
      await checkpoint(page, '08-second-offline-reopening', true)
      await page.getByRole('button', { name: 'End session', exact: true }).click()
      await page.getByRole('button', { name: 'Delete Second reopening media', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
      expect(await releaseInventory(await exportPackage(page, info, 'offline-second-reopening'))).toEqual(offlineInventory)
    }
    diagnostics.phase('reconnect')
    expect((await service.start()).build).toEqual(health.build)
    if (browserName === 'webkit') await active.unroute(networkRequests, rejectNetwork)
    else await active.setOffline(false)
    await sync(page)
    await sync(second.page)
    await second.page.reload()
    await diagnostics.retainNativeFrames(second.page)
    await search(second.page, '"offline edit"')
    await expect(second.page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
    const exported = await exportPackage(page, info, 'reconnected-primary')
    const expected = await releaseInventory(exported)
    expect(expected).toEqual(offlineInventory)
    expect(expected.notes).toHaveLength(4)
    expect(expected.cards).toHaveLength(4)
    expect(expected.reviews).toHaveLength(4)
    expect(expected.decks.map(deck => deck.name.replaceAll('\u001f', '::'))).toEqual(expect.arrayContaining(['Release', 'Release::日本語', '手作り']))
    expect(expected.media.map(media => media.digest).sort()).toEqual(fixture.mediaDigests)
    expect(await releaseInventory(await exportPackage(second.page, info, 'reconnected-second-client'))).toEqual(expected)
    await second.page.getByRole('button', { name: 'Open 日本語', exact: true }).scrollIntoViewIfNeeded()
    await checkpoint(second.page, '09-converged-receiver')
    const restored = await createClient()
    await restored.page.goto('/')
    await diagnostics.retainNativeFrames(restored.page)
    await importPackage(restored.page, exported, 4)
    await restored.page.reload()
    await diagnostics.retainNativeFrames(restored.page)
    await search(restored.page, '"offline edit"')
    await expect(restored.page.getByRole('button', { name: '猫', exact: true })).toBeVisible()
    expect(await releaseInventory(await exportPackage(restored.page, info, 'restored-clean-client'))).toEqual(expected)
    await restored.page.getByRole('button', { name: 'Open 日本語', exact: true }).scrollIntoViewIfNeeded()
    await checkpoint(restored.page, '10-exported-restored')
    await info.attach('release-inventory', { body: JSON.stringify(expected, null, 2), contentType: 'application/json' })
    await info.attach('release-fixture', { body: fixture.bytes, contentType: 'application/octet-stream' })
    await info.attach('release-build', { body: JSON.stringify({ commit, build: health.build, browser: browser.version(), browserName, project: info.project.name, configuredViewport: viewport, phases, fixtureSha256: sha256(fixture.bytes), fixtureMediaDigests: fixture.mediaDigests, durationMs: Date.now() - started, limitations: limitation, physicalIPhone: 'UNVERIFIED: see docs/offline-verification.md and issue #24' }, null, 2), contentType: 'application/json' })
    await diagnostics.assertClean()
  } finally {
    await info.attach('release-run', { body: JSON.stringify({ expectedCommit: commit, browser: browser.version(), browserName, project: info.project.name, configuredViewport: viewport, phases, durationMs: Date.now() - started, limitations: limitation, physicalIPhone: 'UNVERIFIED: see docs/offline-verification.md and issue #24' }, null, 2), contentType: 'application/json' })
    await diagnostics.attach(info)
    await info.attach('release-service-log', { body: service.logs(), contentType: 'text/plain' })
    try { for (const context of contexts) await closeClient(context) }
    finally {
      try { await service.dispose() }
      finally { await rm(profile, { recursive: true, force: true }) }
    }
  }
})
