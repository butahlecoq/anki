import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { openCollectionTools } from './collection-tools'

test('unpaired AnkiWeb entry guides PC pairing and continues to account login', async ({ page }, testInfo) => {
  await page.goto('/')
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
  const pairing = page.getByRole('dialog', { name: 'Connect AnkiWeb account', exact: true })
  await expect(pairing).toContainText('Your PC relays the AnkiWeb connection')
  await pairing.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connect to your PC', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
  await page.getByLabel('PC service address').fill(`http://127.0.0.1:${process.env.KIROKU_SYNC_PORT ?? '4174'}`)
  await page.getByLabel('One-time pairing code').fill('INVALID-CODE')
  await pairing.getByRole('button', { name: 'Connect device', exact: true }).click()
  await expect(pairing.getByRole('alert')).toContainText('code was not accepted')
  const code = execFileSync(process.execPath, ['dist-server/server/index.js', '--pairing-code'], {
    env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: String(testInfo.config.metadata.syncRuntimeDirectory) },
    windowsHide: true, stdio: 'pipe',
  }).toString().trim()
  await page.getByLabel('One-time pairing code').fill(code)
  await pairing.getByRole('button', { name: 'Connect device', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connect AnkiWeb', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByLabel('AnkiWeb username')).toHaveValue('')
  await expect(page.getByLabel('AnkiWeb password')).toHaveValue('')
})
