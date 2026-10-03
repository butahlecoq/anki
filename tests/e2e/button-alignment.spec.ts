import { expect, test, type Locator } from '@playwright/test'

async function expectSameButtonSize(first: Locator, second: Locator) {
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
