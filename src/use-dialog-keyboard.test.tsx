import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useState } from 'react'
import { useDialogKeyboard } from './use-dialog-keyboard'

afterEach(cleanup)

function DialogHarness() {
  const [open, setOpen] = useState(false)
  const dialog = useDialogKeyboard(() => setOpen(false), open)
  return <>
    <button onClick={() => setOpen(true)}>Open dialog</button>
    {open && <section {...dialog} role="dialog" aria-label="Example dialog">
      <button>First</button>
      <button data-dialog-initial-focus>Safe cancel</button>
      <button onClick={() => setOpen(false)}>Save and close</button>
    </section>}
  </>
}

function NestedHarness() {
  const [outer, setOuter] = useState(false)
  const [inner, setInner] = useState(false)
  const outerDialog = useDialogKeyboard(() => setOuter(false), outer)
  const innerDialog = useDialogKeyboard(() => setInner(false), inner)
  return <>
    <button onClick={() => setOuter(true)}>Open outer</button>
    {outer && <section {...outerDialog} role="dialog" aria-label="Outer dialog">
      <button onClick={() => setInner(true)}>Open inner</button>
      {inner && <section {...innerDialog} role="dialog" aria-label="Inner dialog"><button>Inner action</button></section>}
    </section>}
  </>
}

function RemovedOpenerHarness() {
  const [open, setOpen] = useState(false)
  const [removed, setRemoved] = useState(false)
  const dialog = useDialogKeyboard(() => { setOpen(false); setRemoved(true) }, open)
  return <main tabIndex={-1}>
    {!removed && <button onClick={() => setOpen(true)}>Open removable dialog</button>}
    {open && <section {...dialog} role="dialog" aria-label="Removable dialog"><button onClick={() => { setOpen(false); setRemoved(true) }}>Finish and remove opener</button></section>}
  </main>
}

test('focuses a safe target, traps forward and reverse Tab, and restores the opener on Escape', async () => {
  render(<DialogHarness />)
  const opener = screen.getByRole('button', { name: 'Open dialog' })
  opener.focus()
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Example dialog' })
  const first = screen.getByRole('button', { name: 'First' })
  const safe = screen.getByRole('button', { name: 'Safe cancel' })
  const last = screen.getByRole('button', { name: 'Save and close' })
  expect(safe).toHaveFocus()
  last.focus()
  fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(first).toHaveFocus()
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
  expect(last).toHaveFocus()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(opener).toHaveFocus())
})

test('restores focus after a successful action closes the dialog', async () => {
  render(<DialogHarness />)
  const opener = screen.getByRole('button', { name: 'Open dialog' })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.click(screen.getByRole('button', { name: 'Save and close' }))
  await waitFor(() => expect(opener).toHaveFocus())
})

test('Escape closes only the top dialog and restores focus to the dialog beneath it', async () => {
  render(<NestedHarness />)
  const opener = screen.getByRole('button', { name: 'Open outer' })
  opener.focus()
  fireEvent.click(opener)
  const innerOpener = screen.getByRole('button', { name: 'Open inner' })
  innerOpener.focus()
  fireEvent.click(innerOpener)
  const inner = screen.getByRole('dialog', { name: 'Inner dialog' })
  fireEvent.keyDown(inner, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeInTheDocument()
  await waitFor(() => expect(innerOpener).toHaveFocus())
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Outer dialog' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(opener).toHaveFocus())
})

test('moves focus to the page when an action removes its opener', async () => {
  render(<RemovedOpenerHarness />)
  const opener = screen.getByRole('button', { name: 'Open removable dialog' })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.click(screen.getByRole('button', { name: 'Finish and remove opener' }))
  await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
})
