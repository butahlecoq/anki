import { expect, type Page } from '@playwright/test'

/** Open the visible mobile utility disclosure; desktop utilities are already open. */
export async function openCollectionTools(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^Collection tools$/ })
  // A fresh document can finish loading before the workspace mounts.
  await expect(summary).toBeAttached()
  if (!await summary.isVisible()) return
  const details = summary.locator('..')
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) {
    await summary.click()
  }
  await expect(details).toHaveAttribute('open', '')
}
