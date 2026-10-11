import { expect, type Locator } from '@playwright/test'

export async function closeExportDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Close export' }).click()
  await expect(dialog).toHaveCount(0)
}
