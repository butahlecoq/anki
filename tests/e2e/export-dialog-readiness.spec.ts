import { expect, test } from '@playwright/test'
import { closeExportDialog } from './export-dialog'

test('Close export cannot report completion while the dialog remains', async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div role="dialog" aria-label="Export Anki package"><button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Close export</button></div>')
  const dialog = page.getByRole('dialog', { name: 'Export Anki package' })
  await expect(closeExportDialog(dialog)).rejects.toThrow()
  await expect(dialog).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Close export' })).toHaveAttribute('data-clicks', '1')
})

test('Close export completes after its ordinary click removes the dialog', async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div role="dialog" aria-label="Export Anki package"><button onclick="this.closest(\'[role=dialog]\').remove()">Close export</button></div>')
  const dialog = page.getByRole('dialog', { name: 'Export Anki package' })
  await closeExportDialog(dialog)
  await expect(dialog).toHaveCount(0)
})
