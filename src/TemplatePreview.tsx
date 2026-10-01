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
}

export function TemplatePreview({ front, back, css, fields, side, title = 'Card preview', kind = 'standard', ordinal, media }: TemplatePreviewProps) {
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
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"><style>body{font-family:system-ui,sans-serif;color:#202a22;background:#fff;padding:24px;overflow-wrap:anywhere}.card-image{display:block;max-width:100%;max-height:290px;object-fit:contain}.card-audio{width:min(100%,400px)}${css}</style></head><body>${html}</body></html>`

  return (
    <div className="template-preview">
      {error && <p role="alert">{error}</p>}
      {!error && empty && <p className="form-warning" role="status">No card will be created: front has no visible field content.</p>}
      {!error && <iframe title={title} sandbox="allow-same-origin" srcDoc={srcDoc} />}
    </div>
  )
}
