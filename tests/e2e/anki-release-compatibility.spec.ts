import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const packagePath = process.env.KIROKU_ANKI_COMPAT_PACKAGE

test.skip(!packagePath, 'Run scripts/generate-anki-compatibility-package.py with the pinned official Anki release first.')
test('Anki 26.09.3 package renders reversed cards and plays generated audio through a complete study session', async ({ page }) => {
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

  const review = page.frameLocator('iframe[title="Review card"]')
  const questions: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const showAnswer = page.getByRole('button', { name: 'Show answer', exact: true })
    await expect(showAnswer).toBeVisible()
    const question = (await review.locator('body').innerText()).trim()
    questions.push(question)
    const audio = review.locator('audio')
    if (await audio.count()) {
      await expect(audio).toHaveAttribute('src', /^data:audio\/wav;base64,/)
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= HTMLMediaElement.HAVE_METADATA)).toBe(true)
      await page.getByText('More actions', { exact: true }).click()
      await page.getByRole('button', { name: 'Replay audio' }).click()
      await expect(page.getByText('Audio replayed.', { exact: true })).toBeVisible()
    }
    await showAnswer.click()
    await expect(page.getByRole('button', { name: /^Good · / })).toBeVisible()
    await page.getByRole('button', { name: /^Good · / }).click()
  }
  const renderedSession = questions.join('\n')
  for (const value of ['猫', 'ねこ', '犬', 'いぬ']) expect(renderedSession).toContain(value)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.getByText('4 reviews recorded')).toBeVisible()
})
