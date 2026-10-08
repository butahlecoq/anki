import { expect } from '@playwright/test'
import { nativeCanvasTest } from './phone-canvas'

const test = nativeCanvasTest()

test('invalid PC addresses keep the pairing form and local collection without sending a request', async ({ page }, testInfo) => {
  const pairingRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/pair') pairingRequests.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Sample — Japanese Starter' })).toBeVisible()
  // Collection tools are collapsed in the phone layout.
  if (!await page.getByRole('button', { name: 'Connect a PC' }).isVisible()) {
    await page.getByText('Collection tools', { exact: true }).click()
  }
  await page.getByRole('button', { name: 'Connect a PC', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect to your PC' })
  const code = 'synthetic-code'
  for (const address of ['not-a-url', 'http://192.168.1.20:4174', 'file:///private-collection']) {
    await dialog.getByLabel('PC service address').fill(address)
    await dialog.getByLabel('One-time pairing code').fill(code)
    await dialog.getByRole('button', { name: 'Connect device', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('The PC service address is invalid or unsafe.')
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('PC service address')).toHaveValue(address)
    await expect(dialog.getByLabel('One-time pairing code')).toHaveValue(code)
    expect(pairingRequests).toEqual([])
  }
  await page.screenshot({ path: testInfo.outputPath('invalid-address-feedback.png') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open Sample — Japanese Starter' })).toBeVisible()
})
