import { expect, test } from '@playwright/test'
import { releaseDiagnostics } from './release-oracles'

test.use({ trace: { mode: 'on', snapshots: false, screenshots: true, sources: true } })

function nativeAudioSource() {
  const wav = new Uint8Array(844)
  wav.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
  wav.fill(128, 44)
  return Buffer.from(wav).toString('base64')
}

for (const unsafe of [false, true]) test(`release native frame lifecycle: unsafe=${unsafe}`, async ({ page, browserName }, info) => {
  test.skip(browserName !== 'webkit', 'WebKit native audio lifecycle boundary; Chromium has independent diagnostic controls')
  const blocked = "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set."
  let removed: Promise<void> | undefined
  page.on('console', message => {
    // Native audio controls load image blobs while emitting this signature.
    // Let those requests settle before removal so cancellation is not confused
    // with the authored-script safety boundary this control verifies.
    if (message.text() === blocked && !removed) removed = page.waitForLoadState('networkidle').then(() => page.evaluate(() => {
      document.querySelectorAll('iframe').forEach(frame => frame.remove())
    }))
  })
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  await page.setContent('<main><div id="cards"></div></main>')
  await diagnostics.retainNativeFrames(page)
  const html = `<html><body><p>東京</p><audio controls src="data:audio/wav;base64,${nativeAudioSource()}"></audio>${unsafe ? '<script>window.unsafeRan=true</script>' : ''}</body></html>`
  await page.evaluate(html => {
    const frame = document.createElement('iframe')
    frame.title = 'Review card'
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.srcdoc = html
    document.querySelector('#cards')!.append(frame)
  }, html)
  await expect.poll(() => !!removed).toBe(true)
  await removed
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.screenshot()
  try {
    if (unsafe) await expect(diagnostics.assertClean()).rejects.toThrow()
    else await diagnostics.assertClean()
  } finally { await diagnostics.attach(info) }
})

test('a dynamically inserted blocked script remains fatal after its frame is removed', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'webkit', 'WebKit native audio lifecycle boundary; Chromium has independent diagnostic controls')
  let armed = false
  let removed: Promise<void> | undefined
  page.on('console', message => {
    if (armed && !removed && message.text().startsWith('Blocked script execution')) removed = page.evaluate(() => {
      document.querySelectorAll('iframe').forEach(frame => frame.remove())
    })
  })
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  await page.setContent('<main><div id="cards"></div></main>')
  await diagnostics.retainNativeFrames(page)
  await page.evaluate(audio => {
    const frame = document.createElement('iframe')
    frame.title = 'Review card'
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.srcdoc = `<p>東京</p><audio controls src="data:audio/wav;base64,${audio}"></audio>`
    document.querySelector('#cards')!.append(frame)
  }, nativeAudioSource())
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.body?.textContent)).toContain('東京')
  await page.screenshot()
  await diagnostics.assertClean()
  armed = true
  await page.evaluate(() => {
    const child = document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!
    const script = child.createElement('script')
    script.textContent = 'window.unsafeRan=true'
    child.body.append(script)
  })
  await expect.poll(() => !!removed).toBe(true)
  await removed
  try { await expect(diagnostics.assertClean()).rejects.toThrow() }
  finally { await diagnostics.attach(info) }
})
