import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseDelimited } from '../../src/text-csv'

const input = '_note_id,_deck,_note_type,_tags,Field: front,Field: back\r\ncat,日本語::語彙,Basic,"[""日本語"",""common""]",<b>猫</b>,"cat, feline\nねこ"\r\ndog,日本語::語彙,Basic,[],犬,dog\r\nbad,日本語::語彙,Basic,[],,missing\r\n'

async function paste(page: Page, text: string) {
  await page.getByRole('button', { name: 'Import / export text', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import and export text' })
  await dialog.getByRole('combobox', { name: 'Text source', exact: true }).selectOption('paste')
  await dialog.getByLabel('Paste CSV or tab-separated text').fill(text)
  await dialog.getByRole('button', { name: 'Read columns', exact: true }).click()
  await dialog.getByLabel('Create missing mapped deck paths').check()
  await dialog.getByRole('button', { name: 'Preview import', exact: true }).click()
  return dialog
}

async function downloadNotes(page: Page, expectedCount = 2) {
  const dialog = page.getByRole('dialog', { name: 'Import and export text' })
  await dialog.getByRole('button', { name: 'Export text', exact: true }).click()
  const pending = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download text export', exact: true }).click()
  const download = await pending
  await expect(dialog.getByRole('status')).toContainText(`Text export ready: ${expectedCount} notes`)
  return readFile((await download.path())!)
}

test('Japanese CSV preview, explicit partial import, offline export and clean-client semantic re-import', async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  const dialog = await paste(page, input)
  await expect(dialog.getByRole('status')).toHaveText('2 to add · 0 to update · 0 to ignore · 1 invalid')
  await expect(dialog.getByRole('button', { name: 'Import 2 valid rows' })).toBeDisabled()
  const errors = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download row errors' }).click()
  const errorText = await readFile((await (await errors).path())!, 'utf8')
  expect(errorText).toContain('missing')
  expect(errorText).toContain('日本語')
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('csv-preview.png'), fullPage: true })
  await expect(page.getByText('Offline shell ready', { exact: true })).toBeVisible()
  await context.setOffline(true)
  let exported: Buffer
  try {
    await dialog.getByLabel('Import valid rows and skip invalid rows').check()
    await dialog.getByRole('button', { name: 'Import 2 valid rows' }).click()
    await expect(dialog.getByText('Import complete: 2 added, 0 updated, 0 ignored, 1 invalid rows skipped.', { exact: true })).toBeVisible()
    exported = await downloadNotes(page)
    expect(exported.toString('utf8')).toContain('猫')
    expect(exported.toString('utf8')).toContain('cat, feline\nねこ')
    await page.screenshot({ path: test.info().outputPath('csv-export.png'), fullPage: true })
  } finally { await context.setOffline(false) }
  const clean = await browser.newContext()
  let target: Page | undefined
  try {
    target = await clean.newPage()
    await target.goto(test.info().project.use.baseURL ?? page.url().split('#')[0])
    await target.getByRole('button', { name: 'Import / export text', exact: true }).click()
    let imported = target.getByRole('dialog', { name: 'Import and export text' })
    await imported.getByLabel('Text or CSV file').setInputFiles({ name: 'actual-export.csv', mimeType: 'text/csv', buffer: exported! })
    await imported.getByRole('button', { name: 'Read columns' }).click()
    await imported.getByLabel('Create missing mapped deck paths').check()
    await imported.getByRole('button', { name: 'Preview import' }).click()
    await expect(imported.getByRole('status')).toHaveText('2 to add · 0 to update · 0 to ignore · 0 invalid')
    await imported.getByRole('button', { name: 'Import 2 valid rows' }).click()
    await expect(imported.getByText('Import complete: 2 added, 0 updated, 0 ignored, 0 invalid rows skipped.', { exact: true })).toBeVisible()
    // Exact independent export verifies stable IDs, fields, JSON tags and nested
    // paths through the visible workflow, without reading or seeding IndexedDB.
    expect(await downloadNotes(target)).toEqual(exported!)
    await imported.getByLabel('Close text import/export').click()
    await target.getByRole('button', { name: 'Open 語彙', exact: true }).click()
    await target.getByRole('button', { name: 'Study now', exact: true }).click()
    const review = target.frameLocator('iframe[title="Review card"]')
    await expect(review.getByText('猫')).toBeVisible()
    await target.getByRole('button', { name: 'Show answer', exact: true }).click()
    await expect(review.getByText(/cat, feline/)).toBeVisible()
    await target.getByRole('button', { name: /^Good · / }).click()
    await target.getByRole('button', { name: 'End session', exact: true }).click()
    await expect(target.getByRole('heading', { name: '語彙' })).toBeVisible()
    await expect(target.getByText('REVIEWS 1')).toBeVisible()
    const exportedRowsBeforeUpdate = parseDelimited(exported!.toString('utf8').replace(/^\uFEFF/, ''), ',', '"').map((row) => row.values)
    const noteIdColumnBeforeUpdate = exportedRowsBeforeUpdate[0].indexOf('_note_id')
    const catNoteId = exportedRowsBeforeUpdate.find((row) => row[noteIdColumnBeforeUpdate] === 'csv-note:Y2F0')?.[noteIdColumnBeforeUpdate]
    expect(catNoteId).toBe('csv-note:Y2F0')
    await target.getByRole('button', { name: 'Import / export text', exact: true }).click()
    imported = target.getByRole('dialog', { name: 'Import and export text' })
    await imported.getByLabel('Text or CSV file').setInputFiles({ name: 'ignore-existing.csv', mimeType: 'text/csv', buffer: exported! })
    await imported.getByRole('button', { name: 'Read columns' }).click()
    await imported.getByRole('button', { name: 'Preview import' }).click()
    await expect(imported.getByRole('status')).toHaveText('0 to add · 0 to update · 2 to ignore · 0 invalid')
    const metadataUpdate = '_note_id,_deck,_note_type,_tags\r\ncat,日本語::語彙,Basic,"[""更新"",""common""]"\r\ndog,日本語::語彙,Basic,"[""犬"",""common""]"\r\n'
    await imported.getByLabel('Text or CSV file').setInputFiles({ name: 'metadata-update.csv', mimeType: 'text/csv', buffer: Buffer.from(metadataUpdate) })
    await imported.getByRole('button', { name: 'Read columns' }).click()
    await imported.getByLabel('Existing matching notes').selectOption('update')
    await imported.getByRole('button', { name: 'Preview import' }).click()
    await expect(imported.getByRole('status')).toHaveText('0 to add · 2 to update · 0 to ignore · 0 invalid')
    await imported.getByRole('button', { name: 'Import 2 valid rows' }).click()
    await expect(imported.getByText('Import complete: 0 added, 2 updated, 0 ignored, 0 invalid rows skipped.', { exact: true })).toBeVisible()
    const updatedExport = (await downloadNotes(target)).toString('utf8').replace(/^\uFEFF/, '')
    const exportedRows = parseDelimited(updatedExport, ',', '"').map((row) => row.values)
    const updatedNoteIdColumn = exportedRows[0].indexOf('_note_id')
    expect(exportedRows.find((row) => row[updatedNoteIdColumn] === 'csv-note:Y2F0')?.[updatedNoteIdColumn]).toBe(catNoteId)
    const tagColumn = exportedRows[0].indexOf('_tags')
    expect(tagColumn).toBeGreaterThanOrEqual(0)
    expect(exportedRows.find((row) => row[0] === 'csv-note:Y2F0')?.[tagColumn]).toBe('["更新","common"]')
    await imported.getByLabel('Close text import/export').click()
    await expect(target.getByText('REVIEWS 1')).toBeVisible()
    await target.getByRole('button', { name: 'Import / export text', exact: true }).click()
    imported = target.getByRole('dialog', { name: 'Import and export text' })
    await imported.getByLabel('Text or CSV file').setInputFiles({ name: 'intentional-duplicate.csv', mimeType: 'text/csv', buffer: exported! })
    await imported.getByRole('button', { name: 'Read columns' }).click()
    await imported.getByRole('button', { name: 'Preview import' }).click()
    await expect(imported.getByRole('status')).toHaveText('0 to add · 0 to update · 2 to ignore · 0 invalid')
    await imported.getByRole('button', { name: 'Import text', exact: true }).click()
    await imported.getByLabel('Existing matching notes').selectOption('duplicate')
    await imported.getByRole('button', { name: 'Preview import' }).click()
    await expect(imported.getByRole('status')).toHaveText('2 to add · 0 to update · 0 to ignore · 0 invalid')
    await imported.getByRole('button', { name: 'Import 2 valid rows' }).click()
    await expect(imported.getByText('Import complete: 2 added, 0 updated, 0 ignored, 0 invalid rows skipped.', { exact: true })).toBeVisible()
    await imported.getByLabel('Close text import/export').click()
    await expect(target.getByText('REVIEWS 1')).toBeVisible()
  } finally {
    await target?.close().catch(() => undefined)
    await clean.close()
  }
})
