import { afterEach, describe, expect, test } from 'vitest'
import { isShortcutBlocked } from './keyboard-shortcuts'

/*
 * The guard every workspace shortcut runs first.
 *
 * The previous guard listed the components it knew about: it ignored key
 * events inside a field, and it ignored events inside a dialog. It could not
 * tell that a dialog was open when the event came from outside it, which is
 * how a reviewer shortcut reached through an open export dialog and stacked a
 * second modal on top of it.
 */

function keyEvent(init: KeyboardEventInit & { target?: EventTarget | null }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, ...init })
  if (init.target) Object.defineProperty(event, 'target', { value: init.target, configurable: true })
  return event
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

function firstElement(html: string): HTMLElement {
  const element = mount(html).firstElementChild
  if (!element) throw new Error(`the fixture ${html} rendered no element`)
  return element as HTMLElement
}

function dialog(html: string): HTMLElement {
  const host = mount(html)
  const found = host.querySelector('[role="dialog"]')
  if (!found) throw new Error('the fixture must contain a dialog')
  return found as HTMLElement
}

describe('shortcut guard', () => {
  // The guard reads the live document, so a dialog left behind by an earlier
  // case would silently block every later one.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('runs for an ordinary press in the workspace', () => {
    expect(isShortcutBlocked(keyEvent({ target: firstElement('<button>New deck</button>') }))).toBe(false)
  })

  test('is suppressed while a text field, textarea, select or editable region owns the press', () => {
    for (const html of [
      '<input type="text" />',
      '<textarea></textarea>',
      '<select><option>a</option></select>',
      '<div contenteditable="true"></div>',
      // An empty or unspecified contenteditable is still editable, and an exact
      // [contenteditable="true"] match used to miss it.
      '<div contenteditable></div>',
      '<div contenteditable=""></div>',
      '<div contenteditable="plaintext-only"></div>',
    ]) {
      const target = firstElement(html)
      expect(isShortcutBlocked(keyEvent({ target })), html).toBe(true)
    }
  })

  test('is suppressed for a key held down or combined with a modifier', () => {
    const button = firstElement('<button>New deck</button>')
    expect(isShortcutBlocked(keyEvent({ target: button, repeat: true }))).toBe(true)
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(isShortcutBlocked(keyEvent({ target: button, [modifier]: true })), modifier).toBe(true)
    }
  })

  test('is suppressed when a dialog is open and the press came from outside it', () => {
    // The export trigger keeps focus when it opens the export dialog, so the
    // event target is a real button that is not inside the dialog.
    const host = mount('<button>Export Anki package</button><div role="dialog"><button>Close</button></div>')
    const trigger = host.firstElementChild as HTMLElement
    expect(isShortcutBlocked(keyEvent({ target: trigger }))).toBe(true)
  })

  test('stays live for a press inside the open dialog, which has its own controls', () => {
    const open = dialog('<div role="dialog"><input type="text" /><button>Cancel</button></div>')
    const cancel = open.querySelector('button') as HTMLElement
    expect(isShortcutBlocked(keyEvent({ target: cancel }))).toBe(false)
  })

  test('judges only the dialog on top when two are stacked', () => {
    const host = mount('<div role="dialog" id="first"><button>One</button></div><div role="dialog" id="second"><button>Two</button></div>')
    const topmost = host.querySelector('#second button') as HTMLElement
    expect(isShortcutBlocked(keyEvent({ target: topmost }))).toBe(false)
  })

  test('ignores a press whose target is not an element, such as the window itself', () => {
    expect(isShortcutBlocked(keyEvent({ target: window }))).toBe(false)
  })
})
