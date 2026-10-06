import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useTemplateNavigation } from './use-template-navigation'
import { renderedNavigationActions } from './template-navigation'
import { isRenderedCardDisplayable, type RenderedCard } from './card-rendering'
import { applyThemeAttribute, resolveAppearance, readAppearance, watchResolvedTheme } from './appearance'

interface TemplatePreviewProps {
  rendering: RenderedCard
  side: 'front' | 'back'
  title?: string
  templateOrdinal?: number
}

export function TemplatePreview({ rendering, side, title = 'Card preview', templateOrdinal = 1 }: TemplatePreviewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { frameRef: navigationFrameRef, dialog: navigationDialog, choose: chooseNavigation } = useTemplateNavigation(`${side}:${title}:${rendering.front?.html}:${rendering.back?.html}:${templateOrdinal}`)
  const combinedFrameRef = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element
    frameRef.current = element
    navigationFrameRef(element)
  }, [navigationFrameRef])
  useEffect(() => {
    if (title === 'Review card') frame.current?.scrollIntoView?.({ block: 'center' })
  }, [title, side])
  // A front failure suppresses the card; a back failure does not, because the
  // question is still worth showing. The answer side reports its own failure.
  const sideError = (side === 'front' ? rendering.error : rendering.backError) ?? ''
  const error = sideError
  const html = (side === 'front' ? rendering.front : rendering.back)?.html ?? ''
  // The card document is themed by custom property, not by a themed selector on
  // `body`. A `:root[data-theme='light'] body { ... }` rule would out-specify a
  // deck's own `body { background: ... }` and silently override the import;
  // declaring the values on `:root` leaves the body's own declaration at
  // specificity (0,0,1), so `${rendering.css}` still wins on source order and on
  // specificity for `.card`. The dark values are the `:root` default because
  // src/appearance.ts treats an absent data-theme as dark.
  //
  // `color-scheme` is deliberately NOT declared here. It would repaint scrollbars
  // and form controls inside an imported deck, which is a change to card
  // presentation that the deck never asked for; story 13 asks that imported cards
  // keep their intended presentation. The frame keeps the user agent's own
  // defaults and this document supplies its colours explicitly.
  //
  // src/design-tokens.test.ts checks both pairings against WCAG AA, and pins the
  // half-specified case this cannot fix on its own.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"><style>:root{--kiroku-card-surface:#101317;--kiroku-card-ink:#e9ede3;--kiroku-card-link:#8ab4f8}:root[data-theme='light']{--kiroku-card-surface:#ffffff;--kiroku-card-ink:#1c2118;--kiroku-card-link:#175fa6}body{font-family:system-ui,sans-serif;color:var(--kiroku-card-ink);background:var(--kiroku-card-surface);padding:24px;overflow-wrap:anywhere}.card-image{display:block;max-width:100%;max-height:290px;object-fit:contain}.card-audio{width:min(100%,400px)}a[data-kiroku-href]{color:var(--kiroku-card-link);text-decoration:underline;cursor:pointer}.card-hint{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center}.card-hint-toggle{width:20px;height:20px;margin:0}.card-hint label{cursor:pointer}.card-hint-content{grid-column:1 / -1}.card-hint-toggle:not(:checked) + label + .card-hint-content{display:none}${rendering.css}</style></head><body class="card card${templateOrdinal}">${html}</body></html>`
  const navigationActions = renderedNavigationActions(html)
  // The frame is a separate document with no access to this one's storage or
  // media query, so the resolved theme is delivered to it explicitly. Setting an
  // attribute repaints without rebuilding srcDoc, which would otherwise reload
  // the card document and re-fetch its blob media mid-review.
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveAppearance(readAppearance(), window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true))
  useEffect(() => watchResolvedTheme(setResolvedTheme), [])
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    let document: Document | null = null
    let scheduled = 0
    let active = true
    const fit = () => {
      scheduled = 0
      const body = document?.body
      if (!body || !document || !frame.contentWindow) return
      const width = frame.clientWidth
      if (!width) return
      frame.style.padding = '0'
      frame.style.border = '0'
      frame.style.boxSizing = 'border-box'
      frame.style.display = 'block'
      frame.style.verticalAlign = 'top'
      // Measure in the original coordinate space before applying a transform.
      body.style.transform = 'none'
      body.style.transformOrigin = 'top left'
      body.style.margin = '0'
      body.style.boxSizing = 'border-box'
      body.style.width = `${width}px`
      body.style.padding = '0'
      body.style.height = 'auto'
      body.style.minHeight = '0'
      let naturalWidth = width
      // Percentage columns inside overflow:auto containers (common in Anki
      // decks) can clip large glyphs without increasing body.scrollWidth.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        body.style.width = `${naturalWidth}px`
        let requiredWidth = Math.max(naturalWidth, body.scrollWidth)
        for (const element of body.querySelectorAll<HTMLElement>('*')) {
          if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) {
            requiredWidth = Math.max(requiredWidth, naturalWidth * element.scrollWidth / element.clientWidth)
          }
        }
        if (requiredWidth <= naturalWidth + 1) break
        naturalWidth = Math.ceil(requiredWidth)
      }
      const scale = Math.min(1, width / naturalWidth)
      body.style.width = `${naturalWidth}px`
      const height = Math.max(body.scrollHeight, body.getBoundingClientRect().height, body.offsetHeight)
      const renderedTop = body.getBoundingClientRect().top
      body.style.transform = `scale(${scale})`
      document.documentElement.style.overflow = 'hidden'
      const fittedHeight = Math.ceil(height * scale)
      frame.style.height = `${fittedHeight}px`
      frame.style.minHeight = `${fittedHeight}px`
      frame.style.marginBottom = `${Math.ceil(Math.max(0, renderedTop) * scale)}px`
    }
    const schedule = () => {
      if (active && !scheduled) scheduled = requestAnimationFrame(fit)
    }
    const loaded = () => {
      observer?.disconnect()
      document?.removeEventListener('load', schedule, true)
      document = frame.contentDocument
      if (!document?.body) return
      // applyThemeAttribute owns the convention that dark is an absent
      // data-theme, so the host document and the frame cannot disagree about
      // which block of the frame's custom properties applies.
      applyThemeAttribute(resolvedTheme, document.documentElement)
      document.addEventListener('load', schedule, true)
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule)
        observer.observe(frame.parentElement ?? frame)
        observer.observe(document.body)
      }
      void document.fonts?.ready.then(schedule)
      schedule()
    }
    frame.addEventListener('load', loaded)
    window.addEventListener('resize', schedule)
    // WebKit can finish loading a small srcdoc before the effect attaches.
    if (frame.contentDocument?.readyState === 'complete') loaded()
    return () => {
      active = false
      frame.removeEventListener('load', loaded)
      window.removeEventListener('resize', schedule)
      document?.removeEventListener('load', schedule, true)
      observer?.disconnect()
      cancelAnimationFrame(scheduled)
    }
  }, [srcDoc, error, resolvedTheme])

  return (
    <div className="template-preview">
      {error && <p role="alert">{error}</p>}
      {!error && !isRenderedCardDisplayable(rendering) && <p className="form-warning" role="status">No card will be created: front has no visible field content.</p>}
      {!error && <iframe ref={combinedFrameRef} title={title} sandbox="allow-same-origin" srcDoc={srcDoc} />}
      {!error && navigationActions.length > 0 && <section className="external-card-links" aria-label="External card links">
        <p>Links from this card are also available here. Preview the destination before opening another tab.</p>
        <div>{navigationActions.map((link, index) => <button className="text-button" type="button" aria-label={`${link.label} · ${link.host}`} key={`${index}:${link.url}`} onClick={() => chooseNavigation(link.url)}><span>{link.label}</span><span aria-hidden="true"> · </span><bdi>{link.host}</bdi></button>)}</div>
      </section>}
      {navigationDialog}
    </div>
  )
}
