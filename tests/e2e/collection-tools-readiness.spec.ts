import { expect, test } from '@playwright/test'
import { openCollectionTools } from './collection-tools'

test('hidden collection summary cannot falsely report closed utilities as ready', async ({ page }) => {
  await page.setContent('<details><summary style="display:none">Collection tools</summary><button>Export Anki package</button></details>')
  await expect(openCollectionTools(page)).rejects.toThrow()
  await expect(page.locator('details')).not.toHaveAttribute('open', '')
  await expect(page.getByRole('button', { name: 'Export Anki package' })).toHaveCount(0)
})

test('hidden desktop summary retains already open utilities', async ({ page }) => {
  await page.setContent('<details open><summary style="display:none">Collection tools</summary><button>Export Anki package</button></details>')
  await openCollectionTools(page)
  await expect(page.getByRole('button', { name: 'Export Anki package' })).toBeVisible()
})

test('visible mobile summary opens utilities through an ordinary click', async ({ page }) => {
  await page.setContent('<details><summary>Collection tools</summary><button>Export Anki package</button></details>')
  await openCollectionTools(page)
  await expect(page.getByRole('button', { name: 'Export Anki package' })).toBeVisible()
})
