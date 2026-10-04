import { createServer } from 'node:http'
import https from 'node:https'
import { chromium } from '@playwright/test'

// This probe sends only an unauthenticated sync/meta request. It does not
// attach host keys, sync keys, cookies, or collection data, and it never reads
// or records the response body.
const upstreams = ['sync.ankiweb.net', 'sync1.ankiweb.net']
const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>AnkiWeb CORS probe</title>')
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

const address = server.address()
if (!address || typeof address === 'string') throw new Error('Could not determine probe origin')
const origin = `http://127.0.0.1:${address.port}`
function readRawHeaders(host) {
  const boundary = '----KirokuCredentialFreeAnkiWebCorsProbe'
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="data"',
    '',
    JSON.stringify({ v: 10, cv: 'kiroku,0.1,browser-cors-probe' }),
    `--${boundary}`,
    'Content-Disposition: form-data; name="c"',
    '',
    '0',
    `--${boundary}--`,
    '',
  ].join('\r\n')
  return new Promise((resolve) => {
    const request = https.request({
      hostname: host,
      path: '/sync/meta',
      method: 'POST',
      headers: {
        Origin: origin,
        'User-Agent': browserUserAgent,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15_000,
    }, (response) => {
      response.resume()
      response.once('end', () => resolve({
        status: response.statusCode,
        statusText: response.statusMessage,
        // Node's rawHeaders retains the complete header names, values and order.
        headersVerbatim: response.rawHeaders.reduce((lines, value, index, all) => {
          if (index % 2 === 0) lines.push(`${value}: ${all[index + 1]}`)
          return lines
        }, []),
      }))
    })
    request.once('timeout', () => request.destroy(new Error('15 second timeout')))
    request.once('error', (error) => resolve({ error: String(error) }))
    request.end(body)
  })
}
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(origin)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const networkRecords = new Map()
  const recordsByUrl = new Map()
  cdp.on('Network.requestWillBeSent', (event) => {
    if (!event.request.url.startsWith('https://sync')) return
    const record = { url: event.request.url, method: event.request.method }
    networkRecords.set(event.requestId, record)
    recordsByUrl.set(event.request.url, record)
  })
  cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
    const record = networkRecords.get(event.requestId)
    if (record) record.browserRequestOrigin = event.headers.origin ?? null
  })
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    const record = networkRecords.get(event.requestId)
    if (record) record.browserResponse = { status: event.statusCode, headers: event.headers, headersText: event.headersText ?? null }
  })
  cdp.on('Network.loadingFailed', (event) => {
    const record = networkRecords.get(event.requestId)
    if (record) record.browserFailure = { error: event.errorText, corsError: event.corsErrorStatus?.corsError ?? null }
  })
  const result = []
  for (const host of upstreams) {
    const url = `https://${host}/sync/meta`
    const request = await page.evaluate(async (target) => {
      const form = new FormData()
      form.append('data', JSON.stringify({ v: 10, cv: 'kiroku,0.1,browser-cors-probe' }))
      form.append('c', '0')
      try {
        const response = await fetch(target, { method: 'POST', body: form, credentials: 'omit', redirect: 'manual' })
        // Reading the body is intentionally forbidden; it may contain account
        // metadata even though this request carries no account credential.
        return { fetch: 'resolved', status: response.status }
      } catch (error) {
        return { fetch: 'rejected', error: String(error) }
      }
    }, url)
    // Let the browser's network observer deliver headers for CORS-blocked fetches.
    await page.waitForTimeout(250)
    result.push({ url, rawPostWithBrowserOrigin: await readRawHeaders(host), browserFetch: request, browserNetwork: recordsByUrl.get(url) ?? null })
  }
  await cdp.detach()
  console.log(JSON.stringify({ recordedAt: new Date().toISOString(), probes: result }, null, 2))
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
