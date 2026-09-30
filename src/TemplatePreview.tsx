import { renderTemplate } from './template-renderer'

interface TemplatePreviewProps {
  front: string
  back: string
  css: string
  fields: Record<string, string>
  side: 'front' | 'back'
}

export function TemplatePreview({ front, back, css, fields, side }: TemplatePreviewProps) {
  let frontHtml = ''
  let html = ''
  let empty = false
  let error = ''
  try {
    const renderedFront = renderTemplate(front, fields)
    frontHtml = renderedFront.html
    empty = renderedFront.isEmpty
    html = side === 'front' ? frontHtml : renderTemplate(back, fields, frontHtml).html
  } catch (reason) {
    error = reason instanceof Error ? reason.message : 'Unable to render preview'
  }
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"><style>body{font-family:system-ui,sans-serif;color:#202a22;background:#fff;padding:24px;overflow-wrap:anywhere}${css}</style></head><body>${html}</body></html>`

  return (
    <div className="template-preview">
      {error && <p role="alert">{error}</p>}
      {empty && <p className="form-warning" role="status">No card will be created: front has no visible field content.</p>}
      <iframe title="Card preview" sandbox="" srcDoc={srcDoc} />
    </div>
  )
}
