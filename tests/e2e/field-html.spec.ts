import { expect, test } from '@playwright/test'
import initSqlJs from 'sql.js'
import { Deck, Note, Notetype, Package } from 'ankipack'

test('imported field layout markup stays intact and safe while reviewing offline', async ({ page, context }) => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const type = new Notetype({
    id: 1_700_000_000_071,
    name: 'Field layout fixture',
    fields: [{ name: 'Front' }, { name: 'Layout' }],
    templates: [{ name: 'Layout card', questionFormat: '{{Front}}<section data-testid="field-layout">{{Layout}}</section>', answerFormat: '{{FrontSide}}<hr>Answer' }],
  })
  const deck = new Deck({ id: 1_700_000_000_072, name: 'HTML layout' })
  deck.addNote(new Note({
    notetype: type,
    guid: 'field-layout-offline-fixture',
    fields: ['columns', '<table onclick="run()"><tbody><tr><td style="width:50%">左</td><td><b>右</b><script>alert(1)</script><img src=x onerror="run()"></td></tr></tbody></table>'],
  }))
  const pkg = new Package()
  pkg.addDeck(deck)

  await page.goto('/')
  await page.getByRole('button', { name: 'Import Anki package' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import Anki package' })
  await dialog.getByLabel('Anki package', { exact: true }).setInputFiles({ name: 'field-layout.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from(await pkg.toUint8Array(SQL)) })
  await expect(dialog.getByText(/Unsupported or unsafe field HTML was removed:/i)).toBeVisible()
  await dialog.getByRole('button', { name: 'Import package', exact: true }).click()
  await page.getByRole('button', { name: 'Open HTML layout' }).click()
  await page.getByRole('button', { name: 'Study now' }).click()

  const card = page.frameLocator('iframe[title="Review card"]')
  const layout = card.getByTestId('field-layout')
  await expect(layout.locator('table')).toBeVisible()
  await expect(layout.locator('td').nth(0)).toHaveAttribute('style', 'width: 50%')
  await expect(layout.locator('b')).toHaveText('右')
  await expect(layout.locator('script, img')).toHaveCount(0)

  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await context.setOffline(true)
  try {
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(card.locator('body')).toContainText('Answer')
    await expect(layout.locator('table')).toBeVisible()
    await expect(layout.locator('script, img')).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})
