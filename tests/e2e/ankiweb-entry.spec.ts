import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { openCollectionTools } from './collection-tools'

test('unpaired AnkiWeb entry opens login and separates one-time PC setup', async ({ page }, testInfo) => {
  await page.goto('/')
  await openCollectionTools(page)
  await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
  const account = page.getByRole('dialog', { name: 'Connect AnkiWeb', exact: true })
  await expect(page.getByLabel('AnkiWeb username')).toBeVisible()
  await expect(page.getByLabel('AnkiWeb username')).toBeFocused()
  await expect(page.getByLabel('AnkiWeb password')).toBeVisible()
  await expect(page.getByLabel('PC service address')).toHaveCount(0)
  await expect(account.getByRole('button', { name: 'Connect account', exact: true })).toBeDisabled()
  const cancelBounds = await account.getByRole('button', { name: 'Cancel', exact: true }).evaluate(button => {
    const action = button.getBoundingClientRect()
    const dialog = button.closest('[role="dialog"]')!.getBoundingClientRect()
    return { left: action.left, right: action.right, dialogLeft: dialog.left, dialogRight: dialog.right }
  })
  expect(cancelBounds.left).toBeGreaterThanOrEqual(cancelBounds.dialogLeft)
  expect(cancelBounds.right).toBeLessThanOrEqual(cancelBounds.dialogRight)
  await account.getByRole('button', { name: 'Set up PC connection', exact: true }).click()
  const pairing = page.getByRole('dialog', { name: 'Connect to your PC', exact: true })
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await pairing.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(account).toBeVisible()
  await account.getByRole('button', { name: 'Set up PC connection', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(account).toBeVisible()
  await account.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connect to your PC', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Connect AnkiWeb account', exact: true }).click()
  await account.getByRole('button', { name: 'Set up PC connection', exact: true }).click()
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
  await expect(page.getByLabel('AnkiWeb username')).toBeFocused()
  await expect(page.getByLabel('AnkiWeb password')).toHaveValue('')
  await expect(account.getByRole('button', { name: 'Connect account', exact: true })).toBeEnabled()
})
