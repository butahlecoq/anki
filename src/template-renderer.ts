export interface RenderedTemplate {
  html: string
  isEmpty: boolean
}

const token = /{{\s*([#^/])?\s*([^{}]+?)\s*}}/g

/** Validate the deliberately small template language before storing a template. */
export function validateTemplate(template: string, fieldNames: readonly string[], side: 'front' | 'back'): void {
  const known = new Set(fieldNames)
  let section: string | undefined
  let cursor = 0
  for (const match of template.matchAll(token)) {
    if (/{{|}}/.test(template.slice(cursor, match.index))) throw new Error('Unmatched template delimiter')
    const [, marker, rawName] = match
    cursor = match.index + match[0].length
    const name = rawName.trim()
    if (marker === '/') {
      if (section !== name) throw new Error(`Unmatched template conditional: ${name}`)
      section = undefined
      continue
    }
    if (name === 'FrontSide') {
      if (side === 'front') throw new Error('FrontSide is not allowed on the front template')
      if (marker) throw new Error('FrontSide cannot be a conditional field')
    } else if (!known.has(name)) throw new Error(`Unknown field in template: ${name}`)
    if (marker) {
      if (section) throw new Error('Nested template conditionals are not supported')
      section = name
    }
  }
  if (/{{|}}/.test(template.slice(cursor))) throw new Error('Unmatched template delimiter')
  if (section) throw new Error(`Unclosed template conditional: ${section}`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

/** Replace fields without evaluating template text or field contents as code. */
export function renderTemplate(template: string, fields: Record<string, string>, front?: string): RenderedTemplate {
  let html = ''
  let cursor = 0
  let section: { name: string; enabled: boolean } | undefined
  let visibleField = false
  for (const match of template.matchAll(token)) {
    const position = match.index
    const [source, marker, rawName] = match
    const name = rawName.trim()
    if (!section || section.enabled) html += template.slice(cursor, position)
    cursor = position + source.length

    if (marker === '#' || marker === '^') {
      if (section) throw new Error('Nested template conditionals are not supported')
      section = { name, enabled: marker === '#' ? Boolean(fields[name]?.trim()) : !fields[name]?.trim() }
    } else if (marker === '/') {
      if (!section || section.name !== name) throw new Error(`Unmatched template conditional: ${name}`)
      section = undefined
    } else if (!section || section.enabled) {
      const value = name === 'FrontSide' ? (front ?? '') : (fields[name] ?? '')
      if (value.trim()) visibleField = true
      html += name === 'FrontSide' ? value : escapeHtml(value)
    }
  }
  if (section) throw new Error(`Unclosed template conditional: ${section.name}`)
  html += template.slice(cursor)
  return { html, isEmpty: !visibleField }
}
