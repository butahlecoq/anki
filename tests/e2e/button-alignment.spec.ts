import { expect, test, type Locator } from '@playwright/test'

async function expectSameButtonSize(first: Locator, second: Locator) {
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await first.scrollIntoViewIfNeeded()
  await second.scrollIntoViewIfNeeded()
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()])
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  expect(Math.abs(firstBox!.width - secondBox!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(firstBox!.height - secondBox!.height)).toBeLessThanOrEqual(1)
}

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
    expect(importBox!.height).toBeGreaterThanOrEqual(54)
    expect(importBox!.x).toBeGreaterThanOrEqual(actionsBox!.x)
    expect(importBox!.x + importBox!.width).toBeLessThanOrEqual(actionsBox!.x + actionsBox!.width + 1)
    expect(newDeckBox!.x).toBeGreaterThanOrEqual(actionsBox!.x)
    expect(newDeckBox!.x + newDeckBox!.width).toBeLessThanOrEqual(actionsBox!.x + actionsBox!.width + 1)
    expect(await page.evaluate(width => document.documentElement.scrollWidth <= width, viewportWidth)).toBe(true)
  } else {
    expect(importBox!.width).toBe(150)
    expect(importBox!.height).toBe(42)
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
