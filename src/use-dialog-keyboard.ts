import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Apply one focus lifecycle to every modal while leaving its owner in control of dismissal. */
export function useDialogKeyboard(onClose: () => void, open = true) {
  const [dialog, setDialog] = useState<HTMLElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openerCaptured = useRef(false)

  const ref = useCallback((element: HTMLElement | null) => setDialog(element), [])

  useLayoutEffect(() => {
    if (!open || !dialog) return
    // Remember the opener before this hook moves focus into the modal.
    if (!openerCaptured.current) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      openerCaptured.current = true
    }
    const target = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus], [autofocus]')
      ?? dialog.querySelector<HTMLElement>(FOCUSABLE)
      ?? dialog
    target.focus()
    return () => {
      const previous = opener.current
      queueMicrotask(() => {
        // React Strict Mode replays effects while the same dialog stays mounted.
        if (dialog.isConnected) return
        if (previous?.isConnected && !previous.hidden && previous.getAttribute('aria-hidden') !== 'true') previous.focus()
        else {
          const fallback = document.querySelector<HTMLElement>('main button:not([disabled]), [role="main"] button:not([disabled]), main a[href], [role="main"] a[href], main, [role="main"]')
          fallback?.focus()
        }
        opener.current = null
        openerCaptured.current = false
      })
    }
  }, [dialog, open])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open || !dialog) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
    if (!focusable.length) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }, [dialog, onClose, open])

  return { ref, onKeyDown, tabIndex: -1 as const }
}
