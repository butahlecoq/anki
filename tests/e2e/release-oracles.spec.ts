import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import initSqlJs from 'sql.js'
import { Collection as AnkiCollection, Deck, Note, Notetype, Package, type CollectionData } from 'ankipack'
import { releaseDiagnostics, releaseInventory, releaseLayout, releaseMedia } from './release-oracles'

test('release diagnostics reject severe console errors independently', async ({ page }, info) => {
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  diagnostics.phase('synthetic-negative-control')
  await page.setContent('<main><h1>Diagnostic negative control</h1></main>')
  diagnostics.assertClean()
  const logged = page.waitForEvent('console', message => message.type() === 'error')
  await page.evaluate(() => { console.error('release-negative-console') })
  await logged
  expect(() => diagnostics.assertClean()).toThrow()
  await diagnostics.attach(info)
})

test('release diagnostics reject uncaught exceptions independently', async ({ page }, info) => {
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  await page.setContent('<main><h1>Uncaught negative control</h1></main>')
  diagnostics.assertClean()
  const thrown = page.waitForEvent('pageerror')
  await page.evaluate(() => { setTimeout(() => { throw new Error('release-negative-uncaught') }, 0) })
  await thrown
  expect(() => diagnostics.assertClean()).toThrow()
  await diagnostics.attach(info)
})

test('release diagnostics reject required HTTP and network failures and accept a healthy document', async ({ page }, info) => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-type': 'text/html' })
    response.end('<main><h1>Owned transport negative control</h1></main>')
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No negative-control address')
  const url = `http://127.0.0.1:${address.port}`
  let stopped = false
  try {
    const healthy = releaseDiagnostics('http://127.0.0.1:1')
    healthy.observe(page)
    await page.goto(url)
    healthy.assertClean()
    const failedHTTP = releaseDiagnostics('http://127.0.0.1:1')
    failedHTTP.observe(page)
    await page.goto(`${url}/missing`)
    expect(() => failedHTTP.assertClean()).toThrow()
    await failedHTTP.attach(info)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    stopped = true
    const failedNetwork = releaseDiagnostics('http://127.0.0.1:1')
    failedNetwork.observe(page)
    const failed = page.waitForEvent('requestfailed')
    await page.goto(url).catch(() => undefined)
    await failed
    expect(() => failedNetwork.assertClean()).toThrow()
    await failedNetwork.attach(info)
  } finally {
    if (!stopped) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('a fresh release diagnostic observer accepts the repaired synthetic document', async ({ page }) => {
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  await page.setContent('<main><h1>Healthy document</h1><button>Accessible action</button></main>')
  await expect.poll(() => {
    diagnostics.assertClean()
    return true
  }).toBe(true)
  await releaseLayout(page)
})

test('release layout rejects a blank loading shell, unnamed controls and overflow', async ({ page }) => {
  // Synthetic documents exercise the same oracle; no application API is mocked.
  await page.setContent('<main>Loading…</main>')
  await expect(releaseLayout(page)).rejects.toThrow()
  await page.setContent('<main><h1>Ready</h1><button></button></main>')
  await expect(releaseLayout(page)).rejects.toThrow()
  await page.setContent('<main><h1>Ready</h1><div style="width:10000px">Overflow negative control</div></main>')
  await expect(releaseLayout(page)).rejects.toThrow()
  await page.setContent('<main><h1>Ready</h1><button>Accessible action</button></main>')
  await releaseLayout(page)
})

test('release media rejects broken retained image bytes', async ({ page, browserName }) => {
  await page.setContent('<iframe title="Review card"></iframe>')
  const frame = page.frames()[1]!
  await frame.setContent('<p>猫</p><img alt="release.png" src="data:image/png;base64,broken"><audio src="data:audio/wav;base64,broken"></audio>')
  await expect(releaseMedia(page, browserName)).rejects.toThrow()
  if (browserName === 'chromium') {
    await frame.setContent('<p>猫</p><img alt="release.png" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=="><audio src="data:audio/wav;base64,YnJva2Vu"></audio>')
    await expect(releaseMedia(page, browserName)).rejects.toThrow()
  }
  const audio = new Uint8Array(844)
  audio.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
  audio.fill(128, 44)
  await frame.setContent(`<p>猫</p><img alt="release.png" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=="><audio src="data:audio/wav;base64,${Buffer.from(audio).toString('base64')}"></audio>`)
  await releaseMedia(page, browserName)
})

test('release package equality rejects supported content, schedule, history and media loss', async () => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({ id: 1700000269001, name: 'Oracle Japanese', fields: [{ name: 'Expression' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', questionFormat: '{{Expression}}', answerFormat: '{{Meaning}}' }] })
  const deck = new Deck({ id: 1700000269002, name: 'Oracle::日本語' })
  deck.addNote(new Note({ notetype: type, guid: 'release-oracle-cat', fields: ['猫', 'cat'], tags: ['日本語'] }))
  const pkg = new Package()
  pkg.addDeck(deck)
  pkg.addMedia('oracle.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==', 'base64'))
  const original = Buffer.from(await pkg.toUint8Array(SQL))
  const expected = await releaseInventory(original)
  const mutations: Array<[string, (data: CollectionData) => void]> = [
    ['Deck Path', data => { data.decks[0]!.name = 'Lost hierarchy' }],
    ['note fields', data => { data.notes[0]!.flds = '犬\u001fdog' }],
    ['tags', data => { data.notes[0]!.tags = '' }],
    ['note type', data => { data.notetypes[0]!.name = 'Changed type' }],
    ['field definition', data => { data.fields[0]!.name = 'Changed field' }],
    ['template', data => { data.templates[0]!.name = 'Changed template' }],
    ['native scheduling', data => { data.cards[0]!.due += 100 }],
    ['supported timestamps', data => { data.notes[0]!.data = JSON.stringify({ kirokuNoteTimes: { createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T13:00:00Z' } }) }],
    ['history', data => { data.revlog.push({ id: 1700000269003, cid: data.cards[0]!.id, usn: -1, ease: 3, ivl: 1, lastIvl: 0, factor: 2500, time: 1200, type: 0 }) }],
    ['media digest', data => { data.media[0]!.data[0] = 0 }],
  ]
  for (const [name, mutate] of mutations) {
    const data = AnkiCollection.open(original, SQL).data
    mutate(data)
    const changed = Buffer.from(await AnkiCollection.fromData(data).toUint8Array(SQL))
    const actual = await releaseInventory(changed)
    expect(actual, `${name} damage must fail the same release equality oracle`).not.toEqual(expected)
  }
})
