import { expect, type Page } from '@playwright/test'

/** Open mobile utilities and verify the disclosure is open on either layout. */
export async function openCollectionTools(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^Collection tools$/ })
  // A fresh document can finish loading before the workspace mounts.
  await expect(summary).toBeAttached()
  const details = summary.locator('..')
  if (await summary.isVisible() && !await details.evaluate(element => (element as HTMLDetailsElement).open)) {
    await summary.click()
  }
  await expect(details).toHaveAttribute('open', '')
}
