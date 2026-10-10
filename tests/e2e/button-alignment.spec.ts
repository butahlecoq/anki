import { expect, test, type Locator } from '@playwright/test'
import { openCollectionTools } from './collection-tools'

async function expectSameButtonSize(first: Locator, second: Locator) {
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await first.scrollIntoViewIfNeeded()
  await second.scrollIntoViewIfNeeded()
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()])
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  expect(firstBox!.height).toBeGreaterThanOrEqual(43.99)
  expect(secondBox!.height).toBeGreaterThanOrEqual(43.99)
  expect(Math.abs(firstBox!.width - secondBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(firstBox!.height - secondBox!.height)).toBeLessThanOrEqual(1)
}

test('workspace utility and deck actions meet the minimum touch size', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await openCollectionTools(page)
  await expect(page.getByRole('button', { name: 'Import / export text', exact: true })).toHaveCount(0)
  for (const name of ['Connect a PC', 'Export Anki package', 'Open Sample — Japanese Starter']) {
    const action = page.getByRole('button', { name, exact: true })
    await expect(action).toBeVisible()
    const box = await action.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height, name).toBeGreaterThanOrEqual(43.99)
    expect(box!.width, name).toBeGreaterThanOrEqual(43.99)
  }
})

test('paired note-type and dialog actions use matching button dimensions', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Note types' }).click()

  const newDeck = page.getByRole('button', { name: 'New deck', exact: true })
  const createType = page.getByRole('button', { name: 'Create note type', exact: true })
  await expectSameButtonSize(newDeck, createType)

  await createType.click()
  const createDialog = page.getByRole('dialog', { name: 'Create note type' })
  await expectSameButtonSize(createDialog.getByRole('button', { name: 'Cancel' }), createDialog.getByRole('button', { name: 'Save note type' }))
  await createDialog.getByLabel('Note type name').fill('Japanese nouns')
  await createDialog.getByRole('button', { name: 'Save note type' }).click()

  const edit = page.getByRole('button', { name: 'Edit Japanese nouns' })
  await edit.click()
  const editDialog = page.getByRole('dialog', { name: 'Edit Japanese nouns' })
  await expectSameButtonSize(editDialog.getByRole('button', { name: 'Cancel' }), editDialog.getByRole('button', { name: 'Save changes' }))
})

test('Collection landing actions have matching desktop and phone dimensions', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Load sample deck' }).click()
  await expect(page.getByRole('heading', { name: 'Choose what to remember' })).toBeVisible()

  const actions = page.locator('.compact-hero .collection-actions')
  const importPackage = actions.getByRole('button', { name: 'Import Anki package', exact: true })
  const newDeck = actions.getByRole('button', { name: 'New deck', exact: true })
  await expectSameButtonSize(importPackage, newDeck)

  const [importBox, newDeckBox] = await Promise.all([importPackage.boundingBox(), newDeck.boundingBox()])
  expect(importBox).not.toBeNull()
  expect(newDeckBox).not.toBeNull()

  const viewportWidth = page.viewportSize()!.width
  if (viewportWidth < 600) {
    const actionsBox = await actions.boundingBox()
    expect(actionsBox).not.toBeNull()
    expect(Math.abs(importBox!.width - newDeckBox!.width)).toBeLessThanOrEqual(1)
    expect(importBox!.height).toBeGreaterThanOrEqual(54 - .01)
    expect(importBox!.x).toBeGreaterThanOrEqual(actionsBox!.x)
    expect(importBox!.x + importBox!.width).toBeLessThanOrEqual(actionsBox!.x + actionsBox!.width + 1)
    expect(newDeckBox!.x).toBeGreaterThanOrEqual(actionsBox!.x)
    expect(newDeckBox!.x + newDeckBox!.width).toBeLessThanOrEqual(actionsBox!.x + actionsBox!.width + 1)
    const documentWidth = await page.evaluate(() => ({ root: document.documentElement.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth }))
    // WebKit rounds the CSS root to device pixels on Windows (390.4 → 391).
    expect(documentWidth.root).toBeLessThanOrEqual(viewportWidth + 1)
    expect(documentWidth.scroll).toBeLessThanOrEqual(Math.ceil(documentWidth.root))
    // Prove this measurement still detects genuine horizontal overflow.
    await page.evaluate(() => {
      const wide = document.createElement('div')
      wide.id = 'overflow-probe'
      wide.style.width = '200vw'
      wide.textContent = 'Deliberately wide content'
      document.body.append(wide)
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > Math.ceil(document.documentElement.getBoundingClientRect().width))).toBe(true)
    await page.locator('#overflow-probe').evaluate(element => element.remove())
  } else {
    expect(importBox!.width).toBe(150)
    expect(importBox!.height).toBe(44)
    expect(newDeckBox!.width).toBe(150)
    expect(newDeckBox!.height).toBe(44)
  }

  await importPackage.focus()
  await expect(importPackage).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Import Anki package' })).toBeVisible()
  await page.keyboard.press('Escape')
  await newDeck.focus()
  await expect(newDeck).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Create a deck' })).toBeVisible()
  await page.keyboard.press('Escape')
})
