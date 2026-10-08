import { expect, test } from '@playwright/test'
import { releaseDiagnostics } from './release-oracles'

test.use({ trace: { mode: 'on', snapshots: false, screenshots: true, sources: true } })

const blocked = "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set."
const cases = ['audio', 'app-console', 'card-script', 'other-script', 'nested-script', 'event-handler', 'opaque-frame'] as const

for (const scenario of cases) test(`release native diagnostics boundary: ${scenario}`, async ({ page }, info) => {
  const diagnostics = releaseDiagnostics('http://127.0.0.1:1')
  diagnostics.observe(page)
  diagnostics.phase(scenario)
  const wav = new Uint8Array(844)
  wav.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
  wav.fill(128, 44)
  const script = '<script>window.releaseUnsafeRan=true</script>'
  const html = `<!doctype html><html lang="ja"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"></head><body><p>東京</p><audio controls src="data:audio/wav;base64,${Buffer.from(wav).toString('base64')}"></audio>${scenario === 'card-script' ? script : ''}${scenario === 'event-handler' ? '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg==" onload="window.releaseUnsafeRan=true">' : ''}</body></html>`
  await page.setContent('<main><div id="cards"></div></main>')
  await page.evaluate(({ html, scenario, script }) => {
    const card = document.createElement('iframe')
    card.title = 'Review card'
    card.setAttribute('sandbox', 'allow-same-origin')
    card.srcdoc = html
    const holder = document.querySelector('#cards')!
    if (scenario === 'other-script' || scenario === 'nested-script' || scenario === 'opaque-frame') {
      const other = document.createElement('iframe')
      other.title = 'Other frame'
      other.setAttribute('sandbox', scenario === 'opaque-frame' ? '' : 'allow-same-origin')
      other.srcdoc = scenario === 'nested-script'
        ? `<iframe title="Nested frame" sandbox="allow-same-origin" srcdoc="${script.replaceAll('"', '&quot;')}"></iframe>`
        : `<p>Other synthetic frame</p>${scenario === 'other-script' || scenario === 'opaque-frame' ? script : ''}`
      holder.append(other)
    }
    holder.append(card)
  }, { html, scenario, script })
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Review card"]')?.contentDocument?.body?.textContent)).toContain('東京')
  if (scenario === 'app-console') {
    const logged = page.waitForEvent('console', message => message.type() === 'error' && message.args().length === 1)
    await page.evaluate(text => console.error(text), blocked)
    await logged
  }
  // Actual native controls and diagnostics are exercised without trace DOM
  // injection, mocks, or adding script permission to any child frame.
  await page.screenshot()
  try {
    if (scenario === 'audio') await diagnostics.assertClean()
    else await expect(async () => diagnostics.assertClean()).rejects.toThrow()
    expect(await page.evaluate(() => !!(document.querySelector<HTMLIFrameElement>('iframe[title="Review card"]')?.contentWindow as (Window & { releaseUnsafeRan?: boolean }) | null)?.releaseUnsafeRan)).toBe(false)
  } finally { await diagnostics.attach(info) }
})
