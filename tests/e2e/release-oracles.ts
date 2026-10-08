import { expect, type Page, type TestInfo } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Collection as AnkiCollection } from 'ankipack'
import { createHash } from 'node:crypto'

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Compare stable supported package content, retaining native and kiroku schedules. */
export async function releaseInventory(bytes: Buffer) {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const data = AnkiCollection.open(bytes, SQL).data
  const stableRows = (values: unknown[]) => values.map(value => Object.fromEntries(
    // Native transport revision stamps are freshly generated at every export.
    // Actual supported note timestamps and review metadata remain in row.data.
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'mod' && key !== 'usn' && key !== 'mtimeSecs'),
  )).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const notes = data.notes.map(note => {
    const metadata = JSON.parse(note.data || '{}')
    // Reference order is not semantic; all properties and original display names stay.
    metadata.kirokuMedia?.sort((a: { name: string; displayName: string }, b: { name: string; displayName: string }) => `${a.name}:${a.displayName}`.localeCompare(`${b.name}:${b.displayName}`))
    return { ...note, data: JSON.stringify(metadata) }
  })
  return {
    // Exchange supports Deck Path and Native Identity. Deck options/description
    // are not emitted by this exporter; fresh ankipack defaults are not local data.
    decks: stableRows(data.decks.map(({ id, name }) => ({ id, name }))),
    notes: stableRows(notes), types: stableRows(data.notetypes), fields: stableRows(data.fields),
    templates: stableRows(data.templates), cards: stableRows(data.cards), reviews: stableRows(data.revlog),
    media: data.media.map(file => ({ name: file.name, digest: sha256(file.data) })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

type NativeFrameSource = { title: string; sandbox: string | null; srcdoc: string | null }
type NativeFrameHistory = { sources: Map<string, NativeFrameSource>; flush: () => void }

/** Retain authored frame documents before review navigation can detach them. */
async function retainNativeFrames(page: Page) {
  await page.evaluate(() => {
    const owner = window as Window & { releaseNativeFrameHistory?: NativeFrameHistory }
    if (owner.releaseNativeFrameHistory) return
    const sources = new Map<string, NativeFrameSource>()
    function capture(frame: HTMLIFrameElement, oldAttribute?: { name: string; value: string | null }) {
      const source = { title: frame.title, sandbox: frame.getAttribute('sandbox'), srcdoc: frame.getAttribute('srcdoc') }
      if (oldAttribute?.name === 'sandbox') source.sandbox = oldAttribute.value
      if (oldAttribute?.name === 'srcdoc') source.srcdoc = oldAttribute.value
      sources.set(JSON.stringify(source), source)
    }
    function collect(node: Node) {
      if (node instanceof HTMLIFrameElement) capture(node)
      if (node instanceof Element) node.querySelectorAll('iframe').forEach(captureFrame)
    }
    function captureFrame(frame: HTMLIFrameElement) { capture(frame) }
    function consume(records: MutationRecord[]) {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLIFrameElement) {
          capture(record.target)
          capture(record.target, { name: record.attributeName!, value: record.oldValue })
        }
        record.addedNodes.forEach(collect)
        record.removedNodes.forEach(collect)
      }
    }
    const observer = new MutationObserver(consume)
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['srcdoc', 'sandbox'] })
    collect(document.documentElement)
    owner.releaseNativeFrameHistory = { sources, flush: () => consume(observer.takeRecords()) }
  })
}

async function nativeAudioDocuments(page: Page) {
  return page.evaluate(() => {
    const frames: Array<{ title: string; sandbox: string | null; readable: boolean; scripts: number; activeAttributes: number; audioControls: number; source: 'live' | 'retained-srcdoc' }> = []
    const history = (window as Window & { releaseNativeFrameHistory?: NativeFrameHistory }).releaseNativeFrameHistory
    history?.flush()
    function executableAttribute(attribute: Attr) {
      if (/^on/i.test(attribute.name)) return true
      try { return new URL(attribute.value, document.baseURI).protocol === 'javascript:' }
      catch { return false }
    }
    function inspectFrame(title: string, sandbox: string | null, child: Document | null, readable: boolean, source: 'live' | 'retained-srcdoc') {
      const scripts = child?.querySelectorAll('script, object, embed').length ?? 0
      const attributes = child ? [...child.querySelectorAll('*')].flatMap(element => [...element.attributes]) : []
      const activeAttributes = attributes.filter(executableAttribute).length
      frames.push({ title, sandbox, readable, scripts, activeAttributes, audioControls: child?.querySelectorAll('audio[controls][src^="data:audio/wav;base64,"]').length ?? 0, source })
      if (child) inspect(child, source)
    }
    function inspect(document: Document, source: 'live' | 'retained-srcdoc') {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe')) {
        const srcdoc = frame.getAttribute('srcdoc')
        const child = source === 'live' ? frame.contentDocument : srcdoc === null ? null : new DOMParser().parseFromString(srcdoc, 'text/html')
        inspectFrame(frame.title, frame.getAttribute('sandbox'), child, !!child?.body && srcdoc !== null, source)
      }
    }
    inspect(document, 'live')
    for (const source of history?.sources.values() ?? []) {
      const child = source.srcdoc === null ? null : new DOMParser().parseFromString(source.srcdoc, 'text/html')
      inspectFrame(source.title, source.sandbox, child, child !== null, 'retained-srcdoc')
    }
    return {
      safe: frames.some(frame => frame.audioControls > 0) && frames.every(frame => frame.readable && frame.sandbox === 'allow-same-origin' && frame.scripts === 0 && frame.activeAttributes === 0),
      frames,
    }
  })
}

