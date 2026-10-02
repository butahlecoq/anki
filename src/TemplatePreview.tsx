import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { tryRenderTemplate } from './template-renderer'
import { useTemplateNavigation } from './use-template-navigation'
import { renderedNavigationActions } from './template-navigation'

interface TemplatePreviewProps {
  front: string
  back: string
  css: string
  fields: Record<string, string>
  side: 'front' | 'back'
  title?: string
  kind?: 'standard' | 'cloze'
  ordinal?: number
  media?: Record<string, { kind: 'image' | 'audio'; url: string; automatic?: boolean }>
  templateOrdinal?: number
}

export function TemplatePreview({ front, back, css, fields, side, title = 'Card preview', kind = 'standard', ordinal, media, templateOrdinal = 1 }: TemplatePreviewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { frameRef: navigationFrameRef, dialog: navigationDialog, choose: chooseNavigation } = useTemplateNavigation(`${side}:${title}:${front}:${back}:${JSON.stringify(fields)}:${templateOrdinal}`)
  const combinedFrameRef = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element
    frameRef.current = element
    navigationFrameRef(element)
  }, [navigationFrameRef])
  useEffect(() => {
    if (title === 'Review card') frame.current?.scrollIntoView?.({ block: 'center' })
  }, [title, side])
  let frontHtml = ''
  let html = ''
  let empty = false
  let error = ''
  const renderedFront = tryRenderTemplate(front, fields, undefined, { kind, ordinal, side: 'front', media })
  if (!renderedFront.ok) error = renderedFront.error
  else {
    frontHtml = renderedFront.value.html
    empty = renderedFront.value.isEmpty
    if (side === 'front') html = frontHtml
    else {
      const renderedBack = tryRenderTemplate(back, fields, frontHtml, { kind, ordinal, side: 'back', media })
      if (renderedBack.ok) html = renderedBack.value.html
      else error = renderedBack.error
    }
  }
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"><style>body{font-family:system-ui,sans-serif;color:#202a22;background:#fff;padding:24px;overflow-wrap:anywhere}.card-image{display:block;max-width:100%;max-height:290px;object-fit:contain}.card-audio{width:min(100%,400px)}a[data-kiroku-href]{color:#175fa6;text-decoration:underline;cursor:pointer}${css}</style></head><body class="card card${templateOrdinal}">${html}</body></html>`
  const navigationActions = renderedNavigationActions(html)
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
  }, [srcDoc, error])

  return (
    <div className="template-preview">
      {error && <p role="alert">{error}</p>}
      {!error && empty && <p className="form-warning" role="status">No card will be created: front has no visible field content.</p>}
      {!error && <iframe ref={combinedFrameRef} title={title} sandbox="allow-same-origin" srcDoc={srcDoc} />}
      {!error && navigationActions.length > 0 && <section className="external-card-links" aria-label="External card links">
        <p>Links from this card are also available here. Preview the destination before opening another tab.</p>
        <div>{navigationActions.map((link, index) => <button className="text-button" type="button" aria-label={`${link.label} · ${link.host}`} key={`${index}:${link.url}`} onClick={() => chooseNavigation(link.url)}><span>{link.label}</span><span aria-hidden="true"> · </span><bdi>{link.host}</bdi></button>)}</div>
      </section>}
      {navigationDialog}
    </div>
  )
}
