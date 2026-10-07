import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const packagePath = process.env.KIROKU_ANKI_COMPAT_PACKAGE

test.skip(!packagePath, 'Run scripts/generate-anki-compatibility-package.py with the pinned official Anki release first.')
async function openOfficialPackage(page: Page) {
  const bytes = await readFile(packagePath!)
  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'anki-26.09.3.colpkg', mimeType: 'application/octet-stream', buffer: bytes })
  await expect(dialog.getByText('2 notes')).toBeVisible()
  await expect(dialog.getByText('4 cards')).toBeVisible()
  await page.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open Source', exact: true }).click()
  await page.getByRole('button', { name: 'Study now', exact: true }).click()
}

async function nativeMemoryWavCapability(page: Page) {
  return page.evaluate(async () => {
    // Independent, valid mono PCM8 WAV: 800 frames at 8 kHz. Python's wave
    // reader and the standalone HTTP/data/blob probe validate these bytes.
    const bytes = new Uint8Array(844)
    bytes.set([82,73,70,70,68,3,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,32,3,0,0])
    bytes.fill(128, 44)
    const data = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`
    const blob = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const results: { source: string; event: string; errorCode: number | null }[] = []
    try {
      for (const [source, url] of [['data', data], ['blob', blob]]) {
        const audio = document.createElement('audio')
        audio.controls = true
        audio.preload = 'auto'
        document.body.append(audio)
        const result = await new Promise<{ source: string; event: string; errorCode: number | null }>(resolve => {
          const timeout = setTimeout(() => finish('timeout'), 3000)
          const finish = (event: string) => { clearTimeout(timeout); resolve({ source, event, errorCode: audio.error?.code ?? null }) }
          audio.addEventListener('loadedmetadata', () => finish('loadedmetadata'), { once: true })
          audio.addEventListener('error', () => finish('error'), { once: true })
          audio.src = url
          audio.load()
        })
        audio.removeAttribute('src')
        audio.load()
        audio.remove()
        results.push(result)
      }
    } finally { URL.revokeObjectURL(blob) }
    return results
  })
}

test('Anki 26.09.3 package renders reversed cards and retains audio through a complete study session', async ({ page }) => {
  test.setTimeout(90_000)
  await openOfficialPackage(page)

  const review = page.frameLocator('iframe[title="Review card"]')
  const questions: string[] = []
  let audioCards = 0
  for (let index = 0; index < 4; index += 1) {
    const showAnswer = page.getByRole('button', { name: 'Show answer', exact: true })
    await expect(showAnswer).toBeVisible()
    const question = (await review.locator('body').innerText()).trim()
    questions.push(question)
    const audio = review.locator('audio')
    if (await audio.count()) {
      await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      audioCards += 1
    }
    await showAnswer.click()
    await expect(page.getByRole('button', { name: /^Good · / })).toBeVisible()
    await page.getByRole('button', { name: /^Good · / }).click()
  }
  const renderedSession = questions.join('\n')
  for (const value of ['猫', 'ねこ', '犬', 'いぬ']) expect(renderedSession).toContain(value)
  expect(audioCards).toBe(2)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('4 reviews recorded')).toBeVisible()
})

test('Anki 26.09.3 package WAV media loads metadata and replays during review', async ({ page, browserName }, testInfo) => {
  test.setTimeout(90_000)
  if (browserName === 'webkit' && process.platform === 'win32') {
    await page.goto('/')
    const capability = await nativeMemoryWavCapability(page)
    testInfo.annotations.push({ type: 'native-memory-wav', description: JSON.stringify(capability) })
    test.skip(capability.every(result => result.event === 'error' && result.errorCode === 4), 'This Windows WebKit runner rejects valid WAV data/blob URLs with MEDIA_ERR_SRC_NOT_SUPPORTED in a plain document; standalone HTTP decoding succeeds. Import/render/review remains covered separately; this skip is not playback evidence.')
  }
  await openOfficialPackage(page)
  const review = page.frameLocator('iframe[title="Review card"]')
  let replayed = false
  for (let index = 0; index < 4; index += 1) {
    await expect(page.getByRole('button', { name: 'Show answer', exact: true })).toBeVisible()
    const audio = review.locator('audio')
    if (await audio.count()) {
      await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
      await page.getByText('More actions', { exact: true }).click()
      await page.getByRole('button', { name: 'Replay audio' }).click()
      await expect(page.getByText('Audio replayed.', { exact: true })).toBeVisible()
      replayed = true
      break
    }
    await page.getByRole('button', { name: 'Show answer', exact: true }).click()
    await page.getByRole('button', { name: /^Good · / }).click()
  }
  expect(replayed, 'the official package supplies replayable front-side audio').toBe(true)
})
