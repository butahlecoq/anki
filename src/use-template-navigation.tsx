import { useState, useEffect, useCallback } from 'react'
import { safeNavigationURL } from './template-navigation'

export function useTemplateNavigation(owner: string) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null)
  const [destination, setDestination] = useState<{ owner: string; url: string } | null>(null)
  const choose = useCallback((value: string) => {
    const url = safeNavigationURL(value)
    if (url) setDestination({ owner, url })
  }, [owner])
  useEffect(() => {
    let document: Document | null = null
    let removeListeners: (() => void) | undefined
    const activate = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return
      const target = event.target as Element | null
      const anchor = target && typeof target.closest === 'function' ? target.closest('a') : null
      if (!anchor) return
      // Imported navigation cannot replace the card, open a window, or reach a parent.
      event.preventDefault()
      event.stopImmediatePropagation()
      const url = safeNavigationURL(anchor.getAttribute('data-kiroku-href') ?? '')
      if (url) choose(url)
    }
    const bind = () => {
      const current = frame?.contentDocument ?? null
      if (!current) return
      if (current !== document) {
        removeListeners?.()
        document = current
        for (const type of ['click', 'auxclick', 'keydown']) current.addEventListener(type, activate, true)
        removeListeners = () => {
          for (const type of ['click', 'auxclick', 'keydown']) current.removeEventListener(type, activate, true)
        }
      }
      for (const anchor of current.querySelectorAll('a[data-kiroku-href][aria-disabled="true"]')) {
        anchor.removeAttribute('aria-disabled')
        anchor.setAttribute('tabindex', '0')
        anchor.setAttribute('title', 'Show external destination')
      }
    }
    bind()
    // srcdoc document replacement is asynchronous. WebKit's offline emulator
    // can omit load events; inert anchors cannot navigate while binding waits.
    const timer = window.setInterval(bind, 100)
    return () => { window.clearInterval(timer); removeListeners?.() }
  }, [frame, choose])
  const current = destination?.owner === owner ? destination : null
  const dialog = current && <div className="dialog-backdrop" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setDestination(null) }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="external-navigation-title">
    <h2 id="external-navigation-title">Open an external page</h2>
    <p>This link leaves Kiroku in another tab. Your study card stays open.</p>
    <p className="external-destination"><bdi dir="ltr">{current.url}</bdi></p>
    <div className="dialog-actions"><button className="text-button" type="button" onClick={() => setDestination(null)}>Stay on card</button><a className="primary-action" href={current.url} target="_blank" rel="noopener noreferrer" onClick={() => setDestination(null)}>Open external page</a></div>
  </section></div>
  return { frameRef: setFrame, dialog, choose }
}
