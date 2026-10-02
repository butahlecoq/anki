import { useEffect, useRef } from 'react'
import { tryRenderTemplate } from './template-renderer'

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
  const frameRef = useRef<HTMLIFrameElement>(null)
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
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"><style>body{font-family:system-ui,sans-serif;color:#202a22;background:#fff;padding:24px;overflow-wrap:anywhere}.card-image{display:block;max-width:100%;max-height:290px;object-fit:contain}.card-audio{width:min(100%,400px)}${css}</style></head><body class="card card${templateOrdinal}">${html}</body></html>`

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    let document: Document | null = null
    let scheduled = 0
    const fit = () => {
      scheduled = 0
      const body = document?.body
      if (!body || !document || !frame.contentWindow) return
      const width = frame.clientWidth
      if (!width) return
      // Measure in the original coordinate space before applying a transform.
      body.style.transform = 'none'
      body.style.transformOrigin = 'top left'
      body.style.margin = '0'
      body.style.boxSizing = 'border-box'
      body.style.width = `${width}px`
      const naturalWidth = Math.max(width, body.scrollWidth)
      const scale = Math.min(1, width / naturalWidth)
      body.style.width = `${naturalWidth}px`
      const height = Math.max(body.scrollHeight, body.getBoundingClientRect().height)
      body.style.transform = `scale(${scale})`
      document.documentElement.style.overflow = 'hidden'
      frame.style.height = `${Math.ceil(height * scale)}px`
    }
    const schedule = () => {
      if (!scheduled) scheduled = requestAnimationFrame(fit)
    }
    const loaded = () => {
      observer?.disconnect()
      document?.removeEventListener('load', schedule, true)
      document = frame.contentDocument
      if (!document?.body) return
      document.addEventListener('load', schedule, true)
      observer = new ResizeObserver(schedule)
      observer.observe(frame.parentElement ?? frame)
      observer.observe(document.body)
      void document.fonts.ready.then(schedule)
      schedule()
    }
    frame.addEventListener('load', loaded)
    return () => {
      frame.removeEventListener('load', loaded)
      document?.removeEventListener('load', schedule, true)
      observer?.disconnect()
      cancelAnimationFrame(scheduled)
    }
  }, [srcDoc, error])

  return (
    <div className="template-preview">
      {error && <p role="alert">{error}</p>}
      {!error && empty && <p className="form-warning" role="status">No card will be created: front has no visible field content.</p>}
      {!error && <iframe ref={frameRef} title={title} sandbox="allow-same-origin" srcDoc={srcDoc} />}
    </div>
  )
}