export function releaseDiagnostics(serviceURL: string) {
  let phase = 'setup'
  let offline = false
  const events: Array<{ phase: string; kind: string; detail: string; expected: boolean; console?: { arguments: number; location: { url: string; lineNumber: number; columnNumber: number } }; nativeAudioAudit?: Awaited<ReturnType<typeof nativeAudioDocuments>> }> = []
  const pending: Promise<void>[] = []
  const observed = new WeakSet<Page>()
  const record = (kind: string, detail: string, expected = false) => {
    const event: typeof events[number] = { phase, kind, detail, expected }
    events.push(event)
    return event
  }
  return {
    phase(name: string, isOffline = false) { phase = name; offline = isOffline },
    retainNativeFrames,
    observe(page: Page) {
      if (observed.has(page)) return
      observed.add(page)
      page.on('pageerror', error => record('uncaught', error.message))
      page.on('console', message => {
        if (message.type() !== 'error') return
        const location = message.location()
        const event = record('console-error', `${message.text()} (${location.url})`, offline && location.url.startsWith(serviceURL))
        event.console = { arguments: message.args().length, location }
        // WebKit's native audio controls emit this measured signature even in
        // script-free frames. Template code has the same signature: inspect
        // every live and retained authored document, including removed unsafe
        // frames, rather than accepting the text or the last safe frame alone.
        if (page.context().browser()?.browserType().name() === 'webkit'
          && message.text() === "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set."
          && message.args().length === 0 && location.url === '' && location.lineNumber === 0 && location.columnNumber === 0) {
          pending.push(nativeAudioDocuments(page).then(audit => {
            event.nativeAudioAudit = audit
            event.expected = audit.safe
          }).catch(() => { /* Unreadable or detached documents remain fatal. */ }))
        }
      })
      page.on('requestfailed', request => record('request-failed', `${request.method()} ${request.url()} ${request.failure()?.errorText}`, offline && request.url().startsWith(`${serviceURL}/`)))
      page.on('response', response => {
        if (response.status() >= 400) record('http-error', `${response.status()} ${response.url()}`)
      })
    },
    async assertClean() {
      await Promise.all(pending)
      expect(events.filter(event => !event.expected), `diagnostics in ${phase}`).toEqual([])
    },
    async attach(info: TestInfo) {
      await Promise.all(pending)
      await info.attach('release-diagnostics', { body: JSON.stringify(events, null, 2), contentType: 'application/json' })
    },
  }
}

export async function releaseLayout(page: Page) {
  await expect(page.locator('main')).toBeVisible()
  await expect(page.locator('main')).not.toHaveText(/^\s*(?:Loading[\s\S]*|)\s*$/i)
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rootWidth: document.documentElement.getBoundingClientRect().width }))
  expect(geometry.scrollWidth, 'unexpected document overflow').toBeLessThanOrEqual(Math.ceil(geometry.rootWidth))
  // Role/label locators in the journey verify each required control; additionally
  // reject unnamed visible actions in every settled phase.
  const unnamed = await page.locator('button, input, select, textarea').evaluateAll(elements => elements.filter(element => {
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) return false
    if (element.matches('input[type="hidden"], input[type="file"]')) return false
    const labels = (element as HTMLInputElement).labels
    return !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !element.getAttribute('title') && !element.textContent?.trim() && !labels?.length
  }).map(element => element.outerHTML))
  expect(unnamed, 'visible controls need accessible names').toEqual([])
  return geometry
}

export async function releaseMedia(page: Page, browserName: string) {
  const review = page.frameLocator('iframe[title="Review card"]')
  await expect(review.locator('body')).toContainText(/猫|犬|鳥/)
  // The keyed review frame can be replaced while media resolves. Read the
  // current document from its parent atomically, without retaining a frame handle.
  const media = () => page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('iframe[title="Review card"]')?.contentDocument
    const image = frameDocument?.querySelector<HTMLImageElement>('img[alt="release.png"]')
    const audio = frameDocument?.querySelector<HTMLAudioElement>('audio')
    return {
      imageDecoded: !!image && image.complete && image.naturalWidth > 0,
      audioSource: audio?.getAttribute('src') ?? '',
      audioReady: !!audio && audio.readyState >= 1 && !audio.error,
    }
  })
  await expect.poll(async () => (await media()).imageDecoded).toBe(true)
  await expect.poll(async () => (await media()).audioSource).toMatch(/^data:audio\/wav;base64,/)
  if (browserName === 'chromium') await expect.poll(async () => (await media()).audioReady).toBe(true)
  // WebKit on Windows lacks a media backend. A source is evidence of retained
  // bytes only; neither metadata nor audible physical playback is inferred.
}
